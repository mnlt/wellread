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

// Fetch a URL and return its text content length in chars.
// Returns 0 on any failure — never blocks the save pipeline.
async function fetchSourceChars(url: string): Promise<number> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "wellread-mcp/token-counter" },
    });
    clearTimeout(timeout);
    if (!res.ok) return 0;
    const text = await res.text();
    // Strip HTML tags to approximate the text content the agent saw
    return text.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim().length;
  } catch {
    return 0;
  }
}

async function processContributionAsync(
  userId: string,
  data: {
    search_surface: string;
    content: string;
    sources: string[];
    tags: string[];
    gaps: string[];
    replaces_id?: string;
    started_from_ids?: string[];
    volatility?: string;
  }
): Promise<void> {
  try {
    // Compute response_tokens from actual content length (exact, not agent-estimated)
    const response_tokens = Math.ceil(data.content.length / 4);

    const embedding = await generateEmbedding(data.search_surface);
    const result = await insertResearch({
      user_id: userId,
      content: data.content,
      gaps: data.gaps,
      sources: data.sources,
      search_surface: data.search_surface,
      tags: data.tags,
      raw_tokens: 0, // placeholder — updated below after fetching sources
      response_tokens,
      embedding,
      replaces_id: data.replaces_id,
      started_from_ids: data.started_from_ids,
      volatility: data.volatility,
    });
    incrementUserContributions(userId, 0, response_tokens);

    // Fetch sources in parallel and compute actual raw_tokens
    const charCounts = await Promise.all(data.sources.map(fetchSourceChars));
    const raw_tokens = Math.ceil(charCounts.reduce((sum, c) => sum + c, 0) / 4);

    if (raw_tokens > 0) {
      await supabase
        .from("research")
        .update({ raw_tokens })
        .eq("id", result.id);
    }
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
      sources: z.union([z.array(z.string()), z.string()]).optional().describe("ALL public URLs fetched during research — do not omit any. MUST start with https:// or http://. Include every web page, doc fetch, and context7 result URL. Required for new contributions."),
      tags: z.union([z.array(z.string()), z.string()]).optional().describe("Lowercase tags: technologies, concepts. Required for new contributions."),
      gaps: z.union([z.array(z.string()), z.string()]).optional().describe("Unexplored angles for future investigators. Required for new contributions."),
      raw_tokens: z.union([z.number(), z.string()]).optional().describe("Deprecated — computed server-side. Ignored if provided."),
      response_tokens: z.union([z.number(), z.string()]).optional().describe("Deprecated — computed server-side. Ignored if provided."),
      replaces_id: z.string().optional().describe("ID of entry this updates/replaces. Only if same topic with newer info."),
      started_from_ids: z.union([z.array(z.string()), z.string()]).optional().describe("IDs of research entries this was built from. Pass the IDs from the search results."),
      volatility: z.enum(["timeless", "stable", "evolving", "volatile"]).optional().describe("How quickly this knowledge changes. timeless=established facts, stable=mature frameworks, evolving=active libraries, volatile=betas/pre-releases. Default: stable"),
      verify_id: z.string().optional().describe("ID of an existing research entry to mark as still accurate. Updates its freshness clock instead of creating a new entry. Use after a 'check' freshness result when you confirmed the info is still valid."),
      client_stats: z.union([z.string(), z.record(z.string(), z.any())]).optional().describe("JSON object/string from the local helper with current 5h window stats. Pass exactly as shown in your hook instructions."),
    },
    async ({ search_surface, content, sources: rawSources, tags: rawTags, gaps: rawGaps, replaces_id, started_from_ids: rawStartedFrom, volatility, verify_id }) => {
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
          replaces_id, started_from_ids,
          volatility: volatility ?? "stable",
        });

        // Read the user's current contribution count to compute the badge milestone number.
        // This is the count BEFORE the async insert lands, so we add 1 for "the one we just saved".
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
