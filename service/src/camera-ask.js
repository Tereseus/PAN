// camera-ask.js — whether a heard line asks PAN to look through the phone's camera.
//
// The same words as the phone's own check (android/.../camera/CameraAsk.kt): keep the two in
// step. The phone checks its own transcript first and takes the photo itself; its recogniser
// drops letters, though ("what am i lookin at", 2026-11-08), and then the hub answered from
// the computer's screen ("You're looking at your browser"), twice, and said it had no camera
// when asked to look through it. The hub's transcript is better, so it checks again and asks
// the phone for a photo (camera: true in the reply, router.js routeStream).

const PHRASES = [
  'what am i looking at', 'what am i seeing',
  "what i'm looking at", 'what i am looking at', 'what im looking at',
  'take a photo', 'take a picture', 'take photo', 'take picture',
  'what do you see', 'what can you see',
  "what's in front of me", 'what is in front of me',
  'describe what you see',
  "what's around me", 'what is around me',
  'snap a photo', 'snap a picture',
];

// Asked to look with it: "look through the camera of my phone", "use my phone's camera".
// Not "what I was pointing at with the camera" (no asking word), nor "look at the garage
// camera" (another camera).
const WITH_CAMERA = /\b(look|use)\b[^.?!]{0,30}\b(my|the|your)\s+(phone'?s\s+)?camera\b/;

// "What is that" means look only when nothing else follows it: "what is that movie called,
// the one with the..." is him reaching for a name.
const DEICTIC = /\b(what is|what's|look at|identify|describe|capture) (this|that)\b(.*)$/;
const TAIL = /^\s*((thing|things|one|here|there|right|over|called|pan|please|for me|real quick|now)\b[\s,.?!]*)*$/;

const DROPPED_G = /\b(look|see)in'?(?![a-z])/g;

/** Lower case, curly apostrophes made plain, "lookin" and "seein'" as "looking" and "seeing". */
export function normalizeHeard(text) {
  return String(text || '').toLowerCase().trim().replace(/’/g, "'").replace(DROPPED_G, '$1ing');
}

export function asksForCamera(text) {
  const t = normalizeHeard(text);
  if (PHRASES.some((p) => t.includes(p))) return true;
  if (WITH_CAMERA.test(t)) return true;
  const m = t.match(DEICTIC);
  return !!m && TAIL.test(m[3]);
}

// ── Saying what the photo shows ──
// "What am I looking at?" took 6-8 s on the hub with both models loaded, 19 s on 2026-11-08:
// moondream writes ~110 words (the first sentence is the answer, the rest was "paste, paste
// mode, paste all, select all, select all"), then gemma4:e2b turns them into a reply. A plain
// look needs neither the long description nor the second model (routes/api.js lookAndAnswer).

// Words that only ask for a look. A question left with nothing else ("what am I looking at",
// "look through the camera of my phone and tell me what I'm looking at") is a plain look; "what
// kind of dog is that" and "how many fingers am I holding up" are not.
const LOOK_WORDS = new RegExp('\\b(?:' + [
  'hey', 'he', 'hi', 'okay', 'ok', 'so', 'then', 'alright', 'all right', 'right', 'now', 'please', 'pan', 'um+', 'uh+', 'well', 'and', 'just', 'quick', 'real',
  'look', 'looking', 'see', 'seeing', 'through', 'with', 'using', 'use', 'the', 'my', 'your', "phone's", 'phone', 'phones', 'camera', 'of', 'at',
  'tell', 'me', 'what', "what's", "i'm", 'im', 'i', 'am', 'is', 'this', 'that', 'it', 'in', 'front', 'around', 'describe', 'take', 'a', 'photo',
  'picture', 'do', 'you', 'can', 'show', 'here', 'there', 'thing', 'again', 'now', 'for', 'could', 'would',
].sort((a, b) => b.length - a.length).join('|') + ')\\b', 'g');

/** True when the question only asks for a look, so the description itself is the answer. */
export function plainLook(question) {
  const t = normalizeHeard(question);
  if (!t) return true;
  return !t.replace(LOOK_WORDS, ' ').replace(/[^a-z]+/g, '');
}

const OPENING = /^(?:in )?(?:the|this) (?:image|photo|picture|photograph|scene)(?: (?:shows|features|depicts|displays|captures|contains|is of|presents))?[\s,:]+(?:there (?:is|are) )?/i;
const WRITTEN = /\b(?:word|words|text|reads|says|written|labell?ed|logo|sign|title)\b|"[^"]+"/i;

/** A description as one spoken answer: its first sentence, plus the sentence that says what is
 *  written in the photo when there is one (writing is often the thing's name). */
export function spokenLook(description) {
  const flat = String(description || '').replace(/[*_`#]+/g, '').replace(/\s+/g, ' ').trim();
  const sentences = flat.match(/[^.!?]+(?:[.!?]+|$)/g)?.map((s) => s.trim()).filter(Boolean) || [];
  if (!sentences.length) return '';
  let first = sentences[0];
  if (OPENING.test(first)) first = `You're looking at ${first.replace(OPENING, '')}`;
  const writing = sentences.slice(1).find((s) => WRITTEN.test(s));
  return writing ? `${first} ${writing}` : first;
}
