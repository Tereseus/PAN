// Unit sums and the place a clock question names (sums.js). The lines are the kind the
// right-answer bench asks; the model got 7 of 16 unit sums wrong doing them itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unitAsk, unitBlock, convert, sayNumber, clockPlace, coinsAsked, outLoud, figureKey, keepFigures } from '../sums.js';

const sum = (line) => { const a = unitAsk(line); return a ? Math.round(convert(a.amount, a.from, a.to) * 100) / 100 : null; };

test('a measurement in another unit', () => {
  assert.equal(sum('How many miles is forty kilometres'), 24.85);
  assert.equal(sum('What is thirty eight Celsius in Fahrenheit'), 100.4);
  assert.equal(sum('How tall is six feet in centimetres'), 182.88);
  assert.equal(sum('What is a hundred and fifty pounds in kilos'), 68.04);
  assert.equal(sum('How many kilometres is five miles'), 8.05);
  assert.equal(sum('What is a hundred Fahrenheit in Celsius'), 37.78);
  assert.equal(sum('How many kilos is ten stone'), 63.5);
  assert.equal(sum('What is sixty miles an hour in kilometres an hour'), 96.56);
  assert.equal(sum('How many square metres in an acre'), 4046.86);
  assert.equal(sum('How many ounces in two litres'), 67.63);
  assert.equal(sum('How many millilitres is three tablespoons'), 44.36);
  assert.equal(sum('What is two hundred and twenty Celsius in Fahrenheit'), 428);
  assert.equal(sum('How many feet is a hundred metres'), 328.08);
  assert.equal(sum('How many pounds is twenty kilos'), 44.09);
  assert.equal(sum('convert 5 kg to lbs'), 11.02);
  assert.equal(sum('what is minus forty Celsius in Fahrenheit'), -40);
  assert.equal(sum('twenty-four inches in centimeters'), 60.96);
});

test('not a unit sum', () => {
  for (const line of ['How many kilometres is a marathon', 'How many cups is two hundred grams of flour', 'I ran five miles today', 'a pound of flour',
    'how much is eighty pounds in US dollars', 'what time is it in Tokyo', 'how tall is Mount Fuji', 'he lives ten miles from me in a small town',
    'put two cups of rice in the pot', 'how far is Osaka from Tokyo']) {
    assert.equal(unitAsk(line), null, line);
  }
});

test('the words to say', () => {
  assert.equal(sayNumber(24.8548), 'twenty-four point nine');
  assert.equal(sayNumber(100.4), 'one hundred point four');
  assert.equal(sayNumber(8.0467), 'eight point zero five');
  assert.equal(sayNumber(4046.86), 'four thousand forty-seven');
  assert.equal(sayNumber(-40), 'minus forty');
  assert.match(unitBlock(unitAsk('How many miles is forty kilometres')), /40 kilometres = 24\.9 miles\. Out loud: "forty kilometres is about twenty-four point nine miles"/);
  assert.match(unitBlock(unitAsk('What is two hundred and twenty Celsius in Fahrenheit')), /Out loud: "two hundred twenty degrees Celsius is four hundred twenty-eight degrees Fahrenheit"/);
  assert.match(unitBlock(unitAsk('How many square metres in an acre')), /Out loud: "one acre is about four thousand forty-seven square metres"/);
  assert.equal(unitBlock(null), '');
});

test('the coins a line asks the price of', () => {
  const coins = [['bitcoin', 'btc', 'Bitcoin', 1], ['ripple', 'xrp', 'XRP', 6], ['binancecoin', 'bnb', 'BNB', 4], ['dogecoin', 'doge', 'Dogecoin', 13],
    ['cardano', 'ada', 'Cardano', 18], ['litecoin', 'ltc', 'Litecoin', 24], ['rain', 'rain', 'Rain', 26], ['midnight-3', 'night', 'Midnight', 80],
    ['pearl', 'pearl', 'Pearl', 77], ['sky', 'sky', 'Sky', 66], ['just', 'jst', 'JUST', 63], ['gram', 'gram', 'Gram (prev. Toncoin)', 30], ['far', 'far', 'Farcoin', 400]]
    .map(([id, symbol, name, rank]) => ({ id, symbol, name, rank }));
  const asked = (line) => coinsAsked(line, coins);
  assert.deepEqual(asked('What is dogecoin at'), ['dogecoin']);
  assert.deepEqual(asked('How much is one XRP'), ['ripple']);
  assert.deepEqual(asked('What is cardano trading at'), ['cardano']);
  assert.deepEqual(asked('How much is a litecoin'), ['litecoin']);
  assert.deepEqual(asked('What is the price of BNB'), ['binancecoin']);
  assert.deepEqual(asked('what is bitcoin worth right now'), ['bitcoin']);
  assert.deepEqual(asked('price of farcoin'), []);
  for (const line of ['what is midnight', 'is it going to rain today', 'how much is the rain going to cost us', 'the sky is clear', 'I just got home',
    'how much is a pearl necklace', 'what is the price of gold', 'who won the game', 'how many grams in an ounce', 'what is just war theory']) {
    assert.deepEqual(asked(line), [], line);
  }
});

