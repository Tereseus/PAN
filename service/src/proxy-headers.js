// proxy-headers.js — hop-by-hop header hygiene for PAN's two in-process reverse
// proxies: super-carrier.js (:7777 → Carrier) and carrier.js (Carrier → Craft).
//
// Hop-by-hop headers describe one TCP connection, so a proxy must not copy them
// onto the next one (RFC 9110 §7.6.1). Both proxies used to copy them verbatim.
// Bug (2026-11-03): a client's `Connection: close` rode a pooled keep-alive socket
// upstream, the SSE handlers in routes/api.js answered `Connection: keep-alive`
// anyway, and the socket went back into the agent's pool after the upstream
// parser had already closed it ("Data after Connection: close"). The next request
// to reuse that socket got Node's default clientError reply: 400, empty body.
//
// transfer-encoding stays: http.request() and writeHead() read it to frame the
// piped body. Tokens listed inside the Connection header are deliberately NOT
// honoured, because that would let any client strip headers of its choosing
// (content-length, x-forwarded-host) before they reach the next hop.

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'te',
  'trailer',
  'upgrade',
]);

// Returns a copy of `headers` without the hop-by-hop ones. Use it on both the
// request a proxy sends upstream and the response it relays back.
export function stripHopByHop(headers) {
  const out = {};
  for (const [name, value] of Object.entries(headers || {})) {
    if (!HOP_BY_HOP.has(name.toLowerCase())) out[name] = value;
  }
  return out;
}
