// Latin-letter readings and short meanings for one interpreted line, so the person can sound the
// words out and see what each one means (PRODUCT-MAP idea 14, "Learn the language while it
// interprets"). Japanese first; other languages return null.
//
//   const r = await readLine('私は東京に行きます', 'ja');
//   // r = { romaji: 'Watashi wa Tōkyō ni ikimasu',
//   //       words: [{ surface, reading, romaji, pos, base?, form?, meaning? }, ...] }
//
// A line costs about 0.1 ms once loaded. Loading takes about 0.4 s and holds about 300 MB, so the
// dictionaries load at the first line and are dropped again after IDLE_MS without one.
//
// Third-party pieces:
//   kuromoji 0.1.2 (Apache-2.0) with its bundled mecab-ipadic-2.7.0-20070801 dictionary (NAIST /
//     ICOT notice in node_modules/kuromoji/NOTICE.md, which has to ship with the product).
//   Meanings (optional): <data dir>/reading/jmdict-gloss-common.json, made from JMdict (EDRDG,
//     CC BY-SA 4.0: credit, the data file stays share-alike, and it has to be rebuilt from the
//     newest JMdict regularly) by scripts/build-reading-gloss.mjs. Without the file every word
//     still gets its reading; only particles and endings get a note.
// The kana table, the number reader and the particle notes are PAN's own.

import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import { getDataDir } from './platform.js';

const require = createRequire(import.meta.url);

// ───────────────────────────── kana → Hepburn ─────────────────────────────

const SINGLE = {
  ア: 'a', イ: 'i', ウ: 'u', エ: 'e', オ: 'o',
  カ: 'ka', キ: 'ki', ク: 'ku', ケ: 'ke', コ: 'ko',
  サ: 'sa', シ: 'shi', ス: 'su', セ: 'se', ソ: 'so',
  タ: 'ta', チ: 'chi', ツ: 'tsu', テ: 'te', ト: 'to',
  ナ: 'na', ニ: 'ni', ヌ: 'nu', ネ: 'ne', ノ: 'no',
  ハ: 'ha', ヒ: 'hi', フ: 'fu', ヘ: 'he', ホ: 'ho',
  マ: 'ma', ミ: 'mi', ム: 'mu', メ: 'me', モ: 'mo',
  ヤ: 'ya', ユ: 'yu', ヨ: 'yo',
  ラ: 'ra', リ: 'ri', ル: 'ru', レ: 're', ロ: 'ro',
  ワ: 'wa', ヰ: 'i', ヱ: 'e', ヲ: 'o',
  ガ: 'ga', ギ: 'gi', グ: 'gu', ゲ: 'ge', ゴ: 'go',
  ザ: 'za', ジ: 'ji', ズ: 'zu', ゼ: 'ze', ゾ: 'zo',
  ダ: 'da', ヂ: 'ji', ヅ: 'zu', デ: 'de', ド: 'do',
  バ: 'ba', ビ: 'bi', ブ: 'bu', ベ: 'be', ボ: 'bo',
  パ: 'pa', ピ: 'pi', プ: 'pu', ペ: 'pe', ポ: 'po',
  ヴ: 'vu',
  ァ: 'a', ィ: 'i', ゥ: 'u', ェ: 'e', ォ: 'o', ャ: 'ya', ュ: 'yu', ョ: 'yo', ヮ: 'wa', ヵ: 'ka', ヶ: 'ke',
};
const DIGRAPH = {
  シェ: 'she', ジェ: 'je', チェ: 'che', ツァ: 'tsa', ツィ: 'tsi', ツェ: 'tse', ツォ: 'tso',
  ティ: 'ti', ディ: 'di', トゥ: 'tu', ドゥ: 'du', テュ: 'tyu', デュ: 'dyu',
  ファ: 'fa', フィ: 'fi', フェ: 'fe', フォ: 'fo', フュ: 'fyu',
  ウィ: 'wi', ウェ: 'we', ウォ: 'wo', イェ: 'ye',
  ヴァ: 'va', ヴィ: 'vi', ヴェ: 've', ヴォ: 'vo', ヴュ: 'vyu',
  クァ: 'kwa', クィ: 'kwi', クェ: 'kwe', クォ: 'kwo', グァ: 'gwa',
  キェ: 'kye', ニェ: 'nye', ヒェ: 'hye', スィ: 'si', ズィ: 'zi',
};
for (const [k, c] of Object.entries({ キ: 'ky', ギ: 'gy', ニ: 'ny', ヒ: 'hy', ビ: 'by', ピ: 'py', ミ: 'my', リ: 'ry', シ: 'sh', チ: 'ch', ジ: 'j', ヂ: 'j' })) {
  DIGRAPH[k + 'ャ'] = c + 'a'; DIGRAPH[k + 'ュ'] = c + 'u'; DIGRAPH[k + 'ョ'] = c + 'o';
}
const MACRON = { a: 'ā', i: 'ī', u: 'ū', e: 'ē', o: 'ō' };
const VOWELS = 'aiueoāīūēō';
// Which written kana may lengthen which preceding vowel (Hepburn keeps "ei" and "ii" as written).
const LONG_OK = { ウ: 'ou', オ: 'o', ア: 'a', エ: 'e' };

