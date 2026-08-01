import { existsSync, appendFileSync, readdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Client } from "@xhayper/discord-rpc";
import type { Plugin, Config } from "@opencode-ai/plugin";
import type { Event, AssistantMessage, Session } from "@opencode-ai/sdk";

interface DiscordRPOptions {
  clientId?: string;
  showProject?: boolean;
  showTokens?: boolean;
  showCost?: boolean;
  customText?: string;
  hideProjectText?: string;
  providerIcons?: Record<string, string>;
}

const OPENCODE_LOGO = "https://opencode.ai/favicon-96x96-v3.png";
const debugLogDir = join(homedir(), ".local", "share", "opencode");
const debugLogPath = join(debugLogDir, "opencode-rpc-debug.log");
const MAX_DEBUG_LOG_BYTES = 5 * 1024 * 1024;
const STALE_LOG_MS = 7 * 24 * 60 * 60 * 1000; // rotated logs older than this are deleted

function debugLog(data: Record<string, unknown>) {
  if (!process.env.OPENCODE_RPC_DEBUG) return;
  try {
    if (existsSync(debugLogPath) && statSync(debugLogPath).size > MAX_DEBUG_LOG_BYTES) {
      renameSync(debugLogPath, `${debugLogPath}.old`);
    }
    appendFileSync(debugLogPath, JSON.stringify({ time: Date.now(), ...data }) + "\n");
  } catch {
    // ignore
  }
}

function purgeStaleDebugLogs() {
  try {
    const cutoff = Date.now() - STALE_LOG_MS;
    for (const name of readdirSync(debugLogDir)) {
      if (!name.startsWith("opencode-rpc-debug.log")) continue;
      const stalePath = join(debugLogDir, name);
      if (statSync(stalePath).mtimeMs < cutoff) unlinkSync(stalePath);
    }
  } catch {
    // ignore
  }
}

purgeStaleDebugLogs();

function buildModelsDevIconUrl(providerID: string): string {
  return `https://images.weserv.nl/?url=https://models.dev/logos/${providerID}.svg&output=png&bg=white&w=256&h=256`;
}

function getProjectName(directory: string, showProject: boolean, hideText: string): string {
  if (showProject === false) {
    return hideText;
  }
  const parts = directory.split(/[\\/]/).filter(p => p.length > 0);
  return parts[parts.length - 1] || "";
}

function cleanOmnirouteModel(model: { providerID: string; modelID: string }): { providerID: string; modelID: string } {
  if (model.providerID !== "omniroute") return model;

  if (model.modelID.startsWith("omniroute/")) {
    const stripped = model.modelID.slice("omniroute/".length);
    const firstSlash = stripped.indexOf("/");
    if (firstSlash === -1) return { providerID: stripped, modelID: "" };
    return { providerID: stripped.slice(0, firstSlash), modelID: stripped.slice(firstSlash + 1) };
  }

  const firstSlash = model.modelID.indexOf("/");
  if (firstSlash === -1) return { providerID: model.modelID, modelID: "" };
  return { providerID: model.modelID.slice(0, firstSlash), modelID: model.modelID.slice(firstSlash + 1) };
}

function formatTokens(count: number): string {
  if (count >= 1000000) {
    return (count / 1000000).toFixed(2) + "M";
  }
  if (count >= 1000) {
    return (count / 1000).toFixed(1) + "k";
  }
  return count.toString();
}

