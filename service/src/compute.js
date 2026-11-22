// compute.js: the machines ΠAN can run models on, for the app's Models tab (the owner, 2026-11-22:
// "give you a list of the graphics cards that you have available and the different computers you
// have", and a mini PC with a fast AI chip has to show up fairly next to a graphics card).
//
// Each PC's pan-client reports its own chips (hardware: graphics cards, AI chips, processor,
// memory, its home network addresses). Speed is MEASURED, never taken from the box: a short test
// on that machine's Ollama gives tokens a second for a model ΠAN really uses. Each machine has a
// switch, "ΠAN may use this". A machine that is off gets none of ΠAN's models: a model pinned to it
// (setting model_hosts) runs on the hub instead (llm.js, pinAllowed).
//
// Pure functions only; server.js reads the database and Ollama and passes the facts in.

const HW_LIST = 8;
const str = (v, n = 80) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const num = v => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.round(Number(v)) : 0);

/** A pan-client hardware report, cleaned: only the fields shown, sizes capped. null if empty. */
export function cleanHardware(hw) {
  if (!hw || typeof hw !== 'object') return null;
  const gpus = (Array.isArray(hw.gpus) ? hw.gpus : []).slice(0, HW_LIST)
    .map(g => ({ name: str(g?.name), vram_mb: num(g?.vram_mb) })).filter(g => g.name);
  const npus = (Array.isArray(hw.npus) ? hw.npus : []).slice(0, HW_LIST).map(n => str(n)).filter(Boolean);
  const ips = (Array.isArray(hw.ips) ? hw.ips : []).slice(0, HW_LIST).map(i => str(i, 45)).filter(i => /^[0-9a-f.:]+$/i.test(i));
  const cpu = str(hw.cpu);
  const out = { gpus, npus, cpu, cores: num(hw.cores), ram_gb: num(hw.ram_gb), ips };
  return gpus.length || npus.length || cpu || out.ram_gb ? out : null;
}

/** The host part of a URL, lower case ('' if none). */
export function hostOf(url) {
  try { return new URL(String(url)).hostname.toLowerCase().replace(/^\[|\]$/g, ''); } catch { return ''; }
}

const LOCAL = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);

/**
 * Which machine an Ollama URL is on. machines: [{ id, name, tailscale_ip, hardware }].
 * Matches the device id, its name, its tailscale address or one of its home addresses; this
 * computer's own addresses are the hub. Returns the machine id, or '' if none.
 */
export function machineForUrl(machines, url, hubId) {
  const h = hostOf(url);
  if (!h) return '';
  if (LOCAL.has(h)) return hubId || '';
  const short = h.split('.')[0];
  for (const m of machines || []) {
    const names = [m.id, m.name, m.tailscale_ip, ...(m.hardware?.ips || [])].filter(Boolean).map(x => String(x).toLowerCase());
    if (names.includes(h) || names.includes(short)) return m.id;
  }
  return '';
}

/**
 * His switch per machine. allowedMap: setting compute_allowed ({ id: bool }). The hub is always
 * on (it is where everything falls back to). The machine WoE shares its card from keeps WoE's own
 * switch (setting pan_mint_gpu_allowed, which pan-gpu.sh reads): shareId names it. Any other
 * machine is on until he turns it off, so nothing that works today stops.
 */
export function isAllowed(id, { hubId, allowedMap = {}, shareId = '', shareAllowed = false } = {}) {
  if (!id) return true;
  if (id === hubId) return true;
  if (shareId && id === shareId) return !!shareAllowed;
  return allowedMap[id] !== false;
}

/** Tokens a second from an Ollama /api/generate reply (eval_count over eval_duration, ns). 0 if not there. */
export function tokensPerSecond(reply) {
  const n = Number(reply?.eval_count), ns = Number(reply?.eval_duration);
  return n > 0 && ns > 0 ? Math.round((n / (ns / 1e9)) * 10) / 10 : 0;
}

/**
 * The model to time on a machine: the one ΠAN's answer model runs as when it is there, else a
 * model already loaded there (no new load on a shared card), else the answer model if the machine
 * has it, else none ('').
 */
export function modelToTime({ answerModel = '', loaded = [], installed = [] }) {
  const want = String(answerModel).replace(/^ollama:/, '');
  const has = (list, n) => list.some(x => x === n || x === `${n}:latest` || `${x}:latest` === n);
  if (want && has(loaded, want)) return want;
  if (loaded.length) return loaded[0];
  if (want && has(installed, want)) return want;
  return '';
}

