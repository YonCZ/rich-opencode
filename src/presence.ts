import { Client } from "@xhayper/discord-rpc";
import { appendFileSync, existsSync, readdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { LineField, RichOptions } from "./options.js";

export type { RichOptions } from "./options.js";

export type PresenceStatus = "thinking" | "working" | "prompting" | "idle";

export interface SessionUsage {
  tokensInput: number;
  tokensOutput: number;
  cost: number;
}

export interface ModelRef {
  providerID: string;
  modelID: string;
}

const DEFAULT_CLIENT_ID = "1505556269036077178";
const UPDATE_DEBOUNCE_MS = 3_000;
const MAX_DEBUG_LOG_BYTES = 5 * 1024 * 1024;
const STALE_LOG_MS = 7 * 24 * 60 * 60 * 1000;

const debugDir = join(homedir(), ".local", "share", "opencode");
const debugPath = join(debugDir, "rich-opencode-debug.log");

let debugEnabled = false;

/** Toggle file logging for this process (all plugin instances share it). */
export function setDebugLogging(enabled: boolean): void {
  debugEnabled = enabled;
}

export function debugLog(data: Record<string, unknown>): void {
  if (!debugEnabled) return;
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
      if (!name.startsWith("rich-opencode-debug.log")) continue;
      const file = join(debugDir, name);
      if (statSync(file).mtimeMs < cutoff) unlinkSync(file);
    }
  } catch {
    // directory may not exist yet
  }
}

purgeStaleDebugLogs();

export function formatTokens(count: number): string {
  if (count >= 1_000_000) return (count / 1_000_000).toFixed(2) + "M";
  if (count >= 1_000) return (count / 1_000).toFixed(1) + "k";
  return String(count);
}

