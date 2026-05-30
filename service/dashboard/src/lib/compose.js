// compose.js — open the Compose UI in a Tauri popout window (falls back to
// a browser popup when Tauri isn't reachable). The actual compose interface
// runs at /v2/compose; this util just spawns the window with the right
// query string.

const TAURI_PORT = 7790;

export async function openCompose(contact = null, prefillSubject = '', prefillEmail = '') {
	const params = new URLSearchParams();
	if (contact) {
		params.set('contact', contact.id);
		params.set('name', contact.display_name);
		if (contact.email) params.set('email', contact.email);
	} else if (prefillEmail) {
		params.set('email', prefillEmail);
	}
	if (prefillSubject) params.set('subject', prefillSubject);

	const composeUrl = `${window.location.origin}/v2/compose?${params.toString()}`;

	try {
		// Try Tauri window first
		await fetch(`http://127.0.0.1:${TAURI_PORT}/open`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ url: composeUrl, title: 'Compose', width: 640, height: 520 })
		});
	} catch {
		// Fallback: browser popup
		window.open(composeUrl, '_blank', 'width=640,height=520');
	}
}

/**
 * Open the Comms expand window focused on the Π thread, passing ?call=1 so
 * the page starts a live voice session immediately. Goes through
 * /api/v1/popout (same-origin proxy) to dodge Tauri's CORS preflight bug;
 * falls back to window.open() if Tauri isn't running (e.g. dashboard opened
 * in a plain browser).
 */
export async function openPanCall() {
	const url = `${window.location.origin}/v2/comms?view=contacts&thread=thread-pan-system&call=1`;
	let opened = false;
	try {
		const r = await fetch('/api/v1/popout', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ url, title: 'Call Π', width: 720, height: 820 })
		});
		if (r.ok) opened = true;
	} catch {}
	if (!opened) window.open(url, '_blank', 'width=720,height=820');
}

/** Open a panel section (contacts/mail/calendar) in a same-origin Tauri popout. */
export async function openExpandedView(section) {
	const urls = {
		contacts: `${window.location.origin}/v2/comms?view=contacts`,
		mail:     `${window.location.origin}/v2/comms?view=mail`,
		calendar: `${window.location.origin}/v2/comms?view=calendar`,
	};
	const titles = { contacts: 'Contacts', mail: 'Mail', calendar: 'Calendar' };
	const url = urls[section];
	if (!url) return;

	let opened = false;
	try {
		const r = await fetch('/api/v1/popout', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ url, title: titles[section] || section, width: 900, height: 700 })
		});
		if (r.ok) opened = true;
	} catch {}
	if (!opened) window.open(url, '_blank', 'width=900,height=700');
}
