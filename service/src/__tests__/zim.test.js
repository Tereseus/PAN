// The offline library reader (library/zim.js). Builds a tiny ZIM file the way Kiwix lays one out
// (format 6, title list kept as the X/listing/titleOrdered/v1 item, one plain and one zstd cluster,
// a redirect) and reads it back. No Wikipedia download needed.
// Usage: node service/src/__tests__/zim.test.js

import { mkdtempSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { zstdCompressSync } from 'zlib';
import { Zim, lookup, plainText, titleForms, subjectSpans } from '../library/zim.js';

let failed = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`); if (!cond) failed++; };

const html = (title, body) => `<!DOCTYPE html><html><head><title>${title}</title><script>var x="<p>not this</p>";</script></head>` +
  `<body><h1>${title}</h1><div class="hatnote">For other uses, see ${title} (disambiguation).</div>${body}</body></html>`;

function buildZim() {
  const entries = [   // path order: ns + path, bytewise
    { ns: 'C', path: 'Lima', title: '', mime: 0, cluster: 0, blob: 0 },
    { ns: 'C', path: 'USA', title: 'USA', redirect: 2 },
    { ns: 'C', path: 'United_States', title: 'United States', mime: 0, cluster: 0, blob: 1 },
    { ns: 'X', path: 'listing/titleOrdered/v1', title: '', mime: 1, cluster: 1, blob: 0 },
  ];
  const titleOrder = [0, 1, 2];   // "CLima" < "CUSA" < "CUnited States"
  const blobs0 = [
    Buffer.from(html('Lima', '<p>Lima <span>(/ˈliːmə/; Spanish: [ˈlima])</span> is the capital of Peru.<sup>[1]</sup></p><table><tr><td>Population</td></tr></table><p>It sits on the coast &amp; the desert.</p>')),
    Buffer.from(html('United States', '<p>The United States is a country in North America.</p>')),
  ];
  const list = Buffer.alloc(4 * titleOrder.length);
  titleOrder.forEach((v, i) => list.writeUInt32LE(v, 4 * i));

  const cluster = (blobs, comp) => {
    const offs = Buffer.alloc(4 * (blobs.length + 1));
    let o = offs.length;
    blobs.forEach((b, i) => { offs.writeUInt32LE(o, 4 * i); o += b.length; });
    offs.writeUInt32LE(o, 4 * blobs.length);
    const data = Buffer.concat([offs, ...blobs]);
    return Buffer.concat([Buffer.from([comp]), comp === 5 ? zstdCompressSync(data) : data]);
  };
  const clusters = [cluster(blobs0, 1), cluster([list], 5)];

  const mimes = Buffer.from('text/html\0application/octet-stream+zimlisting\0\0');
  const dirents = entries.map((e) => {
    const head = Buffer.alloc(e.redirect !== undefined ? 12 : 16);
    head.writeUInt16LE(e.redirect !== undefined ? 0xffff : e.mime, 0);
    head[2] = 0; head[3] = e.ns.charCodeAt(0); head.writeUInt32LE(0, 4);
    if (e.redirect !== undefined) head.writeUInt32LE(e.redirect, 8);
    else { head.writeUInt32LE(e.cluster, 8); head.writeUInt32LE(e.blob, 12); }
    return Buffer.concat([head, Buffer.from(e.path + '\0' + e.title + '\0')]);
  });

  const mimePos = 80;
  const pathPtrPos = mimePos + mimes.length;
  let at = pathPtrPos + 8 * entries.length;
  const direntPos = dirents.map((d) => { const p = at; at += d.length; return p; });
  const clusterPtrPos = at;
  at += 8 * clusters.length;
  const clusterPos = clusters.map((c) => { const p = at; at += c.length; return p; });
  const checksumPos = at;

  const header = Buffer.alloc(80);
  header.writeUInt32LE(72173914, 0); header.writeUInt16LE(6, 4); header.writeUInt16LE(1, 6);
  header.writeUInt32LE(entries.length, 24); header.writeUInt32LE(clusters.length, 28);
  header.writeBigUInt64LE(BigInt(pathPtrPos), 32);
  header.writeBigUInt64LE(0xffffffffffffffffn, 40);          // new files: title list is an item
  header.writeBigUInt64LE(BigInt(clusterPtrPos), 48);
  header.writeBigUInt64LE(BigInt(mimePos), 56);
  header.writeUInt32LE(0, 64); header.writeUInt32LE(0xffffffff, 68);
  header.writeBigUInt64LE(BigInt(checksumPos), 72);
  const ptrs = (arr) => { const b = Buffer.alloc(8 * arr.length); arr.forEach((p, i) => b.writeBigUInt64LE(BigInt(p), 8 * i)); return b; };
  return Buffer.concat([header, mimes, ptrs(direntPos), ...dirents, ptrs(clusterPos), ...clusters, Buffer.alloc(16)]);
}

const dir = mkdtempSync(join(tmpdir(), 'pan-zim-'));
const file = join(dir, 'wikipedia_en_test.zim');
writeFileSync(file, buildZim());

const z = await Zim.open(file);
ok(z.entryCount === 4 && z.mimes[0] === 'text/html', 'header and mime list read');
ok((await z.findTitle('Lima'))?.path === 'Lima', 'title found by binary search over the listing item');
ok((await z.findTitle('Nowhere')) === null, 'a missing title is null');

const lima = await lookup(file, 'lima');
ok(lima?.title === 'Lima', 'a lower-case spoken name finds the capitalised title');
ok(lima?.text === 'Lima is the capital of Peru.\nIt sits on the coast & the desert.',
  'only paragraphs: no hatnote, no title, no table, no footnote mark, no pronunciation: ' + JSON.stringify(lima?.text));

const us = await lookup(file, 'USA');
ok(us?.title === 'United States' && /North America/.test(us.text), 'a redirect is followed (zstd and plain clusters both read)');
ok((await lookup(file, 'xqzzy')) === null, 'no article gives null');

ok(subjectSpans('how tall is the eiffel tower')[0] === 'eiffel tower', 'the longest stretch of his words comes first');
ok(subjectSpans("what's the capital of peru")[0] === 'capital of peru', 'grammar words may sit inside a stretch, not at its ends');
ok(JSON.stringify(subjectSpans('what do dryads look like')) === '["dryads"]', 'verbs and grammar words are never a subject');
ok(!subjectSpans('who won the champions league this year').includes('year'), 'time words are never a subject');
ok(JSON.stringify(titleForms('eiffel tower')) === JSON.stringify(['eiffel tower', 'Eiffel tower', 'Eiffel Tower']), 'spoken name forms');
const long = plainText('<p>' + 'One sentence here. '.repeat(100) + '</p>', 100);
ok(long.length <= 100 && long.endsWith('.'), 'long text is cut at a sentence end');

process.env.PAN_DATA_DIR = mkdtempSync(join(tmpdir(), 'pan-zim-db-'));   // update.js opens the database
process.env.PAN_DEV = '1';
const { newestEdition, isNewer } = await import('../library/update.js');
const listing = '<a href="wikipedia_en_all_mini_2026-06.zim">x</a> <a href="wikipedia_en_all_mini_2026-09.zim">y</a> ' +
  '<a href="wikipedia_en_all_mini_2026-11.zim.sha256">z</a> <a href="wikipedia_en_all_nopic_2026-12.zim">n</a> <a href="wikipedia_fr_all_mini_2026-12.zim">f</a>';
ok(newestEdition(listing) === 'wikipedia_en_all_mini_2026-09.zim', 'newest English mini edition picked; checksum files, other editions and languages ignored');
ok(isNewer('wikipedia_en_all_mini_2026-09.zim', 'wikipedia_en_all_mini_2026-06.zim') && !isNewer('wikipedia_en_all_mini_2026-09.zim', 'wikipedia_en_all_mini_2026-09.zim'), 'only a later edition counts as newer');
ok(isNewer('wikipedia_en_all_mini_2026-09.zim', null), 'nothing installed: any edition is newer');

await z.close();
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
