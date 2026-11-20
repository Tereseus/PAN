// Lookup tools: the bit a language model cannot do for itself.
//
// A model maps text to text and has no network. Everything here is the program
// fetching real data and handing it to the model as fact, which is what every
// "AI that can look things up" actually is.
//
// A REGISTRY rather than a chain of ifs, for one reason: matching tools run in
// PARALLEL. Five tools that hit on one utterance cost ONE round trip (~400ms),
// not five. Adding a tool therefore costs no latency unless it actually fires.
//
// Every tool must: match cheaply before any network call, carry its own hard
// timeout, and return '' on any failure. A dead API degrades to "I can't check
// that" via the capability block - it must never delay a voice turn.

import { buildWeatherBlock, looksLikeWeather, resolveLocation, locationNeededBlock } from './weather.js';
import * as browser from './playwright-bridge.js';
import { spawn } from 'child_process';
import { askAI } from './llm.js';
import { get } from './db.js';
import { moneyAsk, moneyBlock, CODES as MONEY_CODES, ECB as ECB_CODES } from './money.js';
import { unitAsk, unitBlock, clockPlace, coinsAsked, sayNumber } from './sums.js';
import { sayMoney } from './money.js';
import { dayAsk, dayBlock } from './calendar.js';
import { sunTimes } from './intuition/place.js';
import { hisTimeZone } from './intuition/time.js';

const TIMEOUT_MS = 2500;

async function getJson(url) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { 'User-Agent': 'PAN/1.0 (personal assistant)' },
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

// --- Wikipedia: general factual lookup ------------------------------------
// Two calls (search then summary) but they are sequential by necessity; still
// ~600ms total, measured 218ms + 377ms.
// TALK FIRST. This used to match a bare "what is" / "who is", which is the
// shape of most things anyone says out loud - so asking "what is the meaning
// of life" fetched a Wikipedia article and PAN read it back instead of having
// a view. It knows the capital of Peru and it knows what two plus two is; a
// lookup adds nothing to either and costs the turn its character.
//
// A tool now has to be asked for, or be about something PAN genuinely CANNOT
// know from training: things that change (news, weather, prices) or a specific
// page. Encyclopedic recall is not one of those.
const WIKI_RE = /\b(look up|tell me about|what do you know about|who exactly (?:is|was)|when (?:was|did) .{0,40}(?:born|die|founded|invented)|history of)\b/i;

async function wikipedia(text) {
  // Strip the question framing so the search sees the subject, not the grammar.
  const q = String(text)
    .replace(/[?.!]+$/g, '')
    .replace(/^\s*(hey |ok |okay )?(pan|pam)[,\s]*/i, '')
    .replace(/\b(who|what)\s+(is|was|are|were)\b/i, '')
    .replace(/\b(tell me about|explain|the history of)\b/i, '')
    .trim();
  if (q.length < 3) return '';

  // opensearch is a title/prefix matcher and returns null for anything shaped
  // like a question: "the capital of peru" gave nothing. list=search is full
  // text and finds the article that actually holds the answer ("Lima").
  const s = await getJson(
    'https://en.wikipedia.org/w/api.php?action=query&list=search&srlimit=1&format=json&srsearch=' + encodeURIComponent(q));
  const title = s?.query?.search?.[0]?.title;
  if (!title) return '';

  const p = await getJson(
    'https://en.wikipedia.org/api/rest_v1/page/summary/' + encodeURIComponent(title.replace(/ /g, '_')));
  const extract = String(p?.extract || '').trim();
  if (!extract) return '';

  return `\nWIKIPEDIA on "${title}" - real reference data, safe to state as fact:\n` +
    extract.slice(0, 700) + '\n';
}

// --- Currency ---------------------------------------------------------------
// Which sum the line asks for is worked out in money.js (tested rules), with the talk before
// it, and the sum is done here. The model gets finished figures: left to multiply a rate
// itself it gave 1,800 yen and 3,000 yen the same number of dollars (2026-11-19).
function homeCurrency() {
  try {
    const v = String(get("SELECT value FROM settings WHERE key = 'home_currency'")?.value || '').replace(/^"|"$/g, '').trim().toUpperCase();
    if (MONEY_CODES.includes(v)) return v;
  } catch {}
  return 'USD';
}
const moneyAsks = (text, opts) => moneyAsk(text, (opts && opts.recent) || [], homeCurrency());

