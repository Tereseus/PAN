import { Router } from 'express';
import { all, get, run } from '../db.js';
import { auditLog } from '../middleware/org-context.js';

const router = Router();

// All 22 PAN sensors
const SENSOR_DEFS = [
  { id: 'microphone',    name: 'Microphone',            category: 'passive', icon: '🎙️', description: 'Audio capture, human hearing range (PDM)' },
  { id: 'camera',        name: 'Camera',               category: 'passive', icon: '📷', description: 'Visible light photos, 2MP (OV2640)' },
  { id: 'gas',           name: 'Gas / Air Quality',     category: 'passive', icon: '💨', description: 'VOCs, CO, methane, smoke (BME688)' },
  { id: 'uv',            name: 'UV Sensor',             category: 'passive', icon: '☀️', description: 'Ultraviolet light intensity (LTR390)' },
  { id: 'thermal',       name: 'Thermal Camera',        category: 'passive', icon: '🌡️', description: '32x24 thermal image, heat signatures (MLX90640)' },
  { id: 'magnetometer',  name: 'Magnetometer',          category: 'passive', icon: '🧭', description: 'Magnetic field, compass (QMC5883L)' },
  { id: 'air_quality',   name: 'Air Quality (VOC)',     category: 'passive', icon: '🌬️', description: 'VOC index, indoor air quality (SGP40)' },
  { id: 'accel_gyro',    name: 'Accelerometer / Gyro',  category: 'passive', icon: '📐', description: 'Motion, rotation, steps, fall detection (BMI270)' },
  { id: 'heart_rate',    name: 'Heart Rate / SpO2',     category: 'passive', icon: '❤️', description: 'Pulse + blood oxygen (MAX30102)' },
  { id: 'gps',           name: 'GPS',                   category: 'passive', icon: '📍', description: 'Position, speed, altitude (L76K GNSS)' },
  { id: 'ambient_light', name: 'Ambient Light',         category: 'passive', icon: '💡', description: 'Light intensity in lux (BH1750)' },
  { id: 'sound_level',   name: 'Sound Level',           category: 'passive', icon: '🔊', description: 'Decibel measurement (MAX4466)' },
  { id: 'laser_dist',    name: 'Laser Distance',        category: 'passive', icon: '📏', description: 'Time-of-flight distance, mm accuracy (VL53L0X)' },
  { id: 'ultrasonic',    name: 'Ultrasonic',            category: 'passive', icon: '🦇', description: 'Distance via echolocation, up to 4m (RCWL-1601)' },
  { id: 'temp_humidity', name: 'Temp / Humidity',       category: 'passive', icon: '🌡️', description: 'Temperature + humidity (SHT40 / BME688)' },
  { id: 'barometer',     name: 'Barometric Pressure',   category: 'passive', icon: '🌤️', description: 'Atmospheric pressure, altitude (BME688)' },
  { id: 'gsr',           name: 'Skin Conductance',      category: 'passive', icon: '⚡', description: 'Galvanic skin response, stress (GSR module)' },
  { id: 'radiation',     name: 'Radiation Detector',    category: 'passive', icon: '☢️', description: 'Gamma + beta ionizing radiation (RadSens)' },
  { id: 'spectrometer',  name: 'Spectrometer',          category: 'active',  icon: '🔬', description: '11-channel spectral analysis (AS7341)' },
  { id: 'color_sensor',  name: 'Color Sensor',          category: 'active',  icon: '🎨', description: 'Precise RGB color values (TCS34725)' },
  { id: 'emf',           name: 'EMF Sensor',            category: 'active',  icon: '⚡', description: 'Electromagnetic field strength (AD8317)' },
  { id: 'ph',            name: 'pH Sensor',             category: 'active',  icon: '🧪', description: 'Acidity/alkalinity of liquids (PH-4502C)' },
];

// What sensors each device type actually has
// These are the ONLY sensors that show up for each device type
const DEVICE_SENSORS = {
  phone: ['microphone', 'camera', 'gps', 'accel_gyro', 'ambient_light', 'barometer'],
  pc: ['microphone', 'camera'],
  pendant: SENSOR_DEFS.map(s => s.id), // pendant has everything
};

