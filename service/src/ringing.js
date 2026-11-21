// Ringing: which of a person's devices has a timer or alarm going off right now, and a stop that
// waits for that device. Each device says so on its regular ask for notes (/slack/pending, every
// few seconds); a line said while one rings goes to the hub model with that fact (router.js
// ringPrompt), and when it chooses to stop it, the stop rides back on the device's next ask.
// Only the person's own devices: what rings on someone else's phone is not theirs to stop.
// Pure but for the clock handed in; tested in __tests__/ringing.test.js.

const FRESH_MS = 15_000;   // a device that said "ringing" this recently still rings
const STOP_MS = 30_000;    // a stop not picked up in this long is dropped

export function createRinging({ now = Date.now } = {}) {
  const state = new Map();   // `${person}|${key}` -> { person, key, name, at }
  const stops = new Map();   // `${person}|${key}` -> at

  const id = (person, key) => `${Number(person) || 1}|${String(key || '')}`;

  /** A device asks for its notes. Returns true when a stop waits for it (taken once). */
  const report = (person, key, { ringing = false, name = '' } = {}) => {
    key = String(key || '').trim();
    if (!key) return false;
    const k = id(person, key);
    if (ringing) state.set(k, { person: Number(person) || 1, key, name: String(name || '').slice(0, 60), at: now() });
    else state.delete(k);
    const at = stops.get(k);
    if (at === undefined) return false;
    stops.delete(k);
    return now() - at <= STOP_MS;
  };

  /** The person's devices ringing now: [{ key, name }], newest first. */
  const ringingFor = (person) => {
    const p = Number(person) || 1, t = now();
    return [...state.values()].filter((s) => s.person === p && t - s.at <= FRESH_MS)
      .sort((a, b) => b.at - a.at).map(({ key, name }) => ({ key, name }));
  };

  /** Stop every device of this person that rings now. Returns the ones told. */
  const stopFor = (person) => {
    const ring = ringingFor(person);
    for (const r of ring) stops.set(id(person, r.key), now());
    return ring;
  };

  return { report, ringingFor, stopFor };
}

/** The words for the model: "his Pixel 10 Pro" or "his Pixel 10 Pro and his OnePlus Pad". */
export function ringingWords(list) {
  const names = (list || []).map((r) => `his ${r.name || 'phone'}`);
  return names.length <= 1 ? (names[0] || '') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/**
 * The one question the hub model is asked while something rings, before the turn goes on as usual.
 * Plain words, like every hub prompt; the model's fixed rule block is not touched, so nothing
 * changes for any line said while nothing rings.
 */
export function ringQuestion(list, heard, history = '') {
  return [
    `A timer or alarm is ringing right now on ${ringingWords(list)}.`,
    history ? String(history).trim() : '',
    `Mic heard: "${String(heard || '').slice(0, 400)}"`,
    'Does he want you to stop or silence what is ringing? He may say it any way at all: stop it, shut that off, kill the timer, make it quiet, or just complain about the noise. Reply with one word, Yes or No.',
  ].filter(Boolean).join('\n\n');
}

/** The model's answer to ringQuestion: only a plain yes stops it. */
export function wantsStop(answer) {
  return /^\W*yes(?![a-z])/i.test(String(answer || ''));
}

/** What PAN says once the stop is sent. */
export function stoppedWords(list) {
  const n = (list || []).map((r) => r.name).filter(Boolean);
  return n.length ? `Stopped it on your ${n.join(' and your ')}.` : 'Stopped it.';
}

// One shared copy for the hub: the poll route writes it, the voice router reads it.
export const ringing = createRinging();
