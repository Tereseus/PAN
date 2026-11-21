// What the voice runs on right now, and how long a turn takes on each device, for the app's
// Hub screen, Models tab (the owner, 2026-11-21: one table with every model that is running and
// the average times, a place to change them from).
//
// The times are the phone's own: each finished reply ships a log line
// "Stream (first=..ms total=..ms) ..." and the TOTAL is what the person waits for, the number the
// app shows under a message. The first-word number is never used here (the owner: "the total at
// the bottom is correct. That's how long it actually does take").

const STREAM = /Stream \(first=(\d+)ms total=(\d+)ms\)/;

/** Per device, from client log rows (newest first, as the logs table returns them): the last
 *  `per` turns' average total, middle turn and slowest, in ms. Devices with no turn are left out. */
export function deviceTimes(rows, per = 50) {
  const by = new Map();
  for (const r of rows || []) {
    const m = STREAM.exec(String(r?.message || ''));
    if (!m || !r.device_id) continue;
    const list = by.get(r.device_id) || [];
    if (list.length < per) list.push(Number(m[2]));
    by.set(r.device_id, list);
  }
  const out = [];
  for (const [device, t] of by) {
    const s = [...t].sort((a, b) => a - b);
    const mid = s.length % 2 ? s[(s.length - 1) / 2] : Math.round((s[s.length / 2 - 1] + s[s.length / 2]) / 2);
    out.push({ device, turns: s.length, avg_total_ms: Math.round(s.reduce((a, b) => a + b, 0) / s.length),
      median_total_ms: mid, slowest_ms: s[s.length - 1] });
  }
  return out.sort((a, b) => b.turns - a.turns);
}

/** The model lists the pickers offer: every chat model the hub's Ollama has, plus any model
 *  pinned to another machine (setting model_hosts), as the setting writes them. */
export function pickChoices(ollamaNames, pinned = {}) {
  const names = [...new Set([...(ollamaNames || []), ...Object.keys(pinned || {})])]
    .filter(n => n && !/embed|moondream|minicpm-v|llava/i.test(n)).sort();
  return {
    voice_world_model: names.map(n => `ollama:${n}`),
    voice_student_model: names.map(n => `reader:${n}`),
  };
}
