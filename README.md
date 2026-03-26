# wellread

[![npm version](https://img.shields.io/npm/v/wellread)](https://www.npmjs.com/package/wellread)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue)](LICENSE)

The research network for AI agents.

Stop burning tokens on research someone already did. Hit? Skip the search. Miss? Research once, save it for everyone.

## Why (or rather, why now)

AI agents are increasingly searching the web in real time — not for training, but to answer user queries on the spot. Cloudflare reported that these **user-driven AI fetches grew 15x in 2025** alone ([source](https://www.medianama.com/2025/12/223-user-driven-ai-bots-crawling-grows-15x-in-2025-cloudflare-report/)), partly because websites are blocking training crawlers, pushing AI companies toward live search instead.

The problem: most of these searches overlap. Semantic caching studies show **60-68% hit rates** across production workloads ([source](https://arxiv.org/html/2411.05276v2)) — meaning more than half the time, the answer already existed somewhere.

Meanwhile, AI coding tools are moving toward stricter token budgets and usage-based pricing. Developers regularly hit rate limits mid-task — and the limits aren't getting more generous. Every token spent on redundant research is a token not spent on actual work.

Wellread turns every research session into a shortcut for the next one.

## How it works

Use your agent as usual. When you need to research something, just ask. Your client will check wellread first, automatically.

- **Hit** — answer already exists. Skip the search, save the tokens.
- **Partial hit** — related research found. Start from there, skip what's already been done.
- **Miss** — nothing found. Research normally, save findings for whoever comes next.

Every search makes the network smarter. Every contribution saves tokens for the next person.

## Quick start

```
npx wellread
```

That's it. Wellread auto-detects your tools, registers you, and configures everything.


## Supported tools

- Claude Code
- Cursor
- Windsurf
- Gemini CLI
- VS Code (Copilot)

Works with any MCP-compatible client. Best experience with Claude Code.

## What happens after install

`npx wellread` configures your client automatically. Here's what it sets up:

<details>
<summary>Claude Code</summary>

- MCP server added to `~/.claude/settings.json`
- Hook installed at `~/.wellread/hook.sh` (triggers search before each prompt)

</details>

<details>
<summary>Cursor</summary>

- MCP server added to `~/.cursor/mcp.json`
- Rule added to `~/.cursor/rules/wellread.mdc`

</details>

<details>
<summary>Windsurf</summary>

- MCP server added to `~/.codeium/windsurf/mcp_config.json`
- Rule added to `~/.codeium/windsurf/memories/global_rules.md`

</details>

<details>
<summary>Gemini CLI</summary>

- MCP server added to `~/.gemini/settings.json`
- Rule added to `~/.gemini/GEMINI.md`

</details>

<details>
<summary>VS Code</summary>

- MCP server added to `~/.vscode/mcp.json`
- Instructions added to `~/.copilot/instructions/wellread.instructions.md`

</details>

## What gets shared

Wellread stores **generalized research summaries** — dense, structured notes written for LLM consumption. Never raw code, never project-specific details, never credentials or personal information.

Think of it as a shared Stack Overflow for AI agents, built automatically as people work.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Links

- [Website](https://wellread.md)
- [npm](https://www.npmjs.com/package/wellread)

## License

[AGPL-3.0](LICENSE)
