#!/usr/bin/env node
// wellread capture-usage helper (statusLine command)
//
// Claude Code's `statusLine.command` setting causes Claude Code to invoke this
// script every time it redraws the UI, piping a JSON payload to stdin. The
// payload — fully documented inside Claude Code's bundled cli.js — contains a
// `rate_limits` field with the user's authoritative session/weekly utilization
// percentages, sourced from API response headers Anthropic emits but Claude
// Code otherwise discards before writing JSONL.
//
// This script's only job: extract `rate_limits` from the stdin JSON, persist
// the latest snapshot to `~/.wellread/last-usage.json`, and write a minimal
// status string to stdout (which Claude Code renders in the status bar).
//
// Failure modes are silent. If anything goes wrong (no JSON, malformed JSON,
// no rate_limits yet, can't write the file), we exit 0 with empty stdout so
// Claude Code's status bar isn't affected. The wellread badge will simply
// not show the delta line until the next successful capture.
//
// Why this works: Anthropic gives Claude Code the data, Claude Code passes it
// through statusLine, and we catch it. No proxy, no scraping, no /usage REPL.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

function quietExit() {
  // No status string to render. Claude Code falls back to its default.
  process.exit(0);
}

function readStdinSync() {
  try {
    return readFileSync(0, "utf-8");
  } catch {
    return "";
  }
}

try {
  const raw = readStdinSync();
  if (!raw) quietExit();

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    quietExit();
  }

  const rl = payload?.rate_limits;
  // rate_limits is "Optional: Claude.ai subscription usage limits. Only present
  // for subscribers after first API response." So it's expected to be missing
  // sometimes — that's not an error, just no fresh data to capture this tick.
  if (!rl || typeof rl !== "object") quietExit();

  // Build the snapshot. Keep it small and only include fields we trust.
  const snapshot = {
    capturedAt: new Date().toISOString(),
    fiveHour: rl.five_hour
      ? {
          usedPercentage: typeof rl.five_hour.used_percentage === "number" ? rl.five_hour.used_percentage : null,
          resetsAt: typeof rl.five_hour.resets_at === "number" ? rl.five_hour.resets_at : null,
        }
      : null,
    sevenDay: rl.seven_day
      ? {
          usedPercentage: typeof rl.seven_day.used_percentage === "number" ? rl.seven_day.used_percentage : null,
          resetsAt: typeof rl.seven_day.resets_at === "number" ? rl.seven_day.resets_at : null,
        }
      : null,
    // Claude Code version for forward compat
    claudeCodeVersion: typeof payload.version === "string" ? payload.version : null,
  };

  // Persist to ~/.wellread/last-usage.json — atomic write via tmpfile + rename
  // so usage-stats.mjs (which reads this) never sees a half-written file.
  const dir = join(homedir(), ".wellread");
  if (!existsSync(dir)) {
    try { mkdirSync(dir, { recursive: true }); } catch { quietExit(); }
  }
  const finalPath = join(dir, "last-usage.json");
  const tmpPath = `${finalPath}.tmp.${process.pid}`;
  try {
    writeFileSync(tmpPath, JSON.stringify(snapshot));
    // rename is atomic on the same filesystem
    const { renameSync } = await import("node:fs");
    renameSync(tmpPath, finalPath);
  } catch {
    quietExit();
  }

  // Write a minimal status string to stdout. Format: "5h:NN% · 7d:NN%".
  // Skipped if values are missing. Lets the user see at-a-glance state in
  // Claude Code's status bar without needing to type /usage.
  const parts = [];
  if (snapshot.fiveHour && typeof snapshot.fiveHour.usedPercentage === "number") {
    parts.push(`5h:${Math.round(snapshot.fiveHour.usedPercentage)}%`);
  }
  if (snapshot.sevenDay && typeof snapshot.sevenDay.usedPercentage === "number") {
    parts.push(`7d:${Math.round(snapshot.sevenDay.usedPercentage)}%`);
  }
  if (parts.length > 0) {
    process.stdout.write(parts.join(" · "));
  }
} catch {
  quietExit();
}
