import { test } from 'node:test';
import assert from 'node:assert/strict';
import { arithAsk, arithBlock } from '../arith.js';
import { outLoud, keepFigures } from '../sums.js';

const said = (line) => outLoud(arithBlock(arithAsk(line)))[0];

test('the line that was answered wrong (Nov 24): seven times eight is fifty-six', () => {
  assert.equal(arithAsk('what is seven times eight').value, 56);
  assert.equal(said('What is seven times eight?'), 'seven times eight is fifty-six');
});

test('spoken and written sums', () => {
  const v = (l) => arithAsk(l)?.value;
  assert.equal(v("what's 12 plus 30"), 42);
  assert.equal(v('how much is one hundred and five minus twenty'), 85);
  assert.equal(v('what is 144 divided by 12'), 12);
  assert.equal(v('what is 7 x 6'), 42);
  assert.equal(v('9*9'), 81);
  assert.equal(v('what is 2 plus 3 times 4'), 14);            // times before plus
  assert.equal(v('what is twelve squared'), 144);
  assert.equal(v('what is 2 to the power of 10'), 1024);
  assert.equal(v('what is the square root of 81'), 9);
  assert.equal(v('subtract five from twelve'), 7);
  assert.equal(v('add five and seven'), 12);
  assert.equal(v('multiply six by seven'), 42);
  assert.equal(v('what is half of 90'), 45);
  assert.equal(v('three quarters of two hundred'), 150);
  assert.equal(v('what is twenty four point five times two'), 49);
  assert.equal(v('what is 1,250 times 4'), 5000);
});

test('percentages', () => {
  assert.equal(arithAsk("what's 20 percent of 85").value, 17);
  assert.equal(arithAsk('what is 15% of 200').value, 30);
  assert.equal(said("what's 20 percent of 85"), 'twenty percent of eighty-five is seventeen');
});

test('a figure that is not whole is said as about, rounded the way it is spoken', () => {
  assert.equal(said('what is 10 divided by 3'), 'ten divided by three is about three point three three');
  assert.equal(said('what is 0.1 plus 0.2'), 'zero point one plus zero point two is zero point three');
});

test('a sum with no answer says so and gives no figure', () => {
  assert.equal(said('what is 5 divided by 0'), 'five divided by zero has no answer');
});

test('lines that are not sums are left alone', () => {
  for (const line of ['I worked seven days times twelve hours', 'what time is it', 'how are you',
    'the battery is at forty percent', 'two and three', 'seven times out of ten', 'what is the capital of France',
    'how much is 3 times 4 dollars', 'how many kilometres is forty miles', 'call me in five minutes',
    'x marks the spot', 'what is ten', 'times are hard']) {
    assert.equal(arithAsk(line), null, line);
    assert.equal(arithBlock(arithAsk(line)), '', line);
  }
});

test('the reply must keep the worked out figure', () => {
  const loud = outLoud(arithBlock(arithAsk('what is seven times eight')));
  assert.equal(keepFigures("That's fifty-six.", loud).changed, false);
  const wrong = keepFigures("That's fourteen.", loud);
  assert.equal(wrong.changed, true);
  assert.equal(wrong.text, 'Seven times eight is fifty-six.');
  assert.equal(keepFigures('That is 14.', loud).changed, true);
});
