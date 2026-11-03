<!--
  LifeboatPanel.svelte — Carrier swap / rollback widget.
  Self-managed: polls /api/carrier/status, dispatches rollback/confirm/swap.
-->
<script>
	import { onMount, onDestroy } from 'svelte';

	let lifeboatData = $state(null);
	let lifeboatSwapping = $state(false);
	let lifeboatSwapStarted = 0;
	let lifeboatRollbackMs = 0;
	let nowTick = $state(Date.now());
	let _pollTimer = null;
	let _tickTimer = null;

	async function loadLifeboat() {
		try {
			const r = await fetch('/api/carrier/status');
			if (r.ok) {
				const d = await r.json();
				lifeboatData = d;
				if (d.swapPending && d.rollbackAvailable) {
					if (!lifeboatSwapStarted) {
						try {
							const lb = await fetch('/lifeboat/status');
							if (lb.ok) {
								const lbd = await lb.json();
								lifeboatRollbackMs = lbd.rollbackTimeoutMs || 0;
								lifeboatSwapStarted = Date.now();
							}
						} catch {}
					}
				} else {
					lifeboatRollbackMs = 0;
					lifeboatSwapStarted = 0;
				}
			}
		} catch {}
	}

	async function lifeboatRollback() {
		try { await fetch('/lifeboat/rollback', { method: 'POST' }); await loadLifeboat(); } catch {}
	}
	async function lifeboatConfirm() {
		try { await fetch('/lifeboat/confirm', { method: 'POST' }); await loadLifeboat(); } catch {}
	}
	async function lifeboatSwap() {
		lifeboatSwapping = true;
		try { await fetch('/api/carrier/swap', { method: 'POST' }); await loadLifeboat(); } catch {}
		lifeboatSwapping = false;
	}

	function formatUptime(seconds) {
		if (!seconds && seconds !== 0) return '--';
		if (seconds < 60) return `${Math.floor(seconds)}s`;
		if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`;
		const h = Math.floor(seconds / 3600);
		const m = Math.floor((seconds % 3600) / 60);
		return `${h}h ${m}m`;
	}

	onMount(() => {
		loadLifeboat();
		// Lifeboat is critical — poll every 30s
		_pollTimer = setInterval(loadLifeboat, 30_000);
		// 1s tick for live rollback countdown
		_tickTimer = setInterval(() => { nowTick = Date.now(); }, 1000);
	});
	onDestroy(() => {
		if (_pollTimer) clearInterval(_pollTimer);
		if (_tickTimer) clearInterval(_tickTimer);
	});

	const rollbackLeft = $derived(
		lifeboatSwapStarted > 0
			? Math.max(0, Math.ceil((lifeboatRollbackMs - (nowTick - lifeboatSwapStarted)) / 1000))
			: 0
	);
</script>

<div class="lifeboat-panel">
	{#if !lifeboatData}
		<div class="empty-state">Connecting to Carrier...</div>
	{:else}
		<div class="svc-category">Carrier</div>
		<div class="svc-row">
			<span class="svc-dot up"></span>
			<div class="svc-info">
				<div class="svc-name">PID {lifeboatData.carrier?.pid || '--'}</div>
				<div class="svc-detail">Uptime: {formatUptime(lifeboatData.carrier?.uptime)}</div>
			</div>
		</div>
		<div class="svc-category">Active Craft</div>
		{#if lifeboatData.primaryCraft}
			<div class="svc-row">
				<span class="svc-dot" class:up={lifeboatData.primaryCraft.healthy} class:down={!lifeboatData.primaryCraft.healthy}></span>
				<div class="svc-info">
					<div class="svc-name">Craft-{lifeboatData.primaryCraft.id}</div>
					<div class="svc-detail">{lifeboatData.primaryCraft.gitCommit?.slice(0,7) || '--'} | Port {lifeboatData.primaryCraft.port} | Up {formatUptime(lifeboatData.primaryCraft.uptime / 1000)}</div>
				</div>
			</div>
		{:else}
			<div class="empty-state">No active Craft</div>
		{/if}
		{#if lifeboatData.swapPending && lifeboatData.previousCraft}
			<div class="svc-category">Rollback Window</div>
			<div class="svc-row">
				<span class="svc-dot" class:up={lifeboatData.previousCraft.healthy} class:down={!lifeboatData.previousCraft.healthy}></span>
				<div class="svc-info">
					<div class="svc-name">Craft-{lifeboatData.previousCraft.id} (previous)</div>
					<div class="svc-detail">{lifeboatData.previousCraft.gitCommit?.slice(0,7) || '--'} | Port {lifeboatData.previousCraft.port}</div>
				</div>
			</div>
			{#if rollbackLeft > 0}
				<div class="lifeboat-countdown">Rollback expires in {rollbackLeft}s</div>
			{/if}
			<div class="lifeboat-actions">
				<button class="lifeboat-btn rollback" onclick={lifeboatRollback}>Rollback</button>
				<button class="lifeboat-btn confirm" onclick={lifeboatConfirm}>Confirm</button>
			</div>
		{/if}
		{#if lifeboatData.shadowCraft}
			<div class="svc-category">Shadow</div>
			<div class="svc-row">
				<span class="svc-dot unknown"></span>
				<div class="svc-info">
					<div class="svc-name">Craft-{lifeboatData.shadowCraft.id} (shadow)</div>
					<div class="svc-detail">Testing...</div>
				</div>
			</div>
		{/if}
		<div class="svc-category" style="margin-top:12px">Actions</div>
		<div class="lifeboat-actions">
			<button class="lifeboat-btn swap" onclick={lifeboatSwap} disabled={lifeboatSwapping}>
				{lifeboatSwapping ? 'Swapping...' : 'Hot Swap'}
			</button>
			<button class="lifeboat-btn" style="background:#cba6f7;color:#1e1e2e" onclick={() => {
				fetch('/api/v1/ui-commands', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ type: 'open_window', url: `http://localhost:${location.port || 7777}/v2/crucible`, title: 'Crucible', width: 1200, height: 800 })
				});
			}}>Open Crucible</button>
		</div>
	{/if}
</div>
