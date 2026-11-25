// Sums a voice model must never do in its head: plain arithmetic said out loud. The code reads the
// sum the line asks for, works it out, and writes the words to say, the same way sums.js does unit
// sums and money.js does money. Pure functions, tested in __tests__/arith.test.js.
//
// Why (2026-11-24): on a person's device "what is seven times eight" was answered "That's fourteen."
// Nothing in the lookups handled arithmetic, so the small model made the figure up.
//
// How a line is read: number words become numbers (money.js parseNumber), the words that say an
// operation become operators, and the words people put around a sum ("what's", "is", "please") are
// dropped. If anything else is left, the line is not a sum and nothing is answered here: "I worked
// seven days times twelve hours" keeps "worked", "days", "hours", so it is left to the model.
// No eval: a small parser over the tokens, with the usual precedence.
import { parseNumber } from './money.js';
import { sayNumber } from './sums.js';

const NUM_WORDS = new Set(['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
  'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty', 'thirty', 'forty', 'fifty', 'sixty',
  'seventy', 'eighty', 'ninety', 'hundred', 'thousand', 'million', 'billion', 'trillion', 'point']);
const SCALE_WORDS = new Set(['hundred', 'thousand', 'million', 'billion', 'trillion']);

// Operation words, longest first. [words, token]
const OPS = [
  ['to the power of', { op: '^' }], ['multiplied by', { op: '*' }], ['divided by', { op: '/' }], ['added to', { op: '+' }],
  ['take away', { op: '-' }], ['square root of', { pre: 'sqrt' }], ['the square root of', { pre: 'sqrt' }],
  ['percent of', { post: 'pct', then: '*' }], ['per cent of', { post: 'pct', then: '*' }],
  ['half of', { pre: 'half' }], ['a half of', { pre: 'half' }], ['a third of', { pre: 'third' }], ['one third of', { pre: 'third' }],
  ['a quarter of', { pre: 'quarter' }], ['one quarter of', { pre: 'quarter' }], ['three quarters of', { pre: 'threeq' }],
  ['plus', { op: '+' }], ['minus', { op: '-' }], ['times', { op: '*' }], ['x', { op: '*' }], ['over', { op: '/' }],
  ['squared', { post: 'sq' }], ['cubed', { post: 'cube' }], ['percent', { post: 'pct' }],
  ['double', { pre: 'double' }], ['twice', { pre: 'double' }], ['triple', { pre: 'triple' }],
].map(([w, t]) => [w.split(' '), t]);

// Words said around a sum. Only these may be left over; anything else means the line is not a sum.
const FILLER = new Set(['what', 'whats', 'what\'s', 'is', 'are', 'how', 'much', 'equal', 'equals', 'make', 'makes', 'the', 'answer', 'to',
  'calculate', 'compute', 'work', 'figure', 'tell', 'me', 'can', 'you', 'could', 'please', 'pan', 'hey', 'ok', 'okay', 'so',
  'quick', 'question', 'do', 'know', 'exactly', 'again', 'for', 'um', 'uh', 'hmm', 'now', 'then', 'actually', 'real', 'quickly']);

const PRE_SAID = { sqrt: 'the square root of', half: 'half of', third: 'a third of', quarter: 'a quarter of', threeq: 'three quarters of',
  double: 'double', triple: 'triple' };
const OP_SAID = { '+': 'plus', '-': 'minus', '*': 'times', '/': 'divided by', '^': 'to the power of' };

