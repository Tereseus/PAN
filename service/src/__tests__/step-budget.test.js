// Every step of a real turn against its time budget (step-budget.js, the owner Nov 28).
// Usage: node service/src/__tests__/step-budget.test.js
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import assert from 'assert/strict';

process.env.PAN_DATA_DIR = mkdtempSync(join(tmpdir(), 'pan-stepbudget-'));
process.env.PAN_DEV = '1';
const { checkSteps, busyCheck, reportLines, BUDGET_MS } = await import('../step-budget.js');

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok', name); };

const turn = (at, device, projects, first, done) => ({ at, device, stage: 'steps', steps: [
  ['turn_opened', 0, 0], ['voice_id', 40, 40], ['hub_hears_again', 340, 300], ['projects_check', 340 + projects, projects],
  ['voice_model_first_words', first - 5, first - 345 - projects], ['first_words_sent', first, 5], ['reply_done', done, done - first],
] });

t('a quiet turn inside every budget is not over', () => {
  const r = checkSteps([turn(1000, 'car', 3, 700, 2500)]);
  assert.equal(r.quiet, 1);
  assert.deepEqual(r.over, []);
  assert.equal(r.devices.car.first.p50, 700);
});

t('a slow projects check is over its budget, by how much', () => {
  const r = checkSteps([turn(1000, 'car', 3, 700, 2500), turn(2000, 'car', 1492, 2300, 4000)]);
  const o = r.over.find((x) => x.step === 'projects_check');
  assert.equal(o.over, 1);
  assert.equal(o.of, 2);
  assert.equal(o.worst_over, 1492 - BUDGET_MS.projects_check);
  assert.ok(r.over.some((x) => x.step === 'first_words_from_start'));
});

t('a turn while a bench ran is left out of the budget and counted as busy', () => {
  const busy = busyCheck([2000 - 60_000]);
  const r = checkSteps([turn(1_000_000, 'pixel', 3, 700, 2500), turn(2000, 'pixel', 1492, 2300, 20000)], busy);
  assert.equal(r.quiet, 1);
  assert.equal(r.devices.pixel.busy, 1);
  assert.equal(r.devices.pixel.whole.p50, 2500);
  assert.equal(r.devices.pixel.whole_all.max, 20000);
  assert.deepEqual(r.over, []);
});

t('any voice model give-up is over', () => {
  const r = checkSteps([{ at: 5, device: 'pixel', steps: [['turn_opened', 0, 0], ['voice_model_gave_up', 6528, 6528], ['first_words_sent', 16785, 10000]] }]);
  assert.ok(r.over.some((x) => x.step === 'voice_model_gave_up'));
});

t('report lines say nothing personal: devices, steps and times only', () => {
  const r = checkSteps([turn(1000, 'car', 1492, 2300, 4000)]);
  const lines = reportLines('2026-11-28', r);
  assert.ok(lines.find((l) => /^Speed on 2026-11-28: car$/.test(l.what)));
  assert.ok(lines.find((l) => l.what === 'Over its time budget: projects_check'));
  for (const l of lines) assert.ok(!/said|reply text/i.test(l.detail));
});

console.log(`${n} passed`);
