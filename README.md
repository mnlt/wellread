# wellread - Another dev already searched that.

[![npm version](https://img.shields.io/npm/v/wellread)](https://www.npmjs.com/package/wellread)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue)](LICENSE)
[![wellread MCP server](https://glama.ai/mcp/servers/mnlt/wellread/badges/score.svg)](https://glama.ai/mcp/servers/mnlt/wellread)

Your agent's next research task was probably already solved. Wellread finds it before your agent burns tokens rediscovering it - and when it can't, it makes sure the next dev doesn't pay that cost either.

> Semantic caching studies show **60–68% of agent research queries overlap** with prior ones ([source](https://arxiv.org/html/2411.05276v2)). And AI-driven live web searches **grew 15x in 2025** ([Cloudflare](https://www.medianama.com/2025/12/223-user-driven-ai-bots-crawling-grows-15x-in-2025-cloudflare-report/)). Wellread is the cache that layer has been missing.

## The compounding effect

|                            | Without wellread         | With wellread |
| -------------------------- | ------------------------ | ------------- |
| Turn 1 (fresh session)     | 200K tokens · 10 turns · 67s | 647 tokens · 1 turn · 28s |
| Turn 30 (~40K context)     | 1.2M tokens              | 647 tokens    |
| Turn 100 (~150K context)   | 3.5M tokens              | 647 tokens    |
| Turn 250 (~480K context)   | 11M tokens               | 647 tokens    |

The deeper your session, the more expensive research gets - and the more wellread saves.

## The problem

- Your agent researches every technical question from scratch. When it doesn't, it hallucinates - outdated APIs, wrong examples, broken code.
- Every turn re-sends the whole conversation. By turn 100, you've paid for the same context a hundred times.

## The fix

Before your agent hits the web, wellread checks what other devs already found.

- **Hit** → instant answer from verified sources. Zero web searches. One turn.
- **Partial** → starts from what exists, only researches the gaps.
- **Miss** → normal research, then saves the summary for whoever comes next.

Your agent doesn't just spend fewer tokens. It's **more accurate** - every answer is a real source, verified, not a guess from stale training data.

## Install

```bash
npx wellread
```

Restart your editor. That's it.

*Update:* `npx wellread@latest` - *Uninstall:* `npx wellread uninstall`

## Singleplayer from day one

You don't need a crowd for wellread to pay off.

**Singleplayer** - your own research comes back to you. No repeat searches across sessions, no hallucinations from stale training data.

**Multiplayer** - when another dev has already cracked that Auth.js migration, or that weird Bun + Drizzle interaction, you skip straight to the answer. One person researches, everyone benefits.

Early users build the network. Their contributions get credited - and permanent.

## Freshness

Each entry knows how fast its topic changes:

| Type                          | Fresh     | Re-check  | Re-research |
| ----------------------------- | --------- | --------- | ----------- |
| Timeless (TCP, SQL basics)    | 1 year    | -         | after       |
| Stable (React, PostgreSQL)    | 6 months  | 1 year    | after       |
| Evolving (Next.js, Bun)       | 30 days   | 90 days   | after       |
| Volatile (betas, pre-release) | 7 days    | 30 days   | after       |

When an agent re-verifies, the clock resets for everyone.

## Privacy

Six layers between your private context and the shared network:

1. **Hook instruction** - before anything leaves your machine, the hook tells your agent to sanitize the query: strip project names, API keys, file paths, credentials. Only the generic technical concept is sent.
2. **Search schema** - the search tool's parameter description reinforces: "Remove project names, API keys, file paths, credentials."
3. **Save schema** - the save tool explicitly says: "NEVER include project/repo/company names, internal URLs, file paths, credentials, business logic. Content is PUBLIC."
4. **URL gate (server, hard reject)** - every source must start with `https://` or `http://`. File paths, library identifiers, internal URLs → rejected. The contribution is not saved.
5. **Path detection (server, hard reject)** - the server scans content and search surface for local paths (`/Users/...`, `/home/...`, `file://`, `C:\...`). If found → rejected.
6. **By design** - your agent doesn't forward your input. It synthesizes from public sources. What gets saved is a distilled summary of public docs, not your code or conversation.

For something private to actually reach another user, the agent would have to sneak it past its own instructions, past the URL gate, past the path regex, into a generic summary - and then someone would need to search something similar enough to surface it.

## Stats

Ask your agent:

> "show me my wellread stats"

See your token savings, your top contributions, and how many devs used research you saved.

## Supported tools

Works with any MCP client. Best experience with Claude Code. Also supports Cursor, Windsurf, Gemini CLI, VS Code, OpenCode.

## Links

- [Website](https://wellread.md)
- [npm](https://www.npmjs.com/package/wellread)

## License

[AGPL-3.0](LICENSE)
