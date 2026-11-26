// Each device's own name for ΠAN (task 1082, the owner Nov 26: "every individual's pendant or phone
// can have their own version of that"). The device sends `pan_name` with every turn ("Jamie").
// The hub reads that name where ΠAN is called ("Jamie, what time is it" -> "Pan, what time is it")
// so every rule that knows ΠAN's name (saysPanName and the others, and the voice model, which was
// trained on "Pan") works unchanged. The turn is still recorded with his own words (`said_as`).
// Once a device has its own name, "Pan" on it is just someone else's name: not answered.

const MAX = 24;

/** The device's name for ΠAN, cleaned: '' when there is none, or when it is ΠAN itself. */
export function cleanName(name) {
  const n = String(name || '').replace(/[^\p{L}\p{M}' -]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX);
  if (!n || n.split(' ').length > 3) return '';
  if (/^(?:pan|pam|πan|παν|pan ai)$/i.test(n)) return '';
  return n;
}

function esc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** The name where ΠAN is called (start, end, or the start of a sentence) becomes "Pan". */
export function mapName(text, name) {
  const n = cleanName(name);
  const t = String(text || '');
  if (!n) return t;
  const N = esc(n).replace(/ /g, '\\s+');
  const B = String.raw`(?![\p{L}\p{M}])`;   // no letter after it (\b does not know "ΠAN" or accents)
  return t
    .replace(new RegExp(String.raw`^(\s*(?:(?:hey|hi|hello|ok|okay|yo)[,\s]+)?)${N}${B}`, 'iu'), '$1Pan')
    .replace(new RegExp(String.raw`([.!?,;]\s+(?:(?:hey|hi|ok|okay)[,\s]+)?)${N}${B}`, 'giu'), '$1Pan')
    .replace(new RegExp(String.raw`(^|[\s,])${N}([\s?.!]*)$`, 'iu'), '$1Pan$2');
}

/** Says his own name for ΠAN somewhere ΠAN is called. */
export function callsOwnName(text, name) {
  const n = cleanName(name);
  return !!n && mapName(text, n) !== String(text || '');
}

/** One line for the prompt: what ΠAN is called on this device. */
export function nameLine(name) {
  const n = cleanName(name);
  return n ? `On this device your name is ${n}. Call yourself ${n}, never ΠAN.` : '';
}
