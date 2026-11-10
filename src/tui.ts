import { Plugin } from "@opencode/plugin/tui";
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Reports the chat that is currently open in this TUI to the server plugin.
 * OpenCode does not broadcast route changes, so a tiny file is the bridge
 * between the TUI process and the server process.
 */
const FOCUS_PATH = join(homedir(), ".local", "share", "opencode", "rich-opencode-focus.json");

export default Plugin.define({
  id: "rich-opencode.tui",
  setup(context) {
    let last = "";

    const write = () => {
      try {
        const route = context.ui.router.current();
        const sessionID = route.type === "session" ? route.sessionID : undefined;
        const key = sessionID ?? route.type;
        if (key === last) return;
        last = key;
        writeFileSync(
          FOCUS_PATH,
          JSON.stringify({ sessionID, route: route.type, time: Date.now() }),
          "utf8",
        );
      } catch {
        // the TUI may be tearing down
      }
    };

    write();
    const timer = setInterval(write, 1_000);
    return () => clearInterval(timer);
  },
});
