// Which voice turn from a device is the live one (routes/api.js /query/stream). Kept here, apart from
// the route, so a test holds the rules (__tests__/turn-slots.test.js).
//
// - A newer turn from the same device cancels the older one still in flight (#460: a stalled turn
//   used to run to completion next to every re-send).
// - Turns are ordered by when the phone SENT them: an older one landing late is dropped, not
//   allowed to cancel the newer one (car on a 4G hotspot, 2026-11-17).
// - Tentative (app 0.5.54+, audio/TurnRules.kt): a clip the phone's ear wrote no words for, sent
//   while a question with words was still waiting. In the car that clip was road noise and
//   cancelling for it threw the question away: on Nov 24 a question the hub had heard got no
//   answer, and on Nov 25 a spoken request was cancelled by a 2 s clip of nothing.
//   A tentative turn cancels nothing and is not the newest turn. It runs under its own key and only
//   takes over (cancels the waiting turn) when promoted, i.e. it streamed a real reply.

const LATE_WINDOW_MS = 120_000; // a phone whose clock was set back is not shut out

export function turnSlots(streams, newest, { ttlMs = 60_000, log = () => {} } = {}) {
  const register = (key, controller) => streams.set(key, { controller, expiresAt: Date.now() + ttlMs });
  const abortAt = (key, why) => {
    const entry = streams.get(key);
    if (!entry) return false;
    try { entry.controller.abort(); } catch {}
    streams.delete(key);
    log(`${why} for ${key}`);
    return true;
  };

  /**
   * A turn arrives. Returns { late } when it was sent before the device's newest turn (drop it);
   * otherwise a slot: slot.key is where its controller sits, slot.promote() makes a tentative turn
   * the device's live turn, slot.release() clears it if it still owns its key.
   */
  function open({ streamKey, sentAt = 0, tentative = false, controller }) {
    const newestSent = newest.get(streamKey) || 0;
    if (sentAt && sentAt < newestSent && newestSent - sentAt < LATE_WINDOW_MS) return { late: true, gapMs: newestSent - sentAt };
    const tentativeKey = `${streamKey}:tentative`;
    let key = tentative ? tentativeKey : streamKey;
    let promoted = !tentative;
    if (!tentative) {
      if (sentAt) newest.set(streamKey, sentAt);
      abortAt(streamKey, 'superseded in-flight turn');
    }
    // An older tentative clip is overtaken by any newer turn from the device.
    abortAt(tentativeKey, 'superseded tentative turn');
    register(key, controller);
    return {
      late: false,
      get key() { return key; },
      get promoted() { return promoted; },
      promote() {
        if (promoted) return false;
        promoted = true;
        abortAt(streamKey, 'tentative turn was real words, superseded the waiting turn');
        if (streams.get(tentativeKey)?.controller === controller) streams.delete(tentativeKey);
        key = streamKey;
        register(streamKey, controller);
        if (sentAt) newest.set(streamKey, Math.max(sentAt, newest.get(streamKey) || 0));
        return true;
      },
      release() {
        if (streams.get(key)?.controller === controller) streams.delete(key);
      },
    };
  }

  /** Does this done result show a real reply to a tentative turn (it was words for ΠAN)? */
  function realReply(result) {
    const r = result || {};
    const said = String(r.response || '').trim();
    return !['ambient', 'cancelled'].includes(r.intent) && !r.mute && !r.hold_ms && (!!r.camera || (!!said && said !== '[AMBIENT]'));
  }

  return { open, realReply };
}
