// perf.svelte.js — every dashboard perf observation in one place.
//
// Three kinds of state live here:
//   1. Live counters the parent updates from many places (load timings,
//      send timings, widget-health tracker, WS message-rate counter).
//      Parent calls the exported markLoad / markSend / markSendPhase /
//      trackWidget / trackWsMsg from its existing 27+ call sites.
//   2. Polled state from the carrier perf engine (perfData, perfTrace,
//      perfServer, perfProcesses, perfServices, perfOther). The loaders
//      live here too — startPerfPolling kicks a 5s interval.
//   3. UI state for the Performance panel itself (panelView toggle).
//
// All of it is read by PerfPanel.svelte. Lifted from terminal/+page.svelte
// during the Shape-2 refactor.

import { api } from '$lib/api.js';

const _loadT0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : 0;

// ────────────────────────────────────────────────────────────────────────────
//  The store
// ────────────────────────────────────────────────────────────────────────────

export const perf = $state({
	// ── Page-load timings (ms since navigation start) ───────────────────────
	loadTimings: {
		scriptInit:       0,
		mounted:          0,
		wsOpen:           0,
		ptyAttached:      0,
		firstScreen:      0,
		firstTranscript:  0,
		transcriptWidget: 0,
		usageWidget:      0,
		interactive:      0,
	},
	// ── Send timings (ms from keystroke → server ack → WS echo → assistant) ─
	sendTimings: {
		lastSendAt: 0,
		lastAckMs: 0,
		lastEchoMs: 0,
		lastAssistantMs: 0,
		lastSendText: '',
		awaitingAssistant: false,
	},
	// ── Widget health (what's pushing vs polling, when last refreshed) ──────
	widgetHealth: {
		intuition:  { ts: 0, source: null, pushes: 0, polls: 0 },
		approvals:  { ts: 0, source: null, pushes: 0, polls: 0 },
		alerts:     { ts: 0, source: null, pushes: 0, polls: 0 },
		services:   { ts: 0, source: null, pushes: 0, polls: 0 },
		pipeline:   { ts: 0, source: null, pushes: 0, polls: 0 },
		devices:    { ts: 0, source: null, pushes: 0, polls: 0 },
		transcript: { ts: 0, source: null, pushes: 0, polls: 0 },
		lifeboat:   { ts: 0, source: null, pushes: 0, polls: 0 },
	},
	// ── WS message-type counter ─────────────────────────────────────────────
	wsMsgCounts: {},
	wsTotalMsgs: 0,
	wsLastMsgTs: 0,

	// ── Carrier perf data + processes ───────────────────────────────────────
	data: { wsLatency: 0, domTime: 0, linesChanged: 0, serverRender: 0, serverTotal: 0, msgSize: 0, fps: 0 },
	processes: [],
	services: [],
	other: [],
	server: { heap_mb: 0, rss_mb: 0, avg_ms: 0, total_requests: 0, slow_requests: 0, ws_connections: 0, uptime_s: 0, top_routes: [] },

	// ── Carrier perf trace (probe-driven DAG, see service/src/perf/stages.js) ─
	trace: {
		now: 0, engine_started_at: 0,
		system_ready: false, interactive_ready: false,
		swap_safe: { safe: false, reason: '' },
		critical_path_ms: 0,
		counts: { ready: 0, pending: 0, running: 0, failed: 0, total: 0 },
		stages: [],
	},
	traceLoadedOnce: false,

	// ── UI: which view of the Perf panel is showing ─────────────────────────
	panelView: (typeof window !== 'undefined' && localStorage.getItem('pan_perf_view')) || 'list',
});

/** Persist `panelView` to localStorage. Call from a component's $effect. */
export function persistPanelView() {
	if (typeof window !== 'undefined') {
		try { localStorage.setItem('pan_perf_view', perf.panelView); } catch {}
	}
}

// ────────────────────────────────────────────────────────────────────────────
//  Constants exported for the panel template
// ────────────────────────────────────────────────────────────────────────────

export const STAGE_LABELS = {
	scriptInit:       { name: 'Script parsed',        warn: 300,  bad: 1000, help: 'Browser downloaded + parsed the JS bundle.' },
	mounted:          { name: 'Page mounted',         warn: 600,  bad: 1500, help: 'Svelte built the DOM tree. You see the layout.' },
	wsOpen:           { name: 'WebSocket connected',  warn: 800,  bad: 2000, help: 'Handshake with server done. Terminal can send keys.' },
	ptyAttached:      { name: 'PTY attached',         warn: 1200, bad: 3000, help: 'Server confirmed a live terminal session is ready.' },
	firstScreen:      { name: 'Terminal painted',     warn: 1800, bad: 4000, help: 'First bytes of terminal output rendered on screen.' },
	firstTranscript:  { name: 'Transcript loaded',    warn: 2000, bad: 5000, help: 'JSONL transcript for this session arrived via WS.' },
	transcriptWidget: { name: 'Left panel ready',     warn: 2000, bad: 5000, help: 'Left transcript panel rendered its first message.' },
	usageWidget:      { name: 'Usage widget ready',   warn: 2500, bad: 6000, help: 'Usage/cost data fetched + rendered.' },
	interactive:      { name: 'Interactive',          warn: 2500, bad: 6000, help: 'Everything loaded. Keystrokes hit the PTY instantly.' },
};
export const LOAD_STAGE_ORDER = [
	'scriptInit', 'mounted', 'wsOpen', 'ptyAttached',
	'firstScreen', 'firstTranscript', 'transcriptWidget', 'usageWidget', 'interactive',
];

