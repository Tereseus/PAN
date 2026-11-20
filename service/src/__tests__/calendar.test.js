// Dates worked out by code (calendar.js), checked against dates that are known.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dayAsk, dayBlock, sayDate } from '../calendar.js';

const today = { y: 2026, m: 11, d: 19 };      // a Thursday
const on = (line, t = today) => { const a = dayAsk(line, t); return a ? a.date.toISOString().slice(0, 10) : null; };

test('days set by a rule', () => {
  assert.equal(on('When is Thanksgiving this year'), '2026-11-26');
  assert.equal(on('When is Easter next year'), '2027-03-28');
  assert.equal(on('When is Orthodox Easter next year'), '2027-05-02');
  assert.equal(on('When is Greek Easter in 2026'), '2026-04-12');
  assert.equal(on('When is Mardi Gras next year'), '2027-02-09');
  assert.equal(on('When do the clocks go forward next in the US'), '2027-03-14');
  assert.equal(on('when do the clocks go back', { y: 2026, m: 10, d: 1 }), '2026-11-01');
  assert.equal(on("when is Mother's Day", { y: 2026, m: 3, d: 1 }), '2026-05-10');
  assert.equal(on('when is Memorial Day in 2026'), '2026-05-25');
  assert.equal(on('when is Labor Day in 2027'), '2027-09-06');
  assert.equal(on('when is Good Friday next year'), '2027-03-26');
});

test('days set by another calendar', () => {
  assert.equal(on('When does Ramadan start next year'), '2027-02-08');
  assert.equal(on('When is Chinese New Year next year'), '2027-02-06');
  assert.equal(on('when was lunar new year this year'), '2026-02-17');
  assert.equal(on('When does Hanukkah start this year'), '2026-12-05');      // said with "begins at sundown the evening before"
  assert.equal(on('when is Rosh Hashanah in 2026'), '2026-09-12');
  assert.equal(on('when is Passover next year'), '2027-04-22');
  assert.ok(['2027-03-09', '2027-03-10'].includes(on('When is Eid al-Fitr next year')));
  assert.ok(['2027-03-20', '2027-03-21'].includes(on('When is Nowruz')));
});

test('the same date every year, the next one from today', () => {
  assert.equal(on('When is Bastille Day'), '2027-07-14');
  assert.equal(on('When is Greek Independence Day'), '2027-03-25');
  assert.equal(on('when is Christmas'), '2026-12-25');
  assert.equal(on('when is Halloween'), '2027-10-31');
  assert.equal(on('when is Halloween this year'), '2026-10-31');
});

test('weekdays and day counts', () => {
  const xmas = dayAsk('What day of the week is Christmas this year', today);
  assert.equal(xmas.want, 'weekday');
  assert.match(dayBlock(xmas, today), /Out loud: "Christmas falls on a Friday, December twenty-fifth"/);
  assert.match(dayBlock(dayAsk('What day of the week is New Years Day', today), today), /falls on a Friday, January first, twenty twenty-seven/);
  assert.match(dayBlock(dayAsk('How many days until Christmas', today), today), /Out loud: "Christmas is thirty-six days from now, on December twenty-fifth, a Friday"/);
  assert.match(dayBlock(dayAsk('How many days until New Years', today), today), /is forty-three days from now/);
  assert.match(dayBlock(dayAsk('how many days until March 14th', today), today), /March fourteenth is one hundred fifteen days from now, a Sunday/);
  assert.match(dayBlock(dayAsk('what day of the week is the 4th of July', today), today), /Fourth of July falls on a Sunday, July fourth, twenty twenty-seven/);
  assert.match(dayBlock(dayAsk('When is Thanksgiving this year', today), today), /Out loud: "Thanksgiving is on November twenty-sixth, a Thursday"/);
  assert.match(dayBlock(dayAsk('When does Ramadan start next year', today), today), /Ramadan is on February eighth, twenty twenty-seven, a Monday, give or take a day/);
  assert.match(dayBlock(dayAsk('When does Hanukkah start this year', today), today), /Hanukkah is on December fifth, a Saturday, and it begins at sundown the evening before/);
  assert.match(dayBlock(dayAsk('When is the Day of the Dead', today), today), /is on November first, twenty twenty-seven and the day after/);
  assert.match(dayBlock(dayAsk('when was Thanksgiving last year', today), today), /Thanksgiving was on November twenty-seventh, twenty twenty-five, a Thursday/);
  assert.equal(sayDate(new Date(Date.UTC(2026, 10, 26)), today), 'Thursday, November twenty-sixth');
});

test('lines that ask no date', () => {
  for (const line of ['Merry Christmas', 'I love Thanksgiving dinner', 'we went there last Easter', 'what should I cook for Thanksgiving',
    'what time is it', 'when is the meeting', 'when is my flight', 'what day is it', 'how many days in a leap year', 'who won the game on Christmas',
    'When is Diwali', 'when is the next leap year']) {
    assert.equal(dayAsk(line, today), null, line);
  }
});
