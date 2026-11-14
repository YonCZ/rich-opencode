# Agent installation

Instructions for an AI coding agent. The user asked you to install Rich Opencode, a Discord Rich Presence plugin for OpenCode. Follow the steps in order. Stop and report the failing step instead of guessing.

## Rules

- Back up the OpenCode config before you edit it.
- Keep the user's existing config keys and plugin entries.
- Do not ask for a Discord password or token. The plugin talks to the local Discord app.
- Do not restart the OpenCode TUI yourself. Ask the user to restart it at the end.

## 1. Check the environment

Run these commands:

```bash
opencode --version
node --version
```

Required:

- OpenCode 2.x, or OpenCode 1.18.29 and newer
- Node 20 or newer

Check that the Discord desktop app is installed and running. On macOS:

```bash
ls /Applications/Discord.app
pgrep -f "Discord.app/Contents/MacOS/Discord" >/dev/null && echo running
```

If Discord is not running, start it and wait a few seconds. Discord in a browser will not work.

## 2. Clone and build

Install into a stable directory:

```bash
DIR="${XDG_DATA_HOME:-$HOME/.local/share}/rich-opencode"

# update if already installed
if [ -d "$DIR/.git" ]; then
  git -C "$DIR" pull --ff-only
else
  git clone https://github.com/YonCZ/OpenCode-Presence.git "$DIR"
fi

cd "$DIR"
npm install
npm run build
test -f "$DIR/dist/index.js" && echo "build ok"
```

If the build fails, stop and report the compiler output.

## 3. Register the plugin

The plugin is loaded from a local path, so add it to the global OpenCode config at `~/.config/opencode/opencode.json`.

Back up the file first:

```bash
cp ~/.config/opencode/opencode.json ~/.config/opencode/opencode.json.bak 2>/dev/null || true
```

Merge the plugin entry with this script. It keeps existing keys and entries, and removes an older entry for the same path. The script strips JSONC comments when it rewrites the file.

```bash
DIR="${XDG_DATA_HOME:-$HOME/.local/share}/rich-opencode" python3 - <<'PY'
import json, os

path = os.path.expanduser("~/.config/opencode/opencode.json")
target = os.path.abspath(os.environ["DIR"])

def strip_comments(text):
    out, i, in_string, escape = [], 0, False, False
    while i < len(text):
        ch = text[i]
        if in_string:
            out.append(ch)
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == '"':
                in_string = False
            i += 1
            continue
        if ch == '"':
            in_string = True
            out.append(ch)
            i += 1
            continue
        if ch == "/" and i + 1 < len(text) and text[i + 1] == "/":
            while i < len(text) and text[i] != "\n":
                i += 1
            continue
        if ch == "/" and i + 1 < len(text) and text[i + 1] == "*":
            i += 2
            while i + 1 < len(text) and not (text[i] == "*" and text[i + 1] == "/"):
                i += 1
            i += 2
            continue
        out.append(ch)
        i += 1
    return "".join(out)

if os.path.exists(path):
    with open(path) as f:
        data = json.loads(strip_comments(f.read()))
else:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    data = {"$schema": "https://opencode.ai/config.json"}

plugins = data.get("plugins")
if not isinstance(plugins, list):
    plugins = []

def is_target(entry):
    spec = entry if isinstance(entry, str) else entry.get("package") if isinstance(entry, dict) else None
    return isinstance(spec, str) and os.path.abspath(os.path.expanduser(spec)) == target

plugins = [entry for entry in plugins if not is_target(entry)]
plugins.append({"package": target, "options": {}})
data["plugins"] = plugins

with open(path, "w") as f:
    json.dump(data, f, indent=2)
    f.write("\n")

print("registered", target)
PY
```

The resulting entry:

```json
{
  "package": "/Users/you/.local/share/rich-opencode",
  "options": {}
}
```

## 4. Verify the plugin loads

```bash
opencode api get /api/plugin 2>/dev/null | grep -o '"id":"rich-opencode"'
```

If nothing prints, restart the background service and try again:

```bash
opencode service restart
sleep 5
opencode api get /api/plugin 2>/dev/null | grep -o '"id":"rich-opencode"'
```

Expected output is `"id":"rich-opencode"`. The plugin state should be `active`.

## 5. Ask the user for the Discord setting

You cannot enable this setting for the user. Tell them:

1. Open Discord.
2. Open User Settings with the gear icon.
3. Open Activity Privacy.
4. Turn on "Display current activity as a status message".

## 6. Restart the service and the TUI

The service caches the plugin feature list from the first load. A fresh start advertises the TUI part. Run:

```bash
opencode service restart
sleep 5
opencode api get /api/plugin 2>/dev/null | grep -o '"id":"rich-opencode","source":{[^}]*},"features":{[^}]*}'
```

The features should include `"tui":true`.

Then tell the user to quit and reopen `opencode`. The plugin includes a TUI part that reports the open chat, and the TUI loads it at startup. Their sessions and the background service stay intact.

## Troubleshooting

No presence on the profile:

- Confirm Discord desktop is running.
- Confirm the Activity Privacy setting above is on.
- Run `cd "$DIR" && npm run diagnose`. This opens one raw connection and shows a diagnostic card for 10 minutes.
- Ask the user to view their profile from a second account. Discord sometimes hides your own activity from you.

Wrong chat or stale model:

- The TUI was not restarted after install. The focus file `~/.local/share/opencode/rich-opencode-focus.json` is written by the TUI part.

Plugin not listed:

- Check `opencode --version`. Version 1 requires 1.18.29 or newer.
- Run `cd "$DIR" && npm run typecheck` and report errors.
- Set `"debug": true` in the plugin options, then read `~/.local/share/opencode/rich-opencode-debug.log` after a few minutes.

## Update

```bash
DIR="${XDG_DATA_HOME:-$HOME/.local/share}/rich-opencode"
git -C "$DIR" pull --ff-only
cd "$DIR" && npm install && npm run build
```

## Uninstall

Remove the entry from `~/.config/opencode/opencode.json` and delete the directory:

```bash
DIR="${XDG_DATA_HOME:-$HOME/.local/share}/rich-opencode"
python3 - "$DIR" <<'PY'
import json, os, sys
path = os.path.expanduser("~/.config/opencode/opencode.json")
target = os.path.abspath(sys.argv[1])
data = json.load(open(path))
plugins = data.get("plugins") or []
def is_target(entry):
    spec = entry if isinstance(entry, str) else entry.get("package") if isinstance(entry, dict) else None
    return isinstance(spec, str) and os.path.abspath(os.path.expanduser(spec)) == target
data["plugins"] = [entry for entry in plugins if not is_target(entry)]
json.dump(data, open(path, "w"), indent=2)
PY
rm -rf "$DIR"
```

Then restart the service with `opencode service restart` and the TUI.
