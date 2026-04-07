#!/usr/bin/env node
// wellread usage-stats helper
// Reads Claude Code JSONL files across ALL projects for the current user and
// outputs the current 5h window stats as JSON. Anthropic's rate limit is
// account-wide, so we have to aggregate across every workspace, not just the
// current one. Silently fails (exits 0 with "{}") on any error so the hook
// never breaks the user's session.
//
// The current workspace is also tracked separately so the badge can show
// "this conversation" context size.
//
// Output schema:
// {
//   "windowStart":   "09:00",       // local HH:MM, for display
//   "windowEnd":     "14:00",       // local HH:MM, for display
//   "windowStartMs": 1712039400000, // epoch ms — used by server to query exact window
//   "turns":         435,           // turns in current 5h window across ALL projects
//   "billable":      2688044,       // billable tokens in current 5h window across ALL projects
//   "minutesLeft":   21,
//   "contextSize":   521997,        // current conversation's context size (current workspace only)
//   "fiveHourPct":   47,            // OPTIONAL — Anthropic's authoritative used % of 5h window
//   "sevenDayPct":   39             // OPTIONAL — Anthropic's authoritative used % of 7d weekly
// }
//
// fiveHourPct/sevenDayPct come from a sibling helper (capture-usage.mjs) that
// runs as Claude Code's statusLine command and writes the latest API-header
// rate_limits snapshot to ~/.wellread/last-usage.json. We read that file here
// and merge in the percentages if they're recent enough. If the file doesn't
// exist or is stale (>10 min) the fields are simply omitted from the output.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

function fail() {
  process.stdout.write("{}");
  process.exit(0);
}

