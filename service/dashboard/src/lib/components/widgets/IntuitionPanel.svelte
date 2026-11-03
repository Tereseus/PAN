<!--
  IntuitionPanel.svelte — extracted from terminal/+page.svelte (Shape-2 refactor, 2026-05-27).

  Self-contained version of the right-column Intuition widget. Owns its own:
    • intuition roster + per-commander snapshots
    • PAN's Mind (thought stream) + Synthesis paragraph + reasoning steps
    • Motives (Life Needs) bars
    • Webcam force-capture button
    • Voice enrollment UI (embedded inside the Identity section)

  Reads `orgData` from the parent as a prop because orgData is shared with
  other panels still living in +page.svelte. When the foundation store grows
  to host orgData, this prop becomes a `terminal.orgData` read.

  WS-driven refreshes: the parent dispatches a `window` CustomEvent
  `pan:intuition-update` from its WS handler when an `intuition` widget_update
  arrives. This component subscribes on mount.

  See docs/DASHBOARD-REFACTOR-MAP.md for the full extraction plan.
-->
<script>
	import { onMount, onDestroy } from 'svelte';
	import { api } from '$lib/api.js';

	// ────────────────────────────────────────────────────────────────────────
	//  Org context — read directly from `$lib/stores/org.svelte.js`. 2026-05-28
	//  migrated from props (was prop-drilled from +page.svelte).
	// ────────────────────────────────────────────────────────────────────────
	import { org } from '$lib/stores/org.svelte.js';
	const orgData = $derived(org.data);

	// ────────────────────────────────────────────────────────────────────────
	//  Intuition state — atomic pieces. See docs/NIGHTMARE_BUGS.md for the
	//  history of why this is "DEAD SIMPLE" (no nested deriveds writing back).
	// ────────────────────────────────────────────────────────────────────────
	let intuitionMembers = $state([]);
	let intuitionSnapsByCommander = $state({});
	let intuitionOrgSnap = $state(null);
	let intuitionIndSnap = $state(null);
	let selectedIntuitionUser = $state('');
	let intuitionStatus = $state('');
	let intuitionLoaded = $state(false);
	let intuitionSnapshotsLoaded = $state(false);

	// ────────────────────────────────────────────────────────────────────────
	//  refreshIntuition — the SINGLE refresh function. Replaces the old
	//  loadIntuition. See L544-646 of the original +page.svelte for the
	//  full architectural reasoning behind "atomic only, no synthetics".
	// ────────────────────────────────────────────────────────────────────────
	async function refreshIntuition() {
		// HARD GATE: orgData must exist. Calling with null orgData produces a
		// false "No users in this org yet" flash. Parent is responsible for
		// retrying the org loader; we just bail and wait for the prop update.
		if (!orgData?.org_id) return;
		const orgId = orgData.org_id;
		const orgQS = `?org_id=${encodeURIComponent(orgId)}`;

		// Snapshots skip api()'s 30 s stale-while-revalidate cache: a refresh inside that
		// window rendered the PREVIOUS tick's read, so the panel ran one tick behind.
		const [rosterR, snapsR, orgR, indR] = await Promise.allSettled([
			api(`/api/v1/orgs/${encodeURIComponent(orgId)}/members`),
			api(`/api/v1/intuition/org/members${orgQS}`, { noCache: true }),
			api(`/api/v1/intuition/org/current${orgQS}`, { noCache: true }),
			api(`/api/v1/intuition/current${orgQS}`, { noCache: true }),
		]);

		if (rosterR.status === 'fulfilled' && Array.isArray(rosterR.value?.members)) {
			intuitionMembers = rosterR.value.members;
		}

		if (snapsR.status === 'fulfilled' && Array.isArray(snapsR.value?.members)) {
			const merged = { ...intuitionSnapsByCommander };
			for (const row of snapsR.value.members) merged[row.commander] = row;
			intuitionSnapsByCommander = merged;
		}
		if (snapsR.status === 'fulfilled' || snapsR.status === 'rejected') {
			intuitionSnapshotsLoaded = true;
		}

		if (orgR.status === 'fulfilled' && orgR.value?.snapshot) intuitionOrgSnap = orgR.value.snapshot;
		if (indR.status === 'fulfilled' && indR.value?.snapshot) intuitionIndSnap = indR.value.snapshot;

		// Repair selection if it points at a user no longer in the roster.
		if (!selectedIntuitionUser || !intuitionMembers.some(m => m.display_name === selectedIntuitionUser)) {
			let saved = '';
			try { saved = localStorage.getItem('pan_intuition_user') || ''; } catch {}
			if (saved && intuitionMembers.some(m => m.display_name === saved)) {
				selectedIntuitionUser = saved;
			} else {
				selectedIntuitionUser = orgData?.user_display_name || intuitionMembers[0]?.display_name || '';
			}
		}

		if (rosterR.status === 'rejected' && intuitionMembers.length === 0) {
			intuitionStatus = 'Failed to load — retrying…';
		} else {
			intuitionStatus = intuitionMembers.length === 0 ? 'No users in this org yet' : '';
		}
		if (rosterR.status === 'fulfilled' || rosterR.status === 'rejected') {
			intuitionLoaded = true;
		}

		// 5s retry for transient roster failures. Idempotent via the window guard.
		if (rosterR.status === 'rejected') {
			if (typeof window !== 'undefined' && !window._intuitionRetryTimer) {
				window._intuitionRetryTimer = setTimeout(() => {
					window._intuitionRetryTimer = null;
					refreshIntuition();
				}, 5000);
			}
		}

		if (!voiceEnrollLabel && orgData?.user_display_name) voiceEnrollLabel = orgData.user_display_name;

		loadPanMind();
		loadPanNeeds();
		loadPanSynthesis();
		loadWatcherStatus();
	}

	// The needs and synthesis tables key the owner as 'owner' (needs.canonicalUserId on
	// the server). Asked by display name, the panel read a separate, months-stale set of
	// bars and a cached failed synthesis (2026-11-03).
	function needsUserId() {
		const row = intuitionMembers.find(u => u.display_name === selectedIntuitionUser);
		if (!row) return '';
		return row.role_name === 'owner' ? 'owner' : row.display_name;
	}

	// Camera and screen watchers can be switched off (they are on the hub). "No capture
	// yet" then reads as a wait that never ends, so the panel says off instead.
	let camWatcherOn = $state(null);     // null = unknown
	let screenWatcherOn = $state(null);
	async function loadWatcherStatus() {
		const [w, s] = await Promise.allSettled([
			api('/api/v1/webcam-watcher/status', { noCache: true }),
			api('/api/v1/screen-watcher/status', { noCache: true }),
		]);
		camWatcherOn = w.status === 'fulfilled' ? !!w.value?.running : null;
		screenWatcherOn = s.status === 'fulfilled' ? !!s.value?.running : null;
	}

	function agoStr(ms) {
		if (!ms) return '';
		const d = Date.now() - ms;
		if (d < 60_000) return `${Math.max(0, Math.round(d / 1000))}s ago`;
		if (d < 3_600_000) return `${Math.round(d / 60_000)}m ago`;
		return `${Math.round(d / 3_600_000)}h ago`;
	}

	// ── PAN's Mind — first-person thought stream ────────────────────────────
	let panThoughts = $state([]);
	async function loadPanThoughts() {
		try {
			const r = await fetch('/api/v1/thoughts/recent?limit=20');
			if (!r.ok) return;
			const d = await r.json();
			panThoughts = Array.isArray(d?.thoughts) ? d.thoughts : [];
		} catch { /* keep previous */ }
	}
	const loadPanMind = loadPanThoughts;

	// ── Life Needs — Sims-style motive bars ─────────────────────────────────
	let panNeeds = $state([]);
	async function loadPanNeeds() {
		try {
			const u = needsUserId();
			const qs = u ? `?user=${encodeURIComponent(u)}` : '';
			const r = await fetch(`/api/v1/needs${qs}`);
			if (!r.ok) return;
			const d = await r.json();
			panNeeds = Array.isArray(d?.needs) ? d.needs : [];
		} catch { /* keep last */ }
	}

	// ── PAN's-Mind synthesis paragraph ─────────────────────────────────────
	let panSynthesis = $state(null);
	let panReasoningOpen = $state(false);
	// A failed cycle comes back 200 with ok:false. It used to be dropped, so with no good
	// paragraph yet the box said "thinking…" forever; it is shown when there is nothing
	// better, and a good paragraph is kept over a later failure.
	async function loadPanSynthesis() {
		try {
			const u = needsUserId();
			const qs = u ? `?user=${encodeURIComponent(u)}` : '';
			const r = await fetch(`/api/v1/pan/synthesis${qs}`);
			if (!r.ok) return;
			const d = await r.json();
			if (d?.ok || (d && !panSynthesis?.ok)) panSynthesis = d;
		} catch { /* keep last */ }
	}
	async function forcePanSynthesis() {
		try {
			const u = needsUserId();
			const qs = u ? `?user=${encodeURIComponent(u)}&force=1` : '?force=1';
			const r = await fetch(`/api/v1/pan/synthesis${qs}`);
			if (!r.ok) return;
			const d = await r.json();
			if (d?.ok || (d && !panSynthesis?.ok)) panSynthesis = d;
		} catch { /* keep last */ }
	}
	function needBarColor(level) {
		if (level >= 70) return '#22c55e';
		if (level >= 30) return '#eab308';
		return '#ef4444';
	}

	// ── Face enrollment ──────────────────────────────────────────────
	// Captures a single frame from the browser's webcam (getUserMedia) and
	// POSTs it to /api/v1/identity/enroll-face. The face-id worker extracts
	// the descriptor and adds it to enrolledDescriptors immediately — the
	// next webcam-watcher cycle will identify you instead of returning
	// 'unknown'. The image is also saved to Me_pics/ for persistence across
	// Craft restarts.
	let faceEnrollStatus = $state('');  // '', 'capturing', 'uploading', 'done', 'error'
	let faceEnrollMsg = $state('');
	let faceEnrollCount = $state(0);    // server-reported enrolledCount
	async function refreshFaceStatus() {
		try {
			const s = await fetch(`${window.location.origin}/api/v1/identity/face-status`).then(r => r.json());
			faceEnrollCount = s?.enrolledCount || 0;
		} catch {}
	}
	async function enrollFaceFromCamera() {
		if (faceEnrollStatus === 'capturing' || faceEnrollStatus === 'uploading') return;
		faceEnrollStatus = 'capturing';
		faceEnrollMsg = 'opening camera...';
		let stream = null;
		try {
			stream = await navigator.mediaDevices.getUserMedia({
				video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
				audio: false,
			});
			const video = document.createElement('video');
			video.srcObject = stream;
			video.muted = true;
			await video.play();
			// Give the camera 800ms to settle on a clear frame (auto-exposure / focus)
			await new Promise(r => setTimeout(r, 800));
			const canvas = document.createElement('canvas');
			canvas.width = video.videoWidth || 640;
			canvas.height = video.videoHeight || 480;
			canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
			const dataUrl = canvas.toDataURL('image/jpeg', 0.9);
			faceEnrollStatus = 'uploading';
			faceEnrollMsg = 'enrolling face...';
			const resp = await fetch(`${window.location.origin}/api/v1/identity/enroll-face`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ base64: dataUrl }),
			});
			const r = await resp.json().catch(() => ({}));
			if (resp.ok && r.ok) {
				faceEnrollStatus = 'done';
				faceEnrollCount = r.enrolledCount || (faceEnrollCount + 1);
				faceEnrollMsg = `✓ Enrolled · ${r.label || orgData?.user_display_name || 'you'} (${faceEnrollCount} face${faceEnrollCount !== 1 ? 's' : ''})`;
				setTimeout(() => { faceEnrollMsg = ''; faceEnrollStatus = ''; }, 4000);
			} else {
				faceEnrollStatus = 'error';
				faceEnrollMsg = `✗ ${r.error || 'enroll failed'}`;
				setTimeout(() => { faceEnrollMsg = ''; faceEnrollStatus = ''; }, 6000);
			}
		} catch (e) {
			faceEnrollStatus = 'error';
			faceEnrollMsg = `✗ ${e?.message || 'camera failed'}`;
			setTimeout(() => { faceEnrollMsg = ''; faceEnrollStatus = ''; }, 6000);
		} finally {
			if (stream) stream.getTracks().forEach(t => t.stop());
		}
	}

	// ── Webcam force-capture (lives inside the Identity section UI) ─────────
	let forcingCapture = $state(false);
	async function forceCamCapture() {
		if (forcingCapture) return;
		forcingCapture = true;
		try {
			await fetch(`${window.location.origin}/api/v1/webcam-watcher/force`, { method: 'POST' });
			const start = Date.now();
			while (Date.now() - start < 120_000) {
				await new Promise(r => setTimeout(r, 3000));
				const s = await fetch(`${window.location.origin}/api/v1/webcam-watcher/status`).then(r => r.json()).catch(() => null);
				if (s?.lastCapture?.ts && Date.now() - s.lastCapture.ts < 10_000) {
					if (intuitionIndSnap) {
						const next = { ...intuitionIndSnap };
						next.signals = { ...(next.signals || {}), webcam_context: { ...s.lastCapture } };
						intuitionIndSnap = next;
					}
					await refreshIntuition();
					break;
				}
			}
		} finally {
			forcingCapture = false;
		}
	}

	// ── Voice enrollment (Identity card sub-UI) ─────────────────────────────
	let voiceEnrollLabel = $state('');   // filled with the signed-in user's display name
	let voiceEnrollStatus = $state('');  // '', 'recording', 'uploading', 'done', 'error'
	let voiceEnrollMsg = $state('');
	let voiceEnrollSpeakers = $state([]);
	let voiceServerOk = $state(false);
	let voiceEnrollSeconds = $state(0);
	let _voiceTimer = null;

	async function loadVoiceSpeakers() {
		try {
			const d = await api('/api/v1/voice/status');
			voiceServerOk = d.ok;
			const s = await api('/api/v1/voice/speakers');
			voiceEnrollSpeakers = s.speakers || [];
		} catch { voiceServerOk = false; }
	}

	async function startVoiceEnroll() {
		if (!voiceEnrollLabel.trim()) { voiceEnrollMsg = 'Enter a name first'; return; }
		const label = voiceEnrollLabel.trim();
		const seconds = 10;
		voiceEnrollStatus = 'recording';
		voiceEnrollSeconds = 0;
		voiceEnrollMsg = `Listening via server mic... speak for ${seconds}s`;

		_voiceTimer = setInterval(() => {
			voiceEnrollSeconds++;
			if (voiceEnrollSeconds >= seconds) {
				if (_voiceTimer) { clearInterval(_voiceTimer); _voiceTimer = null; }
			}
		}, 1000);

		try {
			const r = await fetch('/api/v1/voice/record-enroll', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ label, seconds }),
			});
			if (_voiceTimer) { clearInterval(_voiceTimer); _voiceTimer = null; }
			const d = await r.json();
			if (d.ok) {
				voiceEnrollStatus = 'done';
				voiceEnrollMsg = `✓ Enrolled "${label}" (${d.enrolled} speaker${d.enrolled !== 1 ? 's' : ''} total)`;
				await loadVoiceSpeakers();
			} else {
				voiceEnrollStatus = 'error';
				voiceEnrollMsg = d.error || 'Enroll failed';
			}
		} catch(e) {
			if (_voiceTimer) { clearInterval(_voiceTimer); _voiceTimer = null; }
			voiceEnrollStatus = 'error';
			voiceEnrollMsg = 'Error: ' + e.message;
		}
	}

	function stopVoiceEnroll() {
		if (_voiceTimer) { clearInterval(_voiceTimer); _voiceTimer = null; }
		if (voiceEnrollStatus === 'recording') {
			voiceEnrollStatus = '';
			voiceEnrollMsg = 'Cancelled';
		}
	}

	async function deleteVoiceSpeaker(label) {
		try {
			await api(`/api/v1/voice/speaker/${encodeURIComponent(label)}`, { method: 'DELETE' });
			await loadVoiceSpeakers();
		} catch {}
	}

	// ────────────────────────────────────────────────────────────────────────
	//  Derived: composite merged-members view + intuitionData wrapper.
	//  Both are PURE derivations — never assigned to. Re-evaluate whenever
	//  any atomic piece changes, so the panel always reflects fresh data.
	// ────────────────────────────────────────────────────────────────────────
	let _intuitionMergedMembers = $derived.by(() => {
		const snaps = intuitionSnapsByCommander;
		return (intuitionMembers || []).map(u => {
			const snap = snaps[u.display_name]?.snapshot || null;
			const n = snap?.now || {};
			const age_ms = snap?.as_of ? Date.now() - snap.as_of : null;
			return {
				user_id: u.id,
				commander: u.display_name,
				role_name: u.role_name,
				role_color: u.role_color,
				avatar_url: u.avatar_url,
				as_of: snap?.as_of || null,
				age_ms,
				is_active: age_ms !== null && age_ms < 5 * 60 * 1000,
				has_snapshot: !!snap,
				activity: n.activity || null,
				focus: n.focus || null,
				mood: n.mood || null,
				where: n.where || null,
				last_seen: n.last_seen || null,
				last_heard: n.last_heard || null,
				urgency: n.urgency || null,
				engagement: n.engagement || null,
				recent_topics: n.recent_topics || [],
				assumption: n.assumption || null,
				confidence: snap?.signals?.confidence ?? 0,
			};
		});
	});
	let intuitionData = $derived(
		!intuitionLoaded
			? null
			: {
				org_id: orgData?.org_id || '',
				org_name: orgData?.org_name || intuitionOrgSnap?.org_name || 'Personal',
				as_of: intuitionOrgSnap?.as_of || null,
				members: _intuitionMergedMembers,
				devices: intuitionOrgSnap?.devices || [],
				org_state: intuitionOrgSnap?.org_state || {},
				individualSnap: intuitionIndSnap || {},
				snapshot: intuitionIndSnap || null,
			}
	);

	// ── User dropdown change handler ────────────────────────────────────────
	function onIntuitionUserChange() {
		try { localStorage.setItem('pan_intuition_user', selectedIntuitionUser || ''); } catch {}
		refreshIntuition();
	}

	// ────────────────────────────────────────────────────────────────────────
	//  Top-of-template projections. The original {#snippet} placed these as
	//  `{@const}` declarations directly under the snippet body, which Svelte
	//  permits. At the top of a regular component template, `{@const}` is
	//  illegal — it has to live inside `{#snippet|#if|#each|...}`. So the
	//  bindings move here as `$derived` instead, exposing the same names to
	//  the template below.
	// ────────────────────────────────────────────────────────────────────────
	const _intData = $derived(intuitionData || { org_state: {}, individualSnap: {}, org_name: '' });
	const orgState = $derived(_intData.org_state || {});
	const iSnap = $derived(_intData.individualSnap || {});
	const pan = $derived(iSnap.pan || {});
	const iSig = $derived(iSnap.signals || {});
	const preds = $derived(pan.predictions || []);
	const wc = $derived(iSig.webcam_context);
	const sc = $derived(iSig.screen_context);
	const _orgName = $derived(_intData.org_name || orgData?.org_name || 'Org');
	const _selectedRow = $derived(intuitionMembers.find(u => u.display_name === selectedIntuitionUser) || intuitionMembers[0]);
	const _selectedSnap = $derived(_selectedRow ? (intuitionSnapsByCommander[_selectedRow.display_name]?.snapshot || null) : null);
	const _selN = $derived(_selectedSnap?.now || {});
	const _selAgeMs = $derived(_selectedSnap?.as_of ? Date.now() - _selectedSnap.as_of : null);
	const m = $derived(_selectedRow ? {
		commander: _selectedRow.display_name,
		role_name: _selectedRow.role_name,
		role_color: _selectedRow.role_color,
		as_of: _selectedSnap?.as_of || null,
		age_ms: _selAgeMs,
		is_active: _selAgeMs !== null && _selAgeMs < 5 * 60 * 1000,
		has_snapshot: !!_selectedSnap,
		activity: _selN.activity || null,
		focus: _selN.focus || null,
		mood: _selN.mood || null,
		where: _selN.where || null,
		last_heard: _selN.last_heard || null,
		urgency: _selN.urgency || null,
		engagement: _selN.engagement || null,
		recent_topics: _selN.recent_topics || [],
		assumption: _selN.assumption || null,
		confidence: _selectedSnap?.signals?.confidence ?? 0,
		device: _selectedSnap?.signals?.device_source || null,
		classified_at: _selectedSnap?.meta?.classified_at || null,
		classifier: _selectedSnap?.meta?.classifier || null,
	} : null);
	const thinkingNow = $derived((pan.sessions || []).some(s => s.thinking || s.claudeRunning));

	// ────────────────────────────────────────────────────────────────────────
	//  Reactivity to orgData prop changes — only re-fetch when org_id ACTUALLY
	//  changes (cf. L867-879 of the original — Svelte 5 effects deeply track,
	//  so we cache the last org_id to avoid blanking on every mutation).
	// ────────────────────────────────────────────────────────────────────────
	let _lastIntuitionOrgId = null;
	$effect(() => {
		const activeOrgId = orgData?.org_id;
		if (!activeOrgId) return;
		if (activeOrgId === _lastIntuitionOrgId) return;
		_lastIntuitionOrgId = activeOrgId;
		selectedIntuitionUser = '';
		refreshIntuition();
	});

	// ────────────────────────────────────────────────────────────────────────
	//  Lifecycle
	// ────────────────────────────────────────────────────────────────────────
	let _wsHandler = null;
	onMount(() => {
		refreshFaceStatus();
		// Initial loads
		loadVoiceSpeakers();
		if (orgData?.org_id) refreshIntuition();

		// Listen for WS-pushed intuition updates dispatched by the parent.
		// Parent +page.svelte's WS handler dispatches this when a
		// `widget_update:'intuition'` frame arrives.
		_wsHandler = () => refreshIntuition();
		if (typeof window !== 'undefined') {
			window.addEventListener('pan:intuition-update', _wsHandler);
		}
	});

	onDestroy(() => {
		if (_voiceTimer) { clearInterval(_voiceTimer); _voiceTimer = null; }
		if (typeof window !== 'undefined' && _wsHandler) {
			window.removeEventListener('pan:intuition-update', _wsHandler);
		}
	});