const isKata = (s) => /^[ァ-ヺー]+$/.test(s);
const isHira = (s) => /^[ぁ-ゖー]+$/.test(s);
const toKata = (s) => s.replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60));
const toHira = (s) => s.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));

// A "unit" is one katakana character plus a flag saying "this vowel kana only lengthens the one before".
// Kana strings in the tables below mark such a vowel with a trailing "*": 'ジュウ*' = jū.
function U(s) {
  const out = [];
  for (const ch of s) {
    if (ch === '*') { if (out.length) out[out.length - 1].long = true; } else out.push({ k: ch, long: false });
  }
  return out;
}
const unitsToHira = (units) => toHira(units.map((u) => u.k).join(''));

function romanise(units, macrons = true) {
  let out = '';
  let sokuon = false;
  for (let i = 0; i < units.length; i++) {
    const { k, long } = units[i];
    const last = out[out.length - 1] || '';
    if (k === 'ッ') { sokuon = true; continue; }
    if (k === 'ー') {                               // written long mark (loan words)
      if (last && VOWELS.includes(last)) out = macrons ? out.slice(0, -1) + (MACRON[last] || last) : out + last;
      continue;
    }
    if (long && macrons && LONG_OK[k] && LONG_OK[k].includes(last)) {
      out = out.slice(0, -1) + MACRON[last];
      continue;
    }
    let syl;
    const next = units[i + 1];
    if (next && !next.long && DIGRAPH[k + next.k]) { syl = DIGRAPH[k + next.k]; i++; }
    else if (k === 'ン') {
      const after = units[i + 1];
      let nextSyl = '';
      if (after) nextSyl = (units[i + 2] && DIGRAPH[after.k + units[i + 2].k]) || SINGLE[after.k] || '';
      syl = 'n' + (nextSyl && /^[aiueoy]/.test(nextSyl) && !after.long ? "'" : '');
    } else syl = SINGLE[k] !== undefined ? SINGLE[k] : k;
    if (sokuon) {
      if (syl.startsWith('ch')) syl = 't' + syl;
      else if (/^[bcdfghjkmprstvwz]/.test(syl)) syl = syl[0] + syl;
      sokuon = false;
    }
    out += syl;
  }
  return out;
}

// ───────────────────────────── numbers ─────────────────────────────

