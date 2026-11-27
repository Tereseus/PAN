// The voice model on this machine's own CPU (steward service "voice-reader", :7786): Ollama's
// llama-server, run by PAN with --swa-full, because Ollama re-reads the whole prompt every turn.
// It reads the conversation before his words arrive (warmReader) and is handed the fixed start
// of its reply instead of writing it, so the first spoken word doesn't wait on either.
// Hub CPU, Syrinx r10, 2026-11-05: 0.98 s -> 0.2 s on a short conversation, 1.9 s -> 0.47 s on a
// long one with read ahead alone. Model names: "reader:<ollama model>". See docs/FEATURES.md.
export const READER_PORT = 7786;
const BASE = `http://127.0.0.1:${READER_PORT}`;

// Syrinx's chat template, the one in its Modelfile.
const OPEN = '<|startoftext|><|im_start|>user\n';
const CLOSE = '<|im_end|>\n<|im_start|>assistant\n<think></think>';
const TO = '{"to": "';
const HEAD = `${TO}pan", "response": "`;
// Forty lines of history gave it its own replies to copy: "if you're going to spend an hour in
// traffic" four times in one talk. Three test talks replayed: repeated four word runs 26 to 3,
// replies 22 words to 14, and the JSON closed 52 times of 52 (2026-11-05). Only the last few lines
// count: looking back 512 tokens it also pushed the model off what he had said earlier. A line
// that asks for his own words back goes without it (`copy`): even at 192, "what did I say went
// wrong last time" lost the salt. Only the writing: the token that says who a line is for must
// see the plain odds.
const WRITING = { repeat_penalty: 1.15, repeat_last_n: 192 };

// The last prompt the server read, and when: the keep warm below reads it again.
let _lastPrompt = '';
let _lastUse = 0;
const post = (path, body, signal) => {
  if (body?.prompt) { _lastPrompt = body.prompt; _lastUse = Date.now(); }
  return fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
};

// Keep warm (the owner, Nov 27). In the car at 11:35 and 16:01 the first line after a quiet spell
// waited 10.6 s on the first word (the machine had put the model's memory away), past the 4 s
// limit, and the turn fell to the slow backup: 20 s and 36 s. Every 2 minutes with no turn, the
// server reads its last prompt again and writes one token: the prompt is a cache hit, so this is one
// step of the model (about 50 ms of CPU), and it touches all of the model so none of it is put away.
// The same prompt keeps the read ahead conversation in the cache.
const WARM_EVERY_MS = 2 * 60_000;
let _warmTimer = null;
export function keepReaderWarm() {
  if (_warmTimer) return;
  _warmTimer = setInterval(async () => {
    if (Date.now() - _lastUse < WARM_EVERY_MS - 5_000) return;
    const prompt = _lastPrompt || OPEN;
    const t0 = Date.now();
    try {
      const r = await post('/completion', { prompt, n_predict: 1, cache_prompt: true, temperature: 0 }, AbortSignal.timeout(30_000));
      await r.text();
      const ms = Date.now() - t0;
      if (ms > 1500) console.log(`[voice-reader] keep warm: ${ms} ms (it had gone cold)`);
    } catch {}
  }, WARM_EVERY_MS);
  _warmTimer.unref?.();
}

async function read(prompt) {
  const r = await post('/completion', { prompt, n_predict: 0, cache_prompt: true }, AbortSignal.timeout(10_000));
  await r.text();
}

let _warmed = '';

/**
 * Reads what is known before his words arrive. The history goes first and on its own: the server
 * only keeps a restore point at the end of a read, and without one there a new minute in the
 * clock line, or a memory line after the history, would send the turn back to the start.
 * `tail` is the rest of the prompt up to and including the quote his words open with.
 */
export async function warmReader(history, tail) {
  if (history + tail === _warmed) return;
  _warmed = history + tail;
  try {
    if (history) await read(OPEN + history);
    await read(OPEN + history + tail);
  } catch {}
}

async function* completion(prompt, maxTokens, signal, usageOut, copy) {
  const r = await post('/completion', { prompt, n_predict: maxTokens, cache_prompt: true, temperature: 0, stop: ['<|im_end|>'], stream: true, ...(copy ? {} : WRITING) }, signal);
  if (!r.ok) throw new Error(`voice reader ${r.status}`);
  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  // finally: a caller that stops early closes the stream, so llama-server stops writing (llm.js).
  try { while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      let obj;
      try { obj = JSON.parse(line.slice(5)); } catch { continue; }
      if (obj.content) yield obj.content;
      if (obj.stop && usageOut) {
        usageOut.input_tokens += obj.timings?.prompt_n || 0;
        usageOut.output_tokens += obj.timings?.predicted_n || 0;
      }
    }
  } } finally { reader.cancel().catch(() => {}); }
}

/**
 * Yields the reply as the model would have written it. The model still decides who the line is
 * for, with one token after `{"to": "`: handed "pan" blindly it answered talk meant for the room.
 * Only a reply for him gets the rest of the head handed over. Nobody waits on the others.
 * minPan: in a talk the top token is not enough. A line with no "PAN:" lines above it reads as
 * room talk, so one missed reply silenced the rest of the talk. Replayed with his replies in the
 * history, real lines to PAN scored 0.25 and up and "pass me the big pot" 0.00 (2026-11-05).
 */
export async function* readerStream(prompt, maxTokens, signal, usageOut = null, { minPan = 1, needPan = null, copy = false, probe = null, whoMs = 4000 } = {}) {
  const chat = OPEN + prompt + CLOSE;
  // Waits behind a read already running (1.6 s at worst), but a stuck server must not hold the turn.
  // whoMs: a bench turn arrives cold (nothing read ahead), so it gets longer; at 4 s 272 of 872
  // convbench turns fell back to Ollama and skipped this decision (hub, 2026-11-12).
  const r = await post('/completion', { prompt: chat + TO, n_predict: 1, n_probs: 8, cache_prompt: true, temperature: 0 },
    AbortSignal.any([signal, AbortSignal.timeout(whoMs)].filter(Boolean)));
  if (!r.ok) throw new Error(`voice reader ${r.status}`);
  const who = await r.json();
  if (usageOut) usageOut.input_tokens += who.timings?.prompt_n || 0;
  const odds = who.completion_probabilities?.[0]?.top_logprobs || [];
  const pPan = Math.exp(odds.find((t) => t.token === 'pan')?.logprob ?? -Infinity);
  // probe: the caller's object gets the odds, so a bench can replay other thresholds (2026-11-12).
  // pRoom: the other word, for the shadow p_for_pan (intuition/for-pan.js, 2026-11-22).
  if (probe) { probe.pPan = Math.round(pPan * 1000) / 1000; probe.top = who.content; probe.pRoom = Math.round(Math.exp(odds.find((t) => t.token === 'room')?.logprob ?? -Infinity) * 10000) / 10000; }
  // needPan: a stricter bar than the top token (router.js, while he dictates to Claude).
  const head = needPan != null ? (pPan >= needPan ? HEAD : TO) : who.content === 'pan' || pPan >= minPan ? HEAD : TO;
  yield head;
  yield* completion(chat + head, maxTokens, signal, usageOut, copy);
}
