const API_BASE = window.location.origin;

// ── Stale-while-revalidate cache (PHASE 2) ───────────────────────────────────
//
// Why: every panel route fired `await api(path)` on mount and stared at a
// "Loading…" placeholder until the backend responded — even when the user
// had visited that same panel two seconds ago. Tab switching FELT slow even
// when the backend was fast because of the round-trip latency, and felt
// catastrophic when the backend was loaded (8+ second waits).
//
// Now: GET responses are cached in module scope. On every api() call:
//   - If a cached response exists AND is < SWR_TTL_MS old → return it
//     synchronously-equivalent (resolves on the next microtask). In parallel,
//     fire a background fetch to refresh the cache for the *next* caller.
//   - If no cache OR stale → behave like before, fetch + cache the response.
//
// Net effect for the user: the FIRST visit to a panel does a real round-trip
// (same as before). The SECOND and beyond visits in the same session render
// instantly, then quietly update if anything changed. Tab cycling becomes
// snappy regardless of backend pressure.
//
// Trade-offs:
//   - GET only. Mutations (POST/PUT/DELETE) are never cached and they
//     INVALIDATE their target path's cache on success so subsequent reads
//     see fresh state.
//   - Module scope, so the cache lives for the lifetime of the page load
//     (cleared on full refresh). Good enough for tab-cycling; not enough for
//     "open the dashboard for the first time" speed — that needs Phase 3
//     (WebSocket push) or a service-worker / persistent cache layer.
//   - Cache is keyed by method + path + serialized body (first 200 chars).
//     Two callers with identical inputs share the same cache slot.
const _apiCache = new Map(); // key -> { data, ts }
const _CACHE_MAX = 120;
const SWR_TTL_MS = 30_000;

function _cacheKey(path, options) {
	const method = options?.method || 'GET';
	const body = options?.body ? String(options.body).slice(0, 200) : '';
	return `${method}:${path}:${body}`;
}

function _writeCache(key, data) {
	_apiCache.set(key, { data, ts: Date.now() });
	if (_apiCache.size > _CACHE_MAX) {
		// Simple FIFO eviction — drop oldest insert.
		const firstKey = _apiCache.keys().next().value;
		_apiCache.delete(firstKey);
	}
}

function _invalidatePathPrefix(path) {
	// Used after mutating calls (POST/PUT/DELETE) so subsequent reads to the
	// same resource family see fresh state. Matches any cached GET whose
	// path is exactly path OR starts with path + '/' (so a POST to
	// /dashboard/api/projects also invalidates /dashboard/api/projects/123/tasks).
	for (const key of _apiCache.keys()) {
		const match = key.match(/^GET:([^:]+):/);
		if (!match) continue;
		const cachedPath = match[1];
		if (cachedPath === path || cachedPath.startsWith(path + '/')) {
			_apiCache.delete(key);
		}
	}
}

// Read a cached value without firing any fetch. Useful for components that
// want to render last-known data instantly even outside the api() flow.
export function getCached(path, options = {}) {
	const entry = _apiCache.get(_cacheKey(path, options));
	return entry ? entry.data : null;
}

// Prefetch a list of GET paths into the cache. Fire-and-forget — call this
// from the root layout on dashboard mount to warm the cache for the panels
// the user is most likely to click. Errors are swallowed; the regular api()
// call on actual mount will retry normally if a prefetch failed.
//
// Pattern: pass the *first-screen* panel endpoints so tab cycling within
// the first 30 seconds (the SWR TTL) is instant.
export function prefetch(paths) {
	if (!Array.isArray(paths)) paths = [paths];
	for (const path of paths) {
		api(path).catch(() => {});
	}
}

// ── /ws/panels subscriber (PHASE 3) ──────────────────────────────────────────
//
// Long-lived WebSocket to the server-side panel-broadcaster. Every push
// message we receive becomes a cache entry, exactly as if the user had
// just called api(path). Result: panel-route mounts find their data
// already sitting in the SWR cache and render instantly without any
// network round-trip. Live updates keep the cache fresh every 10-60s
// depending on the topic, so even the "first visit" after the dashboard
// has been open ≥10s is instant.
//
// Reconnect on close with exponential backoff capped at 30s. Backgrounded
// tabs sometimes drop the WS; the next visibility-change rewires it.
let _panelWs = null;
let _panelReconnectMs = 1000;
const _PANEL_RECONNECT_CAP_MS = 30_000;
let _panelReconnectTimer = null;

