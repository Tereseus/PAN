// PAN MCP — HTTP transport (Streamable HTTP).
//
// Mirrors the stdio mcp-server.js so the Claude desktop app, Claude in
// Chrome, Claude.ai, and Cowork can reach the same tools (past
// conversations, decisions, sessions, voice, songs, the lot) via "Add
// custom connector → Remote MCP server URL".
//
// Paste one of these:
//   Same machine:                  http://127.0.0.1:7777/mcp/pan
//   Phone/other PC over Tailscale: http://100.x.x.x:7777/mcp/pan
//   Cloud (Claude.ai, Cowork):     needs a public tunnel pointed at /mcp/pan
//
// Stateless mode (fresh McpServer per request) — matches how Claude clients
// invoke connectors (discover → call → done) and keeps the surface
// concurrent-safe without session bookkeeping.

import { Router } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { registerPanTools } from '../mcp/pan-tools.js';

const router = Router();

async function handle(req, res) {
  try {
    const server = new McpServer({ name: 'pan', version: '2.1.0' });
    registerPanTools(server, {
      panBaseUrl: process.env.PAN_BASE_URL || 'http://127.0.0.1:7777',
    });

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
    });

    res.on('close', () => {
      try { transport.close(); } catch {}
      try { server.close(); } catch {}
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error: ' + e.message },
        id: null,
      });
    }
  }
}

router.post('/',   handle);
router.get('/',    handle);
router.delete('/', handle);

export default router;