/** keep_alive for a timing request: a model loaded to stay (expires over a year away) stays; otherwise Ollama's default. */
export function keepAliveFor(expiresAt, now = Date.now()) {
  const t = Date.parse(expiresAt || '');
  return Number.isFinite(t) && t - now > 365 * 864e5 ? -1 : undefined;
}

/**
 * The machine list the app shows. Facts in:
 *  devices: [{ id, name, online, tailscale_ip, hardware }] (pan-client devices; hardware already cleaned)
 *  hubId: this computer's device id; hubHardware: its own report if it has no pan-client
 *  ollama: { [machineId]: { url, loaded: [{ name, vram_mb, cpu_pct }], installed: [names] } }
 *  speeds: setting compute_speeds ({ id: { tok_s, model, at } })
 *  switches: as isAllowed takes them
 *  uses: [{ what, model, pinnedUrl, defaultUrl }] the jobs to place (answer model, voice reader)
 * A device with no hardware report and no Ollama is left out (a bridge, not a computer ΠAN runs on).
 */
export function machineList({ devices = [], hubId = '', hubHardware = null, ollama = {}, speeds = {}, switches = {}, uses = [] }) {
  const out = [];
  const seen = new Set();
  const add = (d) => {
    if (seen.has(d.id)) return;
    const hw = d.hardware || (d.id === hubId ? hubHardware : null);
    const o = ollama[d.id];
    if (!hw && !o && d.id !== hubId) return;
    seen.add(d.id);
    out.push({
      id: d.id, name: d.name || d.id, hub: d.id === hubId, online: d.id === hubId ? true : !!d.online,
      chips: chipsLine(hw), hardware: hw || null,
      ollama: !!o, loaded: o?.loaded || [], speed: speeds[d.id] || null,
      allowed: isAllowed(d.id, { hubId, ...switches }), runs: [],
    });
  };
  if (hubId && !devices.some(d => d.id === hubId)) add({ id: hubId, name: hubId, online: true });
  for (const d of devices) add(d);
  for (const u of uses) {
    const placed = placeUse(out, u, hubId);
    if (placed) placed.machine.runs.push({ what: u.what, model: u.model, note: placed.note });
  }
  // Hub first, then the ones that can run models, fastest first.
  return out.sort((a, b) => (b.hub - a.hub) || (b.ollama - a.ollama) || ((b.speed?.tok_s || 0) - (a.speed?.tok_s || 0)) || a.name.localeCompare(b.name));
}

/**
 * Where one job runs now: its pinned machine (or, unpinned, the machine of the hub's Ollama URL),
 * unless that machine is switched off or offline; then the hub. note says what happens otherwise.
 */
export function placeUse(machines, { pinnedUrl = '', defaultUrl = '' }, hubId) {
  const hub = machines.find(m => m.hub);
  const wantId = machineForUrl(machines, pinnedUrl || defaultUrl, hubId) || hubId;
  const want = machines.find(m => m.id === wantId) || hub;
  if (!want) return null;
  if (want.hub) return { machine: want, note: '' };
  if (!want.allowed) return hub ? { machine: hub, note: `${want.name} is switched off` } : null;
  if (!want.online) return hub ? { machine: hub, note: `${want.name} is offline` } : null;
  return { machine: want, note: hub ? `the hub takes over if ${want.name} is off` : '' };
}

/** One plain line for a machine's chips: "RTX 3050 8 GB · Ryzen 7 5800X, 16 cores, 64 GB". */
export function chipsLine(hw) {
  if (!hw) return '';
  const gb = mb => (mb >= 1024 ? `${Math.round(mb / 1024)} GB` : mb ? `${mb} MB` : '');
  const parts = [];
  for (const g of hw.gpus || []) parts.push([g.name, gb(g.vram_mb)].filter(Boolean).join(' '));
  for (const n of hw.npus || []) parts.push(n);
  const cpu = [hw.cpu, hw.cores ? `${hw.cores} threads` : '', hw.ram_gb ? `${hw.ram_gb} GB memory` : ''].filter(Boolean).join(', ');
  if (cpu) parts.push(cpu);
  return parts.join(' · ');
}
