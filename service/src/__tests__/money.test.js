// The money rules (money.js): which sum a spoken line asks for. The talk these come from
// (2026-11-19, paraphrased) went wrong on every line: yen was not a known currency, the model
// did the arithmetic, and two different amounts of yen both came out as the same dollars.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseNumber, moneyMentions, moneyAsk, moneyBlock, sayAmount } from '../money.js';

test('numbers the way they are said', () => {
  assert.equal(parseNumber('three million'), 3000000);
  assert.equal(parseNumber('eighteen hundred'), 1800);
  assert.equal(parseNumber('one thousand eight hundred'), 1800);
  assert.equal(parseNumber('fifty thousand'), 50000);
  assert.equal(parseNumber('two hundred million'), 200000000);
  assert.equal(parseNumber('two hundred and fifty'), 250);
  assert.equal(parseNumber('1,800'), 1800);
  assert.equal(parseNumber('200 million'), 200000000);
  assert.equal(parseNumber('2.5k'), 2500);
  assert.equal(parseNumber('half a million'), 500000);
  assert.equal(parseNumber('sixteen point five'), 16.5);
  assert.equal(parseNumber('a hundred'), 100);
  assert.equal(parseNumber('hello'), null);
  assert.equal(parseNumber(''), null);
});

test('the currencies in a line, each with its amount', () => {
  assert.deepEqual(moneyMentions('what is three million yen to u s d'), [{ amount: 3000000, code: 'JPY' }, { amount: null, code: 'USD' }]);
  assert.deepEqual(moneyMentions('How much is 1,800 yen then?'), [{ amount: 1800, code: 'JPY' }]);
  assert.deepEqual(moneyMentions('$30 in yen'), [{ amount: 30, code: 'USD' }, { amount: null, code: 'JPY' }]);
  assert.deepEqual(moneyMentions('twenty canadian dollars in euros'), [{ amount: 20, code: 'CAD' }, { amount: null, code: 'EUR' }]);
  assert.deepEqual(moneyMentions('about eighteen point seven nine dollars'), [{ amount: 18.79, code: 'USD' }]);
  assert.deepEqual(moneyMentions('a pound of flour'), []);
  assert.deepEqual(moneyMentions('I lost ten pounds this month'), []);
  assert.deepEqual(moneyMentions('who won the game'), [{ amount: null, code: 'KRW' }]);
});

test('an amount and another currency: that sum', () => {
  assert.deepEqual(moneyAsk('What is three million yen to USD'), [{ amount: 3000000, from: 'JPY', to: 'USD' }]);
  assert.deepEqual(moneyAsk('how much is two hundred million yen to u s d'), [{ amount: 200000000, from: 'JPY', to: 'USD' }]);
  assert.deepEqual(moneyAsk('How much is eighteen hundred yen to USD'), [{ amount: 1800, from: 'JPY', to: 'USD' }]);
  assert.deepEqual(moneyAsk('No, how much is it in dollars? Three thousand yen.'), [{ amount: 3000, from: 'JPY', to: 'USD' }]);
  assert.deepEqual(moneyAsk('$30 in yen'), [{ amount: 30, from: 'USD', to: 'JPY' }]);
  // his own guess at the answer is not a second sum
  assert.deepEqual(moneyAsk('is 3000 yen about 19 dollars'), [{ amount: 3000, from: 'JPY', to: 'USD' }]);
});

const TALK = ['What is three million yen to USD', 'About 18,750 dollars.'];

test('a follow up with one currency goes the way the talk was going', () => {
  assert.deepEqual(moneyAsk('What about fifty thousand yen?', TALK), [{ amount: 50000, from: 'JPY', to: 'USD' }]);
  assert.deepEqual(moneyAsk('Alright, how much is 1,800 yen then?', TALK), [{ amount: 1800, from: 'JPY', to: 'USD' }]);
  assert.deepEqual(moneyAsk('and forty dollars', TALK), [{ amount: 40, from: 'USD', to: 'JPY' }]);
});

test('"that" is the last amount in the talk', () => {
  const talk = [...TALK, 'How much do groceries cost for a week in Japan?', 'About 3000 yen. That is usually enough at most supermarkets.'];
  assert.deepEqual(moneyAsk('So what is that, like thirty bucks?', talk), [{ amount: 3000, from: 'JPY', to: 'USD' }]);
  assert.deepEqual(moneyAsk('what is that in dollars', talk), [{ amount: 3000, from: 'JPY', to: 'USD' }]);
});

test('a complaint that names the amounts gets each sum again, the right way round', () => {
  const talk = [...TALK, 'How much is 1,800 yen to USD', 'About 16.5 dollars.', 'How much is 3,000 yen in dollars', 'About 16.5 dollars.'];
  assert.deepEqual(
    moneyAsk('That makes no sense. Before you said 1800 yen is 16.5, now you say 3,000 yen is the same.', talk),
    [{ amount: 1800, from: 'JPY', to: 'USD' }, { amount: 3000, from: 'JPY', to: 'USD' }]);
});

test('one foreign amount and no talk: into the currency he thinks in', () => {
  assert.deepEqual(moneyAsk('how much is 20 euros'), [{ amount: 20, from: 'EUR', to: 'USD' }]);
  assert.deepEqual(moneyAsk('how much is 20 euros', [], 'GBP'), [{ amount: 20, from: 'EUR', to: 'GBP' }]);
  assert.deepEqual(moneyAsk('how much is 20 dollars'), []);
});

test('two currencies and no amount: the rate', () => {
  assert.deepEqual(moneyAsk("what's the exchange rate for yen to dollars"), [{ amount: 1, from: 'JPY', to: 'USD' }]);
});

test('lines that are not asking for a sum get none', () => {
  for (const line of ['I paid fifty dollars for it', 'this coffee cost me three euros', 'who won the game', 'how much is a pound of flour',
    'how much is 180 pounds in kilos', 'I have a meeting at three', 'what time is it in Tokyo', 'that was a million dollar idea']) {
    assert.deepEqual(moneyAsk(line), [], line);
  }
});

test('the block holds the finished sums', () => {
  const rates = { 'JPY>USD': 0.0062511 };
  const block = moneyBlock([{ amount: 1800, from: 'JPY', to: 'USD' }, { amount: 3000, from: 'JPY', to: 'USD' }], rates, '2026-11-19');
  assert.match(block, /1,800 JPY = 11\.25 USD/);
  assert.match(block, /3,000 JPY = 18\.75 USD/);
  assert.match(block, /1 USD = 160 JPY/);
  assert.match(moneyBlock([{ amount: 200000000, from: 'JPY', to: 'USD' }], rates), /200,000,000 JPY = 1,250,220 USD/);
  assert.equal(moneyBlock([{ amount: 5, from: 'JPY', to: 'CHF' }], rates), '');
  assert.equal(sayAmount(27000.4), '27,000');
  assert.equal(sayAmount(16.456), '16.46');
});
