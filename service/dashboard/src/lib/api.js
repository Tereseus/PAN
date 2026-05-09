const API_BASE = window.location.origin;

/**
 * Fetch wrapper that handles auth tokens and JSON.
 * Looks for a token in localStorage under 'pan_token'.
 */
export async function api(path, options = {}) {
	const token = localStorage.getItem('pan_token');
	const headers = {
		'Content-Type': 'application/json',
		...options.headers
	};
	if (token) {
		headers['Authorization'] = `Bearer ${token}`;
	}

	// Default 10s timeout — prevents hung fetches from freezing the UI (e.g. stale TCP
	// connections after sleep/wake). Callers can override by passing signal in options.
	const signal = options.signal ?? AbortSignal.timeout(10000);

	const res = await fetch(`${API_BASE}${path}`, {
		...options,
		headers,
		signal,
	});

	if (res.status === 401) {
		// Token expired or invalid — clear it
		localStorage.removeItem('pan_token');
	}

	if (!res.ok) {
		let detail = '';
		try { const body = await res.json(); detail = body.error || ''; } catch {}
		throw new Error(detail || `API ${path}: ${res.status}`);
	}

	return res.json();
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
