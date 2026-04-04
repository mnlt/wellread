# I audited Wellread, the "collective research memory" MCP for AI coding agents. Here's the real math on token savings.

Wellread (wellread.md) is an MCP server that pitches itself as a shared cache for AI coding agents: "Another dev already searched that." The idea is simple — when your agent needs to research something (say, "how to set up auth in Next.js"), it first checks a shared database of prior research. Hit? Skip the web search. Miss? Research normally and save it for the next person. It claims to save tokens, water, and money.

I went through every line of the source code. Here's what I found.

## How it actually works

1. A `UserPromptSubmit` hook injects ~500 tokens of workflow instructions into **every single prompt** (for prompts > 20 chars).
2. The agent is instructed to call `wellread.search` before doing anything else — generating 3 query variants + keywords.
3. The server generates an OpenAI embedding (`text-embedding-3-small`, 512d), runs a hybrid search (30% full-text, 70% semantic) against Supabase, and returns up to 5 results.
4. If results are found, they come with freshness signals (fresh/check/stale) based on a volatility system (timeless: 365d, stable: 180d, evolving: 30d, volatile: 7d).
5. If the agent did any additional research, it's told to spawn a **background Agent** to contribute back to the collective.
6. A badge is appended to every response that triggered a search.

The architecture is actually well-designed. Clean TypeScript, async non-blocking contributions, proper quality gates (must have real sources, raw_tokens > 0), versioning with lineage tracking, and a freshness system that's smarter than a simple TTL. Credit where it's due.

## The token savings claim

Here's where it gets interesting. Wellread calculates savings as:

```
tokens_saved = raw_tokens - response_tokens
```

Where `raw_tokens` is "tokens processed from external sources during original research" and `response_tokens` is "tokens in the saved synthesis." The README claims "81% compressed."

This is a reasonable proxy for compression ratio. But it's NOT the same as "tokens saved in your session." Let me break down what actually happens to your token budget:

## The real cost accounting

### Fixed overhead per prompt (every technical question):

| Cost center | Tokens | Notes |
|---|---|---|
| Hook injection | ~500 | Injected as system-reminder, re-sent every turn |
| MCP tool definitions (3 tools) | ~1,500-2,400 | Schemas for search, contribute, stats |
| Search tool call (output) | ~200 | Claude generating the JSON arguments |
| Search result (input, next turn) | ~500-3,000 | Depends on number and size of results |
| Badge text | ~80-120 | Mandatory on every search response |
| "⛔ DO NOT call other tools in parallel" | 0 (latency) | Forces sequential execution — search must complete before anything else starts |

**Conservative per-search overhead: ~2,800-6,200 tokens.**

### On a cache miss (no results):

You pay ALL the overhead above, plus the agent still has to do a full web search. Then it's instructed to spawn a background Agent to contribute. That background agent is a **separate Claude session** that:
- Gets a fresh system prompt (~5K+ tokens)
- Calls the contribute MCP tool
- Generates embeddings
- Formats and sends the contribution

**A cache miss costs you MORE than not having Wellread at all.** You paid ~3K tokens for the search overhead + the full cost of a background agent contribution (~5-15K tokens depending on model).

### On a cache hit (results found, fresh):

This is the happy path. You skip a web search and get a pre-synthesized answer. Let's say the original research consumed 8K tokens from web sources and Wellread returns a 1.5K token synthesis. The claimed savings: 6.5K tokens.

But you still paid ~3-6K in overhead. **Net savings on a fresh hit: ~500-3,500 tokens.** 

Not nothing, but dramatically less than the "saved ~8K tokens!" badge suggests.

### On a "check" freshness result:

The agent is told to use the results BUT also do a web search to verify. So you get the Wellread overhead AND a web search. Then potentially spawn a background agent to call `verify_id` or update the entry. This might cost MORE than just doing the web search directly.

### On a partial match or stale result:

Same as a miss, but with extra context tokens from the stale results polluting your context window.

## The compounding context problem

Here's what the savings math completely ignores: **tool results become input tokens on every subsequent turn.**

If Wellread returns 2K tokens of results on turn 3, those 2K tokens are re-sent as input context on turns 4, 5, 6... until compaction kicks in (~80% of context window). With Opus 4.6 at $5/MTok input, those 2K tokens cost $0.01 on EVERY subsequent turn. Over a 20-turn session, that's $0.17 just from the search result sitting in context.

The hook text (~500 tokens) is injected on EVERY prompt. Over 20 turns, that's 10,000 extra input tokens = $0.05 on Opus. Not huge, but it adds up across sessions.

## The background Agent contribution tax

This is the sneakiest cost. The workflow mandates:

