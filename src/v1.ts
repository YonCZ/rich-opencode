import type { Config, Plugin } from "@opencode-ai/plugin";
import type { AssistantMessage, Event, Session } from "@opencode-ai/sdk";
import { resolveOptions, type RichOptions } from "./options.js";
import { Presence, debugLog, setDebugLogging, type SessionUsage } from "./presence.js";

type V1Hooks = Awaited<ReturnType<Plugin>>;

interface V1Input {
  client: {
    session: {
      get(args: { path: { id: string } }): Promise<{ data?: Session }>;
      list(args: { query: { directory?: string } }): Promise<{ data?: Session[] }>;
    };
  };
  directory?: string;
  worktree?: string;
}

export async function createV1Hooks(input: V1Input, rawOptions?: RichOptions | Record<string, unknown>): Promise<V1Hooks> {
  const options = resolveOptions(rawOptions);
  setDebugLogging(options.debug);
  const presence = new Presence(options, input.worktree || input.directory || "");
  const messages = new Map<string, SessionUsage>();

  async function rememberParent(sessionID: string): Promise<void> {
    try {
      const response = await input.client.session.get({ path: { id: sessionID } });
      const info = response?.data;
      if (info) presence.rememberSession(info.id, info.parentID);
    } catch {
      // session may already be gone
    }
  }

  function loadExistingSessions(): void {
    try {
      void input.client.session
        .list({ query: { directory: input.directory } })
        .then((response) => {
          const list = response?.data;
          if (!Array.isArray(list)) return;
          for (const info of list) {
            if (!info?.id) continue;
            presence.rememberSession(info.id, info.parentID);
            if (info.directory && !input.worktree) presence.setProjectDir(info.directory);
          }
        })
        .catch(() => {});
    } catch {
      // older hosts may not expose session.list
    }
  }

  return {
    config: async (cfg: Config) => {
      const pluginConfig = (cfg as Record<string, unknown> & { plugin_config?: Record<string, unknown> })
        .plugin_config?.["rich-opencode"];
      if (pluginConfig) presence.setOptions(resolveOptions(pluginConfig));

      setTimeout(() => {
        presence.start();
        loadExistingSessions();
      }, 100);
    },

    event: async ({ event }: { event: Event }) => {
      presence.start();

      if (event.type === "session.created") {
        const info = (event as unknown as { properties: { info: Session } }).properties.info;
        debugLog({ type: "session.created", id: info.id, parentID: info.parentID });
        presence.rememberSession(info.id, info.parentID);
        presence.setCurrentSession(info.id, info.directory);
      }

      if (event.type === "session.deleted") {
        const info = (event as unknown as { properties: { info: Session } }).properties.info;
        debugLog({ type: "session.deleted", id: info.id, parentID: info.parentID });
        presence.forgetSession(info.id);
      }

      if (event.type === "message.updated") {
        const message = (event as unknown as { properties: { info: Record<string, unknown> } }).properties.info;

        if (message.role === "user") {
          presence.setCurrentSession(message.sessionID as string);
          presence.setStatus("working");
          const model = message.model as { providerID: string; modelID: string } | undefined;
          if (model) presence.setModel({ providerID: model.providerID, modelID: model.modelID });
          return;
        }

        if (message.role !== "assistant") return;

        const assistant = message as unknown as AssistantMessage;
        if (!presence.hasSession(assistant.sessionID)) {
          // sessions first seen through a message still need their parent for subagent rollup
          void rememberParent(assistant.sessionID);
        }
        presence.setCurrentSession(assistant.sessionID);
        presence.setModel({ providerID: assistant.providerID, modelID: assistant.modelID });
        if (assistant.path?.cwd) presence.setProjectDir(assistant.path.cwd);
        presence.setAgent(assistant.sessionID, assistant.mode);

        const cache = assistant.tokens?.cache;
        presence.setContextUsage(
          assistant.sessionID,
          (assistant.tokens?.input ?? 0) + (cache?.read ?? 0) + (cache?.write ?? 0),
          (assistant.tokens?.output ?? 0) + (assistant.tokens?.reasoning ?? 0),
        );
        presence.setStatus(assistant.time?.completed ? "idle" : "working");

        const usage: SessionUsage = {
          tokensInput: assistant.tokens?.input ?? 0,
          tokensOutput: (assistant.tokens?.output ?? 0) + (assistant.tokens?.reasoning ?? 0),
          cost: assistant.cost ?? 0,
        };

        const previous = messages.get(assistant.id);
        const delta: SessionUsage = previous
          ? {
              tokensInput: usage.tokensInput - previous.tokensInput,
              tokensOutput: usage.tokensOutput - previous.tokensOutput,
              cost: usage.cost - previous.cost,
            }
          : usage;
        messages.set(assistant.id, usage);

        debugLog({
          type: "message.updated.assistant",
          sessionID: assistant.sessionID,
          messageID: assistant.id,
          usage,
          delta,
        });

        if (delta.tokensInput !== 0 || delta.tokensOutput !== 0 || delta.cost !== 0) {
          presence.addUsage(assistant.sessionID, delta);
        }
      }
    },
  };
}
