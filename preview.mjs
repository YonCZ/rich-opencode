import { Presence } from "./dist/presence.js";

const p = new Presence({}, "/Users/yon/Documents/Projects/RichOpencode");
p.start();
p.setCurrentSession("ses_preview", "/Users/yon/Documents/Projects/RichOpencode");
p.setModel({ providerID: "einfra", modelID: "qwen3.8-27b" });
p.setUsage("ses_preview", { tokensInput: 16300, tokensOutput: 500, cost: 0.42 });

setTimeout(() => {
  console.log("connected:", p.client?.isConnected === true);
  p.dispose();
  setTimeout(() => process.exit(0), 500);
}, 5000);