function seedSensors() {
  const existing = get("SELECT COUNT(*) as c FROM sensor_definitions");
  if (existing && existing.c >= SENSOR_DEFS.length) return;

  console.log('[PAN Sensors] Seeding sensor definitions...');
  for (let i = 0; i < SENSOR_DEFS.length; i++) {
    const s = SENSOR_DEFS[i];
    run(`INSERT OR IGNORE INTO sensor_definitions (id, name, category, description, icon, sort_order)
         VALUES (:id, :name, :cat, :desc, :icon, :sort)`, {
      ':id': s.id, ':name': s.name, ':cat': s.category,
      ':desc': s.description, ':icon': s.icon, ':sort': i
    });
  }
  console.log(`[PAN Sensors] Seeded ${SENSOR_DEFS.length} sensors.`);
}

// Initialize sensor rows for a device — only sensors it actually has
function initDeviceSensors(deviceId, deviceType) {
  const existing = get("SELECT COUNT(*) as c FROM device_sensors WHERE device_id = :did", { ':did': deviceId });
  if (existing && existing.c > 0) return;

  const sensorIds = DEVICE_SENSORS[deviceType] || DEVICE_SENSORS.pc;

  for (const sid of sensorIds) {
    run(`INSERT OR IGNORE INTO device_sensors (device_id, sensor_id, available, muted)
         VALUES (:did, :sid, 1, 0)`, {
      ':did': deviceId, ':sid': sid
    });
  }
  console.log(`[PAN Sensors] Initialized ${sensorIds.length} sensors for device ${deviceId} (${deviceType})`);
}

// === API ROUTES ===

// GET /api/sensors — all sensor definitions
router.get('/', (req, res) => {
  const sensors = all("SELECT * FROM sensor_definitions ORDER BY sort_order");
  res.json(sensors);
});

// GET /api/sensors/devices/:deviceId — sensors for this device
// Only returns sensors the device actually has (available=1 in device_sensors)
router.get('/devices/:deviceId', (req, res) => {
  const deviceId = parseInt(req.params.deviceId);
  const device = get("SELECT * FROM devices WHERE id = :id", { ':id': deviceId });
  if (!device) return res.status(404).json({ error: 'device not found' });

  initDeviceSensors(deviceId, device.device_type);

  const sensors = all(`
    SELECT sd.*, ds.muted, ds.policy, ds.policy_reason
    FROM sensor_definitions sd
    JOIN device_sensors ds ON ds.sensor_id = sd.id AND ds.device_id = :did
    WHERE ds.available = 1
    ORDER BY sd.sort_order
  `, { ':did': deviceId });

  // Get attachments
  const attachments = all(`
    SELECT sensor_id, attach_to, enabled
    FROM sensor_attachments WHERE device_id = :did
  `, { ':did': deviceId });

  const attachMap = {};
  for (const a of attachments) {
    if (!attachMap[a.sensor_id]) attachMap[a.sensor_id] = {};
    attachMap[a.sensor_id][a.attach_to] = a.enabled === 1;
  }

  res.json({
    device: { id: device.id, name: device.name, device_type: device.device_type },
    sensors: sensors.map(s => ({
      id: s.id,
      name: s.name,
      category: s.category,
      description: s.description,
      icon: s.icon,
      enabled: s.policy === 'force_on' ? true : s.policy === 'force_off' ? false : s.muted === 0,
      muted: s.muted,
      policy: s.policy || null,        // null=user control, 'force_on', 'force_off'
      policy_reason: s.policy_reason || null,
      locked: s.policy != null,        // true if org policy overrides user toggle
      attachments: attachMap[s.id] || {}
    }))
  });
});

