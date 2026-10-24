#!/usr/bin/env node
/**
 * pan-claude-export-import — pull claude.ai web/desktop threads into PAN.
 *
 * WHY THIS IS SEPARATE FROM pan-transcript-sync
 * Claude Code writes a .jsonl transcript to local disk, so those sessions can be
 * reconciled any time. claude.ai threads cannot: hooks are a Claude Code feature
 * and never fire for them, and the desktop app's local cache is not an archive.
 * Checked on 2026-09-22 — the Mint IndexedDB store holds MCP tool-registry
 * entries and UI state; "chat_messages" appears twice in 3MB. The conversations
 * live server-side. So the only complete source is the account data export.
 *
 * HOW TO GET THE FILE (only he can do this — it is tied to the account)
 *   claude.ai -> Settings -> Privacy -> Export data. A link is emailed, the zip
 *   contains conversations.json.
 *
 *   node pan-claude-export-import.mjs conversations.json --dry-run
 *   node pan-claude-export-import.mjs conversations.json
 *
 * Idempotent, and shares the hub's content dedupe with the transcript sync, so
 * re-importing a newer export only adds what is new.
 */
import { readFileSync } from 'fs';

const argv = process.argv.slice(2);
const FILE = argv.find((a) => !a.startsWith('--'));
const DRY = argv.includes('--dry-run');
const hubArg = argv.indexOf('--hub');
const HUB = (hubArg >= 0 && argv[hubArg + 1] ? argv[hubArg + 1]
  : process.env.PAN_HUB || 'http://minipc-pan-hub:7777').replace(/\/$/, '');

if (!FILE) {
  console.error('usage: node pan-claude-export-import.mjs <conversations.json> [--dry-run] [--hub URL]');
  process.exit(1);
}

const MAX_TEXT = 6000;

/** The export nests text under content[] blocks on newer exports, flat on older. */
function messageText(m) {
  if (Array.isArray(m?.content)) {
    const t = m.content.filter((b) => b?.type === 'text' && b.text).map((b) => b.text).join('\n');
    if (t.trim()) return t;
  }
  return typeof m?.text === 'string' ? m.text : '';
}

async function post(path, body) {
  const r = await fetch(HUB + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });
  const txt = await r.text();
  let j;
  try { j = JSON.parse(txt); } catch { throw new Error(`${r.status} ${txt.slice(0, 200)}`); }
  if (!r.ok || j.ok === false) throw new Error(j.error || `${r.status}`);
  return j;
}

(async () => {
  const raw = JSON.parse(readFileSync(FILE, 'utf8'));
  const convos = Array.isArray(raw) ? raw : (raw.conversations || []);
  console.log(`hub     ${HUB}`);
  console.log(`file    ${FILE}`);
  console.log(`threads ${convos.length}`);

  let sent = 0, written = 0, skipped = 0, failed = 0, empty = 0;

  for (const c of convos) {
    const id = c?.uuid || c?.id;
    const msgs = c?.chat_messages || c?.messages || [];
    if (!id || !msgs.length) { empty++; continue; }

    const entries = [];
    for (const m of msgs) {
      const text = messageText(m).trim();
      if (!text) continue;                           // attachments-only turn
      const role = (m.sender || m.role) === 'human' ? 'user'
        : (m.sender || m.role) === 'user' ? 'user' : 'assistant';
      const ts = m.created_at || c.created_at;
      if (!ts) continue;
      entries.push({
        // Stable per message, so re-importing a later export is a no-op.
        uuid: m.uuid || m.id || `${id}:${entries.length}`,
        ts: new Date(ts).toISOString(),
        role,
        text: text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) + '\n[truncated]' : text,
      });
    }
    if (!entries.length) { empty++; continue; }

    // A claude.ai thread has no working directory. Tagging it plainly beats
    // inventing a path that detectProject would then mis-file under a repo.
    const body = {
      session_id: `claude-ai:${id}`,
      cwd: '',
      transcript_path: `claude.ai/chat/${id}`,
      model: c.model || null,
      entries,
    };

    sent += entries.length;
    if (DRY) continue;
    for (let i = 0; i < entries.length; i += 1000) {
      try {
        const j = await post('/hooks/internal/transcript-sync', { ...body, entries: entries.slice(i, i + 1000) });
        written += j.written; skipped += j.skipped;
      } catch (err) {
        failed++;
        console.error(`  FAIL ${String(c.name || id).slice(0, 40)}: ${err.message}`);
      }
    }
  }

  console.log(`\n${DRY ? 'WOULD IMPORT' : 'IMPORTED'} ${sent} messages from ${convos.length - empty} threads` +
    `${empty ? ` (${empty} empty/unparseable skipped)` : ''}`);
  if (!DRY) console.log(`written ${written}  skipped(dupe) ${skipped}  failed batches ${failed}`);
})().catch((e) => { console.error('import failed:', e.message); process.exit(1); });
