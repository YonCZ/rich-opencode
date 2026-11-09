import { Client } from "@xhayper/discord-rpc";

const CLIENT_ID = process.argv[2] ?? "1505556269036077178";
const client = new Client({ clientId: CLIENT_ID });
const stamp = () => new Date().toISOString();

client.on("ready", () => {
  console.log(stamp(), "READY as", client.user?.username, `(${client.user?.id})`);
  void send();
});
client.on("disconnected", () => console.log(stamp(), "DISCONNECTED"));

async function send() {
  try {
    const result = await client.user?.setActivity({
      details: "RPC diagnostic",
      state: "If you see this, RPC works",
      largeImageKey: "logo",
      largeImageText: "OpenCode",
    });
    console.log(stamp(), "SET_ACTIVITY ok", JSON.stringify(result));
  } catch (error) {
    console.log(stamp(), "SET_ACTIVITY failed:", error?.message ?? error);
  }
}

client
  .login()
  .then(() => console.log(stamp(), "login resolved"))
  .catch((error) => console.log(stamp(), "login failed", error?.message ?? error));

setInterval(send, 15_000);
setTimeout(() => {
  client.destroy();
  process.exit(0);
}, 10 * 60 * 1000);
