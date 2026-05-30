// Terminal page — shared reactive state used across all extracted components.
// Lives at the module level using Svelte 5 runes so any component on the
// terminal page can read/write via plain property access:
//
//     import { terminal } from '$lib/stores-terminal.svelte.js';
//     terminal.tabs;          // read
//     terminal.tabs.push(t);  // write — reactive
//
// This file is the SINGLE source of truth for state that crosses panel
// boundaries (tabs strip, terminal column, transcript column, intuition column,
// perf panel). Anything purely internal to one panel should NOT live here —
// keep it inside the component file. If you find yourself adding state here
// for one widget, ask whether it really belongs in that widget's component.
//
// Created 2026-05-27 as foundation for Shape-2 monolith breakup.

// ────────────────────────────────────────────────────────────────────────────
//  Top-level reactive state — everything is on this one object.
// ────────────────────────────────────────────────────────────────────────────

export const terminal = $state({
	// ── Tabs & projects ─────────────────────────────────────────────────────
	/** @type {any[]} live tab objects (open tabs) */
	tabs: [],
	/** @type {string|null} current active tab id */
	activeTabId: null,
	/** @type {any[]} every tab for the active project (incl. closed) */
	allProjectTabs: [],
	/** @type {boolean} true until auto-restore finishes; blocks manual project select */
	restoringTabs: true,
	/** @type {any[]} all projects from /dashboard/api/projects */
	projects: [],

	// ── Connection lifecycle (canonical WebSocket) ──────────────────────────
	/** @type {WebSocket|null} the one WS connection for this page */
	ws: null,
	/** 'connecting' | 'open' | 'closed' | 'error' */
	wsState: 'closed',
	/** ms — last successful WS ping round-trip */
	wsLatencyMs: 0,
	/** epoch ms of last WS message of any kind */
	wsLastMsgAt: 0,

	// ── PTY / Claude status (source of truth for "is it thinking?") ─────────
	/** @type {boolean} false while LLM is processing, true when waiting for user */
	claudeReady: false,
	/** @type {{pid:number, thinking:boolean, lastInputTs:number, lastOutputTs:number, clients:number, createdAt:number}|null}
	 *  Live PTY status — polled from /api/v1/terminal/sessions every 2s. */
	ptyStatus: null,
	/** ticks every 1s for live duration display in the status bar */
	ptyStatusNow: Date.now(),
	/** messages sent but not yet confirmed in the JSONL transcript */
	pendingSendCount: 0,

	/** True while the pipe POST is in-flight. Drives the send-button spinner. */
	pipeSending: false,
	/** Detected 1/2/3 approval prompt — null when none. */
	approvalOptions: null,

	// ── Center column chat view (when centerView === 'chat') ───────────────
	/** @type {Array<{role?:string, type?:string, text:string, ts?:string}>} */
	centerChatMessages: [],
	/** True between send and first assistant reply (shows "Thinking..." bubble). */
	centerChatLoading: false,
	/** True when user scrolled up — auto-scroll-to-bottom is paused. */
	centerChatUserScrolledUp: false,

	// ── Image paste preview bar ─────────────────────────────────────────────
	/** @type {Array<{dataUrl:string, path?:string, uploading?:boolean}>} */
	pastedImages: [],

	// ── Permissions ─────────────────────────────────────────────────────────
	/** @type {{power:number, realPower:number, isImpersonating:boolean, widgets:Record<string,{visible:boolean}>}|null} */
	permsMatrix: null,

	// ── Layout selectors (left/right sidebar panel choice) ──────────────────
	/** which panel is in the LEFT sidebar */
	leftSection: typeof window !== 'undefined'
		? (localStorage.getItem('pan_left_section') || 'transcript')
		: 'transcript',
	/** which panel is in the RIGHT sidebar */
	rightSection: typeof window !== 'undefined'
		? (localStorage.getItem('pan_right_section') || 'services')
		: 'services',
	/** 'terminal' | 'chat' — center column view */
	centerView: 'terminal',

	// ── Reactive version counter for the per-tab message store (see below) ──
	//   $derived / {#each} readers reference this to register a dependency on
	//   the Map-backed message store. Bumped on every store mutation.
	_storeVersion: 0,
});

