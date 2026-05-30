// atlas.svelte.js — animated SVG orrery view of the PAN system. Shown when
// `centerView === 'atlas'` in the dashboard. Owns the planet/moon/device
// graph, the pan/zoom transform, the hover/select state, the time-elapsed
// counter that drives the orbital animation, and the periodic refetch
// timer that keeps node statuses fresh.
//
// Lifted from terminal/+page.svelte during the Shape-2 refactor.

import { api } from '$lib/api.js';

export const atlas = $state({
	/** @type {{planets:Array, projs:Array, devNodes:Array, stats:object, CX:number, CY:number, ss:Function, sd:Function, rv:Function, COLORS:object, am:object}|null} */
	data: null,
	loading: false,
	/** Pan + zoom. SVG group is `translate(x,y) scale(scale)`. */
	transform: { x: 0, y: 0, scale: 1 },
	dragging: false,
	dragStart: { x: 0, y: 0 },
	/** Node id currently under the pointer. */
	hovered: null,
	/** Node id currently clicked (drives detail panel). */
	selected: null,
	/** Seconds since animation start — drives planet orbital positions. */
	elapsed: 0,
});

// Module-level timers — not reactive, just lifecycle handles.
let _refreshTimer = null;
let _animTimer = null;
let _animT0 = 0;

// ────────────────────────────────────────────────────────────────────────────
//  Loader + graph builder
// ────────────────────────────────────────────────────────────────────────────

export async function loadAtlasData() {
	atlas.loading = !atlas.data;
	try {
		const [svcResp, atlasResp, statsResp, projResp] = await Promise.all([
			api('/dashboard/api/services'),
			api('/api/v1/atlas/services'),
			api('/dashboard/api/stats'),
			api('/dashboard/api/projects'),
		]);
		atlas.data = buildAtlasGraph(svcResp, atlasResp, statsResp, projResp);
	} catch (e) {
		console.error('Atlas load failed:', e);
	}
	atlas.loading = false;
	if (!_refreshTimer) _refreshTimer = setInterval(loadAtlasData, 30000);
	// Start animation loop
	if (!_animTimer) {
		_animT0 = Date.now();
		_animTimer = setInterval(() => { atlas.elapsed = (Date.now() - _animT0) / 1000; }, 50);
	}
}

/** Stop the refresh + animation timers (component unmount). */
export function stopAtlasTimers() {
	if (_refreshTimer) { clearInterval(_refreshTimer); _refreshTimer = null; }
	if (_animTimer) { clearInterval(_animTimer); _animTimer = null; }
}

