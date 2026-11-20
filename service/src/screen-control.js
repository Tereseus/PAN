// Screen control: commands for the PAN app's accessibility service (read the screen, tap, type,
// scroll) wait here for the ONE device they are meant for. A device with the service on asks for
// its commands every two seconds and names itself; a command names its device, or goes to the
// only device that is asking. It never goes to "whichever phone asks first": with two phones on,
// a tap meant for one must not land on the other.
// Pure but for the clock handed in; tested in __tests__/screen-control.test.js.

const LIVE_MS = 10_000;     // a device that asked this recently has the service on
const WAIT_MS = 15_000;     // a command not picked up in this long is dropped

/** A device id as both sides write it: lower case, spaces as dashes. '' when there is none. */
export function deviceKey(name) {
  return String(name || '').trim().toLowerCase().replace(/\s+/g, '-').slice(0, 80);
}

export function createScreenControl({ now = Date.now } = {}) {
  const pending = [];          // { id, device, action, ...params, at }
  const seen = new Map();      // device -> { at, name }

  const drop = () => {
    const t = now();
    for (let i = pending.length - 1; i >= 0; i--) if (t - pending[i].at > WAIT_MS) pending.splice(i, 1);
    for (const [d, s] of seen) if (t - s.at > 10 * LIVE_MS) seen.delete(d);
  };

  /** The devices whose service is on right now: [{ device, name }], newest first. */
  const devices = () => {
    const t = now();
    return [...seen].filter(([, s]) => t - s.at <= LIVE_MS).sort((a, b) => b[1].at - a[1].at).map(([device, s]) => ({ device, name: s.name }));
  };

  /** A device asks for its commands. A device that does not name itself gets nothing. */
  const poll = (device, name = '') => {
    const d = deviceKey(device);
    drop();
    if (!d) return [];
    seen.set(d, { at: now(), name: String(name || '').slice(0, 80) });
    const mine = pending.filter((c) => c.device === d);
    for (const c of mine) pending.splice(pending.indexOf(c), 1);
    return mine.map(({ at, device: _d, ...cmd }) => cmd);
  };

  /**
   * Queue a command. `device` names the target (its id, or the name it shows); without one it
   * goes to the only device that is on. Returns { device } or { error } and queues nothing on error.
   */
  const add = (cmd, device = '') => {
    drop();
    const live = devices();
    if (!live.length) return { error: 'No device has screen control on. Turn on PAN under Accessibility in Android Settings.' };
    const want = deviceKey(device);
    let target;
    if (want) {
      target = live.find((l) => l.device === want || deviceKey(l.name) === want);
      if (!target) return { error: `That device does not have screen control on. On now: ${live.map((l) => l.name || l.device).join(', ')}.` };
    } else if (live.length === 1) {
      target = live[0];
    } else {
      return { error: `More than one device has screen control on. Name one: ${live.map((l) => l.name || l.device).join(', ')}.` };
    }
    pending.push({ ...cmd, device: target.device, at: now() });
    return { device: target.device };
  };

  return { poll, add, devices, waiting: () => pending.length };
}
