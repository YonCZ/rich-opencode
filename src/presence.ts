import { Client } from "@xhayper/discord-rpc";
import { appendFileSync, existsSync, readdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface DiscordRpcOptions {
  clientId?: string;
  showProject?: boolean;
  showTokens?: boolean;
  showCost?: boolean;
  customText?: string;
  hideProjectText?: string;
  providerIcons?: Record<string, string>;
}

export interface SessionUsage {
  tokensInput: number;
  tokensOutput: number;
  cost: number;
}

export interface ModelRef {
  providerID: string;
  modelID: string;
}

const OPENCODE_ASSET_KEY = "logo";
const DEFAULT_CLIENT_ID = "1505556269036077178";
const UPDATE_DEBOUNCE_MS = 3000;
const MAX_DEBUG_LOG_BYTES = 5 * 1024 * 1024;
const STALE_LOG_MS = 7 * 24 * 60 * 60 * 1000; // rotated debug logs older than this are removed

const debugDir = join(homedir(), ".local", "share", "opencode");
const debugPath = join(debugDir, "opencode-rpc-debug.log");

export function debugLog(data: Record<string, unknown>): void {
  if (!process.env.OPENCODE_RPC_DEBUG) return;
  try {
    if (existsSync(debugPath) && statSync(debugPath).size > MAX_DEBUG_LOG_BYTES) {
      renameSync(debugPath, `${debugPath}.old`);
    }
    appendFileSync(debugPath, JSON.stringify({ time: Date.now(), ...data }) + "\n");
  } catch {
    // logging must never break the plugin
  }
}

function purgeStaleDebugLogs(): void {
  try {
    const cutoff = Date.now() - STALE_LOG_MS;
    for (const name of readdirSync(debugDir)) {
      if (!name.startsWith("opencode-rpc-debug.log")) continue;
      const file = join(debugDir, name);
      if (statSync(file).mtimeMs < cutoff) unlinkSync(file);
    }
  } catch {
    // directory may not exist yet
  }
}

purgeStaleDebugLogs();

export type PresenceStatus = "thinking" | "working" | "prompting" | "idle";

const STATUS_LABELS: Record<PresenceStatus, string> = {
  thinking: "Thinking",
  working: "Working",
  prompting: "Prompting",
  idle: "Idle",
};

function formatTokens(count: number): string {
  if (count >= 1_000_000) return (count / 1_000_000).toFixed(2) + "M";
  if (count >= 1_000) return (count / 1_000).toFixed(1) + "k";
  return String(count);
}

// OmniRoute forwards "<provider>/<model>" inside its own model IDs.
export function normalizeModel(model: ModelRef): ModelRef {
  if (model.providerID !== "omniroute") return model;

  const raw = model.modelID.startsWith("omniroute/")
    ? model.modelID.slice("omniroute/".length)
    : model.modelID;

  const slash = raw.indexOf("/");
  if (slash === -1) return { providerID: raw, modelID: "" };
  return { providerID: raw.slice(0, slash), modelID: raw.slice(slash + 1) };
}

export class Presence {
  private options: DiscordRpcOptions;
  private client: Client | null = null;
  private ready = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  private readonly sessions = new Set<string>();
  private readonly parents = new Map<string, string | undefined>();
  private readonly usage = new Map<string, SessionUsage>();

  private currentSessionID: string | null = null;
  private model: ModelRef | null = null;
  private projectDir: string;
  private status: PresenceStatus = "idle";

  constructor(options: DiscordRpcOptions, directory: string) {
    this.options = options;
    this.projectDir = directory;
  }

  setOptions(next: DiscordRpcOptions): void {
    this.options = { ...this.options, ...next };
  }

  start(): void {
    if (this.client || this.ready) return;
    try {
      const client = new Client({ clientId: this.options.clientId || DEFAULT_CLIENT_ID });
      this.client = client;
      client.on("ready", () => {
        this.ready = true;
        // Every location gets its own plugin instance; stay silent until this
        // instance has real session data so a fresh instance can't clobber the
        // presence that the active session is showing.
        if (this.currentSessionID) this.flush();
      });
      void client.login().catch(() => {
        this.client = null;
      });
    } catch {
      this.client = null;
    }
  }

  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    try {
      void this.client?.destroy();
    } catch {
      // ignore
    }
    this.client = null;
    this.ready = false;
  }

  rememberSession(sessionID: string, parentID?: string): void {
    this.sessions.add(sessionID);
    this.parents.set(sessionID, parentID);
  }

  hasSession(sessionID: string): boolean {
    return this.sessions.has(sessionID);
  }

  forgetSession(sessionID: string): void {
    this.sessions.delete(sessionID);
    this.parents.delete(sessionID);
    this.usage.delete(sessionID);
    if (this.currentSessionID === sessionID) {
      const remaining = [...this.sessions];
      this.currentSessionID = remaining.length > 0 ? remaining[remaining.length - 1] : null;
    }
    this.queue();
  }

  setCurrentSession(sessionID: string, directory?: string): void {
    if (!this.sessions.has(sessionID)) this.rememberSession(sessionID);
    this.currentSessionID = sessionID;
    if (directory) this.projectDir = directory;
    this.queue();
  }

  setModel(ref: ModelRef | null): void {
    this.model = ref ? normalizeModel(ref) : null;
    this.queue();
  }

  setProjectDir(directory: string): void {
    if (directory) this.projectDir = directory;
  }

  setStatus(status: PresenceStatus): void {
    if (this.status === status) return;
    this.status = status;
    debugLog({ type: "status", status });
    this.queue();
  }

  /** Adds the delta reported for a single message (OpenCode 1). */
  addUsage(sessionID: string, delta: SessionUsage): void {
    const current = this.usage.get(sessionID) ?? { tokensInput: 0, tokensOutput: 0, cost: 0 };
    this.usage.set(sessionID, {
      tokensInput: current.tokensInput + delta.tokensInput,
      tokensOutput: current.tokensOutput + delta.tokensOutput,
      cost: current.cost + delta.cost,
    });
    this.queue();
  }

  /** Replaces the totals reported for a session (OpenCode 2). */
  setUsage(sessionID: string, totals: SessionUsage): void {
    this.usage.set(sessionID, totals);
    this.queue();
  }

  queue(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, UPDATE_DEBOUNCE_MS);
  }

  flush(): void {
    const details = this.buildDetails();
    const state = this.buildState();
    debugLog({ type: "flush", details, state, connected: Boolean(this.client?.isConnected) });

    const client = this.client;
    if (!client || !client.isConnected) return;

    client.user
      ?.setActivity({
        details,
        state,
        largeImageKey: OPENCODE_ASSET_KEY,
        largeImageText: "OpenCode",
      })
      ?.catch?.(() => {});
  }

  private isDescendantOf(sessionID: string, ancestorID: string): boolean {
    let parent = this.parents.get(sessionID);
    while (parent) {
      if (parent === ancestorID) return true;
      parent = this.parents.get(parent);
    }
    return false;
  }

  private rootOf(sessionID: string): string {
    let current = sessionID;
    let parent = this.parents.get(current);
    while (parent) {
      current = parent;
      parent = this.parents.get(current);
    }
    return current;
  }

  private familyTotals(rootID: string): SessionUsage {
    const totals: SessionUsage = { tokensInput: 0, tokensOutput: 0, cost: 0 };
    for (const [sessionID, sessionUsage] of this.usage) {
      if (sessionID === rootID || this.isDescendantOf(sessionID, rootID)) {
        totals.tokensInput += sessionUsage.tokensInput;
        totals.tokensOutput += sessionUsage.tokensOutput;
        totals.cost += sessionUsage.cost;
      }
    }
    return totals;
  }

  private buildDetails(): string {
    if (!this.currentSessionID) return "OpenCode";
    if (!this.projectDir) return "OpenCode";

    const rootID = this.rootOf(this.currentSessionID);
    const { tokensInput, tokensOutput, cost } = this.familyTotals(rootID);

    const parts: string[] = [];
    if (this.options.showTokens !== false) {
      const tokens: string[] = [];
      if (tokensInput > 0) tokens.push(`\u2193 ${formatTokens(tokensInput)}`);
      if (tokensOutput > 0) tokens.push(`\u2191 ${formatTokens(tokensOutput)}`);
      if (tokens.length > 0) parts.push(tokens.join(" | "));
    }
    if (this.options.showCost === true && cost > 0) {
      parts.push(`$${cost.toFixed(2)}`);
    }
    if (this.model?.modelID) parts.push(this.model.modelID);
    return parts.length > 0 ? parts.join(" \u00b7 ") : "OpenCode";
  }

  private buildState(): string | undefined {
    return STATUS_LABELS[this.status];
  }
}
