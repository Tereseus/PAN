// Offline library: a reader for Kiwix ZIM files (docs/INTUITION-STATE.md section 12).
//
// Kiwix's own readers (libzim, kiwix-serve, kiwix-js) are GPL, so ΠAN reads the file itself. The
// format is public (openzim.org/wiki/ZIM_file_format): a header, a list of entries sorted by path,
// a list of entry numbers sorted by title, and "clusters" of zstd packed articles. Looking a title up
// is a binary search over the title list, about 23 small reads for 6 million entries, then one
// cluster read. No search index: names come from the talk (the shelf), so a title is what we have.
//
// The text (Wikipedia) is CC BY-SA: commercial use is fine with credit, and share-alike applies to
// the text itself.

import { open, readdir } from 'fs/promises';
import { zstdDecompressSync } from 'zlib';
import { join, dirname } from 'path';
import { getDataDir } from '../platform.js';

// The library sits beside the data folder: <LOCALAPPDATA>/PAN/library on Windows.
export function libraryDir() {
  return process.env.PAN_LIBRARY_DIR || join(dirname(getDataDir()), 'library');
}

// The newest English Wikipedia file in the library, or null when there is none.
export async function wikipediaFile() {
  try {
    const files = (await readdir(libraryDir())).filter((f) => /^wikipedia_en_.*\.zim$/.test(f)).sort();
    return files.length ? join(libraryDir(), files[files.length - 1]) : null;
  } catch { return null; }
}

// Wikipedia's opening for a name, offline: { title, text, source } or null.
export async function wikiLookup(name, opts) {
  const f = await wikipediaFile();
  if (!f) return null;
  const r = await lookup(f, name, opts);
  return r && { ...r, source: 'Wikipedia (offline, CC BY-SA)' };
}

const MAGIC = 72173914;
const REDIRECT = 0xffff;

export class Zim {
  static async open(path) {
    const z = new Zim();
    z.fh = await open(path, 'r');
    const h = await z.read(0, 80);
    if (h.readUInt32LE(0) !== MAGIC) throw new Error('not a ZIM file');
    z.major = h.readUInt16LE(4);
    z.entryCount = h.readUInt32LE(24);
    z.clusterCount = h.readUInt32LE(28);
    z.pathPtrPos = Number(h.readBigUInt64LE(32));
    z.titlePtrPos = Number(h.readBigUInt64LE(40));
    z.clusterPtrPos = Number(h.readBigUInt64LE(48));
    z.mimeListPos = Number(h.readBigUInt64LE(56));
    z.mainPage = h.readUInt32LE(64);
    z.checksumPos = Number(h.readBigUInt64LE(72));
    z.mimes = await z.readMimes();
    z.cache = new Map();          // a few decompressed clusters; one cluster holds many articles
    return z;
  }

  async close() { await this.fh?.close(); }

  async read(pos, len) {
    const b = Buffer.alloc(len);
    const { bytesRead } = await this.fh.read(b, 0, len, pos);
    return b.subarray(0, bytesRead);
  }

  async readMimes() {
    const b = await this.read(this.mimeListPos, 4096);
    const out = [];
    let s = 0;
    for (let i = 0; i < b.length; i++) {
      if (b[i] !== 0) continue;
      if (i === s) break;
      out.push(b.toString('utf8', s, i));
      s = i + 1;
    }
    return out;
  }

  // Directory entry number i (in path order).
  async entry(i) {
    const p = await this.read(this.pathPtrPos + 8 * i, 8);
    const pos = Number(p.readBigUInt64LE(0));
    const b = await this.read(pos, 1024);
    const mime = b.readUInt16LE(0);
    const paramLen = b[2];
    const ns = String.fromCharCode(b[3]);
    let o = 8;
    const e = { index: i, mime, ns };
    if (mime === REDIRECT) { e.redirect = b.readUInt32LE(o); o += 4; }
    else { e.cluster = b.readUInt32LE(o); e.blob = b.readUInt32LE(o + 4); o += 8; }
    const pEnd = b.indexOf(0, o);
    e.path = b.toString('utf8', o, pEnd);
    const tEnd = b.indexOf(0, pEnd + 1);
    e.title = b.toString('utf8', pEnd + 1, tEnd) || e.path;
    void paramLen;
    return e;
  }

