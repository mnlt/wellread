import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { supabase, getNetworkStats } from "../db.js";
import { waterSaved } from "../utils.js";

interface UserStats {
  name: string | null;
  created_at: string;
  search_count: number;
  no_match_count: number;
  partial_match_count: number;
  full_match_count: number;
  tokens_kept: number;
  tokens_donated: number;
  tokens_distilled: number;
  citations_count: number;
  contribution_count: number;
}

function computeKarma(stats: UserStats): number {
  const searchKarma = Math.round(stats.tokens_kept / 100);
  const contributeKarma = stats.contribution_count * 50;
  const citationKarma = stats.citations_count * 10;
  return searchKarma + contributeKarma + citationKarma;
}

function daysAgo(dateStr: string): number {
  return Math.max(1, Math.floor((Date.now() - new Date(dateStr).getTime()) / (1000 * 60 * 60 * 24)));
}

function formatTokensCompact(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}K`;
  return String(tokens);
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

        // Network stats
        const network = await getNetworkStats();

        // Best hit (biggest tokens_saved)
        const { data: bestHit } = await supabase
          .from("searches")
          .select("query_text, tokens_saved")
          .eq("user_id", userId)
          .eq("matched", true)
          .order("tokens_saved", { ascending: false })
          .limit(1)
          .single();

        // Top 5 contributions by citations
        const { data: topContribs } = await supabase
          .from("research")
          .select("search_surface, match_count, raw_tokens, response_tokens")
          .eq("user_id", userId)
          .eq("is_current", true)
          .order("match_count", { ascending: false })
          .limit(5);

        // Format top contributions table
        const topContribRows = (topContribs ?? []).map((r) => {
          const topic = (r.search_surface ?? "")
            .split("\n")[0]
            .replace(/^\[TOPIC\]:\s*/i, "")
            .toLowerCase();
          const topicTrunc = topic.length > 40 ? topic.slice(0, 37) + "..." : topic.padEnd(40);
          const saved = r.raw_tokens - r.response_tokens;
          const savedStr = saved > 0 ? formatTokensCompact(saved).padEnd(6) : "-".padEnd(6);
          const cited = r.match_count > 0
            ? `${r.match_count} time${r.match_count !== 1 ? "s" : ""}`
            : "not yet";
          return `│ ${topicTrunc}  ${savedStr}  ${cited}`;
        });

        const topContribsBlock = topContribRows.length > 0
          ? `│ Top contributions\n│\n│ ${"Topic".padEnd(40)}  ${"Saved".padEnd(6)}  Cited\n│ ${"─".repeat(58)}\n${topContribRows.join("\n")}`
          : "│ Start contributing to build your profile";

        // Compute
        const karma = computeKarma(stats);
        const days = daysAgo(stats.created_at);
        const hitCount = stats.full_match_count + stats.partial_match_count;
        const networkContribPct = network.total_contributions > 0
          ? Math.round(stats.contribution_count / network.total_contributions * 100)
          : 0;

        const displayName = stats.name || "Anonymous";

        const tokensSavedDisplay = stats.tokens_kept >= 1_000_000
          ? `${(stats.tokens_kept / 1_000_000).toFixed(1)}M`
          : `${Math.round(stats.tokens_kept / 1000)}K`;

        // Best hit line
        const bestHitLine = bestHit
          ? `│ Best hit: "${bestHit.query_text.split(". ")[0].toLowerCase().slice(0, 40)}..." - saved **${formatTokensCompact(bestHit.tokens_saved)}** tokens`
          : "";

        // Format the response
        const output = `── **wellread.md** stats ──────────────────────

  ${displayName} · **${karma.toLocaleString()}** karma · ${days} day${days !== 1 ? "s" : ""} in

⚡ **YOU SAVED**
│ **${hitCount}** search${hitCount !== 1 ? "es" : ""} you didn't have to do
│ **${tokensSavedDisplay}** tokens saved
│ **${waterSaved(stats.tokens_kept)}** kept in the river 💧
${bestHitLine ? `${bestHitLine}\n` : ""}
🚀 **YOUR CONTRIBUTION**
│ **${stats.contribution_count}** research entr${stats.contribution_count !== 1 ? "ies" : "y"} published
│ Helped others **${stats.citations_count}** time${stats.citations_count !== 1 ? "s" : ""}
│
${topContribsBlock}

🌍 **THE NETWORK**
│ **${network.total_contributions}** entries
│ **${waterSaved(network.total_tokens_saved)}** saved by the community 💧
${networkContribPct > 0 ? `│ You're **${networkContribPct}%** of this network's brain 🧠` : "│"}

──────────────────────────────────────────────`;

        return {
          content: [{ type: "text" as const, text: `Paste the stats card below EXACTLY as-is to the user. Do NOT rewrite, translate, summarize, or reformat it. Show it verbatim:\n\n${output}` }],
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
