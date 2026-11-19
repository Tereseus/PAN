// call-share.js — in a call, ΠAN's answer to one person is also read out to the other, when
// it is not personal.
//
// The owner, 2026-11-18: while two people talk through ΠAN, either can ask ΠAN something
// ("ΠAN, how far is the moon?") and ΠAN chimes in for both. But not everything: it depends
// whether it is a personal thing or just a question about something, and ΠAN has to work
// that out.
//
// The rules:
//   - Only when both are on the call. A call the other has not answered shares nothing.
//   - Only a plain answer to a question (the router's `query`). Anything ΠAN did or looked up
//     for the asker (their memory, threads, computers, house, calendar, a message) is theirs.
//   - The model reads the question and the answer and says whether anything in them is the
//     asker's own. Unsure, no answer or an error: not shared. There are no trigger words.
//   - The other person gets it as words, like every line in a call: who asked what, and what
//     ΠAN said. It never reaches the part of their ΠAN that acts on what it hears.
//   - The asker's own answer is not held up: this runs after it has been sent.

import { talkState, sendMessage, peopleHere } from './person-messages.js';
import { roomOf, sayInRoom } from './group-calls.js';
import { voiceLive } from './call-voice.js';

const OWNER_ID = 1;

const PROMPT = (question, answer) => `Two people are talking on a call. One of them asked their own assistant a question and it answered. Decide whether the answer may also be read out to the other person.

SHARE: a question anyone could ask, answered from general knowledge: facts about the world, a sum, a word's meaning, how something works, sport, history, what time or date it is.
PRIVATE: the question or the answer holds anything of the asker's own: their plans, calendar, messages, notes, what they said or did before, people they know, their health, money, work, home, devices, or where they are or were. An answer that says it cannot help, or asks the asker something back, is also PRIVATE.
If you are not sure, PRIVATE.

Question: ${JSON.stringify(String(question).slice(0, 400))}
Answer: ${JSON.stringify(String(answer).slice(0, 600))}

One word, SHARE or PRIVATE:`;

/** The model's reading: true only on a clear SHARE. */
export async function modelSaysShare(question, answer) {
  try {
    const { claude } = await import('./claude.js');
    const out = String(await claude(PROMPT(question, answer), { caller: 'call-share', maxTokens: 6, timeout: 8000 }) || '');
    return /\bshare\b/i.test(out) && !/\bprivate\b/i.test(out);
  } catch (e) {
    console.warn('[call-share] not judged:', e.message);
    return false;
  }
}

/**
 * After ΠAN answered [person] (null: the owner). judge: (question, answer) -> Promise<boolean>.
 * -> { shared, reason?, to? }
 */
export async function shareAnswerInCall({ person = null, question, answer, intent }, { judge = modelSaysShare } = {}) {
  const me = person ? Number(person.id) : OWNER_ID;
  const state = talkState(me);
  const room = roomOf(me);
  const inRoom = !!room && room.on.size > 1;
  if (!inRoom && (!state.with || !state.joined)) return { shared: false, reason: 'no_call' };
  const said = String(answer || '').trim();
  if (intent !== 'query' || !said || said.startsWith('[')) return { shared: false, reason: 'not_an_answer' };
  if (!(await judge(question, said))) return { shared: false, reason: 'personal' };
  if (inRoom) {
    // A call with a whole group (group-calls.js): everyone who is on hears it.
    const now_ = roomOf(me);
    if (!now_ || now_.key !== room.key || now_.on.size < 2) return { shared: false, reason: 'no_call' };
    const q = String(question || '').trim().replace(/\s+/g, ' ').slice(0, 160);
    // Those the asker's voice is reaching heard the question itself: all of them, then only the answer.
    const heardIt = [...now_.on.keys()].filter((id) => id !== me).every((id) => voiceLive(me, id));
    const put = sayInRoom(person, heardIt ? `PAN: ${said.replace(/\s+/g, ' ').slice(0, 300)}` : `Asked PAN: ${q} PAN said: ${said.replace(/\s+/g, ' ').slice(0, 300)}`);
    if (!put.ok) return { shared: false, reason: put.reason };
    console.log(`[call-share] person ${me}'s answer from PAN was also read out in ${room.key}`);
    return { shared: true, room: room.key, name: room.name };
  }
  // The call may have ended while the model was reading.
  const now = talkState(me);
  if (now.with !== state.with || !now.joined) return { shared: false, reason: 'no_call' };
  const asked = String(question || '').trim().replace(/\s+/g, ' ').slice(0, 160);
  // The other heard the question in the asker's own voice (call-voice.js): then only the answer.
  // how 'pan': it is ΠAN's answer, read out by the other's own ΠAN whether or not voices flow.
  const sent = sendMessage({ from: person, to: { id: state.with }, kind: 'says', how: 'pan',
    body: voiceLive(me, state.with) ? `PAN: ${said.replace(/\s+/g, ' ').slice(0, 300)}` : `Asked PAN: ${asked} PAN said: ${said.replace(/\s+/g, ' ').slice(0, 300)}` });
  if (!sent.ok) return { shared: false, reason: sent.reason };
  const other = peopleHere().find((p) => p.id === state.with);
  console.log(`[call-share] person ${me}'s answer from PAN was also read out to person ${state.with}`);
  return { shared: true, to: state.with, name: other?.first || null };
}