const DIG = ['ゼロ', 'イチ', 'ニ', 'サン', 'ヨン', 'ゴ', 'ロク', 'ナナ', 'ハチ', 'キュウ*'];
const HYAKU = { 1: 'ヒャク', 3: 'サンビャク', 6: 'ロッピャク', 8: 'ハッピャク' };
const SEN = { 1: 'セン', 3: 'サンゼン', 8: 'ハッセン' };
const KANJI_DIGIT = { 〇: 0, 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const KANJI_UNIT = { 十: 10, 百: 100, 千: 1000 };
const KANJI_BIG = { 万: 1e4, 億: 1e8 };

// alt: last digit (or 10) → [number ending, counter kana]; whole: value → full reading.
const P_ROW = (h, p, b) => ({ 1: ['イッ', p], 3: ['サン', b], 4: ['ヨン', h], 6: ['ロッ', p], 8: ['ハッ', p], 10: ['ジュッ', p] });
const K_ROW = { 1: ['イッ'], 6: ['ロッ'], 8: ['ハッ'], 10: ['ジュッ'] };
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const label = (c, v) => (Array.isArray(c.en) ? c.en[v === 1 ? 0 : 1] : c.en);
const COUNTERS = {
  時: { k: 'ジ', alt: { 4: ['ヨ'], 7: ['シチ'], 9: ['ク'] }, en: "o'clock" },
  時間: { k: 'ジカン', alt: { 4: ['ヨ'], 9: ['ク'] }, en: ['hour', 'hours'] },
  分: { k: 'フン', alt: P_ROW('フン', 'プン', 'プン'), en: ['minute', 'minutes'] },
  秒: { k: 'ビョウ*', en: ['second', 'seconds'] },
  円: { k: 'エン', alt: { 4: ['ヨ'] }, en: 'yen' },
  年: { k: 'ネン', alt: { 4: ['ヨ'] }, en: '(year)' },
  月: { k: 'ガツ', alt: { 4: ['シ'], 7: ['シチ'], 9: ['ク'] }, en: '(month of the year)' },
  ヶ月: { k: 'カゲツ', alt: K_ROW, en: ['month', 'months'] },
  か月: { k: 'カゲツ', alt: K_ROW, en: ['month', 'months'] },
  カ月: { k: 'カゲツ', alt: K_ROW, en: ['month', 'months'] },
  日: { k: 'ニチ', en: ['day', 'days'], whole: { 2: 'フツカ', 3: 'ミッカ', 4: 'ヨッカ', 5: 'イツカ', 6: 'ムイカ', 7: 'ナノカ', 8: 'ヨウ*カ', 9: 'ココノカ', 10: 'トオ*カ', 14: 'ジュウ*ヨッカ', 20: 'ハツカ', 24: 'ニジュウ*ヨッカ' } },
  人: { k: 'ニン', alt: { 4: ['ヨ'] }, whole: { 1: 'ヒトリ', 2: 'フタリ' }, en: ['person', 'people'] },
  歳: { k: 'サイ', alt: { 1: ['イッ'], 8: ['ハッ'], 10: ['ジュッ'] }, whole: { 20: 'ハタチ' }, en: 'years old' },
  才: { k: 'サイ', alt: { 1: ['イッ'], 8: ['ハッ'], 10: ['ジュッ'] }, whole: { 20: 'ハタチ' }, en: 'years old' },
  回: { k: 'カイ', alt: K_ROW, en: ['time', 'times'] },
  階: { k: 'カイ', alt: { ...K_ROW, 3: ['サン', 'ガイ'] }, en: 'floor' },
  個: { k: 'コ', alt: K_ROW, en: ['piece', 'pieces'] },
  本: { k: 'ホン', alt: P_ROW('ホン', 'ポン', 'ボン'), en: '(long things)' },
  杯: { k: 'ハイ', alt: P_ROW('ハイ', 'パイ', 'バイ'), en: ['cup / glass', 'cups / glasses'] },
  匹: { k: 'ヒキ', alt: P_ROW('ヒキ', 'ピキ', 'ビキ'), en: '(small animals)' },
  枚: { k: 'マイ', en: '(flat things)' },
  台: { k: 'ダイ', en: '(machines, vehicles)' },
  番: { k: 'バン', en: 'number' },
  度: { k: 'ド', en: 'times / degrees' },
  名: { k: 'メイ', en: 'people (polite)' },
  泊: { k: 'ハク', alt: P_ROW('ハク', 'パク', 'パク'), en: ['night (stay)', 'nights (stay)'] },
  キロ: { k: 'キロ', en: 'kilo' },
  ドル: { k: 'ドル', en: ['dollar', 'dollars'] },
  メートル: { k: 'メートル', en: 'metres' },
};

// 1..9999 → list of kana parts (thousands, hundreds, tens+units). endAlt replaces the last digit or the 10.
function below10000(n, endAlt) {
  const parts = [];
  const th = Math.floor(n / 1000), hu = Math.floor(n / 100) % 10, te = Math.floor(n / 10) % 10, un = n % 10;
  if (th) parts.push(SEN[th] || DIG[th] + 'セン');
  if (hu) parts.push(HYAKU[hu] || DIG[hu] + 'ヒャク');
  if (te || un) {
    let s = '';
    if (te) s += (te > 1 ? DIG[te] : '') + (un === 0 && endAlt ? endAlt : 'ジュウ*');
    if (un) s += endAlt || DIG[un];
    parts.push(s);
  }
  return parts;
}
function numberParts(n, alt) {
  if (n === 0) return ['ゼロ'];
  const parts = [];
  const oku = Math.floor(n / 1e8), man = Math.floor(n / 1e4) % 1e4, rest = n % 1e4;
  if (oku) { const p = below10000(oku); p[p.length - 1] += 'オク'; parts.push(...p); }
  if (man) { const p = below10000(man); p[p.length - 1] += 'マン'; parts.push(...p); }
  if (rest) {
    const un = rest % 10, te = rest % 100;
    let endAlt;
    if (alt && un && alt[un]) endAlt = alt[un][0];
    else if (alt && !un && te && alt[10]) endAlt = alt[10][0];
    parts.push(...below10000(rest, endAlt));
  }
  return parts;
}
// "3,100" / "3.5" / "二十" / "３" → { value, decimals } or null when it is not a plain number (何, 数, phone numbers).
function parseNumber(str) {
  const s = str.normalize('NFKC').replace(/,/g, '');
  if (/^\d+(\.\d+)?$/.test(s)) {
    const [int, dec] = s.split('.');
    if ((int.length > 1 && int[0] === '0') || int.length > 12) return null;
    return { value: parseInt(int, 10), decimals: dec || '' };
  }
  let total = 0, section = 0, cur = null;
  for (const ch of s) {
    if (/\d/.test(ch)) cur = (cur ?? 0) * 10 + +ch;
    else if (ch in KANJI_DIGIT) cur = (cur ?? 0) * 10 + KANJI_DIGIT[ch];
    else if (ch in KANJI_UNIT) { section += (cur ?? 1) * KANJI_UNIT[ch]; cur = null; }
    else if (ch in KANJI_BIG) { total += (section + (cur ?? 0) || 1) * KANJI_BIG[ch]; section = 0; cur = null; }
    else return null;
  }
  return { value: total + section + (cur ?? 0), decimals: '' };
}

// ───────────────────────────── part of speech, particles ─────────────────────────────

const POS_EN = { 名詞: 'noun', 動詞: 'verb', 形容詞: 'adjective', 副詞: 'adverb', 助詞: 'particle', 助動詞: 'auxiliary', 連体詞: 'prenominal', 接続詞: 'conjunction', 感動詞: 'interjection', 接頭詞: 'prefix', 記号: 'punct', フィラー: 'filler', その他: 'other' };
function posOf(t) {
  if (t.pos === '名詞') {
    if (t.pos_detail_1 === '固有名詞') return 'proper noun';
    if (t.pos_detail_1 === '代名詞') return 'pronoun';
    if (t.pos_detail_1 === '数') return 'number';
    if (t.pos_detail_1 === '形容動詞語幹') return 'na-adjective';
    if (t.pos_detail_1 === '接尾') return t.pos_detail_2 === '助数詞' ? 'counter' : 'suffix';
  }
  return POS_EN[t.pos] || 'other';
}
// Which coarse JMdict classes fit a kuromoji token (see build-gloss.mjs for the codes).
function jmClasses(t) {
  switch (t.pos) {
    case '名詞':
      if (t.pos_detail_1 === '代名詞') return ['pn', 'n'];
      if (t.pos_detail_1 === '数') return ['num', 'n'];
      if (t.pos_detail_1 === '接尾') return ['suf', 'ctr', 'n'];
      if (t.pos_detail_1 === '形容動詞語幹') return ['na', 'n'];
      if (t.pos_detail_1 === '副詞可能') return ['n', 'adv'];
      return ['n', 'na', 'pn'];
    case '動詞': return ['v'];
    case '形容詞': return ['adj'];
    case '副詞': return ['adv'];
    case '連体詞': return ['adn'];
    case '接続詞': return ['conj'];
    case '感動詞': return ['int', 'exp'];
    case '接頭詞': return ['pref'];
    case '助詞': return ['prt'];
    case '助動詞': return ['aux'];
    default: return [];
  }
}

// Our own short notes for grammar words (JMdict's glosses for these are long descriptions).
const PARTICLE = {
  は: 'topic marker', が: 'subject marker', を: 'object marker', に: 'to / at / in', で: 'at / by / with',
  へ: 'toward', と: 'and / with', の: "of / 's", も: 'also', か: 'question marker', ね: "isn't it?",
  よ: '(emphasis)', から: 'from / because', まで: 'until / as far as', より: 'than / from', や: 'and (among others)',
  など: 'and so on', だけ: 'only', しか: 'only (with a negative)', くらい: 'about', ぐらい: 'about',
  ので: 'because', のに: 'in order to / even though', けど: 'but', けれど: 'but', けれども: 'but',
  ながら: 'while', ば: 'if', て: 'and (links verbs)', わ: '(soft emphasis)', な: '(emphasis)', って: '(quoting)',
  でも: 'even / but', ほど: 'to the extent of', ばかり: 'just / only', かな: 'I wonder', し: 'and what is more',
  たり: 'things like', なら: 'if', とか: 'such as', には: 'to / for (topic)', では: 'at / in (topic)', じゃ: 'at / in (topic, casual)',
};
const PARTICLE_BY_DETAIL = { 'と|引用': 'quote marker (that)', 'が|接続助詞': 'but', 'から|接続助詞': 'because', 'の|非自立': 'the one / the act of', 'ん|非自立': '(explaining)' };
const AUX = { です: 'is / am / are (polite)', だ: 'is / am / are', ます: '(polite ending)', ない: 'not', た: '(past)', たい: 'want to', う: "let's / will", よう: "let's / will", ん: 'not', ぬ: 'not', らしい: 'seems', そう: 'looks like / I hear', れる: '(passive / can)', られる: '(passive / can)', せる: '(make / let)', させる: '(make / let)' };
const HELPER_VERB = { いる: 'is ...ing (ongoing)', ある: 'has been done', しまう: 'end up doing / finish', みる: 'try doing', おく: 'do ahead of time', くる: 'come to / start to', いく: 'go on doing', もらう: 'have someone do', もらえる: 'can have someone do', くれる: 'do for me', あげる: 'do for someone', くださる: 'please do', いただく: 'have someone do (humble)', すぎる: 'too much', なる: 'become / (after "if not") must' };
const OWN_WORD = { くださる: 'please give me', いる: 'to be (people, animals)', ある: 'to be / to have (things)' };
const NAME_KIND = { 地域: '(place name)', 人名: "(person's name)", 組織: '(organisation name)' };
const FORM = { ます: 'polite', た: 'past', ない: 'negative', ん: 'negative', ぬ: 'negative', たい: 'want to', う: 'volitional', よう: 'volitional', れる: 'passive/potential', られる: 'passive/potential', せる: 'causative', させる: 'causative', て: 'te-form', で: 'te-form', ば: 'if', たり: 'tari-form', ながら: 'while' };
const ATTACHING_PARTICLES = new Set(['て', 'で', 'ば', 'たり', 'だり', 'ながら', 'ちゃ', 'じゃ']);

// Readings kuromoji/IPADIC picks that are not the everyday reading. Surface → [reading, pronunciation].
// Ambiguous words: the more common everyday reading wins here; it will sometimes be the wrong one.
const READING_FIX = {
  日本: ['ニホン', 'ニホン'],        // IPADIC: ニッポン
  雨: ['アメ', 'アメ'],              // IPADIC sometimes takes a lone 雨 as the suffix ウ (as in 豪雨)
  他: ['ホカ', 'ホカ'],              // IPADIC: タ
  明後日: ['アサッテ', 'アサッテ'],  // IPADIC: ミョウゴニチ (formal)
  何分: ['ナンプン', 'ナンプン'],    // IPADIC: ナニブン (a rare adverb); "how many minutes" is the everyday one
  角: ['カド', 'カド'],              // IPADIC: カク (angle). カド (street corner) is likelier when giving directions.
};
const NAN_BEFORE = /^[タチツテトダヂヅデドナヌネノ]/;   // 何 is "nan" before t / d / n sounds (not before に)

// Context fixes on the raw kuromoji tokens, before anything else looks at them.
function fixTokens(raw) {
  const tokens = [];
  for (let i = 0; i < raw.length; i++) {
    let t = raw[i];
    const nx = raw[i + 1], pv = raw[i - 1];
    // 分の after a number is 分 + の, unless another number follows (3分の1).
    if (t.surface_form === '分の' && !(nx && (isNumTok(nx) || /^[0-9０-９]/.test(nx.surface_form)))) { tokens.push(SYN_FUN, SYN_NO); continue; }
    const fix = READING_FIX[t.surface_form];
    if (fix) t = { ...t, reading: fix[0], pronunciation: fix[1] };
    // 辛い: spicy (karai) rather than painful (tsurai), in every inflection.
    else if (t.basic_form === '辛い' && t.reading && t.reading.startsWith('ツラ')) t = { ...t, reading: 'カラ' + t.reading.slice(2), pronunciation: 'カラ' + t.pronunciation.slice(2) };
    // 行って / 行った read as okonatte (行う, "to hold, carry out") although nothing is being held: prefer 行く.
    else if (t.basic_form === '行う' && t.surface_form === '行っ' && !(pv && pv.surface_form === 'を')) t = { ...t, basic_form: '行く', reading: 'イッ', pronunciation: 'イッ' };
    // 何: nan before counters, 曜日, and t / d / n sounds; nani otherwise.
    else if (t.surface_form === '何' && t.reading === 'ナニ' && nx) {
      const counterNext = nx.pos === '名詞' && nx.pos_detail_1 === '接尾';
      if (counterNext || nx.surface_form.startsWith('曜') || (nx.reading && NAN_BEFORE.test(nx.reading))) {
        t = { ...t, reading: 'ナン', pronunciation: 'ナン' };
        if (counterNext && nx.pos_detail_2 !== '人名') t.pos_detail_1 = '数';
      }
    }
    tokens.push(t);
  }
  return tokens;
}

const PUNCT_MAP = { '、': ',', '。': '.', '・': ' ', '「': '“', '」': '”', '『': '“', '』': '”', '…': '...', '‥': '..', '〜': '~', '【': '[', '】': ']', '《': '“', '》': '”' };
const CLOSERS = new Set([',', '.', '!', '?', ')', ']', '”', ':', ';', '...', '..', '%']);
const OPENERS = new Set(['(', '[', '“']);

// ───────────────────────────── dictionaries (lazy) ─────────────────────────────

let tokenizerPromise = null;
let gloss = null;          // { e, k, meta } or false when no file is present
let glossInfo = null;
const IDLE_MS = 20 * 60 * 1000;
let idleTimer = null;

function touch() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { tokenizerPromise = null; gloss = null; glossInfo = null; }, IDLE_MS);
  idleTimer.unref?.();
}

