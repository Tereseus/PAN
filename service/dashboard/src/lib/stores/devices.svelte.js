// devices.svelte.js — full device roster + pan-client list + live resource
// metrics. Shared between DevicesPanel (filter bar + rows) and AppsPanel
// (device-first app grid) so they read the same source.
//
// Two layers:
//   allDevices       — every registered device (computers/phones/pendants)
//   panClientDevices — devices running pan-client, has `trusted` for approval flow
//   deviceMetrics    — { [hostname]: { cpu_pct, ram_pct, disk_pct, ... } }

import { api } from '$lib/api.js';

export const devices = $state({
	/** @type {Array<any>} */
	all: [],
	/** @type {Array<{device_id, name, platform, trusted, ...}>} */
	panClients: [],
	/** @type {Record<string, {cpu_pct?:number, ram_pct?:number, disk_pct?:number, ram_used_mb?:number, ram_total_mb?:number, disk_free_gb?:number}>} */
	metrics: {},
});

let _allDevicesPollTimer = null;
let _panClientPollTimer = null;

export async function loadAllDevices() {
	try {
		const d = await api('/dashboard/api/devices');
		devices.all = Array.isArray(d) ? d : (d.devices || []);
	} catch {}
	try {
		const m = await api('/api/v1/client/metrics');
		const map = {};
		for (const row of (m.metrics || [])) map[row.device_id] = row;
		devices.metrics = map;
	} catch {}
}

export function startAllDevicesPolling() {
	loadAllDevices();
	if (_allDevicesPollTimer) clearInterval(_allDevicesPollTimer);
	// 30s fallback — `widget_update: 'devices'` WS push handles real-time changes
	_allDevicesPollTimer = setInterval(loadAllDevices, 30_000);
}

export function stopAllDevicesPolling() {
	if (_allDevicesPollTimer) { clearInterval(_allDevicesPollTimer); _allDevicesPollTimer = null; }
}

export async function loadClientDevices() {
	try {
		const resp = await fetch('/api/v1/client/devices');
		if (resp.ok) {
			const d = await resp.json();
			devices.panClients = d.devices || [];
			// Tighter poll while there's a pending approval (8s) — fallback only,
			// WS `widget_update:'devices'` is the primary real-time path.
			const hasPending = devices.panClients.some(dev => dev.trusted === false);
			const targetInterval = hasPending ? 8000 : 30_000;
			if (!_panClientPollTimer) {
				_panClientPollTimer = setInterval(loadClientDevices, targetInterval);
			}
		}
	} catch {}
}

export async function approveClient(deviceId) {
	await fetch(`/api/v1/client/${encodeURIComponent(deviceId)}/approve`, { method: 'POST' });
	await loadClientDevices();
	await loadAllDevices();
}

export async function denyClient(deviceId) {
	await fetch(`/api/v1/client/${encodeURIComponent(deviceId)}/deny`, { method: 'POST' });
	await loadClientDevices();
	await loadAllDevices();
}
