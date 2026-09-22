import type { Plugin } from "@opencode/plugin";
import { Presence, debugLog, type DiscordRpcOptions } from "./presence.js";

export const pluginId = "opencode-rpc";

export function createV2Plugin() {
  return {
    id: pluginId,
    async setup(ctx: Plugin.Context) {
      const presence = new Presence((ctx.options ?? {}) as DiscordRpcOptions, ctx.location?.directory ?? "");
      presence.start();

      const controller = new AbortController();

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
            }
          }
        } catch {
          // the subscription ends when the plugin unloads
        }
      })();

      return () => {
        controller.abort();
        presence.dispose();
      };
    },
  };
}
