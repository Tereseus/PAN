// looks.js — where a thing PAN described came from: said with the answer, kept for the follow-ups.
//
// 2026-11-08, on the phone: "What am I looking at?" got "You're looking at MovieWriter. It looks
// like you've got a frame from the movie." No camera took anything. The hub's words matched no
// camera phrase then, so the voice model answered from the situation line, which held his
// desktop's window title ("MovieWriter: Frame 455 ..."). He thought a camera was used. "Did you use
// the front-facing camera or the back camera?" got "I didn't. I'm just reading your voice", and
// "how did you know about MovieWriter?" got "I don't have any record of that": those turns had
// no situation line and nothing said where the first answer came from.
//
// So: an answer from a picture opens with its source ("From your pendant camera a few seconds
// ago: ..."), the source and what was seen are kept in the conversation state (noteLook,
// conv-state-watcher.js), and a question about the source ("which camera did you use?", "how
// did you know about MovieWriter?") is answered by code from that record (sourceAnswer). An
// answer read off a window title is recorded the same way (screenLookFrom, routes/api.js
// recordVoiceTurn), so "how did you know" names the window instead of denying it.

import { normalizeHeard } from './camera-ask.js';
import { historyLines } from './intuition/conversation.js';

// The camera behind each source. The phone's own camera is always the back one
// (android/.../camera/CameraCapture.kt binds DEFAULT_BACK_CAMERA); the pendant is the XIAO
// ESP32-S3 Sense over Bluetooth (PendantBle.kt), one 320x240 frame about every 5 s.
const CAMERA_NAMES = {
  pendant: 'your pendant camera',
  phone_back: "your phone's back camera",
  phone_front: "your phone's front camera",
};

/** The spoken name of a look's source: "your pendant camera", "your desktop's window title". */
export function sourceName(look) {
  if (!look) return '';
  if (look.source === 'screen') return `your ${look.device || 'computer'}'s window title`;
  return CAMERA_NAMES[look.source] || 'a camera';
}

function ago(ms) {
  if (!Number.isFinite(ms) || ms < 20_000) return 'a few seconds ago';
  if (ms < 90_000) return `${Math.round(ms / 10_000) * 10} seconds ago`;
  const min = Math.round(ms / 60_000);
  return min === 1 ? 'a minute ago' : `${min} minutes ago`;
}

