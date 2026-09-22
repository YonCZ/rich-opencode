import type { Plugin } from "@opencode-ai/plugin";
import { createV1Hooks } from "./v1.js";
import { createV2Plugin, pluginId } from "./v2.js";

export type { DiscordRpcOptions } from "./presence.js";

const v2 = createV2Plugin();

/**
 * One package, two host generations:
 * OpenCode 2 calls `setup`, OpenCode 1.18.29 and newer call `server`.
 * Older V1 releases expect a function instead of an object and are not supported.
 */
const plugin = {
  id: pluginId,
  setup: v2.setup,
  server: (input: Parameters<Plugin>[0], options?: Parameters<Plugin>[1]) => createV1Hooks(input, options),
};

export default plugin;