// Two sources, so no currency is left out. European Central Bank reference rates (Frankfurter)
// carry 30 currencies; when a sum needs any other, the rates come from currency-api
// (github.com/fawazahmed0/exchange-api: public domain, daily, every currency, served from a
// CDN with a second host behind it). Neither needs a key.
const RATE_HOSTS = [
  (from) => `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/${from}.min.json`,
  (from) => `https://latest.currency-api.pages.dev/v1/currencies/${from}.min.json`,
];
// The files change once a day, so one read serves three hours of questions, and the two hosts
// are asked at once: a slow CDN answer once cost a whole turn its data (the model then guessed
// 300 dollars for 500 lari, right-answer bench, Craft 28).
const DAY_RATES_KEEP_MS = 3 * 3600 * 1000;
const dayRatesKept = new Map();
async function dayRates(key) {
  const kept = dayRatesKept.get(key);
  if (kept && Date.now() - kept.at < DAY_RATES_KEEP_MS) return kept.j;
  const one = async (host) => {
    const res = await fetch(host(key), { signal: AbortSignal.timeout(1300), headers: { 'User-Agent': 'PAN/1.0 (personal assistant)' } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const j = await res.json();
    if (!j?.[key]) throw new Error('no rates in the file');
    return j;
  };
  try {
    const j = await Promise.any(RATE_HOSTS.map(one));
    dayRatesKept.set(key, { at: Date.now(), j });
    return j;
  } catch (e) {
    console.warn('[tools] rates: ' + (e?.errors?.[0]?.message || e?.message || e));
    return kept ? kept.j : null;      // an older day's rates are better than a guess
  }
}

async function ratesFor(asks) {
  const rates = {};
  let date = '';
  const pairs = new Map();
  for (const a of asks) pairs.set(a.from, [...new Set([...(pairs.get(a.from) || []), a.to])]);
  if (asks.every((a) => ECB_CODES.includes(a.from) && ECB_CODES.includes(a.to))) {
    try {
      for (const [from, to] of pairs) {
        const j = await getJson(`https://api.frankfurter.dev/v1/latest?from=${from}&to=${to.join(',')}`);
        for (const c of to) if (j?.rates?.[c] != null) rates[`${from}>${c}`] = j.rates[c];
        date = j?.date || date;
      }
      if (asks.every((a) => rates[`${a.from}>${a.to}`] > 0)) return { rates, date, source: 'European Central Bank' };
    } catch (e) { console.warn('[tools] ECB rates: ' + (e?.message || e)); }
  }
  for (const [from, to] of pairs) {
    const key = from.toLowerCase();
    const j = await dayRates(key);
    for (const c of to) if (j?.[key]?.[c.toLowerCase()] > 0) rates[`${from}>${c}`] = j[key][c.toLowerCase()];
    date = j?.date || date;
  }
  return { rates, date, source: 'daily market rates' };
}

async function currency(text, opts) {
  const asks = moneyAsks(text, opts);
  if (!asks.length) return '';
  const { rates, date, source } = await ratesFor(asks);
  return moneyBlock(asks, rates, date, source) || lookupFailed('the exchange rate');
}

// --- Crypto: relevant to Dream Fights and the data-staking work ------------
const CRYPTO_RE = /\b(bitcoin|btc|ethereum|eth|solana|sol|crypto|usdc)\b/i;
const COINS = { bitcoin: 'bitcoin', btc: 'bitcoin', ethereum: 'ethereum', eth: 'ethereum', solana: 'solana', sol: 'solana', usdc: 'usd-coin' };

// Every coin the price source lists (its top 250, read once a day), not four typed in here.
// Until the list has loaded, the four above still work.
let coinList = [];
let coinListAt = 0;
let coinListLoading = null;
function coins() {
  if (Date.now() - coinListAt > 24 * 3600 * 1000 && !coinListLoading) {
    coinListLoading = fetch('https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=1',
      { signal: AbortSignal.timeout(10000), headers: { 'User-Agent': 'PAN/1.0 (personal assistant)' } })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status))))
      .then((list) => {
        if (Array.isArray(list) && list.length) coinList = list.map((c) => ({ id: c.id, symbol: c.symbol, name: c.name, rank: c.market_cap_rank }));
        coinListAt = Date.now();
      })
      .catch(async (e) => {
        console.warn('[tools] coin list: ' + (e?.message || e));
        coinListAt = Date.now() - (24 * 3600 - 300) * 1000;      // try the ranked list again in five minutes
        if (coinList.length) return;
        // Meanwhile the names in the daily rate files: every code there that is not a country's money.
        // They carry no ranking, so a name only counts beside the word price ("price of X", "X at").
        for (const host of RATE_HOSTS) {
          try {
            const names = await getJson(host('usd').replace(/currencies\/usd\.min\.json$/, 'currencies.min.json'));
            const list = Object.entries(names || {}).filter(([code, name]) => name && !MONEY_CODES.includes(code.toUpperCase()) && !/^x[a-z]{2}$/.test(code))
              .map(([code, name]) => ({ id: 'sym:' + code, symbol: code, name, rank: 50 }));
            if (list.length) { coinList = list; break; }
          } catch {}
        }
      })
      .finally(() => { coinListLoading = null; });
  }
  return coinList;
}
function coinIds(text) {
  const ids = coinsAsked(text, coins());
  for (const m of String(text).toLowerCase().matchAll(/\b(bitcoin|btc|ethereum|eth|solana|sol|usdc)\b/g)) {
    const id = COINS[m[1]];
    // With only the unranked names loaded, the same coin is already in the list under its ticker.
    const ticker = { bitcoin: 'btc', ethereum: 'eth', solana: 'sol', 'usd-coin': 'usdc' }[id];
    if (id && !ids.includes(id) && !ids.includes('sym:' + ticker)) ids.push(id);
  }
  return ids;
}

