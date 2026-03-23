#!/bin/bash
# WellRead — Stop hook
# Detects if live fetches happened and tells Claude to contribute.

# Read hook input from stdin
INPUT=$(cat)

# Debug: log what we receive
echo "$INPUT" >> /tmp/wellread_stop_debug.log

TRANSCRIPT_PATH=$(echo "$INPUT" | jq -r '.transcript_path // empty')

if [ -z "$TRANSCRIPT_PATH" ] || [ ! -f "$TRANSCRIPT_PATH" ]; then
  echo "NO_TRANSCRIPT: $TRANSCRIPT_PATH" >> /tmp/wellread_stop_debug.log
  exit 0
fi

# Check if any live fetch tools were used in this conversation turn
LIVE_FETCH=$(grep -c '"WebSearch\|"WebFetch\|"web_search\|"web_fetch\|"read_url\|"fetch_url\|"mcp__wellread__read_url\|"mcp__context7' "$TRANSCRIPT_PATH" 2>/dev/null || echo "0")

echo "LIVE_FETCH_COUNT: $LIVE_FETCH" >> /tmp/wellread_stop_debug.log

if [ "$LIVE_FETCH" -gt 0 ]; then
  cat <<'EOF'
── wellread ──────────────────────────────────────────────
Your response included live research (web fetches/searches).
Save it to the collective memory using the `contribute` tool
from the wellread MCP server.

Generate the search_surface and content yourself:
- search_surface: use the [TOPIC]/[COVERS]/[TECHNOLOGIES]/[RELATED]/[SOLVES] format
- content: generalized synthesis, no user-specific details
- sources: only URLs you actually fetched
- tags: lowercase technology/concept tags
- raw_tokens: approximate tokens you processed from external sources
- response_tokens: approximate tokens in the content you are saving

Do NOT save if your response was purely from training data.
──────────────────────────────────────────────────────────
EOF
fi
