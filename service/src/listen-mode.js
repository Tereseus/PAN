// listen-mode.js — ΠAN's four listening modes (the owner, 2026-11-24).
//
//   normal  hears everything, speaks when it judges it is spoken to (as before)
//   listen  "Listen only": hears and keeps everything, works out who speaks, never speaks.
//           Out: the person's own release words ("you can talk"), or the button.
//   name    "Name only": answers only a line that starts with its name or the person's own word.
//           Out: "back to normal", or the button.
//   mute    the mic is off on the device. Out: ONLY the button (nothing is heard to get out by).
//   forget  "Don't remember": hears and talks as in normal, but nothing from that stretch is kept.
//           routes/api.js runs such a turn inside the hub's no-trace context (bench-context.js,
//           the check every writer already makes) and skips the voice turn record, the turn book
//           and voice learning; the device keeps nothing either. Out: the button, the person's own
//           words ("remember again" always works), or 60 minutes (the device's time limit, the
//           same as the hub's incognito default).
//
// The device holds the mode and sends it with every turn (listen_mode), with the person's own
// words (mode_words: { name: [...], release: [...] }, any language). A device too old to send it
// is in normal mode. The hub checks the line here first, the same way mute-ask.js does: a command
// is a whole sentence, never a word inside one, so "I like to just listen to music" changes nothing.
//
// What the hub does with the answer is in router.js routeStream (top). The last mode each device
// reported is kept here (modeOf) so other things (the Medallion's firmware, through the phone or
// GET /api/v1/listen-mode) can read it.
//
// Not done here: the voice model learning these commands in every language, like [MUTE]. Until
// the next voice round, other languages get out of a mode with the person's own words or the button.

import { asksToMute } from './mute-ask.js';

export const MODES = ['normal', 'listen', 'name', 'mute', 'forget'];

const NAME = /(?:pan|pam|pann|πan|παν)/.source;
const LEAD = /^(?:(?:uh+|um+|hey|ok|okay|oh|so|alright|now|just|and),?\s+)*/.source;
const POLITE = /(?:(?:can|could|would|will) you\s+)?(?:please\s+)?(?:just\s+)?/.source;
const TAIL = `(?:\\s+(?:please|now|for (?:a (?:bit|minute|moment|second|while)|now)))*(?:,?\\s+${NAME})?$`;

function cmd(body) {
  return new RegExp(`${LEAD}(?:${NAME},?\\s+)?${POLITE}(?:${body})${TAIL}`, 'i');
}

