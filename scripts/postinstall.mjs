import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { execSync } from "node:child_process";

const PLUGIN_NAME = "opencode-rpc";

if (process.env.SKIP_OPENCODE_AUTO_CONFIG) {
  process.exit(0);
}

function findConfig() {
  let dir = process.cwd();
  while (true) {
    for (const name of ["opencode.json", "opencode.jsonc"]) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  for (const name of ["opencode.json", "opencode.jsonc"]) {
    const candidate = join(homedir(), ".config", "opencode", name);
    if (existsSync(candidate)) return candidate;
  }
  return join(process.cwd(), "opencode.json");
}

function openCodeMajor() {
  try {
    const out = execSync("opencode --version", { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] });
    const match = out.match(/(\d+)\./);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

// OpenCode 2 reads `plugins`; OpenCode 1 reads `plugin`. Prefer the key the file already uses.
function pickKey(raw) {
  if (/"plugins"\s*:/.test(raw)) return "plugins";
  if (/"plugin"\s*:/.test(raw)) return "plugin";
  const major = openCodeMajor();
  return major !== null && major < 2 ? "plugin" : "plugins";
}

function insertIntoArray(raw, key) {
  const match = new RegExp(`"${key}"\\s*:\\s*\\[`).exec(raw);
  if (!match) return null;

  const open = match.index + match[0].length - 1;
  let depth = 0;
  let close = -1;
  for (let i = open; i < raw.length; i++) {
    if (raw[i] === "[") depth++;
    else if (raw[i] === "]") {
      depth--;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (close === -1) return null;

  const lineStart = raw.lastIndexOf("\n", match.index) + 1;
  const indentMatch = /^[ \t]*/.exec(raw.slice(lineStart, match.index));
  const indent = indentMatch ? indentMatch[0] : "  ";
  const inner = raw.slice(open + 1, close);
  const entry = `"${PLUGIN_NAME}"`;

  if (inner.trim().length === 0) {
    return `${raw.slice(0, open + 1)}\n${indent}  ${entry}\n${indent}${raw.slice(close)}`;
  }

  const body = inner.replace(/\s+$/, "");
  const separator = body.endsWith(",") ? " " : ", ";
  return `${raw.slice(0, open + 1)}${body}${separator}${entry} ${raw.slice(close)}`;
}

function appendKey(raw, key) {
  const trimmed = raw.trimEnd();
  const lastBrace = trimmed.lastIndexOf("}");
  if (lastBrace < 0) return `{\n  "${key}": ["${PLUGIN_NAME}"]\n}\n`;

  const body = trimmed.slice(0, lastBrace).trimEnd();
  const needsComma = !body.endsWith("{") && !body.endsWith(",");
  return `${body}${needsComma ? "," : ""}\n  "${key}": ["${PLUGIN_NAME}"]\n}\n`;
}

const configPath = findConfig();
const label = configPath.split(/[\\/]/).pop();

if (!existsSync(configPath)) {
  writeFileSync(configPath, `{\n  "${pickKey("")}": ["${PLUGIN_NAME}"]\n}\n`, "utf8");
  console.log(`[opencode-rpc] created ${configPath}`);
  process.exit(0);
}

const raw = readFileSync(configPath, "utf8");

if (raw.includes(`"${PLUGIN_NAME}"`)) {
  console.log(`[opencode-rpc] already registered in ${label}`);
  process.exit(0);
}

const key = pickKey(raw);
const withArray = insertIntoArray(raw, key);
writeFileSync(configPath, withArray ?? appendKey(raw, key), "utf8");
console.log(`[opencode-rpc] added to "${key}" in ${label}`);
