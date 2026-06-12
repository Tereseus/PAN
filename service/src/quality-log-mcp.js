#!/usr/bin/env node

// Paean Records — Quality Log MCP server.
//
// Logs and scores creative attempts (songs first; later game art + mechanics)
// using the multi-criteria decision analysis math from
// `%USERPROFILE%\Desktop\Me stuff\Paean\song-creation-mathematics.md`.
//
// Transport: stdio. Claude Code spawns this as a child process (see .mcp.json).
//
// Persistence: the existing PAN SQLCipher-encrypted database, accessed via
// the running PAN server's HTTP API at /api/v1/quality-log/* — same pattern
// as the main `pan` MCP server. Math is implemented in routes/quality-log.js
// so it lives in exactly one place.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const PAN = process.env.PAN_BASE_URL || 'http://127.0.0.1:7777';

async function panFetch(path, { method = 'GET', body } = {}) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${PAN}${path}`, opts);
  if (!res.ok) throw new Error(`PAN ${res.status}: ${await res.text()}`);
  return res.json();
}

function ok(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

function err(e) {
  const msg = e.cause?.code === 'ECONNREFUSED'
    ? 'PAN server not running (127.0.0.1:7777 refused) — start PAN before logging quality.'
    : `quality-log error: ${e.message}`;
  return { content: [{ type: 'text', text: msg }], isError: true };
}

const server = new McpServer({ name: 'quality-log', version: '0.1.0' });

// ───────────────────── compute_q ─────────────────────
// Pure preview — no row inserted. Lets the user see the three scores before
// committing the attempt. See `song-creation-mathematics.md` section 2.
server.tool(
  'compute_q',
  'Score ratings without logging. Returns { q_avg, q_geo, q_min }. q_avg = weighted average; q_geo = Cobb-Douglas (collapses if any dim is low); q_min = weakest link. Defaults to equal weights when none supplied.',
  {
    ratings: z.record(z.string(), z.number())
      .describe('Per-dimension ratings, 1..10. e.g. {beat:8,flow:7,voices:9,adlibs:6,lyrics:8}'),
    weights: z.record(z.string(), z.number()).optional()
      .describe('Per-dimension weights (non-negative). Defaults to equal weights across the rated dimensions.'),
  },
  async ({ ratings, weights }) => {
    try {
      return ok(await panFetch('/api/v1/quality-log/compute', {
        method: 'POST',
        body: { ratings, weights },
      }));
    } catch (e) { return err(e); }
  },
);

// ───────────────────── log_attempt ─────────────────────
// Insert one row + return it with q_avg, q_geo, q_min computed.
server.tool(
  'log_attempt',
  'Log one creative attempt (song/art/mechanic) with ratings + weights, computes q_avg, q_geo, q_min on insert, returns the row. Use after listening to a take and rating its dimensions.',
  {
    domain:      z.string().describe('"song" | "art" | "mechanic" (extensible).'),
    genre:       z.string().optional().describe('e.g. "jazz", "afrobeat", "rap" — drives later per-genre learning curves.'),
    round_id:    z.string().describe('Groups iterations toward one keeper. Reuse this id for every attempt in the same round; start a fresh id when you commit to a seed and move on.'),
    iteration_n: z.number().int().describe('Attempt number within the round, starting at 1.'),
    ratings:     z.record(z.string(), z.number()).describe('Per-dimension ratings 1..10 (beat, flow, voices, adlibs, lyrics, …).'),
    weights:     z.record(z.string(), z.number()).optional().describe('Per-dimension weights. Defaults to equal across rated dimensions.'),
    kept:        z.boolean().optional().describe('Mark true when this attempt becomes the seed for the next round.'),
    seed_of:     z.string().optional().describe('id of the attempt this one was built from (links iteration lineage).'),
    notes:       z.string().optional().describe('Free-text — what changed, what to chase next.'),
  },
  async (args) => {
    try {
      return ok(await panFetch('/api/v1/quality-log/attempts', {
        method: 'POST', body: args,
      }));
    } catch (e) { return err(e); }
  },
);

// ───────────────────── get_round ─────────────────────
// All attempts in the round + running best (max q_geo) + threshold gate.
server.tool(
  'get_round',
  'Return every attempt in a round, the running best (highest q_geo), and whether the threshold has been crossed. Default threshold 8.5 from song-creation-mathematics.md section 4.',
  {
    round_id:  z.string().describe('The round to inspect.'),
    threshold: z.number().optional().describe('Quality gate. Defaults to 8.5.'),
  },
  async ({ round_id, threshold }) => {
    try {
      const qs = threshold != null ? `?threshold=${threshold}` : '';
      return ok(await panFetch(
        `/api/v1/quality-log/rounds/${encodeURIComponent(round_id)}${qs}`,
      ));
    } catch (e) { return err(e); }
  },
);

// ───────────────────── best_seed ─────────────────────
// Highest-scoring attempt to start the next round from. Prefers attempts
// flagged kept=true, falls back to global max q_geo.
server.tool(
  'best_seed',
  'Return the highest-scoring attempt to use as a seed for the next round. With round_id: best within that round (kept=true takes priority). Without round_id: best across all logged attempts.',
  {
    round_id: z.string().optional()
      .describe('Limit to one round. Omit to search the full history.'),
  },
  async ({ round_id }) => {
    try {
      const qs = round_id ? `?round_id=${encodeURIComponent(round_id)}` : '';
      return ok(await panFetch(`/api/v1/quality-log/best-seed${qs}`));
    } catch (e) { return err(e); }
  },
);

// ───────────────────── get_history ─────────────────────
server.tool(
  'get_history',
  'Recent quality-log entries, newest first. Optional filters by domain and genre. Use this to recall earlier attempts as reference material when iterating on something new.',
  {
    domain: z.string().optional().describe('Filter to one domain: "song" | "art" | "mechanic".'),
    genre:  z.string().optional().describe('Filter to one genre.'),
    limit:  z.number().int().optional().describe('Default 50, max 500.'),
  },
  async ({ domain, genre, limit }) => {
    try {
      const params = new URLSearchParams();
      if (domain) params.set('domain', domain);
      if (genre)  params.set('genre',  genre);
      if (limit)  params.set('limit',  String(limit));
      const qs = params.toString();
      return ok(await panFetch(
        `/api/v1/quality-log/history${qs ? '?' + qs : ''}`,
      ));
    } catch (e) { return err(e); }
  },
);

// ───────────────────── fit_weights (stub) ─────────────────────
// Where the advanced math eventually lives — regression of kept/q_geo on
// per-dimension ratings to learn weights from history rather than guess them.
// Section 7 of song-creation-mathematics.md. Returns insufficient_data until
// >= 30 rows are logged for that domain+genre.
server.tool(
  'fit_weights',
  'STUB. Will eventually learn weights from history via least-squares regression on kept/q_geo. Currently returns "insufficient_data" until >= 30 rows are logged for the domain/genre.',
  {
    domain: z.string().describe('"song" | "art" | "mechanic".'),
    genre:  z.string().optional().describe('Restrict the fit to one genre.'),
  },
  async ({ domain, genre }) => {
    try {
      return ok(await panFetch('/api/v1/quality-log/fit-weights', {
        method: 'POST', body: { domain, genre },
      }));
    } catch (e) { return err(e); }
  },
);

// ──────────────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);