// ────────────────────────────────────────────────────────────────────────────
//  Per-tab message store (NIGHTMARE BUG #444 — single source of truth)
// ────────────────────────────────────────────────────────────────────────────
//
//  Storage is ONE Map keyed by tabId. ALL reads and writes go through the
//  helper functions below. The tab object NEVER holds messages directly.
//  This eliminates the Svelte-proxy-vs-raw-object split that caused #444.
//
//  If you find yourself writing `tabData._pushedMessages = X` or
//  `tabData._echoMessages.push(X)` — STOP. Use setPushed / pushEcho instead.
//  See docs/NIGHTMARE_BUGS.md #444 for the full story.
//
//  Lifted from +page.svelte L3531-3577 (2026-05-27) so any component on the
//  terminal page can hit the same store without duplicating the data.

/** @type {Map<string, {pushed: any[], echoes: any[], btws: any[]}>} */
const _messageStore = new Map();

function _bump() { terminal._storeVersion++; }

function _ensureEntry(tabId) {
	let e = _messageStore.get(tabId);
	if (!e) { e = { pushed: [], echoes: [], btws: [] }; _messageStore.set(tabId, e); }
	return e;
}

/** Set the pushed-messages list for a tab. */
export function setPushed(tabId, msgs) {
	_ensureEntry(tabId).pushed = Array.isArray(msgs) ? msgs : [];
	_bump();
}
/** Read the pushed-messages list for a tab. Registers reactive dependency. */
export function getPushed(tabId) {
	terminal._storeVersion; // dependency
	return _messageStore.get(tabId)?.pushed || [];
}

/** Append a single echo (user message echoed from server) for a tab. */
export function pushEcho(tabId, msg) {
	_ensureEntry(tabId).echoes.push(msg);
	_bump();
}
/** Read all echoes for a tab. */
export function getEchoes(tabId) {
	terminal._storeVersion;
	return _messageStore.get(tabId)?.echoes || [];
}
/** Replace the echoes list for a tab (used after dedup). */
export function setEchoes(tabId, msgs) {
	_ensureEntry(tabId).echoes = Array.isArray(msgs) ? msgs : [];
	_bump();
}

/** Append a /btw aside for a tab. */
export function pushBtw(tabId, msg) {
	_ensureEntry(tabId).btws.push(msg);
	_bump();
}
/** Read all /btw asides for a tab. */
export function getBtws(tabId) {
	terminal._storeVersion;
	return _messageStore.get(tabId)?.btws || [];
}

/** Clear all stored messages for a tab (used on session reset). */
export function clearTabStore(tabId) {
	_messageStore.delete(tabId);
	_bump();
}

// ────────────────────────────────────────────────────────────────────────────
//  Helpers — keep these thin.
// ────────────────────────────────────────────────────────────────────────────

/** Get the active tab object, or null if none. */
export function getActiveTab() {
	return terminal.tabs.find(t => t.id === terminal.activeTabId) || null;
}

/** Layout: persist left/right panel choice to localStorage on change. */
export function setLeftSection(s) {
	terminal.leftSection = s;
	if (typeof window !== 'undefined') localStorage.setItem('pan_left_section', s);
}
export function setRightSection(s) {
	terminal.rightSection = s;
	if (typeof window !== 'undefined') localStorage.setItem('pan_right_section', s);
}

/** Visibility check for a panel option, based on the current permissions matrix. */
export function widgetVisible(optionValue, panelWidgetMap) {
	if (!terminal.permsMatrix) return true; // not yet loaded → show everything
	const key = panelWidgetMap?.[optionValue];
	if (!key) return true;
	return terminal.permsMatrix.widgets[key]?.visible !== false;
}