function loadTokenizer() {
  if (!tokenizerPromise) {
    tokenizerPromise = new Promise((resolve, reject) => {
      const kuromoji = require('kuromoji');
      const dicPath = path.join(path.dirname(require.resolve('kuromoji/package.json')), 'dict');
      kuromoji.builder({ dicPath }).build((err, tok) => (err ? reject(err) : resolve(tok)));
    });
  }
  return tokenizerPromise;
}
function loadGloss(which) {
  if (gloss !== null && which === undefined) return gloss;
  const candidates = which === false ? [] : which === 'common' ? ['jmdict-gloss-common.json'] : which === 'full' ? ['jmdict-gloss.json'] : ['jmdict-gloss-common.json', 'jmdict-gloss.json'];
  gloss = false; glossInfo = null;
  for (const name of candidates) {
    const file = path.join(getDataDir(), 'reading', name);
    if (!fs.existsSync(file)) continue;
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    gloss = { e: j.e, k: new Map(Object.entries(j.k)), meta: j.meta };
    glossInfo = { file: name, entries: j.e.length, keys: gloss.k.size, ...j.meta };
    break;
  }
  return gloss;
}

/** Load the dictionaries ahead of the first line. opts.meanings: 'common' | 'full' | false (default: the small common-words file if present, else the full one). */
export async function warmUp(opts = {}) {
  const t0 = performance.now();
  await loadTokenizer();
  const t1 = performance.now();
  loadGloss(opts.meanings);
  const t2 = performance.now();
  return { tokenizerMs: t1 - t0, glossMs: t2 - t1, gloss: glossInfo };
}

