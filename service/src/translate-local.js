// The hub's own translator (steward service "translate", :7784), when one is installed: the
// interpreter's first choice for most lines, and its fallback when the cloud model stalls or is
// out of quota. The local chat model is no fallback: it garbled Greek ("Ποτέ τι κάνει αυτό;",
// 2026-11-03). Languages are ISO 639-1.
export const TRANSLATE_PORT = 7784;

let _up = { ok: false, at: 0, pairs: [] };

/** Whether a translator answers on the hub, checked at most every 30 s. */
export async function translatorUp() {
  if (Date.now() - _up.at < 30_000) return _up.ok;
  let ok = false;
  let pairs = [];
  try {
    const r = await fetch(`http://127.0.0.1:${TRANSLATE_PORT}/`, { signal: AbortSignal.timeout(300) });
    ok = r.ok;
    if (ok) pairs = (await r.json()).pairs || [];
  } catch {}
  _up = { ok, at: Date.now(), pairs };
  return ok;
}

/**
 * Whether a small quickmt model covers this direction: those go ahead of the cloud whatever the
 * language (translate-server.py Pairs). Read after translatorUp(), which keeps the list fresh.
 */
export function pairInstalled(src, tgt) {
  return _up.pairs.includes(`${src}-${tgt}`);
}

// A translator that hands the words straight back has not translated them: MADLAD did that for
// five English lines in a row, and PAN said English to someone who has none (2026-11-05).
const sameWords = (a, b) => a.replace(/[^\p{L}\p{N}]+/gu, '').toLowerCase() === b.replace(/[^\p{L}\p{N}]+/gu, '').toLowerCase();

/** The translation, or null when no translator runs, it does not know a language, or it is slow. */
export async function translateLocal(text, src, tgt, { timeoutMs = 4000 } = {}) {
  const t = String(text || '').trim();
  if (!t || !src || !tgt || src === tgt) return null;
  try {
    const r = await fetch(`http://127.0.0.1:${TRANSLATE_PORT}/translate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: t, src, tgt }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) return null;
    const d = await r.json();
    const out = String(d.text || '').trim();
    return out && !sameWords(out, t) ? out : null;
  } catch {
    return null;
  }
}
