// Alone with PAN: his own voice (voice ID's verdict, even while its gate only watches), nobody named
// in the talk, and no other voice heard on this device for OTHER_VOICE_MS. Then a question the reader
// called not for PAN is asked again (router.js): a plain question about his own day got silence
// on Nov 21 while he was alone with PAN. Friends in the room are heard as other voices even when nobody names them.
// Pure but for the clock handed in; tested in __tests__/alone.test.js.

export const OTHER_VOICE_MS = 10 * 60_000;

export function createAlone({ now = Date.now } = {}) {
  const otherVoiceAt = new Map();   // device id -> when a voice not his was last heard there
  const heardOther = (deviceId) => { otherVoiceAt.set(String(deviceId || ''), now()); };
  /** context: { voice_his, device_id }; part: participationOf(...) */
  const aloneWithPan = (context, part) => {
    if (context?.voice_his !== true || (part?.others ?? 1) > 0) return false;
    return now() - (otherVoiceAt.get(String(context.device_id || '')) ?? -Infinity) > OTHER_VOICE_MS;
  };
  return { heardOther, aloneWithPan };
}

export const alone = createAlone();