const discordRPPlugin: Plugin = async (input, rawOptions) => {
  const tupleOptions = (rawOptions || {}) as unknown as DiscordRPOptions;
  let options: DiscordRPOptions = { ...tupleOptions };

  function resolveIcon(providerID: string): string {
    return options.providerIcons?.[providerID] || buildModelsDevIconUrl(providerID);
  }

  const sessions = new Set<string>();
  const messages: Array<{ id: string; sessionID: string; tokensInput: number; tokensOutput: number; cost: number }> = [];
  const seenMessages = new Set<string>();
  const sessionTotals = new Map<string, { tokensInput: number; tokensOutput: number; cost: number }>();
  const sessionParents = new Map<string, string | undefined>();
  let currentSessionID: string | null = null;
  let currentModel: { providerID: string; modelID: string } | null = null;
  let currentProjectDir: string | null = null;
  let updateTimer: ReturnType<typeof setTimeout> | null = null;
  const pluginStartTime = Date.now();
  let client: Client | null = null;
  let discordReady = false;

  function addToSessionTotals(sessionID: string, tokensInput: number, tokensOutput: number, cost: number) {
    const existing = sessionTotals.get(sessionID) || { tokensInput: 0, tokensOutput: 0, cost: 0 };
    existing.tokensInput += tokensInput;
    existing.tokensOutput += tokensOutput;
    existing.cost += cost;
    sessionTotals.set(sessionID, existing);
  }

  function getSessionTotals(sessionID: string) {
    return sessionTotals.get(sessionID) || { tokensInput: 0, tokensOutput: 0, cost: 0 };
  }

  function getFamilyTotals(sessionID: string) {
    let tokensInput = 0;
    let tokensOutput = 0;
    let cost = 0;
    for (const [id, totals] of sessionTotals) {
      if (id === sessionID || isDescendantOf(id, sessionID)) {
        tokensInput += totals.tokensInput;
        tokensOutput += totals.tokensOutput;
        cost += totals.cost;
      }
    }
    return { tokensInput, tokensOutput, cost };
  }

  function isDescendantOf(sessionID: string, ancestorID: string): boolean {
    let parent = sessionParents.get(sessionID);
    while (parent) {
      if (parent === ancestorID) return true;
      parent = sessionParents.get(parent);
    }
    return false;
  }

  function getRootSessionID(sessionID: string): string {
    let current = sessionID;
    let parent = sessionParents.get(current);
    while (parent) {
      current = parent;
      parent = sessionParents.get(current);
    }
    return current;
  }

  async function ensureSessionParent(sessionID: string) {
    if (sessionParents.has(sessionID) || sessions.has(sessionID)) return;
    try {
      const res: any = await input.client.session.get({ path: { id: sessionID } });
      if (res.data) {
        sessions.add(sessionID);
        if (res.data.parentID !== undefined) {
          sessionParents.set(sessionID, res.data.parentID);
        }
      }
    } catch {
      // ignore
    }
  }

  function buildDetails(): string {
    if (!currentSessionID) {
      return "At the main screen...";
    }

    const projectDir = currentProjectDir || input.worktree || input.directory || "";
    const hasHideFile = projectDir ? existsSync(`${projectDir}/.hiderpc`) : false;
    const showProject = !hasHideFile && options.showProject !== false;
    const hideText = options.hideProjectText || "something...";
    const projectName = getProjectName(projectDir, showProject, hideText);
    const prefix = options.customText || "Working on";

    if (showProject) {
      return `${prefix} ${projectName || ""}`.trim();
    }

    return `${prefix} ${hideText || ""}`.trim();
  }

  function buildState(): string | undefined {
    if (!currentSessionID) return undefined;

    const showTokens = options.showTokens !== false;
    const showCost = options.showCost !== false;
    const rootID = getRootSessionID(currentSessionID);
    const { tokensInput, tokensOutput, cost } = getFamilyTotals(rootID);
    debugLog({ type: "buildState", currentSessionID, rootID, totals: { tokensInput, tokensOutput, cost }, sessionTotalsKeys: Array.from(sessionTotals.keys()), sessionParentsKeys: Array.from(sessionParents.entries()) });

    const parts: string[] = [];
    if (showTokens) {
      const tokenParts: string[] = [];
      if (tokensInput > 0) tokenParts.push(`\u2193 ${formatTokens(tokensInput)}`);
      if (tokensOutput > 0) tokenParts.push(`\u2191 ${formatTokens(tokensOutput)}`);
      if (tokenParts.length > 0) {
        parts.push(tokenParts.join(" | "));
      }
    }
    if (showCost && cost > 0) {
      parts.push(`$${cost.toFixed(2)}`);
    }
    return parts.length > 0 ? parts.join(" / ") : "";
  }

  function updatePresence() {
    if (!client || !client.isConnected) return;

    const smallImage = currentModel ? resolveIcon(currentModel.providerID) : undefined;
    const smallText = currentModel ? `${currentModel.providerID}/${currentModel.modelID}` : undefined;

    client.user?.setActivity({
      details: buildDetails(),
      state: buildState(),
      startTimestamp: pluginStartTime,
      largeImageKey: OPENCODE_LOGO,
      largeImageText: "OpenCode",
      smallImageKey: smallImage,
      smallImageText: smallText,
    })?.catch(() => {});
  }

  function queueUpdate() {
    if (updateTimer) return;
    updateTimer = setTimeout(() => {
      updateTimer = null;
      updatePresence();
    }, 3000);
  }

  function initDiscord() {
    if (client || discordReady) return;
    try {
      const clientId = options.clientId || "1505556269036077178";
      client = new Client({ clientId });
      client.on("ready", () => {
        discordReady = true;
        updatePresence();
      });
      client.login().catch(() => { client = null; });
    } catch {
      // discord not available
    }
  }

  function initSessions() {
    try {
      input.client.session.list({ query: { directory: input.directory } })
        .then((res: any) => {
          if (res.data && Array.isArray(res.data)) {
            for (const s of res.data) {
              if (s.id) {
                sessions.add(s.id);
                if (s.parentID !== undefined) sessionParents.set(s.id, s.parentID);
              }
              if (s.directory && !currentProjectDir) currentProjectDir = s.directory;
            }
            if (!currentSessionID && sessions.size > 0) {
              currentSessionID = Array.from(sessions)[sessions.size - 1];
              queueUpdate();
            }
          }
        })
        .catch(() => {});
    } catch {
      // ignore
    }
  }

  return {
    config: async (cfg: Config) => {
      const pluginConfig = (cfg as any).plugin_config?.["opencode-rpc"];
      if (pluginConfig) {
        options = { ...options, ...pluginConfig };
      }

      setTimeout(() => {
        initDiscord();
        initSessions();
      }, 100);
    },

    event: async ({ event }: { event: Event }) => {
      if (!client) initDiscord();

      if (event.type === "session.created") {
        const info = (event as any).properties.info as Session;
        debugLog({ type: "session.created", id: info.id, parentID: info.parentID });
        sessions.add(info.id);
        sessionParents.set(info.id, info.parentID);
        currentSessionID = info.id;
        if (info.directory) currentProjectDir = info.directory;
        queueUpdate();
      }

      if (event.type === "session.deleted") {
        const info = (event as any).properties.info as Session;
        debugLog({ type: "session.deleted", id: info.id, parentID: info.parentID });
        sessions.delete(info.id);
        for (let i = messages.length - 1; i >= 0; i--) {
          if (messages[i].sessionID === info.id) {
            seenMessages.delete(messages[i].id);
            messages.splice(i, 1);
          }
        }
        if (currentSessionID === info.id) {
          currentSessionID = sessions.size > 0 ? Array.from(sessions)[sessions.size - 1] : null;
        }
        queueUpdate();
      }

      if (event.type === "message.updated") {
        const msg = (event as any).properties.info;

        if (msg.role === "user") {
          currentSessionID = msg.sessionID;
          currentModel = msg.model ? cleanOmnirouteModel(msg.model) : null;
          queueUpdate();
        } else if (msg.role === "assistant") {
          const assistant = msg as AssistantMessage;
          if (!sessions.has(assistant.sessionID)) {
            await ensureSessionParent(assistant.sessionID);
          }
          currentSessionID = assistant.sessionID;
          currentModel = cleanOmnirouteModel({ providerID: assistant.providerID, modelID: assistant.modelID });
          if (assistant.path?.cwd) currentProjectDir = assistant.path.cwd;

          const tokensInput = assistant.tokens?.input ?? 0;
          const tokensOutput = (assistant.tokens?.output ?? 0) + (assistant.tokens?.reasoning ?? 0);

          debugLog({
            type: "message.updated.assistant",
            sessionID: assistant.sessionID,
            msgID: assistant.id,
            cost: assistant.cost,
            tokensInput,
            tokensOutput,
            parentID: sessionParents.get(assistant.sessionID),
            sessionsKnown: sessions.has(assistant.sessionID),
          });

          if (!seenMessages.has(assistant.id)) {
            seenMessages.add(assistant.id);
            messages.push({
              id: assistant.id,
              sessionID: assistant.sessionID,
              tokensInput,
              tokensOutput,
              cost: assistant.cost,
            });
            addToSessionTotals(assistant.sessionID, tokensInput, tokensOutput, assistant.cost);
          } else {
            const existing = messages.find(m => m.id === assistant.id);
            if (existing) {
              const deltaInput = tokensInput - existing.tokensInput;
              const deltaOutput = tokensOutput - existing.tokensOutput;
              const deltaCost = assistant.cost - existing.cost;
              if (deltaInput > 0 || deltaOutput > 0 || deltaCost > 0) {
                debugLog({ type: "message.delta", sessionID: assistant.sessionID, msgID: assistant.id, deltaInput, deltaOutput, deltaCost });
                addToSessionTotals(assistant.sessionID, deltaInput, deltaOutput, deltaCost);
              }
              existing.tokensInput = tokensInput;
              existing.tokensOutput = tokensOutput;
              existing.cost = assistant.cost;
            }
          }
          queueUpdate();
        }
      }
    },
  };
};

export default discordRPPlugin;
