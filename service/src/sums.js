// Sums a voice model must never do itself: a measurement in another unit. The code reads which
// sum the line asks for, does it, and writes the words to say. Pure functions, tested in
// __tests__/sums.test.js.
//
// Why (right-answer bench, 2026-11-19): asked out loud, the hub model said a marathon is 23
// kilometres, 38 Celsius is 101.6 Fahrenheit and ten stone is 70 kilos. 7 of 16 unit sums wrong.
import { parseNumber, numberWords } from './money.js';

// [names as said (regex), kind, how many base units one is, said for one, said for many, (offset for temperature)]
// Base units: metre, kilogram, litre, square metre, metre per second, kelvin.
const UNITS = [
  // speed first: "miles an hour" must not be read as "miles"
  ['miles? (?:an|per) hour|mph', 'speed', 0.44704, 'mile an hour', 'miles an hour'],
  ['kilomet(?:re|er)s? (?:an|per) hour|kph|km/h|kmh', 'speed', 1 / 3.6, 'kilometre an hour', 'kilometres an hour'],
  ['met(?:re|er)s? (?:a|per) second', 'speed', 1, 'metre per second', 'metres per second'],
  ['knots?', 'speed', 0.514444, 'knot', 'knots'],
  // area
  ['square kilomet(?:re|er)s?|sq(?:uare)? km', 'area', 1e6, 'square kilometre', 'square kilometres'],
  ['square met(?:re|er)s?|sq(?:uare)? m\\b', 'area', 1, 'square metre', 'square metres'],
  ['square miles?', 'area', 2589988.11, 'square mile', 'square miles'],
  ['square (?:feet|foot)|sq(?:uare)? ft', 'area', 0.09290304, 'square foot', 'square feet'],
  ['acres?', 'area', 4046.8564224, 'acre', 'acres'],
  ['hectares?', 'area', 10000, 'hectare', 'hectares'],
  // length
  ['nautical miles?', 'length', 1852, 'nautical mile', 'nautical miles'],
  ['kilomet(?:re|er)s?|km|klicks?', 'length', 1000, 'kilometre', 'kilometres'],
  ['centimet(?:re|er)s?|cm', 'length', 0.01, 'centimetre', 'centimetres'],
  ['millimet(?:re|er)s?|mm', 'length', 0.001, 'millimetre', 'millimetres'],
  ['met(?:re|er)s?', 'length', 1, 'metre', 'metres'],
  ['miles?', 'length', 1609.344, 'mile', 'miles'],
  ['yards?', 'length', 0.9144, 'yard', 'yards'],
  ['feet|foot|ft', 'length', 0.3048, 'foot', 'feet'],
  ['inch(?:es)?', 'length', 0.0254, 'inch', 'inches'],
  // weight
  ['kilograms?|kilos?|kg', 'weight', 1, 'kilo', 'kilos'],
  ['milligrams?|mg', 'weight', 1e-6, 'milligram', 'milligrams'],
  ['grams?', 'weight', 0.001, 'gram', 'grams'],
  ['pounds?|lbs?', 'weight', 0.45359237, 'pound', 'pounds'],
  ['stones?', 'weight', 6.35029318, 'stone', 'stone'],
  ['tonnes?|metric tons?', 'weight', 1000, 'tonne', 'tonnes'],
  // volume (US kitchen measures)
  ['millilit(?:re|er)s?|ml', 'volume', 0.001, 'millilitre', 'millilitres'],
  ['lit(?:re|er)s?', 'volume', 1, 'litre', 'litres'],
  ['tablespoons?|tbsp', 'volume', 0.0147868, 'tablespoon', 'tablespoons'],
  ['teaspoons?|tsp', 'volume', 0.00492892, 'teaspoon', 'teaspoons'],
  ['fluid ounces?|fl oz', 'volume', 0.0295735, 'fluid ounce', 'fluid ounces'],
  ['gallons?', 'volume', 3.785411784, 'gallon', 'gallons'],
  ['quarts?', 'volume', 0.946352946, 'quart', 'quarts'],
  ['pints?', 'volume', 0.473176473, 'pint', 'pints'],
  ['cups?', 'volume', 0.2365882365, 'cup', 'cups'],
  // an ounce is a weight, or a measure of liquid when the other side is one
  ['ounces?|oz', 'weight', 0.028349523, 'ounce', 'ounces'],
  // temperature: kelvin = value * scale + offset
  ['(?:degrees? )?(?:celsius|centigrade)|degrees c\\b', 'heat', 1, 'degree Celsius', 'degrees Celsius', 273.15],
  ['(?:degrees? )?fahrenheit|degrees f\\b', 'heat', 5 / 9, 'degree Fahrenheit', 'degrees Fahrenheit', 459.67 * 5 / 9],
  ['kelvins?', 'heat', 1, 'kelvin', 'kelvin', 0],
].map(([names, kind, scale, one, many, offset]) => ({ names, test: new RegExp(`^(?:${names})$`, 'i'), kind, scale, one, many, offset: offset || 0 }));
const FLUID_OUNCE = UNITS.find((u) => u.one === 'fluid ounce');
const UNIT_RE = new RegExp(`(?<![a-z])(?:${UNITS.map((u) => u.names).join('|')})(?![a-z])`, 'gi');
const NUMBER_WORD = /^(?:\d[\d,]*(?:\.\d+)?|zero|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion|and|half|point)$/;

