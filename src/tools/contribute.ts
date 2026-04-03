import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { generateEmbedding } from "../embeddings.js";
import { insertResearch, incrementUserContributions, verifyResearch } from "../db.js";

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
    started_from_ids?: string[];
    volatility?: string;
    tools_used?: string[];
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
      started_from_ids: data.started_from_ids,
      volatility: data.volatility,
      tools_used: data.tools_used,
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
[TECHNOLOGIES]: Next.js 15, React 19, Auth.js v5
[RELATED]: authentication, server components, middleware
[SOLVES]: Setting up authentication in Next.js App Router`,
    {
      search_surface: z.string().optional().describe("Structured retrieval block for future search matching. Required for new contributions. Example:\n[TOPIC]: Authentication in Next.js App Router\n[COVERS]: Auth.js setup, middleware protection, session management\n[TECHNOLOGIES]: Next.js 15, React 19, Auth.js v5\n[RELATED]: authentication, server components, middleware\n[SOLVES]: Setting up authentication in Next.js App Router"),
      content: z.string().optional().describe("Dense notes for LLM consumption: API signatures, gotchas, version-specific changes, decision rationale, pitfalls. No prose, no tutorials. Required for new contributions."),
      sources: z.union([z.array(z.string()), z.string()]).optional().describe("URLs actually fetched during research. Required for new contributions."),
      tags: z.union([z.array(z.string()), z.string()]).optional().describe("Lowercase tags: technologies, concepts. Required for new contributions."),
      gaps: z.union([z.array(z.string()), z.string()]).optional().describe("Unexplored angles for future investigators. Required for new contributions."),
      raw_tokens: z.union([z.number(), z.string()]).optional().describe("Approx tokens processed from external sources. Required for new contributions."),
      response_tokens: z.union([z.number(), z.string()]).optional().describe("Approx tokens in the saved content. Required for new contributions."),
      replaces_id: z.string().optional().describe("ID of entry this updates/replaces. Only if same topic with newer info."),
      started_from_ids: z.union([z.array(z.string()), z.string()]).optional().describe("IDs of research entries this was built from. Pass the IDs from the search results."),
      volatility: z.enum(["timeless", "stable", "evolving", "volatile"]).optional().describe("How quickly this knowledge changes. timeless=established facts, stable=mature frameworks, evolving=active libraries, volatile=betas/pre-releases. Default: stable"),
      verify_id: z.string().optional().describe("ID of an existing research entry to mark as still accurate. Updates its freshness clock instead of creating a new entry. Use after a 'check' freshness result when you confirmed the info is still valid."),
      tools_used: z.union([z.array(z.string()), z.string()]).optional().describe("Tools used during research, e.g. ['WebSearch', 'context7', 'WebFetch']. List the tools your agent called to produce this research."),
    },
    async ({ search_surface, content, sources: rawSources, tags: rawTags, gaps: rawGaps, raw_tokens: rawRawTokens, response_tokens: rawResponseTokens, replaces_id, started_from_ids: rawStartedFrom, volatility, verify_id, tools_used: rawToolsUsed }) => {
      // Parameter coercion — LLMs send arrays as JSON strings or comma-separated strings
      function coerceStringArray(raw: string | string[]): string[] {
        if (Array.isArray(raw)) return raw.map(s => s.replace(/^["'\[\]]+|["'\[\]]+$/g, '').trim()).filter(Boolean);
        const trimmed = raw.trim();
        if (trimmed.startsWith("[")) {
          try { return JSON.parse(trimmed); } catch {}
        }
        return trimmed.split(",").map(s => s.replace(/^["'\[\]]+|["'\[\]]+$/g, '').trim()).filter(Boolean);
      }
      const sources = rawSources ? coerceStringArray(rawSources) : [];
      const tags = rawTags ? coerceStringArray(rawTags) : [];
      const gaps = rawGaps ? coerceStringArray(rawGaps) : [];
      const raw_tokens = Number(rawRawTokens) || 0;
      const response_tokens = Number(rawResponseTokens) || 0;
      const started_from_ids: string[] = rawStartedFrom
        ? (typeof rawStartedFrom === "string"
          ? (rawStartedFrom.startsWith("[") ? JSON.parse(rawStartedFrom) : [rawStartedFrom])
          : rawStartedFrom)
        : [];
      const tools_used = rawToolsUsed ? coerceStringArray(rawToolsUsed) : [];
      try {
        // Verification mode: refresh the freshness clock without creating a new entry
        if (verify_id) {
          await verifyResearch(verify_id);
          return {
            content: [
              {
                type: "text" as const,
                text: "Research verified as still accurate. Freshness clock reset.",
              },
            ],
          };
        }

        // Required fields for new contributions (not needed for verify)
        if (!search_surface || !content) {
          return {
            content: [{ type: "text" as const, text: "Rejected: search_surface and content are required for new contributions." }],
          };
        }

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
          raw_tokens, response_tokens, replaces_id, started_from_ids,
          volatility: volatility ?? "stable",
          tools_used,
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
