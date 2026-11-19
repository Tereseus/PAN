// One real voice turn against the PAN on this computer, the way the phone sends it
// (POST /api/v1/query/stream, source "voice"). Prints one line of JSON and exits 0 when
// PAN answered in words. PAN Setup runs it after the models are in; the install test too.
//
//   node voice-check.cjs [port] ["what to say"]
//
// Nothing it sends is kept: that endpoint does not write the line to PAN's memory.

const port = parseInt(process.argv[2], 10) || 7777;
const lines = process.argv[3] ? [process.argv[3]] : ['Hey PAN, say hello to me.', 'PAN, what is two plus two?'];

async function ask(text) {
  const t0 = Date.now();
  const res = await fetch(`http://127.0.0.1:${port}/api/v1/query/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-device-id': `setup-check-${Math.random().toString(36).slice(2, 10)}` },
    body: JSON.stringify({ text, source: 'voice', device_id: 'setup-check', session_id: `setup-check-${t0}`, context: '' }),
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) return { ok: false, said: text, status: res.status };
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let firstMs = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const piece = dec.decode(value, { stream: true });
    if (!firstMs && piece.includes('"chunk"')) firstMs = Date.now() - t0;
    buf += piece;
  }
  try { await reader.cancel(); } catch {}
  let reply = '';
  const re = /"type":"chunk","text":"((?:[^"\\]|\\.)*)"/g;
  let m;
  while ((m = re.exec(buf)) !== null) {
    try { reply += JSON.parse(`"${m[1]}"`); } catch {}
  }
  // A reply PAN decided to hold back for a moment still shows it can talk.
  const held = buf.match(/"type":"done","result":\{(?:[^{}]|\{[^{}]*\})*"response":"((?:[^"\\]|\\.)*)"/);
  let heldText = '';
  if (held) { try { heldText = JSON.parse(`"${held[1]}"`); } catch {} }
  const model = (buf.match(/"model":"([^"]+)"/) || [])[1] || null;
  const words = (reply.trim() || heldText.trim());
  return { ok: words.length > 0, said: text, reply: words.slice(0, 300), firstMs, totalMs: Date.now() - t0, model, raw: words ? undefined : buf.slice(0, 400) };
}

(async () => {
  let last = { ok: false };
  for (const text of lines) {
    try { last = await ask(text); } catch (e) { last = { ok: false, said: text, error: e.message }; }
    if (last.ok) break;
  }
  console.log(JSON.stringify(last));
  process.exit(last.ok ? 0 : 1);
})();
