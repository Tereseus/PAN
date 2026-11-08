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
import { registerPanTools, PAN_MCP_INSTRUCTIONS } from './mcp/pan-tools.js';
import { panBaseUrl } from './mcp/pan-address.js';

// PAN_BASE_URL, else this computer's PAN Link, else PAN on this computer (mcp/pan-address.js).
const PAN = panBaseUrl();

const server = new McpServer({ name: 'pan', version: '2.1.0' }, { instructions: PAN_MCP_INSTRUCTIONS });
registerPanTools(server, { panBaseUrl: PAN });

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[PAN MCP] stdio server started, PAN at ${PAN}`);
