import type { Plugin } from "@opencode/plugin";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Presence, debugLog, type DiscordRpcOptions } from "./presence.js";

export const pluginId = "opencode-rpc";

/** Human input within this window counts as "Prompting". */
const PROMPTING_IDLE_MS = 60_000;
/** No session events for this long while "running" means the state went stale. */
const STALL_MS = 3 * 60_000;
/** How often we sample macOS system idle time and re-derive the status. */
const STATUS_POLL_MS = 5_000;

/**
 * The server loads one plugin instance per location, but Discord only needs one
 * connection. Whichever instance wins this lock owns the RPC client.
 */
const LOCK_PATH = join(homedir(), ".local", "share", "opencode", "opencode-rpc.lock");
const LOCK_STALE_MS = 15_000;

/** Apps that can host the opencode TUI (or its integrated terminal). */
const FRONTMOST_TERMINALS = new Set([
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
]);

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
    !existing ||
    !existing.heartbeat ||
    now - existing.heartbeat > LOCK_STALE_MS ||
    !pidAlive(existing.pid);

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
      const presence = new Presence((ctx.options ?? {}) as DiscordRpcOptions, ctx.location?.directory ?? "");
      const controller = new AbortController();

      const executing = new Set<string>();
      const reasoning = new Set<string>();
      const inspected = new Set<string>();
      let systemIdleMs: number | null = null;
      let frontmostApp: string | null = null;
      let lastSessionEvent = Date.now();
      let activeSessionID: string | null = null;
      let leader = false;

      const derive = () => {
        if (reasoning.size > 0) {
          presence.setStatus("thinking");
        } else if (executing.size > 0) {
          presence.setStatus("working");
        } else if (
          systemIdleMs !== null &&
          systemIdleMs < PROMPTING_IDLE_MS &&
          frontmostApp !== null &&
          FRONTMOST_TERMINALS.has(frontmostApp)
        ) {
          presence.setStatus("prompting");
        } else {
          presence.setStatus("idle");
        }
      };

      const ensureLeader = () => {
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
          systemIdleMs !== null && systemIdleMs < PROMPTING_IDLE_MS ? await readFrontmostApp() : null;
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
              presence.setModel({ providerID: message.model.providerID, modelID: message.model.id });
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
          if (info.location?.directory) presence.setProjectDir(info.location.directory);
          if (info.model) presence.setModel({ providerID: info.model.providerID, modelID: info.model.id });
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
                if (data.model) {
                  presence.setModel({ providerID: data.model.providerID, modelID: data.model.id });
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
                activeSessionID = event.data.sessionID;
                presence.setCurrentSession(event.data.sessionID);
                void inspect(event.data.sessionID);
                break;
              }

              case "session.model.selected": {
                const data = event.data;
                presence.setModel({ providerID: data.model.providerID, modelID: data.model.id });
                break;
              }

              case "session.usage.updated": {
                const data = event.data;
                activeSessionID = data.sessionID;
                presence.setCurrentSession(data.sessionID);
                presence.setUsage(data.sessionID, {
                  tokensInput: data.tokens.input,
                  tokensOutput: data.tokens.output + data.tokens.reasoning,
                  cost: data.cost,
                });
                // A session that existed before the plugin loaded never emitted
                // session.created here, so fetch its model on first usage.
                void inspect(data.sessionID);
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

              case "session.step.started":
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
        controller.abort();
        presence.dispose();
        if (leader) releaseLock();
      };
    },
  };
}
