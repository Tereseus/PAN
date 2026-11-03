// Conversation benchmark isolation (evals/voicebench).
//
// The benchmark drives the real voice loop: the phone plays recorded speech into
// its own microphone path and the hub answers it like any other turn. Without
// this, every test line would become one of his memories, his thoughts and his
// intuition signals. A /query/stream request carrying bench:true runs inside
// benchContext, and the writers that would persist it check isBench() first.
import { AsyncLocalStorage } from 'node:async_hooks';

export const benchContext = new AsyncLocalStorage();

export function isBench() {
  return benchContext.getStore()?.bench === true;
}
