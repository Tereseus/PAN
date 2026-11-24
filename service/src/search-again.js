// One more search, asked for by the hub model itself. The hub looks a world question up once,
// before the model speaks. When those notes do not hold the answer to something that changes (a
// recent result, who holds a post, a price), the model may reply with only
//   [SEARCH: the words it would type into a search box]
// instead of "I'm not sure". The hub then runs that search and asks again with the new notes, and
// this time the model answers or says it is not sure (the owner's idea, Nov 20: let the model
// itself decide to search when it does not know). The tag is never spoken: plainAsReply would read a
// reply that starts with "[" as the quiet tag, so the tag is caught here, before it.

const TAG = /^\[\s*search\s*:\s*([^\]\n]{2,120}?)\s*\]/i;
const OPEN_TAG = /^\[\s*search\s*:\s*([^\]\n]{2,120})$/i;   // the model stopped before the closing bracket
const lead = (s) => String(s || '').replace(/^[\s"'`]+/, '');

/** The search words when the reply is a search tag, else null. done: the reply is over, so a tag
 *  left open counts too. */
export function searchAgainQuery(reply, done = false) {
  const t = lead(reply);
  const m = TAG.exec(t) || (done ? OPEN_TAG.exec(t.trim()) : null);
  const q = m ? m[1].replace(/\s+/g, ' ').trim() : '';
  return q.length >= 2 ? q : null;
}

/** Can a reply that starts like this still turn out to be a search tag? */
export function maybeSearchTag(head) {
  const t = lead(head).toLowerCase();
  if (!t) return true;
  if (t[0] !== '[') return false;
  if (t.includes(']') || t.includes('\n') || t.length > 160) return false;
  const u = t.slice(1).replace(/^\s+/, '');
  if (u.length <= 6) return 'search'.startsWith(u);
  if (!u.startsWith('search')) return false;
  const rest = u.slice(6).replace(/^\s+/, '');
  return !rest || rest[0] === ':';
}

// The ways the voice model says it does not know. With offline Wikipedia notes that miss something
// that changes (a price, this year's winner), the untrained model said "I don't know that." instead
// of writing the search tag: 11 of 88 on the answer bench, 2026-11-23. That is its own word that it
// does not know, so the hub then looks on the web (the owner: Wikipedia first, the web for what is new).
const DECLINES = ["i don't know", 'i do not know', 'i dont know', "i'm not sure", 'im not sure', 'i am not sure',
  'not sure', "i can't find", 'i cannot find', "i couldn't find", "i can't tell", "i don't have"];
const norm = (s) => lead(s).toLowerCase().replace(/[‘’]/g, "'").replace(/\s+/g, ' ');

/** Does a reply that starts like this say it does not know? true, false, or null (too early to tell). */
export function declineState(head) {
  const t = norm(head);
  if (DECLINES.some((p) => t.startsWith(p))) return true;
  if (!t || DECLINES.some((p) => p.startsWith(t))) return null;
  return false;
}

/** Read the start of a stream only as long as it could still be "I don't know". { declined, stream,
 *  close }: stream gives every piece again from the first; close() drops it when it is not used. */
export async function peekDecline(stream) {
  const it = stream[Symbol.asyncIterator]();
  const seen = [];
  let head = '', done = false, state = null;
  while (state === null) {
    const r = await it.next();
    if (r.done) { done = true; state = declineState(head) === true; break; }
    seen.push(r.value);
    head += r.value;
    state = declineState(head);
  }
  return {
    declined: state === true,
    close: async () => { try { await it.return?.(); } catch { /* already over */ } },
    stream: (async function* () {
      try {
        for (const c of seen) yield c;
        if (done) return;
        while (true) { const r = await it.next(); if (r.done) return; yield r.value; }
      } finally { try { await it.return?.(); } catch { /* already over */ } }
    })(),
  };
}

/** Read the start of a model's stream. A search tag: { query } (the rest of that stream is
 *  dropped). Anything else: { stream } that gives every piece again from the first, so nothing
 *  is lost and nothing waits longer than it takes to see that the reply is not a tag. */
export async function peekSearch(stream) {
  const it = stream[Symbol.asyncIterator]();
  const seen = [];
  let head = '', done = false;
  while (true) {
    const r = await it.next();
    if (r.done) { done = true; break; }
    seen.push(r.value);
    head += r.value;
    const q = searchAgainQuery(head);
    if (q) { try { await it.return?.(); } catch { /* the stream is dropped either way */ } return { query: q }; }
    if (!maybeSearchTag(head)) break;
  }
  if (done) {
    const q = searchAgainQuery(head, true);
    if (q) return { query: q };
  }
  return {
    stream: (async function* () {
      try {
        for (const c of seen) yield c;
        if (done) return;
        while (true) { const r = await it.next(); if (r.done) return; yield r.value; }
      } finally { try { await it.return?.(); } catch { /* already over */ } }
    })(),
  };
}
