// where.js — which device he is using right now: the car, a computer, or the phone (Nov 26).
//
// Until now Intuition's "where" only knew the phone: it said "Mobile" forever after the first voice
// turn, never "at the computer" and never "in the car" (review, Nov 26). The signals were already
// coming in and nobody read them:
//   - every PC client posts a presence row every 30 s (/api/v1/client/presence), now with idle_s,
//     the seconds since its last keyboard or mouse input. A window title alone is not presence: a
//     PC left on says "coding" all day.
//   - every answered voice turn upserts the phone's row (routes/api.js), now with in_car (the app's
//     car mode: a car's Bluetooth, or the device is a car unit) and speed_kmh from the phone's GPS.
// The newest real sign of him wins. A row that only says a machine is on counts for nothing.
//
// Pure: the rows go in, a small answer comes out, so it is tested without a database
// (__tests__/where.test.js).

export const PC_ACTIVE_MS = 2 * 60_000;      // input this recent = he is at that computer
export const ROW_FRESH_MS = 90_000;          // a PC row older than this: the client is off or asleep
export const CAR_MS = 10 * 60_000;           // a car sign keeps him "in the car" this long
export const DRIVING_KMH = 20;               // steady GPS speed above this = in a vehicle
export const PHONE_MS = 30 * 60_000;         // the phone's place is trusted this long after a turn

const PCS = new Set(['win32', 'windows', 'linux', 'darwin', 'macos']);

/**
 * rows: device_presence rows { device_id, activity, screen_title, platform, as_of, idle_s, in_car, speed_kmh }
 * voice: { at, place } of his newest answered voice turn, or null
 * names: optional { device_id: 'friendly name' }
 * Returns { kind: 'car'|'computer'|'phone'|null, device, since, label }.
 */
export function whereNow({ rows = [], voice = null, now = Date.now(), names = {} } = {}) {
  const cands = [];
  for (const r of rows) {
    if (!r || !r.device_id || !Number.isFinite(r.as_of)) continue;
    const age = now - r.as_of;
    const name = names[r.device_id] || r.device_id;
    if (r.in_car && age < CAR_MS) cands.push({ kind: 'car', device: name, at: r.as_of, rank: 3 });
    else if (Number(r.speed_kmh) >= DRIVING_KMH && age < CAR_MS) cands.push({ kind: 'car', device: name, at: r.as_of, rank: 3 });
    if (PCS.has(String(r.platform || '').toLowerCase()) && age < ROW_FRESH_MS && Number.isFinite(r.idle_s)) {
      const lastInput = r.as_of - r.idle_s * 1000;
      if (now - lastInput < PC_ACTIVE_MS) cands.push({ kind: 'computer', device: name, at: lastInput, rank: 2 });
    }
  }
  if (voice && Number.isFinite(voice.at) && now - voice.at < PHONE_MS) {
    cands.push({ kind: 'phone', device: 'phone', at: voice.at, rank: 1, place: voice.place || null });
  }
  if (!cands.length) {
    return voice ? { kind: 'phone', device: 'phone', since: voice.at, label: 'mobile' } : { kind: null, device: null, since: null, label: null };
  }
  // Newest sign first; within a minute of each other the stronger sign wins (a car beats the phone
  // in it, a computer he is typing on beats a phone turn said at the desk).
  cands.sort((a, b) => (Math.abs(a.at - b.at) < 60_000 ? b.rank - a.rank : b.at - a.at));
  const c = cands[0];
  const label = c.kind === 'car' ? 'in the car'
    : c.kind === 'computer' ? `at the computer (${c.device})`
    : (c.place || 'mobile');
  return { kind: c.kind, device: c.device, since: c.at, label };
}
