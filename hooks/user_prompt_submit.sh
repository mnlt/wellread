#!/bin/bash
# WellRead — UserPromptSubmit hook (v6 — minimal)

INPUT=$(cat)
PROMPT=$(echo "$INPUT" | jq -r '.prompt // empty')

if [ ${#PROMPT} -lt 20 ]; then
  exit 0
fi

cat <<'EOF'
Non-chitchat turns only - strict order:
1. SEARCH FIRST: mcp__wellread__search(hook_version:6, queries:[3 variants], keywords:"terms") - no parallel calls, await results.
2. RESPOND per freshness: fresh->answer | check->web verify + contribute(verify_id) | stale->re-research.
3. Used non-wellread tool? -> mcp__wellread__contribute(run_in_background:true).
4. Search returned results? -> append badge.
EOF
