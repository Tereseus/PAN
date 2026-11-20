// Dates a voice model must not guess: when a holiday falls, what weekday a date is, how many
// days until it. Worked out from the calendars the runtime carries (Gregorian, Islamic, Hebrew,
// Chinese, Persian) and the rules the days are set by. Pure functions: __tests__/calendar.test.js.
//
// Why (right-answer bench, 2026-11-19): the hub model put Thanksgiving on November 23rd, Ramadan
// on April 23rd, Christmas on a Monday and sixteen days away. 15 of 21 date questions wrong.
import { numberWords } from './money.js';

const DAY = 86400000;
const utc = (y, m, d) => new Date(Date.UTC(y, m - 1, d));
const plus = (date, days) => new Date(date.getTime() + days * DAY);
/** The nth (1 to 4) given weekday of a month, or the last one (n = -1). dow: 0 Sunday to 6 Saturday. */
function nthWeekday(y, m, dow, n) {
  if (n > 0) { const first = utc(y, m, 1); return plus(first, ((dow - first.getUTCDay() + 7) % 7) + 7 * (n - 1)); }
  const last = utc(y, m + 1, 0);
  return plus(last, -((last.getUTCDay() - dow + 7) % 7));
}
function easter(y) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  return utc(y, Math.floor((h + l - 7 * m + 114) / 31), ((h + l - 7 * m + 114) % 31) + 1);
}
function orthodoxEaster(y) {
  const a = y % 4, b = y % 7, c = y % 19, d = (19 * c + 15) % 30, e = (2 * a + 4 * b - d + 34) % 7;
  // the Julian date, then the 13 days between the calendars (1900 to 2099)
  return plus(utc(y, Math.floor((d + e + 114) / 31), ((d + e + 114) % 31) + 1), 13);
}

// A day set by another calendar: the first Gregorian day, from `from` on, that is that month and day there.
const FORMATS = {};
function otherCalendar(calendar, date) {
  const f = FORMATS[calendar] || (FORMATS[calendar] = new Intl.DateTimeFormat(`en-u-ca-${calendar}`, { month: calendar === 'hebrew' ? 'long' : 'numeric', day: 'numeric', timeZone: 'UTC' }));
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
  return { month: p.month, day: Number(p.day) };
}
function nextIn(calendar, month, day, from, within = 400) {
  for (let i = 0; i < within; i++) {
    const d = plus(from, i);
    const c = otherCalendar(calendar, d);
    if (String(c.month) === String(month) && c.day === day) return d;
  }
  return null;
}

// The runtime's Chinese calendar puts the new year a day off in 2027 and 2030 (the new moon falls
// minutes from midnight in Beijing), so these are the published dates, not a sum.
const LUNAR_NEW_YEAR = { 2025: [1, 29], 2026: [2, 17], 2027: [2, 6], 2028: [1, 26], 2029: [2, 13], 2030: [2, 3], 2031: [1, 23], 2032: [2, 11],
  2033: [1, 31], 2034: [2, 19], 2035: [2, 8], 2036: [1, 28], 2037: [2, 15], 2038: [2, 4], 2039: [1, 24], 2040: [2, 12] };