function lookupMeaning(keys, readingHira, classes) {
  if (!gloss) return undefined;
  for (const key of keys) {
    if (!key || key === '*') continue;
    const hit = gloss.k.get(key);
    if (!hit) continue;
    const keyIsKana = isHira(key) || isKata(key);
    let best = null, bestScore = -1;
    for (const idx of hit.split(',')) {
      const [kana, pos, text, flags] = gloss.e[idx];
      let score = 0;
      if (!keyIsKana && readingHira && kana.split('|').includes(readingHira)) score += 8;
      const p = pos.split(' ');
      if (classes.some((c) => p.includes(c))) score += 4;
      if (flags & 1) score += 2;
      if (keyIsKana && flags & 2) score += 1;
      if (score > bestScore) { bestScore = score; best = text; }
    }
    if (best) return best;
  }
  return undefined;
}

// ───────────────────────────── Japanese ─────────────────────────────

function tokenUnits(t, prev) {
  let R = t.reading, P = t.pronunciation;
  if (!R || R === '*') {                       // not in the dictionary
    const s = t.surface_form;
    if (isKata(s)) R = P = s;
    else if (isHira(s)) R = P = toKata(s);
    else return null;                           // kanji (or other script) we cannot read
  }
  // Volitional う (行こ+う, しよ+う, でしょ+う): it only lengthens the o before it.
  if (t.pos === '助動詞' && t.surface_form === 'う' && t.basic_form === 'う' && prev) return [{ k: 'ウ', long: true }];
  const units = [];
  const aligned = P && P.length === R.length;
  for (let i = 0; i < R.length; i++) {
    let k = R[i], long = false;
    if (aligned) {
      const p = P[i];
      if (p === 'ー' && k !== 'ー') long = true;         // dictionary says this vowel is only length
      else if (k === 'ハ' && p === 'ワ') k = 'ワ';       // は read wa
      else if (k === 'ヘ' && p === 'エ') k = 'エ';       // へ read e
    } else if (t.pos !== '動詞' && i > 0 && k === 'ウ') long = true;   // no alignment: assume on-reading long o/u
    if (k === 'ヲ') k = 'オ';
    units.push({ k, long });
  }
  if (t.pos === '助詞') {                                // unknown-word path for bare particles
    if (t.surface_form === 'は' && units.length === 1) units[0].k = 'ワ';
    if (t.surface_form === 'へ' && units.length === 1) units[0].k = 'エ';
  }
  return units;
}