// A price the way it is said: dollars and cents, or cents with a decimal for a coin under a dollar.
function sayCoinPrice(usd) {
  if (usd >= 1) return sayMoney(usd, 'USD');
  const cents = usd * 100;
  return cents >= 1 ? `${sayNumber(cents)} cents` : `${sayNumber(cents)} of a cent`;
}

async function crypto(text) {
  const ids = coinIds(text);
  if (!ids.length) ids.push('bitcoin', 'ethereum');
  let j = null;
  let source = 'CoinGecko, live';
  try {
    if (ids.some((id) => id.startsWith('sym:'))) throw new Error('no ranked coin list yet');
    j = await getJson(
      'https://api.coingecko.com/api/v3/simple/price?ids=' + ids.join(',') +
      '&vs_currencies=usd&include_24hr_change=true');
  } catch (e) {
    // The live source allows only a few questions a minute. The daily rates (the same public
    // files the currency sums use) carry the big coins too: an older price, said to be one.
    console.warn('[tools] coin price: ' + (e?.message || e) + ', using the daily rates');
    const SYMBOL = { bitcoin: 'btc', ethereum: 'eth', solana: 'sol', 'usd-coin': 'usdc' };
    const day = await dayRates('usd');
    j = {};
    for (const id of ids) {
      const symbol = SYMBOL[id] || (coinList.find((c) => c.id === id) || {}).symbol;
      const perDollar = symbol && day?.usd?.[symbol.toLowerCase()];
      if (perDollar > 0) j[id] = { usd: 1 / perDollar };
    }
    source = `daily rates of ${day?.date || 'today'}, not live`;
  }
  const lines = [];
  for (const [id, v] of Object.entries(j || {})) {
    if (!(v?.usd > 0)) continue;
    const ch = v.usd_24h_change;
    const name = (coinList.find((c) => c.id === id) || {}).name || id;
    const figure = v.usd >= 100 ? Math.round(v.usd).toLocaleString('en-US') : v.usd >= 1 ? v.usd.toFixed(2) : String(Number(v.usd.toPrecision(3)));
    lines.push(`- ${name}: $${figure}` + (ch != null ? ` (${ch >= 0 ? '+' : ''}${ch.toFixed(1)}% in 24h)` : '') + `. Out loud: "${name} is at about ${sayCoinPrice(v.usd)}"`);
  }
  if (!lines.length) return '';
  return `\nCRYPTO PRICES (${source}) - real data.`
    + ' Use the words after "Out loud" as they are; do not spell any number yourself:\n' + lines.join('\n') + '\n';
}

// --- Air quality: the wearer's local environment --------------------------
const AIR_RE = /\b(air quality|pollution|smog|pm2\.?5|aqi)\b/i;

async function airQuality(text, sensors) {
  // Same location resolution as weather: GPS when the phone sends it, hub IP
  // otherwise. GPS-only meant this never fired on the real voice path.
  const loc = resolveLocation(sensors);
  if (!loc) return locationNeededBlock('air quality');
  const j = await getJson(
    `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${loc.lat.toFixed(3)}` +
    `&longitude=${loc.lon.toFixed(3)}&current=pm2_5,pm10,european_aqi&timezone=auto`);
  const c = j?.current;
  if (!c) return '';
  return `\nAIR QUALITY (Open-Meteo, live) - real data:\n` +
    `- European AQI ${c.european_aqi}, PM2.5 ${c.pm2_5} ug/m3, PM10 ${c.pm10} ug/m3\n`;
}

// --- Web search ------------------------------------------------------------
//
// Every consumer search engine refuses this hub. Measured, one query each:
//   bing        degraded no-JS SERP; "prime minister" returned Prime Video, and
//               its format=rss feed returned orange.fr for "capital of peru"
//   duckduckgo  CAPTCHA ("select all squares containing a duck")
//   startpage   "Access Temporarily Suspended" - the VPN exit is banned
//   brave       "Verifying you're not a bot"
//   ecosia      Cloudflare 403
//   mojeek      403 "your network appears to be sending automated queries"
//   searx.be    browser integrity check
//
// Those are anti-bot measures and we do not try to defeat them. Gemini can do
// grounded Google search, but that tool 429s instantly on this key's free tier;
// it needs billing enabled, which is the commander's call.
//
// What works is Google News RSS: an endpoint built to be read by programs,
// measured at 932ms, and current enough to name the sitting prime minister when
// Wikipedia only had the article about the office.
//
// So "search" here means CURRENT NEWS. It is not a general web index, and PAN
// must never imply it looked something up when it did not. Encyclopedic
// questions are the wikipedia tool's job (it uses full-text search, which does
// answer question-shaped queries).

const SEARCH_RE = /\b(search (?:for|the web|online)|look (?:it|that|this) up|look up|google|what'?s (?:the )?latest|latest news|news (?:about|on|from)|what happened|any news|headlines|what'?s happening|in the news)\b/i;

// Questions whose answer changes over time. Wikipedia returns the article about
// the OFFICE for "who is the prime minister of a country" and never names the
// holder, so these also need the news feed to get an actual name.
// Also tightened: a bare "today" or "latest" appears in ordinary conversation
// constantly ("how are you doing today"). These now need a news-shaped subject
// as well as the time word.
const CURRENT_RE = /\b(prime minister|president|the ceo|who won|winner of|champion of|election|stock price|share price)\b|\b(latest|current|right now|today)\b.{0,30}\b(news|headline|score|result|price|update|release)\b/i;

