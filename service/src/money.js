// Money in a spoken line: which amounts, which currencies, and what he wants converted.
// Pure functions (no network, no clock), so every rule here is tested: __tests__/money.test.js.
//
// Why this exists (2026-11-19): the currency tool knew dollars, euros and pounds only. Asked
// for yen in dollars it fetched the dollar to euro rate, the model did the sum itself, and
// 1,800 yen and 3,000 yen both came out as 16.5 dollars. The rule now: the code works out
// which sum is asked and does it; the model only says the result.

// Every currency the rate source (Frankfurter, European Central Bank rates) carries.
export const CODES = ['AUD', 'BRL', 'CAD', 'CHF', 'CNY', 'CZK', 'DKK', 'EUR', 'GBP', 'HKD', 'HUF', 'IDR', 'ILS', 'INR', 'ISK',
  'JPY', 'KRW', 'MXN', 'MYR', 'NOK', 'NZD', 'PHP', 'PLN', 'RON', 'SEK', 'SGD', 'THB', 'TRY', 'USD', 'ZAR'];

// How people say them. Longer names first, so "australian dollars" is not read as "dollars".
const NAMES = [
  ['australian dollars?|aussie dollars?', 'AUD'], ['canadian dollars?', 'CAD'], ['new zealand dollars?|kiwi dollars?', 'NZD'],
  ['hong kong dollars?', 'HKD'], ['singapore dollars?', 'SGD'], ['us dollars?|u s dollars?|american dollars?', 'USD'],
  ['swiss francs?', 'CHF'], ['mexican pesos?', 'MXN'], ['philippine pesos?', 'PHP'], ['brazilian reals?|reais', 'BRL'],
  ['indian rupees?', 'INR'], ['indonesian rupiahs?|rupiahs?', 'IDR'], ['turkish liras?', 'TRY'], ['south african rands?', 'ZAR'],
  ['danish kron(?:e|er)', 'DKK'], ['norwegian kron(?:e|er)', 'NOK'], ['swedish kron(?:a|or)', 'SEK'], ['icelandic kron(?:a|ur)', 'ISK'],
  ['british pounds?|pounds? sterling', 'GBP'], ['japanese yen', 'JPY'], ['chinese yuan', 'CNY'], ['korean won', 'KRW'],
  ['dollars?|bucks?', 'USD'], ['euros?', 'EUR'], ['pounds?|quid', 'GBP'], ['yen', 'JPY'], ['yuan|renminbi|rmb', 'CNY'],
  ['won', 'KRW'], ['rupees?', 'INR'], ['pesos?', 'MXN'], ['francs?', 'CHF'], ['liras?', 'TRY'], ['rands?', 'ZAR'], ['baht', 'THB'],
  ['zloty|zlotys', 'PLN'], ['kron(?:a|or)', 'SEK'], ['kron(?:e|er)', 'NOK'], ['shekels?', 'ILS'], ['forints?', 'HUF'],
  ['ringgits?', 'MYR'], ['korun(?:a|y)', 'CZK'], ['leu|lei', 'RON'],
  ...CODES.map((c) => [c.toLowerCase(), c]),
];
const SYMBOLS = { '$': 'USD', '€': 'EUR', '£': 'GBP', '¥': 'JPY', '₹': 'INR', '₩': 'KRW' };
const NAME_RE = new RegExp(`\\b(?:${NAMES.map(([n]) => n).join('|')})\\b`, 'gi');
function codeOf(word) {
  const w = word.toLowerCase();
  for (const [pattern, code] of NAMES) if (new RegExp(`^(?:${pattern})$`).test(w)) return code;
  return null;
}

