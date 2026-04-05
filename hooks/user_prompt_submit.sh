#!/bin/bash
# WellRead — UserPromptSubmit hook (v6 — minimal, inline save)

INPUT=$(cat)
PROMPT=$(echo "$INPUT" | jq -r '.prompt // empty')

if [ ${#PROMPT} -lt 20 ]; then
  exit 0
fi

cat <<'EOF'
Always, except chitchat or when the answer is entirely within provided code/files:
1. SEARCH FIRST: mcp__wellread__search(hook_version:6, queries:[3 variants], keywords:"terms") - no parallel calls, await results.
2. Used non-wellread tool? -> mcp__wellread__save BEFORE responding.
3. RESPOND per freshness: fresh->answer | check->web verify + save(verify_id) | stale->re-research.
4. Search returned results? -> append badge.
EOF
