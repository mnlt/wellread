import "dotenv/config";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import rateLimit from "express-rate-limit";
import { registerUser, getUserByApiKey, supabase } from "./db.js";
import { registerSearchTool } from "./tools/search.js";
import { registerContributeTool } from "./tools/contribute.js";
import { registerStatsTool } from "./tools/stats.js";
import type { Request, Response } from "express";

// Single source of truth for version: read from package.json at startup
const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8"));
const VERSION = pkg.version as string;

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
function createServer(userId: string, sessionId: string): McpServer {
  const server = new McpServer({
    name: "wellread",
    version: VERSION,
  });

  // Shared session context — search populates, contribute reads
  const sessionContext = {
    agent: null as string | null,
    matchedIds: [] as string[],
    lastQuery: null as string | null,
  };

  registerSearchTool(server, userId, sessionId, sessionContext);
  registerContributeTool(server, userId, sessionContext);
  registerStatsTool(server, userId);

  return server;
}

// --- HTTP server ---
const transports: Record<string, StreamableHTTPServerTransport> = {};
const sessionUsers: Record<string, string> = {};

const app = createMcpExpressApp({ host: "0.0.0.0" });

// --- Rate limiting ---
const registerLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // 5 registrations per IP per window
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many registrations. Try again later." },
});

// --- REST endpoint: register user ---
app.post("/register", registerLimiter, async (req: Request, res: Response) => {
  try {
    const { name, clients } = req.body ?? {};

    // Reject registrations without detected clients (likely scanners/bots)
    if (!clients || !Array.isArray(clients) || clients.length === 0) {
      res.status(400).json({ error: "At least one supported client is required (claude-code, cursor, windsurf, etc.)" });
      return;
    }

    const user = await registerUser(name, clients);
    res.json({ id: user.id, api_key: user.api_key });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// --- REST endpoint: update user profile (name) ---
app.patch("/user", async (req: Request, res: Response) => {
  try {
    const userId = await authenticateRequest(req);
    if (!userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const { name } = req.body ?? {};
    if (!name || typeof name !== "string" || name.trim().length === 0) {
      res.status(400).json({ error: "name is required" });
      return;
    }
    const trimmed = name.trim().slice(0, 40); // cap length
    const { error } = await supabase
      .from("users")
      .update({ name: trimmed })
      .eq("id", userId);
    if (error) throw error;
    res.json({ name: trimmed });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// --- REST endpoint: update research measurement from PostToolUse hook ---
app.patch("/measure", async (req: Request, res: Response) => {
  try {
    const userId = await authenticateRequest(req);
    if (!userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const { id, raw_tokens, research_turns, total_context } = req.body ?? {};
    if (!id || typeof id !== "string") {
      res.status(400).json({ error: "id is required" });
      return;
    }

    // Verify the research belongs to this user
    const { data: existing } = await supabase
      .from("research")
      .select("user_id")
      .eq("id", id)
      .single();

    if (!existing || existing.user_id !== userId) {
      res.status(404).json({ error: "Research not found" });
      return;
    }

    const update: Record<string, number> = {};
    if (typeof raw_tokens === "number" && raw_tokens > 0) update.raw_tokens = raw_tokens;
    if (typeof research_turns === "number" && research_turns > 0) update.research_turns = research_turns;
    if (typeof total_context === "number" && total_context > 0) update.total_context = total_context;

    if (Object.keys(update).length === 0) {
      res.status(400).json({ error: "No valid fields to update" });
      return;
    }

    const { error } = await supabase
      .from("research")
      .update(update)
      .eq("id", id);

    if (error) throw error;
    res.json({ updated: true });
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
    const userId = await authenticateRequest(req);
    if (!userId) {
      res.status(401).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Unauthorized: invalid or missing API key. Register at POST /register" },
        id: null,
      });
      return;
    }

    const mcpSessionId = randomUUID();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => mcpSessionId,
      onsessioninitialized: (id) => {
        transports[id] = transport;
        sessionUsers[id] = userId;
        // Track connection (async, non-blocking)
        supabase.rpc("increment_connections", { p_user_id: userId }).then(({ error }) => {
          if (error) console.error("Connection increment error:", error);
        });
      },
    });

    transport.onclose = () => {
      if (transport.sessionId) {
        delete transports[transport.sessionId];
        delete sessionUsers[transport.sessionId];
      }
    };

    const server = createServer(userId, mcpSessionId);
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
  res.json({ status: "ok", name: "wellread", version: VERSION });
});

app.listen(PORT, "0.0.0.0", () => {
  console.error(`wellread MCP server running on http://0.0.0.0:${PORT}/mcp`);
});
