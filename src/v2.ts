import type { Plugin } from "@opencode/plugin";
import { execFile } from "node:child_process";
import { Presence, debugLog, type DiscordRpcOptions } from "./presence.js";

export const pluginId = "opencode-rpc";

/** Human input within this window counts as "Prompting". */
const PROMPTING_IDLE_MS = 60_000;
/** No session events for this long while "running" means the state went stale. */
const STALL_MS = 3 * 60_000;
/** How often we sample macOS system idle time and re-derive the status. */
const STATUS_POLL_MS = 5_000;

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

export function createV2Plugin() {
  return {
    id: pluginId,
    async setup(ctx: Plugin.Context) {
      const presence = new Presence((ctx.options ?? {}) as DiscordRpcOptions, ctx.location?.directory ?? "");
      presence.start();

      const controller = new AbortController();

      const executing = new Set<string>();
      const reasoning = new Set<string>();
      let systemIdleMs: number | null = null;
      let lastSessionEvent = Date.now();

      const derive = () => {
        if (reasoning.size > 0) {
          presence.setStatus("thinking");
        } else if (executing.size > 0) {
          presence.setStatus("working");
        } else if (systemIdleMs !== null && systemIdleMs < PROMPTING_IDLE_MS) {
          presence.setStatus("prompting");
        } else {
          presence.setStatus("idle");
        }
      };

      const poll = setInterval(() => {
        void readSystemIdleMs().then((idle) => {
          systemIdleMs = idle;
          if (executing.size > 0 && Date.now() - lastSessionEvent > STALL_MS) {
            executing.clear();
            reasoning.clear();
          }
          derive();
        });
      }, STATUS_POLL_MS);

      void readSystemIdleMs().then((idle) => {
        systemIdleMs = idle;
        derive();
      });

      async function inspect(sessionID: string): Promise<void> {
        try {
          const info = await ctx.session.get({ sessionID });
          if (!info) return;
          presence.rememberSession(info.id, info.parentID);
          if (info.location?.directory) presence.setProjectDir(info.location.directory);
          if (info.model) presence.setModel({ providerID: info.model.providerID, modelID: info.model.id });
        } catch {
          // session may not be readable yet
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
                presence.setCurrentSession(data.sessionID, data.location?.directory);
                if (data.model) {
                  presence.setModel({ providerID: data.model.providerID, modelID: data.model.id });
                }
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
                presence.setCurrentSession(data.sessionID);
                presence.setUsage(data.sessionID, {
                  tokensInput: data.tokens.input,
                  tokensOutput: data.tokens.output + data.tokens.reasoning,
                  cost: data.cost,
                });
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
      };
    },
  };
}
