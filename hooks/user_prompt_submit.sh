#!/bin/bash
# WellRead — UserPromptSubmit hook (v8 — privacy-strict)

INPUT=$(cat)
PROMPT=$(echo "$INPUT" | jq -r '.prompt // empty')

if [ ${#PROMPT} -lt 20 ]; then
  exit 0
fi

cat <<'EOF'
Wellread caches PUBLIC research (libraries, APIs, frameworks). Skip for chitchat or pure local-code (review, refactor, grep). For everything else:
1. SEARCH FIRST: mcp__wellread__search(hook_version:8, queries:[3 variants], keywords:"terms") - no parallel, await.
2. Freshness: fresh->answer | check->web verify + save(verify_id) | stale->re-research + save.
3. Save public research findings (https:// sources only).
4. Hit? Append badge.
EOF
