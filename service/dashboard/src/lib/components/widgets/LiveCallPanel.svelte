<!--
  LiveCallPanel.svelte — at-a-glance "what's happening on the call" view
  for the main dashboard. Complements (does NOT replace) the immersive
  /comms popup. The popup is still the place to actually be on a call;
  this widget makes the call's context visible from inside the dashboard
  while you work on other things.

  Shows:
    • Is a call active right now? (yes/no + elapsed)
    • Live conv-state (topic, phase, pending_question)
    • Current intuition snapshot (where, activity, focus, commander)
    • Last 3-5 chat turns (most recent at bottom)
    • Buttons: "Open call window" (popup) and "End call"

  Symmetric across left and right columns — same component, same data
  source, no column-specific logic. Polls every 3s while the panel is
  open (cheap reads; no model calls).

  Source of truth: /api/v1/chat/threads/thread-pan-system/messages,
  /api/v1/intuition/snapshot (existing), and a new endpoint we add for
  active call state (POST /api/v1/chat/calls/active).
-->
<script>
	import { onMount, onDestroy } from 'svelte';
	import { api } from '$lib/api.js';

	let { openCount = $bindable(0) } = $props();

	const PAN_THREAD_ID = 'thread-pan-system';

	let activeCall   = $state(/** @type {object|null} */ (null));
	let snapshot     = $state(/** @type {object|null} */ (null));
	let convState    = $state(/** @type {object|null} */ (null));
	let recentMsgs   = $state(/** @type {array} */ ([]));
	let refreshTimer = null;

	function formatElapsed(ms) {
		if (!ms || ms < 0) return '0:00';
		const total = Math.floor(ms / 1000);
		const m = Math.floor(total / 60);
		const s = total % 60;
		return `${m}:${String(s).padStart(2, '0')}`;
	}

	function formatTime(ts) {
		if (!ts) return '';
		try {
			return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
		} catch { return ''; }
	}

	async function refresh() {
		// 1. Active call lookup (returns null if no live call)
		try {
			const r = await api('/api/v1/chat/calls/active');
			activeCall = r?.call || null;
		} catch { activeCall = null; }
		openCount = activeCall ? 1 : 0;

		// 2. Intuition snapshot — what does PAN currently know about the user.
		// Endpoint is /current (returns {ok, snapshot, as_of}); the snapshot
		// has .now.* and .signals.* nested under it.
		try {
			const r = await api('/api/v1/intuition/current');
			snapshot = r?.snapshot?.now || null;
			convState = r?.snapshot?.conversation || null;
		} catch { snapshot = null; convState = null; }

		// 4. Last 5 messages in the Π thread — gives context regardless of
		// whether the call is active right now (so the widget is useful even
		// between calls).
		try {
			const r = await api(`/api/v1/chat/threads/${PAN_THREAD_ID}/messages?limit=5`);
			recentMsgs = Array.isArray(r?.messages) ? r.messages : [];
		} catch { recentMsgs = []; }
	}

	function openPopup() {
		// Open the existing /comms route in a popup window. Same UX the user
		// already knows; this widget is just the at-a-glance view.
		const w = 900, h = 700;
		const left = (window.screen.availWidth - w) / 2;
		const top  = (window.screen.availHeight - h) / 2;
		window.open(`/comms?thread=${PAN_THREAD_ID}`, 'pan-comms',
			`width=${w},height=${h},left=${left},top=${top},toolbar=no,menubar=no,location=no,status=no`);
	}

	async function endCall() {
		if (!activeCall?.call_id) return;
		try {
			await api(`/api/v1/chat/calls/${activeCall.call_id}/end`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ duration_ms: Date.now() - (activeCall.started_at || Date.now()) }),
			});
			activeCall = null;
		} catch {}
		refresh();
	}

	onMount(() => {
		refresh();
		refreshTimer = setInterval(refresh, 3000);
	});
	onDestroy(() => {
		if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
	});
</script>

