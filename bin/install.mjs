#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { homedir } from "os";
import { execFileSync } from "child_process";

const HOME = homedir();
const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_URL = process.env.WELLREAD_URL || "https://wellread-production.up.railway.app/mcp";



// ── Styled output ──────────────────────────────────────

const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

function log(msg) { console.log(msg); }
function success(msg) { console.log(green(`  ✓ ${msg}`)); }
function skip(msg) { console.log(dim(`  - ${msg}`)); }
function warn(msg) { console.log(yellow(`  ! ${msg}`)); }

function readJSON(path) {
  try { return JSON.parse(readFileSync(path, "utf-8")); }
  catch { return {}; }
}

// ── Find existing API key ────────────────────────────────

function findExistingApiKey() {
  // Check all known config locations for an existing wellread API key
  const configPaths = [
    { path: join(HOME, ".claude.json"), extract: (c) => c?.mcpServers?.wellread?.headers?.Authorization },
    { path: join(HOME, ".claude", "settings.json"), extract: (c) => c?.mcpServers?.wellread?.headers?.Authorization },
    { path: join(HOME, ".cursor", "mcp.json"), extract: (c) => c?.mcpServers?.wellread?.headers?.Authorization },
    { path: join(HOME, ".codeium", "windsurf", "mcp_config.json"), extract: (c) => c?.mcpServers?.wellread?.headers?.Authorization },
    { path: join(HOME, ".gemini", "settings.json"), extract: (c) => c?.mcpServers?.wellread?.headers?.Authorization },
    { path: join(HOME, ".vscode", "mcp.json"), extract: (c) => c?.servers?.wellread?.headers?.Authorization },
    { path: join(HOME, ".config", "opencode", "opencode.json"), extract: (c) => c?.mcp?.wellread?.headers?.Authorization },
  ];

  for (const { path, extract } of configPaths) {
    if (!existsSync(path)) continue;
    const config = readJSON(path);
    const auth = extract(config);
    if (auth && auth.startsWith("Bearer wr_")) {
      return auth.replace("Bearer ", "");
    }
  }
  return null;
}

// ── Register user ──────────────────────────────────────