/** The units named in a line, in order, each with the amount said just before it (or null). */
export function unitMentions(text) {
  const line = String(text || '').replace(/[?!]/g, ' ').replace(/(?<=[a-z])-(?=[a-z])/gi, ' ');
  const out = [];
  for (const m of line.matchAll(UNIT_RE)) {
    const unit = UNITS.find((u) => u.test.test(m[0]));
    if (!unit) continue;
    const before = line.slice(0, m.index).replace(/[.,;:]+\s*$/, ' ').trimEnd().split(/\s+/);
    const taken = [];
    while (before.length) {
      const w = before[before.length - 1].toLowerCase().replace(/^[^\w.]+|[^\w]+$/g, '');
      if (!NUMBER_WORD.test(w)) break;
      taken.unshift(w.replace(/-/g, ' '));
      before.pop();
    }
    // "twenty-four" arrives as one word with a hyphen
    const words = taken.join(' ').split(/\s+/).filter(Boolean);
    while (words.length && (words[0] === 'and' || words[0] === 'point')) words.shift();
    let amount = words.length ? parseNumber(words.join(' ')) : null;
    if (words.length === 1 && (words[0] === 'a' || words[0] === 'an')) amount = 1;
    out.push({ unit, amount: amount != null ? amount : null, minus: /\b(?:minus|negative)\s*$/i.test(before.join(' ')) });
  }
  return out;
}