<div class="live-call-panel">
	<!-- Call status header -->
	<div class="lc-header">
		<div class="lc-title">
			<span class="lc-dot" class:active={!!activeCall}></span>
			<span>{activeCall ? 'On call' : 'No active call'}</span>
		</div>
		{#if activeCall}
			<span class="lc-elapsed">{formatElapsed(Date.now() - (activeCall.started_at || Date.now()))}</span>
		{/if}
	</div>

	<!-- Action row -->
	<div class="lc-actions">
		<button class="lc-btn lc-btn-primary" onclick={openPopup} title="Open the immersive call window">
			{activeCall ? 'Open window' : 'Start call'}
		</button>
		{#if activeCall}
			<button class="lc-btn lc-btn-end" onclick={endCall} title="End call">End</button>
		{/if}
	</div>

	<!-- Conv-state — what PAN thinks the conversation is about right now -->
	{#if convState}
		<div class="lc-section">
			<div class="lc-section-title">Conversation</div>
			{#if convState.topic}
				<div class="lc-row"><span class="lc-label">Topic</span><span class="lc-val">{convState.topic}</span></div>
			{/if}
			{#if convState.phase}
				<div class="lc-row"><span class="lc-label">Phase</span><span class="lc-val">{convState.phase}</span></div>
			{/if}
			{#if convState.pending_question}
				<div class="lc-row lc-pending"><span class="lc-label">Open ?</span><span class="lc-val">{convState.pending_question}</span></div>
			{/if}
			{#if convState.summary}
				<div class="lc-row"><span class="lc-label">Summary</span><span class="lc-val">{convState.summary}</span></div>
			{/if}
		</div>
	{/if}

	<!-- Intuition snapshot — where/what/who context for any reply -->
	{#if snapshot}
		<div class="lc-section">
			<div class="lc-section-title">Intuition</div>
			{#if snapshot.where}<div class="lc-row"><span class="lc-label">Where</span><span class="lc-val">{snapshot.where}</span></div>{/if}
			{#if snapshot.activity}<div class="lc-row"><span class="lc-label">Activity</span><span class="lc-val">{snapshot.activity}</span></div>{/if}
			{#if snapshot.focus}<div class="lc-row"><span class="lc-label">Focus</span><span class="lc-val">{snapshot.focus}</span></div>{/if}
			{#if snapshot.mood}<div class="lc-row"><span class="lc-label">Mood</span><span class="lc-val">{snapshot.mood}</span></div>{/if}
		</div>
	{/if}

	<!-- Recent turns — last few exchanges so context is visible even when
	     popup is closed. Keep cheap: 5 turns, no timing metadata. -->
	{#if recentMsgs.length}
		<div class="lc-section">
			<div class="lc-section-title">Recent turns</div>
			{#each recentMsgs.slice(-5) as msg}
				<div class="lc-msg" class:lc-msg-self={msg.sender_id === 'self'}>
					<span class="lc-msg-who">{msg.sender_id === 'self' ? 'you' : 'Π'}</span>
					<span class="lc-msg-time">{formatTime(msg.created_at)}</span>
					<div class="lc-msg-body">{(msg.body || '').slice(0, 160)}{(msg.body || '').length > 160 ? '…' : ''}</div>
				</div>
			{/each}
		</div>
	{/if}
</div>

<style>
	.live-call-panel {
		padding: 8px;
		font-size: 12px;
		color: #cdd6f4;
	}
	.lc-header {
		display: flex; align-items: center; gap: 8px;
		padding: 4px 6px 8px;
		border-bottom: 1px solid rgba(205,214,244,0.1);
	}
	.lc-title { display: flex; align-items: center; gap: 6px; flex: 1; font-weight: 600; }
	.lc-dot {
		display: inline-block; width: 8px; height: 8px; border-radius: 50%;
		background: #6c7086;
	}
	.lc-dot.active { background: #a6e3a1; box-shadow: 0 0 6px rgba(166,227,161,0.6); animation: pulse 2s infinite; }
	@keyframes pulse {
		0%, 100% { opacity: 1; }
		50% { opacity: 0.5; }
	}
	.lc-elapsed { font-variant-numeric: tabular-nums; color: #a6e3a1; font-weight: 600; }

	.lc-actions { display: flex; gap: 6px; padding: 8px 6px; }
	.lc-btn {
		flex: 1; padding: 6px 10px; font-size: 11px;
		background: rgba(116,199,236,0.1); border: 1px solid rgba(116,199,236,0.3);
		color: #74c7ec; border-radius: 4px; cursor: pointer;
	}
	.lc-btn:hover { background: rgba(116,199,236,0.2); }
	.lc-btn-end {
		background: rgba(243,139,168,0.1); border-color: rgba(243,139,168,0.3); color: #f38ba8;
	}
	.lc-btn-end:hover { background: rgba(243,139,168,0.2); }

	.lc-section { padding: 8px 6px; border-bottom: 1px solid rgba(205,214,244,0.05); }
	.lc-section-title {
		font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px;
		color: #6c7086; margin-bottom: 4px;
	}
	.lc-row { display: flex; gap: 8px; padding: 2px 0; }
	.lc-label { color: #6c7086; min-width: 60px; font-size: 11px; }
	.lc-val   { color: #cdd6f4; flex: 1; font-size: 11px; word-break: break-word; }
	.lc-pending .lc-val { color: #f9e2af; font-style: italic; }

	.lc-msg {
		padding: 4px 6px; margin: 4px 0;
		background: rgba(205,214,244,0.03); border-radius: 4px;
		border-left: 2px solid rgba(116,199,236,0.4);
	}
	.lc-msg-self { border-left-color: rgba(203,166,247,0.4); }
	.lc-msg-who { font-weight: 600; font-size: 10px; color: #74c7ec; }
	.lc-msg-self .lc-msg-who { color: #cba6f7; }
	.lc-msg-time { font-size: 9px; color: #6c7086; margin-left: 6px; }
	.lc-msg-body { margin-top: 2px; font-size: 11px; line-height: 1.4; }
</style>
