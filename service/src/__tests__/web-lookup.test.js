// Reading a search page for the lines that speak to a question (web-lookup.js). The browser
// itself is not started here: these are the pure parts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { notesFromPage, pick, pageLines, grams, sentences, looksLikeBotCheck, ENGINES, DEFAULT_ENGINE, engineFor, lookupStatus } from '../web-lookup.js';

const PAGE = [
  'All', 'Images', 'News', 'Videos', 'Maps', 'Search Settings',
  'Wikipedia',
  'https://en.wikipedia.org › wiki › Example_Cup_final',
  'Who won the Example Cup',
  'Northland beat Southland 2 to 1 after extra time to win the Example Cup, its second title.',
  'Sports Daily',
  'https://sportsdaily.example › cup',
  'Example Cup final: how the match was decided',
  'The winning goal came in the 106th minute in front of 80,000 people at the national stadium.',
  'Travel Notes',
  'Ten things to do in Southland this winter, from hot springs to night markets and mountain trains.',
].join('\n');

test('the lines that hold the answer are kept, titles and links are not', () => {
  const notes = notesFromPage('who won the Example Cup', PAGE);
  assert.ok(notes.some((n) => /Northland beat Southland/.test(n)), notes.join(' | '));
  assert.ok(!notes.some((n) => /^https?:|›/.test(n)), 'a link is not a note');
  assert.ok(!notes.includes('Who won the Example Cup'), 'a line that only says the question back is not a note');
  assert.ok(notes.join('').length <= 450);
});

test('a page with nothing on the question gives no notes', () => {
  assert.deepEqual(notesFromPage('how tall is the Eiffel Tower', 'Ten things to do in Southland this winter, from hot springs to night markets.\nRecipes for a quick weeknight dinner with five ingredients or fewer.'), []);
  assert.deepEqual(notesFromPage('anything', ''), []);
});

test('the budget is kept and long lines are cut', () => {
  const long = 'The Example Cup ' + 'was won by Northland in a match that went on and on '.repeat(12) + 'in the end.';
  const notes = pick('who won the Example Cup', pageLines(long + '\n' + PAGE), 300);
  assert.ok(notes.join('').length <= 300);
  assert.ok(notes.every((n) => n.length <= 261));
});

test('other scripts: a question and a page in Japanese', () => {
  const page = 'オーストラリアの首都 - 検索\nオーストラリアの首都はキャンベラで、シドニーとメルボルンの間に計画都市として建設されました。\n旅行ガイド：冬のおすすめ温泉と夜市の楽しみ方を紹介します。';
  const notes = notesFromPage('オーストラリアの首都はどこですか', page);
  assert.ok(notes.length >= 1 && /キャンベラ/.test(notes[0]), notes.join(' | '));
  assert.ok(grams('オーストラリア').has('オー'));
});

test('sentences and the bot check', () => {
  assert.deepEqual(sentences('It is 3,776 meters tall. It last erupted in 1707.'), ['It is 3,776 meters tall.', 'It last erupted in 1707.']);
  assert.equal(looksLikeBotCheck('Our systems have detected unusual traffic from your computer network.'), true);
  assert.equal(looksLikeBotCheck('Verifying you’re not a bot. Quick check before you continue searching.'), true);
  // a long results page that happens to hold the word is a results page
  assert.equal(looksLikeBotCheck('How CAPTCHA works. ' + 'A real article about web security and how sites tell people from programs. '.repeat(30)), false);
  assert.equal(looksLikeBotCheck(''), false);
});

test('the default engine is the private one and every engine makes a search address', () => {
  assert.equal(DEFAULT_ENGINE, 'duckduckgo');
  for (const e of Object.values(ENGINES)) assert.match(e.url('a b&c'), /^https:\/\/[^ ]+a(?:%20|\+)b%26c/);
});

test('a blocked search site is skipped until its rest is over, and the status says so', () => {
  const now = 1_000_000;
  assert.equal(engineFor('duckduckgo', new Map(), now), 'duckduckgo');
  assert.equal(engineFor('duckduckgo', new Map([['duckduckgo', now + 5000]]), now), 'bing');
  assert.equal(engineFor('duckduckgo', new Map([['duckduckgo', now - 1]]), now), 'duckduckgo', 'the rest is over');
  assert.equal(engineFor('qwant', new Map([['qwant', now + 5000]]), now), 'duckduckgo', 'his choice is resting: the default next');
  assert.equal(engineFor('duckduckgo', new Map([['duckduckgo', now + 1], ['bing', now + 1], ['qwant', now + 1]]), now), null);
  assert.equal(engineFor('no-such-engine', new Map(), now), 'duckduckgo');
  const st = lookupStatus('duckduckgo');
  assert.equal(st.chosen, 'duckduckgo');
  assert.equal(st.using, 'duckduckgo');
  assert.ok(st.engines.some((e) => e.id === 'duckduckgo' && e.blockedUntil === 0));
  assert.ok(st.dayLimit > 100);
});
