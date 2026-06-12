#!/usr/bin/env node

// Paean Records — Quality Log MCP server (stdio transport, for Claude CLI).
//
// Tool definitions live in mcp/quality-log-tools.js so they can be reused by
// the HTTP transport (routes/mcp-quality-log.js) without drift.
//
// For the Claude desktop app / Claude in Chrome / Claude.ai / Cowork, use the
// HTTP transport instead: paste http://127.0.0.1:7777/mcp/quality-log into
// the "Add custom connector → Remote MCP server URL" dialog.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerQualityLogTools } from './mcp/quality-log-tools.js';

const PAN = process.env.PAN_BASE_URL || 'http://127.0.0.1:7777';

const server = new McpServer({ name: 'quality-log', version: '0.1.0' });
registerQualityLogTools(server, { panBaseUrl: PAN });

const transport = new StdioServerTransport();
await server.connect(transport);