// PUT /api/sensors/devices/:deviceId/:sensorId — toggle ON/OFF
router.put('/devices/:deviceId/:sensorId', (req, res) => {
  const deviceId = parseInt(req.params.deviceId);
  const sensorId = req.params.sensorId;
  const { enabled } = req.body;

  const device = get("SELECT * FROM devices WHERE id = :id", { ':id': deviceId });
  if (!device) return res.status(404).json({ error: 'device not found' });

  initDeviceSensors(deviceId, device.device_type);

  // Check for org policy lock
  const ds = get("SELECT policy FROM device_sensors WHERE device_id = :did AND sensor_id = :sid",
    { ':did': deviceId, ':sid': sensorId });
  if (ds && ds.policy) {
    return res.status(403).json({ error: 'locked', policy: ds.policy, message: `Sensor locked by organization policy (${ds.policy})` });
  }

  // enabled=true → muted=0 (ON), enabled=false → muted=1 (OFF)
  const muted = enabled ? 0 : 1;
  run(`UPDATE device_sensors SET muted = :val WHERE device_id = :did AND sensor_id = :sid`,
    { ':val': muted, ':did': deviceId, ':sid': sensorId });

  try { auditLog(req, 'sensor.toggle', sensorId, { device_id: deviceId, enabled: !!enabled }); } catch {}
  res.json({ ok: true });
});

// PUT /api/sensors/devices/:deviceId/:sensorId/policy — org policy override
router.put('/devices/:deviceId/:sensorId/policy', (req, res) => {
  const deviceId = parseInt(req.params.deviceId);
  const sensorId = req.params.sensorId;
  const { policy, reason } = req.body;  // policy: null | 'force_on' | 'force_off'

  const device = get("SELECT * FROM devices WHERE id = :id", { ':id': deviceId });
  if (!device) return res.status(404).json({ error: 'device not found' });

  if (policy && !['force_on', 'force_off'].includes(policy)) {
    return res.status(400).json({ error: 'policy must be null, force_on, or force_off' });
  }

  run(`UPDATE device_sensors SET policy = :pol, policy_reason = :reason WHERE device_id = :did AND sensor_id = :sid`, {
    ':pol': policy || null, ':reason': reason || null, ':did': deviceId, ':sid': sensorId
  });

  try { auditLog(req, 'sensor.policy', sensorId, { device_id: deviceId, policy: policy || null, reason: reason || null }); } catch {}
  res.json({ ok: true, policy: policy || null });
});

// PUT /api/sensors/devices/:deviceId/:sensorId/attach/:attachTo
router.put('/devices/:deviceId/:sensorId/attach/:attachTo', (req, res) => {
  const deviceId = parseInt(req.params.deviceId);
  const sensorId = req.params.sensorId;
  const attachTo = req.params.attachTo;
  const { enabled } = req.body;

  run(`INSERT INTO sensor_attachments (device_id, sensor_id, attach_to, enabled)
       VALUES (:did, :sid, :ato, :en)
       ON CONFLICT(device_id, sensor_id, attach_to) DO UPDATE SET enabled = :en`, {
    ':did': deviceId, ':sid': sensorId, ':ato': attachTo, ':en': enabled ? 1 : 0
  });

  res.json({ ok: true });
});

// POST /api/sensors/devices/:deviceId/init — force re-init
router.post('/devices/:deviceId/init', (req, res) => {
  const deviceId = parseInt(req.params.deviceId);
  const device = get("SELECT * FROM devices WHERE id = :id", { ':id': deviceId });
  if (!device) return res.status(404).json({ error: 'device not found' });

  run("DELETE FROM device_sensors WHERE device_id = :did", { ':did': deviceId });
  run("DELETE FROM sensor_attachments WHERE device_id = :did", { ':did': deviceId });
  initDeviceSensors(deviceId, device.device_type);

  res.json({ ok: true });
});

// ======================================================================
// Tier 0 Phase 3 — Sensor Toggles CRUD (user intent layer)
// sensor_toggles = what the user WANTS (per user/device/org/sensor)
// device_sensors = hardware capability + org policy (what CAN be toggled)
// ======================================================================

const PERSONAL_ORG_ID = 'org_personal';

