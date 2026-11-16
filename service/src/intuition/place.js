// Where he is and what the daylight is doing there: part of the live world (INTUITION-STATE.md
// v2, "Place" and "Time and light"), kept in memory and read on every voice turn.
//
// Why this exists (2026-11-10): asked "what time does the sun come up where I am" eight times,
// PAN answered "your GPS is off" every time, including on turns where the phone had sent its
// place. The voice model never saw the place, and nothing in PAN knew the daylight. A person
// in the room just knows it is dark and roughly when the sun comes up; so does the world now.
//
// - The phone's last GPS fix is kept here (memory first, the settings row `last_phone_place`
//   so a restart keeps it). A turn without GPS still knows the last place, with its age.
// - Sunrise and sunset are computed from that place and the date with the NOAA formula: no
//   network, no lookup, microseconds. Accurate to about a minute, which is what a person needs.
// Coordinates stay on the hub: the voice line carries the place name, never the numbers.

import { get, run } from '../db.js';

const KEY = 'last_phone_place';
const SAVE_EVERY_MS = 5 * 60_000;
let _last = null;          // { lat, lng, address, at }
let _loaded = false;
let _savedAt = 0;

function load() {
  if (_loaded) return;
  _loaded = true;
  try {
    const raw = get(`SELECT value FROM settings WHERE key = '${KEY}'`)?.value;
    const v = raw ? JSON.parse(raw) : null;
    if (v && typeof v.lat === 'number' && typeof v.lng === 'number') _last = v;
  } catch {}
}

/** Called with the phone's sensors on every turn that carries them. */
export function notePhoneGps(gps) {
  if (!gps || typeof gps.lat !== 'number' || typeof gps.lng !== 'number') return;
  if (!Number.isFinite(gps.lat) || !Number.isFinite(gps.lng)) return;
  load();
  const moved = !_last || Math.abs(_last.lat - gps.lat) > 0.002 || Math.abs(_last.lng - gps.lng) > 0.002;
  _last = { lat: gps.lat, lng: gps.lng, address: gps.address || (moved ? null : _last?.address) || null, at: Date.now() };
  if (moved || Date.now() - _savedAt > SAVE_EVERY_MS) {
    _savedAt = Date.now();
    try { run('INSERT OR REPLACE INTO settings (key, value) VALUES (:k, :v)', { ':k': KEY, ':v': JSON.stringify(_last) }); } catch {}
  }
}

/** The last known place, or null when there is none or it is older than maxAgeMs. */
export function lastPlace(maxAgeMs = 12 * 60 * 60_000) {
  load();
  if (!_last) return null;
  const age = Date.now() - (_last.at || 0);
  return age <= maxAgeMs ? { ..._last, age_ms: age } : null;
}

// --- sun ------------------------------------------------------------------------------------
// NOAA solar calculator (the "General Solar Position" equations), zenith 90.833 deg for
// sunrise/sunset. Returns UTC milliseconds, or null in polar day/night.
const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;

export function sunTimes(lat, lng, when = new Date()) {
  const dayStartUtc = Date.UTC(when.getUTCFullYear(), when.getUTCMonth(), when.getUTCDate());
  const doy = Math.floor((dayStartUtc - Date.UTC(when.getUTCFullYear(), 0, 1)) / 86400000) + 1;
  const g = (2 * Math.PI / 365) * (doy - 1 + 0.5);
  const eqTime = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g)
    - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
  const decl = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g)
    + 0.000907 * Math.sin(2 * g) - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
  const cosHa = Math.cos(rad(90.833)) / (Math.cos(rad(lat)) * Math.cos(decl)) - Math.tan(rad(lat)) * Math.tan(decl);
  if (cosHa > 1 || cosHa < -1) return null;
  const ha = deg(Math.acos(cosHa));
  const riseMin = 720 - 4 * (lng + ha) - eqTime;
  const setMin = 720 - 4 * (lng - ha) - eqTime;
  return { sunrise: dayStartUtc + riseMin * 60000, sunset: dayStartUtc + setMin * 60000 };
}