// Talking TO PAN is not a lookup. CURRENT_RE matches a bare "today", so
// "how are you doing today" was firing a news search; WIKI_RE matches
// "what is", so half of normal conversation was firing an encyclopedia
// lookup. Both then had to finish before PAN could answer at all. This veto
// runs before any tool matches - it is cheaper and far more legible than
// trying to make every individual trigger smarter.
const CONVERSATIONAL_RE = /\b(how are you|how're you|how are we|how you doing|how'?s it going|what do you think|what'?s your (?:name|opinion|take)|who are you|how old are you|are you (?:ok|okay|there|awake|listening|sure|serious|kidding)|thank you|thanks|good (?:morning|night|evening|afternoon)|i guess you|you don'?t know|never mind|forget it|shut up|stop talking)\b/i;

function decodeEntities(s) {
  return String(s)
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

async function getText(url, timeoutMs = 3500) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'User-Agent': 'PAN/1.0 (personal assistant)' },
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.text();
}

/** Strip question grammar so the query carries the subject, not the framing. */
function searchSubject(text) {
  return String(text)
    .replace(/[?.!]+$/g, '')
    .replace(/^\s*(hey |ok |okay )?(pan|pam)[,\s]*/i, '')
    .replace(/\b(can you|please|could you)\b/gi, '')
    .replace(/\b(search (?:for|the web|online)?|look (?:it|that|this)? ?up|google|tell me)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function googleNews(q) {
  const xml = await getText(
    'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=' + encodeURIComponent(q));
  const items = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const t = m[1].match(/<title>([\s\S]*?)<\/title>/);
    if (!t) continue;
    const title = decodeEntities(t[1]).replace(/\s+/g, ' ').trim();
    if (title && !items.includes(title)) items.push(title);
    if (items.length >= 6) break;
  }
  return items;
}

// Sunrise and sunset are computed for where he is (intuition/place.js daylightLine, in the
// situation line). The news feed has no such answer, so "do a web search, what time does the
// sun come up" got "I couldn't run the search" (Nov 10, and again on the hub Nov 13).
const SUN_RE = /\b(?:sun ?rise|sun ?set|sun ?up|sundown|dusk|dawn|daylight|sun (?:come|comes|coming|go|goes|going|rise|rises) (?:up|down))\b/i;

// A named place ("when does the sun come up in Porto, Portugal"): its coordinates from the
// Wikipedia summary, then the same sun maths as place.js, told in his own clock (the instant is
// the same anywhere, so "07:12 his time" is right even for a far place). No place named: the
// situation line already holds sunrise and sunset for where he is.
async function sunForPlace(text) {
  const m = String(text).match(/^.*\b(?:in|at|for|over)\s+((?:the\s+)?\p{L}[\p{L}'’ ,-]{1,60}?)\s*(?:\b(?:today|tomorrow|tonight|right now|now)\b)?\s*[?.!]*\s*$/iu);
  if (!m) return '';
  const place = m[1].replace(/[.,\s]+$/, '').trim();
  if (place.length < 3 || /^(?:the )?(?:morning|evening|summer|winter|here|there|my place|where i am|where i'm at)$/i.test(place)) return '';
  const s = await getJson('https://en.wikipedia.org/w/api.php?action=query&list=search&srlimit=1&format=json&srsearch=' + encodeURIComponent(place));
  const title = s?.query?.search?.[0]?.title;
  if (!title) return '';
  const p = await getJson('https://en.wikipedia.org/api/rest_v1/page/summary/' + encodeURIComponent(title.replace(/ /g, '_')));
  const c = p?.coordinates;
  if (typeof c?.lat !== 'number' || typeof c?.lon !== 'number') return '';
  const now = new Date();
  const sun = sunTimes(c.lat, c.lon, now);
  if (!sun) return '';
  const tz = hisTimeZone();
  const fmt = (ms) => new Date(ms).toLocaleTimeString('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false });
  return `\nSUN TIMES for ${title} today, computed from its coordinates (real data, state as fact): ` +
    `sunrise ${fmt(sun.sunrise)}, sunset ${fmt(sun.sunset)}, both in his own time (${tz}).\n`;
}

async function webSearch(text) {
  if (SUN_RE.test(text)) return '';
  const q = searchSubject(text);
  if (q.length < 3) return '';

  let headlines = [];
  try {
    headlines = await googleNews(q);
  } catch (e) {
    console.warn('[tools] googleNews: ' + (e?.message || e));
  }

  if (headlines.length) {
    return `\nCURRENT NEWS HEADLINES (Google News, live) for "${q}" - real data, ` +
      `use these for anything time-sensitive:\n` +
      headlines.map((h) => '- ' + h.slice(0, 160)).join('\n') + '\n';
  }

  // No fallback. If the lookup failed on an explicit request to search, say so
  // rather than answering from memory and passing a stale guess off as a fact
  // that was just checked.
  if (SEARCH_RE.test(text)) {
    return '\nSEARCH FAILED: the news lookup returned nothing. Tell the commander ' +
      'you could not search just now. Do NOT answer from memory as though you had ' +
      'looked it up.\n';
  }
  return '';
}

// --- Read a page the commander names ---------------------------------------
//
// This is the browser path, and it is the one thing a browser is genuinely
// needed for: pulling the readable text out of a specific page. It only fires
// when a URL is actually named, because it costs ~4.5s against ~900ms for the
// feed endpoints.

const URL_RE = /\bhttps?:\/\/[^\s<>"']{4,}/i;

async function readNamedUrl(text) {
  const m = String(text).match(URL_RE);
  if (!m) return '';
  const url = m[0].replace(/[.,;:)\]]+$/, '');
  if (!(await browser.isAvailable())) {
    return `\nBROWSER UNAVAILABLE: could not open ${url}. Tell the commander the ` +
      `browser is not running rather than guessing what the page says.\n`;
  }
  const body = await browser.readUrl(url, { settleMs: 2000, maxChars: 3000 });
  if (!body) return '';
  return `\nPAGE TEXT from ${url} - real content, safe to quote:\n${body}\n`;
}

// --- Decisions ---------------------------------------------------------------
//
// "Should I get this?" answered with arithmetic instead of an opinion.
//
// The calculator (Autokratia's decide.py, vendored at C:/PAN/autokratia) does
// Monte Carlo over RANGES. It cannot read a sentence. So this tool does the one
// translation step nobody else can: it asks the model to turn the question into
// options and a range per belief, then hands that to the calculator.
//
// The ranges are GUESSES. That is not a flaw to be hidden, it is the whole
// reported quantity - the calculator prints what share was guessed, and the
// block below tells the model to say so out loud. A confident number built on
// invented ranges is the exact failure this project exists to avoid.
//
// PAN has no model tool-calling (llm.js passes tools: [] to the SDK), so the
// two-step happens here rather than as a tool the model invokes itself.

const DECIDE_RE = /\b(should i|shall i|should we|is it worth|worth it|worth buying|am i better off|do i (?:buy|get|take|quit|cancel|keep|sell))\b/i;

const DECIDE_PY = 'C:/PAN/autokratia/decide_inline.py';

const BUILD_PROMPT = `Turn the question into a decision for a Monte Carlo calculator. Reply with ONLY a JSON object, no prose, no code fence.

Shape:
{"decision":"<short title>",
 "unit":"<what one point means, e.g. euros per year, wellbeing points per year>",
 "headline_question":"<the yes/no question>",
 "headline_yes_option":"<name of the option that means YES>",
 "uncertainties":[{"id":"<snake_case>","low":<number>,"high":<number>,"mode":<number>,"provenance":"guessed"}],
 "options":[{"name":"<option>","terms":{"<uncertainty id>":<coefficient>}}]}

Rules:
- 2 to 4 uncertainties, each a quantity that could plausibly differ, with an honest low/high spread. Costs are negative.
- Exactly 2 options. One must equal headline_yes_option. The do-nothing option usually has "terms":{}.
- Every coefficient is a number multiplying that uncertainty in that option.
- Every provenance is "guessed". Never claim a measurement.
- All ids used in terms must exist in uncertainties.

Question: `;

function runDecide(decision, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    let p;
    try {
      p = spawn('python', [DECIDE_PY], { windowsHide: true });
    } catch (e) {
      return reject(new Error('spawn failed: ' + e.message));
    }
    let out = '', err = '';
    const timer = setTimeout(() => {
      try { p.kill(); } catch {}
      reject(new Error('decide timeout'));
    }, timeoutMs);
    p.stdout.on('data', (d) => { out += d.toString(); });
    p.stderr.on('data', (d) => { err += d.toString(); });
    p.on('error', (e) => { clearTimeout(timer); reject(e); });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(err.trim().slice(0, 200) || ('exit ' + code)));
      resolve(out);
    });
    try {
      p.stdin.write(JSON.stringify(decision));
      p.stdin.end();
    } catch (e) {
      clearTimeout(timer);
      reject(e);
    }
  });
}

/** Keep only the verdict; the full working is far too long for a voice prompt. */
function answerBlock(report) {
  const marker = '='.repeat(74);
  const start = report.indexOf('THE ANSWER');
  if (start < 0) return report.slice(0, 1200);
  const after = report.indexOf(marker, start);
  const end = after > 0 ? report.indexOf(marker, after + marker.length) : -1;
  const cut = end > 0 ? report.slice(0, end) : report.slice(0, 1200);
  return cut.replace(/\n{3,}/g, '\n\n').trim();
}

async function decideTool(text) {
  const q = String(text).replace(/\s+/g, ' ').trim();
  if (q.length < 8) return '';

  let raw;
  try {
    // LOCAL model on purpose. Turning a question into ranges is mechanical,
    // and the cloud key is already at its 500/day free-tier ceiling - spending
    // it here would cost a conversation turn to save nothing.
    raw = await askAI(BUILD_PROMPT + q, {
      model: 'ollama:gemma4:e4b',
      timeout: 20000, maxTokens: 500, caller: 'tools.decide',
    });
  } catch (e) {
    console.warn('[tools] decide: model failed: ' + (e?.message || e));
    return '';
  }

  // The model was told "JSON only" but fences and preamble still happen.
  let decision;
  try {
    const s = String(raw);
    const a = s.indexOf('{'), b = s.lastIndexOf('}');
    if (a < 0 || b <= a) throw new Error('no JSON object in reply');
    decision = JSON.parse(s.slice(a, b + 1));
  } catch (e) {
    console.warn('[tools] decide: unparseable decision: ' + e.message);
    return '';
  }

  // Validate before spending a process on it, and fail loudly rather than
  // letting the calculator compute something silently malformed.
  const ids = new Set((decision.uncertainties || []).map((u) => u.id));
  const bad = !Array.isArray(decision.uncertainties) || !decision.uncertainties.length
    || !Array.isArray(decision.options) || decision.options.length < 2
    || decision.options.some((o) => Object.keys(o.terms || {}).some((k) => !ids.has(k)));
  if (bad) {
    console.warn('[tools] decide: decision failed validation');
    return '';
  }

  let report;
  try {
    report = await runDecide(decision);
  } catch (e) {
    console.warn('[tools] decide: calculator failed: ' + (e?.message || e));
    return '\nDECISION CALCULATOR UNAVAILABLE: tell the commander you could not ' +
      'run the numbers, and do not substitute an opinion for them.\n';
  }

  const guessed = (decision.uncertainties || [])
    .filter((u) => u.provenance === 'guessed').length;
  const total = (decision.uncertainties || []).length;

  return `\nDECISION CALCULATOR (Monte Carlo over stated ranges) - real arithmetic:\n` +
    answerBlock(report) + '\n' +
    `\nHOW TO USE THIS: read out the percentage and which option it favours. ` +
    `${guessed} of ${total} ranges were GUESSED by you, not measured, so say that ` +
    `plainly - the number describes what those guesses imply, not what is true ` +
    `about the commander. If it says coin flip, say it is a coin flip.\n` +
    `The ranges used: ` +
    (decision.uncertainties || []).map((u) => `${u.id} ${u.low}..${u.high}`).join(', ') + '\n';
}

// --- Clock: the time somewhere else -----------------------------------------
// "What time is it in Tokyo" is a time-zone sum, and the voice model cannot do
// sums: told it was 00:45 in New York, it said 9:45 PM for Tokyo (Syrinx r9,
// 2026-11-02). No network: the hub's own clock, in the zone he named. Any IANA
// city works ("in lisbon"), plus the countries and states people actually say.
const ZONE_ALIASES = {
  california: 'America/Los_Angeles', 'san francisco': 'America/Los_Angeles', seattle: 'America/Los_Angeles',
  'las vegas': 'America/Los_Angeles', 'west coast': 'America/Los_Angeles', 'east coast': 'America/New_York',
  florida: 'America/New_York', miami: 'America/New_York', boston: 'America/New_York',
  washington: 'America/New_York', atlanta: 'America/New_York', philadelphia: 'America/New_York', 'new jersey': 'America/New_York',
  texas: 'America/Chicago', dallas: 'America/Chicago', houston: 'America/Chicago', colorado: 'America/Denver',
  arizona: 'America/Phoenix', hawaii: 'Pacific/Honolulu', alaska: 'America/Anchorage',
  canada: 'America/Toronto', ottawa: 'America/Toronto', montreal: 'America/Toronto', mexico: 'America/Mexico_City',
  brazil: 'America/Sao_Paulo', rio: 'America/Sao_Paulo', argentina: 'America/Argentina/Buenos_Aires',
  'buenos aires': 'America/Argentina/Buenos_Aires', uk: 'Europe/London', england: 'Europe/London',
  britain: 'Europe/London', scotland: 'Europe/London', manchester: 'Europe/London', ireland: 'Europe/Dublin',
  france: 'Europe/Paris', germany: 'Europe/Berlin', munich: 'Europe/Berlin', frankfurt: 'Europe/Berlin',
  italy: 'Europe/Rome', milan: 'Europe/Rome', spain: 'Europe/Madrid', barcelona: 'Europe/Madrid',
  portugal: 'Europe/Lisbon', netherlands: 'Europe/Amsterdam', switzerland: 'Europe/Zurich',
  cyprus: 'Asia/Nicosia', turkey: 'Europe/Istanbul',
  russia: 'Europe/Moscow', israel: 'Asia/Jerusalem', egypt: 'Africa/Cairo', 'south africa': 'Africa/Johannesburg',
  uae: 'Asia/Dubai', 'abu dhabi': 'Asia/Dubai', india: 'Asia/Kolkata', mumbai: 'Asia/Kolkata', delhi: 'Asia/Kolkata',
  bangalore: 'Asia/Kolkata', china: 'Asia/Shanghai', beijing: 'Asia/Shanghai', japan: 'Asia/Tokyo', osaka: 'Asia/Tokyo',
  kyoto: 'Asia/Tokyo', korea: 'Asia/Seoul', 'south korea': 'Asia/Seoul', thailand: 'Asia/Bangkok',
  vietnam: 'Asia/Ho_Chi_Minh', philippines: 'Asia/Manila', indonesia: 'Asia/Jakarta', bali: 'Asia/Makassar',
  australia: 'Australia/Sydney', 'new zealand': 'Pacific/Auckland',
};

let zoneNames = null;
function zones() {
  if (zoneNames) return zoneNames;
  // Places only he says (his own city, a work site) live in the zone_aliases setting,
  // a JSON object of name -> IANA zone, not in this public file.
  let own = {};
  try { own = JSON.parse(get("SELECT value FROM settings WHERE key = 'zone_aliases'")?.value || '{}'); } catch {}
  zoneNames = new Map(Object.entries({ ...ZONE_ALIASES, ...own }));
  for (const z of Intl.supportedValuesOf('timeZone')) {
    // Region/City only: the last word of a three-part sub-zone is often an
    // ordinary word ("America/North_Dakota/Center", "America/Indiana/Knox").
    const parts = z.split('/');
    const city = parts.length === 2 ? parts[1].replace(/_/g, ' ').toLowerCase() : '';
    if (city && !zoneNames.has(city)) zoneNames.set(city, z);
  }
  return zoneNames;
}

function worldClock(text) {
  const t = String(text).toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/[^a-z ]+/g, ' ').replace(/\s+/g, ' ').trim();
  // The place is what follows "in": "what time is it (over there) in new york (right now)".
  // Only there, so "what time is casey coming" never reads as Antarctica/Casey.
  for (const m of t.matchAll(/\bin (?:the )?(?=[a-z])/g)) {
    const rest = t.slice(m.index + m[0].length);
    let best = '';
    for (const name of zones().keys()) {
      if (name.length > best.length && (rest === name || rest.startsWith(name + ' '))) best = name;
    }
    if (!best) continue;
    const zone = zones().get(best);
    try {
      const when = new Date().toLocaleString('en-US', { timeZone: zone, weekday: 'long', hour: 'numeric', minute: '2-digit' });
      const place = /^(uk|uae)$/.test(best) ? best.toUpperCase() : best.replace(/\b[a-z]/g, (c) => c.toUpperCase());
      return `\nCLOCK: in ${place} it is ${when} right now (${zone}).\n`;
    } catch { return ''; }
  }
  return '';
}