const ASKS = /\b(?:how many|how much|how (?:tall|long|far|heavy|hot|cold|fast|big)|what is|what's|whats|what would|convert|equals?|in|to|into)\b/i;

/**
 * The unit sum a line asks for: { amount, from, to } (units), or null.
 * One amount in one unit, one other unit of the same kind with no amount:
 * "forty kilometres in miles", "how many miles is forty kilometres", "how many square metres in an acre".
 * Not a sum: one unit only ("how many kilometres is a marathon"), or two kinds
 * ("how many cups is two hundred grams of flour": that needs to know the flour).
 */
export function unitAsk(text) {
  if (!ASKS.test(String(text || ''))) return null;
  let mentions = unitMentions(text);
  if (mentions.length < 2) return null;
  // an ounce beside a measure of liquid is a fluid ounce
  if (mentions.some((m) => m.unit.kind === 'volume')) mentions = mentions.map((m) => (m.unit.one === 'ounce' ? { ...m, unit: FLUID_OUNCE } : m));
  const withAmount = mentions.filter((m) => m.amount != null);
  const bare = mentions.filter((m) => m.amount == null);
  if (withAmount.length !== 1 || !bare.length) return null;
  const from = withAmount[0];
  const to = bare.find((m) => m.unit !== from.unit && m.unit.kind === from.unit.kind);
  if (!to) return null;
  return { amount: from.minus ? -from.amount : from.amount, from: from.unit, to: to.unit };
}

export function convert(amount, from, to) {
  return (amount * from.scale + from.offset - to.offset) / to.scale;
}

/** A measurement the way it is said: whole from a thousand up, one decimal from ten, two below. */
export function sayNumber(n) {
  const v = Math.abs(n);
  const rounded = v >= 1000 ? Math.round(v) : v >= 10 ? Math.round(v * 10) / 10 : Math.round(v * 100) / 100;
  const [whole, frac] = String(rounded).split('.');
  const words = numberWords(Number(whole)) + (frac ? ' point ' + [...frac].map((d) => numberWords(Number(d))).join(' ') : '');
  return (n < 0 && rounded !== 0 ? 'minus ' : '') + words;
}
const figure = (n) => (Math.abs(n) >= 1000 ? Math.round(n) : Math.abs(n) >= 10 ? Math.round(n * 10) / 10 : Math.round(n * 100) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 });
const named = (n, unit) => (Math.abs(n) === 1 ? unit.one : unit.many);

/** The block the model reads: the sum done, in figures and in the words to say. '' when there is no sum. */
export function unitBlock(ask) {
  if (!ask) return '';
  const got = convert(ask.amount, ask.from, ask.to);
  if (!Number.isFinite(got)) return '';
  const said = `${sayNumber(ask.amount)} ${named(ask.amount, ask.from)} is ${Math.abs(got - Math.round(got)) < 1e-6 ? '' : 'about '}${sayNumber(got)} ${named(got, ask.to)}`;
  return '\nUNIT SUM - done by code, it is exact. Use the words after "Out loud" as they are: do no arithmetic and do not spell any number yourself.\n'
    + `- ${figure(ask.amount)} ${named(ask.amount, ask.from)} = ${figure(got)} ${named(got, ask.to)}. Out loud: "${said}"\n`;
}

// ---- the figure the code worked out must be the figure that is said ---------------------------
// The blocks above (and the money and calendar ones) end each sum with: Out loud: "...". The model
// is told to use those words, and mostly does. Twice in 66 answers it did not: handed "one thousand
// seven hundred fifty dollars" it said "thirteen hundred fifty", handed a sum of 262 dollars it
// said 512 (right-answer bench, Craft 27, 2026-11-19). So the reply is checked before it is spoken.

/** The finished sentences in a block. */
export function outLoud(block) {
  return [...String(block || '').matchAll(/Out loud: "([^"]+)"/g)].map((m) => m[1]);
}
const plainWords = (s) => String(s || '').toLowerCase().replace(/[-–]/g, ' ').replace(/[^\p{L}\p{N}. ]+/gu, ' ').replace(/\.(?!\d)/g, ' ').replace(/\s+/g, ' ').trim();
/** The part of a finished sentence that carries the answer: "three thousand yen is about eighteen dollars" -> "eighteen dollars". */
export function figureKey(sentence) {
  const m = String(sentence || '').match(/ (?:is|was|are|falls|fell)(?: at)?(?: about| around| on a| on)? (.+)$/i);
  const rest = (m ? m[1] : String(sentence || '')).split(',')[0];
  return plainWords(rest).replace(/^(?:about|around) /, '').replace(/ (?:from now|ago|away)$/, '');
}
const SAYS_A_FIGURE = /\d|\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|june|july|august|september|october|november|december)\b/i;

/**
 * A reply to a turn that had finished sums: the same reply when it holds every worked out figure,
 * or says no figure at all (he was answered about something else, or it stayed quiet); else the
 * code's own sentences. `reply` is the model's whole output, JSON or plain words.
 * Returns { text, changed }.
 */
