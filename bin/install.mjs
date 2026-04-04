#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { execFileSync } from "child_process";

const HOME = homedir();
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
cat <<'HOOKEOF'
Non-chitchat turns only - strict order:
1. SEARCH FIRST: mcp__wellread__search(hook_version:6, queries:[3 variants], keywords:"terms") - no parallel calls, await results.
2. Used non-wellread tool? -> mcp__wellread__save with your findings BEFORE responding.
3. RESPOND per freshness: fresh->answer | check->web verify + save(verify_id) | stale->re-research.
4. Search returned results? -> append badge.
HOOKEOF`;

// ── Rules markdown (for clients without hooks) ───────

const RULES_MD = `# Wellread — Collective Research Memory

Non-chitchat turns only - strict order:
1. SEARCH FIRST: wellread search (hook_version:6, queries:[3 variants], keywords:"terms") - no parallel calls, await results.
2. Used non-wellread tool? -> wellread save with your findings BEFORE responding.
3. RESPOND per freshness: fresh->answer | check->web verify + save(verify_id) | stale->re-research.
4. Search returned results? -> append badge.
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