try {
  // 1. Determine current workspace from argv[2] or cwd
  const cwd = process.argv[2] || process.cwd();

  // 2. Encode cwd to Claude Code's project directory format.
  // Claude Code replaces all "/" with "-".
  const currentEncoded = cwd.replace(/\//g, "-");

  // 3. Find Claude Code projects root (legacy or new location)
  const home = homedir();
  const rootCandidates = [
    join(home, ".config", "claude", "projects"),
    join(home, ".claude", "projects"),
  ];
  let projectsRoot = null;
  for (const r of rootCandidates) {
    try {
      if (statSync(r).isDirectory()) {
        projectsRoot = r;
        break;
      }
    } catch {}
  }
  if (!projectsRoot) fail();

  // 4. Collect ALL .jsonl files from ALL projects modified in the last 24h
  const now = Date.now();
  const oneDay = 24 * 60 * 60 * 1000;
  const allFiles = []; // [{ path, project }]
  let projectDirs;
  try {
    projectDirs = readdirSync(projectsRoot);
  } catch {
    fail();
  }
  for (const dir of projectDirs) {
    const fullDir = join(projectsRoot, dir);
    let entries;
    try {
      const st = statSync(fullDir);
      if (!st.isDirectory()) continue;
      entries = readdirSync(fullDir);
    } catch {
      continue;
    }
    for (const f of entries) {
      if (!f.endsWith(".jsonl")) continue;
      const p = join(fullDir, f);
      try {
        if (now - statSync(p).mtimeMs < oneDay) {
          allFiles.push({ path: p, project: dir });
        }
      } catch {}
    }
  }

  // Filter to only files from current workspace for context size, but use all
  // files for window aggregation
  const currentWorkspaceFiles = allFiles.filter((f) => f.project === currentEncoded);
  const files = allFiles.map((f) => f.path);

  if (files.length === 0) fail();

  // 5. Parse all messages with usage data, tagging by project
  function parseFile(path, project) {
    const out = [];
    let content;
    try {
      content = readFileSync(path, "utf-8");
    } catch {
      return out;
    }
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      const ts = obj.timestamp;
      const usage = obj.message?.usage;
      if (ts && usage) {
        out.push({
          time: new Date(ts).getTime(),
          project,
          input: usage.input_tokens || 0,
          cacheCreation: usage.cache_creation_input_tokens || 0,
          cacheRead: usage.cache_read_input_tokens || 0,
          output: usage.output_tokens || 0,
        });
      }
    }
    return out;
  }

  const messages = [];
  for (const f of allFiles) {
    messages.push(...parseFile(f.path, f.project));
  }

  if (messages.length === 0) fail();

  // 6. Sort by time
  messages.sort((a, b) => a.time - b.time);

  // 7. Find current 5h window. Anthropic's window is a fixed 5h block anchored
  //    to the floor-hour of the FIRST message that doesn't fit in the previous
  //    window. Continuous activity does NOT extend a window — once 5h pass since
  //    the floor-hour anchor, the next message starts a fresh window.
  //
  //    Algorithm: walk forward, advancing the active window whenever a message
  //    falls outside it. The last window we end up with is the current one.
  const FIVE_H = 5 * 60 * 60 * 1000;
  function floorToHour(ms) {
    const d = new Date(ms);
    d.setMinutes(0, 0, 0);
    return d.getTime();
  }

  let windowStart = floorToHour(messages[0].time);
  let windowEnd = windowStart + FIVE_H;
  for (const m of messages) {
    if (m.time >= windowEnd) {
      windowStart = floorToHour(m.time);
      windowEnd = windowStart + FIVE_H;
    }
  }

  // Edge case: if "now" is past the windowEnd of the most recent message's window,
  // the user is between windows. Their next message will start a brand-new window
  // anchored to floor(now). Reflect that in the badge so it doesn't lie about turns.
  if (now >= windowEnd) {
    windowStart = floorToHour(now);
    windowEnd = windowStart + FIVE_H;
  }

  // 8. Sum usage in current window across ALL projects (account-wide rate limit)
  // We deliberately skip cache_read tokens — they don't count toward the rate
  // limit and aren't useful in the badge. Saving them in the JSON output would
  // just bloat the prompt the agent receives every turn.
  let turns = 0;
  let billable = 0;
  for (const m of messages) {
    if (m.time >= windowStart && m.time <= windowEnd) {
      turns++;
      billable += m.input + m.cacheCreation + m.output;
    }
  }

  // 9. Current context size = total input tokens of the most recent message
  //    in the CURRENT WORKSPACE (this conversation, not all of them)
  let contextSize = 0;
  const currentMessages = messages.filter((m) => m.project === currentEncoded);
  if (currentMessages.length > 0) {
    const lastMsg = currentMessages[currentMessages.length - 1];
    contextSize = lastMsg.input + lastMsg.cacheCreation + lastMsg.cacheRead;
  }

  // 10. Minutes until window reset
  const minutesLeft = Math.max(0, Math.round((windowEnd - now) / 60000));

  // 11. Format times as HH:MM (local time)
  const fmtTime = (ms) => {
    const d = new Date(ms);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  };

  const result = {
    windowStart: fmtTime(windowStart),
    windowEnd: fmtTime(windowEnd),
    windowStartMs: windowStart, // epoch ms — server uses this for exact window queries
    turns,
    billable,
    minutesLeft,
    contextSize,
  };

  // 12. Merge in Anthropic's authoritative rate_limits percentages from the
  //     statusLine capture, IF available and recent. capture-usage.mjs writes
  //     this file every time Claude Code redraws its UI, so freshness is
  //     usually <1s. We accept up to 10 min as "recent enough".
  try {
    const lastUsagePath = join(home, ".wellread", "last-usage.json");
    const lastUsageRaw = readFileSync(lastUsagePath, "utf-8");
    const lastUsage = JSON.parse(lastUsageRaw);
    const capturedAtMs = Date.parse(lastUsage.capturedAt);
    if (Number.isFinite(capturedAtMs) && now - capturedAtMs < 10 * 60 * 1000) {
      if (lastUsage.fiveHour && typeof lastUsage.fiveHour.usedPercentage === "number") {
        result.fiveHourPct = lastUsage.fiveHour.usedPercentage;
      }
      if (lastUsage.sevenDay && typeof lastUsage.sevenDay.usedPercentage === "number") {
        result.sevenDayPct = lastUsage.sevenDay.usedPercentage;
      }
    }
  } catch {
    // last-usage.json doesn't exist yet, isn't readable, or is malformed.
    // Fall through silently — the badge degrades to its existing display.
  }

  process.stdout.write(JSON.stringify(result));
} catch (err) {
  fail();
}