const ALREADY_SOURCED = /^from your (?:pendant camera|phone'?s (?:back|front) camera)\b/i;

/** The answer with its source in front: "From your pendant camera a few seconds ago: ...".
 *  frameAgeMs is how old the picture was when he asked (the pendant's frame is not taken on
 *  the spot); the phone's photo is taken for the question, so it needs no age. */
export function withSource(said, source, frameAgeMs = 0) {
  const text = String(said || '').trim();
  if (!text || ALREADY_SOURCED.test(text) || !CAMERA_NAMES[source]) return text;
  const name = CAMERA_NAMES[source];
  const head = source === 'pendant' ? `From ${name} ${ago(frameAgeMs)}` : `From ${name}`;
  return `${head[0].toUpperCase()}${head.slice(1)}: ${text}`;
}

// A look named in PAN's own words in the history: the source prefix above, kept by the phone
// ("PAN: From your pendant camera a few seconds ago: ..."). Covers a hub restart, when the
// conversation state is empty but the phone still has the talk.
const SOURCE_IN_HISTORY = /^from your (pendant camera|phone'?s back camera|phone'?s front camera)[^:]{0,40}:\s*(.*)$/i;
function lookFromHistory(history) {
  const lines = historyLines(history);
  for (let i = lines.length - 1; i >= 0 && i >= lines.length - 8; i--) {
    if (lines[i].his) continue;
    const m = lines[i].text.match(SOURCE_IN_HISTORY);
    if (m) {
      const kind = m[1].toLowerCase();
      return { source: kind.startsWith('pendant') ? 'pendant' : kind.includes('front') ? 'phone_front' : 'phone_back', said: m[2], at: null };
    }
  }
  return null;
}

// Asking which camera, or whether one was used: "did you use the front-facing camera or the
// backwards camera?", "which camera was that?", "did you take a picture?". "camer" and "crammer"
// are the phone recogniser's ("the front facing crammer or the backwards camer", 2026-11-08).
const CAMERA_Q = /\b(?:which|what) camera\b|\b(?:front|back|rear|selfie|backwards?)[- ]?(?:facing )?(?:camera|camer|crammer|cam|one)\b|\b(?:did|do|were|are|have) you (?:just )?(?:use|used|using|take|took|taking|turn on|open)\b[^.?!]{0,25}\b(?:camera|cameras|photo|picture|pic|pendant)\b|\bwhere did (?:that|the|this) (?:photo|picture|image) come from\b/;
// Asking how PAN knew: "how did you know about MovieWriter?", "where did you see that?".
const KNOW_Q = /\bhow (?:did|do|could|can|would) you (?:know|tell|see|find out|get that|figure)\b|\bwhere did you (?:see|get|read|find|hear) (?:that|it|this|about)\b|\bwhat (?:did|do|are) you (?:look(?:ing)?|see(?:ing)?) (?:at|with|through)\b|\bhow are you (?:seeing|looking|watching)\b/;
const FRONT = /\b(?:front|selfie)\b/;

/** True when the line asks where PAN's picture came from. */
export function asksAboutSource(text) {
  const t = normalizeHeard(text);
  return CAMERA_Q.test(t) || KNOW_Q.test(t);
}

// "how did you know about Movie Rider" -> "movie rider".
function askedThing(t) {
  const m = t.match(/\babout ([^.?!]+?)\s*[.?!]*$/) || t.match(/\b(?:know|see|get|read|find|hear) (?:that |it )?(?:was |is )?(?:a |an |the )?([^.?!]+?)\s*[.?!]*$/);
  const thing = m ? m[1].replace(/^(?:that|this|it|the|a|an)\s+/, '').trim() : '';
  return /^(?:that|this|it|so|then|now)?$/.test(thing) ? '' : thing;
}

const squash = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
function editDistance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cur = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
  }
  return row[b.length];
}
// Whether the thing he names is in a text, allowing what the recogniser does to a name
// ("Movie Rider" for "MovieWriter"): any run of the text's words, squashed, within a fifth.
function mentions(text, thing) {
  const want = squash(thing);
  if (want.length < 3) return false;
  const words = String(text || '').split(/[^\p{L}\p{N}']+/u).filter(Boolean);
  for (let i = 0; i < words.length; i++) {
    let run = '';
    for (let j = i; j < Math.min(words.length, i + 4); j++) {
      run += squash(words[j]);
      if (run.length > want.length + 4) break;
      if (editDistance(run, want) <= Math.floor(want.length / 5)) return true;
    }
  }
  return false;
}

function lookText(look) {
  return [look?.said, look?.description, look?.title].filter(Boolean).join(' ');
}

function cameraAnswer(look, t, now) {
  const name = sourceName(look);
  let head = `${name[0].toUpperCase()}${name.slice(1)}`;
  if (FRONT.test(t) && look.source !== 'phone_front') head += ', not the front one';
  if (look.source === 'pendant') {
    return `${head}. I used the last frame it sent before you asked${look.at ? `, ${ago(now - look.at)}` : ''}.`;
  }
  return `${head}. I took the photo${look.at ? ` ${ago(now - look.at)}` : ' when you asked'}.`;
}

function screenAnswer(look) {
  return `I didn't use a camera. I read it off ${sourceName(look)}, which says "${look.title}".`;
}

/**
 * The spoken answer to a question about where PAN's picture came from, or '' to leave the line
 * to the voice model.
 *   look      the conversation state's last look (conv-state-watcher.js lastLook), or null
 *   history   the turn's history block, read when there is no look (after a hub restart)
 *   screens   what his computers show now ([{ device, title }], router.js screenTitlesNow)
 */
export function sourceAnswer(text, { look = null, history = '', screens = [], now = Date.now() } = {}) {
  const t = normalizeHeard(text);
  const camQ = CAMERA_Q.test(t);
  const knowQ = KNOW_Q.test(t);
  if (!camQ && !knowQ) return '';
  const seen = look || lookFromHistory(history);
  const thing = askedThing(t);

  if (knowQ && !camQ) {
    // "How did you know about X": answer only when X is what the look was about, or on a
    // window he has up. Anything else (a thing from his notes, a lookup) is the model's.
    if (thing) {
      if (seen && mentions(lookText(seen), thing)) {
        return seen.source === 'screen' ? screenAnswer(seen) : `I saw it through ${sourceName(seen)}.`;
      }
      const win = screens.find((s) => mentions(s.title, thing));
      if (win) return screenAnswer({ source: 'screen', device: win.device, title: win.title });
      return '';
    }
    if (!seen) return '';
    return seen.source === 'screen' ? screenAnswer(seen) : `I saw it through ${sourceName(seen)}.`;
  }

  // Which camera, or whether one was used.
  if (!seen) return "I didn't use a camera just now.";
  if (seen.source === 'screen') return screenAnswer(seen);
  return cameraAnswer(seen, t, now);
}

// Words of a window title too common to say it was read from that window.
const PLAIN_WORDS = new Set(['frame', 'time', 'file', 'edit', 'view', 'window', 'new', 'tab', 'home', 'page', 'untitled', 'document', 'google', 'search', 'the', 'and', 'with']);

/** The window a reply was read from: his line asked what he is looking at or doing, and the reply
 *  names a word of a window title (four letters or more, not a common one). */
export function screenLookFrom(reply, screens = []) {
  const said = String(reply || '');
  if (!said) return null;
  for (const s of screens) {
    const words = String(s.title || '').split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 4 && !PLAIN_WORDS.has(w.toLowerCase()));
    const hit = words.find((w) => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(said));
    if (hit) return { source: 'screen', device: s.device, title: String(s.title).slice(0, 60), said: said.slice(0, 200) };
  }
  return null;
}

// What he asks when a window title can be the answer (router.js gives the situation line for
// these too): "what am I looking at", "what's on my screen", "what am I doing".
const SCREEN_ASK = /\bwhat am i (?:doing|working on|up to|looking at|seeing)\b|\bwhat(?:'s| is) on my (?:screen|desktop|computer|laptop|monitor)\b|\bcan you see (?:what|my)\b|\bwhat(?:'s| is) in front of me\b/;
export function asksWhatHeSees(text) {
  return SCREEN_ASK.test(normalizeHeard(text));
}
