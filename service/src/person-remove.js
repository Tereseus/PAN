// Removing a person from the hub removes what was theirs.
//
// DELETE /users/:id only deleted the row in `users` (found 2026-11-19). The person's phone
// stayed paired and kept talking to PAN as "Nobody", their messages, groups, met list and
// voice stayed in the database. Now:
//  - each device paired for them is unpaired in PAN Link, so it cannot reach the hub at all;
//  - the note that says whose device it was is KEPT: if that device id ever shows up again it
//    belongs to a person who is gone, and such a device is refused everything (server.js). A
//    device with no note is the owner's, so deleting the note would hand it the owner's rights;
//  - their messages (both ways), group places, met list, extra names, message mode, call
//    blocks and learned voice are deleted.
import { run, all, get } from './db.js';
import { ensurePeopleSchema, resetPeopleCache } from './people.js';

const quiet = (fn) => { try { return fn(); } catch { return undefined; } };

function dropFromSetting(key, change) {
  const row = quiet(() => get(`SELECT value FROM settings WHERE key = :k`, { ':k': key }));
  if (!row?.value) return;
  let map;
  try { map = JSON.parse(row.value); } catch { return; }
  if (!map || typeof map !== 'object') return;
  const before = JSON.stringify(map);
  change(map);
  const after = JSON.stringify(map);
  if (after !== before) run(`UPDATE settings SET value = :v WHERE key = :k`, { ':v': after, ':k': key });
}

/**
 * unpair(linkDeviceId) -> true when PAN Link dropped that device. forgetVoice(userId): the
 * learned voice (person-voices.js), passed in so this file needs nothing that loads models.
 * -> { ok, devices, unpaired, still_paired: [ids] } | { ok: false, reason }
 */
export async function removePerson(userId, { unpair = null, forgetVoice = null } = {}) {
  const id = Number(userId);
  if (!Number.isInteger(id) || id <= 1) return { ok: false, reason: 'not_a_person' };
  ensurePeopleSchema();
  const devices = (quiet(() => all('SELECT link_device_id FROM device_people WHERE user_id = :u', { ':u': id })) || []).map((r) => String(r.link_device_id));
  const still = [];
  let unpaired = 0;
  for (const d of devices) {
    let gone = false;
    try { gone = unpair ? !!(await unpair(d)) : false; } catch { gone = false; }
    if (gone) unpaired++; else still.push(d);
  }
  quiet(() => run('DELETE FROM pairing_for WHERE user_id = :u', { ':u': id }));
  quiet(() => run('DELETE FROM person_messages WHERE from_user = :u OR to_user = :u', { ':u': id }));
  quiet(() => run('DELETE FROM people_group_people WHERE user_id = :u', { ':u': id }));
  quiet(() => run('DELETE FROM met_people WHERE user_id = :u', { ':u': id }));
  const key = String(id);
  dropFromSetting('people_nicknames', (m) => { delete m[key]; });
  dropFromSetting('people_message_mode', (m) => { delete m[key]; });
  dropFromSetting('people_call_block', (m) => {
    delete m[key];
    for (const k of Object.keys(m)) {
      if (!Array.isArray(m[k])) continue;
      m[k] = m[k].filter((x) => Number(x) !== id);
      if (!m[k].length) delete m[k];
    }
  });
  if (forgetVoice) quiet(() => forgetVoice(id));
  run('DELETE FROM users WHERE id = :id', { ':id': id });
  resetPeopleCache();
  return { ok: true, devices: devices.length, unpaired, still_paired: still };
}
