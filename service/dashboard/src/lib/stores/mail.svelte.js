// mail.svelte.js — inbox view (Mail panel). Wraps PAN's email integration
// endpoints (`/api/v1/chat/mail`, `/api/v1/email/{status,sync}`).
//
// `mail.status` is the connect/config gate (drives the small status pill at
// the top of the inbox view). `mail.messages` is the current page of
// messages; `mail.page` / `mail.total` paginate.

import { api } from '$lib/api.js';

export const mail = $state({
	/** @type {Array<{id, from?, to?, subject?, preview?, date, direction, channel, read}>} */
	messages: [],
	loading: false,
	total: 0,
	page: 0,
	/** @type {{connected:boolean, configured:boolean, user?:string}|null} */
	status: null,
});

export async function loadMail(page = 0) {
	mail.loading = true;
	try {
		const data = await api(`/api/v1/chat/mail?limit=50&offset=${page * 50}`);
		mail.messages = Array.isArray(data?.messages) ? data.messages : [];
		mail.total = data?.total || mail.messages.length;
		mail.page = page;
	} catch (e) {
		console.error('Failed to load mail:', e);
		mail.messages = [];
	}
	mail.loading = false;
}

export async function loadMailStatus() {
	try {
		mail.status = await api('/api/v1/email/status');
	} catch (e) {
		mail.status = { connected: false, configured: false };
	}
}

export async function syncMail() {
	mail.loading = true;
	try {
		await api('/api/v1/email/sync', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ folder: 'INBOX' })
		});
		await loadMail(0);
	} catch (e) {
		console.error('Failed to sync mail:', e);
	}
	mail.loading = false;
}

/** Date formatter used by the inbox row's right-side timestamp. */
export function formatMailDate(dateStr) {
	if (!dateStr) return '';
	const d = new Date(dateStr);
	const now = new Date();
	const isToday = d.toDateString() === now.toDateString();
	if (isToday) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
	const isThisYear = d.getFullYear() === now.getFullYear();
	if (isThisYear) return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
	return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
}