// GET /api/sensors/toggles — list all sensor toggles for current user + org
// Merges sensor_toggles (user intent) with device_sensors (hardware defaults)
router.get('/toggles', (req, res) => {
  const userId = req.user?.id || 1;
  const orgId = req.org_id || PERSONAL_ORG_ID;

  // Get all explicit toggles for this user + org
  const toggles = all(
    `SELECT * FROM sensor_toggles WHERE user_id = :uid AND org_id = :oid`,
    { ':uid': userId, ':oid': orgId }
  );

  // Get all devices for this user to provide defaults from device_sensors
  const devices = all(
    `SELECT d.id, d.name, d.device_type FROM devices WHERE user_id = :uid`,
    { ':uid': userId }
  );

  // Build a merged view: sensor_toggles override device_sensors defaults
  const result = [];
  for (const device of devices) {
    const deviceSensors = all(
      `SELECT ds.sensor_id, ds.muted, ds.policy, ds.policy_reason, sd.name, sd.category, sd.icon
       FROM device_sensors ds
       JOIN sensor_definitions sd ON sd.id = ds.sensor_id
       WHERE ds.device_id = :did AND ds.available = 1
       ORDER BY sd.sort_order`,
      { ':did': device.id }
    );

    const deviceToggles = toggles.filter(t => t.device_id === device.id);
    const toggleMap = {};
    for (const t of deviceToggles) toggleMap[t.sensor] = t;

    const sensors = deviceSensors.map(ds => {
      const toggle = toggleMap[ds.sensor_id];
      return {
        sensor: ds.sensor_id,
        name: ds.name,
        category: ds.category,
        icon: ds.icon,
        // toggle overrides device_sensors default
        enabled: toggle ? toggle.enabled === 1 : ds.muted === 0,
        cadence_seconds: toggle?.cadence_seconds || null,
        forced_by_org: toggle ? toggle.forced_by_org === 1 : (ds.policy === 'force_on'),
        policy: ds.policy || null,
        policy_reason: ds.policy_reason || null,
        locked: ds.policy != null,
        has_toggle: !!toggle,
        updated_at: toggle?.updated_at || null,
      };
    });

    result.push({
      device_id: device.id,
      device_name: device.name,
      device_type: device.device_type,
      sensors,
    });
  }

  res.json({ org_id: orgId, user_id: userId, devices: result });
});

// PUT /api/sensors/toggles/:sensor — toggle a sensor on/off for current user/device/org
router.put('/toggles/:sensor', (req, res) => {
  const userId = req.user?.id || 1;
  const orgId = req.org_id || PERSONAL_ORG_ID;
  const sensor = req.params.sensor;
  const { enabled, device_id, cadence_seconds } = req.body;

  if (typeof enabled !== 'boolean' && typeof enabled !== 'number') {
    return res.status(400).json({ error: 'enabled (boolean) is required' });
  }

  // Validate sensor exists
  const sensorDef = get(
    `SELECT id FROM sensor_definitions WHERE id = :sid`,
    { ':sid': sensor }
  );
  if (!sensorDef) {
    return res.status(404).json({ error: `unknown sensor: ${sensor}` });
  }

  // Resolve device_id — use provided or default to first device
  let deviceId = device_id;
  if (!deviceId) {
    const firstDevice = get(
      `SELECT id FROM devices WHERE user_id = :uid LIMIT 1`,
      { ':uid': userId }
    );
    if (!firstDevice) {
      return res.status(404).json({ error: 'no devices found for user' });
    }
    deviceId = firstDevice.id;
  }

  // Check if org-forced — cannot override forced sensors
  const existing = get(
    `SELECT forced_by_org FROM sensor_toggles WHERE user_id = :uid AND device_id = :did AND org_id = :oid AND sensor = :sid`,
    { ':uid': userId, ':did': deviceId, ':oid': orgId, ':sid': sensor }
  );
  if (existing && existing.forced_by_org === 1) {
    return res.status(403).json({
      error: 'sensor is forced by org policy',
      sensor,
      forced_by_org: true,
    });
  }

  // Also check device_sensors policy
  const dsPolicy = get(
    `SELECT policy FROM device_sensors WHERE device_id = :did AND sensor_id = :sid`,
    { ':did': deviceId, ':sid': sensor }
  );
  if (dsPolicy && dsPolicy.policy) {
    return res.status(403).json({
      error: `sensor locked by device policy: ${dsPolicy.policy}`,
      sensor,
      policy: dsPolicy.policy,
    });
  }

  const enabledInt = enabled ? 1 : 0;
  const now = Date.now();

  run(
    `INSERT INTO sensor_toggles (user_id, device_id, org_id, sensor, enabled, cadence_seconds, forced_by_org, updated_at)
     VALUES (:uid, :did, :oid, :sid, :en, :cad, 0, :now)
     ON CONFLICT(user_id, device_id, org_id, sensor)
     DO UPDATE SET enabled = :en, cadence_seconds = :cad, updated_at = :now`,
    {
      ':uid': userId, ':did': deviceId, ':oid': orgId,
      ':sid': sensor, ':en': enabledInt,
      ':cad': cadence_seconds || null, ':now': now,
    }
  );

  // Audit log for sensor toggle changes
  try {
    const auditReq = { user: { id: userId }, org_id: orgId };
    auditLog(auditReq, 'sensor.toggle', sensor, { enabled: !!enabledInt, device_id: deviceId });
  } catch {}

  res.json({ ok: true, sensor, enabled: !!enabledInt, device_id: deviceId, org_id: orgId });
});

