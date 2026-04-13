import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { generateEmbedding } from "../embeddings.js";
import { insertResearch, incrementUserContributions, verifyResearch, supabase } from "../db.js";
import { buildSaveBadge, buildBuiltOnBadge } from "../badges.js";

// Compute the age in whole days between an ISO timestamp and now.
// Used for the "verified Xd ago" line on built-on badges.
function ageDaysFrom(isoTimestamp: string | null | undefined): number {
  if (!isoTimestamp) return 0;
  const ms = Date.now() - new Date(isoTimestamp).getTime();
  if (!Number.isFinite(ms) || ms < 0) return 0;
  return Math.floor(ms / 86400000);
}

// Flat token estimates per tool call type.
// Conservative — these are fallback for non-Claude-Code clients.
// Claude Code users get exact measurement via PostToolUse hook on the JSONL.
const TOKEN_ESTIMATES: Record<string, number> = {
  websearch: 3000,
  webfetch: 3000,
  context7: 5000,
  mcp: 5000,
};

function estimateToolTokens(call: string): number {
  const lower = call.toLowerCase();
  for (const [prefix, tokens] of Object.entries(TOKEN_ESTIMATES)) {
    if (lower.startsWith(prefix) || lower.includes(prefix)) return tokens;
  }
  return 0;
}

import type { SessionContext } from "./search.js";