// Into Listen only.
const TO_LISTEN = cmd([
  /(?:only|just) listen(?: only)?/.source,
  /listen(?:-| )only(?: mode)?/.source,
  /(?:go|switch|get) (?:in)?to listen(?:ing)?(?:-| )?(?:only )?mode/.source,
  /listening mode/.source,
  /(?:stay|be) quiet and (?:just )?listen/.source,
  /keep listening but (?:don't|do not) (?:talk|speak|say anything)/.source,
  /(?:don't|do not) (?:talk|speak),? just listen/.source,
].join('|'));

// Into Name only.
const TO_NAME = cmd([
  /only (?:answer|respond|talk|reply)(?: to me)? (?:to|when (?:i|you hear me) (?:say|call|use)) (?:your|my) name/.source,
  /only (?:answer|respond|talk|reply) (?:to|when you hear) your name/.source,
  /only (?:talk|answer|respond) when (?:i )?call(?:ed)? (?:you|on you)/.source,
  /name(?:-| )only(?: mode)?/.source,
  /(?:go|switch|get) (?:in)?to name(?:-| )?(?:only )?mode/.source,
].join('|'));

// Into Don't remember.
const TO_FORGET = cmd([
  /(?:don't|do not) remember (?:this|any of this|anything|what (?:i|we) say)(?: (?:conversation|part))?/.source,
  /(?:go|switch|get) (?:in)?to (?:incognito|don't remember)(?: mode)?/.source,
  /(?:go )?incognito(?: mode)?/.source,
  /(?:this is |let's go |go )?off the record/.source,
  /(?:don't|do not) (?:save|keep|record) (?:this|any of this|anything)/.source,
].join('|'));

// Out of Don't remember (only there: "remember again" in Listen only changes nothing).
const TO_REMEMBER = cmd([
  /(?:you can |ok(?:ay)? you can )?(?:remember|start remembering|keep remembering)(?: again| now)?/.source,
  /(?:back )?on the record/.source,
  /stop (?:being )?incognito/.source,
].join('|'));

// Back to Normal (from Listen only these are the default release words too).
const TO_NORMAL = cmd([
  /back to normal(?: mode)?/.source,
  /normal mode/.source,
  /(?:you can|ok(?:ay)? you can|go ahead and) (?:talk|speak)(?: again| now| to me)?/.source,
  /talk (?:to me )?again/.source,
  /(?:start|you can start) talking(?: again)?/.source,
  /talk normally/.source,
].join('|'));

const sentencesOf = (text) => String(text || '').replace(/’/g, "'").split(/[.!?。！？]+/).map((s) => s.trim()).filter(Boolean);
const fold = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();

/** The person's own words, cleaned: at most 12 of each, each 1 to 60 characters. */
export function cleanWords(words) {
  const list = (a) => (Array.isArray(a) ? a : []).map((w) => String(w || '').trim()).filter((w) => w && w.length <= 60).slice(0, 12);
  return { name: list(words?.name), release: list(words?.release), remember: list(words?.remember) };
}

/** Does the line start with one of these words (whole words, accents and case ignored)? Returns the rest. */
export function startsWithAny(text, words) {
  const line = fold(text);
  for (const w of words) {
    const f = fold(w);
    if (!f) continue;
    if (line === f) return '';
    if (line.startsWith(`${f} `)) return String(text).trim().split(/\s+/).slice(f.split(' ').length).join(' ').replace(/^[,.:;!?\s]+/, '');
  }
  return null;
}

/** Which mode a line asks for, if it is a mode command: 'listen', 'name', 'normal', 'mute' or null. */
export function modeAsked(text) {
  if (asksToMute(text)) return 'mute';
  const s = sentencesOf(text);
  if (!s.length || s.length > 3 || String(text).trim().split(/\s+/).length > 16) return null;
  for (const one of [s[0], s[s.length - 1]]) {
    if (TO_FORGET.test(one)) return 'forget';
    if (TO_LISTEN.test(one)) return 'listen';
    if (TO_NAME.test(one)) return 'name';
    if (TO_NORMAL.test(one)) return 'normal';
  }
  return null;
}

const DEFAULT_NAME = ['pan', 'hey pan', 'ok pan', 'pam', 'pann', 'ΠAN', 'Παν'];

/**
 * What the mode does to this line.
 *   { set: mode, rest }  a mode command; rest = what follows a release word, to answer as well
 *   { quiet: reason }    say nothing (the line is still kept, and voice ID still runs)
 *   { named: true }      Name only, and the line starts with the name: answer it as addressed
 *   null                 normal: nothing changes
 */
export function modeTurn(text, mode = 'normal', words = {}) {
  const own = cleanWords(words);
  const m = MODES.includes(mode) ? mode : 'normal';
  // Don't remember ends only with the button (owner, 2026-11-25). "Remember again", his own words,
  // and "just listen", "name only" or "back to normal" all used to leave it by voice, and Listen
  // only keeps everything: one misheard line started saving again. Only Mute is let through, since
  // it turns the mic off; the mode is still Don't remember when the button turns the mic back on.
  if (m === 'forget') return modeAsked(text) === 'mute' ? { set: 'mute', rest: '' } : null;
  // The mic is off in mute; a line that still arrives (a call opened the mic) gets nothing.
  if (m === 'mute') return { quiet: 'mute_mode' };
  const asked = modeAsked(text);
  if (asked && asked !== m) return { set: asked, rest: '' };
  if (m === 'listen') {
    const rest = startsWithAny(text, own.release);
    if (rest !== null) return { set: 'normal', rest };
    return { quiet: 'listen_mode' };
  }
  if (m === 'name') {
    const rest = startsWithAny(text, [...own.name, ...DEFAULT_NAME]);
    if (rest !== null) return { named: true };
    return { quiet: 'name_mode' };
  }
  return null;
}

/** What ΠAN says when a mode changes. Short, so a wrong guess costs little. */
export function modeAck(mode, from = 'normal') {
  if (mode === 'normal' && from === 'forget') return "Okay, I'm remembering again.";
  return { listen: 'Okay, just listening.', name: 'Okay, only when you say my name.', normal: "I'm back.", mute: '',
    forget: "Okay, I won't remember any of this." }[mode] ?? '';
}

// The last mode each device reported (per turn, or POST /api/v1/listen-mode).
const lastMode = new Map();
export function noteMode(deviceId, mode) {
  if (!deviceId || !MODES.includes(mode)) return;
  lastMode.set(String(deviceId), { mode, at: Date.now() });
}
export function modeOf(deviceId) { return lastMode.get(String(deviceId)) || null; }
export function allModes() { return Object.fromEntries(lastMode); }