// A place the table above does not hold (a country, a town anywhere, a name in another
// language): the geocoder knows its time zone. The table missed "Nigeria", "Kenya" and
// "Kathmandu", and the model then made a time up (7 of 20 wrong, right-answer bench 2026-11-19).
async function clockAnywhere(text) {
  const known = worldClock(text);
  if (known) return known;
  const place = clockPlace(text);
  if (!place) return '';
  const j = await getJson('https://geocoding-api.open-meteo.com/v1/search?count=5&language=en&name=' + encodeURIComponent(place));
  const hits = (j?.results || []).filter((r) => r.timezone);
  // A country or the biggest town of that name, before a village that shares it.
  const best = hits.find((r) => r.feature_code === 'PCLI') || hits.sort((a, b) => (b.population || 0) - (a.population || 0))[0];
  if (!best) return '';
  try {
    const when = new Date().toLocaleString('en-US', { timeZone: best.timezone, weekday: 'long', hour: 'numeric', minute: '2-digit' });
    const where = best.country && best.country !== best.name ? `${best.name}, ${best.country}` : best.name;
    return `\nCLOCK: in ${where} it is ${when} right now (${best.timezone}).\n`;
  } catch { return ''; }
}

// --- Calendar: when a holiday falls, what weekday, how many days until -------------------------
// Worked out in calendar.js. Today is his own date, not the hub's.
function todayHere() {
  let tz;
  try { tz = hisTimeZone(); } catch {}
  try {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz || undefined, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date()).map((x) => [x.type, x.value]));
    return { y: Number(p.year), m: Number(p.month), d: Number(p.day) };
  } catch { const n = new Date(); return { y: n.getFullYear(), m: n.getMonth() + 1, d: n.getDate() }; }
}
function calendarDay(text) {
  const today = todayHere();
  return dayBlock(dayAsk(text, today), today);
}

