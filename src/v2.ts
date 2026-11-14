import type { Plugin } from "@opencode/plugin";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveOptions } from "./options.js";
import { Presence, debugLog, setDebugLogging } from "./presence.js";

export const pluginId = "rich-opencode";

/** No session events for this long while "running" means the state went stale. */
const STALL_MS = 3 * 60_000;
/** How often we sample macOS system idle time and re-derive the status. */
const STATUS_POLL_MS = 5_000;

/**
 * The server loads one plugin instance per location, but Discord only needs one
 * connection. Whichever instance wins this lock uses the RPC client.
 */
const LOCK_PATH = join(homedir(), ".local", "share", "opencode", "rich-opencode.lock");
const LOCK_STALE_MS = 15_000;

/** Written by the TUI part: the chat currently open in the terminal. */
const FOCUS_PATH = join(homedir(), ".local", "share", "opencode", "rich-opencode-focus.json");

type FocusFile = { sessionID?: string; route?: string; time?: number };

function readFocus(): FocusFile | null {
  try {
    return JSON.parse(readFileSync(FOCUS_PATH, "utf8")) as FocusFile;
  } catch {
    return null;
  }
}

/**
 * Seconds since the last keyboard/mouse input anywhere on the machine.
 * OpenCode does not broadcast prompt typing (the TUI keeps the draft local),
 * so system input activity is the closest proxy for "I am typing".
 */
function readSystemIdleMs(): Promise<number | null> {
  if (process.platform !== "darwin") return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile("/usr/sbin/ioreg", ["-c", "IOHIDSystem"], { timeout: 2000 }, (error, stdout) => {
      if (error) return resolve(null);
      const match = /"HIDIdleTime"\s*=\s*(\d+)/.exec(stdout);
      resolve(match ? Number(match[1]) / 1e6 : null);
    });
  });
}

/** Display name of the frontmost macOS app, e.g. "Terminal". */
function readFrontmostApp(): Promise<string | null> {
  if (process.platform !== "darwin") return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile("/usr/bin/lsappinfo", ["front"], { timeout: 2000 }, (error, stdout) => {
      if (error) return resolve(null);
      const asn = stdout.trim();
      if (!asn) return resolve(null);
      execFile("/usr/bin/lsappinfo", ["info", "-only", "name", asn], (err, out) => {
        if (err) return resolve(null);
        const match = /"LSDisplayName"\s*=\s*"([^"]+)"/.exec(out);
        resolve(match?.[1] ?? null);
      });
    });
  });
}

type LockFile = { id?: string; pid?: number; heartbeat?: number };

const instanceId = randomUUID();

function readLock(): LockFile | null {
  try {
    return JSON.parse(readFileSync(LOCK_PATH, "utf8")) as LockFile;
  } catch {
    return null;
  }
}

function pidAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function tryAcquireLock(): boolean {
  const now = Date.now();
  const existing = readLock();
  const stale =
    !existing || !existing.heartbeat || now - existing.heartbeat > LOCK_STALE_MS || !pidAlive(existing.pid);

  if (!stale) return false;

  try {
    writeFileSync(LOCK_PATH, JSON.stringify({ id: instanceId, pid: process.pid, heartbeat: now }));
  } catch {
    return false;
  }
  return readLock()?.id === instanceId;
}

function heartbeatLock(): void {
  try {
    writeFileSync(LOCK_PATH, JSON.stringify({ id: instanceId, pid: process.pid, heartbeat: Date.now() }));
  } catch {
    // ignore
  }
}

function releaseLock(): void {
  if (readLock()?.id !== instanceId) return;
  try {
    unlinkSync(LOCK_PATH);
  } catch {
    // ignore
  }
}

