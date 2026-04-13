# wellread — Another dev already searched that.

[![npm version](https://img.shields.io/npm/v/wellread)](https://www.npmjs.com/package/wellread)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue)](LICENSE)

## The problem

- ❌ Your agent researches every technical question from scratch — 10-20 turns per query
- ❌ When it doesn't search, it hallucinates — outdated APIs, wrong examples, broken code
- ❌ Each turn re-sends your entire conversation history, and the cost compounds
- ❌ Thousands of devs burning tokens on the same questions, every day

## The fix

Before your agent searches the web, wellread checks what other devs already found.

- **Hit** → instant answer from verified sources. Zero web searches. One turn.
- **Partial** → starts from what exists, only researches the gaps.
- **Miss** → normal research, then saves it for the next person.

| | Without wellread | With wellread |
|---|---|---|
| Turn 1 (fresh session) | 200K tokens · 10 turns · 67s | 647 tokens · 1 turn · 28s |
| Turn 30 (~40K context) | 1.2M tokens | 647 tokens |
| Turn 100 (~150K context) | 3.5M tokens | 647 tokens |

Wellread always costs the same. Everything else gets more expensive.

## Install

```
npx wellread
```

Restart your editor. That's it.

Update: `npx wellread@latest` · Uninstall: `npx wellread uninstall`

### Singleplayer

Your own research comes back to you. No repeat searches, no hallucinations
from stale training data — real sources, verified.

### Multiplayer

27 devs already used that Auth.js research before you got here.
One person researched, everyone benefits.

## Freshness

Each entry knows how fast its topic changes:

| Type | Fresh | Re-check | Re-research |
|------|-------|----------|-------------|
| Stable (React, PostgreSQL) | 6 months | 1 year | after |
| Evolving (Next.js, Bun) | 30 days | 90 days | after |
| Volatile (betas, pre-release) | 7 days | 30 days | after |

When an agent re-verifies, the clock resets for everyone.

## Privacy

Only generalized research summaries are shared. No code, no file paths,
no credentials, no project names. Your agent strips everything private
before saving.

## Supported tools

Works with any MCP client. Best experience with Claude Code. Also supports
Cursor, Windsurf, Gemini CLI, VS Code, OpenCode.

## Stats

Ask your agent "show me my wellread stats" to see your search savings,
top contributions, and network impact.

## Links

- [Website](https://wellread.md)
- [npm](https://www.npmjs.com/package/wellread)

## License

[AGPL-3.0](LICENSE)
