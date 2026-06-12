#!/usr/bin/env node

// PAN MCP Server — stdio transport for the Claude CLI.
//
// Tool definitions live in mcp/pan-tools.js so they can be reused by the HTTP
// transport (routes/mcp-pan.js) without drift.
//
// For the Claude desktop app / Claude in Chrome / Claude.ai / Cowork, use the
// HTTP transport instead: paste http://127.0.0.1:7777/mcp/pan into
// the "Add custom connector → Remote MCP server URL" dialog.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerPanTools } from './mcp/pan-tools.js';

const PAN = process.env.PAN_BASE_URL || 'http://127.0.0.1:7777';

const server = new McpServer({ name: 'pan', version: '2.1.0' });
registerPanTools(server, { panBaseUrl: PAN });

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('[PAN MCP] stdio server started');
