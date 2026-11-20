// The lookup helper: web-lookup.js behind a door on this computer only, for a PAN that runs as
// the system account (a browser must not run with those rights). Start it as the person:
//   node web-lookup-helper.js [port]
// POST /notes { q, engine, budget, deadlineMs } -> { notes, ms, engine } or { notes: [] }
// GET  /status -> lookupStatus()
import http from 'node:http';
import { lookupNotes, lookupStatus, isSystemAccount } from './web-lookup.js';

const PORT = Number(process.argv[2] || process.env.PAN_LOOKUP_PORT || 7796);
if (isSystemAccount()) { console.error('[lookup-helper] refusing to run as the system account'); process.exit(1); }

http.createServer(async (req, res) => {
  const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  try {
    if (req.method === 'GET' && req.url === '/status') return send(200, lookupStatus());
    if (req.method === 'POST' && req.url === '/notes') {
      let raw = '';
      for await (const c of req) { raw += c; if (raw.length > 4000) return send(413, { notes: [] }); }
      const { q, engine, budget, deadlineMs } = JSON.parse(raw || '{}');
      const found = await lookupNotes(q, { engine, budget, deadlineMs: Math.min(Number(deadlineMs) || 4000, 8000) });
      return send(200, found || { notes: [] });
    }
    send(404, {});
  } catch { send(500, { notes: [] }); }
}).listen(PORT, '127.0.0.1', () => console.log(`[lookup-helper] on 127.0.0.1:${PORT}`));
