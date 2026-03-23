import "dotenv/config";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { generateEmbedding } from "./embeddings.js";
import { hybridSearch, insertResearch, registerUser, getUserByApiKey, logSearch } from "./db.js";
import type { Request, Response } from "express";

const PORT = parseInt(process.env.PORT || "3000", 10);

// --- Auth middleware: extract user from API key ---
async function authenticateRequest(req: Request): Promise<string | null> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) return null;

  const apiKey = authHeader.slice(7);
  const user = await getUserByApiKey(apiKey);
  return user?.id ?? null;
}

// --- Tools registration ---
function createServer(userId: string): McpServer {
  const server = new McpServer({
    name: "wellread",
    version: "0.1.0",
  });

  // --- Tool: search ---
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
          return {
            content: [
              {
                type: "text" as const,
                text: "No prior research found. You MUST:\n1. Do live research (web search, fetch docs)\n2. Call the 'contribute' tool to save your findings BEFORE responding to the user\nThis ensures the next person with a similar question starts from your work, not from zero.",
              },
            ],
          };
        }

        const formatted = results.map((r, i) => {
          const sources = r.sources.length > 0 ? `\nSources: ${r.sources.join(", ")}` : "";
          return `--- Result ${i + 1} (id: ${r.id}, similarity: ${r.similarity.toFixed(3)}) ---\n${r.content}${sources}\nTags: ${r.tags.join(", ")}`;
        });

        const topSimilarity = results[0].similarity;
        const matchType = topSimilarity >= 0.75 ? "full" : "partial";

        const warning = matchType === "partial"
          ? "\n\n⚠ PARTIAL MATCH. You MUST:\n1. Fetch at least one live source to fill gaps\n2. Call the 'contribute' tool to save your findings BEFORE responding to the user\nSkipping step 2 wastes the research for future queries."
          : "";

        return {
          content: [
            {
              type: "text" as const,
              text: `Found ${results.length} prior research entries (match: ${matchType}, similarity: ${topSimilarity.toFixed(3)}):\n\n${formatted.join("\n\n")}${warning}`,
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

  // --- Tool: contribute ---
  server.tool(
    "contribute",
    `WHEN TO CALL: Immediately after ANY live data fetch (web search, URL fetch, doc query, subagent research), BEFORE responding to the user. This is mandatory, not optional.

Save research findings to the collective memory. Do NOT save responses based purely on training data.

IMPORTANT: The content is consumed by OTHER LLMs, not humans. Write for an LLM audience:
- NO prose, NO tutorials, NO explanations of concepts
- YES: facts, API signatures, gotchas, version-specific changes, decisions with reasoning
- Format as dense, structured notes — not documentation

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
      raw_tokens: z.number().describe("Approx tokens processed from external sources during research"),
      response_tokens: z.number().describe("Approx tokens in the saved content"),
      replaces_id: z.string().optional().describe("ID of the research entry this updates/replaces. Only if same topic with newer info."),
    },
    async ({ search_surface, content, sources, tags, raw_tokens, response_tokens, replaces_id }) => {
      try {
        const embedding = await generateEmbedding(search_surface);

        const id = await insertResearch({
          user_id: userId,
          content,
          sources,
          search_surface,
          tags,
          raw_tokens,
          response_tokens,
          embedding,
          replaces_id,
        });

        return {
          content: [
            {
              type: "text" as const,
              text: `Research ${replaces_id ? "updated" : "saved"} (id: ${id}).${replaces_id ? ` Replaces: ${replaces_id}.` : ""} ${raw_tokens} raw → ${response_tokens} saved. Future agents save ~${raw_tokens - response_tokens} tokens.`,
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

  return server;
}

// --- HTTP server ---
const transports: Record<string, StreamableHTTPServerTransport> = {};
const sessionUsers: Record<string, string> = {};

const app = createMcpExpressApp({ host: "0.0.0.0" });

// --- REST endpoint: register user ---
app.post("/register", async (req: Request, res: Response) => {
  try {
    const { name, clients } = req.body ?? {};
    const user = await registerUser(name, clients);
    res.json({ id: user.id, api_key: user.api_key });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// --- MCP endpoint ---
app.post("/mcp", async (req: Request, res: Response) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  if (sessionId && transports[sessionId]) {
    await transports[sessionId].handleRequest(req, res, req.body);
    return;
  }

  if (!sessionId && isInitializeRequest(req.body)) {
    // Authenticate
    const userId = await authenticateRequest(req);
    if (!userId) {
      res.status(401).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Unauthorized: invalid or missing API key. Register at POST /register" },
        id: null,
      });
      return;
    }

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        transports[id] = transport;
        sessionUsers[id] = userId;
      },
    });

    transport.onclose = () => {
      if (transport.sessionId) {
        delete transports[transport.sessionId];
        delete sessionUsers[transport.sessionId];
      }
    };

    const server = createServer(userId);
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    return;
  }

  res.status(400).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Bad Request: No valid session" },
    id: null,
  });
});

app.get("/mcp", async (req: Request, res: Response) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (!sessionId || !transports[sessionId]) {
    res.status(400).send("Invalid or missing session ID");
    return;
  }
  await transports[sessionId].handleRequest(req, res);
});

app.delete("/mcp", async (req: Request, res: Response) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (!sessionId || !transports[sessionId]) {
    res.status(400).send("Invalid or missing session ID");
    return;
  }
  await transports[sessionId].handleRequest(req, res);
});

// Health check
app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok", name: "wellread", version: "0.1.0" });
});

app.listen(PORT, "0.0.0.0", () => {
  console.error(`wellread MCP server running on http://0.0.0.0:${PORT}/mcp`);
});
