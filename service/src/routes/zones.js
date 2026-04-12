// Tier 0 Phase 7 — Geofencing + Zones
//
// CRUD for org geofence zones + point-in-polygon resolver.
// Phone calls POST /api/v1/zones/check on GPS update to get
// combined sensor rules for all active zones.

import { Router } from 'express';
import { all, get, run, logEvent } from '../db.js';
import { auditLog } from '../middleware/org-context.js';

const router = Router();

const PERSONAL_ORG_ID = 'org_personal';

// ============================================================
// Ray-casting point-in-polygon (no external deps)
// GeoJSON polygons use [lng, lat] order.
// ============================================================
function pointInPolygon(lat, lng, polygon) {
  // polygon is an array of [lng, lat] pairs (GeoJSON ring)
  // First and last point should be the same (closed ring), but we handle both
  const n = polygon.length;
  let inside = false;

  for (let i = 0, j = n - 1; i < n; j = i++) {
    const yi = polygon[i][1]; // lat
    const xi = polygon[i][0]; // lng
    const yj = polygon[j][1];
    const xj = polygon[j][0];

    // Ray from point going east (+lng direction)
    if ((yi > lat) !== (yj > lat)) {
      const intersectX = xj + ((lat - yj) / (yi - yj)) * (xi - xj);
      if (lng < intersectX) {
        inside = !inside;
      }
    }
  }

  return inside;
}

// ============================================================
// getActiveZones — returns all zones containing the given point
// ============================================================
export function getActiveZones(lat, lng, orgId) {
  const zones = all(
    `SELECT * FROM zones WHERE org_id = :oid`,
    { ':oid': orgId }
  );

  const active = [];
  for (const zone of zones) {
    let polygon;
    try {
      const geojson = JSON.parse(zone.polygon_geojson);
      // Support both raw coordinate array and GeoJSON Polygon object
      if (Array.isArray(geojson)) {
        polygon = geojson;
      } else if (geojson.type === 'Polygon' && Array.isArray(geojson.coordinates)) {
        // GeoJSON Polygon: coordinates[0] is the outer ring
        polygon = geojson.coordinates[0];
      } else if (geojson.type === 'Feature' && geojson.geometry?.type === 'Polygon') {
        polygon = geojson.geometry.coordinates[0];
      } else {
        continue; // unsupported format
      }
    } catch {
      continue; // invalid JSON
    }

    if (pointInPolygon(lat, lng, polygon)) {
      let sensorRules = null;
      let toolRules = null;
      try { sensorRules = zone.sensor_rules_json ? JSON.parse(zone.sensor_rules_json) : null; } catch {}
      try { toolRules = zone.tool_rules_json ? JSON.parse(zone.tool_rules_json) : null; } catch {}

      active.push({
        id: zone.id,
        name: zone.name,
        sensor_rules: sensorRules,
        tool_rules: toolRules,
      });
    }
  }

  return active;
}

// ============================================================
// findZonesForPoint — alias with (orgId, lat, lng) signature
// as specified in Phase 7 spec
// ============================================================
export function findZonesForPoint(orgId, lat, lng) {
  return getActiveZones(lat, lng, orgId);
}

// ============================================================
// Merge sensor rules from multiple overlapping zones.
// forced_off beats forced_on beats null.
// ============================================================
function mergeSensorRules(zones) {
  const merged = {};
  for (const zone of zones) {
    if (!zone.sensor_rules) continue;
    for (const [sensor, rule] of Object.entries(zone.sensor_rules)) {
      const existing = merged[sensor];
      // forced_off always wins (most restrictive)
      if (existing === 'forced_off') continue;
      merged[sensor] = rule;
    }
  }
  return merged;
}

// ============================================================
// Routes
// ============================================================

// GET /api/v1/zones — list zones for current org
router.get('/', (req, res) => {
  const orgId = req.org_id || PERSONAL_ORG_ID;

  const zones = all(
    `SELECT * FROM zones WHERE org_id = :oid ORDER BY created_at DESC`,
    { ':oid': orgId }
  );

  res.json({
    org_id: orgId,
    zones: zones.map(z => {
      let sensorRules = null;
      let toolRules = null;
      try { sensorRules = z.sensor_rules_json ? JSON.parse(z.sensor_rules_json) : null; } catch {}
      try { toolRules = z.tool_rules_json ? JSON.parse(z.tool_rules_json) : null; } catch {}
      return {
        id: z.id,
        name: z.name,
        polygon_geojson: z.polygon_geojson,
        sensor_rules: sensorRules,
        tool_rules: toolRules,
        created_at: z.created_at,
      };
    }),
  });
});

