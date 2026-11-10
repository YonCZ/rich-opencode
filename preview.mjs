import { Presence } from "./dist/presence.js";
import { resolveOptions } from "./dist/options.js";

const status = process.argv[2] ?? "working";
const p = new Presence(resolveOptions({}), "/Users/yon/Documents/Projects/RichOpencode");
p.start();
p.setCurrentSession("ses_preview", "/Users/yon/Documents/Projects/RichOpencode");
p.setModel({ providerID: "einfra", modelID: "deepseek-v4.1-flash" });
p.setUsage("ses_preview", { tokensInput: 16300, tokensOutput: 500, cost: 0.42 });
p.setContextUsage("ses_preview", 15200, 500);
p.setAgent("ses_preview", "build");
p.setStatus(status);

setTimeout(() => {
  console.log(`connected: ${p.client?.isConnected === true} (status: ${status})`);
  p.dispose();
  setTimeout(() => process.exit(0), 500);
}, 5000);
