# opencode-rpc

Discord Rich Presence for [OpenCode](https://opencode.ai).

<p align="center">
  <img width="458" height="163" src="https://github.com/user-attachments/assets/222a7434-38b3-44ca-9292-abde7b7863c5" />
</p>

## install

```bash
bun pm trust opencode-rpc
bun add opencode-rpc
```
or
```bash
npm install opencode-rpc
```
or
```bash
pnpm add opencode-rpc
```

if you choose to not run `bun pm trust opencode-rpc` (it just adds the plugin to opencode.json, that's it) or if for some reason auto-add to opencode.json didn't work, you can add the plugin to opencode.json by yourself:

```json
{
  "plugin": ["opencode-rpc"]
}
```

## update

opencode has a terrible caching system for npm plugins, so you'll need to force a refresh if the plugin has been updated:

```bash
opencode plugin opencode-rpc@latest --global --force
```

## configuration

```json
{
  "plugin": ["opencode-rpc"],
  "plugin_config": {
    "opencode-rpc": {
      "clientId": "1234567...", // your own discord application client id (default: built-in)
      "showProject": true, // set to false to hide the project name
      "showTokens": true, // set to false to hide input/output token stats
      "showCost": true, // set to false to hide cost stats
      "customText": "deep into vibecoding in", // custom prefix instead of "Working on"
      "hideProjectText": "your mom", // custom text instead of project name when hidden
      "providerIcons": { // override or add custom provider icons
        "openai": "https://example.com/my-icon.png",
        "user-added-provider": "https://example.com/my-icon-2.png"
      }
    }
  }
}
```

also, if you create a `.hiderpc` file in your project, it will force `showProject = false` for that specific project.

## built-in provider icons


| provider ID(s) | |
|---|---|
| `openai` | <img src="https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/png/openai.png" width="24" /> |
| `anthropic` | <img src="https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/png/anthropic.png" width="24" /> |
| `google`, `google-gemini`, `gemini`, `google-vertex` | <img src="https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/png/google-gemini.png" width="24" /> |
| `groq` | <img src="https://www.google.com/s2/favicons?domain=groq.com&sz=32" width="24" /> |
| `together`, `together-color`, `togetherai` | <img src="https://www.google.com/s2/favicons?domain=together.ai&sz=32" width="24" /> |
| `cohere` | <img src="https://www.google.com/s2/favicons?domain=cohere.com&sz=32" width="24" /> |
| `mistral` | <img src="https://www.google.com/s2/favicons?domain=mistral.ai&sz=32" width="24" /> |
| `azure`, `azure-cognitive-services` | <img src="https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/png/azure.png" width="24" /> |
| `aws`, `amazon`, `amazon-bedrock` | <img src="https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/png/amazon-web-services.png" width="24" /> |
| `xai` | <img src="https://www.google.com/s2/favicons?domain=x.ai&sz=32" width="24" /> |
| `deepseek` | <img src="https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/png/deepseek.png" width="24" /> |
| `perplexity` | <img src="https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/png/perplexity.png" width="24" /> |
| `copilot`, `github-copilot`, `github` | <img src="https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/png/github-copilot.png" width="24" /> |
| `gitlab` | <img src="https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/png/gitlab.png" width="24" /> |
| `huggingface` | <img src="https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/png/hugging-face.png" width="24" /> |
| `cloudflare`, `cloudflare-ai-gateway`, `cloudflare-workers-ai` | <img src="https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/png/cloudflare.png" width="24" /> |
| `nvidia` | <img src="https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/png/nvidia.png" width="24" /> |
| `databricks` | <img src="https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/png/databricks.png" width="24" /> |
| `vercel` | <img src="https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/png/vercel.png" width="24" /> |
| `vultr` | <img src="https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/png/vultr.png" width="24" /> |
| `zenmux` | <img src="https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/png/zenmux.png" width="24" /> |
| `ovhcloud` | <img src="https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/png/ovh.png" width="24" /> |
| `ollama`, `ollama-cloud` | <img src="https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/png/ollama.png" width="24" /> |
| `openrouter` | <img src="https://www.google.com/s2/favicons?domain=openrouter.ai&sz=32" width="24" /> |
| `deepinfra` | <img src="https://www.google.com/s2/favicons?domain=deepinfra.com&sz=32" width="24" /> |
| `cerebras` | <img src="https://www.google.com/s2/favicons?domain=cerebras.ai&sz=32" width="24" /> |
| `digitalocean` | <img src="https://www.google.com/s2/favicons?domain=digitalocean.com&sz=32" width="24" /> |
| `moonshotai` | <img src="https://www.google.com/s2/favicons?domain=moonshot.ai&sz=32" width="24" /> |
| `venice` | <img src="https://www.google.com/s2/favicons?domain=venice.ai&sz=32" width="24" /> |
| `helicone` | <img src="https://www.google.com/s2/favicons?domain=helicone.ai&sz=32" width="24" /> |
| `nebius` | <img src="https://www.google.com/s2/favicons?domain=nebius.com&sz=32" width="24" /> |
| `minimax` | <img src="https://www.google.com/s2/favicons?domain=minimax.io&sz=32" width="24" /> |
| `scaleway` | <img src="https://www.google.com/s2/favicons?domain=scaleway.com&sz=32" width="24" /> |
| `zai` | <img src="https://www.google.com/s2/favicons?domain=z.ai&sz=32" width="24" /> |
| `io-net` | <img src="https://www.google.com/s2/favicons?domain=io.net&sz=32" width="24" /> |
| `stackit` | <img src="https://www.google.com/s2/favicons?domain=stackit.de&sz=32" width="24" /> |
| `baseten` | <img src="https://www.google.com/s2/favicons?domain=baseten.co&sz=32" width="24" /> |
| `fireworks-ai` | <img src="https://www.google.com/s2/favicons?domain=www.fireworks.ai&sz=32" width="24" /> |
| `sap-ai-core` | <img src="https://www.google.com/s2/favicons?domain=sap.com&sz=32" width="24" /> |
| `302ai` | <img src="https://www.google.com/s2/favicons?domain=302.ai&sz=32" width="24" /> |
| `cortecs` | <img src="https://www.google.com/s2/favicons?domain=cortecs.ai&sz=32" width="24" /> |
| `llmgateway` | <img src="https://www.google.com/s2/favicons?domain=llmgateway.io&sz=32" width="24" /> |
| `frogbot` | <img src="https://www.google.com/s2/favicons?domain=frogbot.ai&sz=32" width="24" /> |
| `opencode-go`, `opencode-zen` | uses the OpenCode app icon |

any unrecognized provider falls back to the OpenCode icon unless specified in providerIcons.

## uhhh

everything was vibecoded with opencode go's kimi k2.6 :) but if it works it works