const ONES = { zero: 0, a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
const TENS = { twenty: 20, thirty: 30, forty: 40, fourty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const SCALES = { hundred: 100, thousand: 1e3, grand: 1e3, k: 1e3, million: 1e6, mil: 1e6, billion: 1e9, trillion: 1e12 };
const NUMBER_WORD = new RegExp(`^(?:${[...Object.keys(ONES), ...Object.keys(TENS), ...Object.keys(SCALES), 'and', 'half', 'point'].join('|')})$`);

/**
 * A spoken or written number as a number: "three million", "eighteen hundred", "1,800",
 * "200 million", "2.5k", "one thousand eight hundred", "half a million". null when it is not one.
 */
export function parseNumber(words) {
  const tokens = String(words || '').toLowerCase().replace(/(\d),(?=\d{3}\b)/g, '$1').replace(/-/g, ' ')
    .replace(/(\d)(k|m|mil|bn)\b/g, (_, d, s) => `${d} ${s === 'k' ? 'thousand' : s === 'bn' ? 'billion' : 'million'}`)
    .split(/\s+/).filter(Boolean);
  if (!tokens.length) return null;
  let total = 0;      // finished groups (thousands, millions)
  let group = 0;      // the group being built, under a thousand (or "eighteen hundred")
  let seen = false;
  let half = false;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === 'and') continue;
    if (t === 'half') { half = true; seen = true; continue; }
    if (t === 'point') {
      const digits = tokens.slice(i + 1).map((d) => (d in ONES && ONES[d] < 10 ? String(ONES[d]) : /^\d$/.test(d) ? d : null));
      if (!digits.length || digits.includes(null)) return null;
      group += Number(`0.${digits.join('')}`);
      seen = true;
      break;
    }
    if (/^\d+(?:\.\d+)?$/.test(t)) { group += Number(t); seen = true; continue; }
    if (t in ONES) {
      if ((t === 'a' || t === 'an') && half) continue;      // "half a million"
      group += ONES[t]; seen = true; continue;
    }
    if (t in TENS) { group += TENS[t]; seen = true; continue; }
    if (t in SCALES) {
      const scale = SCALES[t];
      if (half && group === 0) { group = 0.5; half = false; }
      if (scale === 100) group = (group || 1) * 100;
      else { total += (group || 1) * scale; group = 0; }
      seen = true;
      continue;
    }
    return null;
  }
  if (!seen) return null;
  if (half && total === 0 && group === 0) return null;
  return total + group;
}

/**
 * Every currency named in the line, in order, each with the amount said next to it (or null):
 * "three thousand yen" -> { amount: 3000, code: 'JPY' }, "in dollars" -> { amount: null, code: 'USD' }.
 */
export function moneyMentions(text) {
  // "u s d", "u.s.d." -> usd, the way a phone's speech to text spells it.
  const line = String(text || '').replace(/\bu\.?\s?s\.?\s?d\b\.?/gi, 'usd').replace(/[?!]/g, ' ');
  const out = [];
  for (const m of line.matchAll(/([$€£¥₹₩])\s?(\d[\d,]*(?:\.\d+)?(?:\s?(?:k|m|mil|bn|hundred|thousand|million|billion))?)/gi)) {
    const amount = parseNumber(m[2]);
    if (amount != null) out.push({ amount, code: SYMBOLS[m[1]], at: m.index });
  }
  for (const m of line.matchAll(NAME_RE)) {
    const code = codeOf(m[0]);
    if (!code) continue;
    // Pounds of weight are not money: "a pound of flour", "I lost ten pounds", "180 pounds in kilos".
    if (code === 'GBP' && /^(?:pounds?)$/i.test(m[0]) && (/^\s+of\b/i.test(line.slice(m.index + m[0].length)) || WEIGHT.test(line))) continue;
    // The number just before the name: as many number words (or digits) as sit there.
    const before = line.slice(0, m.index).replace(/[.,;:]+\s*$/, ' ').trimEnd().split(/\s+/);
    const taken = [];
    while (before.length) {
      const w = before[before.length - 1].toLowerCase().replace(/^[^\w.]+|[^\w]+$/g, '');
      const isNumber = /^\d[\d,]*(?:\.\d+)?(?:k|m|mil|bn)?$/.test(w) || NUMBER_WORD.test(w);
      if (!isNumber) break;
      taken.unshift(w);
      before.pop();
    }
    // "a" and "and" alone are not numbers ("a dollar" is, "and dollars" is not).
    while (taken.length && (taken[0] === 'and' || taken[0] === 'point')) taken.shift();
    let amount = taken.length ? parseNumber(taken.join(' ')) : null;
    if (taken.length === 1 && (taken[0] === 'a' || taken[0] === 'an')) amount = 1;
    out.push({ amount: amount != null && amount > 0 ? amount : null, code, at: m.index });
  }
  out.sort((a, b) => a.at - b.at);
  return out.map(({ amount, code }) => ({ amount, code }));
}

