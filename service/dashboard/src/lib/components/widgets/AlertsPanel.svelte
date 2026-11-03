<!--
  AlertsPanel.svelte — extracted from terminal/+page.svelte (Shape-2 refactor).

  System alerts panel with severity badges, status filter, type filter, and
  per-alert acknowledge/resolve/dismiss/reopen actions.

  Self-contained: fetches its own list + types + count, subscribes to the WS
  push the parent dispatches via `pan:alerts-update` event.

  Exposes `openCount` as a $bindable prop so the parent can show "(N)" in the
  panel-selector dropdown.
-->
<script>
	import { onMount, onDestroy } from 'svelte';
	import { api } from '$lib/api.js';

	let { openCount = $bindable(0) } = $props();

	let alertsData = $state([]);
	let alertTypes = $state([]);
	let alertFilterType = $state('all');
	let alertFilterStatus = $state('open');
	let alertFlash = $state(false);

	async function loadAlerts() {
		try {
			const params = new URLSearchParams();
			if (alertFilterStatus !== 'all') params.set('status', alertFilterStatus);
			if (alertFilterType !== 'all') params.set('type', alertFilterType);
			params.set('limit', '50');
			const resp = await api(`/dashboard/api/alerts?${params}`);
			alertsData = Array.isArray(resp) ? resp : [];
		} catch { alertsData = []; }
	}

	async function loadAlertCount() {
		try {
			const resp = await api('/dashboard/api/alerts/count');
			const newCount = resp?.count || 0;
			if (newCount > openCount && openCount >= 0) {
				alertFlash = true;
				setTimeout(() => { alertFlash = false; }, 3000);
			}
			openCount = newCount;
		} catch {}
	}

	async function loadAlertTypes() {
		try {
			const resp = await api('/dashboard/api/alerts/types');
			alertTypes = Array.isArray(resp) ? resp : [];
		} catch { alertTypes = []; }
	}

	async function updateAlertStatus(alertId, status, resolution = '') {
		try {
			await fetch(`/dashboard/api/alerts/${alertId}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ status, resolution, resolved_by: 'user' })
			});
			await loadAlerts();
			await loadAlertCount();
		} catch {}
	}

	let _wsHandler = null;
	onMount(() => {
		loadAlerts();
		loadAlertCount();
		loadAlertTypes();
		_wsHandler = () => { loadAlerts(); loadAlertCount(); };
		if (typeof window !== 'undefined') {
			window.addEventListener('pan:alerts-update', _wsHandler);
		}
	});
	onDestroy(() => {
		if (typeof window !== 'undefined' && _wsHandler) {
			window.removeEventListener('pan:alerts-update', _wsHandler);
		}
	});
</script>

<div class="alerts-panel">
	<div class="alerts-filters">
		<select class="alert-filter-select" bind:value={alertFilterStatus} onchange={loadAlerts}>
			<option value="open">Open</option>
			<option value="acknowledged">Acknowledged</option>
			<option value="resolved">Resolved</option>
			<option value="dismissed">Dismissed</option>
			<option value="all">All</option>
		</select>
		<select class="alert-filter-select" bind:value={alertFilterType} onchange={loadAlerts}>
			<option value="all">All Types</option>
			{#each alertTypes as t}
				<option value={t.id}>{t.label}</option>
			{/each}
		</select>
	</div>
	{#if alertsData.length === 0}
		<div class="empty-state">No {alertFilterStatus === 'all' ? '' : alertFilterStatus} alerts</div>
	{:else}
		{#each alertsData as alert}
			<div class="alert-card" class:critical={alert.severity === 'critical'} class:warning={alert.severity === 'warning'} class:info={alert.severity === 'info'}>
				<div class="alert-header">
					<span class="alert-severity-dot {alert.severity}"></span>
					<span class="alert-type-badge">{alert.alert_type.replace(/_/g, ' ')}</span>
					<span class="alert-time">{new Date(alert.created_at).toLocaleTimeString()}</span>
				</div>
				<div class="alert-title">{alert.title}</div>
				{#if alert.detail}
					{@const parsed = (() => { try { return JSON.parse(alert.detail); } catch { return null; } })()}
					{#if parsed}
						<div class="alert-detail">
							{#if parsed.orphans}{#each parsed.orphans as o}<div class="alert-detail-line">PID {o.pid} — {o.ageMin}min old</div>{/each}{/if}
							{#if parsed.hint}<div class="alert-hint">{parsed.hint}</div>{/if}
							{#if parsed.message}<div class="alert-detail-line">{parsed.message}</div>{/if}
							{#if parsed.stack}<details class="alert-stack"><summary>Stack trace</summary><pre>{parsed.stack}</pre></details>{/if}
						</div>
					{:else}
						<div class="alert-detail"><div class="alert-detail-line">{alert.detail}</div></div>
					{/if}
				{/if}
				{#if alert.resolution}<div class="alert-resolution">Resolution: {alert.resolution}</div>{/if}
				{#if alert.status === 'open'}
					<div class="alert-actions">
						<button class="alert-btn ack" onclick={() => updateAlertStatus(alert.id, 'acknowledged')}>Acknowledge</button>
						<button class="alert-btn resolve" onclick={() => { const res = prompt('Resolution notes (optional):'); if (res !== null) updateAlertStatus(alert.id, 'resolved', res); }}>Resolve</button>
						<button class="alert-btn dismiss" onclick={() => updateAlertStatus(alert.id, 'dismissed')}>Dismiss</button>
					</div>
				{:else if alert.status === 'acknowledged'}
					<div class="alert-actions">
						<button class="alert-btn resolve" onclick={() => { const res = prompt('Resolution notes (optional):'); if (res !== null) updateAlertStatus(alert.id, 'resolved', res); }}>Resolve</button>
						<button class="alert-btn dismiss" onclick={() => updateAlertStatus(alert.id, 'dismissed')}>Dismiss</button>
					</div>
				{:else if alert.status === 'resolved' || alert.status === 'dismissed'}
					<div class="alert-actions">
						<button class="alert-btn reopen" onclick={() => updateAlertStatus(alert.id, 'open')}>Reopen</button>
					</div>
				{/if}
				<div class="alert-meta">{alert.status}{#if alert.resolved_at} — resolved {new Date(alert.resolved_at).toLocaleString()}{/if}{#if alert.resolved_by} by {alert.resolved_by}{/if}</div>
			</div>
		{/each}
	{/if}
</div>
