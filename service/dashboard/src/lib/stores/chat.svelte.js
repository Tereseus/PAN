// chat.svelte.js — chat bubble transcripts (used by the left-column
// TranscriptPanel and the center column chat view) + the DM/Contacts thread
// state (active thread, messages, contact roster, add-contact modal,
// in-call state).
//
// `chat.bubbles` is the per-tab assistant/user transcript history surfaced
// as bubbles. It's separate from the foundation store's per-tab message
// map (`getPushed` / `pushEcho` / `pushBtw`) which holds the raw WS frames;
// this store holds the *rendered* bubble objects after `bubblesFromMessages`
// normalisation.
//
// 2026-05-28: expanded to also hold the entire Contacts panel state +
// loaders/mutators so ContactsPanel.svelte can be a pure consumer.

import { tick } from 'svelte';
import { api } from '$lib/api.js';

export const chat = $state({
	// ── Transcript bubbles (used by TranscriptPanel) ────────────────────────
	/** @type {Array<{type:'user'|'assistant'|'tool'|'stats', text?:string, speaker?:string, model?:string, multiSession?:boolean, accentColor?:string, tokens?:object}>} */
	bubbles: [],

	// ── DM / Contacts state ─────────────────────────────────────────────────
	/** Currently-open DM thread (null = contact list). */
	activeThread: null,
	/** Messages in the active thread. */
	messages: [],
	/** Contact roster (incl. the Π system contact). */
	contacts: [],
	/** All open threads (DM history). */
	threads: [],
	/** Search filter for the contacts list. */
	searchQuery: '',
	/** Unread total across all contacts (drives the dropdown badge). */
	unreadTotal: 0,
	/** Current text in the DM input box. */
	inputText: '',
	/** Active call state — null when not in a call. */
	callActive: null,

	// ── Add-contact modal ───────────────────────────────────────────────────
	addContactOpen: false,
	newContactName: '',
	newContactPanId: '',
	newContactPhone: '',
	newContactEmail: '',
});

// Scroll-container ref set by the component so loadChatMessages can pin scroll
// to bottom after a fetch. Components register it on mount.
let _messagesEl = null;
export function setChatMessagesEl(el) { _messagesEl = el; }

// ────────────────────────────────────────────────────────────────────────────
//  Loaders + mutators (used by ContactsPanel + the rare parent re-fetch)
// ────────────────────────────────────────────────────────────────────────────

export async function loadContacts() {
	try {
		const data = await api('/api/v1/chat/contacts');
		chat.contacts = Array.isArray(data) ? data : [];
		const unread = await api('/api/v1/chat/unread');
		chat.unreadTotal = unread?.unread || 0;
	} catch (e) {
		console.error('Failed to load contacts:', e);
	}
}

export async function loadChatThreads() {
	try {
		const data = await api('/api/v1/chat/threads');
		chat.threads = Array.isArray(data) ? data : [];
	} catch (e) {
		console.error('Failed to load threads:', e);
	}
}

export async function loadChatMessages(threadId) {
	try {
		const data = await api(`/api/v1/chat/threads/${threadId}/messages`);
		chat.messages = Array.isArray(data) ? data : [];
		await tick();
		if (_messagesEl) _messagesEl.scrollTop = _messagesEl.scrollHeight;
	} catch (e) {
		console.error('Failed to load messages:', e);
	}
}

/** Open a DM thread for the given contact + switch the center view to chat. */
export async function openChat(contact, switchCenterView) {
	try {
		const res = await api('/api/v1/chat/threads/dm', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ contact_id: contact.id })
		});
		chat.activeThread = { id: res.thread_id, contact, type: 'dm' };
		await loadChatMessages(res.thread_id);
		await api(`/api/v1/chat/threads/${res.thread_id}/read`, { method: 'POST' });
		loadContacts(); // refresh unread counts
		if (typeof switchCenterView === 'function') switchCenterView('chat');
	} catch (e) {
		console.error('Failed to open chat:', e);
	}
}

