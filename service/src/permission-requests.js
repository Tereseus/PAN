// Claude Code permission prompts waiting for an answer from the phone or dashboard. Each one is an
// open PermissionRequest hook call, so it lives as long as that call. Claude Code's own prompt is up
// beside it the whole time, and whichever is answered first wins.

// Someone at the screen answers there first: half of them take 16 s or less. Keeper runs get refused
// by the app in seconds, and an Allow can do nothing for those.
const SHOW_AFTER_MS = 30_000;

const open = new Map();   // id → { ...request, settle }
let lastId = 0;

export function openRequests() {
  const shownBefore = Date.now() - SHOW_AFTER_MS;
  return [...open.values()].filter(r => r.id <= shownBefore).map(({ settle, ...request }) => request);
}

// answer resolves 'allow', 'deny', or null when nobody answered in time.
export function askForAnswer(request, waitMs) {
  lastId = Math.max(Date.now(), lastId + 1);
  const id = lastId;
  const answer = new Promise((resolve) => {
    const timer = setTimeout(() => settle(null), waitMs);
    const settle = (response) => { clearTimeout(timer); open.delete(id); resolve(response); };
    open.set(id, { ...request, id, settle });
  });
  return { id, answer };
}

export function answerRequest(id, response) {
  const request = open.get(id);
  request?.settle(response);
  return !!request;
}

export function dropRequest(id) {
  answerRequest(id, null);
}

// The thread has moved on, so its prompt was answered at the screen.
export function dropSessionRequests(sessionId) {
  for (const r of [...open.values()]) if (r.session_id === sessionId) r.settle(null);
}