// live: data that changes (weather, prices, news, a page, a clock), which the voice
// student cannot answer from its own head; routeStream hands such a turn the data
// instead of the student. A function when the match is looser than a real ask:
// WEATHER_RE fires on "wind chimes" and "this coffee is too hot", SEARCH_RE on "what
// happened to my build", and sending those past the student lost the reply
// ("remember I hate wind chimes" got silence, 2026-11-03).
const WEATHER_ASK = /\b(weather|forecast|rain(?:ing|y)?|snow(?:ing|y)?|umbrella|sunny|cloudy|windy|humid(?:ity)?|temperature (?:outside|today|tomorrow|tonight))\b/i;
const SEARCH_ASK = /\b(search (?:for|the web|online)|look (?:it|that|this) up|look up|google|latest news|news (?:about|on|from)|any news|headlines|in the news)\b/i;
const TOOLS = [
  { name: 'weather',  live: (t) => WEATHER_ASK.test(t), match: (t) => looksLikeWeather(t), run: (t, s) => buildWeatherBlock(t, s) },
  { name: 'wikipedia',match: (t) => WIKI_RE.test(t) && !looksLikeWeather(t), run: (t) => wikipedia(t) },
  { name: 'currency', live: true, match: (t, o) => moneyAsks(t, o).length > 0, run: (t, s, o) => currency(t, o) },
  { name: 'crypto',   live: true, match: (t) => CRYPTO_RE.test(t) || coinIds(t).length > 0, run: (t) => crypto(t) },
  { name: 'calendar', live: true, match: (t) => !!dayAsk(t, todayHere()), run: (t) => calendarDay(t) },
  { name: 'units',    live: true, match: (t) => !!unitAsk(t), run: (t) => unitBlock(unitAsk(t)) },
  { name: 'air',      live: true, match: (t) => AIR_RE.test(t),      run: (t, s) => airQuality(t, s) },
  { name: 'search',   live: (t) => SEARCH_ASK.test(t) || CURRENT_RE.test(t), match: (t) => SEARCH_RE.test(t) || CURRENT_RE.test(t), run: (t) => webSearch(t) },
  { name: 'page',     live: true, match: (t) => URL_RE.test(t),      run: (t) => readNamedUrl(t) },
  { name: 'sun',      live: true, match: (t) => SUN_RE.test(t), run: (t) => sunForPlace(t) },
  { name: 'clock',    live: true, match: (t) => /\btime\b/i.test(t) && /\b(?:in|at)\b/i.test(t), run: (t) => clockAnywhere(t) },
  // decide builds its ranges with gemma4:e4b on the hub CPU, 16-20 s. Inside the
  // deadline below it failed 919 times out of 919 (hub.log, Aug 7 to Nov 2), and
  // every "should I" turn waited the full 1.5 s for it. Not run inline until it
  // has a way to follow up after the reply.
  { name: 'decide',   slow: true, match: (t) => DECIDE_RE.test(t), run: (t) => decideTool(t) },
];