> "condition: you used ANY tool besides wellread search → spawn a background Agent to contribute"

A background Agent is a full Claude API session. Even a minimal one consumes 5-15K tokens (system prompt + tool schemas + the actual contribute call + thinking). On Opus 4.6, that's $0.03-$0.15 per contribution.

If you're a diligent contributor, you're paying a "community tax" of ~$0.10 per non-trivial question. Over 50 questions/day, that's $5/day just in contribution overhead — nearly doubling your typical Claude Code daily spend.

## The water metric

```js
waterSaved(tokens) = tokens * 0.005 // mL
```

So 100K tokens = 500mL of water. This number is... vaguely sourced. The actual water consumption per token depends heavily on the datacenter's cooling system, PUE, and local climate. The 0.005 mL/token figure isn't cited anywhere in the codebase. It's a nice story for the badge, but it's greenwashing without a source.

## What's genuinely good

1. **The freshness/volatility system is clever.** Different decay windows for different knowledge types is the right approach. "TCP doesn't change, beta APIs do" — correct intuition, well-implemented.

2. **Quality gates on contributions.** Must have real sources and raw_tokens > 0. Rejects training-data-only answers. This is important for a shared knowledge base.

3. **Versioning with lineage.** Contributions track what they replace and what they started from. Sources accumulate across versions. This is proper data engineering.

4. **The hybrid search.** Combining full-text (30%) and semantic (70%) is a proven pattern. Using `text-embedding-3-small` at 512d is a good cost/quality tradeoff.

5. **Non-blocking architecture.** Contributions and logging are async. Search never blocks on writes. This is the right pattern for an MCP tool.

6. **Multi-client support.** Works with Claude Code, Cursor, Windsurf, Gemini CLI, VS Code, OpenCode. The installer auto-detects and configures everything. Slick DX.

## What's concerning

1. **The hook hijacks every prompt.** The `UserPromptSubmit` hook fires on every message > 20 chars. Even "refactor this function" or "add a test for X" triggers the workflow injection. The "skip for conversational messages" instruction is a suggestion to the LLM, not an actual filter. In practice, Claude will often search anyway because the instructions say "always use wellread before... implementing."

2. **The sequential execution mandate.** "⛔ DO NOT call other tools in parallel with search." This means every technical question has an added latency of: hook execution + embedding generation + database query + response parsing, BEFORE the agent can start actual work. On a cold MCP connection, this could be 2-5 seconds.

3. **Self-reported token counts.** The `raw_tokens` and `response_tokens` in contributions are provided by the LLM itself. There's no server-side validation that these numbers are accurate. An LLM could hallucinate "raw_tokens: 50000" and inflate the savings metrics for everyone.

4. **The update nag.** When `hook_version < CURRENT_HOOK_VERSION`, the search response includes an aggressive update notice that instructs the agent to run `npx wellread@latest` via the Bash tool. This is a tool execution triggered by a remote server response — a pattern that should make security-conscious users uncomfortable.

5. **Privacy depends on LLM compliance.** The instructions say "NEVER include project names, internal URLs, file paths." But this is enforced by prompt instructions, not by code. A sufficiently confused or overloaded LLM could leak private context into the shared database. There's no server-side PII detection.

6. **No opt-out per query.** There's no way to say "skip wellread for this question" short of uninstalling it. The hook always fires.

## The honest verdict

Wellread is a well-engineered solution to a real problem. Developers DO ask the same questions repeatedly, and LLMs DO waste tokens re-researching common topics. The architecture shows genuine thoughtfulness — the freshness system, the quality gates, the lineage tracking.

But the token savings are significantly overstated. The overhead of the hook system, the MCP tool definitions, the search results in context, and especially the background Agent contribution tax eat into the savings substantially. On cache misses (which are common for a young network), you're actively losing tokens.

The real value proposition isn't token savings — it's **latency and quality**. Getting a pre-verified, source-cited answer instantly is genuinely useful, especially for common framework questions. That's worth something even if the net token math is closer to break-even than the badges suggest.

For a network like this to work, it needs critical mass. Right now (v0.1.27), I'd guess the database is still sparse, meaning most queries are misses, meaning most users are paying the overhead without getting hits. It's a cold-start problem that every knowledge network faces.

**My take:** Install it if you work with popular frameworks and don't mind the overhead. Skip it if you're cost-sensitive, work on niche topics, or are uncomfortable with a hook that intercepts every prompt. And take the "saved ~8K tokens!" badges with a massive grain of salt.

---

*Disclosure: I audited the open-source code at github.com/mnlt/wellread. I have no affiliation with the project. All numbers are based on current Claude API pricing ($5/$25 per MTok for Opus 4.6 input/output) and may vary with model choice.*