export function keepFigures(reply, loud) {
  const raw = String(reply || '');
  if (!loud || !loud.length) return { text: raw, changed: false };
  let obj = null;
  try { const j = JSON.parse(raw); if (j && typeof j === 'object') obj = j; } catch {}
  const said = obj ? String(obj.response || '') : raw;
  if (obj && obj.intent && obj.intent !== 'query') return { text: raw, changed: false };
  if (!said.trim() || said.includes('[')) return { text: raw, changed: false };
  const heard = plainWords(said);
  const keys = loud.map(figureKey).filter(Boolean);
  if (keys.every((k) => heard.includes(k))) return { text: raw, changed: false };
  if (!SAYS_A_FIGURE.test(said)) return { text: raw, changed: false };
  const fixed = loud.map((s) => s[0].toUpperCase() + s.slice(1)).join('. ') + '.';
  return { text: obj ? JSON.stringify({ ...obj, response: fixed }) : fixed, changed: true };
}

// ---- coins: which ones a line asks the price of ---------------------------------------------

/**
 * The coins a line asks the price of. `coins` is the price source's own list
 * ([{ id, symbol, name, rank }], biggest first), so no coin is left out because nobody typed
 * its name here. Many coins are named with everyday words (Rain, Sky, Midnight, Pearl), so a
 * name only counts where the line is plainly about a price:
 *   "price of X", "value of X", "X at", "X trading", "X worth"      any of the top 100
 *   "how much is one X", "how much is a X"                          the top 30 only
 * A ticker (xrp, bnb) counts as the name does.
 */
export function coinsAsked(text, coins) {
  const line = String(text || '');
  const found = [];
  for (const c of coins || []) {
    if (!(c.rank > 0) || c.rank > 100) continue;
    const name = String(c.name || '').replace(/\s*\(.*$/, '').trim();
    const forms = [name, c.symbol].filter((f) => f && f.length >= 3 && f.split(' ').length <= 3);
    for (const form of forms) {
      const m = new RegExp(`(?<![\\p{L}\\p{N}])${form.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}s?(?![\\p{L}\\p{N}])`, 'iu').exec(line);
      if (!m) continue;
      const before = line.slice(0, m.index);
      const after = line.slice(m.index + m[0].length);
      const priced = /\b(?:price|value|cost) of (?:an? |one |the )?$/i.test(before) || /^\s*(?:is |are )?(?:at\b|trading|worth\b|price\b|going for|doing\b)/i.test(after);
      // An everyday word needs a top coin behind it; "litecoin" or a ticker said in capitals (XRP) does not.
      const plainlyCoin = c.rank <= 30 || /coin$/i.test(m[0]) || (form === c.symbol && m[0] === m[0].toUpperCase());
      const howMuch = plainlyCoin && /\bhow much (?:is|are|for) (?:an? |one |1 )?$/i.test(before) && /^\s*(?:$|[?.!,]|right now|now\b|today|worth|these days|at the moment|in )/i.test(after);
      if (priced || howMuch) { if (!found.includes(c.id)) found.push(c.id); break; }
    }
  }
  return found.slice(0, 3);
}

// ---- the time somewhere else: which place ---------------------------------------------------

/**
 * The place a clock question names: "what time is it over in Nigeria right now" -> "nigeria".
 * '' when the line is not asking the time somewhere.
 */
export function clockPlace(text) {
  const t = String(text || '').toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/[^\p{L}\p{N}' ]+/gu, ' ').replace(/\s+/g, ' ').trim();
  if (!/\btime\b/.test(t)) return '';
  const m = t.match(/\btime\b.*?\b(?:in|at) (?:the )?(.+)$/);
  if (!m) return '';
  const place = m[1].replace(/\b(?:right now|just now|now|at the moment|at this moment|currently|today|tonight|please|then|there|is it|do you know|i wonder)\b.*$/, '').trim();
  if (!place || place.split(' ').length > 5 || /^(?:it|that|this|here|my|your|his|her|morning|evening|afternoon|night|a minute|a second|an hour|time)\b/.test(place)) return '';
  return place;
}