// POST /api/v1/zones — create a zone
router.post('/', (req, res) => {
  const orgId = req.org_id || PERSONAL_ORG_ID;
  const { name, polygon_geojson, sensor_rules, tool_rules } = req.body;

  if (!name || !polygon_geojson) {
    return res.status(400).json({ error: 'name and polygon_geojson are required' });
  }

  // Validate polygon_geojson is parseable
  let polygonStr;
  try {
    const parsed = typeof polygon_geojson === 'string' ? JSON.parse(polygon_geojson) : polygon_geojson;
    polygonStr = JSON.stringify(parsed);
  } catch {
    return res.status(400).json({ error: 'polygon_geojson must be valid JSON' });
  }

  const sensorRulesStr = sensor_rules ? JSON.stringify(sensor_rules) : null;
  const toolRulesStr = tool_rules ? JSON.stringify(tool_rules) : null;
  const now = Date.now();

  run(
    `INSERT INTO zones (org_id, name, polygon_geojson, sensor_rules_json, tool_rules_json, created_at)
     VALUES (:oid, :name, :poly, :sr, :tr, :now)`,
    {
      ':oid': orgId,
      ':name': name,
      ':poly': polygonStr,
      ':sr': sensorRulesStr,
      ':tr': toolRulesStr,
      ':now': now,
    }
  );

  const created = get(
    `SELECT id FROM zones WHERE org_id = :oid AND name = :name AND created_at = :now`,
    { ':oid': orgId, ':name': name, ':now': now }
  );

  try { auditLog(req, 'zone.create', name, { zone_id: created?.id, sensor_rules, tool_rules }); } catch {}

  res.json({ ok: true, zone_id: created?.id, name, org_id: orgId });
});

// PUT /api/v1/zones/:id — update a zone
router.put('/:id', (req, res) => {
  const orgId = req.org_id || PERSONAL_ORG_ID;
  const zoneId = parseInt(req.params.id);

  const existing = get(
    `SELECT * FROM zones WHERE id = :id AND org_id = :oid`,
    { ':id': zoneId, ':oid': orgId }
  );
  if (!existing) {
    return res.status(404).json({ error: 'zone not found' });
  }

  const { name, polygon_geojson, sensor_rules, tool_rules } = req.body;

  // Build SET clause dynamically for provided fields only
  const updates = [];
  const params = { ':id': zoneId, ':oid': orgId };

  if (name !== undefined) {
    updates.push('name = :name');
    params[':name'] = name;
  }

  if (polygon_geojson !== undefined) {
    try {
      const parsed = typeof polygon_geojson === 'string' ? JSON.parse(polygon_geojson) : polygon_geojson;
      updates.push('polygon_geojson = :poly');
      params[':poly'] = JSON.stringify(parsed);
    } catch {
      return res.status(400).json({ error: 'polygon_geojson must be valid JSON' });
    }
  }

  if (sensor_rules !== undefined) {
    updates.push('sensor_rules_json = :sr');
    params[':sr'] = sensor_rules ? JSON.stringify(sensor_rules) : null;
  }

  if (tool_rules !== undefined) {
    updates.push('tool_rules_json = :tr');
    params[':tr'] = tool_rules ? JSON.stringify(tool_rules) : null;
  }

  if (updates.length === 0) {
    return res.status(400).json({ error: 'no fields to update' });
  }

  run(
    `UPDATE zones SET ${updates.join(', ')} WHERE id = :id AND org_id = :oid`,
    params
  );

  try { auditLog(req, 'zone.update', existing.name, { zone_id: zoneId, changed: Object.keys(req.body) }); } catch {}

  res.json({ ok: true, zone_id: zoneId });
});

// DELETE /api/v1/zones/:id — delete a zone
router.delete('/:id', (req, res) => {
  const orgId = req.org_id || PERSONAL_ORG_ID;
  const zoneId = parseInt(req.params.id);

  const existing = get(
    `SELECT * FROM zones WHERE id = :id AND org_id = :oid`,
    { ':id': zoneId, ':oid': orgId }
  );
  if (!existing) {
    return res.status(404).json({ error: 'zone not found' });
  }

  run(
    `DELETE FROM zones WHERE id = :id AND org_id = :oid`,
    { ':id': zoneId, ':oid': orgId }
  );

  try { auditLog(req, 'zone.delete', existing.name, { zone_id: zoneId }); } catch {}

  res.json({ ok: true, deleted: zoneId, name: existing.name });
});

// GET /api/v1/zones/:id — single zone details
router.get('/:id', (req, res) => {
  const orgId = req.org_id || PERSONAL_ORG_ID;
  const zoneId = parseInt(req.params.id);

  const zone = get(
    `SELECT * FROM zones WHERE id = :id AND org_id = :oid`,
    { ':id': zoneId, ':oid': orgId }
  );
  if (!zone) {
    return res.status(404).json({ error: 'zone not found' });
  }

  let sensorRules = null;
  let toolRules = null;
  try { sensorRules = zone.sensor_rules_json ? JSON.parse(zone.sensor_rules_json) : null; } catch {}
  try { toolRules = zone.tool_rules_json ? JSON.parse(zone.tool_rules_json) : null; } catch {}

  res.json({
    id: zone.id,
    org_id: zone.org_id,
    name: zone.name,
    polygon_geojson: zone.polygon_geojson,
    sensor_rules: sensorRules,
    tool_rules: toolRules,
    created_at: zone.created_at,
  });
});

