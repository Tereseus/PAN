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

	const res = await fetch(`${API_BASE}${path}`, {
		...options,
		headers
	});

	if (res.status === 401) {
		// Token expired or invalid — clear it
		localStorage.removeItem('pan_token');
	}

	if (!res.ok) {
		throw new Error(`API ${path}: ${res.status}`);
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