export function createV2Plugin() {
  return {
    id: pluginId,
    async setup(ctx: Plugin.Context) {
      const options = resolveOptions(ctx.options);
      setDebugLogging(options.debug);

      const presence = new Presence(options, ctx.location?.directory ?? "");
      const controller = new AbortController();

      const promptingIdleMs = options.prompting.idleSeconds * 1000;
      const frontmostApps = new Set(options.prompting.apps);

      const loadModels = async () => {
        try {
          const result = await ctx.model.list();
          for (const model of result.data) {
            presence.setModelInfo(model.providerID, model.id, {
              name: model.name,
              contextLimit: model.limit?.context,
            });
          }
        } catch {
          // model catalog may not be ready yet
        }
      };
      void loadModels();

      const executing = new Set<string>();
      const reasoning = new Set<string>();
      const inspected = new Set<string>();
      let systemIdleMs: number | null = null;
      let frontmostApp: string | null = null;
      let lastSessionEvent = Date.now();
      let activeSessionID: string | null = null;
      let focusSessionID: string | null = null;
      let leader = false;

      const derive = () => {
        // Only count activity from the open chat (and its sub-agents) when we
        // know which chat the TUI has focused.
        const inFocus = (sessionID: string) =>
          focusSessionID === null || presence.belongsToCurrentSession(sessionID);
        const thinking = [...reasoning].some(inFocus);
        const working = [...executing].some(inFocus);

        if (thinking) {
          presence.setStatus("thinking");
        } else if (working) {
          presence.setStatus("working");
        } else if (
          systemIdleMs !== null &&
          systemIdleMs < promptingIdleMs &&
          (!options.prompting.frontmostOnly || (frontmostApp !== null && frontmostApps.has(frontmostApp)))
        ) {
          presence.setStatus("prompting");
        } else {
          presence.setStatus("idle");
        }
      };

      const setFocus = (sessionID: string | null) => {
        if (sessionID === focusSessionID) return;
        focusSessionID = sessionID;
        debugLog({ type: "focus", sessionID });
        if (!sessionID) return;
        activeSessionID = sessionID;
        presence.setCurrentSession(sessionID);
        void inspect(sessionID);
        derive();
      };

      const focusPoll = setInterval(() => {
        const focus = readFocus();
        if (focus?.sessionID) setFocus(focus.sessionID);
      }, 1_000);

      const ensureLeader = () => {
        if (!options.leaderLock) {
          if (!leader) {
            leader = true;
            presence.start();
          }
          return;
        }
        if (leader) {
          heartbeatLock();
          return;
        }
        if (!tryAcquireLock()) return;
        leader = true;
        debugLog({ type: "leader.acquired" });
        presence.start();
        // Re-seed the visible session (model, context tokens, start time).
        inspected.clear();
        if (activeSessionID) void inspect(activeSessionID);
      };

      const refresh = async () => {
        ensureLeader();
        // Dormant instances only watch the lock; they don't need OS polling.
        if (!leader) return;
        systemIdleMs = await readSystemIdleMs();
        frontmostApp =
          systemIdleMs !== null && systemIdleMs < promptingIdleMs ? await readFrontmostApp() : null;
        if (executing.size > 0 && Date.now() - lastSessionEvent > STALL_MS) {
          executing.clear();
          reasoning.clear();
        }
        derive();
        debugLog({
          type: "refresh",
          systemIdleMs,
          frontmostApp,
          executing: executing.size,
          reasoning: reasoning.size,
        });
      };

      const poll = setInterval(() => void refresh(), STATUS_POLL_MS);
      void refresh();

      async function seedContext(sessionID: string): Promise<void> {
        try {
          const messages = await ctx.session.context({ sessionID });
          for (let index = messages.length - 1; index >= 0; index--) {
            const message = messages[index];
            if (!message || message.type !== "assistant" || !message.tokens) continue;
            presence.setContextUsage(
              sessionID,
              message.tokens.input + message.tokens.cache.read + message.tokens.cache.write,
              message.tokens.output + message.tokens.reasoning,
            );
            if (message.model) {
              presence.setModel(sessionID, {
                providerID: message.model.providerID,
                modelID: message.model.id,
                variant: message.model.variant,
              });
            }
            break;
          }
        } catch {
          // best effort only
        }
      }

      async function inspect(sessionID: string): Promise<void> {
        if (inspected.has(sessionID)) return;
        inspected.add(sessionID);
        try {
          const info = await ctx.session.get({ sessionID });
          if (!info) return;
          presence.rememberSession(info.id, info.parentID);
          presence.rememberDirectory(info.id, info.location?.directory);
          presence.setAgent(info.id, info.agent);
          presence.setTitle(info.id, info.title);
          presence.setUsage(info.id, {
            tokensInput: info.tokens?.input ?? 0,
            tokensOutput: (info.tokens?.output ?? 0) + (info.tokens?.reasoning ?? 0),
            cost: info.cost ?? 0,
          });
          if (info.model)
            presence.setModel(info.id, {
              providerID: info.model.providerID,
              modelID: info.model.id,
              variant: info.model.variant,
            });
          if (leader) void seedContext(info.id);
        } catch {
          inspected.delete(sessionID);
        }
      }

      void (async () => {
        try {
          for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
            switch (event.type) {
              case "session.created": {
                const data = event.data;
                debugLog({ type: "session.created", sessionID: data.sessionID, parentID: data.parentID });
                presence.rememberSession(data.sessionID, data.parentID);
                presence.rememberDirectory(data.sessionID, data.location?.directory);
                if (data.agent) presence.setAgent(data.sessionID, data.agent);
                presence.setTitle(data.sessionID, data.title);
                if (data.model) {
                  presence.setModel(data.sessionID, {
                    providerID: data.model.providerID,
                    modelID: data.model.id,
                    variant: data.model.variant,
                  });
                }
                // Do not steal the card for a freshly opened empty session.
                void inspect(data.sessionID);
                break;
              }

              case "session.deleted": {
                debugLog({ type: "session.deleted", sessionID: event.data.sessionID });
                presence.forgetSession(event.data.sessionID);
                executing.delete(event.data.sessionID);
                reasoning.delete(event.data.sessionID);
                break;
              }

              case "session.viewed": {
                // A TUI viewed a session, so the user switched to it. That is a focus signal.
                setFocus(event.data.sessionID);
                void inspect(event.data.sessionID);
                break;
              }

              case "session.model.selected": {
                const data = event.data;
                presence.setModel(data.sessionID, {
                  providerID: data.model.providerID,
                  modelID: data.model.id,
                  variant: data.model.variant,
                });
                break;
              }

              case "session.usage.updated": {
                const data = event.data;
                // While a chat is focused, activity from other chats must not
                // take over the card.
                if (focusSessionID === null || data.sessionID === focusSessionID) {
                  activeSessionID = data.sessionID;
                  presence.setCurrentSession(data.sessionID);
                }
                presence.setUsage(data.sessionID, {
                  tokensInput: data.tokens.input,
                  tokensOutput: data.tokens.output + data.tokens.reasoning,
                  cost: data.cost,
                });
                // A session that existed before the plugin loaded never emitted
                // session.created here, so fetch its model/agent on first usage.
                void inspect(data.sessionID);
                break;
              }

              case "session.inbox.enqueued": {
                // A real user prompt landed in this session, so the user is there.
                if (event.data.item.type === "user") setFocus(event.data.sessionID);
                break;
              }

              case "session.execution.started": {
                executing.add(event.data.sessionID);
                lastSessionEvent = Date.now();
                break;
              }

              case "session.execution.succeeded":
              case "session.execution.failed":
              case "session.execution.interrupted":
              case "session.idle": {
                executing.delete(event.data.sessionID);
                reasoning.delete(event.data.sessionID);
                lastSessionEvent = Date.now();
                break;
              }

              case "session.reasoning.started": {
                reasoning.add(event.data.sessionID);
                lastSessionEvent = Date.now();
                break;
              }

              case "session.reasoning.ended": {
                reasoning.delete(event.data.sessionID);
                lastSessionEvent = Date.now();
                break;
              }

              case "session.step.started": {
                const data = event.data;
                if (data.model) {
                  presence.setModel(data.sessionID, {
                    providerID: data.model.providerID,
                    modelID: data.model.id,
                    variant: data.model.variant,
                  });
                }
                if (data.agent) presence.setAgent(data.sessionID, data.agent);
                executing.add(data.sessionID);
                lastSessionEvent = Date.now();
                break;
              }

              case "model.updated":
              case "models-dev.refreshed": {
                void loadModels();
                break;
              }

              case "session.text.started":
              case "session.tool.called":
              case "session.tool.progress": {
                executing.add(event.data.sessionID);
                lastSessionEvent = Date.now();
                break;
              }

              case "session.step.ended": {
                const data = event.data;
                presence.setContextUsage(
                  data.sessionID,
                  data.tokens.input + data.tokens.cache.read + data.tokens.cache.write,
                  data.tokens.output + data.tokens.reasoning,
                );
                lastSessionEvent = Date.now();
                break;
              }
            }

            derive();
          }
        } catch {
          // the subscription ends when the plugin unloads
        }
      })();

      return () => {
        clearInterval(poll);
        clearInterval(focusPoll);
        controller.abort();
        presence.dispose();
        if (options.leaderLock && leader) releaseLock();
      };
    },
  };
}
