// HTTP transport for the quality-log MCP server.
//
// Lets the Claude desktop app, Claude in Chrome, Claude.ai, and Cowork add
// quality-log as a custom connector via "Add custom connector → Remote MCP
// server URL". The URL is whatever points to this server on whichever
// network the client is on:
//
//   Desktop app on this PC:  http://127.0.0.1:7777/mcp/quality-log
//   Phone / other PC over Tailscale: http://100.x.x.x:7777/mcp/quality-log
//   Cloud Claude (Claude.ai, Cowork): needs a public tunnel (Cloudflare
//     Tunnel, ngrok, etc.) pointed at 7777/mcp/quality-log. Localhost won't
//     be reachable from cloud agents.
//
// We use stateless mode (one McpServer per request) so there's no session
// memory to keep alive — every request initialises, lists tools, runs the
// call, tears down. This matches how the Claude desktop client invokes the
// connector: discover → call → done. It also means CRoss-instance routing
// works (no sticky-session requirement).

import { Router } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { registerQualityLogTools } from '../mcp/quality-log-tools.js';

const router = Router();

// Stateless handler — fresh McpServer + transport per request. Cheap because
// tool registration is just a few function calls; no DB or network at boot.
async function handle(req, res) {
  try {
    const server = new McpServer({ name: 'quality-log', version: '0.1.0' });
    registerQualityLogTools(server, {
      // Resolve the base URL from the incoming request so the route works
      // whether the caller hit 127.0.0.1, Tailscale, or a tunnel. The MCP
      // tools internally fetch /api/v1/quality-log/* on this same origin.
      panBaseUrl: process.env.PAN_BASE_URL || 'http://127.0.0.1:7777',
    });

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
    });

    // Tear down per-request resources when the client disconnects.
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

// MCP Streamable HTTP transport accepts both POST (client→server messages)
// and GET (server-initiated SSE stream). Mount on both. DELETE is reserved
// for session termination in stateful mode — harmless to expose here.
router.post('/',   handle);
router.get('/',    handle);
router.delete('/', handle);

export default router;
