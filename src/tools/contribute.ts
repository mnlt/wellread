import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { generateEmbedding } from "../embeddings.js";
import { insertResearch, incrementUserContributions } from "../db.js";

async function processContributionAsync(
  userId: string,
  data: {
    search_surface: string;
    content: string;
    sources: string[];
    tags: string[];
    gaps: string[];
    raw_tokens: number;
    response_tokens: number;
    replaces_id?: string;
  }
): Promise<void> {
  try {
    const embedding = await generateEmbedding(data.search_surface);
    await insertResearch({
      user_id: userId,
      content: data.content,
      gaps: data.gaps,
      sources: data.sources,
      search_surface: data.search_surface,
      tags: data.tags,
      raw_tokens: data.raw_tokens,
      response_tokens: data.response_tokens,
      embedding,
      replaces_id: data.replaces_id,
    });
    incrementUserContributions(userId, data.raw_tokens, data.response_tokens);
  } catch (err) {
    console.error("Async contribution processing error:", err);
  }
}

export function registerContributeTool(server: McpServer, userId: string) {
  server.tool(
    "contribute",
    `Save research to collective memory. Call after live research (web search, URL fetch), in a background Agent.

Content is PUBLIC, consumed by LLMs worldwide. ALWAYS English. Dense structured notes — no tutorials.
NEVER include: project/repo/company names, internal URLs, file paths, credentials, business logic.

search_surface MUST use this format:
[TOPIC]: Semantic caching for LLM API calls
[COVERS]: hit rates, cost reduction, cache invalidation
[TECHNOLOGIES]: Redis, GPTCache, OpenAI API
[RELATED]: embedding similarity, deduplication, query clustering
[SOLVES]: Reducing redundant LLM API calls and costs`,
    {
      search_surface: z.string().describe("Structured retrieval block for future search matching. Example:\n[TOPIC]: Semantic caching for LLM API calls\n[COVERS]: hit rates, cost reduction, cache invalidation\n[TECHNOLOGIES]: Redis, GPTCache, OpenAI API\n[RELATED]: embedding similarity, deduplication, query clustering\n[SOLVES]: Reducing redundant LLM API calls and costs"),
      content: z.string().describe("Dense notes for LLM consumption: API signatures, gotchas, version-specific changes, decision rationale, pitfalls. No prose, no tutorials."),
      sources: z.array(z.string()).describe("URLs actually fetched during research"),
      tags: z.array(z.string()).describe("Lowercase tags: technologies, concepts"),
      gaps: z.union([z.array(z.string()), z.string()]).describe("Unexplored angles for future investigators"),
      raw_tokens: z.union([z.number(), z.string()]).describe("Approx tokens processed from external sources"),
      response_tokens: z.union([z.number(), z.string()]).describe("Approx tokens in the saved content"),
      replaces_id: z.string().optional().describe("ID of entry this updates/replaces. Only if same topic with newer info."),
    },
    async ({ search_surface, content, sources, tags, gaps: rawGaps, raw_tokens: rawRawTokens, response_tokens: rawResponseTokens, replaces_id }) => {
      // Parameter coercion
      const gaps: string[] = typeof rawGaps === "string" ? [rawGaps] : rawGaps;
      const raw_tokens = Number(rawRawTokens);
      const response_tokens = Number(rawResponseTokens);
      try {
        // Quality gate: reject contributions without real research
        if (raw_tokens === 0 || sources.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: "Rejected: contributions require real research (raw_tokens > 0, sources non-empty).",
              },
            ],
          };
        }

        // Fire off heavy work async — non-blocking
        processContributionAsync(userId, {
          search_surface, content, sources, tags, gaps,
          raw_tokens, response_tokens, replaces_id,
        });

        return {
          content: [
            {
              type: "text" as const,
              text: "Research saved to collective memory. Thank you.",
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
