#!/usr/bin/env node
/**
 * PAN Bug Logging Rule — UserPromptSubmit hook
 *
 * Wired from .claude/settings.json. When the user submits a prompt indicating
 * something is broken / regressed / came back, this hook prints additionalContext
 * reminding Claude to apply the Bug Logging Rule from MEMORY.md BEFORE doing
 * anything else this turn.
 *
 * Harness-enforced (settings.json) — Claude cannot bypass via misreading
 * instructions. Matches the architectural fix proposed in bug #974.
 *
 * Input  : JSON via stdin per Claude Code hook contract
 *          { session_id, cwd, hook_event_name: "UserPromptSubmit", prompt: "..." }
 * Output : Plain text to stdout = additionalContext injected for this turn
 *          (silent / empty if no trigger match)
 * Exit   : 0 always (never block the user's turn)
 */

const TRIGGER = new RegExp(
  [
    "doesn'?t work",
    "isn'?t working",
    "not working",
    "broken",
    "broke",
    "is back",
    "happening again",
    "still broken",
    "this is wrong",
    "you didn'?t",
    "you fucked up",
    "regression",
    "came back",
    "keeps doing",
    "keeps happening",
    "fucked up again",
    "why did you",
    "why didn'?t you",
    "that didn'?t",
  ].join("|"),
  "i"
);

let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (stdin += c));
process.stdin.on("end", () => {
  let payload;
  try {
    payload = JSON.parse(stdin || "{}");
  } catch {
    process.exit(0); // never block, even on malformed input
  }

  const prompt = String(payload.prompt || "");
  const cwd = String(payload.cwd || "");

  // Scope: PAN project only. Accept both Desktop\PAN and OneDrive\Desktop\PAN.
  if (!/[\\/]PAN([\\/]|$)/i.test(cwd)) {
    process.exit(0);
  }

  if (!TRIGGER.test(prompt)) {
    process.exit(0);
  }

  // Match found — inject reminder. stdout from a UserPromptSubmit hook becomes
  // additionalContext for the current turn.
  process.stdout.write(
    [
      "",
      "## ⚠️ PAN Bug Logging Rule triggered (harness-enforced via .claude/settings.json)",
      "",
      "The user just reported a broken / regressed / recurring behavior. **Before doing anything else this turn**, apply the Bug Logging Rule from `MEMORY.md > Bug Logging Rule (MANDATORY)`:",
      "",
      "1. **Search existing bugs first.** `GET http://127.0.0.1:7777/dashboard/api/projects/791/tasks` (include done). Match on symptom, file path, error text, behavioral pattern — not just title keyword.",
      "2. **Match found, open → UPDATE.** `PUT /dashboard/api/tasks/:id` appending today's date, this session id, exact repro, why it happened, how it happened, what you tried.",
      "3. **Match found, status=done → REOPEN.** PUT status back to `todo` or `in_progress`. Add `RECURRENCE #N (date)` at the TOP of the description. Do NOT mark it done again until a regression test exists and passes.",
      "4. **3+ occurrences → nightmare bug.** Add to `docs/NIGHTMARE_BUGS.md` (Symptom / Root cause / Why it keeps coming back / Real fix needed). Bump to P1. Never close without root cause + regression test + 24h clean in prod.",
      "5. **No match → file a new bug.** `POST /dashboard/api/projects/791/tasks` with full diagnosis and cross-references to siblings.",
      "6. **Your own rule-breaks count.** If you violated a CLAUDE.md / MEMORY.md rule, file it as a 'behavioral rule has no enforcement' class bug. This is how upstream architectural causes surface.",
      "",
      "**Why this rule exists:** closing bugs that come back hides the recurrence pattern. Filing duplicates fragments the evidence. Updating the same bug with each occurrence is the only way to see 'this has happened 5 times — the root cause must be upstream of what we keep patching.'",
      "",
      "Do this BEFORE explaining or fixing the underlying problem.",
      "",
    ].join("\n")
  );

  process.exit(0);
});