coins();

/** All matching tool outputs, fetched in parallel. '' when nothing matches.
 *  With { detail: true }: { text, live }, live when any block came from a live tool.
 *  With { liveOnly: true }: only the live tools run.
 *  With { recent: [lines] }: the talk before this line, oldest first, for a tool that needs it
 *  (currency: "what about fifty thousand yen" only means something after the line before). */
// A tool gets this long to answer, total. Nothing here is worth making the
// user wait: buildToolBlocks is awaited before the prompt is even built, and
// Promise.allSettled waits for the SLOWEST tool with no ceiling - so one
// hanging fetch used to sit on the whole voice turn until the phone's 30s cap
// fired and PAN said "Server didn't respond". A tool that misses the deadline
// simply contributes no block, which is a state the prompt already handles
// ("if the question needed such a block and none appeared, say so").
const TOOL_DEADLINE_MS = 1500;

function withDeadline(promise, ms, label) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms`)), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

// A lookup the line needed did not arrive. Without this the turn went on with no data and the
// model gave a figure from its own head, said as fact.
const lookupFailed = (what) => `\nLOOKUP FAILED: ${what} could not be fetched just now. Tell him in a few words that you could not look it up this time. Do NOT give a figure, a date or a name from memory.\n`;
const WHAT = { currency: 'the exchange rate', crypto: 'the coin price', weather: 'the weather', air: 'the air quality', clock: 'the time there', sun: 'the sun times', calendar: 'the date', units: 'the sum' };

export async function buildToolBlocks(text, sensors, opts = {}) {
  const t = String(text || '');
  const none = opts.detail ? { text: '', live: false } : '';
  if (!t) return none;
  if (CONVERSATIONAL_RE.test(t)) return none;
  const isLive = (tool) => (typeof tool.live === 'function' ? tool.live(t) : !!tool.live);
  const hits = TOOLS.filter((tool) => {
    if (tool.slow) return false;
    if (opts.skip && opts.skip.includes(tool.name)) return false;
    try { return tool.match(t, opts) && (!opts.liveOnly || isLive(tool)); } catch { return false; }
  });
  if (!hits.length) return none;

  const started = Date.now();
  const settled = await Promise.allSettled(
    hits.map((tool) => withDeadline(Promise.resolve().then(() => tool.run(t, sensors, opts)),
                                    TOOL_DEADLINE_MS, tool.name)));
  const blocks = [];
  let live = false;
  settled.forEach((r, i) => {
    // "Switch on your location" is an instruction, not data: the student already gives it.
    if (r.status === 'fulfilled' && r.value) { blocks.push(r.value); live = live || (isLive(hits[i]) && !r.value.includes('LOCATION UNAVAILABLE')); }
    else if (r.status === 'rejected') {
      console.warn(`[tools] ${hits[i].name}: ${r.reason?.message || r.reason}`);
      if (isLive(hits[i]) && WHAT[hits[i].name]) { blocks.push(lookupFailed(WHAT[hits[i].name])); live = true; }
    }
  });
  if (blocks.length) {
    console.log(`[tools] ${hits.map((h) => h.name).join('+')} -> ${blocks.length} block(s) in ${Date.now() - started}ms`);
  }
  return opts.detail ? { text: blocks.join(''), live } : blocks.join('');
}
