// His clock, as opposed to the hub's.
//
// His computers run on his job's time zone while he lives somewhere else, so the hub's clock
// says nothing about his day. Every time of day rule in Intuition read the hub's hour: "up at
// 2 to 6 AM, possible fatigue" fired in his morning, and "winding down" ran from his breakfast
// to his lunch (found 2026-11-03, the hub on New York time, him 7 hours ahead). Anything about his
// body or his day (awake, late, morning, a meal) goes by the zone he is in.
//
// Where the zone comes from, best first:
//   1. the zone the phone reported with its last turn (setPhoneTimeZone; the app does not send
//      one yet, it is on the list for the next build)
//   2. the `home_timezone` setting, an IANA name such as "Asia/Tokyo", set once per PAN
//   3. the hub's own zone
// The setting is data in his database, never in this file.

import { get } from '../db.js';

export function validTimeZone(tz) {
  if (!tz || typeof tz !== 'string') return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

export function hubTimeZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

// A phone zone stays good for a day: he does not change countries faster than that, and a
// stale one is still better than the hub's.
const PHONE_ZONE_TTL_MS = 24 * 60 * 60_000;
let _phone = { tz: null, at: 0 };
export function setPhoneTimeZone(tz) {
  if (validTimeZone(tz)) _phone = { tz, at: Date.now() };
}

let _setting = { tz: null, at: 0 };
function settingZone() {
  if (Date.now() - _setting.at < 60_000) return _setting.tz;
  let tz = null;
  try {
    const row = get("SELECT value FROM settings WHERE key = 'home_timezone'");
    if (row?.value) tz = String(row.value).replace(/^"|"$/g, '').trim();
  } catch {}
  _setting = { tz: validTimeZone(tz) ? tz : null, at: Date.now() };
  return _setting.tz;
}

/** { tz, source } for where he is: 'phone', 'setting' or 'hub'. */
export function hisZone() {
  if (_phone.tz && Date.now() - _phone.at < PHONE_ZONE_TTL_MS) return { tz: _phone.tz, source: 'phone' };
  const s = settingZone();
  if (s) return { tz: s, source: 'setting' };
  return { tz: hubTimeZone(), source: 'hub' };
}

export function hisTimeZone() { return hisZone().tz; }

/** His local hour, 0 to 23. */
export function localHour(ts = Date.now(), tz = hisTimeZone()) {
  try {
    const h = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' }).format(new Date(ts));
    const n = parseInt(h, 10);
    return Number.isFinite(n) ? n % 24 : new Date(ts).getHours();
  } catch { return new Date(ts).getHours(); }
}

/** Offset from UTC in hours for a zone at a moment, e.g. 9 for Tokyo. */
export function utcOffsetHours(ts = Date.now(), tz = hisTimeZone()) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric',
    }).formatToParts(new Date(ts));
    const v = Object.fromEntries(parts.map((p) => [p.type, p.value]));
    const asUtc = Date.UTC(+v.year, +v.month - 1, +v.day, +v.hour % 24, +v.minute);
    return Math.round((asUtc - Math.floor(ts / 60_000) * 60_000) / 36e5 * 2) / 2;
  } catch { return -new Date(ts).getTimezoneOffset() / 60; }
}
