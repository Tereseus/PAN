// client-claim.js — which computer may use a PAN client name.
//
// pan-client and the Slack client connect to /ws/client under a name they choose
// themselves (device_id), and PAN sends that name's commands to whoever holds it. So a
// name belongs to the computer that first used it, kept in devices.link_device_id:
//   - over PAN Link, the link device (its own WireGuard key; pan-link-auth.js);
//   - otherwise LOCAL, this computer itself (with PAN_HOST=127.0.0.1 nothing else
//     reaches PAN without the link).
// No other computer gets a name someone holds. Two ways a name moves on:
//   - the link device holding it was removed (link.json no longer lists it);
//   - it was held by LOCAL and one of the owner's own link computers (not a limited one)
//     uses it, which is what moving a PC from Tailscale to PAN Link looks like.
// A name nobody holds yet goes to the first computer that uses it. New names wait for
// the owner's approval, as always. A name PAN already approved, taken by a limited link
// device, waits for approval again: a limited computer can't inherit the owner's trust.

export const LOCAL = 'local';

/**
 * Decide a registration.
 * @param {{trusted: number|null, link_device_id: string|null}|null} row
 *        the devices row for this name, or null for a name PAN hasn't seen
 * @param {string} source       the link device id, or LOCAL
 * @param {object} opts
 * @param {boolean} opts.limited     the link device is limited (ignored for LOCAL)
 * @param {boolean} opts.holderGone  the link device holding the name is no longer paired
 * @returns {{ok: false} | {ok: true, bind: string|null, pending: boolean, reapprove: boolean}}
 *   bind: the holder to record (null: it already holds the name);
 *   pending: wait for the owner's approval;
 *   reapprove: an approved name is losing its approval (a limited computer took it).
 */
export function decideClaim(row, source, { limited = false, holderGone = false } = {}) {
  const fromLink = source !== LOCAL;
  const isLimited = fromLink && limited;
  const holder = row?.link_device_id || null;
  const approved = row?.trusted === 1;

  if (holder === source) return { ok: true, bind: null, pending: !approved, reapprove: false };

  if (holder && !holderGone) {
    const movingToLink = holder === LOCAL && fromLink && !isLimited;
    if (!movingToLink) return { ok: false };
  }

  // Nobody holds it (or its holder is gone, or it moves to the owner's link computer).
  const reapprove = isLimited && approved;
  return { ok: true, bind: source, pending: !approved || reapprove, reapprove };
}