test('the place a clock question names', () => {
  assert.equal(clockPlace('What time is it over in Nigeria right now'), 'nigeria');
  assert.equal(clockPlace('What time is it in Kathmandu?'), 'kathmandu');
  assert.equal(clockPlace('what time is it for my friend in Addis Ababa'), 'addis ababa');
  assert.equal(clockPlace('What is the time in the Philippines at the moment'), 'philippines');
  assert.equal(clockPlace('what time is it'), '');
  assert.equal(clockPlace('what time is the game in the morning'), '');
  assert.equal(clockPlace('is there time in my schedule'), '');
  assert.equal(clockPlace('how much is rent in Lisbon'), '');
});

test('the figure the code worked out is the figure that is said', () => {
  const block = 'EXCHANGE RATE - real data.\n- 200 GBP = 262.4 USD. Out loud: "two hundred pounds is about two hundred sixty-two dollars"\n- the rate: 1 GBP = 1.31 USD\n';
  const loud = outLoud(block);
  assert.deepEqual(loud, ['two hundred pounds is about two hundred sixty-two dollars']);
  assert.equal(figureKey(loud[0]), 'two hundred sixty two dollars');
  assert.equal(figureKey('Ethereum is at about one thousand seven hundred fifty dollars'), 'one thousand seven hundred fifty dollars');
  assert.equal(figureKey('Christmas is thirty-six days from now, on December twenty-fifth, a Friday'), 'thirty six days');
  assert.equal(figureKey('Thanksgiving is on November twenty-sixth, a Thursday'), 'november twenty sixth');
  assert.equal(figureKey('Christmas falls on a Friday, December twenty-fifth'), 'friday');
  const json = (response, extra = {}) => JSON.stringify({ to: 'pan', response, intent: 'query', addressed: 0.9, ...extra });
  // the model kept the figure: its own words stand
  assert.equal(keepFigures(json('About two hundred sixty-two dollars.'), loud).changed, false);
  assert.equal(keepFigures(json('Two hundred pounds is about two hundred sixty-two dollars, give or take.'), loud).changed, false);
  // it changed the figure: the code's sentence is said
  const fixed = keepFigures(json("That's about five hundred twelve dollars."), loud);
  assert.equal(fixed.changed, true);
  assert.equal(JSON.parse(fixed.text).response, 'Two hundred pounds is about two hundred sixty-two dollars.');
  assert.equal(JSON.parse(fixed.text).addressed, 0.9);
  assert.equal(keepFigures(json('About 262 dollars.'), loud).changed, true);      // same sum, but checked by words only: the code's words are said
  // no figure in the reply, or it stayed quiet: left alone
  assert.equal(keepFigures(json('Got it.'), loud).changed, false);
  assert.equal(keepFigures(JSON.stringify({ intent: 'ambient', addressed: 0.1, response: '[AMBIENT]' }), loud).changed, false);
  assert.equal(keepFigures(json(''), loud).changed, false);
  // two sums: both must be there
  const two = ['one thousand eight hundred yen is about eleven dollars and twenty-five cents', 'three thousand yen is about eighteen dollars and seventy-five cents'];
  assert.equal(keepFigures(json('I got that wrong. One thousand eight hundred yen is eleven dollars and twenty-five cents, and three thousand yen is eighteen dollars and seventy-five cents.'), two).changed, false);
  assert.equal(JSON.parse(keepFigures(json('Both are sixteen dollars.'), two).text).response,
    'One thousand eight hundred yen is about eleven dollars and twenty-five cents. Three thousand yen is about eighteen dollars and seventy-five cents.');
  // plain words, no JSON
  assert.equal(keepFigures('One is thirteen hundred fifty dollars.', ['Ethereum is at about one thousand seven hundred fifty dollars']).text, 'Ethereum is at about one thousand seven hundred fifty dollars.');
  assert.equal(keepFigures(json('anything'), []).changed, false);
});
