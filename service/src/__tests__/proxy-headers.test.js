// Hop-by-hop header regression tests — runs standalone, no server needed
// Usage: node service/src/__tests__/proxy-headers.test.js
//
// Bug 2026-11-03: the front door (:7777) answered an empty 400 to whatever request
// followed one sent with `Connection: close` (Python urllib sends it every time).
// super-carrier.js and carrier.js copied the client's Connection header onto
// pooled keep-alive sockets, the SSE handlers answered `Connection: keep-alive`
// anyway, and the next request on the pooled socket hit an upstream parser that
// had already closed it. These tests rebuild that chain in-process.

import http from 'http';
import net from 'net';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { stripHopByHop } from '../proxy-headers.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ✗ ${name}: ${err.message}`);
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg || 'Assertion failed');
}

// Stands in for Craft's POST /api/v1/query/stream (routes/api.js): an SSE handler
// that sets `Connection: keep-alive` whatever the client asked for.
function sseCraft() {
  return http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();
      res.end('data: {"type":"done"}\n\n');
    });
  });
}

// The forwarding shape super-carrier.js proxyHttp() and carrier.js proxyRequest()
// share: Node's default keep-alive agent, body piped, response headers relayed.
// `filter` is what each proxy does to headers in both directions.
function proxyTo(port, filter) {
  return http.createServer((req, res) => {
    const upstream = http.request({
      hostname: '127.0.0.1', port, path: req.url, method: req.method, headers: filter(req.headers),
    }, (upRes) => {
      res.writeHead(upRes.statusCode, filter(upRes.headers));
      upRes.pipe(res);
    });
    upstream.on('error', () => {
      if (!res.headersSent) { res.writeHead(502); res.end(); }
    });
    req.pipe(upstream);
  });
}

// One POST on its own TCP connection, the way curl or Python urllib sends it.
function post(port, { close = false } = {}) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1');
    let data = '';
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      const head = data.split('\r\n\r\n')[0];
      resolve({
        status: Number(head.split(' ')[1]) || 0,
        connection: (/\r\nconnection:\s*([^\r]*)/i.exec(head)?.[1] || '').toLowerCase(),
      });
    };
    const timer = setTimeout(() => { settled = true; sock.destroy(); reject(new Error('no response in 5s')); }, 5000);
    sock.setEncoding('latin1');
    sock.on('data', (d) => { data += d; if (data.endsWith('\r\n0\r\n\r\n')) done(); });
    sock.on('end', done);
    sock.on('error', (err) => { if (!settled) { settled = true; clearTimeout(timer); reject(err); } });
    sock.write(
      `POST /api/v1/query/stream HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n` +
      (close ? 'Connection: close\r\n' : '') +
      'Content-Type: application/json\r\nContent-Length: 2\r\n\r\n{}');
  });
}

// client → front (:7777 role) → carrier (:17760 role) → craft, then the two
// requests from the bug report: one with Connection: close, one right after it.
async function runChain(frontFilter, carrierFilter) {
  const servers = [];
  const listen = (srv) => new Promise((resolve) => {
    servers.push(srv);
    srv.listen(0, '127.0.0.1', () => resolve(srv.address().port));
  });
  try {
    const craftPort = await listen(sseCraft());
    const carrierPort = await listen(proxyTo(craftPort, carrierFilter));
    const frontPort = await listen(proxyTo(carrierPort, frontFilter));
    const first = await post(frontPort, { close: true });
    const second = await post(frontPort);
    return { first, second };
  } finally {
    for (const srv of servers) { srv.closeAllConnections(); srv.close(); }
  }
}

const copyAll = (headers) => ({ ...headers });

console.log('\n=== stripHopByHop ===');

await test('drops every hop-by-hop header', async () => {
  const out = stripHopByHop({
    connection: 'close', 'keep-alive': 'timeout=5', 'proxy-connection': 'keep-alive',
    te: 'trailers', trailer: 'x-checksum', upgrade: 'h2c', 'Keep-Alive': 'timeout=5',
  });
  assert(Object.keys(out).length === 0, `left behind: ${Object.keys(out).join(', ')}`);
});

await test('keeps end-to-end and framing headers', async () => {
  const input = {
    host: 'hub:7777', 'content-type': 'application/json', 'content-length': '42',
    'transfer-encoding': 'chunked', 'x-device-id': 'bench-hub', 'set-cookie': ['a=1', 'b=2'],
  };
  const out = stripHopByHop(input);
  assert(JSON.stringify(out) === JSON.stringify(input), `changed: ${JSON.stringify(out)}`);
});

await test('ignores header names listed inside Connection', async () => {
  const out = stripHopByHop({ connection: 'close, x-device-id, content-length', 'x-device-id': 'p', 'content-length': '2' });
  assert(out['x-device-id'] === 'p' && out['content-length'] === '2', 'a client could strip headers of its choosing');
});

await test('does not mutate its input', async () => {
  const input = { connection: 'close', host: 'x' };
  stripHopByHop(input);
  assert(input.connection === 'close', 'input was modified');
});

console.log('\n=== Proxy chain after a Connection: close request ===');

await test('control: copying hop-by-hop headers still reproduces the empty 400', async () => {
  const { first, second } = await runChain(copyAll, copyAll);
  assert(first.status === 200, `first request got ${first.status}`);
  assert(second.status === 400,
    `second request got ${second.status}, expected the bug's 400. If Node changed how it pools ` +
    'sockets, this chain no longer reproduces the bug and the tests below prove nothing');
});

await test('Carrier fixed, old Super-Carrier in front: no 400', async () => {
  const { first, second } = await runChain(copyAll, stripHopByHop);
  assert(first.status === 200, `first request got ${first.status}`);
  assert(second.status === 200, `second request got ${second.status}`);
});

await test('both proxies fixed: no 400, and the client that asked to close is told close', async () => {
  const { first, second } = await runChain(stripHopByHop, stripHopByHop);
  assert(first.status === 200, `first request got ${first.status}`);
  assert(first.connection === 'close', `first response said Connection: ${first.connection || '(none)'}`);
  assert(second.status === 200, `second request got ${second.status}`);
});

console.log('\n=== Production proxies use the filter ===');

// The chain above uses a stand-in proxy, so also pin the real call sites.
for (const file of ['super-carrier.js', 'carrier.js']) {
  await test(`${file} strips hop-by-hop headers both ways`, async () => {
    const src = readFileSync(join(__dirname, '..', file), 'utf8');
    assert(/import \{ stripHopByHop \} from '\.\/proxy-headers\.js'/.test(src), 'does not import stripHopByHop');
    assert(!/headers:\s*(\{\s*\.\.\.)?req\.headers\b(?!\.)/.test(src), 'forwards raw req.headers upstream');
    assert(!/writeHead\(\s*\w+\.statusCode\s*,\s*\w+\.headers\s*\)/.test(src), 'relays raw upstream response headers');
  });
}

http.globalAgent.destroy();
console.log(`\n${'='.repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${'='.repeat(40)}\n`);
process.exit(failed > 0 ? 1 : 0);
