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

// --- Currency: USD/EUR conversions come up often ---------------------------
const CURRENCY_RE = /\b(exchange rate|conversion rate|convert|how much is|worth in|in (?:usd|eur|dollars|euros|pounds|gbp))\b|\b(usd|eur|gbp|dollars?|euros?|pounds?)\b.*\bto\b.*\b(usd|eur|gbp|dollars?|euros?|pounds?)\b/i;
const CODE = { dollar: 'USD', dollars: 'USD', usd: 'USD', euro: 'EUR', euros: 'EUR', eur: 'EUR', pound: 'GBP', pounds: 'GBP', gbp: 'GBP' };

async function currency(text) {
  const found = [];
  for (const m of String(text).toLowerCase().matchAll(/\b(usd|eur|gbp|dollars?|euros?|pounds?)\b/g)) {
    const c = CODE[m[1]];
    if (c && !found.includes(c)) found.push(c);
  }
  const from = found[0] || 'USD';
  const to = found[1] || (from === 'EUR' ? 'USD' : 'EUR');
  if (from === to) return '';
  const j = await getJson(`https://api.frankfurter.app/latest?from=${from}&to=${to}`);
  const rate = j?.rates?.[to];
  if (rate == null) return '';
  return `\nEXCHANGE RATE (European Central Bank, ${j.date}) - real data:\n` +
    `- 1 ${from} = ${rate} ${to}\n- 1 ${to} = ${(1 / rate).toFixed(4)} ${from}\n`;
}

// --- Crypto: relevant to Dream Fights and the data-staking work ------------
const CRYPTO_RE = /\b(bitcoin|btc|ethereum|eth|solana|sol|crypto|usdc)\b/i;
const COINS = { bitcoin: 'bitcoin', btc: 'bitcoin', ethereum: 'ethereum', eth: 'ethereum', solana: 'solana', sol: 'solana', usdc: 'usd-coin' };

async function crypto(text) {
  const ids = [];
  for (const m of String(text).toLowerCase().matchAll(/\b(bitcoin|btc|ethereum|eth|solana|sol|usdc)\b/g)) {
    const id = COINS[m[1]];
    if (id && !ids.includes(id)) ids.push(id);
  }
  if (!ids.length) ids.push('bitcoin', 'ethereum');
  const j = await getJson(
    'https://api.coingecko.com/api/v3/simple/price?ids=' + ids.join(',') +
    '&vs_currencies=usd&include_24hr_change=true');
  const lines = [];
  for (const [id, v] of Object.entries(j || {})) {
    const ch = v.usd_24h_change;
    lines.push(`- ${id}: $${Math.round(v.usd).toLocaleString('en-US')}` +
      (ch != null ? ` (${ch >= 0 ? '+' : ''}${ch.toFixed(1)}% in 24h)` : ''));
  }
  if (!lines.length) return '';
  return '\nCRYPTO PRICES (CoinGecko, live) - real data:\n' + lines.join('\n') + '\n';
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

async function webSearch(text) {
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

const TOOLS = [
  { name: 'weather',  match: (t) => looksLikeWeather(t), run: (t, s) => buildWeatherBlock(t, s) },
  { name: 'wikipedia',match: (t) => WIKI_RE.test(t) && !looksLikeWeather(t), run: (t) => wikipedia(t) },
  { name: 'currency', match: (t) => CURRENCY_RE.test(t), run: (t) => currency(t) },
  { name: 'crypto',   match: (t) => CRYPTO_RE.test(t),   run: (t) => crypto(t) },
  { name: 'air',      match: (t) => AIR_RE.test(t),      run: (t, s) => airQuality(t, s) },
  { name: 'search',   match: (t) => SEARCH_RE.test(t) || CURRENT_RE.test(t), run: (t) => webSearch(t) },
  { name: 'page',     match: (t) => URL_RE.test(t),      run: (t) => readNamedUrl(t) },
  { name: 'decide',   match: (t) => DECIDE_RE.test(t),   run: (t) => decideTool(t) },
];

/** All matching tool outputs, fetched in parallel. '' when nothing matches. */
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

export async function buildToolBlocks(text, sensors) {
  const t = String(text || '');
  if (!t) return '';
  if (CONVERSATIONAL_RE.test(t)) return '';
  const hits = TOOLS.filter((tool) => {
    try { return tool.match(t); } catch { return false; }
  });
  if (!hits.length) return '';

  const started = Date.now();
  const settled = await Promise.allSettled(
    hits.map((tool) => withDeadline(Promise.resolve().then(() => tool.run(t, sensors)),
                                    TOOL_DEADLINE_MS, tool.name)));
  const blocks = [];
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled' && r.value) blocks.push(r.value);
    else if (r.status === 'rejected') console.warn(`[tools] ${hits[i].name}: ${r.reason?.message || r.reason}`);
  });
  if (blocks.length) {
    console.log(`[tools] ${hits.map((h) => h.name).join('+')} -> ${blocks.length} block(s) in ${Date.now() - started}ms`);
  }
  return blocks.join('');
}