function _wsScheme() {
	return window.location.protocol === 'https:' ? 'wss:' : 'ws:';
}

function _connectPanelStream() {
	if (_panelWs) return;
	try {
		const url = `${_wsScheme()}//${window.location.host}/ws/panels`;
		const ws = new WebSocket(url);
		_panelWs = ws;
		ws.addEventListener('open', () => {
			_panelReconnectMs = 1000;
		});
		ws.addEventListener('message', (ev) => {
			try {
				const msg = JSON.parse(ev.data);
				if (msg?.type === 'panel_update' && msg.path && msg.data !== undefined) {
					_writeCache(_cacheKey(msg.path, {}), msg.data);
				}
			} catch {}
		});
		ws.addEventListener('close', () => {
			_panelWs = null;
			if (_panelReconnectTimer) clearTimeout(_panelReconnectTimer);
			_panelReconnectTimer = setTimeout(_connectPanelStream, _panelReconnectMs);
			_panelReconnectMs = Math.min(_panelReconnectMs * 2, _PANEL_RECONNECT_CAP_MS);
		});
		ws.addEventListener('error', () => { /* close handler will fire and retry */ });
	} catch {
		_panelReconnectTimer = setTimeout(_connectPanelStream, _panelReconnectMs);
		_panelReconnectMs = Math.min(_panelReconnectMs * 2, _PANEL_RECONNECT_CAP_MS);
	}
}

export function startPanelStream() {
	if (typeof window === 'undefined') return;
	_connectPanelStream();
	// Tab returning to foreground after sleep often has a dead WS — eager
	// reconnect on visibility change so the cache starts updating again
	// before the user starts clicking around.
	document.addEventListener('visibilitychange', () => {
		if (!document.hidden && !_panelWs) _connectPanelStream();
	});
}

// Force-drop everything (or one path family). Useful after explicit user
// "refresh" actions or settings changes that invalidate broad cache state.
export function invalidateCache(pathPrefix = null) {
	if (!pathPrefix) {
		_apiCache.clear();
		return;
	}
	_invalidatePathPrefix(pathPrefix);
}

async function _doFetch(path, options) {
	const token = localStorage.getItem('pan_token');
	const headers = {
		'Content-Type': 'application/json',
		...options.headers
	};
	if (token) headers['Authorization'] = `Bearer ${token}`;
	const signal = options.signal ?? AbortSignal.timeout(10000);
	const res = await fetch(`${API_BASE}${path}`, { ...options, headers, signal });
	if (res.status === 401) localStorage.removeItem('pan_token');
	if (!res.ok) {
		let detail = '';
		try { const body = await res.json(); detail = body.error || ''; } catch {}
		throw new Error(detail || `API ${path}: ${res.status}`);
	}
	return res.json();
}

/**
 * Fetch wrapper that handles auth tokens, JSON, and SWR caching.
 * Looks for a token in localStorage under 'pan_token'.
 *
 * Pass `options.noCache: true` to bypass the cache entirely (e.g. for
 * always-fresh polling endpoints like /api/v1/perf/trace).
 */
export async function api(path, options = {}) {
	const method = options.method || 'GET';
	const isGet = method === 'GET';
	const wantCache = isGet && !options.noCache;

	if (wantCache) {
		const key = _cacheKey(path, options);
		const cached = _apiCache.get(key);
		if (cached && (Date.now() - cached.ts < SWR_TTL_MS)) {
			// Stale-while-revalidate: return cached now, refresh in background.
			// We swallow errors on the background fetch — the cache simply
			// won't update; the next caller will retry on its own schedule.
			_doFetch(path, options)
				.then((fresh) => _writeCache(key, fresh))
				.catch(() => {});
			return cached.data;
		}
	}

	const data = await _doFetch(path, options);

	if (wantCache) {
		_writeCache(_cacheKey(path, options), data);
	} else if (!isGet) {
		// Mutation — invalidate any cached GETs that this might have changed.
		// Strip query string for the invalidation key since GET caches are
		// keyed by full path including query.
		const cleanPath = path.split('?')[0];
		_invalidatePathPrefix(cleanPath);
	}

	return data;
}

/**
 * Build a WebSocket URL from a path.
 */
export function wsUrl(path) {
	const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
	return `${proto}//${window.location.host}${path}`;
}

/**
 * Escape HTML entities for safe rendering.
 */
export function escapeHtml(str) {
	if (!str) return '';
	return str
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}