export function lastPathSegment(directory: string): string {
  const parts = directory.split(/[\\/]/).filter((part) => part.length > 0);
  return parts[parts.length - 1] ?? "";
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

function modelsDevIconUrl(providerID: string): string {
  return `https://images.weserv.nl/?url=https://models.dev/logos/${providerID}.svg&output=png&bg=white&w=256&h=256`;
}

export class Presence {
  private options: RichOptions;
  private client: Client | null = null;
  private ready = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryDelay = 2_000;

  private readonly sessions = new Set<string>();
  private readonly parents = new Map<string, string | undefined>();
  private readonly usage = new Map<string, SessionUsage>();
  private readonly contextUsage = new Map<string, { input: number; output: number }>();
  private readonly directories = new Map<string, string>();
  private readonly agents = new Map<string, string>();

  /** Start of the current "play session"; reset after a long idle stretch. */
  private activityStartedAt: number | null = null;
  private idleSince: number | null = null;

  private currentSessionID: string | null = null;
  private model: ModelRef | null = null;
  private projectDir: string;
  private status: PresenceStatus = "idle";

  constructor(options: RichOptions, directory: string) {
    this.options = options;
    this.projectDir = directory;
  }

  setOptions(next: RichOptions): void {
    this.options = next;
  }

  start(): void {
    if (this.client || this.ready) return;
    try {
      const client = new Client({ clientId: this.options.clientId || DEFAULT_CLIENT_ID });
      this.client = client;
      client.on("ready", () => {
        this.ready = true;
        this.retryDelay = 2_000;
        debugLog({ type: "rpc.ready", user: this.client?.user?.username });
        // One plugin instance loads per location; stay silent until this one has
        // real session data so a fresh instance can't clobber the live card.
        if (this.currentSessionID) this.flush();
      });
      client.on("disconnected", () => {
        debugLog({ type: "rpc.disconnected" });
        this.ready = false;
        this.client = null;
        this.scheduleRetry();
      });
      void client.login().catch((error) => {
        // The Discord handshake has a 10s timeout and the OpenCode server can be
        // busy while plugins load, so retry with backoff instead of giving up.
        debugLog({ type: "rpc.login.failed", error: String(error), retryInMs: this.retryDelay });
        try {
          void client.destroy();
        } catch {
          // ignore
        }
        this.client = null;
        this.ready = false;
        this.scheduleRetry();
      });
    } catch (error) {
      debugLog({ type: "rpc.client.failed", error: String(error) });
      this.client = null;
      this.scheduleRetry();
    }
  }

  private scheduleRetry(): void {
    if (this.retryTimer) return;
    const delay = this.retryDelay;
    this.retryDelay = Math.min(Math.round(this.retryDelay * 1.5), 15_000);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.start();
    }, delay);
  }

  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
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
    this.contextUsage.delete(sessionID);
    this.directories.delete(sessionID);
    this.agents.delete(sessionID);
    if (this.currentSessionID === sessionID) {
      const remaining = [...this.sessions];
      this.currentSessionID = remaining.length > 0 ? remaining[remaining.length - 1]! : null;
    }
    this.queue();
  }

  setCurrentSession(sessionID: string, directory?: string): void {
    // Sub-agent sessions share the card with their parent; never let them own it.
    if (this.parents.get(sessionID)) return;
    if (!this.sessions.has(sessionID)) this.rememberSession(sessionID);
    this.currentSessionID = sessionID;
    if (directory) this.directories.set(sessionID, directory);
    this.queue();
  }

  setModel(ref: ModelRef | null): void {
    this.model = ref ? normalizeModel(ref) : null;
    this.queue();
  }

  setProjectDir(directory: string): void {
    if (directory) this.projectDir = directory;
  }

  rememberDirectory(sessionID: string, directory: string | undefined): void {
    if (directory) this.directories.set(sessionID, directory);
  }

  setAgent(sessionID: string, agent: string | undefined): void {
    if (agent) this.agents.set(sessionID, agent);
  }

  setStatus(status: PresenceStatus): void {
    const now = Date.now();
    if (status === "idle") {
      // Idle still counts as play time, but a long break starts a new session.
      if (this.idleSince === null) this.idleSince = now;
      if (now - this.idleSince >= this.options.timer.idleResetMinutes * 60_000) this.activityStartedAt = null;
    } else {
      this.idleSince = null;
      if (this.activityStartedAt === null) this.activityStartedAt = now;
    }
    if (this.status === status) return;
    this.status = status;
    debugLog({ type: "status", status });
    this.queue();
  }

  /** Context usage of the latest model call, matching OpenCode's sidebar number. */
  setContextUsage(sessionID: string, input: number, output: number): void {
    const previous = this.contextUsage.get(sessionID);
    if (previous && previous.input === input && previous.output === output) return;
    this.contextUsage.set(sessionID, { input, output });
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
    const startTimestamp =
      this.options.timer.enabled && this.activityStartedAt
        ? Math.floor(this.activityStartedAt / 1000)
        : undefined;

    debugLog({ type: "flush", details, state, startTimestamp, connected: Boolean(this.client?.isConnected) });

    const client = this.client;
    if (!client || !client.isConnected) return;

    const icon = this.options.smallImage.enabled && this.model ? this.iconFor(this.model.providerID) : undefined;

    client.user
      ?.setActivity({
        details,
        state,
        ...(startTimestamp === undefined ? {} : { startTimestamp }),
        largeImageKey: this.options.largeImage.key,
        largeImageText: this.options.largeImage.text,
        ...(icon === undefined ? {} : { smallImageKey: icon }),
        ...(icon === undefined || !this.model
          ? {}
          : { smallImageText: `${this.model.providerID}/${this.model.modelID}` }),
      })
      ?.catch?.(() => {});
  }

  private iconFor(providerID: string): string {
    return this.options.smallImage.providerIcons[providerID] || modelsDevIconUrl(providerID);
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
    return this.renderLine(this.options.details) || "OpenCode";
  }

  private buildState(): string | undefined {
    const line = this.renderLine(this.options.state);
    return line.length > 0 ? line : undefined;
  }

  private renderLine(fields: readonly LineField[]): string {
    const parts: string[] = [];
    for (const field of fields) {
      const value = this.renderField(field);
      if (value.length > 0) parts.push(value);
    }
    return parts.join(this.options.separator);
  }

  private renderField(field: LineField): string {
    switch (field) {
      case "model":
        return this.model?.modelID ?? "";
      case "status":
        return this.options.status.labels[this.status] ?? "";
      case "tokens":
        return this.renderTokens();
      case "cost":
        return this.renderCost();
      case "project":
        return this.renderProject();
      case "agent": {
        if (!this.currentSessionID) return "";
        return this.agents.get(this.currentSessionID) ?? "";
      }
      default:
        return field.startsWith("text:") ? field.slice("text:".length) : "";
    }
  }

  private renderTokens(): string {
    if (!this.currentSessionID) return "";
    let input = 0;
    let output = 0;

    if (this.options.tokens.mode === "cumulative") {
      const totals = this.familyTotals(this.rootOf(this.currentSessionID));
      input = totals.tokensInput;
      output = totals.tokensOutput;
    } else {
      const usage = this.contextUsage.get(this.currentSessionID);
      if (!usage) return "";
      input = usage.input;
      output = usage.output;
    }

    const parts: string[] = [];
    if (this.options.tokens.showInput && input > 0) {
      parts.push(`${this.options.tokens.inputPrefix} ${formatTokens(input)}`);
    }
    if (this.options.tokens.showOutput && output > 0) {
      parts.push(`${this.options.tokens.outputPrefix} ${formatTokens(output)}`);
    }
    return parts.join(" | ");
  }

  private renderCost(): string {
    if (!this.currentSessionID) return "";
    const { cost } = this.familyTotals(this.rootOf(this.currentSessionID));
    if (cost <= 0) return "";
    return this.options.cost.format.replace("{amount}", cost.toFixed(2));
  }

  private renderProject(): string {
    if (!this.currentSessionID) return "";
    const directory = this.directories.get(this.currentSessionID) ?? this.projectDir;
    return directory ? lastPathSegment(directory) : "";
  }
}
