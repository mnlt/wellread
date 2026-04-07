import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { generateEmbedding } from "../embeddings.js";
import { insertResearch, incrementUserContributions, verifyResearch } from "../db.js";
import { randomPick } from "../utils.js";

const CONTRIBUTION_QUIPS = [
  "First one here. Enjoy the silence.",
  "Uncharted territory. You just charted it.",
  "Fresh knowledge. Still warm.",
  "You broke new ground. The ground says thanks.",
  "The hive mind just learned something new.",
  "The network just got smarter.",
  "First hit. No cache. All you.",
  "This one's going in the vault.",
  "That was virgin territory. Was.",
  "Nobody asked this before? Really?",
];

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
    });
    incrementUserContributions(userId, data.raw_tokens, data.response_tokens);
  } catch (err) {
    console.error("Async contribution processing error:", err);
  }
}

export function registerContributeTool(server: McpServer, userId: string) {
  server.tool(
    "save",
    `Save research to collective memory. Call directly BEFORE responding to the user, after any live research (web search, URL fetch, context7).

Content is PUBLIC, consumed by LLMs worldwide. ALWAYS English. Dense structured notes — no tutorials.
NEVER include: project/repo/company names, internal URLs, file paths, credentials, business logic.
Set volatility: timeless (established facts), stable (mature frameworks), evolving (active libraries), volatile (betas/pre-releases).

search_surface MUST use this format:
[TOPIC]: Semantic caching for LLM API calls
[COVERS]: hit rates, cost reduction, cache invalidation
[TECHNOLOGIES]: Next.js 15, React 19, Auth.js v5
[RELATED]: authentication, server components, middleware
[SOLVES]: Setting up authentication in Next.js App Router`,
    {
      search_surface: z.string().optional().describe("Structured retrieval block for future search matching. Required for new contributions. Example:\n[TOPIC]: Authentication in Next.js App Router\n[COVERS]: Auth.js setup, middleware protection, session management\n[TECHNOLOGIES]: Next.js 15, React 19, Auth.js v5\n[RELATED]: authentication, server components, middleware\n[SOLVES]: Setting up authentication in Next.js App Router"),
      content: z.string().optional().describe("Dense notes for LLM consumption: API signatures, gotchas, version-specific changes, decision rationale, pitfalls. No prose, no tutorials. Required for new contributions."),
      sources: z.union([z.array(z.string()), z.string()]).optional().describe("Public URLs actually fetched during research. MUST start with https:// or http:// — file paths, library identifiers, or descriptions are rejected. If you used a docs MCP like context7, use the public URL of the doc page, not the library ID. Required for new contributions."),
      tags: z.union([z.array(z.string()), z.string()]).optional().describe("Lowercase tags: technologies, concepts. Required for new contributions."),
      gaps: z.union([z.array(z.string()), z.string()]).optional().describe("Unexplored angles for future investigators. Required for new contributions."),
      raw_tokens: z.union([z.number(), z.string()]).optional().describe("Total tokens consumed from ALL external sources during research: web pages fetched, documentation retrieved (e.g. context7), API docs read. Count everything you processed to produce this answer. Typical values: 5K-10K for simple topics, 15K-30K for complex multi-source research. Required for new contributions."),
      response_tokens: z.union([z.number(), z.string()]).optional().describe("Approx token count of the content field you're saving. Required for new contributions."),
      replaces_id: z.string().optional().describe("ID of entry this updates/replaces. Only if same topic with newer info."),
      started_from_ids: z.union([z.array(z.string()), z.string()]).optional().describe("IDs of research entries this was built from. Pass the IDs from the search results."),
      volatility: z.enum(["timeless", "stable", "evolving", "volatile"]).optional().describe("How quickly this knowledge changes. timeless=established facts, stable=mature frameworks, evolving=active libraries, volatile=betas/pre-releases. Default: stable"),
      verify_id: z.string().optional().describe("ID of an existing research entry to mark as still accurate. Updates its freshness clock instead of creating a new entry. Use after a 'check' freshness result when you confirmed the info is still valid."),
    },
    async ({ search_surface, content, sources: rawSources, tags: rawTags, gaps: rawGaps, raw_tokens: rawRawTokens, response_tokens: rawResponseTokens, replaces_id, started_from_ids: rawStartedFrom, volatility, verify_id }) => {
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

        // Privacy gate 1: every source MUST be a public http(s):// URL.
        // No file paths, no library identifiers, no descriptions, no "context7 /lib/name" — only real URLs.
        // Wellread is a cache of PUBLIC knowledge; research that can't be cited with a public URL doesn't belong here.
        const invalidSources = sources.filter((s) => {
          const trimmed = s.trim();
          return !(trimmed.startsWith("https://") || trimmed.startsWith("http://"));
        });
        if (invalidSources.length > 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Rejected: every source must be a public URL starting with https:// or http://. Got: ${invalidSources.map((s) => `"${s.slice(0, 60)}"`).join(", ")}. If you researched the user's own code or local files, do not call save — that knowledge is not shareable. If you used a docs MCP (e.g. context7), use the public URL of the doc page, not the library identifier.`,
              },
            ],
          };
        }

        // Privacy gate 2: reject content/search_surface that contains user-specific local paths.
        // Catches the case where the agent put public sources but leaked paths inside the content.
        // Match real-looking local paths but allow generic /etc/<software> references that are public.
        const localPathPattern = /(?:file:\/\/|\/(?:Users|home|root)\/[A-Za-z0-9._-]+|[A-Za-z]:[\\/](?:Users|Documents))/;
        if (localPathPattern.test(content) || localPathPattern.test(search_surface)) {
          return {
            content: [
              {
                type: "text" as const,
                text: "Rejected: content or search_surface contains user-specific local paths (e.g. /Users/..., /home/..., file://). Wellread only indexes generalized public knowledge — strip all machine-specific references before saving.",
              },
            ],
          };
        }

        // Fire off heavy work async — non-blocking
        processContributionAsync(userId, {
          search_surface, content, sources, tags, gaps,
          raw_tokens, response_tokens, replaces_id, started_from_ids,
          volatility: volatility ?? "stable",
        });

        const quip = randomPick(CONTRIBUTION_QUIPS);
        const sourceWord = sources.length === 1 ? "source" : "sources";
        const badge = `── **wellread.md** ──\n\n**🗺️ Added to the network!**\n\n${sources.length} ${sourceWord} distilled into a ~${response_tokens}-token entry. Future devs skip your work.\n\n${quip}\n\n*(say "show me my wellread stats" to see your impact)*`;

        return {
          content: [
            {
              type: "text" as const,
              text: `Research saved to collective memory. Thank you.\n\nBADGE (paste EXACTLY at end of your response):\n${badge}`,
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
