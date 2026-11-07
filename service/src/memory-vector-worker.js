// Every embedding in memory, on a thread of its own: see vectorSearch in memory-search.js.
//
// sqlite-vec has no index, so a MATCH reads every vector back through SQLCipher: 8 s on a quiet
// hub and 21.7 s on a busy one (159k x 1024, 2026-11-05). Held as plain floats, the same scan is
// a fraction of a second, for about 650 MB. Loaded at the first search, topped up at each one.
// A vector rewritten or an event pruned since the load stays as it was until the next Craft: the
// search drops ids it can't find, and only the ranking of the rest is used.
//
// It opens the file itself and read-only, not through db-registry: importing that opens the main
// database again with everything db.js does at start. Nothing here writes.
import { parentPort, workerData } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3-multiple-ciphers');
const sqliteVec = require('sqlite-vec');

const { path, dim } = workerData;
const db = new Database(path, { readonly: true });
db.pragma("cipher = 'sqlcipher'");
db.pragma(`key = '${readFileSync(join(dirname(path), 'pan.key'), 'utf-8').trim()}'`);
sqliteVec.load(db);

let ids = new Int32Array(0);
let vecs = new Float32Array(0);
let bytes = new Uint8Array(vecs.buffer);
let count = 0;
let newest = 0;
let loaded = false;

function room(need) {
  if (need <= ids.length) return;
  const capacity = Math.ceil(need * 1.1);
  const grownIds = new Int32Array(capacity);
  grownIds.set(ids.subarray(0, count));
  const grownVecs = new Float32Array(capacity * dim);
  grownVecs.set(vecs.subarray(0, count * dim));
  ids = grownIds;
  vecs = grownVecs;
  bytes = new Uint8Array(vecs.buffer);
}

function add(id, blob) {
  room(count + 1);
  ids[count] = id;
  bytes.set(blob, count * dim * 4);
  count++;
  if (id > newest) newest = id;
}

function load() {
  const t0 = Date.now();
  room(db.prepare('SELECT COUNT(*) AS c FROM event_embeddings_rowids').get().c);
  for (const r of db.prepare('SELECT rowid AS id, embedding FROM event_embeddings').iterate()) add(r.id, r.embedding);
  loaded = true;
  parentPort.postMessage({ log: `${count} vectors in memory in ${Date.now() - t0}ms` });
}

const added = db.prepare('SELECT rowid AS id FROM event_embeddings_rowids WHERE rowid > ? ORDER BY rowid LIMIT 20000');
const vector = db.prepare('SELECT embedding FROM event_embeddings WHERE rowid = ?');

function topUp() {
  for (const { id } of added.all(newest)) {
    const r = vector.get(id);
    if (r) add(id, r.embedding);
  }
}

// The same order as vec0's default L2 distance.
function nearest(q, limit) {
  const v = vecs;
  const top = [];
  for (let i = 0, o = 0; i < count; i++, o += dim) {
    let d = 0;
    for (let j = 0; j < dim; j++) {
      const x = v[o + j] - q[j];
      d += x * x;
    }
    if (top.length === limit && d >= top[limit - 1].distance) continue;
    const at = top.findIndex((t) => t.distance > d);
    top.splice(at < 0 ? top.length : at, 0, { id: ids[i], distance: d });
    if (top.length > limit) top.pop();
  }
  return top.map((t) => ({ id: t.id, distance: Math.sqrt(t.distance) }));
}

parentPort.on('message', ({ id, blob, limit }) => {
  try {
    if (loaded) topUp(); else load();
    if (!blob) return;
    const q = new Float32Array(dim);
    new Uint8Array(q.buffer).set(blob);
    parentPort.postMessage({ id, rows: nearest(q, limit) });
  } catch (e) {
    parentPort.postMessage({ id, error: e.message });
  }
});
