// The brief: what a person in the room already knows when he starts talking, kept ready ahead of
// his words (docs/INTUITION-STATE.md section 11.2). The owner, 2026-11-23: the hub should keep the
// small voice model up to date in the background (the intuition, his notes, the situation, his
// threads) instead of it working out the moment each time, about 500 tokens of its 4,096.
//
// It is the situation line (router.js buildSituationLine: place, daylight, weather, screens, the
// camera, the talk's topic, other voices) with what that line lacks:
//   - his threads: what he sent each one in the last 3 hours, what came back, what still waits;
//   - the things in play: the notes on the shelf, with where each stands and what is next;
//   - the talk: its short summary and the topics before this one.
// Times are clock times, never "5 minutes ago", so the text stays the same from one minute to the
// next and the voice reader's read ahead of it still counts (voice-reader.js warmReader).
//
// Off for his own turns until the voice model is trained to read it (setting voice_brief:
// 'bench' = bench turns only, the default; 'on'; 'off').
import { all, get } from '../db.js';
import { onShelf } from './shelf.js';
import { getConversationState, overheardWithin } from '../conv-state-watcher.js';
import { hisTimeZone } from './time.js';
import { shortTitle, toSpeech } from '../thread-relay.js';

const THREADS_MS = 3 * 60 * 60_000;
const MAX_CHARS = 2000;   // about 500 tokens at 4 characters a token

const clip = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 3).replace(/\s+\S*$/, '') + '...' : t; };

function clock(ms) {
  try { return new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: hisTimeZone() }); }
  catch { return new Date(ms).toISOString().slice(11, 16); }
}

/** His threads in the last 3 hours, the newest ask to each: sent, answered, or still waiting. */
export function threadLines(now = Date.now(), max = 3) {
  let jobs = [];
  try {
    jobs = all(`SELECT title, text, status, reply, error, kind, created_at, replied_at FROM thread_relay_jobs
      WHERE asked_by IS NULL AND created_at > :since AND (source IS NULL OR source NOT LIKE '%bench%')
      ORDER BY created_at DESC LIMIT 30`, { ':since': now - THREADS_MS });
  } catch { return []; }
  const seen = new Set();
  const out = [];
  for (const j of jobs) {
    const name = shortTitle(j.title || 'a thread');
    if (seen.has(name)) continue;
    seen.add(name);
    const asked = j.kind === 'status' ? `asked ${name} what it is doing` : `sent ${name} "${clip(j.text, 70)}"`;
    if (j.status === 'replied') out.push(`${asked} at ${clock(j.created_at)}; it answered at ${clock(j.replied_at || j.created_at)}: ${clip(toSpeech(j.reply || '', 220).replace(/ The rest is in the thread\.$/, ''), 180)}`);
    else if (j.status === 'failed') out.push(`${asked} at ${clock(j.created_at)}; it failed`);
    else out.push(`${asked} at ${clock(j.created_at)}; no answer yet`);
    if (out.length >= max) break;
  }
  return out;
}

/** The talk so far: its summary and the topics before the current one. */
function talkLine(org) {
  const cs = getConversationState(org);
  if (!cs || cs.phase === 'idle') return '';
  const before = (cs.topics || []).map((t) => (typeof t === 'string' ? t : t?.topic)).filter((t) => t && t !== cs.topic).slice(-3);
  return [cs.summary ? clip(cs.summary, 180) : '', before.length ? `earlier: ${before.map((t) => clip(t, 40)).join(', ')}` : ''].filter(Boolean).join('; ');
}

/**
 * The brief for a turn. `situation` is the turn's situation line ("Situation (background only,
 * never read it out): ...") or ''. Returns { text, parts } where text keeps that opening, so the
 * models read it the way they read the line.
 */
export function buildBrief(situation, { org = 'org_personal', now = Date.now() } = {}) {
  const othersNearby = (() => { try { return overheardWithin(2 * 60_000, org) >= 2; } catch { return false; } })();
  const parts = {
    situation: String(situation || '').replace(/^Situation \(background only, never read it out\):\s*/, '').replace(/\.$/, ''),
    threads: threadLines(now),
    in_play: (() => { try { return onShelf({ othersNearby }); } catch { return []; } })(),
    talk: (() => { try { return talkLine(org); } catch { return ''; } })(),
  };
  const sections = [
    parts.situation && parts.situation,
    parts.threads.length && `His threads: ${parts.threads.join(' | ')}`,
    parts.in_play.length && `In play (his own notes): ${parts.in_play.join(' | ')}`,
    parts.talk && `The talk: ${parts.talk}`,
  ].filter(Boolean);
  if (!sections.length) return { text: '', parts };
  // Over the size, the last sections give way first: the place and the threads matter most.
  let body = sections.join('. ');
  while (body.length > MAX_CHARS && sections.length > 1) { sections.pop(); body = sections.join('. '); }
  if (body.length > MAX_CHARS) body = clip(body, MAX_CHARS);
  return { text: `Situation (background only, never read it out): ${body}.`, parts };
}

/** voice_brief: 'off', 'bench' (default: bench turns only) or 'on'. */
export function briefMode() {
  try {
    const v = String(get(`SELECT value FROM settings WHERE key = 'voice_brief'`)?.value || '').replace(/^"|"$/g, '').trim();
    return ['off', 'bench', 'on'].includes(v) ? v : 'bench';
  } catch { return 'bench'; }
}
