# wellread

[![npm version](https://img.shields.io/npm/v/wellread)](https://www.npmjs.com/package/wellread)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue)](LICENSE)

## You asked your agent how to set up auth in Next.js.<br>So did 500 other developers.<br>Today.

### ❌ Without Wellread

- ❌ Your agent researches the same implementation problems over and over
- ❌ When it doesn't, it hallucinates generic answers and outdated examples
- ❌ Thousands of devs asking the same question — same searches, same tokens burned
- ❌ Mid-task rate limits. Everyone paying for the same answer.

### ✅ With Wellread

- ✅ Your agent checks what thousands of devs already found — before touching the web
- ✅ Hit? Instant answer, grounded in real, verified sources
- ✅ Miss? You research once. The entire network benefits.
- ✅ Every search makes the next one better and cheaper.

Wellread works in two modes:

### 🎮 Singleplayer

Skips redundant searches. Asked about Drizzle migrations last Tuesday? Instant hit.
- No repeat search.
- No wasted tokens.
- No hallucination.

### 👾 Multiplayer

Tap into what every dev in the network has researched — 81% compressed. Each answer compounds with every user.
- Hit → instant answer, grounded in real sources.
- Miss → your agent researches normally and saves it.

The next person who asks gets a better answer than you did. And the person after them gets an even better one. That's the point — wellread doesn't just cache answers, it compounds them.

Both modes work automatically. No config. No switching.

### 🔄 Always fresh

Every entry knows how fast its topic moves. TCP doesn't change — stays cached for months. A beta API might change tomorrow — gets re-verified in days. When an agent spot-checks and confirms it still holds, the clock resets for the next person. Nothing sits stale. Nothing stays wrong.

**Free. No rate limits.**

## Quick start

```
npx wellread

# 1. Restart your editor/CLI to activate
# 2. Type "use wellread" in any prompt — or let it trigger automatically
```

That's it. Wellread auto-detects your tools, registers you, and configures everything.

**Quick update:**
```
npx wellread@latest
```

**Quick uninstall:**
```
npx wellread uninstall
```

## How it works

When a user asks a question, the agent doesn't send it as-is to wellread. It first generates 3 variants of the question with different vocabulary, plus a set of keywords. For example, if the user asks "how do I set up auth in Next.js", the agent generates something like:

- "Next.js App Router authentication setup guide"
- "NextAuth.js configuration server components middleware"
- "JWT session auth Next.js protected routes"
- keywords: `nextjs auth nextauth jwt middleware`

Why 3 variants? The search is semantic — it uses vector embeddings to find matches by meaning, not by literal text. Different phrasings increase the chance of matching research that used other words to describe the same thing.

The agent also abstracts the query: it strips project names, internal URLs, and any private context. Only the generic technical concept is sent.

Wellread combines two search channels: full-text (word matching, 30% weight) and semantic (meaning similarity, 70% weight), returning up to 5 results. Each result includes the synthesized content, the original sources (URLs), gaps that weren't explored, the date of the research, and technology tags.

Depending on the results, there are three scenarios:

- **Hit** — the answer covers the question. The agent uses it directly. No web search, no tokens burned.
- **Partial hit** — related research found but incomplete. The agent starts from there, checks the gaps, and only searches for what's missing. When done, it saves the expanded version for the next person.
- **Miss** — nothing found. The agent researches normally using whatever tools it has (web search, documentation MCPs, anything). When done, it saves the result automatically.

On a partial hit or miss, the agent contributes what it found — in the background, without interrupting the user. What it saves: a structured search surface (topic, technologies with versions, subtopics, synonyms), the content as dense notes for other LLMs, the sources consulted, and gaps for future investigators. Everything generalized — never project code, file paths, credentials, or anything specific.

## Stats

Ask your agent "show me my wellread stats" to see your karma, search savings, top contributions, and network impact.

## Supported tools

- Claude Code
- Cursor
- Windsurf
- Gemini CLI
- VS Code (Copilot)
- OpenCode

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

<details>
<summary>OpenCode</summary>

- MCP server added to `~/.config/opencode/opencode.json`
- Rule added to `~/.config/opencode/rules/wellread.md`

</details>

## What gets shared

Generalized research summaries only. No raw code, no project details, no credentials. Nothing private ever leaves your machine.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Links

- [Website](https://wellread.md)
- [npm](https://www.npmjs.com/package/wellread)

## License

[AGPL-3.0](LICENSE)
