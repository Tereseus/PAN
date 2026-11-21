#!/usr/bin/env node
/**
 * capture-mid-turn.js — Stop command hook: send this turn's mid-turn assistant
 * text to PAN, so outcomes written between tool calls become searchable.
 *
 * The live Stop hook is an `http` hook that posts the payload to PAN; it carries
 * only last_assistant_message. The transcript holding the rest is on THIS machine
 * (the hub cannot read it), so this runs here, beside it, in ~/.claude/settings.json:
 *
 *   "Stop": [{ "hooks": [ ...,
 *     { "type": "command", "command": "node <repo>/service/src/hooks/capture-mid-turn.js", "timeout": 10 } ] }]
 *
 * Reads the hook payload on stdin, the transcript's tail (never the whole file),
 * keeps only assistant text blocks of the current turn except the final message
 * (see mid-turn-text.js), and POSTs them to /hooks/internal/turn-text. Where PAN
 * is: PAN_BASE_URL, else this computer's PAN Link (127.0.0.1:7779) when paired,
 * else 127.0.0.1:7777 (mcp/pan-address.js).
 *
 * Always exits 0 and prints nothing: it must never block or alter the Stop chain.
 */
import { openSync, readSync, fstatSync, closeSync } from 'fs';
import { midTurnBlocks, capBlocks } from './mid-turn-text.js';
import { panBaseUrl } from '../mcp/pan-address.js';

const TAIL_BYTES = 4 * 1024 * 1024;

function readTail(path, bytes = TAIL_BYTES) {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString('utf8').split('\n');
    if (len < size) lines.shift();   // the first line is cut in half
    return lines;
  } finally {
    closeSync(fd);
  }
}

function readStdin() {
  return new Promise((resolve) => {
    let s = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => { s += d; });
    process.stdin.on('end', () => resolve(s));
    process.stdin.on('error', () => resolve(s));
  });
}

async function main() {
  const payload = JSON.parse((await readStdin()) || '{}');
  const { session_id: sessionId, transcript_path: tp, cwd = '' } = payload;
  if (!sessionId || !tp) return;
  const blocks = capBlocks(midTurnBlocks(readTail(tp), { lastAssistantMessage: payload.last_assistant_message }));
  if (!blocks.length) return;
  await fetch(`${panBaseUrl()}/hooks/internal/turn-text`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: sessionId, cwd, transcript_path: tp, blocks }),
    signal: AbortSignal.timeout(5000),
  });
}

main().catch(() => {}).finally(() => process.exit(0));
