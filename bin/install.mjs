#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { execSync } from "child_process";

const HOME = homedir();
const SERVER_URL = process.env.WELLREAD_URL || "https://wellread.dev/mcp";

// ── Styled output ──────────────────────────────────────

const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

function log(msg) { console.log(msg); }
function success(msg) { console.log(green(`  ✓ ${msg}`)); }
function skip(msg) { console.log(dim(`  - ${msg}`)); }
function warn(msg) { console.log(yellow(`  ! ${msg}`)); }

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

// ── Tool configurations ────────────────────────────────

const tools = [
  {
    name: "Claude Code",
    detect: () => existsSync(join(HOME, ".claude")),
    install: (apiKey) => {
      // Use CLI if available, otherwise write config
      try {
        execSync(
          `claude mcp add --transport http wellread ${SERVER_URL} --header "Authorization: Bearer ${apiKey}" --scope user 2>/dev/null`,
          { stdio: "pipe" }
        );
        return true;
      } catch {
        // CLI not available, write config directly
        const configPath = join(HOME, ".claude", "settings.json");
        const config = existsSync(configPath)
          ? JSON.parse(readFileSync(configPath, "utf-8"))
          : {};

        config.mcpServers = config.mcpServers || {};
        config.mcpServers.wellread = {
          type: "http",
          url: SERVER_URL,
          headers: { Authorization: `Bearer ${apiKey}` },
        };

        writeFileSync(configPath, JSON.stringify(config, null, 2));
        return true;
      }
    },
  },
  {
    name: "Cursor",
    detect: () => existsSync(join(HOME, ".cursor")),
    install: (apiKey) => {
      const configPath = join(HOME, ".cursor", "mcp.json");
      const config = existsSync(configPath)
        ? JSON.parse(readFileSync(configPath, "utf-8"))
        : {};

      config.mcpServers = config.mcpServers || {};
      config.mcpServers.wellread = {
        url: SERVER_URL,
        headers: { Authorization: `Bearer ${apiKey}` },
      };

      writeFileSync(configPath, JSON.stringify(config, null, 2));
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
        ? JSON.parse(readFileSync(configPath, "utf-8"))
        : {};

      config.mcpServers = config.mcpServers || {};
      config.mcpServers.wellread = {
        serverUrl: SERVER_URL,
        headers: { Authorization: `Bearer ${apiKey}` },
      };

      writeFileSync(configPath, JSON.stringify(config, null, 2));
      return true;
    },
  },
  {
    name: "Gemini CLI",
    detect: () => existsSync(join(HOME, ".gemini")),
    install: (apiKey) => {
      const configPath = join(HOME, ".gemini", "settings.json");
      const config = existsSync(configPath)
        ? JSON.parse(readFileSync(configPath, "utf-8"))
        : {};

      config.mcpServers = config.mcpServers || {};
      config.mcpServers.wellread = {
        httpUrl: SERVER_URL,
        headers: { Authorization: `Bearer ${apiKey}` },
      };

      writeFileSync(configPath, JSON.stringify(config, null, 2));
      return true;
    },
  },
  {
    name: "VS Code",
    detect: () =>
      existsSync(join(HOME, ".vscode")) ||
      existsSync(join(HOME, "Library", "Application Support", "Code")),
    install: (apiKey) => {
      // VS Code uses workspace-level config, so we write to user settings
      const vscodePath = join(HOME, ".vscode");
      if (!existsSync(vscodePath)) mkdirSync(vscodePath, { recursive: true });

      const configPath = join(vscodePath, "mcp.json");
      const config = existsSync(configPath)
        ? JSON.parse(readFileSync(configPath, "utf-8"))
        : {};

      config.servers = config.servers || {};
      config.servers.wellread = {
        type: "http",
        url: SERVER_URL,
        headers: { Authorization: `Bearer ${apiKey}` },
      };

      writeFileSync(configPath, JSON.stringify(config, null, 2));
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

  // 2. Register
  log(dim("  Registering..."));
  let apiKey;
  try {
    const clientNames = detected.map((t) => t.name.toLowerCase().replace(/\s+/g, "-"));
    apiKey = await registerUser(clientNames);
  } catch (err) {
    warn(`Registration failed: ${err.message}`);
    process.exit(1);
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
  log(green("  Done. wellread is active."));
  log(dim("  Restart your editor/CLI to connect."));
  log("");
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