function hm(ms, tz) {
  try { return new Date(ms).toLocaleTimeString('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }); }
  catch { return new Date(ms).toISOString().slice(11, 16); }
}

/** "dark; sun up at 07:06, down at 17:13" for the last known place, in his zone, or ''. */
export function daylightLine(tz, now = Date.now()) {
  const p = lastPlace();
  if (!p) return '';
  const today = sunTimes(p.lat, p.lng, new Date(now));
  if (!today) return '';
  const tomorrow = sunTimes(p.lat, p.lng, new Date(now + 86400000));
  // Both times, always: with only the next event, a daylight line carried the sunset alone
  // and the model, asked for sunrise, read the clock instead (hub bench, 2026-11-11).
  const rise = hm(today.sunrise, tz), set = hm(today.sunset, tz);
  if (now < today.sunrise) return `dark now (sunrise today ${rise}, sunset ${set})`;
  if (now < today.sunset) return `daylight now (sunrise today was ${rise}, sunset ${set})`;
  return `dark now (sunset today was ${set}${tomorrow ? `, sunrise tomorrow ${hm(tomorrow.sunrise, tz)}` : ''})`;
}

// --- weather, kept in the background -----------------------------------------------------------
// A person in the room knows if it is raining. Fetched for the last known place at most every
// 30 minutes, started by a read but never awaited by it: a voice turn uses what is already there.
const WX_EVERY_MS = 30 * 60_000;
const WX_CODES = {
  0: 'clear', 1: 'mostly clear', 2: 'partly cloudy', 3: 'overcast', 45: 'fog', 48: 'fog',
  51: 'drizzle', 53: 'drizzle', 55: 'drizzle', 61: 'light rain', 63: 'rain', 65: 'heavy rain',
  71: 'light snow', 73: 'snow', 75: 'heavy snow', 80: 'showers', 81: 'showers', 82: 'heavy showers',
  95: 'thunderstorms', 96: 'thunderstorms', 99: 'thunderstorms',
};
let _wx = null;            // { text, at, lat, lng }
let _wxBusy = false;

async function refreshWeather(p) {
  _wxBusy = true;
  try {
    const url = 'https://api.open-meteo.com/v1/forecast' +
      `?latitude=${p.lat.toFixed(3)}&longitude=${p.lng.toFixed(3)}` +
      '&current=temperature_2m,weather_code,wind_speed_10m' +
      '&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto&forecast_days=1';
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return;
    const j = await res.json();
    const c = j.current || {}, d = j.daily || {};
    const bits = [];
    if (c.temperature_2m != null) bits.push(`${Math.round(c.temperature_2m)}C ${WX_CODES[c.weather_code] || ''}`.trim());
    if (d.temperature_2m_min?.[0] != null) bits.push(`today ${Math.round(d.temperature_2m_min[0])} to ${Math.round(d.temperature_2m_max[0])}C`);
    if (d.precipitation_probability_max?.[0] != null) bits.push(`${d.precipitation_probability_max[0]}% chance of rain`);
    if (bits.length) _wx = { text: bits.join(', '), at: Date.now(), lat: p.lat, lng: p.lng };
  } catch {} finally { _wxBusy = false; }
}

/** "weather 14C clear, today 9 to 17C, 0% chance of rain", or '' (then starts a fetch). */
export function weatherLine() {
  const p = lastPlace();
  if (!p) return '';
  const near = _wx && Math.abs(_wx.lat - p.lat) < 0.2 && Math.abs(_wx.lng - p.lng) < 0.2;
  if ((!near || Date.now() - _wx.at > WX_EVERY_MS) && !_wxBusy) refreshWeather(p);
  return near && Date.now() - _wx.at < 3 * WX_EVERY_MS ? `weather ${_wx.text}` : '';
}

/** The place part of the situation line: this turn's place, else the last known one with its age. */
export function placeLine(turnGps) {
  if (turnGps?.address) return `his phone is at ${String(turnGps.address).slice(0, 60)}`;
  const p = lastPlace();
  if (!p?.address) return '';
  const mins = Math.round(p.age_ms / 60000);
  // A fix this fresh reads the same as one sent with the turn, so the read ahead matches the turn.
  if (mins < 5) return `his phone is at ${String(p.address).slice(0, 60)}`;
  const ago = mins < 5 ? 'just now' : mins < 90 ? `${mins} min ago` : `${Math.round(mins / 60)} h ago`;
  return `his phone was at ${String(p.address).slice(0, 60)} (${ago}; no fix with this turn)`;
}
