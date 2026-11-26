// mute-ask.js — whether a heard line tells PAN to mute itself.
//
// The device checks its own transcript for this first (MUTE_CMD in the app), on the whole line. In
// a car its recogniser hears the words wrong, nothing matched, and the line went to the voice
// model, which answered "Got it. Mute." and "Already done." and muted nothing (2026-11-17 and 18,
// five asks). The hub's transcript had every one of them right, so the hub checks too and tells
// the device to mute (mute: true in the reply, router.js routeStream).
//
// Same rule as the device: the command is the whole sentence, never a word inside one, so "my
// commute was long" and "he told me to shut up" do nothing. It may be the last sentence of a
// short line ("Wait, hold on. Mute yourself.").

// "Han": the hub's transcript of "Pan" in the car (Nov 26, "Han, mute yourself" three times, not muted).
const NAME = /(?:pan|pam|pann|han)/.source;
const COMMAND = new RegExp(
  /^(?:(?:uh+|um+|hey|ok|okay|oh|so|alright|now|just),?\s+)*/.source
  + `(?:${NAME},?\\s+)?`
  + /(?:(?:can|could|would|will) you\s+)?(?:please\s+)?(?:just\s+)?(?:(?:mute,?\s+)*mute(?:\s+your\s?self)?|be quiet|shut up|stop listening|go quiet)(?:\s+for (?:a (?:bit|minute|moment|second|while)|now))?(?:\s+(?:please|now))?/.source
  + `(?:,?\\s+${NAME})?$`, 'i');

// "I told you to mute yourself": the same ask, said again because the first one was missed.
const AGAIN = new RegExp(
  /^(?:(?:and|but|so|okay|ok|hey|look),?\s+)*/.source
  + `(?:${NAME},?\\s+)?`
  + /i (?:already\s+)?(?:told|asked) you to (?:mute(?:\s+your\s?self)?|be quiet|shut up|stop listening|go quiet)(?:\s+(?:already|now))?/.source
  + `(?:,?\\s+${NAME})?$`, 'i');
const NAMED_FIRST = new RegExp(`^(?:(?:hey|ok|okay)\\s+)?${NAME}\\b`, 'i');

export function asksToMute(text) {
  const sentences = String(text || '').replace(/’/g, "'").split(/[.!?]+/).map((s) => s.trim()).filter(Boolean);
  if (!sentences.length) return false;
  // Named and said first, as its own sentence: "Pan, mute yourself." followed by more talk was
  // answered three times and never muted (Nov 21), because only the last sentence was checked.
  // Any sentence, not only the first: in the car (Nov 26) he read a long text aloud with
  // "That's it. Pan, mute yourself." in front, and the first sentence was not the command. A
  // sentence that is only the name and the command is never part of other talk.
  if (sentences.some((one) => NAMED_FIRST.test(one) && (COMMAND.test(one) || AGAIN.test(one)))) return true;
  if (sentences.length > 4) return false;
  if (String(text).trim().split(/\s+/).length > 16) return false;
  const last = sentences[sentences.length - 1];
  return COMMAND.test(last) || AGAIN.test(last);
}