/** The line as a list of tokens: numbers, operators, and the words that are neither. */
export function tokens(text) {
  let line = String(text || '').toLowerCase()
    .replace(/(\d),(?=\d{3}\b)/g, '$1')
    .replace(/(\d)\s*%/g, '$1 percent ')
    .replace(/(\d)\s*[x×*]\s*(?=\d)/g, '$1 times ')
    .replace(/(\d)\s*[÷/]\s*(?=\d)/g, '$1 divided by ')
    .replace(/(\d)\s*\+\s*(?=\d)/g, '$1 plus ')
    .replace(/(\d)\s+[-−]\s+(?=\d)/g, '$1 minus ')
    .replace(/(\d)\s*\^\s*(?=\d)/g, '$1 to the power of ')
    .replace(/(?<=[a-z])-(?=[a-z])/g, ' ')
    .replace(/[?!,;:"“”]+/g, ' ')
    .replace(/\.(?!\d)/g, ' ');
  const words = line.split(/\s+/).filter(Boolean);
  const out = [];
  for (let i = 0; i < words.length;) {
    // "subtract five from twelve" / "add five and seven" / "multiply five by seven" / "divide ten by four"
    const lead = { subtract: ['from', '-', true], add: ['and', '+', false], multiply: ['by', '*', false], divide: ['by', '/', false] }[words[i]];
    if (lead) { out.push({ lead: words[i], join: lead[0], op: lead[1], swap: lead[2] }); i++; continue; }
    if (words[i] === 'sum' && words[i + 1] === 'of') { out.push({ lead: 'add', join: 'and', op: '+', swap: false }); i += 2; continue; }
    if (words[i] === 'product' && words[i + 1] === 'of') { out.push({ lead: 'multiply', join: 'and', op: '*', swap: false }); i += 2; continue; }
    const hit = OPS.find(([ws]) => ws.every((w, k) => words[i + k] === w));
    if (hit && !(hit[0][0] === 'x' && !(out.length && out[out.length - 1].num !== undefined))) {
      out.push({ ...hit[1] }); i += hit[0].length; continue;
    }
    // a run of number words: "one hundred and five", "twenty four point five"
    if (/^\d+(?:\.\d+)?$/.test(words[i]) || NUM_WORDS.has(words[i]) || ((words[i] === 'a' || words[i] === 'an') && SCALE_WORDS.has(words[i + 1]))) {
      const run = [words[i]];
      let j = i + 1;
      while (j < words.length) {
        const w = words[j];
        // "and" belongs to the number only after a scale word: "one hundred and five"; else it joins two numbers
        if (w === 'and' && SCALE_WORDS.has(run[run.length - 1]) && NUM_WORDS.has(words[j + 1] || '')) { run.push(w); j++; continue; }
        if (NUM_WORDS.has(w) && !/^\d/.test(run[run.length - 1])) { run.push(w); j++; continue; }
        if (/^\d+(?:\.\d+)?$/.test(w) && run[run.length - 1] === 'point') { run.push(w); j++; continue; }
        if (SCALE_WORDS.has(w) && /^\d/.test(run[run.length - 1])) { run.push(w); j++; continue; }   // "3 million"
        break;
      }
      const n = parseNumber(run.join(' '));
      if (n == null) return null;
      out.push({ num: n }); i = j; continue;
    }
    out.push({ word: words[i] }); i++;
  }
  return out;
}

/**
 * The sum a line asks for: { tree, value } or null. `tree` is what was asked, `value` the answer
 * (NaN for a sum with no answer, such as dividing by zero).
 */
export function arithAsk(text) {
  const toks = tokens(text);
  if (!toks) return null;
  // the lead forms: "subtract A from B" -> B - A, "add A and B" -> A + B
  const seq = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.lead) {
      const k = toks.findIndex((u, j) => j > i && u.word === t.join);
      if (k < 0) return null;
      const a = toks.slice(i + 1, k), b = toks.slice(k + 1);
      const end = b.findIndex((u) => u.word && !FILLER.has(u.word));
      const bb = end < 0 ? b : b.slice(0, end);
      const [x, y] = t.swap ? [bb, a] : [a, bb];
      seq.push({ open: true }, ...x, { op: t.op }, ...y, { close: true });
      i = k + bb.length;
      continue;
    }
    if (t.word) {
      if (t.word === 'and' && seq.length && seq[seq.length - 1].num !== undefined) return null;   // "two and three" with no operation
      // "out" only in "work out" / "figure out": "seven times out of ten" is not a sum
      const prev = toks[i - 1]?.word;
      if (!FILLER.has(t.word) && !(t.word === 'out' && (prev === 'work' || prev === 'figure'))) return null;
      continue;
    }
    seq.push(t);
  }
  const ops = seq.filter((t) => t.op || t.pre || t.post);
  if (!ops.length || !seq.some((t) => t.num !== undefined)) return null;
  // a bare "percent" with no operation is a figure, not a sum ("battery at forty percent")
  if (ops.every((t) => t.post === 'pct' && !t.then)) return null;

  let p = 0;
  const peek = () => seq[p];
  const fail = () => { throw new Error('not a sum'); };
  function primary() {
    const t = peek();
    if (!t) fail();
    if (t.open) { p++; const e = expr(); if (!peek()?.close) fail(); p++; return e; }
    if (t.pre) { p++; return { pre: t.pre, arg: postfix(primary()) }; }
    if (t.num !== undefined) { p++; return { num: t.num }; }
    return fail();
  }
  function postfix(node) {
    while (peek()?.post) {
      const t = seq[p++];
      node = { post: t.post, arg: node };
      if (t.then) { const right = power(); node = { op: '*', l: node, r: right, of: true }; }
    }
    return node;
  }
  function power() {
    const base = postfix(primary());
    if (peek()?.op === '^') { p++; return { op: '^', l: base, r: power() }; }
    return base;
  }
  function term() {
    let l = power();
    while (peek()?.op === '*' || peek()?.op === '/') { const op = seq[p++].op; l = { op, l, r: power() }; }
    return l;
  }
  function expr() {
    let l = term();
    while (peek()?.op === '+' || peek()?.op === '-') { const op = seq[p++].op; l = { op, l, r: term() }; }
    return l;
  }
  let tree;
  try { tree = expr(); if (p !== seq.length) return null; } catch { return null; }
  const value = evaluate(tree);
  if (value === null) return null;
  return { tree, value };
}