async function registerUser(clients) {
  const res = await fetch(`${SERVER_URL.replace("/mcp", "")}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clients }),
  });

  if (!res.ok) {
    throw new Error(`Registration failed: ${res.statusText}`);
  }

  const data = await res.json();
  return data.api_key;
}

// ── Hook script (embedded) ────────────────────────────

const HOOK_SCRIPT = `#!/bin/bash
INPUT=$(cat)
PROMPT=$(echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('prompt',''))" 2>/dev/null || echo "")
if [ \${#PROMPT} -lt 20 ]; then exit 0; fi

cat <<HOOKEOF
Wellread: research others already paid for. Skip for chitchat or pure local-code.
1. SEARCH FIRST: mcp__wellread__search(hook_version:11, query:"sanitized question — remove project names, keys, paths. Keep ALL technical terms.", keywords:"key terms") — no parallel, await.
2. Hit? fresh→answer | check→web verify + save(verify_id) BEFORE answering | stale→re-research + save BEFORE answering.
   Miss? → research with web tools, then save BEFORE answering. Contribution is non-optional.
3. If you used any web tool, call mcp__wellread__save(...) BEFORE writing your response. Sources: https:// only.
4. Hit? Append badge.
HOOKEOF`;

// ── PostToolUse hook (embedded) ───────────────────────
// Measures real token cost from JSONL after a save, updates server via PATCH /measure.

const POST_SAVE_MEASURE_SCRIPT = `#!/usr/bin/env node
import { readFileSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
const LOG = join(homedir(), ".wellread", "measure-log.jsonl");
function log(obj) { try { appendFileSync(LOG, JSON.stringify({ ...obj, ts: new Date().toISOString() }) + "\\n"); } catch {} }
function getServerConfig() {
  for (const p of [join(homedir(), ".claude", "settings.json"), join(homedir(), ".config", "claude", "settings.json")]) {
    try {
      const s = JSON.parse(readFileSync(p, "utf-8"));
      const w = s.mcpServers?.wellread;
      if (w?.url && w?.headers?.Authorization) return { baseUrl: w.url.replace(/\\/mcp\\/?$/, ""), authHeader: w.headers.Authorization };
    } catch {}
  }
  return null;
}
try {
  const hook = JSON.parse(readFileSync("/dev/stdin", "utf-8"));
  if (!hook.tool_name?.includes("wellread__save")) process.exit(0);
  let researchId = null;
  const tr = hook.tool_response;
  if (Array.isArray(tr)) { for (const item of tr) { if (item.type === "text" && item.text) { const m = item.text.match(/research_id:([a-f0-9-]+)/); if (m) researchId = m[1]; } } }
  else if (typeof tr === "string") { const m = tr.match(/research_id:([a-f0-9-]+)/); if (m) researchId = m[1]; }
  if (!researchId || !hook.transcript_path) { log({ error: "missing research_id or transcript_path" }); process.exit(0); }
  const config = getServerConfig();
  if (!config) { log({ error: "no server config" }); process.exit(0); }
  const content = readFileSync(hook.transcript_path, "utf-8");
  const entries = content.split("\\n").filter(l => l.trim()).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  let searchIdx = -1, saveIdx = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    const ca = entries[i]?.message?.content;
    if (!Array.isArray(ca)) continue;
    for (const c of ca) {
      if (c.type === "tool_use") {
        if (c.name?.includes("wellread__save") && saveIdx === -1) saveIdx = i;
        if (c.name?.includes("wellread__search") && searchIdx === -1 && saveIdx !== -1) searchIdx = i;
      }
    }
    if (searchIdx !== -1) break;
  }
  if (searchIdx === -1 || saveIdx === -1) { log({ error: "no span", searchIdx, saveIdx }); process.exit(0); }
  let baseline = 0;
  const su = entries[searchIdx]?.message?.usage;
  if (su) baseline = (su.input_tokens || 0) + (su.cache_creation_input_tokens || 0) + (su.cache_read_input_tokens || 0);
  let totalContext = 0, researchTurns = 0;
  for (let i = searchIdx; i <= saveIdx; i++) {
    const u = entries[i]?.message?.usage;
    if (!u) continue;
    totalContext += (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
    researchTurns++;
  }
  const rawTokens = Math.max(0, totalContext - (baseline * researchTurns));
  log({ event: "measured", researchId, researchTurns, baseline, totalContext, rawTokens });
  const res = await fetch(\`\${config.baseUrl}/measure\`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", "Authorization": config.authHeader },
    body: JSON.stringify({ id: researchId, raw_tokens: rawTokens, research_turns: researchTurns, total_context: totalContext }),
  });
  log({ event: "updated", researchId, status: res.status });
} catch (err) { log({ error: String(err) }); }
process.exit(0);
`;

// ── Rules markdown (for clients without hooks) ───────

const RULES_MD = `# Wellread — Collective Research Memory

Wellread: research others already paid for. Skip for chitchat or pure local-code.

1. SEARCH FIRST: wellread search (hook_version:11, query:"sanitized question", keywords:"key terms") — no parallel, await.
2. Hit? fresh→answer | check→web verify + save(verify_id) | stale→re-research + save.
   Miss? → research with web tools, then save BEFORE answering. Contribution is non-optional.
3. If you used any web tool, call save(...) BEFORE writing your response. Sources: https:// only.
4. Hit? Append badge.
`;

// ── Tool configurations ────────────────────────────────

const tools = [
  {
    name: "Claude Code",
    detect: () => existsSync(join(HOME, ".claude")),
    install: (apiKey) => {
      // Write hook script
      const hooksDir = join(HOME, ".wellread");
      if (!existsSync(hooksDir)) mkdirSync(hooksDir, { recursive: true });
      const hookPath = join(hooksDir, "hook.sh");
      writeFileSync(hookPath, HOOK_SCRIPT, { mode: 0o755 });

      // MCP server config — update both ~/.claude.json and ~/.claude/settings.json
      // to avoid desync when one has an old API key
      const mcpEntry = {
        type: "http",
        url: SERVER_URL,
        headers: { Authorization: `Bearer ${apiKey}` },
      };

      // ~/.claude.json (written by `claude mcp add`)
      const claudeJsonPath = join(HOME, ".claude.json");
      if (existsSync(claudeJsonPath)) {
        const cj = readJSON(claudeJsonPath);
        cj.mcpServers = cj.mcpServers || {};
        cj.mcpServers.wellread = mcpEntry;
        writeFileSync(claudeJsonPath, JSON.stringify(cj, null, 2));
      } else {
        try {
          execFileSync("claude", [
            "mcp", "add", "--transport", "http", "wellread", SERVER_URL,
            "--header", `Authorization: Bearer ${apiKey}`, "--scope", "user",
          ], { stdio: "pipe" });
        } catch {
          // CLI not available, write manually
        }
      }

      // ~/.claude/settings.json (fallback, always update)
      {
        const configPath = join(HOME, ".claude", "settings.json");
        const config = existsSync(configPath)
          ? readJSON(configPath)
          : {};
        config.mcpServers = config.mcpServers || {};
        config.mcpServers.wellread = mcpEntry;
        writeFileSync(configPath, JSON.stringify(config, null, 2));
      }

      // Hook: always goes in settings.json
      const configPath = join(HOME, ".claude", "settings.json");
      const config = existsSync(configPath)
        ? readJSON(configPath)
        : {};

      config.hooks = config.hooks || {};
      config.hooks.UserPromptSubmit = config.hooks.UserPromptSubmit || [];

      // Check if wellread hook already exists
      const hasHook = config.hooks.UserPromptSubmit.some((h) =>
        JSON.stringify(h).includes("wellread")
      );

      if (!hasHook) {
        config.hooks.UserPromptSubmit.push({
          hooks: [
            {
              type: "command",
              command: `bash ${hookPath}`,
            },
          ],
        });
      }

      // PostToolUse hook: measures real token cost after save via JSONL analysis
      const measurePath = join(hooksDir, "post-save-measure.mjs");
      writeFileSync(measurePath, POST_SAVE_MEASURE_SCRIPT, { mode: 0o755 });

      config.hooks.PostToolUse = config.hooks.PostToolUse || [];
      const hasPostHook = config.hooks.PostToolUse.some((h) =>
        JSON.stringify(h).includes("wellread")
      );
      if (!hasPostHook) {
        config.hooks.PostToolUse.push({
          matcher: "mcp__wellread__save",
          hooks: [
            {
              type: "command",
              command: `node ${measurePath}`,
            },
          ],
        });
      }

      writeFileSync(configPath, JSON.stringify(config, null, 2));
      return true;
    },
  },
  {
    name: "Cursor",
    detect: () => existsSync(join(HOME, ".cursor")),
    install: (apiKey) => {
      const configPath = join(HOME, ".cursor", "mcp.json");
      const config = existsSync(configPath)
        ? readJSON(configPath)
        : {};

      config.mcpServers = config.mcpServers || {};
      config.mcpServers.wellread = {
        url: SERVER_URL,
        headers: { Authorization: `Bearer ${apiKey}` },
      };

      writeFileSync(configPath, JSON.stringify(config, null, 2));

      // Write global rules (.mdc)
      const rulesDir = join(HOME, ".cursor", "rules");
      if (!existsSync(rulesDir)) mkdirSync(rulesDir, { recursive: true });
      const mdcContent = `---
description: Wellread collective research memory
globs:
alwaysApply: true
---

${RULES_MD}`;
      writeFileSync(join(rulesDir, "wellread.mdc"), mdcContent);

      return true;
    },
  },
  {
    name: "Windsurf",
    detect: () => existsSync(join(HOME, ".codeium", "windsurf")),
    install: (apiKey) => {
      const configDir = join(HOME, ".codeium", "windsurf");
      const configPath = join(configDir, "mcp_config.json");
      const config = existsSync(configPath)
        ? readJSON(configPath)
        : {};

      config.mcpServers = config.mcpServers || {};
      config.mcpServers.wellread = {
        serverUrl: SERVER_URL,
        headers: { Authorization: `Bearer ${apiKey}` },
      };

      writeFileSync(configPath, JSON.stringify(config, null, 2));

      // Write global rules
      const memoriesDir = join(configDir, "memories");
      if (!existsSync(memoriesDir)) mkdirSync(memoriesDir, { recursive: true });
      const rulesPath = join(memoriesDir, "global_rules.md");
      const existing = existsSync(rulesPath) ? readFileSync(rulesPath, "utf-8") : "";
      if (!existing.includes("wellread")) {
        const separator = existing.length > 0 ? "\n\n---\n\n" : "";
        writeFileSync(rulesPath, existing + separator + RULES_MD);
      }

      return true;
    },
  },
  {
    name: "Gemini CLI",
    detect: () => existsSync(join(HOME, ".gemini")),
    install: (apiKey) => {
      const configPath = join(HOME, ".gemini", "settings.json");
      const config = existsSync(configPath)
        ? readJSON(configPath)
        : {};

      config.mcpServers = config.mcpServers || {};
      config.mcpServers.wellread = {
        httpUrl: SERVER_URL,
        headers: { Authorization: `Bearer ${apiKey}` },
      };

      writeFileSync(configPath, JSON.stringify(config, null, 2));

      // Write GEMINI.md with rules
      const geminiMdPath = join(HOME, ".gemini", "GEMINI.md");
      const existing = existsSync(geminiMdPath) ? readFileSync(geminiMdPath, "utf-8") : "";
      if (!existing.includes("wellread")) {
        const separator = existing.length > 0 ? "\n\n---\n\n" : "";
        writeFileSync(geminiMdPath, existing + separator + RULES_MD);
      }

      return true;
    },
  },
  {
    name: "VS Code",
    detect: () =>
      existsSync(join(HOME, ".vscode")) ||
      existsSync(join(HOME, "Library", "Application Support", "Code")),
    install: (apiKey) => {
      const vscodePath = join(HOME, ".vscode");
      if (!existsSync(vscodePath)) mkdirSync(vscodePath, { recursive: true });

      // MCP server config
      const configPath = join(vscodePath, "mcp.json");
      const config = existsSync(configPath)
        ? readJSON(configPath)
        : {};

      config.servers = config.servers || {};
      config.servers.wellread = {
        type: "http",
        url: SERVER_URL,
        headers: { Authorization: `Bearer ${apiKey}` },
      };

      writeFileSync(configPath, JSON.stringify(config, null, 2));

      // Write Copilot instructions
      const instructionsDir = join(HOME, ".copilot", "instructions");
      if (!existsSync(instructionsDir)) mkdirSync(instructionsDir, { recursive: true });
      writeFileSync(join(instructionsDir, "wellread.instructions.md"), RULES_MD);

      return true;
    },
  },
  {
    name: "OpenCode",
    detect: () => existsSync(join(HOME, ".config", "opencode")),
    install: (apiKey) => {
      // MCP server config
      const configPath = join(HOME, ".config", "opencode", "opencode.json");
      const config = existsSync(configPath)
        ? readJSON(configPath)
        : {};

      config.mcp = config.mcp || {};
      config.mcp.wellread = {
        type: "remote",
        url: SERVER_URL,
        headers: { Authorization: `Bearer ${apiKey}` },
      };

      writeFileSync(configPath, JSON.stringify(config, null, 2));

      // Write rules
      const rulesDir = join(HOME, ".config", "opencode", "rules");
      if (!existsSync(rulesDir)) mkdirSync(rulesDir, { recursive: true });
      writeFileSync(join(rulesDir, "wellread.md"), RULES_MD);

      return true;
    },
  },
];

// ── Random name generator (adjective-animal-NNNN) ─────

const ADJECTIVES = [
  "swift","bright","calm","bold","keen","warm","cool","wild","free","kind",
  "deep","fair","glad","pure","wise","brave","crisp","deft","firm","fond",
  "grand","hale","just","lush","mild","neat","prime","rare","safe","sage",
  "tall","true","vast","avid","epic","hardy","jolly","lucid","lunar","noble",
  "opal","plush","polar","quiet","rapid","regal","risen","royal","sleek","solar",
  "sonic","stark","sunny","tidal","vivid","witty","young","agile","amber","azure",
  "cedar","coral","ember","flint","frost","ivory","jade","maple","misty","onyx",
  "pixel","prism","rustic","silver","velvet","focal","gilt","ionic","ultra","major",
];

const ANIMALS = [
  "otter","hawk","fox","panda","wolf","eagle","lynx","heron","falcon","crane",
  "raven","cobra","bison","whale","shark","tiger","finch","gecko","koala","lemur",
  "moose","newt","okapi","quail","robin","sloth","stork","tapir","viper","wren",
  "yak","zebra","alpaca","badger","camel","dingo","egret","ferret","grouse","hare",
  "ibis","jackal","kiwi","lark","mink","narwhal","osprey","parrot","puma","rook",
  "salmon","tern","vole","walrus","condor","dove","ermine","gull","hippo","iguana",
  "jay","koi","lion","marten","ocelot","penguin","quetzal","seal","toucan","vulture",
  "wombat","axolotl","bobcat","cicada","drake","rail","urchin","swift","nuthatch","umbra",
];

function generateRandomName() {
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const animal = ANIMALS[Math.floor(Math.random() * ANIMALS.length)];
  const token = String(Math.floor(Math.random() * 10000)).padStart(4, "0");
  return `${adj}-${animal}-${token}`;
}

// ── Username prompt ───────────────────────────────────

async function promptUsername() {
  const { createInterface } = await import("readline");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`  Pick a username (or Enter for a random one): `, (answer) => {
      rl.close();
      const trimmed = answer.trim();
      if (trimmed) {
        // Sanitize: lowercase, replace spaces with hyphens, remove non-alphanumeric
        const clean = trimmed.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "").slice(0, 30);
        resolve(clean || generateRandomName());
      } else {
        const randomName = generateRandomName();
        log(dim(`  → ${randomName}`));
        resolve(randomName);
      }
    });
  });
}

// ── Main ───────────────────────────────────────────────

async function main() {
  log("");
  log(bold("  wellread"));
  log(dim("  Collective research memory for AI agents"));
  log("");

  // 1. Detect tools
  const detected = tools.filter((t) => t.detect());

  if (detected.length === 0) {
    warn("No supported tools detected.");
    log(dim("  Supported: Claude Code, Cursor, Windsurf, Gemini CLI, VS Code"));
    process.exit(1);
  }

  log(`  Found: ${detected.map((t) => t.name).join(", ")}`);
  log("");

  // 2. Find existing key or register new user
  let apiKey = findExistingApiKey();
  if (apiKey) {
    log(dim("  Existing account found."));
  } else {
    log(dim("  Registering..."));
    try {
      const clientNames = detected.map((t) => t.name.toLowerCase().replace(/\s+/g, "-"));
      apiKey = await registerUser(clientNames);
    } catch (err) {
      warn(`Registration failed: ${err.message}`);
      process.exit(1);
    }
  }

  // 3. Install in each detected tool
  for (const tool of detected) {
    try {
      tool.install(apiKey);
      success(tool.name);
    } catch (err) {
      warn(`${tool.name}: ${err.message}`);
    }
  }

  // 4. Username prompt — after everything works, ask for a community name.
  //    Skip = random name (haikunator-style: adjective-animal-NNNN).
  //    The name is displayed in badges when others hit your research.
  log("");
  const username = await promptUsername();
  if (username) {
    try {
      const baseUrl = SERVER_URL.replace("/mcp", "");
      const res = await fetch(`${baseUrl}/user`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ name: username }),
      });
      if (res.ok) {
        success(`You're @${username} in the community`);
      } else {
        warn("Couldn't save username — you can set it later with: npx wellread name");
      }
    } catch {
      warn("Couldn't save username — you can set it later with: npx wellread name");
    }
  }

  log("");
  log(green("  ✓ Done."));
  log("");
  log(`  1️⃣  Restart your editor/CLI to activate`);
  log(`  2️⃣  Type ${bold("\"use wellread\"")} in any prompt — or let it trigger automatically`);
  log("");
}