// POST /api/sensors/toggles/bulk — bulk on/off (mute all / unmute all)
router.post('/toggles/bulk', (req, res) => {
  const userId = req.user?.id || 1;
  const orgId = req.org_id || PERSONAL_ORG_ID;
  const { enabled, device_id, sensors: sensorList } = req.body;

  if (typeof enabled !== 'boolean' && typeof enabled !== 'number') {
    return res.status(400).json({ error: 'enabled (boolean) is required' });
  }

  // Resolve device_id
  let deviceId = device_id;
  if (!deviceId) {
    const firstDevice = get(
      `SELECT id FROM devices WHERE user_id = :uid LIMIT 1`,
      { ':uid': userId }
    );
    if (!firstDevice) {
      return res.status(404).json({ error: 'no devices found for user' });
    }
    deviceId = firstDevice.id;
  }

  // Get available sensors for this device
  let targetSensors;
  if (sensorList && Array.isArray(sensorList) && sensorList.length > 0) {
    // Caller specified which sensors to bulk toggle
    targetSensors = sensorList;
  } else {
    // All available sensors on the device
    const available = all(
      `SELECT sensor_id FROM device_sensors WHERE device_id = :did AND available = 1`,
      { ':did': deviceId }
    );
    targetSensors = available.map(r => r.sensor_id);
  }

  const enabledInt = enabled ? 1 : 0;
  const now = Date.now();
  let toggled = 0;
  let skippedForced = 0;

  for (const sensor of targetSensors) {
    // Skip org-forced sensors
    const existing = get(
      `SELECT forced_by_org FROM sensor_toggles WHERE user_id = :uid AND device_id = :did AND org_id = :oid AND sensor = :sid`,
      { ':uid': userId, ':did': deviceId, ':oid': orgId, ':sid': sensor }
    );
    if (existing && existing.forced_by_org === 1) {
      skippedForced++;
      continue;
    }

    // Skip device policy-locked sensors
    const dsPolicy = get(
      `SELECT policy FROM device_sensors WHERE device_id = :did AND sensor_id = :sid`,
      { ':did': deviceId, ':sid': sensor }
    );
    if (dsPolicy && dsPolicy.policy) {
      skippedForced++;
      continue;
    }

    run(
      `INSERT INTO sensor_toggles (user_id, device_id, org_id, sensor, enabled, cadence_seconds, forced_by_org, updated_at)
       VALUES (:uid, :did, :oid, :sid, :en, NULL, 0, :now)
       ON CONFLICT(user_id, device_id, org_id, sensor)
       DO UPDATE SET enabled = :en, updated_at = :now`,
      {
        ':uid': userId, ':did': deviceId, ':oid': orgId,
        ':sid': sensor, ':en': enabledInt, ':now': now,
      }
    );
    toggled++;
  }

  // Audit log for bulk sensor toggle
  try {
    const auditReq = { user: { id: userId }, org_id: orgId };
    auditLog(auditReq, 'sensor.bulk_toggle', null, { enabled: !!enabledInt, toggled, skipped_forced: skippedForced });
  } catch {}

  res.json({
    ok: true,
    enabled: !!enabledInt,
    device_id: deviceId,
    org_id: orgId,
    toggled,
    skipped_forced: skippedForced,
    total: targetSensors.length,
  });
});

