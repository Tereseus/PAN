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