  // Exact path in namespace ns. Binary search over the path-ordered list.
  async findPath(path, ns) {
    const want = Buffer.from(ns + path);
    let lo = 0, hi = this.entryCount - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const e = await this.entry(mid);
      const c = Buffer.compare(Buffer.from(e.ns + e.path), want);
      if (c === 0) return e;
      if (c < 0) lo = mid + 1; else hi = mid - 1;
    }
    return null;
  }

  // The title-ordered list. Files from format 6.1 on keep it as an item: X/listing/titleOrdered/v1
  // holds the articles only (smaller), v0 every entry. Older files point at it from the header.
  async titleList() {
    if (this.titles) return this.titles;
    for (const p of ['listing/titleOrdered/v1', 'listing/titleOrdered/v0']) {
      const e = await this.findPath(p, 'X');
      const a = e && (await this.article(e));
      if (a?.body?.length) {
        const own = Buffer.from(a.body);           // copy: the cluster cache may drop the source
        this.titles = { count: own.length / 4, at: (k) => own.readUInt32LE(4 * k) };
        return this.titles;
      }
    }
    if (this.titlePtrPos < 2 ** 52) {
      const pos = this.titlePtrPos;
      this.titles = { count: this.entryCount, at: async (k) => (await this.read(pos + 4 * k, 4)).readUInt32LE(0) };
      return this.titles;
    }
    throw new Error('no title list in this ZIM file');
  }

  async entryByTitleRank(k) {
    const t = await this.titleList();
    return this.entry(await t.at(k));
  }

  // Exact title in namespace ns. Binary search over the title-ordered list.
  async findTitle(title, ns = 'C') {
    const want = ns + title;
    const t = await this.titleList();
    let lo = 0, hi = t.count - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const e = await this.entryByTitleRank(mid);
      const got = e.ns + e.title;
      if (got === want) return e;
      if (Buffer.compare(Buffer.from(got), Buffer.from(want)) < 0) lo = mid + 1; else hi = mid - 1;
    }
    return null;
  }

  async cluster(n) {
    if (this.cache.has(n)) return this.cache.get(n);
    const ptr = await this.read(this.clusterPtrPos + 8 * n, 16);
    const start = Number(ptr.readBigUInt64LE(0));
    const end = n + 1 < this.clusterCount ? Number(ptr.readBigUInt64LE(8)) : this.checksumPos;
    const raw = await this.read(start, end - start);
    const info = raw[0];
    const comp = info & 0x0f;
    const wide = (info & 0x10) !== 0;
    let data;
    if (comp === 0 || comp === 1) data = raw.subarray(1);
    else if (comp === 5) data = zstdDecompressSync(raw.subarray(1));
    else throw new Error(`cluster compression ${comp} not supported (xz is only in old ZIM files)`);
    const c = { data, wide };
    this.cache.set(n, c);
    if (this.cache.size > 8) this.cache.delete(this.cache.keys().next().value);
    return c;
  }

  async blob(clusterNo, blobNo) {
    const { data, wide } = await this.cluster(clusterNo);
    const w = wide ? 8 : 4;
    const off = (i) => (wide ? Number(data.readBigUInt64LE(i * w)) : data.readUInt32LE(i * w));
    return data.subarray(off(blobNo), off(blobNo + 1));
  }

  // Follows redirects (at most 5) and returns { title, path, mime, body } or null.
  async article(e) {
    for (let hops = 0; e && e.mime === REDIRECT && hops < 5; hops++) e = await this.entry(e.redirect);
    if (!e || e.mime === REDIRECT) return null;
    return { title: e.title, path: e.path, mime: this.mimes[e.mime], body: await this.blob(e.cluster, e.blob) };
  }
}

// The spellings a spoken name may need: as said, first letter up, every word up.
export function titleForms(name) {
  const s = String(name || '').trim().replace(/\s+/g, ' ');
  if (!s) return [];
  const first = s[0].toUpperCase() + s.slice(1);
  const words = s.split(' ').map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(' ');
  const lowerRest = s[0].toUpperCase() + s.slice(1).toLowerCase();
  return [...new Set([s, first, words, lowerRest])];
}

// Article HTML to plain text: its paragraphs only. Hatnotes ("For other uses, see..."), the title,
// infoboxes and footnote marks are not paragraphs, so they drop out. A pronunciation in brackets
// right after the name ("(/ˈliːmə/; Spanish: [ˈlima])") is cut: it is noise when spoken.
export function plainText(html, max = 1200) {
  const page = String(html).replace(/<(script|style|template)\b[\s\S]*?<\/\1>/gi, ' ');
  const paras = [...page.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)].map((m) => m[1]
    .replace(/<(sup|style|script)[\s\S]*?<\/\1>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/\s*\(\/[^()]*(?:\([^()]*\)[^()]*)*\)/g, '')
    .replace(/\[\d+\]/g, '')
    .replace(/\s+/g, ' ')
    .trim()).filter(Boolean);
  const t = paras.join('\n');
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('.\n'));
  return end > max * 0.5 ? cut.slice(0, end + 1) : cut;
}

