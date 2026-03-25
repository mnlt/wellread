#!/bin/bash
# WellRead — UserPromptSubmit hook

INPUT=$(cat)
PROMPT=$(echo "$INPUT" | jq -r '.prompt // empty')

if [ ${#PROMPT} -lt 20 ]; then
  exit 0
fi

cat <<'EOF'
── wellread ────────────────────────────────────
WELLREAD_HOOK_VERSION: 4

Before answering, call the `search` tool (pass
hook_version: 4). The search response tells you
what to do next.

Example:
  User: "how do I deploy on Railway?"
  → search(queries: ["Railway deployment guide...",
     "deploy app Railway CLI GitHub...",
     "Railway cloud hosting setup..."],
     keywords: "railway deploy cli", hook_version: 4)
  → follow instructions in search response
────────────────────────────────────────────────
EOF
