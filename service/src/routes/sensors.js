import { Router } from 'express';
import { all, get, run } from '../db.js';

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

export { seedSensors };
export default router;