</script>

<!-- ════════════════════════════════════════════════════════════════════════
     Template lifted verbatim from L6473-L6880 of +page.svelte. Layout and
     class names preserved so the panel renders identically to the old
     {#snippet intuitionPanelContents()} version.
     ════════════════════════════════════════════════════════════════════════ -->

<!-- BULLETPROOF RENDER: this template has NO conditional wrapper that can
     unmount the user card. Every "could be null" path falls through to a
     synthetic placeholder so the layout NEVER disappears.
     The top-level projections (_intData, orgState, iSnap, pan, iSig, preds,
     wc, sc, _orgName, _selectedRow, _selectedSnap, _selN, _selAgeMs, m,
     thinkingNow) are declared as `$derived` in the script above. -->

<!-- TOP-LEVEL SECTION: USER -->
<div style="padding-bottom:3px;margin-bottom:6px;font-size:11px;font-weight:700;color:#cba6f7;letter-spacing:1.5px;border-bottom:1px solid rgba(203,166,247,0.3)">
	USER
</div>
<div class="int-header" style="gap:6px;align-items:center">
	<select
		bind:value={selectedIntuitionUser}
		onchange={onIntuitionUserChange}
		style="flex:1;background:#181825;color:#cdd6f4;border:1px solid #313244;border-radius:4px;padding:3px 6px;font-size:11px"
	>
		{#if intuitionMembers.length === 0}
			<option value="">(no users)</option>
		{:else}
			{#each intuitionMembers as u (u.id)}
				{@const hasSnap = !!intuitionSnapsByCommander[u.display_name]?.snapshot}
				<option value={u.display_name}>
					{u.display_name}{u.role_name ? ` · ${u.role_name}` : ''}{(intuitionSnapshotsLoaded && !hasSnap) ? ' (no data)' : ''}
				</option>
			{/each}
		{/if}
	</select>
	<span class="int-ago">{m?.as_of ? new Date(m.as_of).toLocaleTimeString() : (intuitionLoaded ? '—' : 'loading…')}</span>
</div>

{#if intuitionStatus}
	<div class="empty-state" style="font-size:11px;color:#94a3b8;font-style:italic">{intuitionStatus}</div>
{/if}

{#if m}
	{@const _roleLabel = m.role_name ? (m.role_name.charAt(0).toUpperCase() + m.role_name.slice(1)) : ''}
	{@const _assump = String(m.assumption || '').toLowerCase().replace(/[\s-]+/g, '_')}
	<!-- _assump: the classifier writes "Ok" / "Not ok"; the classes were keyed on 'ok' / 'not_ok'. -->
	<div class="svc-category" style="display:flex;align-items:center;gap:6px">
		{m.commander || 'Unknown'}
		{#if _roleLabel}<span style="font-size:10px;color:{m.role_color || '#6c7086'}">· {_roleLabel}</span>{/if}
		<!-- Freshness of the read, not his activity: "● active" sat above "Activity: Idle". -->
		<span title={m.as_of ? `read ${agoStr(m.as_of)}` : 'no read yet'} style="font-size:10px;padding:1px 5px;border-radius:3px;background:{m.is_active ? 'rgba(166,227,161,0.15)' : 'rgba(108,112,134,0.15)'};color:{m.is_active ? '#a6e3a1' : '#6c7086'}">{m.is_active ? '● live' : (m.as_of ? `○ stale · ${agoStr(m.as_of)}` : '○ no read')}</span>
	</div>

	<!-- SECTION: Identity (camera/screen/voice enrollment) -->
	<div class="svc-category" style="display:flex;align-items:center;gap:6px">
		Identity
		<span style="font-size:10px;padding:1px 5px;border-radius:3px;margin-left:auto;background:{voiceServerOk ? 'rgba(166,227,161,0.15)' : 'rgba(243,139,168,0.15)'};color:{voiceServerOk ? '#a6e3a1' : '#f38ba8'}" title="voice ID server">voice {voiceServerOk ? 'online' : 'offline'}</span>
	</div>
	<div class="int-axes">
		<div class="int-axis">
			<span class="int-label">Camera</span>
			<span class="int-val small" style="color:{wc ? (wc.presence === 'yes' ? '#a6e3a1' : wc.presence === 'no' ? '#f38ba8' : '#fab387') : '#6c7086'}">
				{wc ? (wc.presence === 'yes' ? (wc.identity || 'Someone') : wc.presence === 'no' ? 'Desk empty' : 'Unclear') : camWatcherOn === false ? 'off (watcher not running)' : '⏳ no capture yet'}
			</span>
			<button onclick={forceCamCapture} disabled={forcingCapture} title="Force capture now" style="margin-left:4px;background:none;border:1px solid rgba(255,255,255,0.15);border-radius:4px;color:{forcingCapture ? '#6c7086' : '#cba6f7'};cursor:{forcingCapture ? 'default' : 'pointer'};font-size:10px;padding:1px 5px;line-height:1.4">
				{forcingCapture ? '⏳' : '📷'}
			</button>
			<button onclick={enrollFaceFromCamera} disabled={faceEnrollStatus === 'capturing' || faceEnrollStatus === 'uploading'} title={faceEnrollCount === 0 ? 'Enroll your face — required for identity recognition' : `Add another sample (${faceEnrollCount} enrolled)`} style="margin-left:2px;background:none;border:1px solid {faceEnrollCount === 0 ? '#fab387' : 'rgba(255,255,255,0.15)'};border-radius:4px;color:{(faceEnrollStatus === 'capturing' || faceEnrollStatus === 'uploading') ? '#6c7086' : (faceEnrollCount === 0 ? '#fab387' : '#cba6f7')};cursor:{(faceEnrollStatus === 'capturing' || faceEnrollStatus === 'uploading') ? 'default' : 'pointer'};font-size:10px;padding:1px 5px;line-height:1.4">
				{faceEnrollStatus === 'capturing' || faceEnrollStatus === 'uploading' ? '⏳' : '🆔'}
			</button>
		</div>
		{#if faceEnrollMsg}
			<div style="font-size:10px;color:{faceEnrollStatus === 'error' ? '#f38ba8' : faceEnrollStatus === 'done' ? '#a6e3a1' : '#6c7086'};padding:2px 0 4px;margin-left:4px">{faceEnrollMsg}</div>
		{:else if faceEnrollCount === 0 && camWatcherOn}
			<div style="font-size:10px;color:#fab387;padding:2px 0 4px;margin-left:4px">No face enrolled · click 🆔 to enroll yours (every capture will say 'unknown' until you do)</div>
		{/if}
		{#if wc?.emotion && wc.presence === 'yes'}
			<div class="int-axis"><span class="int-label">Expression</span><span class="int-val small">{wc.emotion}{wc.note ? ' · ' + wc.note : ''}</span></div>
		{/if}
		{#if wc?.people_count > 1}
			<div class="int-axis"><span class="int-label">People</span><span class="int-val small">{wc.people_count} visible</span></div>
		{/if}
		<div class="int-axis" style="flex-wrap:wrap">
			<span class="int-label">Screen</span>
			<span class="int-val small" style="color:{sc ? '#cba6f7' : '#6c7086'};white-space:normal">{sc ? sc.description : screenWatcherOn === false ? 'off (watcher not running)' : '⏳ no capture yet'}</span>
		</div>
		{#if wc?.age_ms}<div class="int-axis"><span class="int-label">Cam age</span><span class="int-val small">{Math.round(wc.age_ms/1000)}s ago</span></div>{/if}
		{#if sc?.age_ms}<div class="int-axis"><span class="int-label">Screen age</span><span class="int-val small">{Math.round(sc.age_ms/1000)}s ago</span></div>{/if}
	</div>
	<!-- Voice enrollment lives inside the Identity section -->
	{#if voiceEnrollSpeakers.length > 0}
		<div style="margin-bottom:6px">
			{#each voiceEnrollSpeakers as sp}
				<div style="display:flex;align-items:center;gap:6px;padding:2px 0">
					<span style="font-size:15px">🎤</span>
					<span style="font-size:12px;color:#cdd6f4;flex:1">{sp.label || sp}</span>
					{#if sp.sample_count}<span style="font-size:10px;color:#6c7086">{sp.sample_count} sample{sp.sample_count !== 1 ? 's' : ''}</span>{/if}
					<button onclick={() => deleteVoiceSpeaker(sp.label || sp)} style="background:none;border:none;color:#f38ba8;cursor:pointer;font-size:12px;padding:1px 4px;border-radius:3px" title="Remove">✕</button>
				</div>
			{/each}
		</div>
	{:else}
		<div style="font-size:11px;color:#6c7086;margin-bottom:6px">No speakers enrolled — voice IDs passively as you speak</div>
	{/if}
	<div style="display:flex;gap:5px;margin-bottom:5px">
		<input bind:value={voiceEnrollLabel} placeholder="Speaker name" disabled={voiceEnrollStatus === 'recording' || voiceEnrollStatus === 'uploading'} style="flex:1;background:#1e1e2e;border:1px solid rgba(255,255,255,0.12);border-radius:5px;color:#cdd6f4;padding:4px 8px;font-size:12px;outline:none" />
	</div>
	{#if voiceEnrollStatus === 'recording'}
		<div style="display:flex;gap:6px;align-items:center">
			<button onclick={stopVoiceEnroll} style="flex:1;background:rgba(243,139,168,0.2);border:1px solid #f38ba8;border-radius:5px;color:#f38ba8;padding:5px;font-size:12px;cursor:pointer">⏹ Stop ({voiceEnrollSeconds}s / 10s)</button>
		</div>
		<div style="margin-top:4px;background:rgba(255,255,255,0.07);border-radius:3px;height:3px;overflow:hidden">
			<div style="background:#cba6f7;height:100%;width:{Math.min(voiceEnrollSeconds/10*100,100)}%;transition:width 1s linear"></div>
		</div>
	{:else}
		<button onclick={startVoiceEnroll} disabled={!voiceServerOk || voiceEnrollStatus === 'uploading'} style="width:100%;background:rgba(203,166,247,0.15);border:1px solid rgba(203,166,247,0.4);border-radius:5px;color:#cba6f7;padding:5px;font-size:12px;cursor:{voiceServerOk ? 'pointer' : 'not-allowed'};opacity:{voiceServerOk ? 1 : 0.5}">
			🎤 {voiceEnrollStatus === 'uploading' ? 'Processing...' : 'Record Sample (10s)'}
		</button>
	{/if}
	{#if voiceEnrollMsg}
		<div style="font-size:11px;margin-top:4px;color:{voiceEnrollStatus === 'error' ? '#f38ba8' : voiceEnrollStatus === 'done' ? '#a6e3a1' : '#6c7086'}">{voiceEnrollMsg}</div>
	{/if}

	<hr style="border:none;border-top:1px solid rgba(255,255,255,0.07);margin:10px 0 6px" />

	<!-- SECTION: State -->
	<div class="svc-category" style="display:flex;align-items:center;gap:6px">
		State
		<span style="font-size:10px;color:#6c7086">read of {m.commander}</span>
	</div>
	{#if !m.has_snapshot}
		<div class="empty-state" style="font-size:10px;color:#94a3b8;font-style:italic;margin:4px 0">No intuition data for {m.commander} yet — the daemon builds a snapshot once they have presence signals (screen, camera, mic, or terminal activity).</div>
	{/if}
	<div class="int-axes">
		<div class="int-axis"><span class="int-label">Where</span><span class="int-val">{m.where || '—'}</span></div>
		<div class="int-axis"><span class="int-label">Device</span><span class="int-val">{m.device || '—'}</span></div>
		<div class="int-axis"><span class="int-label">Activity</span><span class="int-val">{m.activity || '—'}</span></div>
		<div class="int-axis"><span class="int-label">Focus</span><span class="int-val">{m.focus || '—'}</span></div>
		<div class="int-axis"><span class="int-label">Mood</span><span class="int-val">{m.mood || '—'}</span></div>
		<div class="int-axis"><span class="int-label">Urgency</span><span class="int-val">{m.urgency || (m.has_snapshot ? 'normal' : '—')}</span></div>
		<div class="int-axis"><span class="int-label">Engagement</span><span class="int-val">{m.engagement || '—'}</span></div>
		<div class="int-axis">
			<span class="int-label">Assumption</span>
			<span class="int-val" class:wellbeing-ok={_assump === 'ok'} class:wellbeing-notok={_assump === 'not_ok'} class:wellbeing-emergency={_assump === 'emergency'}>{m.assumption || '—'}</span>
		</div>
		<div class="int-axis"><span class="int-label">Last heard</span><span class="int-val small">{m.last_heard ? `"${m.last_heard}"` : '—'}</span></div>
		<div class="int-axis"><span class="int-label">Topics</span><span class="int-val small">{(m.recent_topics || []).length > 0 ? m.recent_topics.slice(0, 3).join(', ') : '—'}</span></div>
		<div class="int-axis"><span class="int-label">Confidence</span><span class="int-val small">{Math.round((m.confidence || 0) * 100)}%</span></div>
		<div class="int-axis"><span class="int-label">Mood read</span><span class="int-val small" title={m.classifier || ''}>{m.classified_at ? agoStr(m.classified_at) : '—'}</span></div>
	</div>
	{#if m.has_snapshot}
		<div class="int-disclaimer">⚠ Not medical advice — PAN's assumptions only</div>
	{/if}
{/if}

<hr style="border:none;border-top:1px solid rgba(255,255,255,0.07);margin:10px 0 6px" />

<!-- SECTION: Motives (Life Needs bars) -->
{#if panNeeds.length > 0}
	{@const _trackedCount = panNeeds.filter(n => n.tracked).length}
	{@const _untrackedCount = panNeeds.length - _trackedCount}
	<div class="svc-category" style="display:flex;align-items:center;gap:6px">
		Motives
		<span style="font-size:10px;color:#6c7086">
			{_trackedCount} tracked{_untrackedCount > 0 ? ` · ${_untrackedCount} awaiting signal` : ''} · event-driven (task #492)
		</span>
	</div>
	<div class="needs-grid">
		{#each panNeeds as n}
			<div class="need-row" class:need-untracked={!n.tracked} title="{n.label} · weight {n.weight} · decay {n.decay_rate}/h · {n.cause || ''}">
				<span class="need-icon">{n.icon}</span>
				<span class="need-label">{n.label}</span>
				{#if n.tracked}
					<div class="need-bar-track">
						<div class="need-bar-fill" style="width:{n.level}%;background:{needBarColor(n.level)}"></div>
					</div>
					<span class="need-level" style="color:{needBarColor(n.level)}">{Math.round(n.level)}{#if n.stale}<span style="font-size:9px;color:#fab387;margin-left:3px" title="value can't be trusted — last event too old">⚠</span>{/if}</span>
				{:else}
					<span class="need-hint" style="flex:1;font-size:10px;color:#6c7086;font-style:italic;text-align:right">{n.hint || 'not tracked yet'}</span>
				{/if}
			</div>
			{#if n.tracked && n.cause}
				<div class="need-cause" style="font-size:10px;color:{n.stale ? '#fab387' : '#6c7086'};padding:0 6px 4px 22px;line-height:1.2;margin-top:-2px">{n.cause}</div>
			{/if}
		{/each}
	</div>
{/if}

<!-- TOP-LEVEL SECTION: PAN -->
<div style="margin-top:14px;padding-bottom:3px;margin-bottom:6px;font-size:11px;font-weight:700;color:#a6e3a1;letter-spacing:1.5px;border-bottom:1px solid rgba(166,227,161,0.3)">
	PAN
</div>

<!-- SECTION: PAN's Mind. `thinkingNow` is derived in the script. -->
<div class="svc-category" style="display:flex;align-items:center;gap:6px">
	PAN's Mind
	<span style="font-size:10px;padding:1px 6px;border-radius:3px;font-weight:600;background:{thinkingNow ? 'rgba(203,166,247,0.18)' : 'rgba(108,112,134,0.18)'};color:{thinkingNow ? '#cba6f7' : '#9399b2'}">
		{thinkingNow ? '🧠 thinking…' : 'Π idle'}
	</span>
</div>
{#if panThoughts.length > 0}
	{@const sensorOf = (src) => (
		src === 'intuition'    ? 'brain'
		: src === 'screen'     ? 'eye'
		: src === 'webcam'     ? 'eye'
		: src === 'router'     ? 'ear'
		: src === 'transcript' ? 'ear'
		: src === 'scout'      ? 'scout'
		: src === 'interjection' ? 'voice'
		: src === 'dream'      ? 'dream'
		: 'other'
	)}
	{@const sensorIcon = { brain: '🧠', eye: '👁', ear: '👂', scout: '🔭', voice: '🗣', dream: '💤', other: '·' }}
	{@const sensorColor = { brain: '#cba6f7', eye: '#89b4fa', ear: '#a6e3a1', scout: '#f9e2af', voice: '#fab387', dream: '#f5c2e7', other: '#9399b2' }}
	{@const sensorLabel = { brain: 'think', eye: 'see', ear: 'hear', scout: 'scout', voice: 'speak', dream: 'dream', other: 'other' }}

	<!-- Synthesis paragraph + reasoning steps -->
	{@const synthAgeMs = panSynthesis?.generated_at_ms ? (Date.now() - panSynthesis.generated_at_ms) : null}
	{@const synthAgeStr = synthAgeMs == null ? '' : synthAgeMs < 60_000 ? `${Math.round(synthAgeMs/1000)}s ago` : synthAgeMs < 3_600_000 ? `${Math.round(synthAgeMs/60_000)}m ago` : `${Math.round(synthAgeMs/3_600_000)}h ago`}
	{@const reasoningSteps = panSynthesis?.steps || []}
	<div style="margin:6px 0 10px;padding:8px 10px;background:rgba(203,166,247,0.06);border-left:2px solid rgba(203,166,247,0.45);border-radius:3px;font-size:12px;color:#cdd6f4;line-height:1.55">
		<div style="display:flex;align-items:center;gap:6px;font-size:9px;font-weight:700;color:#cba6f7;letter-spacing:1px;margin-bottom:4px">
			SYNTHESIS
			{#if reasoningSteps.length > 0}
				<button onclick={() => panReasoningOpen = !panReasoningOpen} style="margin-left:auto;background:none;border:1px solid rgba(203,166,247,0.3);color:#cba6f7;font-size:9px;font-weight:600;letter-spacing:1px;border-radius:3px;padding:1px 6px;cursor:pointer">{panReasoningOpen ? '▾ HIDE STEPS' : '▸ SHOW STEPS'} ({reasoningSteps.length})</button>
			{/if}
		</div>
		{#if panSynthesis && !panSynthesis.ok}
			<div style="display:flex;align-items:center;gap:6px;color:#fab387;font-size:11px">
				<span style="flex:1">Couldn't reason it through{panSynthesis.error ? ` (${panSynthesis.error})` : ''}{synthAgeStr ? ` · ${synthAgeStr}` : ''}</span>
				<button onclick={() => forcePanSynthesis()} style="background:none;border:1px solid rgba(255,255,255,0.12);color:#9399b2;font-size:9px;border-radius:3px;padding:1px 5px;cursor:pointer" title="Force a fresh reasoning cycle">↻ rethink</button>
			</div>
		{:else if panSynthesis?.synthesis}
			<div style="color:#cdd6f4;font-size:12px;line-height:1.55">{panSynthesis.synthesis}</div>
			{#if panReasoningOpen && reasoningSteps.length > 0}
				{@const kindColor = { observe:'#a6e3a1', recall:'#89b4fa', notice:'#f9e2af', contradict:'#f38ba8', infer:'#cba6f7', question:'#94e2d5', doubt:'#fab387', intend:'#f5c2e7', commit:'#cba6f7' }}
				<div style="margin-top:8px;padding-top:8px;border-top:1px dashed rgba(255,255,255,0.08);display:flex;flex-direction:column;gap:4px">
					{#each reasoningSteps as step}
						{@const kc = kindColor[step.kind] || '#9399b2'}
						<div style="display:flex;align-items:flex-start;gap:6px;font-size:11px">
							<span style="flex:0 0 70px;font-size:9px;font-weight:700;color:{kc};letter-spacing:1px;text-transform:uppercase;padding-top:2px">{step.kind}</span>
							<span style="flex:1;color:#cdd6f4;line-height:1.4">
								{step.value}
								{#if step.subject || step.predicate}
									<span style="color:#6c7086;font-size:9px"> · {step.subject || ''}{step.predicate ? `.${step.predicate}` : ''}</span>
								{/if}
								{#if step.conf != null}
									<span style="color:#585b70;font-size:9px"> · conf {(step.conf * 100).toFixed(0)}%</span>
								{/if}
								{#if step.refs && step.refs.length}
									<span style="color:#585b70;font-size:9px"> · refs {step.refs.map(r => `${r.type}#${r.id}`).join(', ')}</span>
								{/if}
								{#if step.parents && step.parents.length}
									<span style="color:#585b70;font-size:9px"> ← from step{step.parents.length > 1 ? 's' : ''} {step.parents.join(', ')}</span>
								{/if}
							</span>
						</div>
					{/each}
				</div>
			{/if}
			<div style="margin-top:5px;font-size:9px;color:#6c7086;display:flex;align-items:center;gap:6px">
				<span>{synthAgeStr ? `${synthAgeStr}` : ''}</span>
				{#if (panSynthesis.sources_used || []).length}
					<span>· sources: {panSynthesis.sources_used.join(' · ')}</span>
				{/if}
				{#if panSynthesis.cached}<span style="opacity:0.6">· cached</span>{/if}
				<button onclick={() => forcePanSynthesis()} style="margin-left:auto;background:none;border:1px solid rgba(255,255,255,0.12);color:#9399b2;font-size:9px;border-radius:3px;padding:1px 5px;cursor:pointer" title="Force a fresh reasoning cycle">↻ rethink</button>
			</div>
		{:else}
			<div style="color:#6c7086;font-size:11px;font-style:italic">thinking…</div>
		{/if}
	</div>

	<div class="thought-stream" style="margin-top:6px">
		{#each panThoughts.slice(0, 8) as t}
			{@const tsMs = t.ts ? Date.parse(t.ts.replace(' ', 'T')) : null}
			{@const ageMs = tsMs ? (Date.now() - tsMs) : null}
			{@const ageStr = ageMs == null ? '' : ageMs < 60_000 ? `${Math.round(ageMs/1000)}s` : ageMs < 3_600_000 ? `${Math.round(ageMs/60_000)}m` : `${Math.round(ageMs/3_600_000)}h`}
			{@const sens = sensorOf(t.source)}
			{@const srcColor = sensorColor[sens]}
			{@const srcIcon = sensorIcon[sens]}
			<div class="thought-row">
				<span class="thought-source" style="color:{srcColor}" title="{sensorLabel[sens]} · {t.source}">{srcIcon}</span>
				<span class="thought-text">{t.thought}</span>
				<span class="thought-age" title={t.ts}>{ageStr}</span>
			</div>
		{/each}
	</div>
{/if}

<!-- SECTION: Recent Actions -->
{#if (pan.recent_actions || []).length > 0}
	<div class="svc-category" style="display:flex;align-items:center;gap:6px">
		Recent Actions
	</div>
	<div class="int-axes">
		{#each (pan.recent_actions || []).slice(0, 5) as act}
			<div class="int-axis"><span class="int-val small">{act.action}</span></div>
		{/each}
	</div>
{/if}

<!-- SECTION: Tasks -->
{#if (pan.active_tasks || []).length > 0}
	<div class="svc-category" style="display:flex;align-items:center;gap:6px">
		Tasks
		<span style="font-size:10px;color:#6c7086">in flight</span>
	</div>
	<div class="int-axes">
		{#each (pan.active_tasks || []).slice(0, 5) as task}
			<div class="int-axis task">
				<span class="int-label task-status" class:in-progress={task.status === 'in_progress'}>{task.status === 'in_progress' ? '◆' : '○'}</span>
				<span class="int-val">{task.title}</span>
			</div>
		{/each}
	</div>
{/if}

<!-- SECTION: Predictions -->
{#if preds.length > 0}
	<div class="svc-category" style="display:flex;align-items:center;gap:6px">
		Predictions
		<span style="font-size:10px;color:#6c7086">what PAN thinks comes next</span>
	</div>
	<div class="int-axes">
		{#each preds as p}
			<div class="int-axis pred">
				<span class="int-val">{p.what}</span>
				<span class="int-confidence">{Math.round((p.confidence || 0) * 100)}%</span>
			</div>
		{/each}
	</div>
{/if}

<style>
	/* ════════════════════════════════════════════════════════════════════════
	   Lifted from L12387-L12482 of +page.svelte. Scoped to this component
	   in Svelte 5 — these class names only style elements rendered by
	   IntuitionPanel.svelte. The same names still exist in +page.svelte
	   (left/right column wrapper containers, etc.) but Svelte's per-component
	   CSS hashing keeps them from colliding.
	   ════════════════════════════════════════════════════════════════════════ */
	.int-header {
		display: flex; justify-content: space-between; align-items: center;
		padding: 8px 4px; margin-bottom: 4px; border-bottom: 1px solid #313244;
	}
	.int-ago { font-size: 11px; color: #6c7086; }
	.int-axes { padding: 2px 0 6px 0; }
	.int-axis {
		display: flex; align-items: baseline; gap: 6px;
		padding: 3px 4px; font-size: 12px;
		min-width: 0;
	}
	.int-label, .int-val { overflow-wrap: anywhere; word-break: break-word; }
	.int-axis:hover { background: #1e1e2e; border-radius: 4px; }
	.int-label { color: #6c7086; min-width: 80px; flex-shrink: 0; }
	.int-val { color: #cdd6f4; word-break: break-word; }
	.int-val.small { font-size: 11px; color: #a6adc8; }
	.int-axis.task { padding-left: 12px; }
	.int-axis.task .int-label { min-width: auto; }
	.task-status { color: #6c7086; }
	.task-status.in-progress { color: #f9e2af; }
	.int-axis.pred { justify-content: space-between; }
	.int-confidence {
		color: #a6e3a1; font-size: 11px; flex-shrink: 0;
		background: #1e1e2e; padding: 1px 6px; border-radius: 8px;
	}
	.int-disclaimer {
		font-size: 10px; color: #585b70; padding: 4px 4px 2px;
		font-style: italic;
	}
	.wellbeing-ok { color: #a6e3a1; }
	.wellbeing-notok { color: #f9e2af; }
	.wellbeing-emergency { color: #f38ba8; font-weight: 700; }

	/* Life Needs — Sims-style motive bars */
	.needs-grid {
		padding: 2px 0 8px 0; display: flex; flex-direction: column; gap: 3px;
	}
	.need-row {
		display: flex; align-items: center; gap: 6px;
		padding: 3px 4px; font-size: 12px; min-width: 0;
	}
	.need-icon { flex-shrink: 0; width: 16px; text-align: center; font-size: 13px; }
	.need-label {
		flex-shrink: 0; width: 90px; color: #a6adc8;
		overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
	}
	.need-bar-track {
		flex: 1 1 auto; min-width: 30px; height: 8px;
		background: rgba(255,255,255,0.06); border-radius: 4px; overflow: hidden;
	}
	.need-bar-fill { height: 100%; border-radius: 4px; transition: width 0.4s ease, background 0.4s ease; }
	.need-level {
		flex-shrink: 0; width: 28px; text-align: right;
		font-variant-numeric: tabular-nums; font-weight: 600; font-size: 11px;
	}

	/* PAN's thought stream */
	.thought-stream { padding: 2px 0 8px 0; display: flex; flex-direction: column; gap: 4px; }
	.thought-row {
		display: flex; align-items: flex-start; gap: 6px;
		padding: 5px 6px; font-size: 12px; line-height: 1.4;
		background: rgba(255,255,255,0.02); border-radius: 5px;
		border-left: 2px solid rgba(203,166,247,0.25);
		min-width: 0;
	}
	.thought-source { flex-shrink: 0; font-size: 13px; line-height: 1.3; width: 16px; text-align: center; }
	.thought-text   { flex: 1; min-width: 0; color: #cdd6f4; overflow-wrap: anywhere; word-break: break-word; }
	.thought-age    { flex-shrink: 0; color: #6c7086; font-size: 10px; font-family: ui-monospace, monospace; align-self: flex-end; }

	/* Shared classes — used in this component's template AND in +page.svelte.
	   Mark :global so the rule applies to the rendered DOM regardless of
	   where the element was authored. .svc-category is a section heading
	   used by Services / Devices / Tasks etc. too, so global is correct. */
	:global(.svc-category) {
		font-size: 10px; font-weight: 600; letter-spacing: 1px;
		text-transform: uppercase; color: #cba6f7;
		padding: 8px 4px 4px; margin-top: 4px;
	}
	:global(.empty-state) {
		text-align: center; color: #6c7086; padding: 12px 4px;
	}
</style>