const WEIGHT = /\b(kilos?|kilograms?|kg|weigh(?:s|t|ed)?|lbs?|heavy|heavier|lose|lost|gain(?:ed)?|ounces?|grams?)\b/i;
const ASKS = /\b(how much|how many|what about|how about|what is|what's|whats|what would|convert|worth|exchange rate|conversion rate|the rate|equal|equals|come to|comes to)\b|\?\s*$/i;
const POINTS_BACK = /\b(that|this|it|those|these)\b/i;

/**
 * The sums a line asks for: [{ amount, from, to }], empty when it asks for none.
 * `recent` is the talk before this line, oldest first (plain strings, either speaker).
 * `home` is the currency he thinks in, used when a line names one foreign amount and nothing else.
 *
 *  A  an amount and another currency          "three million yen to usd"      3,000,000 JPY -> USD
 *  B  points back, names one currency         "so what is that, thirty bucks" the last other amount in the talk -> USD
 *  C  amounts in one currency, asking         "what about fifty thousand yen" 50,000 JPY -> the talk's other currency, else home
 *  D  two currencies, no amount               "yen to dollars"                1 JPY -> USD
 */
export function moneyAsk(text, recent = [], home = 'USD') {
  const mentions = moneyMentions(text);
  if (!mentions.length) return [];
  const withAmount = mentions.filter((m) => m.amount != null);
  const codes = [...new Set(mentions.map((m) => m.code))];

  // What the talk was converting: the last earlier line that asked for a sum by itself.
  const lines = [...(recent || [])].slice(-8);
  let talk = null;
  for (let i = lines.length - 1; i >= 0 && !talk; i--) {
    const [ask] = moneyAsk(lines[i], [], home);
    if (ask) talk = { from: ask.from, to: ask.to };
  }
  const earlier = [];
  for (const line of [...lines].reverse()) earlier.push(...moneyMentions(line).reverse());

  // A
  if (withAmount.length && codes.length >= 2) {
    const asks = [];
    for (const m of withAmount) {
      // "is 3000 yen about 19 dollars": the second amount is his guess, not a second sum.
      if (asks.length && asks[0].to === m.code) continue;
      const to = (mentions.find((x) => x.code !== m.code && x.amount == null) || mentions.find((x) => x.code !== m.code)).code;
      asks.push({ amount: m.amount, from: m.code, to });
    }
    return dedupe(asks);
  }
  if (codes.length === 1) {
    const code = codes[0];
    // B: "that" is the last amount in the talk in another currency. Not when the line's own
    // currency is the one the talk converts FROM: then its amounts are the sums he wants (C).
    if (POINTS_BACK.test(text) && withAmount.length <= 1 && !(talk && talk.from === code)) {
      const referent = earlier.find((m) => m.amount != null && m.code !== code);
      if (referent) return [{ amount: referent.amount, from: referent.code, to: code }];
    }
    // C: in a talk about money every amount named gets its sum; outside one, only an ask does.
    if (withAmount.length && (talk || ASKS.test(text))) {
      const to = talk ? (code === talk.from ? talk.to : talk.from)
        : (earlier.find((m) => m.code !== code) || {}).code || (code !== home ? home : null);
      if (to && to !== code) return dedupe(withAmount.slice(0, 3).map((m) => ({ amount: m.amount, from: m.code, to })));
    }
    return [];
  }
  // D
  if (!withAmount.length && codes.length >= 2 && ASKS.test(text)) return [{ amount: 1, from: codes[0], to: codes[1] }];
  return [];
}

function dedupe(asks) {
  const seen = new Set();
  return asks.filter((a) => {
    const key = `${a.amount}|${a.from}|${a.to}`;
    if (a.from === a.to || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** A sum of money the way it is said: no decimals from a hundred up, two below. */
export function sayAmount(n) {
  const v = Math.abs(n) >= 100 ? Math.round(n) : Math.round(n * 100) / 100;
  return v.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

/**
 * The block the model reads: each sum already done. `rates` is { 'JPY>USD': 0.0062511, ... }.
 * '' when a rate is missing.
 */
export function moneyBlock(asks, rates, date) {
  const lines = [];
  for (const a of asks) {
    const rate = rates[`${a.from}>${a.to}`];
    if (!(rate > 0)) return '';
    lines.push(`- ${sayAmount(a.amount)} ${a.from} = ${sayAmount(a.amount * rate)} ${a.to}`);
  }
  if (!lines.length) return '';
  const first = asks[0];
  const rate = rates[`${first.from}>${first.to}`];
  const per = rate < 1 ? `1 ${first.to} = ${sayAmount(1 / rate)} ${first.from}` : `1 ${first.from} = ${sayAmount(rate)} ${first.to}`;
  return `\nEXCHANGE RATE (European Central Bank${date ? `, ${date}` : ''}) - real data. The sums are already done: say these figures and do no arithmetic of your own. If an earlier answer in this talk gave a different figure, that answer was wrong: say so plainly and give these.\n`
    + `${lines.join('\n')}\n- the rate: ${per}\n`;
}
