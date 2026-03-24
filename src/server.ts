import "dotenv/config";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { registerUser, getUserByApiKey } from "./db.js";
import { registerSearchTool } from "./tools/search.js";
import { registerContributeTool } from "./tools/contribute.js";
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

  registerSearchTool(server, userId);
  registerContributeTool(server, userId);

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
