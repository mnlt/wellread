import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { supabase, getNetworkStats } from "../db.js";
import { waterSaved } from "../utils.js";

interface UserStats {
  // User info
  name: string | null;
  created_at: string;
  // Search stats
  search_count: number;
  no_match_count: number;
  partial_match_count: number;
  full_match_count: number;
  // Token economics
  tokens_kept: number;
  tokens_donated: number;
  tokens_distilled: number;
  // Social
  citations_count: number;
  contribution_count: number;
}

function computeKarma(stats: UserStats): number {
  // Karma = saving value + contribution value + social value
  // Weights chosen so early users see meaningful numbers
  const searchKarma = Math.round(stats.tokens_kept / 100); // 1 karma per 100 tokens saved
  const contributeKarma = stats.contribution_count * 50; // 50 karma per contribution
  const citationKarma = stats.citations_count * 10; // 10 karma per citation
  return searchKarma + contributeKarma + citationKarma;
}

function daysAgo(dateStr: string): number {
  return Math.max(1, Math.floor((Date.now() - new Date(dateStr).getTime()) / (1000 * 60 * 60 * 24)));
}

export function registerStatsTool(server: McpServer, userId: string) {
  server.tool(
    "stats",
    "View your personal wellread stats: karma, savings, contributions, and network impact.",
    {},
    async () => {
      try {
        // Fetch user data
        const { data: user, error: userErr } = await supabase
          .from("users")
          .select("name, created_at, search_count, no_match_count, partial_match_count, full_match_count, tokens_kept, tokens_donated, tokens_distilled, citations_count, contribution_count")
          .eq("id", userId)
          .single();

        if (userErr || !user) {
          return { content: [{ type: "text" as const, text: "Could not load stats." }] };
        }

        const stats = user as UserStats;

        // Top tags (from user's research entries)
        const { data: tagData } = await supabase
          .from("research")
          .select("tags")
          .eq("user_id", userId)
          .eq("is_current", true);

        const tagCounts: Record<string, number> = {};
        for (const row of tagData ?? []) {
          for (const tag of row.tags ?? []) {
            tagCounts[tag] = (tagCounts[tag] || 0) + 1;
          }
        }
        const topTags = Object.entries(tagCounts)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 6);

        // Network stats
        const network = await getNetworkStats();

        // Compute
        const karma = computeKarma(stats);
        const days = daysAgo(stats.created_at);
        const hitCount = stats.full_match_count + stats.partial_match_count;
        const hitRate = stats.search_count > 0 ? Math.round(hitCount / stats.search_count * 100) : 0;
        const networkContribPct = network.total_contributions > 0
          ? Math.round(stats.contribution_count / network.total_contributions * 100)
          : 0;

        const displayName = stats.name || "Anonymous";
        const tagsLine = topTags.length > 0
          ? topTags.map(([tag, count]) => `${tag} (${count})`).join(" · ")
          : "none yet";

        // Format the response
        const output = `
▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓
  **wellread** · ${displayName}
  ${karma.toLocaleString()} karma · ${days} day${days !== 1 ? "s" : ""} in
▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓

⚡ **YOU SAVED**
│ ${hitCount} search${hitCount !== 1 ? "es" : ""} you didn't have to do${stats.search_count > 0 ? ` · ${hitRate}% hit rate` : ""}
│ ${Math.round(stats.tokens_kept / 1000)}K tokens saved
│ ${waterSaved(stats.tokens_kept)} kept in the river 💧

🔬 **YOU GAVE BACK**
│ ${stats.contribution_count} research entr${stats.contribution_count !== 1 ? "ies" : "y"} published
│ Used by others ${stats.citations_count} time${stats.citations_count !== 1 ? "s" : ""}
│ ${topTags.length > 0 ? `Greatest hits: ${tagsLine}` : "Start contributing to build your profile"}

🌐 **THE NETWORK**
│ ${network.total_contributions} entries · ${waterSaved(network.total_tokens_saved)} saved
${networkContribPct > 0 ? `│ You're ${networkContribPct}% of this network's brain 🧠` : "│"}

*Every research you save is one less someone else has to do.*`;

        return {
          content: [{ type: "text" as const, text: output }],
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Stats error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    }
  );
}
