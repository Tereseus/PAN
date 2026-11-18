// A person's computer is that person's client (docs/PEOPLE-PLAN.md): whose a relay host is, which
// threads each person can reach, and that nothing one person hears or asks leaks to another
// (thread-relay.js). Runs standalone on a fresh database, no PAN server needed.
// Usage: node service/src/__tests__/thread-people.test.js

import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

process.env.PAN_DATA_DIR = mkdtempSync(join(tmpdir(), 'pan-thread-people-'));
process.env.PAN_DEV = '1';

const { run, get, all } = await import('../db.js');
const tr = await import('../thread-relay.js');

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}: ${err.message}`); }
}
function ok(cond, what) { if (!cond) throw new Error(what); }
const J = (v) => JSON.stringify(v);

run(`INSERT OR IGNORE INTO users (id, email, display_name, role) VALUES (1, 'owner@localhost', 'owner', 'owner')`);
const addUser = (name, role, power) => Number(run(
  `INSERT INTO users (email, display_name, role, power_lvl, is_active) VALUES (:e, :n, :r, :p, 1)`,
  { ':e': `${name}@local`, ':n': name, ':r': role, ':p': power }).lastInsertRowid);
const mia = { id: addUser('Mia Test', 'user', 25), role: 'user', power: 25, person: true };
const sam = { id: addUser('Sam Test', 'user', 25), role: 'user', power: 25, person: true };
const MIA_PC = 'd0000000000c1', SAM_PC = 'd0000000000c3', OWN_PC = 'd0000000000a4';
const asMia = { person: mia, linkDevice: MIA_PC };
const asSam = { person: sam, linkDevice: SAM_PC };
const now = Date.now();
const thread = (id, title, at = now) => ({ session_id: id, title, cwd: '/x', last_activity: at });
const titles = (list) => list.map(t => t.title).sort().join(' | ');

function report(host, who, threads) {
  if (!tr.holdHost(host, who)) return false;
  tr.reportThreads(host, threads);
  return true;
}

console.log('threads and people');

await test('a host belongs to the device that first reported under it', () => {
  ok(report('study-desk', {}, [thread('o1', 'Notes'), thread('o2', 'Garden Plans'), thread('o3', 'Desk PC Stuff')]), 'the owner\'s own computer was refused');
  ok(report('mia-laptop', asMia, [thread('m1', 'Notes'), thread('m2', 'Homework'), thread('m3', 'Laptop PC Stuff')]), 'her computer was refused');
  ok(report('sam-tower', asSam, [thread('s1', 'Recipes')]), 'his computer was refused');
  ok(!report('mia-laptop', asSam, [thread('x', 'Planted')]), 'another person reported under her computer\'s name');
  ok(!report('study-desk', asMia, [thread('x', 'Planted')]), 'a person reported under the owner\'s computer\'s name');
  ok(!report('mia-laptop', { linkDevice: OWN_PC }, [thread('x', 'Planted')]), 'one of the owner\'s computers took a person\'s name');
  ok(!report('mia-laptop', {}, [thread('x', 'Planted')]), 'the hub itself took a person\'s name');
  ok(!tr.holdHost('new-name', { person: mia, linkDevice: null }), 'a person with no link device was believed');
  ok(!all(`SELECT * FROM thread_relay_threads WHERE title = 'Planted'`).length, 'a refused report was stored');
});

await test('the owner sees every computer\'s threads and whose they are; a person sees only their own', () => {
  const mine = tr.listThreads();
  ok(mine.length === 7, `the owner sees ${mine.length}`);
  const hw = mine.find(t => t.title === 'Homework');
  ok(hw.theirs === 1 && hw.owner_name === 'Mia Test', J(hw));
  ok(mine.find(t => t.title === 'Garden Plans').theirs === 0, 'his own thread is marked as someone else\'s');
  ok(titles(tr.listThreads({ person: mia })) === 'Homework | Laptop PC Stuff | Notes', titles(tr.listThreads({ person: mia })));
  ok(titles(tr.listThreads({ person: sam })) === 'Recipes', titles(tr.listThreads({ person: sam })));
  ok(tr.listThreads({ person: { id: 0, role: 'guest', person: true } }).length === 0, 'a removed person sees threads');
  ok(tr.listThreads({ person: mia }).every(t => t.host === 'mia-laptop'), 'she sees another host');
});

await test('the owner: his own thread first, a person\'s when he says whose or has none by that name', () => {
  const m = (name) => tr.matchThread(name);
  ok(m('notes').ok && m('notes').thread.host === 'study-desk', J(m('notes')));
  ok(m('homework').ok && m('homework').thread.host === 'mia-laptop', 'a thread only her computer has was not found');
  for (const said of ["mia's notes", 'mia notes', 'mias notes', 'Mia’s notes']) {
    const r = m(said);
    ok(r.ok && r.thread.host === 'mia-laptop', `${said}: ${J(r.thread || r.reason)}`);
  }
  ok(m("sam's recipes").thread?.session_id === 's1', 'Sam\'s was not found');
  ok(!m("sam's homework").ok, 'a person\'s name did not limit the search to that person\'s computer');
});

await test('the owner asks by voice: status, a send, a list of a person\'s threads, a job for their computer', () => {
  const p = (text) => tr.parseThreadCommand(text, { peek: true });
  let c = p("What is Mia's homework thread doing?");
  ok(c?.kind === 'send' && c.status && c.thread.session_id === 'm2', J(c));
  c = p('Tell the garden plans thread to add tomatoes.');
  ok(c?.kind === 'send' && c.thread.session_id === 'o2', J(c));
  c = p("List Mia's threads.");
  ok(c?.kind === 'list' && titles(c.threads) === 'Homework | Laptop PC Stuff | Notes' && c.whose === 'Mia Test', J(c));
  c = p('List my threads.');
  ok(c?.kind === 'list' && c.threads.every(t => !t.theirs) && c.threads.length === 3, J(c?.threads?.map(t => t.title)));
  c = p("Tell Mia's computer to close the browser.");
  ok(c?.kind === 'send' && c.thread.session_id === 'm3', J(c));
});

await test('a person: their own threads only, and the owner\'s do not exist for them', () => {
  const p = (text, person) => tr.parseThreadCommand(text, { person, peek: true });
  let c = p('What is the homework thread doing?', mia);
  ok(c?.kind === 'send' && c.thread.session_id === 'm2', J(c));
  c = p('Tell the notes thread to add milk.', mia);
  ok(c?.kind === 'send' && c.thread.session_id === 'm1' && c.thread.host === 'mia-laptop', `her line reached ${J(c?.thread)}`);
  c = p('Tell the garden plans thread hello.', mia);
  ok(c?.kind === 'unknown', `the owner's thread: ${J(c)}`);
  c = p('Tell the recipes thread hello.', mia);
  ok(c?.kind === 'unknown', `another person's thread: ${J(c)}`);
  c = p('List my threads.', mia);
  ok(c?.kind === 'list' && titles(c.threads) === 'Homework | Laptop PC Stuff | Notes', J(c));
  c = p('Tell the homework thread hello.', sam);
  ok(c?.kind === 'unknown', `Sam reached Mia's thread: ${J(c)}`);
  // The same words for a thread that exists for nobody and for one that is the owner's: one answer.
  ok(J(p('Tell the garden plans thread hello.', mia)?.kind) === J(p('Tell the zebra crossing thread hello.', mia)?.kind), 'an answer that tells her which threads the owner has');
});

