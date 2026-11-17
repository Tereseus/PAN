// The meanings file for src/reading.js: turns a jmdict-simplified JSON build (JMdict, EDRDG
// licence, CC BY-SA 4.0) into a compact "word -> short English gloss" file. Run it again whenever
// a newer JMdict is out (the EDRDG licence asks for regular updates): download
// jmdict-eng-<version>.json.zip from the jmdict-simplified releases, unzip, then:
//
//   node scripts/build-reading-gloss.mjs <jmdict-eng-x.y.z.json> [out dir, default <data dir>/reading]
//
// Output (both are DERIVED FROM JMdict and so stay under CC BY-SA 4.0 + EDRDG terms):
//   jmdict-gloss.json         every entry
//   jmdict-gloss-common.json  only entries with a form marked "common"
//
// File shape: { meta, e: [[kanaForms, posCodes, gloss, flags], ...], k: { key: "i,j,k" } }
//   kanaForms  kana spellings joined with "|"
//   posCodes   coarse part-of-speech codes of the first sense, space separated
//   flags      bit 0 = common, bit 1 = usually written in kana
import fs from 'node:fs';
import path from 'node:path';
import { getDataDir } from '../src/platform.js';

const src = process.argv[2];
if (!src) { console.error('usage: node scripts/build-reading-gloss.mjs <jmdict-eng-x.y.z.json>'); process.exit(1); }
const outDir = process.argv[3] || path.join(getDataDir(), 'reading');
fs.mkdirSync(outDir, { recursive: true });

const t0 = performance.now();
const jm = JSON.parse(fs.readFileSync(src, 'utf8'));
console.log(`parsed ${jm.words.length} entries in ${(performance.now() - t0).toFixed(0)} ms (dict date ${jm.dictDate})`);

function coarse(tag) {
  if (tag === 'prt') return 'prt';
  if (tag === 'pn') return 'pn';
  if (tag === 'int') return 'int';
  if (tag === 'conj') return 'conj';
  if (tag === 'ctr') return 'ctr';
  if (tag === 'num') return 'num';
  if (tag === 'exp') return 'exp';
  if (tag === 'pref' || tag === 'n-pref') return 'pref';
  if (tag === 'suf' || tag === 'n-suf') return 'suf';
  if (tag === 'adj-pn') return 'adn';
  if (tag === 'adj-na') return 'na';
  if (tag === 'adj-i' || tag === 'adj-ix') return 'adj';
  if (tag === 'cop' || tag.startsWith('aux')) return 'aux';
  if (tag.startsWith('adv')) return 'adv';
  if (tag === 'vs') return 'n';            // "noun taking suru": the entry itself is a noun
  if (tag.startsWith('v')) return 'v';
  if (tag === 'n' || tag.startsWith('n-') || tag === 'adj-no') return 'n';
  return '';
}

function shortGloss(sense) {
  const parts = [];
  let len = 0;
  for (const g of sense.gloss) {
    if (g.lang && g.lang !== 'eng') continue;
    const t = g.text;
    if (parts.length && len + t.length > 38) break;
    parts.push(t);
    len += t.length + 2;
    if (parts.length === 2) break;
  }
  let s = parts.join('; ');
  if (s.length > 60) s = s.slice(0, 57).trimEnd() + '...';
  return s;
}

function build(commonOnly) {
  const e = [];
  const k = Object.create(null);
  for (const w of jm.words) {
    const common = w.kanji.some((x) => x.common) || w.kana.some((x) => x.common);
    if (commonOnly && !common) continue;
    const sense = w.sense[0];
    if (!sense) continue;
    const gloss = shortGloss(sense);
    if (!gloss) continue;
    const pos = [...new Set(sense.partOfSpeech.map(coarse).filter(Boolean))].join(' ');
    const uk = w.sense.some((s) => s.misc && s.misc.includes('uk'));
    const kana = w.kana.filter((x) => !x.tags.includes('sk')).map((x) => x.text);
    const idx = e.length;
    e.push([kana.join('|'), pos, gloss, (common ? 1 : 0) | (uk ? 2 : 0)]);
    const keys = new Set(kana);
    for (const kj of w.kanji) keys.add(kj.text);   // search-only forms kept: useful for lookup
    for (const key of keys) k[key] = k[key] === undefined ? String(idx) : k[key] + ',' + idx;
  }
  return {
    meta: {
      source: 'JMdict (Electronic Dictionary Research and Development Group), via jmdict-simplified ' + jm.version,
      dictDate: jm.dictDate,
      licence: 'CC BY-SA 4.0, https://www.edrdg.org/edrdg/licence.html',
      commonOnly,
    },
    e, k,
  };
}

for (const commonOnly of [false, true]) {
  const out = build(commonOnly);
  const file = path.join(outDir, commonOnly ? 'jmdict-gloss-common.json' : 'jmdict-gloss.json');
  fs.writeFileSync(file, JSON.stringify(out));
  console.log(`${file}: ${out.e.length} entries, ${Object.keys(out.k).length} keys, ${(fs.statSync(file).size / 1048576).toFixed(1)} MB`);
}
