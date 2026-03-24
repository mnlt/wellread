import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { generateEmbedding } from "../embeddings.js";
import { hybridSearch, logSearch, getNetworkStats, supabase } from "../db.js";
import { waterSaved } from "../utils.js";

export function registerSearchTool(server: McpServer, userId: string) {
  server.tool(
    "search",
    `Search the collective research memory. Call this BEFORE doing your own research.

You (the LLM) must generate the search input yourself:
- queries: 3 reformulated variants of the user's question using different vocabulary.
  KEEP technical context: stack, versions, runtime, deploy platform, architecture patterns.
  REMOVE personal context: project names, internal URLs, endpoint names, business logic.
- keywords: specific technology names, versions, concepts, and abbreviations that should match exactly.

Example: User asks "how do I send emails with Resend in my Next.js 15 app deployed on Vercel?"
→ queries: ["Resend email integration Next.js 15 App Router", "transactional email API React Server Components Vercel serverless", "Resend SDK setup Node.js edge runtime"]
→ keywords: "resend email nextjs-15 app-router vercel serverless react-server-components"`,
    {
      queries: z.array(z.string()).describe("3 reformulated search queries with different vocabulary"),
      keywords: z.string().describe("Space-separated keywords for exact matching"),
      agent: z.string().optional().describe("Which tool is calling: claude-code, cursor, gemini-cli, windsurf, etc."),
    },
    async ({ queries, keywords, agent }) => {
      try {
        const combinedQuery = queries.join(". ");
        const embedding = await generateEmbedding(combinedQuery);
        const results = await hybridSearch(keywords, embedding, 5);

        // Log the search (async, non-blocking)
        const tokensSaved = results.reduce((sum, r) => sum + (r.raw_tokens - r.response_tokens), 0);
        logSearch({
          user_id: userId,
          query_text: combinedQuery,
          keywords,
          matched: results.length > 0,
          match_count: results.length,
          results: results.map((r) => ({
            research_id: r.id,
            score: r.score,
            raw_tokens: r.raw_tokens,
            response_tokens: r.response_tokens,
          })),
          tokens_saved: Math.max(tokensSaved, 0),
          agent,
        });

        if (results.length === 0) {
          const stats = await getNetworkStats();
          return {
            content: [
              {
                type: "text" as const,
                text: `No one has researched this... yet. You'll be the first.\n\nYou MUST:\n1. Do live research (web search, fetch docs)\n2. Call the 'contribute' tool BEFORE responding to the user\n\n🌍 **No one has been here... yet**\nYour research will be the first\nWellread contributors saved ${waterSaved(stats.total_tokens_saved)} in ${stats.days_active}d`,
              },
            ],
          };
        }

        // Fetch gaps for results
        const gapsData = await Promise.all(
          results.map((r) =>
            supabase.from("research").select("gaps").eq("id", r.id).single()
          )
        );

        const formatted = results.map((r, i) => {
          const sources = r.sources.length > 0 ? `\nSources: ${r.sources.join(", ")}` : "";
          const gaps = gapsData[i]?.data?.gaps;
          const gapsStr = gaps && gaps.length > 0 ? `\nGaps (unexplored): ${gaps.join(" · ")}` : "";
          return `--- Result ${i + 1} (id: ${r.id}, similarity: ${r.similarity.toFixed(3)}) ---\n${r.content}${sources}${gapsStr}\nTags: ${r.tags.join(", ")}`;
        });

        const topSimilarity = results[0].similarity;
        const matchType = topSimilarity >= 0.75 ? "full" : "partial";

        const warning = matchType === "partial"
          ? "\n\n⚠ PARTIAL MATCH. You MUST:\n1. Fetch at least one live source to fill gaps\n2. Call the 'contribute' tool BEFORE responding\nSkipping step 2 wastes the research for future queries."
          : "";

        const tokensSavedThisQuery = results.reduce((sum, r) => sum + (r.raw_tokens - r.response_tokens), 0);
        const [{ data: topResearch }, stats] = await Promise.all([
          supabase.from("research").select("match_count").eq("id", results[0].id).single(),
          getNetworkStats(),
        ]);
        const matchCount = topResearch?.match_count ?? 1;

        return {
          content: [
            {
              type: "text" as const,
              text: `Found ${results.length} prior research entries (match: ${matchType}, similarity: ${topSimilarity.toFixed(3)}):\n\n${formatted.join("\n\n")}${warning}\n\n🌍 **Already figured out**\n${waterSaved(tokensSavedThisQuery)} saved\nWellread contributors saved ${waterSaved(stats.total_tokens_saved)} in ${stats.days_active}d`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Search error: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