await test('what one person was told is not what another person\'s "number two" counts in', async () => {
  const drain = async (gen) => { let last; for await (const ev of gen) last = ev; return last?.result; };
  const list = tr.parseThreadCommand('List my threads.');
  const said = await drain(tr.handleThreadCommand(list, 'List my threads.', {}));
  ok(/^Your newest threads/.test(said.response), said.response);
  // She has heard no list: her "number two" is a place in her own threads, never in his.
  const hers = tr.parseThreadCommand("What's thread number two doing?", { person: mia });
  ok(!hers?.thread || hers.thread.host === 'mia-laptop', `her number two is ${J(hers?.thread)}`);
  // A look at what her line means to the owner leaves his pending choice alone.
  const before = tr.parseThreadCommand('two', { peek: true });
  tr.parseThreadCommand('What is the homework thread doing?', { peek: true });
  ok(J(tr.parseThreadCommand('two', { peek: true })?.thread?.session_id) === J(before?.thread?.session_id), 'a look changed what he was offered');
  const mias = await drain(tr.handleThreadCommand(tr.parseThreadCommand("List Mia's threads."), "List Mia's threads.", {}));
  ok(/^Mia's newest threads/.test(mias.response), mias.response);
});

await test('a job carries who asked; a follow up never lands in someone else\'s thread', async () => {
  const garden = tr.listThreads().find(t => t.session_id === 'o2');
  const jobO = tr.enqueueJob({ thread: garden, text: 'add tomatoes', device_id: 'owner-phone' });
  ok(jobO.asked_by === null, J(jobO));
  ok(tr.parseThreadCommand('Tell it thanks.', { peek: true })?.thread?.session_id === 'o2', 'his own follow up was lost');
  const fu = tr.parseThreadCommand('Tell it thanks.', { person: mia, peek: true });
  ok(!fu || fu.thread?.host === 'mia-laptop', `her "tell it" went to ${J(fu?.thread)}`);
  const hw = tr.listThreads({ person: mia }).find(t => t.session_id === 'm2');
  const jobM = tr.enqueueJob({ thread: hw, text: 'what is due', device_id: `person${mia.id}-${MIA_PC}`, asked_by: mia.id });
  ok(get(`SELECT asked_by FROM thread_relay_jobs WHERE id = :i`, { ':i': jobM.id }).asked_by === mia.id, 'asked_by not stored');
  ok(tr.parseThreadCommand('Tell it thanks.', { person: mia, peek: true })?.thread?.session_id === 'm2', 'her follow up was lost');
  ok(tr.parseThreadCommand('Tell it thanks.', { peek: true })?.thread?.session_id === 'o2', 'his follow up moved to her thread');
});

await test('a job is taken only by the computer that holds its host', async () => {
  const jobs = all(`SELECT * FROM thread_relay_jobs ORDER BY created_at`);
  const [jobO, jobM] = [jobs.find(j => j.host === 'study-desk'), jobs.find(j => j.host === 'mia-laptop')];
  ok(tr.holdsJob(jobM, asMia) && !tr.holdsJob(jobM, asSam), 'her job and Sam');
  ok(!tr.holdsJob(jobO, asMia), 'she holds the owner\'s job');
  ok(tr.holdsJob(jobO, {}) && tr.holdsJob(jobM, {}), 'the owner is held back');
  ok(!tr.holdsJob(null, asMia), 'no job');
  ok(!tr.holdHost('study-desk', asMia), 'she could ask for the owner\'s computer\'s jobs');
  const got = await tr.claimNext('mia-laptop', 1000);
  ok(got?.id === jobM.id && /Your user is talking to you/.test(got.message), J(got?.message));
  // The owner asks her thread something: it is told who is asking.
  tr.enqueueJob({ thread: tr.listThreads().find(t => t.session_id === 'm2'), text: 'how far along is it' });
  const fromOwner = await tr.claimNext('mia-laptop', 1000);
  ok(/The owner of this/.test(fromOwner.message) && /not the person who uses this computer/.test(fromOwner.message), fromOwner.message);
});

await test('handing a computer over, taking it back, removing it', () => {
  // The owner takes her laptop back: the same device now reports as his.
  ok(tr.holdHost('mia-laptop', { linkDevice: MIA_PC }), 'the owner could not take the device back');
  ok(tr.listThreads().find(t => t.session_id === 'm2').theirs === 0, 'still marked as hers');
  ok(tr.listThreads({ person: mia }).length === 0, 'she still sees its threads');
  // And hands it to Sam.
  ok(tr.holdHost('mia-laptop', { person: sam, linkDevice: MIA_PC }), 'the new person could not use it');
  ok(titles(tr.listThreads({ person: sam })).includes('Homework'), 'Sam does not see it');
  // A person who is removed: their computer's threads are offered to nobody.
  run(`UPDATE users SET is_active = 0 WHERE id = :i`, { ':i': sam.id });
  ok(!tr.listThreads().some(t => t.host === 'sam-tower' || t.host === 'mia-laptop'), 'a removed person\'s threads are still offered');
  run(`UPDATE users SET is_active = 1 WHERE id = :i`, { ':i': sam.id });
  // The device is removed from PAN Link: its hosts go with it. The owner's own are never touched.
  ok(tr.forgetHostsOf(SAM_PC) === 1, 'his tower was not forgotten');
  ok(!tr.listThreads().some(t => t.host === 'sam-tower'), 'its threads are still listed');
  ok(tr.forgetHostsOf(OWN_PC) === 0 && tr.listThreads().some(t => t.host === 'study-desk'), 'the owner\'s computer was forgotten');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
