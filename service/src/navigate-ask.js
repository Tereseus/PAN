// "Take me to <place>" starts Google Maps navigation on the device he is talking through (task 1106).
//
// Why: in the car on Nov 28 "Put a GPS to <place>" and "Take me to <place>" got "I can't do that"
// and "I don't have access to your car's GPS" four times. The app has had a navigate action that
// opens Google Maps navigation for months, but nothing on the hub's voice path ever sent it: the
// voice model answered the line itself, and the app's stream reader dropped the done event's
// actions anyway (fixed in app 0.5.68). This is a fast path like the thread relay: no model, the
// place is read straight off the line.
//
// Only an order at the start of a sentence counts ("take me to", "navigate to", "directions to",
// "drive me to", "put a GPS to", and "can you / please" before them), so "he took me to the
// market" or "they'll take me to the airport tomorrow" stay talk.

import { get } from './db.js';

// The first app build whose stream reader keeps the done event's actions.
export const NAVIGATE_MIN_CODE = 197;
export const NAVIGATE_MIN_NAME = '0.5.68';

const LEAD = String.raw`(?:(?:ok(?:ay)?|so|hey|hi|alright|all right|right|now|and|then|please|pan|ΠAN|πan)[,.!]?\s+)*`;
const ASK = String.raw`(?:(?:can|could|would|will) you\s+(?:please\s+)?|please\s+|let'?s\s+|i (?:want|need|'d like) (?:you )?to\s+)?`;
const VERB = String.raw`(?:take me|drive me|get me|bring me|route me|guide me|navigate(?: me)?|start (?:the )?navigation|give me directions|get (?:me )?directions|directions|put (?:a |the )?gps(?: on)?|set (?:a |the )?gps|gps)`;
const ORDER = new RegExp(String.raw`^${LEAD}${ASK}${VERB}\s+(?:to(?:wards)?|for)\s+(.+)$`, 'i');
const HOME = new RegExp(String.raw`^${LEAD}${ASK}(?:take me|drive me|get me|navigate(?: me)?)\s+home\b`, 'i');
// Said after the place: not part of it.
const TAIL = /\s*(?:,?\s*(?:please|now|right now|thanks|thank you|on (?:google )?maps|with (?:google )?maps|in (?:google )?maps|using (?:google )?maps))+\s*$/i;

/** The place he asked to be taken to, or null when the line is not an order to navigate. */
export function navigationAsk(text) {
  const sentences = String(text || '').split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
  for (const s of sentences) {
    const bare = s.replace(/[.!?]+$/, '').trim();
    if (HOME.test(bare)) return 'Home';
    const m = bare.match(ORDER);
    if (!m) continue;
    const place = m[1].replace(TAIL, '').replace(/^(?:the\s+)?(?:place|restaurant|shop|store)\s+called\s+/i, '').trim();
    // A place has a name: "take me to it" or "navigate to there" says nothing.
    if (!place || /^(?:it|there|that|this|them|here)$/i.test(place) || place.split(/\s+/).length > 8) return null;
    return place;
  }
  return null;
}

/** The app build on this device from its own start-up log line: { code, name } or null. */
export function appBuildOn(deviceId) {
  if (!deviceId) return null;
  try {
    const row = get("SELECT message FROM client_logs WHERE device_id = :d AND message LIKE 'Build: versionCode=%' ORDER BY id DESC LIMIT 1", { ':d': `phone-${deviceId}` });
    const code = Number(row?.message?.match(/versionCode=(\d+)/)?.[1]);
    const name = row?.message?.match(/versionName=(\S+)/)?.[1] || null;
    return Number.isFinite(code) && code > 0 ? { code, name } : null;
  } catch { return null; }
}

/**
 * The turn's result for a navigation order, or null when the line is not one or the device cannot
 * navigate (the dashboard, a PC). An app too old to act on it gets a plain reply that says so
 * instead of a promise nothing keeps.
 */
export function navigationTurn(text, context = {}) {
  if (context.source === 'dashboard' || !String(context.source || '').startsWith('phone')) return null;
  const place = navigationAsk(text);
  if (!place) return null;
  const bench = /-bench$/.test(String(context.device_id || ''));
  const build = bench ? null : appBuildOn(context.device_id);
  if (!bench && build && build.code < NAVIGATE_MIN_CODE) {
    return { intent: 'query', addressed: 1, importance: 0.4, reason: 'navigate_old_app',
      response: `I can start navigation once the ΠAN app on this device is updated to ${NAVIGATE_MIN_NAME}; it has ${build.name || 'an older build'}.` };
  }
  return {
    intent: 'navigate', addressed: 1, importance: 0.5, query: place,
    response: place === 'Home' ? 'Taking you home.' : `Navigating to ${place}.`,
    actions: [{ target: 'device', device_type: 'phone', type: 'navigate', args: { destination: place } }],
  };
}
