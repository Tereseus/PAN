// Mid-turn assistant text: the pure parts, shared by the Stop command hook that
// reads the transcript (capture-mid-turn.js, runs on the machine that ran Claude)
// and the hub route that stores it (POST /hooks/internal/turn-text).
//
// Why (2026-11-21): the live hooks store each prompt and only the LAST assistant
// message of a turn (Stop.last_assistant_message). Text written between tool calls
// never reached the hub, and that is often where the outcome is: "The KVM is
// unbound, but it isn't fully local yet" was such a line, and pan_search could not
// find it. Only text blocks are kept: never tool inputs, tool output or thinking.

export const LIMITS = Object.freeze({
  minChars: 20,     // shorter blocks are "Let me check." filler
  maxBlock: 800,    // per block
  maxTotal: 2000,   // per turn; also the FTS index's per-row cap (db.js indexEventFTS)
  maxBlocks: 12,
});

export function normText(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function isRealPrompt(e) {
  if (e.type !== 'user' || e.isMeta || e.isSidechain) return false;
  const c = e.message?.content;
  if (typeof c === 'string') return c.trim().length > 0;
  return Array.isArray(c) && c.some((b) => b?.type === 'text' && String(b.text || '').trim());
}

/**
 * Assistant text blocks of the CURRENT turn (after the last real user prompt),
 * except the final message, which the Stop event already stores.
 *
 * lines: transcript JSONL lines (strings) or parsed entries; a tail of the file is
 * fine. lastAssistantMessage: Stop's last_assistant_message when known. Blocks
 * contained in it are the final message and are dropped. Without it, the blocks of
 * the last assistant message that has text are dropped instead.
 * Returns [{ uuid, text }] in transcript order, unfiltered by size (see capBlocks).
 */
export function midTurnBlocks(lines, { lastAssistantMessage = null } = {}) {
  const entries = [];
  for (const line of lines || []) {
    let e = line;
    if (typeof line === 'string') {
      if (!line.trim()) continue;
      try { e = JSON.parse(line); } catch { continue; }
    }
    if (e && typeof e === 'object') entries.push(e);
  }

  let start = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (isRealPrompt(entries[i])) { start = i + 1; break; }
  }

  const blocks = [];
  for (let i = start; i < entries.length; i++) {
    const e = entries[i];
    if (e.type !== 'assistant' || e.isSidechain || e.isApiErrorMessage) continue;
    const content = e.message?.content;
    if (!Array.isArray(content)) continue;
    const text = content
      .filter((b) => b?.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text).join('\n').trim();
    if (!text) continue;
    blocks.push({ uuid: e.uuid || null, messageId: e.message?.id || null, text });
  }
  if (!blocks.length) return [];

  let keep;
  const last = normText(lastAssistantMessage);
  if (last) {
    keep = blocks.filter((b) => !last.includes(normText(b.text)));
  } else {
    const finalId = blocks[blocks.length - 1].messageId;
    keep = finalId
      ? blocks.filter((b) => b.messageId !== finalId)
      : blocks.slice(0, -1);
  }
  return keep.map(({ uuid, text }) => ({ uuid, text }));
}

/**
 * Size caps, applied on both sides (the hub does not trust the client). Drops
 * short blocks, cuts long ones, and when the turn is over maxTotal keeps the LATEST
 * blocks: those sit closest to the outcome. Returns [{ uuid, text }].
 */
export function capBlocks(blocks, limits = LIMITS) {
  const L = { ...LIMITS, ...limits };
  const sized = [];
  for (const b of blocks || []) {
    let t = String(b?.text || '').trim();
    if (t.length < L.minChars) continue;
    if (t.length > L.maxBlock) t = t.slice(0, L.maxBlock - 1).trimEnd() + '…';
    sized.push({ uuid: b?.uuid ? String(b.uuid).slice(0, 64) : null, text: t });
  }
  const out = [];
  let total = 0;
  for (let i = sized.length - 1; i >= 0 && out.length < L.maxBlocks; i--) {
    const add = sized[i].text.length + (out.length ? 2 : 0);
    if (total + add > L.maxTotal) break;
    total += add;
    out.unshift(sized[i]);
  }
  return out;
}

/**
 * Drop blocks the hub already holds for this session: same transcript uuid, or
 * the same text as a recent Stop reply (when a Stop hook makes Claude continue,
 * the next Stop sees the earlier final message as mid-turn text).
 * recent: [{ event_type, data }] rows, data as a JSON string.
 */
export function dropSeenBlocks(blocks, recent = []) {
  const uuids = new Set();
  const texts = new Set();
  for (const r of recent) {
    let d;
    try { d = JSON.parse(r.data); } catch { continue; }
    for (const u of d?.transcript_uuids || []) uuids.add(u);
    if (d?.transcript_uuid) uuids.add(d.transcript_uuid);
    if (d?.last_assistant_message) texts.add(normText(d.last_assistant_message));
  }
  return (blocks || []).filter((b) => !(b.uuid && uuids.has(b.uuid)) && !texts.has(normText(b.text)));
}

/** The stored row's data for one turn: joined text for FTS and the embeddings. */
export function turnTextData(blocks, cwd = '') {
  return {
    text: blocks.map((b) => b.text).join('\n\n'),
    count: blocks.length,
    transcript_uuids: blocks.map((b) => b.uuid).filter(Boolean),
    cwd,
  };
}