export const PERF_PHASE_LABELS = {
	boot: 'Boot', attach: 'Attach', service: 'Services', widget: 'Widgets', hot_path: 'Hot path',
};
export const PERF_PHASE_ORDER = ['boot', 'attach', 'service', 'hot_path', 'widget'];

export function fmtMs(ms) {
	if (!ms) return '—';
	if (ms < 1000) return ms + 'ms';
	return (ms / 1000).toFixed(2) + 's';
}

// ────────────────────────────────────────────────────────────────────────────
//  Live counter mutators (called from +page.svelte's many existing sites)
// ────────────────────────────────────────────────────────────────────────────

export function markLoad(key) {
	if (!perf.loadTimings[key]) {
		perf.loadTimings[key] = Math.round(((typeof performance !== 'undefined' && performance.now) ? performance.now() : 0) - _loadT0);
	}
}

export function markSend(text) {
	perf.sendTimings.lastSendAt = (typeof performance !== 'undefined' && performance.now) ? performance.now() : 0;
	perf.sendTimings.lastAckMs = 0;
	perf.sendTimings.lastEchoMs = 0;
	perf.sendTimings.lastAssistantMs = 0;
	perf.sendTimings.lastSendText = (text || '').slice(0, 40);
	perf.sendTimings.awaitingAssistant = true;
}

export function markSendPhase(key) {
	if (!perf.sendTimings.lastSendAt) return;
	const dt = Math.round(((typeof performance !== 'undefined' && performance.now) ? performance.now() : 0) - perf.sendTimings.lastSendAt);
	if (key === 'ack' && !perf.sendTimings.lastAckMs) {
		perf.sendTimings.lastAckMs = dt;
		postPerfEvent('sendAck', dt);
	}
	if (key === 'echo' && !perf.sendTimings.lastEchoMs) {
		perf.sendTimings.lastEchoMs = dt;
		postPerfEvent('sendEcho', dt);
	}
	if (key === 'assistant' && !perf.sendTimings.lastAssistantMs) {
		perf.sendTimings.lastAssistantMs = dt;
		perf.sendTimings.awaitingAssistant = false;
		postPerfEvent('sendAssistant', dt);
	}
}

export function trackWidget(name, source) {
	const w = perf.widgetHealth[name];
	if (!w) return;
	w.ts = Date.now();
	w.source = source;
	if (source === 'push') w.pushes++; else w.polls++;
}

export function trackWsMsg(type) {
	perf.wsMsgCounts[type] = (perf.wsMsgCounts[type] || 0) + 1;
	perf.wsTotalMsgs++;
	perf.wsLastMsgTs = Date.now();
}

// ────────────────────────────────────────────────────────────────────────────
//  Carrier perf engine — loaders + polling
// ────────────────────────────────────────────────────────────────────────────

export async function loadPerfTrace() {
	try {
		const r = await fetch('/api/v1/perf/trace', { cache: 'no-store' });
		if (!r.ok) return;
		const j = await r.json();
		if (j && Array.isArray(j.stages)) {
			perf.trace = j;
			perf.traceLoadedOnce = true;
		}
	} catch {}
}

export async function forceProbeStage(stageId) {
	try {
		await fetch('/api/v1/perf/probe/' + encodeURIComponent(stageId), { method: 'POST', cache: 'no-store' });
		setTimeout(loadPerfTrace, 200);
	} catch {}
}

export function postPerfEvent(name, ms) {
	try {
		fetch('/api/v1/perf/event', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ name, ms }),
			cache: 'no-store',
		}).catch(() => {});
	} catch {}
}

export async function loadPerfProcesses() {
	try {
		const [procData, serverData] = await Promise.all([
			api('/dashboard/api/processes').catch(() => null),
			api('/dashboard/api/perf').catch(() => null),
		]);
		if (procData?.services) {
			perf.services = procData.services;
			perf.other    = procData.other     || [];
			perf.processes = procData.processes || [];
		} else if (procData?.processes) {
			perf.processes = procData.processes;
		}
		if (serverData) perf.server = serverData;
	} catch {}
}

let _processTimer = null;
let _traceTimer = null;

export function startPerfPolling() {
	if (_processTimer) return;
	loadPerfProcesses();
	loadPerfTrace();
	_processTimer = setInterval(() => {
		loadPerfProcesses();
		loadPerfTrace();
	}, 5000);
}

export function stopPerfPolling() {
	if (_processTimer) { clearInterval(_processTimer); _processTimer = null; }
	if (_traceTimer)   { clearInterval(_traceTimer);   _traceTimer   = null; }
}

export async function killProcess(pid) {
	try {
		await api('/dashboard/api/processes/kill', {
			method: 'POST',
			body: JSON.stringify({ pid }),
			headers: { 'Content-Type': 'application/json' },
		});
		setTimeout(loadPerfProcesses, 500);
	} catch {}
}

// Auto-mark scriptInit as soon as this module loads (parent had `_markLoad('scriptInit')` right after the helper definition).
markLoad('scriptInit');
