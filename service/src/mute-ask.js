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

const NAME = /(?:pan|pam|pann)/.source;
const COMMAND = new RegExp(
  /^(?:(?:uh+|um+|hey|ok|okay|oh|so|alright|now|just),?\s+)*/.source
  + `(?:${NAME},?\\s+)?`
  + /(?:(?:can|could|would|will) you\s+)?(?:please\s+)?(?:just\s+)?(?:(?:mute,?\s+)*mute(?:\s+your\s?self)?|be quiet|shut up|stop listening|go quiet)(?:\s+for (?:a (?:bit|minute|moment|second|while)|now))?(?:\s+(?:please|now))?/.source
  + `(?:,?\\s+${NAME})?$`, 'i');

export function asksToMute(text) {
  const sentences = String(text || '').replace(/’/g, "'").split(/[.!?]+/).map((s) => s.trim()).filter(Boolean);
  if (!sentences.length || sentences.length > 4) return false;
  if (String(text).trim().split(/\s+/).length > 16) return false;
  return COMMAND.test(sentences[sentences.length - 1]);
}