// ── Uninstall ────────────────────────────────────────────

async function uninstall() {
  log("");
  log(bold("  wellread uninstall"));
  log("");

  // Claude Code
  const claudeJsonPath = join(HOME, ".claude.json");
  if (existsSync(claudeJsonPath)) {
    const config = readJSON(claudeJsonPath);
    if (config.mcpServers?.wellread) {
      delete config.mcpServers.wellread;
      writeFileSync(claudeJsonPath, JSON.stringify(config, null, 2));
      success("Claude Code (.claude.json)");
    }
  }

  const claudeSettingsPath = join(HOME, ".claude", "settings.json");
  if (existsSync(claudeSettingsPath)) {
    const config = readJSON(claudeSettingsPath);
    let changed = false;
    if (config.mcpServers?.wellread) {
      delete config.mcpServers.wellread;
      changed = true;
    }
    if (config.hooks?.UserPromptSubmit) {
      config.hooks.UserPromptSubmit = config.hooks.UserPromptSubmit.filter(
        (h) => !JSON.stringify(h).includes("wellread")
      );
      changed = true;
    }
    if (config.hooks?.PostToolUse) {
      config.hooks.PostToolUse = config.hooks.PostToolUse.filter(
        (h) => !JSON.stringify(h).includes("wellread")
      );
      changed = true;
    }
    if (changed) {
      writeFileSync(claudeSettingsPath, JSON.stringify(config, null, 2));
      success("Claude Code (settings.json + hook)");
    }
  }

  // Cursor
  const cursorMcpPath = join(HOME, ".cursor", "mcp.json");
  if (existsSync(cursorMcpPath)) {
    const config = readJSON(cursorMcpPath);
    if (config.mcpServers?.wellread) {
      delete config.mcpServers.wellread;
      writeFileSync(cursorMcpPath, JSON.stringify(config, null, 2));
    }
  }
  const cursorRulePath = join(HOME, ".cursor", "rules", "wellread.mdc");
  if (existsSync(cursorRulePath)) {
    const { unlinkSync } = await import("fs");
    unlinkSync(cursorRulePath);
    success("Cursor");
  }

  // Windsurf
  const windsurfMcpPath = join(HOME, ".codeium", "windsurf", "mcp_config.json");
  if (existsSync(windsurfMcpPath)) {
    const config = readJSON(windsurfMcpPath);
    if (config.mcpServers?.wellread) {
      delete config.mcpServers.wellread;
      writeFileSync(windsurfMcpPath, JSON.stringify(config, null, 2));
      success("Windsurf");
    }
  }

  // Gemini CLI
  const geminiPath = join(HOME, ".gemini", "settings.json");
  if (existsSync(geminiPath)) {
    const config = readJSON(geminiPath);
    if (config.mcpServers?.wellread) {
      delete config.mcpServers.wellread;
      writeFileSync(geminiPath, JSON.stringify(config, null, 2));
      success("Gemini CLI");
    }
  }

  // VS Code
  const vscodeMcpPath = join(HOME, ".vscode", "mcp.json");
  if (existsSync(vscodeMcpPath)) {
    const config = readJSON(vscodeMcpPath);
    if (config.servers?.wellread) {
      delete config.servers.wellread;
      writeFileSync(vscodeMcpPath, JSON.stringify(config, null, 2));
      success("VS Code");
    }
  }
  const copilotRulePath = join(HOME, ".copilot", "instructions", "wellread.instructions.md");
  if (existsSync(copilotRulePath)) {
    const { unlinkSync } = await import("fs");
    unlinkSync(copilotRulePath);
  }

  // OpenCode
  const opencodePath = join(HOME, ".config", "opencode", "opencode.json");
  if (existsSync(opencodePath)) {
    const config = readJSON(opencodePath);
    if (config.mcp?.wellread) {
      delete config.mcp.wellread;
      writeFileSync(opencodePath, JSON.stringify(config, null, 2));
      success("OpenCode");
    }
  }
  const opencodeRulePath = join(HOME, ".config", "opencode", "rules", "wellread.md");
  if (existsSync(opencodeRulePath)) {
    const { unlinkSync } = await import("fs");
    unlinkSync(opencodeRulePath);
  }

  // Wellread hook dir
  const wellreadDir = join(HOME, ".wellread");
  if (existsSync(wellreadDir)) {
    const { rmSync } = await import("fs");
    rmSync(wellreadDir, { recursive: true });
  }

  log("");
  log(green("  ✓ Wellread removed. Restart your editor/CLI to complete."));
  log("");
}

const cmd = process.argv[2];
if (cmd === "uninstall") {
  uninstall().catch((err) => { console.error("Error:", err.message); process.exit(1); });
} else {
  main().catch((err) => { console.error("Error:", err.message); process.exit(1); });
}
