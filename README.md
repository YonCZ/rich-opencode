# Rich Opencode

A **highly configurable Discord Rich Presence plugin for [OpenCode](https://opencode.ai)**.

Show your model, context usage, activity status and a play-session timer on your Discord profile — arranged exactly how you want them.

```
Playing opencode
deepseek-v4.1-flash
↓ 298.8k | ↑ 398 · Working
01:23:45 elapsed
```

## Features

- **Follows your open chat** — a tiny TUI part reports which chat is open, so the card shows that chat's model and tokens instead of whatever ran last
- **Fully configurable layout** — choose which fields go on line 1 and line 2, in any order, with any separator
- **Fields**: model, token usage, cost, activity status, project name, agent, and custom literal text
- **Two token modes** — `context` (latest model call, matches OpenCode's sidebar "Context" number) or `cumulative` (session totals)
- **Activity status** — `Thinking` (model reasoning), `Working` (tools, streaming, execution), `Prompting` (you're typing), `Idle`
- **Play-session timer** — counts continuously through idle, starts a new session after a long break
- **Custom Discord app** — optional `clientId` for your own app name, logo and assets
- **One Discord connection per machine** — a leader lock prevents the duplicate-connection storms that happen when OpenCode loads a plugin per project location
- **Resilient** — retries the Discord handshake with backoff, reconnects after Discord restarts
- **Privacy-conscious** — the project name is never shown unless you add the `project` field

## Requirements

- **OpenCode 2.x** (OpenCode 1.18.29+ is also supported)
- **Discord desktop app** running on the same machine (browser Discord does not expose the IPC socket)
- In Discord: **User Settings → Activity Privacy → "Display current activity as a status message"** must be ON
- The `Prompting` heuristics use macOS system APIs (`ioreg`, `lsappinfo`); on other platforms the plugin still works, but `Prompting` stays off and `Idle` is used instead

## Install

Rich Opencode is installed from a local checkout (npm publishing planned):

```bash
git clone https://github.com/YonCZ/rich-opencode.git
cd rich-opencode
npm install
npm run build
```

Then register it in `~/.config/opencode/opencode.json` (or a project `opencode.json`):

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

Save the config (OpenCode hot-reloads) or run `opencode service restart`.

> Restart your OpenCode TUI once after installing. The plugin ships a tiny TUI part that reports the open chat; it only loads when the TUI starts.

> The `options` block below is optional — every setting has a default.

## Configuration

All options live in the `options` object of the plugin entry:

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

### Lines and fields

`details` is line 1, `state` is line 2. Fields render in order and empty ones are skipped.

| Field | Renders |
| --- | --- |
| `model` | the active model id, e.g. `deepseek-v4.1-flash` |
| `tokens` | token usage, e.g. `↓ 298.8k \| ↑ 398` |
| `cost` | cumulative session cost, e.g. `$1.42` |
| `status` | `Thinking` / `Working` / `Prompting` / `Idle` |
| `project` | the project folder name |
| `agent` | the active agent id |
| `text:<anything>` | literal text, e.g. `"text:in opencode"` |

### Options reference

| Option | Default | Description |
| --- | --- | --- |
| `clientId` | built-in shared app | Discord application id (see [Custom Discord app](#custom-discord-app)) |
| `details` | `["model"]` | line 1 fields |
| `state` | `["tokens", "status"]` | line 2 fields |
| `separator` | `" · "` | joins non-empty fields |
| `tokens.mode` | `"context"` | `context` = latest model call (matches OpenCode's sidebar), `cumulative` = session totals |
| `tokens.showInput` | `true` | show the input/context half |
| `tokens.showOutput` | `true` | show the output half |
| `tokens.inputPrefix` | `"↓"` | prefix for input tokens |
| `tokens.outputPrefix` | `"↑"` | prefix for output tokens |
| `cost.show` | `false` | include cost in the `cost` field |
| `cost.format` | `"${amount}"` | `{amount}` is replaced with the number |
| `status.labels.*` | `Thinking` / `Working` / `Prompting` / `Idle` | rename or translate the states |
| `prompting.idleSeconds` | `60` | input within this window counts as prompting |
| `prompting.frontmostOnly` | `true` | require one of `prompting.apps` to be frontmost (macOS) |
| `prompting.apps` | Terminal, iTerm2, Ghostty, Warp, VS Code, Cursor, … | apps that count as "the opencode window" |
| `timer.enabled` | `true` | show the Discord elapsed timer |
| `timer.idleResetMinutes` | `30` | a continuous idle stretch this long starts a new play session |
| `largeImage.key` | `"logo"` | Discord asset key for the large image |
| `largeImage.text` | `"OpenCode"` | hover text for the large image |
| `smallImage.enabled` | `false` | show a small provider icon |
| `smallImage.providerIcons` | `{}` | override icon URLs per provider id |
| `debug` | `false` | log lifecycle and flush details to `~/.local/share/opencode/rich-opencode-debug.log` |
| `leaderLock` | `true` | let one plugin instance own the Discord connection |

### Examples

**Everything on two lines**

```jsonc
"options": {
  "details": ["model", "project"],
  "state": ["tokens", "status"]
}
```

**Literal text + total usage**

```jsonc
"options": {
  "details": ["text:Rich Opencode", "project"],
  "state": ["tokens", "cost", "status"],
  "tokens": { "mode": "cumulative" },
  "cost": { "show": true }
}
```

**Localized labels and a custom separator**

```jsonc
"options": {
  "separator": " — ",
  "status": {
    "labels": {
      "thinking": "Přemýšlí",
      "working": "Pracuje",
      "prompting": "Píše",
      "idle": "Nečinný"
    }
  }
}
```

## How it works

Rich Opencode runs as an OpenCode server plugin and subscribes to the V2 event stream:

| Status | Source |
| --- | --- |
| `Thinking` | `session.reasoning.started` → `session.reasoning.ended` |
| `Working` | `session.execution.started`, tool calls, text streaming, step starts |
| `Prompting` | no agent activity, recent keyboard/mouse input, and (optionally) the terminal is frontmost |
| `Idle` | nothing running and no recent input |

Token numbers come from `session.step.ended` — the latest model call — so the card matches the "Context" number in OpenCode's sidebar instead of inflating to the whole session's cumulative usage.

### Which chat is shown

OpenCode's server does not broadcast focus changes, so the plugin's TUI part writes the currently open chat to `~/.local/share/opencode/rich-opencode-focus.json` (on route change). The server follows that file, which means:

- switching chats/tabs updates the card immediately
- a background chat that runs or finishes **does not** take over the card
- switching between separate terminal windows without changing the chat is not detectable (open the chat or send a prompt and it updates)

If the TUI part is unavailable (e.g. an older TUI), the plugin falls back to activity-based switching.

The elapsed timer starts with the first activity and keeps counting through idle. A continuous idle stretch of `timer.idleResetMinutes` starts a new play session, so an old session opened days later doesn't show a 100+ hour timer.

OpenCode loads one plugin instance per project location. `leaderLock` lets exactly one of them own the Discord IPC connection (lock file: `~/.local/share/opencode/rich-opencode.lock`), and the leader retries with backoff if the 10s Discord handshake times out.

### Prompting caveat

OpenCode does not broadcast prompt typing — the TUI keeps your prompt draft local (`tui.prompt.append` is an inbound command, not a typing signal). `Prompting` therefore approximates "you're typing" with macOS system input activity plus the frontmost app check. On non-macOS platforms it stays off.

## Custom Discord app

For your own name, logo and assets:

1. Create an application at [discord.com/developers/applications](https://discord.com/developers/applications) — the app name becomes the "Playing …" headline
2. Copy the **Application ID** → `clientId`
3. Under **Rich Presence → Art Assets**, upload your large image with the asset key used by `largeImage.key` (default `logo`)
4. Optionally upload provider icons and map them via `smallImage.providerIcons`

## Development

```bash
npm run build       # tsc → dist/
npm run typecheck   # type check only
npm run preview     # flash a sample card in Discord for ~5s (optionally pass a status: preview thinking)
npm run diagnose    # open a single raw RPC connection for 10 minutes
```

Set `"debug": true` in the options to get a log at `~/.local/share/opencode/rich-opencode-debug.log` (rotated at 5 MB).

## License

MIT. See [LICENSE](LICENSE).

## Credits

Rich Opencode is a heavily modified fork of [butterbrodskiy/opencode-rpc](https://github.com/butterbrodskiy/opencode-rpc) (MIT), which this project would not exist without. Thanks also to the OpenCode team for the plugin event API.
