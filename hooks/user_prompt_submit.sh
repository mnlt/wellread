#!/bin/bash
# WellRead — UserPromptSubmit hook (v9 — local stats injection)

INPUT=$(cat)
PROMPT=$(echo "$INPUT" | jq -r '.prompt // empty')

if [ ${#PROMPT} -lt 20 ]; then
  exit 0
fi

# Read current 5h window stats from local Claude Code logs (silently empty on failure)
STATS=$(node "$HOME/.wellread/usage-stats.mjs" "$PWD" 2>/dev/null || echo "{}")

cat <<HOOKEOF
Wellread caches PUBLIC research (libraries, APIs, frameworks). Skip for chitchat or pure local-code (review, refactor, grep). For everything else:
1. SEARCH FIRST: mcp__wellread__search(hook_version:9, queries:[3 variants], keywords:"terms", client_stats:'${STATS}') - no parallel, await.
2. Freshness: fresh->answer | check->web verify + save(verify_id) | stale->re-research + save.
3. Save public research findings: mcp__wellread__save(..., client_stats:'${STATS}'). Sources MUST be https:// URLs.
4. Hit? Append badge.
HOOKEOF
