// Listening modes (listen-mode.js). Usage: node service/src/__tests__/listen-mode.test.js
import { modeAsked, modeTurn, startsWithAny, cleanWords } from '../listen-mode.js';

let passed = 0, failed = 0;
const t = (name, fn) => { try { fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { failed++; console.log(`  ✗ ${name}: ${e.message}`); } };
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m || ''} got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`); };

console.log('\nlisten-mode\n');
t('mode commands', () => {
  eq(modeAsked('Just listen.'), 'listen');
  eq(modeAsked('Pan, listen only'), 'listen');
  eq(modeAsked('Okay, go into listen mode please'), 'listen');
  eq(modeAsked('Only answer to your name.'), 'name');
  eq(modeAsked('Pan only answer when I say your name'), 'name');
  eq(modeAsked('Back to normal.'), 'normal');
  eq(modeAsked('Okay you can talk now'), 'normal');
  eq(modeAsked('Mute yourself.'), 'mute');
});
t('words inside a sentence are not commands', () => {
  eq(modeAsked('I like to just listen to music on the train'), null);
  eq(modeAsked('He said you can talk to the manager about it tomorrow'), null);
  eq(modeAsked('Things went back to normal after the storm'), null);
  eq(modeAsked('what is the normal mode of transport there'), null);
});
t('normal: nothing changes, commands switch', () => {
  eq(modeTurn('what time is it', 'normal'), null);
  eq(modeTurn('just listen', 'normal'), { set: 'listen', rest: '' });
  eq(modeTurn('only answer to your name', 'normal'), { set: 'name', rest: '' });
});
t('listen only: quiet until released', () => {
  eq(modeTurn('what time is it', 'listen'), { quiet: 'listen_mode' });
  eq(modeTurn('Pan what time is it', 'listen'), { quiet: 'listen_mode' });
  eq(modeTurn('you can talk', 'listen'), { set: 'normal', rest: '' });
  eq(modeTurn('just listen', 'listen'), { quiet: 'listen_mode' });
  eq(modeTurn('Pan, only answer to your name', 'listen'), { set: 'name', rest: '' });
});
t('listen only: own release words, any language, rest answered', () => {
  const w = { release: ['μίλα', 'wake up buddy'] };
  eq(modeTurn('Μίλα', 'listen', w), { set: 'normal', rest: '' });
  eq(modeTurn('Wake up buddy, what is the weather like', 'listen', w), { set: 'normal', rest: 'what is the weather like' });
  eq(modeTurn('wake up', 'listen', w), { quiet: 'listen_mode' });
});
t('name only: only lines that start with the name', () => {
  eq(modeTurn('what time is it', 'name'), { quiet: 'name_mode' });
  eq(modeTurn('Pan, what time is it', 'name'), { named: true });
  eq(modeTurn('hey pan what time is it', 'name'), { named: true });
  eq(modeTurn('I told Pan about it', 'name'), { quiet: 'name_mode' });
  eq(modeTurn('Jarvis what time is it', 'name', { name: ['Jarvis'] }), { named: true });
  eq(modeTurn('back to normal', 'name'), { set: 'normal', rest: '' });
});
t('mute: nothing by voice', () => {
  eq(modeTurn('you can talk', 'mute'), { quiet: 'mute_mode' });
  eq(modeTurn('back to normal', 'mute'), { quiet: 'mute_mode' });
});
t("don't remember: talks as normal, nothing else changes, own words end it", () => {
  eq(modeAsked("Don't remember any of this."), 'forget');
  eq(modeAsked('Okay, this is off the record'), 'forget');
  eq(modeAsked('Go incognito'), 'forget');
  eq(modeAsked("I don't remember what he said yesterday"), null);
  eq(modeTurn("don't remember this", 'normal'), { set: 'forget', rest: '' });
  eq(modeTurn('what time is it', 'forget'), null);
  eq(modeTurn('remember again', 'forget'), { set: 'normal', rest: '' });
  eq(modeTurn('You can remember again. What did I ask?', 'forget'), { set: 'normal', rest: 'What did I ask' });
  eq(modeTurn('remember again', 'listen'), { quiet: 'listen_mode' });
  eq(modeTurn('θυμήσου', 'forget', { remember: ['Θυμήσου'] }), { set: 'normal', rest: '' });
  eq(modeTurn('just listen', 'forget'), { set: 'listen', rest: '' });
});
t('words helpers', () => {
  eq(startsWithAny('Pantelis is here', ['pan']), null);
  eq(startsWithAny('pan, hi', ['pan']), 'hi');
  eq(cleanWords({ name: ['a', '', 7], release: 'x' }), { name: ['a', '7'], release: [], remember: [] });
});
console.log(`\n${'='.repeat(40)}\nResults: ${passed} passed, ${failed} failed\n${'='.repeat(40)}\n`);
process.exit(failed ? 1 : 0);