// POST /api/v1/zones/check — phone GPS check endpoint
// Returns active zones + combined sensor rules for the given lat/lng.
// Phone calls this on every GPS update.
router.post('/check', (req, res) => {
  const orgId = req.org_id || PERSONAL_ORG_ID;
  const { lat, lng } = req.body;

  if (typeof lat !== 'number' || typeof lng !== 'number') {
    return res.status(400).json({ error: 'lat and lng (numbers) are required' });
  }

  const activeZones = getActiveZones(lat, lng, orgId);
  const combinedSensorRules = mergeSensorRules(activeZones);

  res.json({
    org_id: orgId,
    lat,
    lng,
    active_zones: activeZones.map(z => ({ id: z.id, name: z.name })),
    sensor_rules: combinedSensorRules,
    zone_count: activeZones.length,
  });
});

// POST /api/v1/zones/enforce — enforce sensor rules at zone boundaries
// Given lat/lng and device_id, applies zone sensor rules to sensor_toggles.
// Returns which sensors were forced on/off.
router.post('/enforce', (req, res) => {
  const orgId = req.org_id || PERSONAL_ORG_ID;
  const userId = req.user?.id || 1;
  const { lat, lng, device_id } = req.body;

  if (typeof lat !== 'number' || typeof lng !== 'number') {
    return res.status(400).json({ error: 'lat and lng (numbers) are required' });
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

  // Find active zones and merge their sensor rules
  const activeZones = getActiveZones(lat, lng, orgId);
  const combinedRules = mergeSensorRules(activeZones);

  const now = Date.now();
  const enforced = [];
  const cleared = [];

  // Get all sensors that currently have forced_by_org=1 for this user/device/org
  const currentForced = all(
    `SELECT sensor FROM sensor_toggles WHERE user_id = :uid AND device_id = :did AND org_id = :oid AND forced_by_org = 1`,
    { ':uid': userId, ':did': deviceId, ':oid': orgId }
  );
  const currentForcedSet = new Set(currentForced.map(r => r.sensor));

  // Apply zone rules — set forced_by_org=1 for forced sensors
  for (const [sensor, rule] of Object.entries(combinedRules)) {
    if (rule === 'forced_on' || rule === 'forced_off') {
      const enabledInt = rule === 'forced_on' ? 1 : 0;
      run(
        `INSERT INTO sensor_toggles (user_id, device_id, org_id, sensor, enabled, cadence_seconds, forced_by_org, updated_at)
         VALUES (:uid, :did, :oid, :sid, :en, NULL, 1, :now)
         ON CONFLICT(user_id, device_id, org_id, sensor)
         DO UPDATE SET enabled = :en, forced_by_org = 1, updated_at = :now`,
        {
          ':uid': userId, ':did': deviceId, ':oid': orgId,
          ':sid': sensor, ':en': enabledInt, ':now': now,
        }
      );
      enforced.push({ sensor, rule, enabled: !!enabledInt });
      currentForcedSet.delete(sensor); // still forced, don't clear
    } else {
      // "allowed" — clear any previous forced state for this sensor
      currentForcedSet.delete(sensor); // will be handled below if it was forced
    }
  }

  // Clear forced_by_org for sensors that were previously forced but are no longer
  // in any active zone (user left the zone)
  for (const sensor of currentForcedSet) {
    // Only clear if this sensor is NOT in the current combined rules as forced
    const currentRule = combinedRules[sensor];
    if (currentRule !== 'forced_on' && currentRule !== 'forced_off') {
      run(
        `UPDATE sensor_toggles SET forced_by_org = 0, updated_at = :now
         WHERE user_id = :uid AND device_id = :did AND org_id = :oid AND sensor = :sid AND forced_by_org = 1`,
        { ':uid': userId, ':did': deviceId, ':oid': orgId, ':sid': sensor, ':now': now }
      );
      cleared.push(sensor);
    }
  }

  // Audit the enforcement
  try {
    auditLog(req, 'zone.enforce', null, {
      lat, lng, device_id: deviceId,
      active_zones: activeZones.map(z => z.id),
      enforced: enforced.length,
      cleared: cleared.length,
    });
  } catch {}

  res.json({
    org_id: orgId,
    device_id: deviceId,
    lat, lng,
    active_zones: activeZones.map(z => ({ id: z.id, name: z.name })),
    enforced,
    cleared,
    zone_count: activeZones.length,
  });
});

export default router;
