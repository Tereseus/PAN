// A line of an app's own log, without the words it carries.
//
// The phone app ships its log to the hub (POST /api/v1/logs), and some lines hold what the
// microphone heard or what was said back: "Heard: ...", "Hub heard: ...". For the owner's own
// devices that is his own log. For a device that belongs to another person on this hub it put
// everything that person's phone heard, the lines not said to PAN included, in a table the owner
// reads (found 2026-11-19: a test person's phone was read that way). A person's lines are kept
// with their shape and without their words: "Heard: (4 words)".
//
// A new log line in the app that carries words needs its form added here, with a line in
// __tests__/log-words.test.js.

const count = (s) => {
  const n = String(s || '').trim().split(/\s+/).filter(Boolean).length;
  return `(${n} word${n === 1 ? '' : 's'})`;
};

// Each rule: what is kept (group 1), the words (group 2), and what follows them (group 3, if any).
const RULES = [
  /^(Heard:)\s*([\s\S]*)$/,
  /^(Hub heard:)\s*([\s\S]*)$/,
  /^(Dedup skipped:)\s*([\s\S]*)$/,
  /^(Suppressed while muted:)\s*([\s\S]*)$/,
  /^(Cooldown \(ignoring post-TTS echo\):)\s*([\s\S]*)$/,
  /^(TTS stopped by user:)\s*([\s\S]*)$/,
  /^(PAN muted, the hub heard the command:)\s*([\s\S]*)$/,
  /^(Camera from hub \(\d+ms\):)\s*([\s\S]*)$/,
  /^(Held \d+ms \([^)]*\):)\s*([\s\S]*)$/,
  /^(Stream \([^)]*\)(?: up=\S+)?:)\s*([\s\S]*)$/,
  /^(Ambient \(\d+ms\):)\s*(?!no-op$)(\S[\s\S]*)$/,
  /^(\[STT\] holding, [^:]*:)\s*([\s\S]*)$/,
  /^(\[STT\] echo discarded:)\s*([\s\S]*)$/,
  /^(\[STT\] [a-z -]*partial:)\s*([\s\S]*)$/i,
  /^(Query cancelled for) '([\s\S]*)'()$/,
  /^(FATAL onSpeech error for) '([\s\S]*)'(: [^']*)$/,
  /^(Alert notify #\d+ type=\S+) '([\s\S]*)'( -> notification \d+)$/,
  /^(Slack reply sent to \S+:)\s*([\s\S]*)$/,
  /^(Reply:|PAN said:|Said:|Speaking:)\s*([\s\S]*)$/,
];

/** The line as it may be kept for a device that is not the owner's. */
export function withoutWords(message) {
  const line = String(message ?? '');
  for (const rule of RULES) {
    const m = rule.exec(line);
    if (!m) continue;
    if (!String(m[2] || '').trim()) return line;
    return `${m[1]} ${count(m[2])}${m[3] || ''}`;
  }
  return line;
}