const isAsciiTok = (t) => t.word_type === 'UNKNOWN' && /^[\x21-\x7e]+$/.test(t.surface_form.normalize('NFKC'));
const isNumTok = (t) => t.pos === '名詞' && t.pos_detail_1 === '数';
const isCounterTok = (t) => t && t.pos === '名詞' && ((t.pos_detail_1 === '接尾' && t.pos_detail_2 === '助数詞') || t.surface_form in COUNTERS);

function capitalise(s) { return s.replace(/^[^A-Za-zāīūēō]*[a-zāīūēō]/, (m) => m.toUpperCase()); }

const SYN_FUN = { surface_form: '分', pos: '名詞', pos_detail_1: '接尾', pos_detail_2: '助数詞', basic_form: '分', reading: 'フン', pronunciation: 'フン', word_type: 'KNOWN' };
const SYN_NO = { surface_form: 'の', pos: '助詞', pos_detail_1: '連体化', pos_detail_2: '*', basic_form: 'の', reading: 'ノ', pronunciation: 'ノ', word_type: 'KNOWN' };

function readJapanese(rawTokens, opts) {
  const macrons = opts.macrons !== false;
  const tokens = fixTokens(rawTokens);
  const words = [];
  const last = () => words[words.length - 1];

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const s = t.surface_form;
    const prev = tokens[i - 1];

    if (/^\s+$/.test(s)) { if (last()) last().spaceAfter = true; continue; }

    // Runs of plain ASCII the dictionary does not know: Latin words, digits, ASCII punctuation.
    if (isAsciiTok(t)) {
      let run = s.normalize('NFKC');
      while (tokens[i + 1] && isAsciiTok(tokens[i + 1])) run += tokens[++i].surface_form.normalize('NFKC');
      const m = /^(.*?)([!?.,;:)\]]*)$/.exec(run);
      const lead = /^([(\[]*)(.*)$/.exec(m[1]);
      for (const ch of lead[1]) words.push({ kind: 'punct', surface: ch, romaji: ch });
      const body = lead[2];
      if (body) {
        if (/^\d[\d,]*(\.\d+)?$/.test(body)) words.push({ kind: 'number', surface: body, toks: [], numStr: body });
        else if (/^[^A-Za-z0-9]+$/.test(body)) words.push({ kind: 'punct', surface: body, romaji: body });
        else words.push({ kind: 'latin', surface: body, romaji: body });
      }
      for (const ch of m[2]) words.push({ kind: 'punct', surface: ch, romaji: ch });
      continue;
    }

    if (t.pos === '記号' || (t.word_type === 'UNKNOWN' && /^[\p{P}\p{S}]+$/u.test(s))) {
      const n = s.normalize('NFKC');
      words.push({ kind: 'punct', surface: s, romaji: PUNCT_MAP[s] ?? PUNCT_MAP[n] ?? n });
      continue;
    }

    // Numbers: consecutive number tokens become one word (二 + 十, 3 + 万).
    if (isNumTok(t)) {
      const w = last();
      if (w && w.kind === 'number' && !w.counter && !w.spaceAfter) { w.surface += s; w.numStr += s; w.toks.push(t); }
      else words.push({ kind: 'number', surface: s, numStr: s, toks: [t] });
      continue;
    }
    if (isCounterTok(t) && last() && last().kind === 'number' && !last().counter && !last().spaceAfter) {
      const w = last(); w.surface += s; w.counter = t; w.toks.push(t);
      continue;
    }

    if (s === '中' && last() && last().kind === 'number' && last().counter && !last().spaceAfter && /^(日|年|晩)$/.test(last().counter.surface_form) && parseNumber(last().numStr)?.value === 1) {
      last().surface += s; last().tail = 'ジュウ*'; last().tailNote = 'all ... long';
      continue;
    }

    // Does this token glue onto the word before it?
    const w = last();
    let attach = false;
    if (w && w.kind === 'word' && !w.spaceAfter) {
      const lt = w.toks[w.toks.length - 1];
      const inflecting = lt.pos === '動詞' || lt.pos === '形容詞' || lt.pos === '助動詞';
      if (w.prefixOnly) attach = true;                                             // お + 茶
      else if (lt.reading && lt.reading.endsWith('ッ')) attach = true;             // 行っ + た
      else if (t.pos === '助動詞' && inflecting && !/特殊・(デス|ダ)/.test(t.conjugated_type)) attach = true;
      else if (t.pos === '助詞' && t.pos_detail_1 === '接続助詞' && ATTACHING_PARTICLES.has(s) && inflecting) attach = true;
      else if (t.pos === '動詞' && t.pos_detail_1 === '接尾') attach = true;       // 食べ + られる
      else if (t.pos === '動詞' && t.pos_detail_1 === '非自立' && ((lt.pos === '動詞' && lt.conjugated_form === '連用形') || (lt.pos === '形容詞' && lt.conjugated_form === 'ガル接続'))) attach = true; // 食べ + すぎる, 高 + すぎる
    }
    if (attach) { w.toks.push(t); w.surface += s; if (w.prefixOnly) { w.prefixOnly = false; w.head = t; } continue; }
    words.push({ kind: 'word', surface: s, toks: [t], head: t, prefixOnly: t.pos === '接頭詞' });
  }

  // Fill in reading / romaji / pos / meaning per word.
  const out = [];
  for (let wi = 0; wi < words.length; wi++) {
    const w = words[wi];
    if (w.kind === 'punct') { out.push({ surface: w.surface, reading: '', romaji: w.romaji, pos: 'punct', _sp: w.spaceAfter }); continue; }
    if (w.kind === 'latin') { out.push({ surface: w.surface, reading: '', romaji: w.romaji, pos: 'foreign', _sp: w.spaceAfter, _keep: true }); continue; }

    if (w.kind === 'number') {
      const c = w.counter ? COUNTERS[w.counter.surface_form] : null;
      const num = parseNumber(w.numStr);
      let parts = null, counterUnits = null, meaning;
      if (w.counter) counterUnits = c ? U(c.k) : tokenUnits(w.counter, null) || [];
      if (num) {
        const v = num.value;
        const prevWord = words[wi - 1];
        const afterMonth = prevWord && /月$/.test(prevWord.surface);
        let whole = c && c.whole && !num.decimals ? c.whole[v] : null;
        if (w.counter && w.counter.surface_form === '日' && v === 1 && !num.decimals) whole = afterMonth ? 'ツイタチ' : 'イチニチ';
        if (whole) { parts = [whole]; counterUnits = []; }
        else {
          const alt = c && !num.decimals ? c.alt : null;
          parts = numberParts(v, alt);
          if (num.decimals) parts.push('テン', ...[...num.decimals].map((d) => DIG[+d]));
          else if (alt) {
            const key = v % 10 || (v % 100 ? 10 : 0);
            if (alt[key] && alt[key][1]) counterUnits = U(alt[key][1]);
          }
        }
        const shown = w.numStr.normalize('NFKC');
        const figure = /^\d/.test(shown) ? shown : String(v);
        if (!w.counter) meaning = figure;
        else if (w.counter.surface_form === '日' && afterMonth) meaning = `day ${figure} of the month`;
        else if (w.counter.surface_form === '月' && MONTHS[v - 1]) meaning = MONTHS[v - 1];
        else if (c) meaning = `${figure} ${label(c, v)}`;
      } else if (w.toks.every((t) => t.reading)) {
        // 何時, 数人 ...: not a number we can compute; use the dictionary readings. 何 takes the "3" sound changes.
        const numToks = w.toks.filter((t) => t !== w.counter);
        parts = [null];
        w._units = numToks.flatMap((t) => tokenUnits(t, null) || []);
        if (c && c.alt && c.alt[3] && c.alt[3][1] && w.numStr === '何') counterUnits = U(c.alt[3][1]);
        meaning = w.numStr === '何' && c ? `what / how many ${label(c, 2)}` : undefined;
      }
      let romaji, reading;
      if (!parts) { romaji = w.surface.normalize('NFKC'); reading = ''; }       // phone numbers and the like: left as digits
      else {
        const groups = w._units ? [w._units] : parts.map((p) => U(p));
        if (counterUnits && counterUnits.length) groups[groups.length - 1] = groups[groups.length - 1].concat(counterUnits);
        if (w.tail) { groups[groups.length - 1] = groups[groups.length - 1].concat(U(w.tail)); if (meaning) meaning += ', ' + w.tailNote; }
        romaji = groups.map((g) => romanise(g, macrons)).join(' ');
        reading = groups.map(unitsToHira).join('');
      }
      const word = { surface: w.surface, reading, romaji, pos: w.counter ? 'number + counter' : 'number', _sp: w.spaceAfter, _keep: !parts };
      if (gloss && !meaning && w.counter) meaning = lookupMeaning([w.surface, w.counter.surface_form], reading, ['ctr', 'suf', 'n']);
      if (opts.meanings !== false && meaning) word.meaning = meaning;
      out.push(word);
      continue;
    }

    // Ordinary word: one head token plus whatever glued onto it.
    let units = [], unread = false, readKana = '';
    for (let j = 0; j < w.toks.length; j++) {
      const u = tokenUnits(w.toks[j], w.toks[j - 1]);
      if (!u) { unread = true; break; }
      units = units.concat(u);
      const t = w.toks[j];
      readKana += t.reading && t.reading !== '*' ? t.reading : toKata(t.surface_form);
    }
    const h = w.head;
    let romaji = unread ? w.surface : romanise(units, macrons);
    if (!unread && h.pos === '名詞' && h.pos_detail_1 === '固有名詞') romaji = capitalise(romaji);
    const word = { surface: w.surface, reading: unread ? '' : toHira(readKana), romaji, pos: unread ? 'unknown' : posOf(h), _sp: w.spaceAfter, _keep: unread };
    if (h.basic_form && h.basic_form !== '*' && h.basic_form !== w.surface) word.base = h.basic_form;
    const forms = [];
    if (/^命令/.test(h.conjugated_form || '')) forms.push('imperative');
    for (const t of w.toks) {
      if (t === h) continue;
      const f = (t.pos === '助動詞' || t.pos_detail_1 === '接尾') ? FORM[t.basic_form] : t.pos === '助詞' ? FORM[t.surface_form] : null;
      if (f && !forms.includes(f)) forms.push(f);
    }
    if (forms.length) word.form = forms.join(', ');

    if (opts.meanings !== false && !unread) {
      let meaning;
      if (h.pos === '助詞') meaning = PARTICLE_BY_DETAIL[`${h.surface_form}|${h.pos_detail_2}`] || PARTICLE_BY_DETAIL[`${h.surface_form}|${h.pos_detail_1}`] || PARTICLE[h.surface_form];
      else if (h.pos === '助動詞') meaning = h.basic_form === 'だ' && h.surface_form === 'な' ? '(links a describing word to a noun)' : AUX[h.basic_form];
      else if (h.pos === '名詞' && h.pos_detail_1 === '非自立') meaning = PARTICLE_BY_DETAIL[`${h.surface_form}|非自立`];
      else if (h.pos === '動詞' && h.pos_detail_1 === '非自立') meaning = HELPER_VERB[h.basic_form];
      else if (h.pos === '動詞' && isHira(h.basic_form)) meaning = OWN_WORD[h.basic_form];
      if (!meaning && gloss) {
        // Reading of the dictionary form: swap the inflected ending of the reading for the base ending.
        let baseReading = toHira(h.reading || '');
        const sf = h.surface_form, bf = h.basic_form && h.basic_form !== '*' ? h.basic_form : sf;
        if (bf !== sf) {
          let p = 0; while (p < sf.length && p < bf.length && sf[p] === bf[p]) p++;
          const tail = toHira(sf.slice(p));
          baseReading = baseReading.endsWith(tail) ? baseReading.slice(0, baseReading.length - tail.length) + toHira(bf.slice(p)) : '';
        }
        const keys = w.toks[0].pos === '接頭詞' && w.toks.length > 1 ? [w.toks[0].surface_form + bf, bf] : [bf];
        if (!keys.includes(sf)) keys.push(sf);
        meaning = lookupMeaning(keys, baseReading, jmClasses(h));
      }
      if (!meaning && h.pos_detail_1 === '固有名詞') meaning = NAME_KIND[h.pos_detail_2];
      if (meaning) word.meaning = meaning;
    }
    out.push(word);
  }

  // The romaji line: words spaced, punctuation hugging its neighbour, sentence starts capitalised.
  let line = '';
  let startOfSentence = true, glueNext = false;
  for (const w of out) {
    let r = w.romaji;
    if (w.pos === 'punct') {
      if (r === ' ') { if (line && !line.endsWith(' ')) line += ' '; }
      else if (CLOSERS.has(r)) { line = line.trimEnd() + r; }
      else { if (line && !line.endsWith(' ') && !glueNext) line += ' '; line += r; }
      glueNext = OPENERS.has(r);
      if (r === '.' || r === '!' || r === '?') startOfSentence = true;
      continue;
    }
    if (startOfSentence && !w._keep) r = capitalise(r);
    startOfSentence = false;
    if (line && !line.endsWith(' ') && !glueNext) line += ' ';
    line += r;
    glueNext = false;
  }
  for (const w of out) { delete w._sp; delete w._keep; }
  return { romaji: line.trim(), words: out };
}

/**
 * @param {string} text  one line in the target language
 * @param {string} lang  'ja' (others: returns null in this prototype)
 * @param {{ macrons?: boolean, meanings?: boolean }} [opts]
 *        macrons false → long vowels spelled as in kana (toukyou); meanings false → skip the dictionary lookup
 * @returns {Promise<{ romaji: string, words: Array<{ surface: string, reading: string, romaji: string, pos: string, base?: string, form?: string, meaning?: string }> } | null>}
 */
export async function readLine(text, lang, opts = {}) {
  if (lang !== 'ja' || typeof text !== 'string') return null;
  touch();
  const tokenizer = await loadTokenizer().catch((e) => { tokenizerPromise = null; throw e; });
  if (gloss === null && opts.meanings !== false) loadGloss('common');
  return readJapanese(tokenizer.tokenize(text), opts);
}

export const _internals = { romanise, U, numberParts, parseNumber, toHira, toKata };
