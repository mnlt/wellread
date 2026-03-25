import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { generateEmbedding } from "../embeddings.js";
import { insertResearch, getNetworkStats, incrementUserContributions } from "../db.js";
import { waterSaved, formatTokens, compressionPercent, randomPick } from "../utils.js";

export function registerContributeTool(server: McpServer, userId: string) {
  server.tool(
    "contribute",
    `WHEN TO CALL: Immediately after ANY live data fetch (web search, URL fetch, doc query, subagent research), BEFORE responding to the user. This is mandatory, not optional.

Save research findings to the collective memory. Do NOT save responses based purely on training data.

IMPORTANT: The content is consumed by OTHER LLMs worldwide, not humans. ALWAYS write in English regardless of the user's language. Write for an LLM audience:
- NO prose, NO tutorials, NO explanations of concepts
- YES: facts, API signatures, gotchas, version-specific changes, decisions with reasoning
- Format as dense, structured notes — not documentation

PRIVACY — Your content is PUBLIC and visible to ALL users worldwide.
NEVER include:
- Project names, repo names, company names, team names
- Internal URLs, endpoints, API keys, credentials
- Business logic specific to one project
- File paths from the user's machine (e.g. /Users/..., C:\\Users\\...)
- User names, email addresses, or any personal identifiers
ALWAYS generalize: "a Next.js 15 app" not "the Acme dashboard".
If the research is inseparable from private context, DO NOT contribute.

You (the LLM) must generate:
- search_surface: A structured block optimized for future retrieval. Format:
  [TOPIC]: What this research covers
  [COVERS]: Specific subtopics addressed
  [TECHNOLOGIES]: Exact product/library/framework names
  [RELATED]: Synonyms, alternatives, related terms someone might search for
  [SOLVES]: The problem this research addresses
- content: Dense, fact-based notes for LLM consumption. Include:
  * Key API signatures (function names, parameters, return types)
  * Version-specific breaking changes or gotchas
  * Decision rationale (why X over Y, tradeoffs)
  * Common pitfalls and edge cases
  * Minimal code only for non-obvious API usage
  Do NOT include: explanations of concepts, step-by-step tutorials,
  full code implementations, or anything an LLM already knows.
- sources: URLs that were actually fetched
- tags: lowercase technology/concept tags
- gaps: areas NOT covered by this research that future investigators should explore.
  Think: what angles did you skip? What would need deeper research? What adjacent
  topics connect to this? These are internal breadcrumbs for the next agent — the
  user never sees them.
- raw_tokens: approximate number of tokens you processed from external sources during research
- response_tokens: approximate number of tokens in the content you are saving
- replaces_id: (optional) if your research UPDATES a previous entry you found via search,
  pass its ID here. The old entry becomes archived and yours becomes the current version.
  Only use this when your research covers the SAME topic with newer/better info.
  Do NOT use this if your research is a different (more specific or broader) topic.`,
    {
      search_surface: z.string().describe("Structured search surface for retrieval (see format above)"),
      content: z.string().describe("Synthesized research content, generalized and clean"),
      sources: z.array(z.string()).describe("URLs that were actually fetched during research"),
      tags: z.array(z.string()).describe("Lowercase tags: technologies, concepts"),
      gaps: z.array(z.string()).describe("Unexplored angles and rabbit holes for future investigators"),
      raw_tokens: z.number().describe("Approx tokens processed from external sources during research"),
      response_tokens: z.number().describe("Approx tokens in the saved content"),
      replaces_id: z.string().optional().describe("ID of the research entry this updates/replaces. Only if same topic with newer info."),
    },
    async ({ search_surface, content, sources, tags, gaps, raw_tokens, response_tokens, replaces_id }) => {
      try {
        // Quality gate: reject contributions without real research
        if (raw_tokens === 0 || sources.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: "Rejected: contributions require real research. You must have fetched external sources (raw_tokens > 0, sources non-empty). Training data or user-provided info without verification cannot be contributed.",
              },
            ],
          };
        }

        const embedding = await generateEmbedding(search_surface);

        const result = await insertResearch({
          user_id: userId,
          content,
          gaps,
          sources,
          search_surface,
          tags,
          raw_tokens,
          response_tokens,
          embedding,
          replaces_id,
        });

        // Increment user contribution count + token stats (async, non-blocking)
        incrementUserContributions(userId, raw_tokens, response_tokens);

        const stats = await getNetworkStats();
        const tokensSaved = Math.max(0, raw_tokens - response_tokens);
        const compression = compressionPercent(raw_tokens, response_tokens);
        const tokensStr = formatTokens(tokensSaved);
        const waterStr = waterSaved(tokensSaved);
        const gapsCount = gaps.length;
        const sourcesCount = sources.length;

        const newTitles = [
          "🗺️ Uncharted territory!",
          "🏴‍☠️ Just planted the flag!",
          "🌔 First footprint!",
        ];

        let title: string;
        let details: string;

        if (replaces_id) {
          title = `**🪂 Went deeper and faster thanks to prior research!**`;
          details = `- Went ${tokensStr} further and saved it for whoever comes next`;
        } else {
          title = `**${randomPick(newTitles)}**`;
          details = `- ${tokensStr} saved for whoever comes next`;
        }

        const msg = `── #wellread ──\n${title}\n${details}\n*(btw, Wellread network saved ${waterSaved(stats.total_tokens_saved)} of water so far)*`;

        return {
          content: [
            {
              type: "text" as const,
              text: msg,
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Save error: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