function buildAtlasGraph(svcResp, atlasResp, statsResp, projResp) {
	const atlasSvcs = atlasResp?.services || [];
	const am = Object.fromEntries(atlasSvcs.map(s => [s.id, s]));
	const projs = projResp || [];

	function ss(id) {
		const s = am[id];
		if (!s) return 'unknown';
		if (s.status === 'running') return 'up';
		if (s.status === 'stopped') return 'idle';
		return (s.status === 'down' || s.status === 'error') ? 'down' : 'unknown';
	}
	function sd(id) {
		const s = am[id]; if (!s) return '';
		const p = [];
		if (s.port) p.push(`Port ${s.port}`);
		if (s.interval) p.push(`Every ${s.interval}`);
		if (s.lastRun) {
			const a = Math.round((Date.now() - s.lastRun) / 60000);
			p.push(a < 60 ? `${a}m ago` : `${Math.round(a / 60)}h ago`);
		}
		return p.join(' · ') || s.status;
	}
	function rv(id) {
		switch (id) {
			case 'pan-server': return statsResp ? `${(statsResp.total_events / 1000).toFixed(1)}K events` : null;
			case 'database':   return statsResp ? `${(statsResp.db_size_bytes / 1048576).toFixed(0)}MB` : null;
			case 'embeddings': return '1024D';
			case 'memory-hub': return statsResp ? `${(statsResp.total_memory || 0) / 1000 | 0}K mem` : null;
			default: {
				const s = am[id];
				return s?.lastRun
					? (() => { const m = Math.round((Date.now() - s.lastRun) / 60000); return m < 1 ? 'Just Now' : m < 60 ? `${m}m ago` : `${Math.round(m / 60)}h ago`; })()
					: null;
			}
		}
	}

	const PLANETS = [
		{ id: 'database',   label: 'Vault',    type: 'data',    orbitR: 190, baseAngle:  45, orbitSpeed:  0.28, moonR:  0, moonSpeed:    0, moons: [] },
		{ id: 'steward',    label: 'Steward',  type: 'service', orbitR: 380, baseAngle: 200, orbitSpeed: -0.13, moonR: 90, moonSpeed:  0.32, moons: [
			{ id: 'whisper',    label: 'Listener', type: 'service', baseAngle:   0 },
			{ id: 'ahk',        label: 'Hotkeys',  type: 'service', baseAngle:  90 },
			{ id: 'ollama',     label: 'Oracle',   type: 'service', baseAngle: 180 },
			{ id: 'tailscale',  label: 'Tether',   type: 'service', baseAngle: 270 },
		] },
		{ id: 'memory-hub', label: 'Memoria',  type: 'memory',  orbitR: 570, baseAngle: 110, orbitSpeed:  0.09, moonR: 95, moonSpeed: -0.27, moons: [
			{ id: 'mem-episodic',   label: 'Episodes',  type: 'memory', baseAngle:   0 },
			{ id: 'mem-semantic',   label: 'Knowledge', type: 'memory', baseAngle:  72 },
			{ id: 'mem-procedural', label: 'Habits',    type: 'memory', baseAngle: 144 },
			{ id: 'embeddings',     label: 'Resonance', type: 'memory', baseAngle: 216 },
			{ id: 'inject-ctx',     label: 'Injector',  type: 'memory', baseAngle: 288 },
		] },
		{ id: 'dream-cycle', label: 'Dream',   type: 'process', orbitR: 760, baseAngle: 300, orbitSpeed: -0.07, moonR: 95, moonSpeed:  0.23, moons: [
			{ id: 'classifier',    label: 'Augur',     type: 'process', baseAngle:   0 },
			{ id: 'consolidation', label: 'Archivist', type: 'process', baseAngle:  90 },
			{ id: 'evolution',     label: 'Evolution', type: 'process', baseAngle: 180 },
		] },
		{ id: 'autodev',     label: 'Forge',   type: 'ai',      orbitR: 960, baseAngle: 160, orbitSpeed:  0.05, moonR: 95, moonSpeed: -0.18, moons: [
			{ id: 'claude',       label: 'Nexus',        type: 'ai', baseAngle:   0 },
			{ id: 'orchestrator', label: 'Orchestrator', type: 'ai', baseAngle: 120 },
			{ id: 'scout',        label: 'Scout',        type: 'ai', baseAngle: 240 },
		] },
	];

	const COLORS = { core: '#89b4fa', data: '#fab387', service: '#a6e3a1', memory: '#cba6f7', process: '#f9e2af', ai: '#f38ba8', device: '#89dceb', project: '#94e2d5' };

	const projs3 = projs.slice(0, 3).map((p, i) => ({
		id: `proj-${p.id}`, label: p.name, type: 'project', baseAngle: i * 120 + 30,
	}));

	const dashSvcs = svcResp?.services || [];
	const devices = [...new Map(dashSvcs.filter(s => s.category === 'Devices').map(d => [d.name, d])).values()].slice(0, 4);
	const devNodes = devices.map((d, i) => ({ id: `dev-${d.name}`, label: d.name, type: 'device', baseAngle: i * 90, status: d.status === 'up' ? 'up' : 'unknown' }));

	return { planets: PLANETS, projs: projs3, devNodes, stats: statsResp, CX: 1150, CY: 800, ss, sd, rv, COLORS, am };
}

// ────────────────────────────────────────────────────────────────────────────
//  Display helpers
// ────────────────────────────────────────────────────────────────────────────

export function atlasNodeColor(type) {
	const c = { core: '#89b4fa', data: '#fab387', service: '#a6e3a1', memory: '#cba6f7', process: '#f9e2af', ai: '#f38ba8', device: '#89dceb', project: '#94e2d5' };
	return c[type] || '#6c7086';
}

export function atlasStatusDot(status) {
	if (status === 'up') return '#a6e3a1';
	if (status === 'down') return '#f38ba8';
	if (status === 'warn') return '#f9e2af';
	return '#6c7086';
}

// ────────────────────────────────────────────────────────────────────────────
//  Pan / zoom interaction handlers
// ────────────────────────────────────────────────────────────────────────────

export function handleAtlasWheel(e) {
	e.preventDefault();
	const delta = e.deltaY > 0 ? 0.9 : 1.1;
	const newScale = Math.max(0.3, Math.min(3, atlas.transform.scale * delta));
	atlas.transform = { ...atlas.transform, scale: newScale };
}

export function handleAtlasPointerDown(e) {
	if (e.target.closest('.atlas-node')) return;
	atlas.dragging = true;
	atlas.dragStart = { x: e.clientX - atlas.transform.x, y: e.clientY - atlas.transform.y };
}

export function handleAtlasPointerMove(e) {
	if (!atlas.dragging) return;
	atlas.transform = { ...atlas.transform, x: e.clientX - atlas.dragStart.x, y: e.clientY - atlas.dragStart.y };
}

export function handleAtlasPointerUp() {
	atlas.dragging = false;
}

export function atlasResetView() {
	atlas.transform = { x: 0, y: 0, scale: 1 };
}