// [names as said, what to call it, how its date is found, note said with it]
//   { md: [month, day] }                    the same date every year
//   { rule: (year) => Date }                set by a rule
//   { cal: [calendar, month, day] }         set by another calendar
//   { table: { year: [month, day] } }       published dates, where no sum is safe
const DAYS = [
  ['christmas eve', 'Christmas Eve', { md: [12, 24] }],
  ['orthodox christmas', 'Orthodox Christmas', { md: [1, 7] }],
  ['christmas(?: day)?|xmas', 'Christmas', { md: [12, 25] }],
  ['boxing day', 'Boxing Day', { md: [12, 26] }],
  ["new year'?s eve", "New Year's Eve", { md: [12, 31] }],
  ["(?:chinese|lunar) new year'?s?|spring festival|tet\\b", 'Lunar New Year', { table: LUNAR_NEW_YEAR }],
  ['(?:islamic|hijri) new year', 'the Islamic New Year', { cal: ['islamic-umalqura', 1, 1] }, 'moon'],
  ['(?:jewish new year|rosh hashanah?)', 'Rosh Hashanah', { cal: ['hebrew', 'Tishri', 1] }, 'sundown'],
  ['(?:persian new year|nowruz|norooz|navroz)', 'Nowruz', { cal: ['persian', 1, 1] }, 'equinox'],
  ["new year'?s?(?: day)?|new years", "New Year's Day", { md: [1, 1] }],
  ["valentine'?s?(?: day)?", "Valentine's Day", { md: [2, 14] }],
  ["(?:saint|st\\.?) patrick'?s(?: day)?|paddy'?s day", "Saint Patrick's Day", { md: [3, 17] }],
  ['greek independence day', 'Greek Independence Day', { md: [3, 25] }],
  ['earth day', 'Earth Day', { md: [4, 22] }],
  ['anzac day', 'Anzac Day', { md: [4, 25] }],
  ["may day|international workers'?(?: day)?", 'May Day', { md: [5, 1] }],
  ['cinco de mayo', 'Cinco de Mayo', { md: [5, 5] }],
  ['juneteenth', 'Juneteenth', { md: [6, 19] }],
  ['canada day', 'Canada Day', { md: [7, 1] }],
  ['(?:the )?(?:fourth|4th) of july|independence day|july (?:the )?(?:fourth|4th)', 'the Fourth of July', { md: [7, 4] }],
  ['bastille day', 'Bastille Day', { md: [7, 14] }],
  ['oh?[ic] day|ochi day', 'Ohi Day', { md: [10, 28] }],
  ["hallowe?'?en", 'Halloween', { md: [10, 31] }],
  ['(?:day of the dead|dia de (?:los )?muertos)', 'the Day of the Dead', { md: [11, 2] }, 'dead'],
  ['guy fawkes(?: night| day)?|bonfire night', 'Bonfire Night', { md: [11, 5] }],
  ["veterans'? day|remembrance day|armistice day", 'Veterans Day', { md: [11, 11] }],
  ['australia day', 'Australia Day', { md: [1, 26] }],
  ['songkran', 'Songkran', { md: [4, 13] }],
  ['epiphany|three kings(?: day)?', 'Epiphany', { md: [1, 6] }],
  ['canadian thanksgiving|thanksgiving in canada', 'Canadian Thanksgiving', { rule: (y) => nthWeekday(y, 10, 1, 2) }],
  ['thanksgiving', 'Thanksgiving', { rule: (y) => nthWeekday(y, 11, 4, 4) }],
  ['black friday', 'Black Friday', { rule: (y) => plus(nthWeekday(y, 11, 4, 4), 1) }],
  ["mother'?s'? day", "Mother's Day", { rule: (y) => nthWeekday(y, 5, 0, 2) }],
  ["father'?s'? day", "Father's Day", { rule: (y) => nthWeekday(y, 6, 0, 3) }],
  ['labou?r day', 'Labor Day', { rule: (y) => nthWeekday(y, 9, 1, 1) }],
  ['memorial day', 'Memorial Day', { rule: (y) => nthWeekday(y, 5, 1, -1) }],
  ['(?:mlk|martin luther king)(?: junior| jr\\.?)?(?: day)?', 'Martin Luther King Day', { rule: (y) => nthWeekday(y, 1, 1, 3) }],
  ["presidents'? day", "Presidents' Day", { rule: (y) => nthWeekday(y, 2, 1, 3) }],
  ['(?:greek |orthodox )+(?:easter|pascha)|pascha', 'Orthodox Easter', { rule: orthodoxEaster }],
  ['good friday', 'Good Friday', { rule: (y) => plus(easter(y), -2) }],
  ['easter monday', 'Easter Monday', { rule: (y) => plus(easter(y), 1) }],
  ['palm sunday', 'Palm Sunday', { rule: (y) => plus(easter(y), -7) }],
  ['ash wednesday', 'Ash Wednesday', { rule: (y) => plus(easter(y), -46) }],
  ['mardi gras|fat tuesday|shrove tuesday|pancake day', 'Mardi Gras', { rule: (y) => plus(easter(y), -47) }],
  ['pentecost|whitsun', 'Pentecost', { rule: (y) => plus(easter(y), 49) }],
  ['easter(?: sunday| day)?', 'Easter', { rule: easter }],
  ['(?:the )?clocks? (?:go|goes|going|spring|move|change) (?:forward|ahead)|daylight sav(?:ing|ings)(?: time)? (?:start|begin)s?|spring forward', 'the clocks going forward in the United States', { rule: (y) => nthWeekday(y, 3, 0, 2) }],
  ['(?:the )?clocks? (?:go|goes|going|fall|move|change) back|daylight sav(?:ing|ings)(?: time)? ends?|fall back', 'the clocks going back in the United States', { rule: (y) => nthWeekday(y, 11, 0, 1) }],
  ['ramadh?an', 'Ramadan', { cal: ['islamic-umalqura', 9, 1] }, 'moon'],
  ['eid(?: al| ul| el)?[- ]fitr|eid\\b(?! al[- ]adha)', 'Eid al-Fitr', { cal: ['islamic-umalqura', 10, 1] }, 'moon'],
  ['eid(?: al| ul| el)?[- ]adha', 'Eid al-Adha', { cal: ['islamic-umalqura', 12, 10] }, 'moon'],
  ['yom kippur', 'Yom Kippur', { cal: ['hebrew', 'Tishri', 10] }, 'sundown'],
  ['hanukk?ah|chanukk?ah', 'Hanukkah', { cal: ['hebrew', 'Kislev', 25] }, 'sundown'],
  ['passover|pesach', 'Passover', { cal: ['hebrew', 'Nisan', 15] }, 'sundown'],
].map(([names, title, how, note]) => ({ re: new RegExp(`(?<![a-z])(?:${names})(?![a-z])`, 'i'), title, how, note: note || '' }));

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const ORDINALS = ['', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth', 'eleventh', 'twelfth', 'thirteenth',
  'fourteenth', 'fifteenth', 'sixteenth', 'seventeenth', 'eighteenth', 'nineteenth', 'twentieth', 'twenty-first', 'twenty-second', 'twenty-third',
  'twenty-fourth', 'twenty-fifth', 'twenty-sixth', 'twenty-seventh', 'twenty-eighth', 'twenty-ninth', 'thirtieth', 'thirty-first'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const dayNumber = (word) => {
  const w = String(word).toLowerCase().replace(/\s+/g, '-');
  if (/^\d{1,2}(?:st|nd|rd|th)?$/.test(w)) return parseInt(w, 10);
  const i = ORDINALS.indexOf(w);
  return i > 0 ? i : null;
};
const DAY_WORD = `(\\d{1,2}(?:st|nd|rd|th)?|${ORDINALS.slice(1).sort((a, b) => b.length - a.length).map((o) => o.replace('-', '[- ]')).join('|')})`;
const PLAIN_DATE = new RegExp(`\\b(${MONTHS.join('|')}) (?:the )?${DAY_WORD}\\b|\\b(?:the )?${DAY_WORD} (?:of )?(${MONTHS.join('|')})\\b`, 'i');

const WANT_DAYS = /\bhow (?:many|long) (?:more )?(?:days?|sleeps|weeks?)?\s*(?:is it |are there |do we have |left )?(?:un)?till?\b|\bhow (?:many days|long) (?:to|before|to go)\b|\bdays? (?:left )?(?:un)?till?\b|\bhow far (?:away|off) is\b|\bhow long (?:is it )?(?:un)?till?\b/i;
const WANT_WEEKDAY = /\bwhat day of the week\b|\bwhich day of the week\b|\bwhat weekday\b|\bis .{0,40} on a (?:week ?end|week ?day|sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i;
const WANT_WHEN = /\bwhen(?:'s| is| was| does| do| did| will| are)\b|\bwhat (?:day|date)\b|\bwhich (?:day|date)\b|\bwhat's the date\b/i;

/**
 * The date question a line asks: { title, date, want: 'when' | 'days' | 'weekday', note }, or null.
 * `today` is { y, m, d } in his own time zone.
 */
export function dayAsk(text, today) {
  const line = String(text || '').toLowerCase().replace(/[‘’]/g, "'");
  const want = WANT_DAYS.test(line) ? 'days' : WANT_WEEKDAY.test(line) ? 'weekday' : WANT_WHEN.test(line) ? 'when' : null;
  if (!want) return null;
  const now = utc(today.y, today.m, today.d);
  const yearSaid = (line.match(/\b(20\d\d)\b/) || [])[1];
  const year = yearSaid ? Number(yearSaid) : /\bnext year\b/.test(line) ? today.y + 1 : /\blast year\b/.test(line) ? today.y - 1 : /\bthis year\b/.test(line) ? today.y : null;
  // the next one from today, unless a year is named
  const resolve = (how) => {
    if (how.md) {
      if (year) return utc(year, how.md[0], how.md[1]);
      const d = utc(today.y, how.md[0], how.md[1]);
      return d >= now ? d : utc(today.y + 1, how.md[0], how.md[1]);
    }
    if (how.rule) {
      if (year) return how.rule(year);
      const d = how.rule(today.y);
      return d >= now ? d : how.rule(today.y + 1);
    }
    if (how.table) {
      const at = (y) => (how.table[y] ? utc(y, how.table[y][0], how.table[y][1]) : null);
      if (year) return at(year);
      const d = at(today.y);
      return d && d >= now ? d : at(today.y + 1);
    }
    return year ? nextIn(how.cal[0], how.cal[1], how.cal[2], utc(year, 1, 1), 366) : nextIn(how.cal[0], how.cal[1], how.cal[2], now);
  };
  for (const day of DAYS) {
    if (!day.re.test(line)) continue;
    const date = resolve(day.how);
    return date ? { title: day.title, date, want, note: day.note } : null;
  }
  const m = line.match(PLAIN_DATE);
  if (m && want !== 'when') {
    const month = MONTHS.indexOf((m[1] || m[4]).toLowerCase()) + 1;
    const dayOfMonth = dayNumber(m[2] || m[3]);
    if (!dayOfMonth || dayOfMonth > 31) return null;
    const date = resolve({ md: [month, dayOfMonth] });
    return { title: `${MONTHS[month - 1][0].toUpperCase()}${MONTHS[month - 1].slice(1)} ${ORDINALS[dayOfMonth]}`, date, want, note: 'plain' };
  }
  return null;
}

const sayYear = (y) => (y >= 2010 && y <= 2099 ? `twenty ${numberWords(y - 2000)}` : numberWords(y));
/** A date the way it is said: "Thursday, November twenty-sixth" (and the year when it is not this one). */
export function sayDate(date, today) {
  const y = date.getUTCFullYear();
  return `${WEEKDAYS[date.getUTCDay()]}, ${MONTHS[date.getUTCMonth()][0].toUpperCase()}${MONTHS[date.getUTCMonth()].slice(1)} ${ORDINALS[date.getUTCDate()]}`
    + (today && y !== today.y ? `, ${sayYear(y)}` : '');
}

/** The block the model reads: the date worked out, with the words to say. '' when there is no ask. */
export function dayBlock(ask, today) {
  if (!ask) return '';
  const now = utc(today.y, today.m, today.d);
  const days = Math.round((ask.date - now) / DAY);
  const away = days === 0 ? 'today' : days === 1 ? 'tomorrow' : days === -1 ? 'yesterday' : days > 0 ? `${numberWords(days)} days from now` : `${numberWords(-days)} days ago`;
  const verb = days < 0 ? 'was' : 'is';
  const iso = ask.date.toISOString().slice(0, 10);
  // The date leads, the weekday follows: "November twenty-sixth, a Thursday".
  const dayOf = (d) => `${MONTHS[d.getUTCMonth()][0].toUpperCase()}${MONTHS[d.getUTCMonth()].slice(1)} ${ORDINALS[d.getUTCDate()]}${d.getUTCFullYear() !== today.y ? `, ${sayYear(d.getUTCFullYear())}` : ''}`;
  let on = `${dayOf(ask.date)}, a ${WEEKDAYS[ask.date.getUTCDay()]}`;
  let extra = '';
  if (ask.note === 'moon') extra = ', give or take a day, because it follows the sighting of the moon';
  if (ask.note === 'equinox') extra = ', give or take a day, because it follows the spring equinox';
  if (ask.note === 'sundown') extra = ', and it begins at sundown the evening before';
  if (ask.note === 'dead') on = `${dayOf(plus(ask.date, -1))} and the day after`;
  const said = ask.note === 'plain'
    ? (ask.want === 'days' ? `${ask.title} ${verb} ${away}, a ${WEEKDAYS[ask.date.getUTCDay()]}` : `${ask.title} ${verb} a ${WEEKDAYS[ask.date.getUTCDay()]}`)
    : ask.want === 'days' ? `${ask.title} ${verb} ${away}, on ${on}${extra}`
      : ask.want === 'weekday' ? `${ask.title} ${days < 0 ? 'fell' : 'falls'} on a ${WEEKDAYS[ask.date.getUTCDay()]}, ${MONTHS[ask.date.getUTCMonth()][0].toUpperCase()}${MONTHS[ask.date.getUTCMonth()].slice(1)} ${ORDINALS[ask.date.getUTCDate()]}${ask.date.getUTCFullYear() !== today.y ? `, ${sayYear(ask.date.getUTCFullYear())}` : ''}`
        : `${ask.title} ${verb} on ${on}${extra}`;
  return '\nCALENDAR - worked out by code from the calendar, it is exact. Use the words after "Out loud" as they are: do no date sums and do not change the date.\n'
    + `- ${ask.title}: ${iso} (${WEEKDAYS[ask.date.getUTCDay()]}), ${days} days from today. Out loud: "${said[0].toUpperCase()}${said.slice(1)}"\n`;
}
