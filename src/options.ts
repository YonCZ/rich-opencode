import type { PresenceStatus } from "./presence.js";

/** Which fields a line can render, in order. `text:...` renders a literal. */
export type LineField =
  | "model"
  | "modelName"
  | "provider"
  | "variant"
  | "tokens"
  | "tokenPercent"
  | "cost"
  | "status"
  | "project"
  | "agent"
  | "title"
  | `text:${string}`;

export interface TokenOptions {
  /** `context` = latest model call (matches OpenCode's sidebar), `cumulative` = session totals. */
  mode: "context" | "cumulative";
  showInput: boolean;
  showOutput: boolean;
  inputPrefix: string;
  outputPrefix: string;
}

export interface CostOptions {
  /** `{amount}` is replaced with the number, e.g. `"${amount}"` or `"{amount} USD"`. */
  format: string;
}

export interface StatusOptions {
  labels: Record<PresenceStatus, string>;
}

export interface PromptingOptions {
  /** Keyboard/mouse input within this window counts as "Prompting". */
  idleSeconds: number;
  /** Require one of `apps` to be frontmost (macOS only). */
  frontmostOnly: boolean;
  apps: string[];
}

export interface TimerOptions {
  enabled: boolean;
  /** A continuous idle stretch this long starts a new play session. */
  idleResetMinutes: number;
}

export interface ImageOptions {
  key: string;
  text: string;
}

export interface SmallImageOptions {
  enabled: boolean;
  providerIcons: Record<string, string>;
}

export interface RichOptions {
  /** Discord application id. Omit to use the built-in shared OpenCode app. */
  clientId?: string;
  /** Line 1 fields, rendered in order. */
  details: LineField[];
  /** Line 2 fields, rendered in order. */
  state: LineField[];
  separator: string;
  tokens: TokenOptions;
  cost: CostOptions;
  status: StatusOptions;
  prompting: PromptingOptions;
  timer: TimerOptions;
  largeImage: ImageOptions;
  smallImage: SmallImageOptions;
  /** Append lifecycle/flush details to `~/.local/share/opencode/rich-opencode-debug.log`. */
  debug: boolean;
  /** One plugin instance owns the Discord connection (recommended). */
  leaderLock: boolean;
}

export const DEFAULT_PROMPTING_APPS = [
  "Terminal",
  "iTerm2",
  "iTerm",
  "Ghostty",
  "Warp",
  "Alacritty",
  "kitty",
  "WezTerm",
  "Hyper",
  "Tabby",
  "Rio",
  "Code",
  "Cursor",
  "Zed",
  "Windsurf",
  "opencode",
];

export const DEFAULT_OPTIONS: RichOptions = {
  details: ["model"],
  state: ["tokens", "status"],
  separator: " \u00b7 ",
  tokens: {
    mode: "context",
    showInput: true,
    showOutput: true,
    inputPrefix: "\u2193",
    outputPrefix: "\u2191",
  },
  cost: { format: "${amount}" },
  status: {
    labels: { thinking: "Thinking", working: "Working", prompting: "Prompting", idle: "Idle" },
  },
  prompting: { idleSeconds: 60, frontmostOnly: true, apps: DEFAULT_PROMPTING_APPS },
  timer: { enabled: true, idleResetMinutes: 30 },
  largeImage: { key: "logo", text: "OpenCode" },
  smallImage: { enabled: false, providerIcons: {} },
  debug: false,
  leaderLock: true,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function num(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(value, min), max);
}

function fields(value: unknown, fallback: LineField[]): LineField[] {
  if (!Array.isArray(value)) return fallback;
  const parsed = value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return parsed.length > 0 ? (parsed as LineField[]) : fallback;
}

function strings(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback;
  const parsed = value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
  return parsed.length > 0 ? parsed : fallback;
}

/** Merge user options over the defaults, ignoring invalid values. */
export function resolveOptions(raw: unknown): RichOptions {
  const input = isRecord(raw) ? raw : {};
  const tokens = isRecord(input.tokens) ? input.tokens : {};
  const cost = isRecord(input.cost) ? input.cost : {};
  const status = isRecord(input.status) ? input.status : {};
  const labels = isRecord(status.labels) ? status.labels : {};
  const prompting = isRecord(input.prompting) ? input.prompting : {};
  const timer = isRecord(input.timer) ? input.timer : {};
  const largeImage = isRecord(input.largeImage) ? input.largeImage : {};
  const smallImage = isRecord(input.smallImage) ? input.smallImage : {};

  return {
    clientId: typeof input.clientId === "string" && input.clientId.length > 0 ? input.clientId : undefined,
    details: fields(input.details, DEFAULT_OPTIONS.details),
    state: fields(input.state, DEFAULT_OPTIONS.state),
    separator: str(input.separator, DEFAULT_OPTIONS.separator),
    tokens: {
      mode: tokens.mode === "cumulative" ? "cumulative" : "context",
      showInput: bool(tokens.showInput, DEFAULT_OPTIONS.tokens.showInput),
      showOutput: bool(tokens.showOutput, DEFAULT_OPTIONS.tokens.showOutput),
      inputPrefix: str(tokens.inputPrefix, DEFAULT_OPTIONS.tokens.inputPrefix),
      outputPrefix: str(tokens.outputPrefix, DEFAULT_OPTIONS.tokens.outputPrefix),
    },
    cost: {
      format: str(cost.format, DEFAULT_OPTIONS.cost.format),
    },
    status: {
      labels: {
        thinking: str(labels.thinking, DEFAULT_OPTIONS.status.labels.thinking),
        working: str(labels.working, DEFAULT_OPTIONS.status.labels.working),
        prompting: str(labels.prompting, DEFAULT_OPTIONS.status.labels.prompting),
        idle: str(labels.idle, DEFAULT_OPTIONS.status.labels.idle),
      },
    },
    prompting: {
      idleSeconds: num(prompting.idleSeconds, DEFAULT_OPTIONS.prompting.idleSeconds, 5, 3600),
      frontmostOnly: bool(prompting.frontmostOnly, DEFAULT_OPTIONS.prompting.frontmostOnly),
      apps: strings(prompting.apps, DEFAULT_OPTIONS.prompting.apps),
    },
    timer: {
      enabled: bool(timer.enabled, DEFAULT_OPTIONS.timer.enabled),
      idleResetMinutes: num(timer.idleResetMinutes, DEFAULT_OPTIONS.timer.idleResetMinutes, 1, 1440),
    },
    largeImage: {
      key: str(largeImage.key, DEFAULT_OPTIONS.largeImage.key),
      text: str(largeImage.text, DEFAULT_OPTIONS.largeImage.text),
    },
    smallImage: {
      enabled: bool(smallImage.enabled, DEFAULT_OPTIONS.smallImage.enabled),
      providerIcons: isRecord(smallImage.providerIcons)
        ? Object.fromEntries(
            Object.entries(smallImage.providerIcons).filter(
              (entry): entry is [string, string] => typeof entry[1] === "string",
            ),
          )
        : {},
    },
    debug: bool(input.debug, DEFAULT_OPTIONS.debug),
    leaderLock: bool(input.leaderLock, DEFAULT_OPTIONS.leaderLock),
  };
}