export async function sendChatMessage() {
	if (!chat.inputText.trim() || !chat.activeThread) return;
	const body = chat.inputText.trim();
	chat.inputText = '';
	const isPan = chat.activeThread.id === 'thread-pan-system';
	try {
		const res = await api(`/api/v1/chat/threads/${chat.activeThread.id}/messages`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ body })
		});
		chat.messages = [...chat.messages, {
			id: res.id, thread_id: chat.activeThread.id, sender_id: 'self',
			body, body_type: 'text', created_at: res.created_at
		}];
		await tick();
		if (_messagesEl) _messagesEl.scrollTop = _messagesEl.scrollHeight;

		// Π persona — server generates a reply; poll for it.
		if (isPan) {
			const sentAt = Date.now();
			let attempts = 0;
			const pollForReply = async () => {
				attempts++;
				try {
					const msgs = await api(`/api/v1/chat/threads/${chat.activeThread?.id}/messages`);
					if (Array.isArray(msgs)) {
						const hasNewReply = msgs.some(m => m.sender_id === 'contact-pan-system' && m.created_at >= sentAt);
						chat.messages = msgs;
						await tick();
						if (_messagesEl) _messagesEl.scrollTop = _messagesEl.scrollHeight;
						if (hasNewReply || attempts >= 8) return;
					}
				} catch {}
				if (attempts < 8) setTimeout(pollForReply, 2000);
			};
			setTimeout(pollForReply, 2000);
		}
	} catch (e) {
		console.error('Failed to send message:', e);
	}
}

export async function addContact() {
	if (!chat.newContactName.trim()) return;
	try {
		await api('/api/v1/chat/contacts', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				display_name: chat.newContactName.trim(),
				pan_instance_id: chat.newContactPanId.trim() || undefined,
				phone:           chat.newContactPhone.trim() || undefined,
				email:           chat.newContactEmail.trim() || undefined,
			})
		});
		chat.newContactName = '';
		chat.newContactPanId = '';
		chat.newContactPhone = '';
		chat.newContactEmail = '';
		chat.addContactOpen = false;
		loadContacts();
	} catch (e) {
		console.error('Failed to add contact:', e);
	}
}

export async function deleteContact(contactId) {
	try {
		await api(`/api/v1/chat/contacts/${contactId}`, { method: 'DELETE' });
		loadContacts();
	} catch (e) {
		console.error('Failed to delete contact:', e);
	}
}

export async function toggleFavorite(contact) {
	try {
		await api(`/api/v1/chat/contacts/${contact.id}`, {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ favorited: !contact.favorited })
		});
		loadContacts();
	} catch (e) {
		console.error('Failed to toggle favorite:', e);
	}
}

export async function startCall(threadId, type) {
	try {
		const res = await api('/api/v1/chat/calls/start', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ thread_id: threadId, type })
		});
		chat.callActive = { call_id: res.call_id, type, thread_id: threadId, status: 'ringing' };
	} catch (e) {
		console.error('Failed to start call:', e);
	}
}

export async function endCall() {
	if (!chat.callActive) return;
	try {
		await api(`/api/v1/chat/calls/${chat.callActive.call_id}/end`, { method: 'POST' });
		chat.callActive = null;
		if (chat.activeThread) loadChatMessages(chat.activeThread.id);
	} catch (e) {
		console.error('Failed to end call:', e);
	}
}

/** Restore the persisted bubble history (localStorage survives page refresh). */
export function restoreBubblesFromStorage() {
	try {
		const saved = localStorage.getItem('pan-chat-bubbles');
		if (saved) chat.bubbles = JSON.parse(saved);
	} catch {}
}

/** Persist the last 200 bubbles for refresh-survival. */
export function persistBubbles() {
	try {
		if (chat.bubbles.length > 0) {
			localStorage.setItem('pan-chat-bubbles', JSON.stringify(chat.bubbles.slice(-200)));
		}
	} catch {}
}