// GET /api/sensors/toggles/hard-off — check if hard off is active
router.get('/toggles/hard-off', (req, res) => {
  const userId = req.user?.id || 1;
  const orgId = req.org_id || PERSONAL_ORG_ID;

  // Hard Off only available in personal org
  if (orgId !== PERSONAL_ORG_ID) {
    return res.json({
      available: false,
      active: false,
      reason: 'Hard Off is only available in personal org. Org controls sensors.',
    });
  }

  // Check if ALL non-forced sensors are disabled for this user across all devices
  const devices = all(
    `SELECT id FROM devices WHERE user_id = :uid`,
    { ':uid': userId }
  );

  if (devices.length === 0) {
    return res.json({ available: true, active: false, reason: 'no devices' });
  }

  let allOff = true;
  for (const device of devices) {
    const available = all(
      `SELECT sensor_id FROM device_sensors WHERE device_id = :did AND available = 1`,
      { ':did': device.id }
    );

    for (const row of available) {
      // Skip org-forced sensors (they stay on regardless)
      const toggle = get(
        `SELECT enabled, forced_by_org FROM sensor_toggles WHERE user_id = :uid AND device_id = :did AND org_id = :oid AND sensor = :sid`,
        { ':uid': userId, ':did': device.id, ':oid': orgId, ':sid': row.sensor_id }
      );

      if (toggle && toggle.forced_by_org === 1) continue;

      // If no toggle exists, sensor defaults to ON (muted=0 in device_sensors)
      if (!toggle) {
        const ds = get(
          `SELECT muted FROM device_sensors WHERE device_id = :did AND sensor_id = :sid`,
          { ':did': device.id, ':sid': row.sensor_id }
        );
        if (!ds || ds.muted === 0) {
          allOff = false;
          break;
        }
      } else if (toggle.enabled === 1) {
        allOff = false;
        break;
      }
    }
    if (!allOff) break;
  }

  res.json({ available: true, active: allOff, org_id: orgId });
});

// POST /api/sensors/toggles/hard-off — toggle hard off (personal org only)
router.post('/toggles/hard-off', (req, res) => {
  const userId = req.user?.id || 1;
  const orgId = req.org_id || PERSONAL_ORG_ID;
  const { active } = req.body; // true = turn everything off, false = restore

  // Hard Off only in personal org
  if (orgId !== PERSONAL_ORG_ID) {
    return res.status(403).json({
      error: 'Hard Off is only available in personal org',
      reason: 'In org mode, the organization controls sensor policy.',
    });
  }

  if (typeof active !== 'boolean') {
    return res.status(400).json({ error: 'active (boolean) is required — true = all off, false = restore' });
  }

  const devices = all(
    `SELECT id FROM devices WHERE user_id = :uid`,
    { ':uid': userId }
  );

  const enabledInt = active ? 0 : 1; // hard-off active = sensors disabled
  const now = Date.now();
  let toggled = 0;
  let skippedForced = 0;

  for (const device of devices) {
    const available = all(
      `SELECT sensor_id FROM device_sensors WHERE device_id = :did AND available = 1`,
      { ':did': device.id }
    );

    for (const row of available) {
      // Do NOT override forced_by_org sensors
      const existing = get(
        `SELECT forced_by_org FROM sensor_toggles WHERE user_id = :uid AND device_id = :did AND org_id = :oid AND sensor = :sid`,
        { ':uid': userId, ':did': device.id, ':oid': orgId, ':sid': row.sensor_id }
      );
      if (existing && existing.forced_by_org === 1) {
        skippedForced++;
        continue;
      }

      run(
        `INSERT INTO sensor_toggles (user_id, device_id, org_id, sensor, enabled, cadence_seconds, forced_by_org, updated_at)
         VALUES (:uid, :did, :oid, :sid, :en, NULL, 0, :now)
         ON CONFLICT(user_id, device_id, org_id, sensor)
         DO UPDATE SET enabled = :en, updated_at = :now`,
        {
          ':uid': userId, ':did': device.id, ':oid': orgId,
          ':sid': row.sensor_id, ':en': enabledInt, ':now': now,
        }
      );
      toggled++;
    }
  }

  // Audit log for hard off toggle
  try {
    const auditReq = { user: { id: userId }, org_id: orgId };
    auditLog(auditReq, 'sensor.hard_off', null, { active, toggled, skipped_forced: skippedForced });
  } catch {}

  res.json({
    ok: true,
    hard_off: active,
    org_id: orgId,
    toggled,
    skipped_forced: skippedForced,
  });
});

export { seedSensors };
export default router;