function evaluate(n) {
  if (n.num !== undefined) return n.num;
  if (n.pre) {
    const a = evaluate(n.arg);
    return { sqrt: a < 0 ? NaN : Math.sqrt(a), half: a / 2, third: a / 3, quarter: a / 4, threeq: a * 0.75, double: a * 2, triple: a * 3 }[n.pre];
  }
  if (n.post) {
    const a = evaluate(n.arg);
    return { sq: a * a, cube: a * a * a, pct: a / 100 }[n.post];
  }
  const l = evaluate(n.l), r = evaluate(n.r);
  switch (n.op) {
    case '+': return l + r;
    case '-': return l - r;
    case '*': return l * r;
    case '/': return r === 0 ? NaN : l / r;
    case '^': return Math.abs(r) > 64 ? null : l ** r;
    default: return null;
  }
}

/** The sum as it is said: "seven times eight", "twenty percent of eighty-five". */
export function sayTree(n) {
  if (n.num !== undefined) return sayNumber(n.num);
  if (n.pre) return `${PRE_SAID[n.pre]} ${sayTree(n.arg)}`;
  if (n.post === 'sq') return `${sayTree(n.arg)} squared`;
  if (n.post === 'cube') return `${sayTree(n.arg)} cubed`;
  if (n.post === 'pct') return `${sayTree(n.arg)} percent`;
  if (n.of) return `${sayTree(n.l)} of ${sayTree(n.r)}`;
  return `${sayTree(n.l)} ${OP_SAID[n.op]} ${sayTree(n.r)}`;
}

const figure = (v) => (Math.abs(v) >= 1000 ? Math.round(v) : Math.abs(v) >= 10 ? Math.round(v * 10) / 10 : Math.round(v * 100) / 100)
  .toLocaleString('en-US', { maximumFractionDigits: 2 });

/** The block the model reads: the sum done, and the words to say. '' when there is no sum. */
export function arithBlock(ask) {
  if (!ask) return '';
  const head = '\nSUM - done by code, it is exact. Use the words after "Out loud" as they are: do no arithmetic and do not spell any number yourself.\n';
  const asked = sayTree(ask.tree);
  if (!Number.isFinite(ask.value)) {
    return head + `- ${asked}: no answer. Out loud: "${asked} has no answer"\n`;
  }
  if (Math.abs(ask.value) >= 1e15) return '';
  const v = Math.abs(ask.value) < 1e-9 ? 0 : ask.value;
  const shown = Math.abs(v) >= 1000 ? Math.round(v) : Math.abs(v) >= 10 ? Math.round(v * 10) / 10 : Math.round(v * 100) / 100;
  const about = Math.abs(shown - v) > 1e-9 * Math.max(1, Math.abs(v)) ? 'about ' : '';
  return head + `- ${asked} = ${figure(v)}. Out loud: "${asked} is ${about}${sayNumber(v)}"\n`;
}