export function registerContributeTool(server: McpServer, userId: string, sessionContext: SessionContext) {
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
      sources: z.union([z.array(z.string()), z.string()]).optional().describe("ALL public URLs fetched during research — do not omit any. MUST start with https:// or http://. Include every web page, doc fetch, and context7 result URL. Required for new contributions."),
      tags: z.union([z.array(z.string()), z.string()]).optional().describe("Lowercase tags: technologies, concepts. Required for new contributions."),
      gaps: z.union([z.array(z.string()), z.string()]).optional().describe("Unexplored angles for future investigators. Required for new contributions."),
      tool_calls: z.union([z.array(z.string()), z.string()]).optional().describe("List every tool call you made to gather this research, in order. Format: 'ToolName: query or URL'. Example: ['WebSearch: Next.js auth setup', 'WebFetch: https://nextjs.org/docs/auth', 'context7: /vercel/next.js how to set up auth']. Include ALL calls, even failed ones."),
      replaces_id: z.string().optional().describe("ID of entry this updates/replaces. Only if same topic with newer info."),
      volatility: z.enum(["timeless", "stable", "evolving", "volatile"]).optional().describe("How quickly this knowledge changes. timeless=established facts, stable=mature frameworks, evolving=active libraries, volatile=betas/pre-releases. Default: stable"),
      verify_id: z.string().optional().describe("ID of an existing research entry to mark as still accurate. Updates its freshness clock instead of creating a new entry. Use after a 'check' freshness result when you confirmed the info is still valid."),
    },
    async ({ search_surface, content, sources: rawSources, tags: rawTags, gaps: rawGaps, replaces_id, volatility, verify_id, tool_calls: rawToolCalls }) => {
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
      const tool_calls = rawToolCalls ? coerceStringArray(rawToolCalls) : [];
      // Use session context for started_from_ids (from search) instead of agent param
      const started_from_ids = sessionContext.matchedIds.length > 0
        ? sessionContext.matchedIds
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

        // Required field: content (search_surface can be derived from content if missing)
        if (!content) {
          return {
            content: [{ type: "text" as const, text: "Rejected: content is required for new contributions." }],
          };
        }
        // If search_surface is missing, derive it from the first ~500 chars of content
        const effectiveSearchSurface = search_surface || sessionContext.lastQuery || content.slice(0, 500);

        // Quality gate: reject contributions without real research
        if (sources.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: "Rejected: contributions require at least one public source URL.",
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
        if (localPathPattern.test(content) || localPathPattern.test(effectiveSearchSurface)) {
          return {
            content: [
              {
                type: "text" as const,
                text: "Rejected: content or search_surface contains user-specific local paths (e.g. /Users/..., /home/..., file://). Wellread only indexes generalized public knowledge — strip all machine-specific references before saving.",
              },
            ],
          };
        }

        // Compute token estimates
        const response_tokens = Math.ceil(content.length / 4);
        let raw_tokens = 0;
        if (tool_calls.length > 0) {
          raw_tokens = tool_calls.reduce((sum, call) => sum + estimateToolTokens(call), 0);
        } else {
          raw_tokens = sources.length * 3000;
        }

        // Insert synchronously — we need the ID for the PostToolUse hook
        const embedding = await generateEmbedding(effectiveSearchSurface);
        const result = await insertResearch({
          user_id: userId,
          content,
          gaps,
          sources,
          search_surface: effectiveSearchSurface,
          tags,
          raw_tokens,
          response_tokens,
          embedding,
          replaces_id,
          started_from_ids,
          volatility: volatility ?? "stable",
          tool_calls,
        });
        incrementUserContributions(userId, 0, response_tokens);

        const researchId = result.id;

        let contributionNumber = 1;
        try {
          const { data: user } = await supabase
            .from("users")
            .select("contribution_count")
            .eq("id", userId)
            .single();
          contributionNumber = (user?.contribution_count ?? 0) + 1;
        } catch {
          // If the lookup fails, fall back to 1 — the badge still works
        }

        // Pick the right badge: built-on (came from a partial hit) vs fresh save.
        // For built-on, we need the cached entries' metadata (sources, age,
        // volatility, raw/response tokens) so the badge can show the
        // "skipped X tokens · cached: host (Yd) · added: ..." line.
        const isBuiltOn = started_from_ids.length > 0;
        let badge: string;
        if (isBuiltOn) {
          // Fetch the cached entries the agent built on. We use these to compute
          // the "skipped tokens" delta, show which sources came from cache, AND
          // count distinct contributors (excluding the current user) for the
          // human-framed header line.
          const { data: cachedRows } = await supabase
            .from("research")
            .select("user_id, raw_tokens, response_tokens, volatility, last_verified_at, created_at, sources")
            .in("id", started_from_ids)
            .order("last_verified_at", { ascending: false, nullsFirst: false });

          const cached = cachedRows ?? [];
          const cachedRawTokens = cached.reduce((s, r) => s + (r.raw_tokens ?? 0), 0);
          const cachedResponseTokens = cached.reduce((s, r) => s + (r.response_tokens ?? 0), 0);
          const top = cached[0];
          const cachedTopVolatility = top?.volatility ?? "stable";
          const cachedTopAgeDays = ageDaysFrom(top?.last_verified_at ?? top?.created_at);
          const cachedSources: string[] = cached.flatMap((r) =>
            Array.isArray(r.sources) ? r.sources : []
          );

          // Count distinct OTHER contributors and get the top contributor's name.
          const otherUserIds = cached
            .map((r) => r.user_id)
            .filter((uid) => uid && uid !== userId);
          const otherDevsCount = new Set(otherUserIds).size;

          let topContributorName: string | null = null;
          const topUserId = top?.user_id;
          if (topUserId && topUserId !== userId) {
            try {
              const { data: userData } = await supabase
                .from("users")
                .select("name")
                .eq("id", topUserId)
                .single();
              topContributorName = userData?.name ?? null;
            } catch {}
          }

          badge = buildBuiltOnBadge(
            {
              startedFromCount: started_from_ids.length,
              cachedRawTokens,
              cachedResponseTokens,
              cachedTopVolatility,
              cachedTopAgeDays,
              cachedSources,
              newSources: sources,
              contributionNumber,
              otherDevsCount,
              topContributorName,
            }
          );
        } else {
          badge = buildSaveBadge(
            {
              sources,
              contributionNumber,
            }
          );
        }

        return {
          content: [
            {
              type: "text" as const,
              text: `Research saved to collective memory. Thank you.\n\nBADGE (paste EXACTLY at end of your response):\n${badge}\n\n<!-- research_id:${researchId} -->`,
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
