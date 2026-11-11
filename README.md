# Rich Opencode

Discord Rich Presence plugin for [OpenCode](https://opencode.ai). It shows what you are doing in OpenCode on your Discord profile. You choose what goes on each line.

```
Playing opencode
deepseek-v4.1-flash
↓ 298.8k | ↑ 398 · Working
01:23:45 elapsed
```

## What it does

The plugin reads OpenCode's event stream and session data. You place fields on either line, in any order, joined by the separator you pick.

Available fields:

| Field | Example | Notes |
| --- | --- | --- |
| `model` | `deepseek-v4.1-flash` | model id |
| `modelName` | `DeepSeek V4.1 Flash` | display name from the model catalog |
| `provider` | `einfra` | provider id |
| `variant` | `high` | model variant |
| `tokens` | `↓ 298.8k \| ↑ 398` | context usage or session totals |
| `tokenPercent` | `34%` | context used against the model limit |
| `cost` | `$0.52` | cumulative session cost |
| `status` | `Working` | Thinking, Working, Prompting or Idle |
| `project` | `Programming` | project folder name |
| `agent` | `build` | active agent id |
| `title` | `Discord Rich Presence` | session title, visible on your profile |
| `text:<anything>` | `in opencode` | literal text |

Other features:

- two token modes, `context` for the latest model call and `cumulative` for session totals
- a play-session timer that counts idle time and resets after a long break
- the card follows the chat open in your TUI, not the chat that ran last
- optional custom Discord application, logo and provider icons
- one Discord connection per machine, with reconnect and retry
- the project name and session title are hidden unless you add those fields

## Requirements

- OpenCode 2.x. OpenCode 1.18.29 and newer also work.
- Discord desktop app running on the same machine. Discord in a browser cannot reach the local IPC socket.
- In Discord, open User Settings, then Activity Privacy, and turn on "Display current activity as a status message".
- The Prompting state uses macOS system APIs. On other platforms the plugin works, but Prompting stays off and the card shows Idle instead.

## Install with an AI agent

Point your agent at [AGENT_INSTALL.md](AGENT_INSTALL.md). It contains the commands, the config merge, verification and troubleshooting.

## Install manually

```bash
git clone https://github.com/YonCZ/rich-opencode.git
cd rich-opencode
npm install
npm run build
```

Register the plugin in `~/.config/opencode/opencode.json`. Use the absolute path to the checkout:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "/absolute/path/to/rich-opencode",
      "options": {}
    }
  ]
}
```

Save the file. OpenCode reloads the config. Then restart the background service and your TUI:

```bash
opencode service restart
```

Quit and reopen `opencode` after the restart. The plugin includes a TUI part that reports the open chat. The service advertises that part only after a fresh start, and the TUI loads it at startup. Your sessions stay intact.

The `options` object is optional. Every setting has a default.

## Configuration

All settings go in the `options` object of the plugin entry.

```jsonc
{
  "plugins": [
    {
      "package": "/absolute/path/to/rich-opencode",
      "options": {
        "details": ["model"],
        "state": ["tokens", "status"],
        "separator": " · ",
        "tokens": { "mode": "context" },
        "timer": { "enabled": true, "idleResetMinutes": 30 },
        "debug": false
      }
    }
  ]
}
```

`details` is the first line, `state` is the second line. Fields render in order, and empty fields are skipped.

### Options

| Option | Default | Description |
| --- | --- | --- |
| `clientId` | built-in shared app | Discord application id |
| `details` | `["model"]` | fields on the first line |
| `state` | `["tokens", "status"]` | fields on the second line |
| `separator` | `" · "` | joins non-empty fields |
| `tokens.mode` | `"context"` | `context` matches OpenCode's sidebar, `cumulative` sums the session |
| `tokens.showInput` | `true` | show the input half |
| `tokens.showOutput` | `true` | show the output half |
| `tokens.inputPrefix` | `"↓"` | prefix for input tokens |
| `tokens.outputPrefix` | `"↑"` | prefix for output tokens |
| `cost.format` | `"${amount}"` | amount format, for example `"{amount} USD"` |
| `status.labels` | English labels | rename or translate the four states |
| `prompting.idleSeconds` | `60` | input within this window counts as prompting |
| `prompting.frontmostOnly` | `true` | require one of the apps below to be frontmost, macOS only |
| `prompting.apps` | Terminal, iTerm2, Ghostty, Warp, VS Code, Cursor and others | apps that count as the opencode window |
| `timer.enabled` | `true` | show the elapsed timer |
| `timer.idleResetMinutes` | `30` | a continuous idle stretch this long starts a new timer |
| `largeImage.key` | `"logo"` | asset key for the large image |
| `largeImage.text` | `"OpenCode"` | hover text for the large image |
| `smallImage.enabled` | `false` | show a provider icon |
| `smallImage.providerIcons` | `{}` | icon URLs by provider id |
| `debug` | `false` | write a log to `~/.local/share/opencode/rich-opencode-debug.log` |
| `leaderLock` | `true` | let one plugin instance own the Discord connection |

### Examples

Everything on two lines:

```jsonc
"options": {
  "details": ["model", "project"],
  "state": ["tokens", "status"]
}
```

Show the price:

```jsonc
"options": {
  "details": ["modelName"],
  "state": ["tokens", "cost", "status"],
  "cost": { "format": "${amount}" }
}
```

Custom status labels and separator:

```jsonc
"options": {
  "separator": " | ",
  "status": {
    "labels": {
      "thinking": "Thinking hard",
      "working": "Doing the thing",
      "prompting": "Your move",
      "idle": "Away"
    }
  }
}
```

## How it works

The plugin subscribes to the OpenCode V2 event stream.

| State | Source |
| --- | --- |
| Thinking | `session.reasoning.started` until `session.reasoning.ended` |
| Working | `session.execution.started`, tool calls, text streaming, step starts |
| Prompting | no agent activity, recent keyboard or mouse input, and the terminal is frontmost |
| Idle | nothing running and no recent input |

Token numbers come from `session.step.ended`, so the card shows the latest model call. The value matches the Context number in OpenCode's sidebar. The `cumulative` token mode uses the session totals instead, which is what the old RPC plugins showed.

The timer starts with the first activity and keeps counting through idle. A continuous idle stretch of `timer.idleResetMinutes` starts a new session timer, so opening an old chat does not show a 100 hour timer.

### Which chat is shown

The OpenCode server does not report focus changes. The plugin's TUI part writes the open chat to `~/.local/share/opencode/rich-opencode-focus.json` on route changes. The server follows that file.

- switching chats or tabs updates the card immediately
- a background chat that runs or finishes does not take over the card
- switching between terminal windows without changing the chat cannot be detected. Open the chat or send a prompt and the card updates.
- if the TUI part is missing, the plugin falls back to the session that ran last

### Prompting

OpenCode does not send prompt typing to plugins. The TUI keeps the draft local, and `tui.prompt.append` is an inbound command. Prompting therefore uses macOS system idle time and the frontmost app. It appears only when you used the keyboard or mouse in the last 60 seconds and the terminal is frontmost. On other platforms this state stays off.

### Multiple instances

OpenCode loads one plugin instance per project location. The `leaderLock` option lets one instance own the Discord connection, with a lock file at `~/.local/share/opencode/rich-opencode.lock`. The leader retries the Discord handshake with backoff if it times out.

## Custom Discord app

1. Create an application at [discord.com/developers/applications](https://discord.com/developers/applications). The app name becomes the "Playing" headline.
2. Copy the Application ID and set it as `clientId`.
3. Open Rich Presence, then Art Assets, and upload your large image with the key used by `largeImage.key`. The default key is `logo`.
4. Optional: upload provider icons and map them in `smallImage.providerIcons`.

## Development

```bash
npm run build       # compile to dist/
npm run typecheck   # type check only
npm run preview     # show a sample card in Discord for 5 seconds
npm run diagnose    # open one raw RPC connection for 10 minutes
```

Set `"debug": true` to write a log to `~/.local/share/opencode/rich-opencode-debug.log`. The log rotates at 5 MB.

## License

MIT. See [LICENSE](LICENSE).

## Credits

Rich Opencode is a modified fork of [butterbrodskiy/opencode-rpc](https://github.com/butterbrodskiy/opencode-rpc), released under MIT. Thanks to the OpenCode team for the plugin event API.