// One open library per file, reused.
const opened = new Map();
export async function library(path) {
  if (!opened.has(path)) opened.set(path, Zim.open(path).catch((err) => { opened.delete(path); throw err; }));
  return opened.get(path);
}

// ---- notes for a question ---------------------------------------------------------------------
// The world path (router.js) asks Wikipedia first and the web only when Wikipedia does not hold it
// (the owner's call, 2026-11-23: Wikipedia first, the web for what is new). The
// subject is found the way the file allows: stretches of his words that are an article's title,
// longest first ("capital of peru" before "peru"). Only grammar words are listed, never topics.
const GRAMMAR = new Set(('a an the of in on at to for from by with about and or but is are was were be been am do does did ' +
  'what whats what\'s who whos who\'s whom whose which where when why how hows how\'s tell me us you your i my we our it its ' +
  'it\'s that this these those there here can could would should will shall may might must please hey ok okay so just ' +
  'like know think really actually much many tall old big long far far away pan pam ' +
  'look looks eat eats ate get got go goes went make made see saw say said mean means want need live lives ' +
  'work works win won lose lost play played happen happened happening use used come came give gave take took ' +
  'year years today tonight now time times day days week weeks month months people thing things way ' +
  'last next first latest new current right still ever also').split(' '));
const DISAMBIG = /\b(?:may|might|can) (?:also )?refer to:?\s*$|^.{0,80}\brefers? to:\s*$/im;

/** Stretches of 1 to 4 words that could name an article: longest first, later ones first within a length. */
export function subjectSpans(question, max = 16) {
  const words = String(question || '').replace(/[“”"]/g, '').match(/[\p{L}\p{N}][\p{L}\p{N}'.-]*/gu) || [];
  const w = words.map((x) => x.replace(/[.'-]+$/, ''));
  const out = [];
  for (let n = Math.min(4, w.length); n >= 1; n--) {
    for (let i = w.length - n; i >= 0; i--) {
      const s = w.slice(i, i + n);
      if (GRAMMAR.has(s[0].toLowerCase()) || GRAMMAR.has(s[n - 1].toLowerCase())) continue;
      if (n === 1 && s[0].length < 3 && !/\d/.test(s[0])) continue;
      out.push(s.join(' '));
      if (out.length >= max) return out;
    }
  }
  return out;
}

/**
 * Notes for a question from offline Wikipedia: { notes: [line, ...], titles, ms, engine } or null.
 * Up to two articles; the lines that share most with the question (web-lookup.js pick), else the
 * opening sentence of the article found from the longest stretch of his words.
 */
export async function wikiNotes(question, { budget = 450 } = {}) {
  const f = await wikipediaFile();
  if (!f) return null;
  const t0 = Date.now();
  try {
    const z = await library(f);
    const found = [];
    for (const span of subjectSpans(question)) {
      if (found.length >= 2) break;
      if (found.some((x) => x.span.toLowerCase().includes(span.toLowerCase()))) continue;
      for (const form of titleForms(span)) {
        const e = await z.findTitle(form);
        if (!e) continue;
        const a = await z.article(e);
        if (!a || !/html/.test(a.mime || '') || /\(disambiguation\)$/.test(a.title)) break;
        const text = plainText(a.body.toString('utf8'), 2500);
        if (!text || DISAMBIG.test(text.split('\n')[0])) break;
        if (!found.some((x) => x.title === a.title)) found.push({ span, title: a.title, text });
        break;
      }
    }
    if (!found.length) return null;
    const { pick, sentences } = await import('../web-lookup.js');
    const lines = found.flatMap((x, k) => sentences(x.text).map((t, i) => ({ text: t, top: k === 0 && i < 2 })));
    let notes = pick(question, lines, budget);
    if (!notes.length) notes = [sentences(found[0].text)[0] || found[0].text.slice(0, 240)];
    return { notes, titles: found.map((x) => x.title), ms: Date.now() - t0, engine: 'wikipedia' };
  } catch { return null; }
}

// Look a name up: { title, text } or null.
export async function lookup(path, name, { max = 1200 } = {}) {
  const z = await library(path);
  for (const t of titleForms(name)) {
    const e = await z.findTitle(t);
    if (!e) continue;
    const a = await z.article(e);
    if (!a || !/html/.test(a.mime || '')) continue;
    const text = plainText(a.body.toString('utf8'), max);
    if (text) return { title: a.title, text };
  }
  return null;
}
