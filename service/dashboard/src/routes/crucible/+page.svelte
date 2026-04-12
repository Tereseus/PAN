<script>
	import { onMount, onDestroy } from 'svelte';

	let shadowStatus = $state(null);
	let crucibleData = $state([]);
	let crucibleTotal = $state(0);
	let carrierStatus = $state(null);
	let loading = $state(true);
	let launching = $state(false);
	let promoting = $state(false);
	let rejecting = $state(false);
	let showMismatchOnly = $state(false);
	let pollTimer = null;
	let flash = $state('');

	function showFlash(msg) {
		flash = msg;
		setTimeout(() => flash = '', 4000);
	}

	async function api(path, opts = {}) {
		try {
			const r = await fetch(path, opts);
			return r.json();
		} catch (e) {
			return { error: e.message };
		}
	}

	async function refresh() {
		const [status, shadow, crucible] = await Promise.all([
			api('/api/carrier/status'),
			api('/api/carrier/shadow/stats'),
			api(`/api/carrier/crucible?limit=200${showMismatchOnly ? '&mismatches=1' : ''}`),
		]);
		carrierStatus = status;
		shadowStatus = shadow;
		crucibleData = crucible?.results || [];
		crucibleTotal = crucible?.total || 0;
		loading = false;
	}

	async function launchShadow() {
		launching = true;
		const res = await api('/api/carrier/shadow', { method: 'POST' });
		if (res.ok) {
			showFlash('Shadow Craft launching...');
		} else {
			showFlash(res.error || 'Failed to launch shadow');
		}
		launching = false;
		await refresh();
	}

	async function promoteShadow() {
		if (!confirm('Promote shadow to primary? (30s rollback window)')) return;
		promoting = true;
		const res = await api('/api/carrier/shadow/promote', { method: 'POST' });
		if (res.ok) {
			showFlash(`Shadow promoted to primary (Craft-${res.newPrimaryId})`);
		} else {
			showFlash(res.error || 'Promote failed');
		}
		promoting = false;
		await refresh();
	}

	async function rejectShadow() {
		if (!confirm('Kill shadow Craft?')) return;
		rejecting = true;
		const res = await api('/api/carrier/shadow', { method: 'DELETE' });
		if (res.ok) {
			showFlash('Shadow rejected and killed');
		} else {
			showFlash(res.error || 'Reject failed');
		}
		rejecting = false;
		await refresh();
	}

	onMount(() => {
		refresh();
		pollTimer = setInterval(refresh, 3000);
	});

	onDestroy(() => {
		if (pollTimer) clearInterval(pollTimer);
	});

	function statusColor(healthy) {
		return healthy ? '#a6e3a1' : '#f38ba8';
	}

	function matchColor(match) {
		if (match === true) return '#a6e3a1';
		if (match === false) return '#f38ba8';
		return '#6c7086';
	}

	function fmtMs(ms) {
		if (!ms && ms !== 0) return '—';
		return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
	}

	function fmtTime(ts) {
		return new Date(ts).toLocaleTimeString();
	}

	function fmtUptime(ms) {
		if (!ms) return '—';
		const s = Math.floor(ms / 1000);
		if (s < 60) return `${s}s`;
		if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
		return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
	}
</script>

<svelte:head>
	<title>Crucible — PAN</title>
</svelte:head>

<div class="crucible">
	{#if flash}
		<div class="flash">{flash}</div>
	{/if}

	<header>
		<h1>Crucible</h1>
		<span class="subtitle">Shadow Traffic & Variant Comparison</span>
	</header>

	{#if loading}
		<div class="loading">Loading Carrier status...</div>
	{:else}
		<!-- Carrier Overview -->
		<section class="cards">
			<div class="card">
				<div class="card-title">Carrier</div>
				<div class="card-row">
					<span class="label">PID</span>
					<span>{carrierStatus?.carrier?.pid || '—'}</span>
				</div>
				<div class="card-row">
					<span class="label">Uptime</span>
					<span>{fmtUptime((carrierStatus?.carrier?.uptime || 0) * 1000)}</span>
				</div>
				<div class="card-row">
					<span class="label">Git</span>
					<span class="mono">{carrierStatus?.carrier?.gitCommit || '—'}</span>
				</div>
			</div>

			<div class="card">
				<div class="card-title">Primary Craft</div>
				{#if carrierStatus?.primaryCraft}
					<div class="card-row">
						<span class="label">Craft ID</span>
						<span style="color: {statusColor(carrierStatus.primaryCraft.healthy)}">
							#{carrierStatus.primaryCraft.id} {carrierStatus.primaryCraft.healthy ? '(healthy)' : '(unhealthy)'}
						</span>
					</div>
					<div class="card-row">
						<span class="label">Port</span>
						<span class="mono">{carrierStatus.primaryCraft.port}</span>
					</div>
					<div class="card-row">
						<span class="label">Uptime</span>
						<span>{fmtUptime(carrierStatus.primaryCraft.uptime)}</span>
					</div>
					<div class="card-row">
						<span class="label">Git</span>
						<span class="mono">{carrierStatus.primaryCraft.gitCommit}</span>
					</div>
				{:else}
					<div class="card-row" style="color:#f38ba8">No primary Craft</div>
				{/if}
			</div>

			<div class="card" class:card-active={shadowStatus?.shadow}>
				<div class="card-title">Shadow Craft</div>
				{#if shadowStatus?.shadow}
					<div class="card-row">
						<span class="label">Craft ID</span>
						<span style="color: {statusColor(shadowStatus.shadow.healthy)}">
							#{shadowStatus.shadow.id} {shadowStatus.shadow.healthy ? '(healthy)' : '(starting...)'}
						</span>
					</div>
					<div class="card-row">
						<span class="label">Port</span>
						<span class="mono">{shadowStatus.shadow.port}</span>
					</div>
					<div class="card-row">
						<span class="label">Uptime</span>
						<span>{fmtUptime(shadowStatus.shadow.uptime)}</span>
					</div>
					<div class="card-row">
						<span class="label">Git</span>
						<span class="mono">{shadowStatus.shadow.gitCommit}</span>
					</div>
				{:else}
					<div class="card-row" style="color:#6c7086">No shadow running</div>
				{/if}
			</div>
		</section>

		<!-- Shadow Controls -->
		<section class="controls">
			{#if !shadowStatus?.shadow}
				<button class="btn btn-launch" onclick={launchShadow} disabled={launching}>
					{launching ? 'Launching...' : 'Launch Shadow Craft'}
				</button>
			{:else}
				<button class="btn btn-promote" onclick={promoteShadow} disabled={promoting}>
					{promoting ? 'Promoting...' : 'Promote to Primary'}
				</button>
				<button class="btn btn-reject" onclick={rejectShadow} disabled={rejecting}>
					{rejecting ? 'Rejecting...' : 'Reject & Kill'}
				</button>
			{/if}
		</section>

		<!-- Shadow Stats -->
		{#if shadowStatus?.stats?.startedAt}
			<section class="stats">
				<h2>Shadow Traffic Stats</h2>
				<div class="stat-grid">
					<div class="stat">
						<div class="stat-value">{shadowStatus.stats.mirrored}</div>
						<div class="stat-label">Mirrored</div>
					</div>
					<div class="stat">
						<div class="stat-value" style="color:#f38ba8">{shadowStatus.stats.errors}</div>
						<div class="stat-label">Errors</div>
					</div>
					<div class="stat">
						<div class="stat-value">{shadowStatus.comparison?.matchRate || 'N/A'}</div>
						<div class="stat-label">Match Rate</div>
					</div>
					<div class="stat">
						<div class="stat-value">{fmtMs(shadowStatus.comparison?.avgPrimaryLatencyMs)}</div>
						<div class="stat-label">Primary Avg</div>
					</div>
					<div class="stat">
						<div class="stat-value">{fmtMs(shadowStatus.comparison?.avgShadowLatencyMs)}</div>
						<div class="stat-label">Shadow Avg</div>
					</div>
					<div class="stat">
						<div class="stat-value" style="color:#a6e3a1">{shadowStatus.stats.promoted}</div>
						<div class="stat-label">Promoted</div>
					</div>
					<div class="stat">
						<div class="stat-value" style="color:#f38ba8">{shadowStatus.stats.rejected}</div>
						<div class="stat-label">Rejected</div>
					</div>
				</div>
			</section>
		{/if}

		<!-- Crucible Comparison Table -->
		<section class="crucible-results">
			<div class="results-header">
				<h2>Crucible Results ({crucibleTotal} total)</h2>
				<label class="toggle">
					<input type="checkbox" bind:checked={showMismatchOnly} onchange={refresh} />
					Mismatches only
				</label>
			</div>

			{#if crucibleData.length === 0}
				<div class="empty">
					{shadowStatus?.shadow
						? 'Waiting for traffic... Send requests to PAN and both primary + shadow will process them.'
						: 'Launch a shadow Craft to start collecting comparison data.'}
				</div>
			{:else}
				<div class="table-wrap">
					<table>
						<thead>
							<tr>
								<th>Time</th>
								<th>Method</th>
								<th>Path</th>
								<th>Primary</th>
								<th>Shadow</th>
								<th>Match</th>
								<th>P Latency</th>
								<th>S Latency</th>
							</tr>
						</thead>
						<tbody>
							{#each crucibleData.slice().reverse() as entry}
								<tr class:mismatch={entry.match === false}>
									<td class="mono">{fmtTime(entry.ts)}</td>
									<td class="method">{entry.method}</td>
									<td class="path mono">{entry.path?.split('?')[0]}</td>
									<td style="color:{entry.primary?.status < 400 ? '#a6e3a1' : '#f38ba8'}">
										{entry.primary?.status || '—'}
									</td>
									<td style="color:{entry.shadow?.status < 400 ? '#a6e3a1' : entry.shadow?.error ? '#f38ba8' : '#f9e2af'}">
										{entry.shadow?.error ? 'ERR' : entry.shadow?.status || '—'}
									</td>
									<td style="color:{matchColor(entry.match)}">
										{entry.match === true ? 'YES' : entry.match === false ? 'NO' : '...'}
									</td>
									<td class="mono">{fmtMs(entry.primary?.latencyMs)}</td>
									<td class="mono">{fmtMs(entry.shadow?.latencyMs)}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{/if}
		</section>

		<!-- Rollback Status -->
		{#if carrierStatus?.swapPending}
			<section class="rollback-banner">
				Swap pending — rollback available! Previous Craft-{carrierStatus.previousCraft?.id} is still alive.
			</section>
		{/if}
	{/if}
</div>

<style>
	.crucible {
		font-family: 'Inter', -apple-system, sans-serif;
		background: #1e1e2e;
		color: #cdd6f4;
		min-height: 100vh;
		padding: 24px;
		max-width: 1200px;
		margin: 0 auto;
	}

	header {
		margin-bottom: 24px;
	}

	h1 {
		font-size: 28px;
		font-weight: 700;
		color: #cba6f7;
		margin: 0;
	}

	h2 {
		font-size: 18px;
		font-weight: 600;
		color: #cdd6f4;
		margin: 0;
	}

	.subtitle {
		color: #6c7086;
		font-size: 14px;
	}

	.loading {
		color: #6c7086;
		padding: 40px;
		text-align: center;
	}

	.flash {
		position: fixed;
		top: 12px;
		right: 12px;
		background: #313244;
		color: #f9e2af;
		padding: 10px 18px;
		border-radius: 8px;
		border: 1px solid #45475a;
		z-index: 1000;
		font-size: 14px;
		animation: fadeIn 0.2s;
	}

	@keyframes fadeIn { from { opacity: 0; transform: translateY(-10px); } to { opacity: 1; } }

	/* Cards */
	.cards {
		display: grid;
		grid-template-columns: repeat(3, 1fr);
		gap: 16px;
		margin-bottom: 20px;
	}

	.card {
		background: #181825;
		border: 1px solid #313244;
		border-radius: 12px;
		padding: 16px;
	}

	.card-active {
		border-color: #cba6f7;
		box-shadow: 0 0 12px rgba(203, 166, 247, 0.15);
	}

	.card-title {
		font-weight: 600;
		font-size: 15px;
		margin-bottom: 10px;
		color: #cba6f7;
	}

	.card-row {
		display: flex;
		justify-content: space-between;
		padding: 3px 0;
		font-size: 13px;
	}

	.label {
		color: #6c7086;
	}

	.mono {
		font-family: 'JetBrains Mono', 'Fira Code', monospace;
		font-size: 12px;
	}

	/* Controls */
	.controls {
		display: flex;
		gap: 12px;
		margin-bottom: 20px;
	}

	.btn {
		padding: 10px 20px;
		border: none;
		border-radius: 8px;
		font-size: 14px;
		font-weight: 600;
		cursor: pointer;
		transition: all 0.15s;
	}

	.btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.btn-launch {
		background: #cba6f7;
		color: #1e1e2e;
	}
	.btn-launch:hover:not(:disabled) { background: #b490e0; }

	.btn-promote {
		background: #a6e3a1;
		color: #1e1e2e;
	}
	.btn-promote:hover:not(:disabled) { background: #8fd18a; }

	.btn-reject {
		background: #f38ba8;
		color: #1e1e2e;
	}
	.btn-reject:hover:not(:disabled) { background: #e07090; }

	/* Stats */
	.stats {
		margin-bottom: 20px;
	}

	.stat-grid {
		display: grid;
		grid-template-columns: repeat(7, 1fr);
		gap: 12px;
		margin-top: 12px;
	}

	.stat {
		background: #181825;
		border: 1px solid #313244;
		border-radius: 8px;
		padding: 12px;
		text-align: center;
	}

	.stat-value {
		font-size: 22px;
		font-weight: 700;
		font-family: 'JetBrains Mono', monospace;
	}

	.stat-label {
		font-size: 11px;
		color: #6c7086;
		margin-top: 4px;
		text-transform: uppercase;
		letter-spacing: 0.5px;
	}

	/* Results */
	.crucible-results {
		margin-top: 20px;
	}

	.results-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		margin-bottom: 12px;
	}

	.toggle {
		font-size: 13px;
		color: #6c7086;
		cursor: pointer;
		display: flex;
		align-items: center;
		gap: 6px;
	}

	.toggle input { cursor: pointer; }

	.empty {
		background: #181825;
		border: 1px solid #313244;
		border-radius: 8px;
		padding: 40px;
		text-align: center;
		color: #6c7086;
		font-size: 14px;
	}

	.table-wrap {
		overflow-x: auto;
		border: 1px solid #313244;
		border-radius: 8px;
	}

	table {
		width: 100%;
		border-collapse: collapse;
		font-size: 13px;
	}

	thead {
		background: #181825;
		position: sticky;
		top: 0;
	}

	th {
		padding: 10px 12px;
		text-align: left;
		font-weight: 600;
		color: #6c7086;
		font-size: 11px;
		text-transform: uppercase;
		letter-spacing: 0.5px;
		border-bottom: 1px solid #313244;
	}

	td {
		padding: 8px 12px;
		border-bottom: 1px solid #1e1e2e;
	}

	tr:hover {
		background: rgba(203, 166, 247, 0.05);
	}

	tr.mismatch {
		background: rgba(243, 139, 168, 0.08);
	}

	tr.mismatch:hover {
		background: rgba(243, 139, 168, 0.12);
	}

	.method {
		font-weight: 600;
		color: #89b4fa;
	}

	.path {
		max-width: 300px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.rollback-banner {
		margin-top: 20px;
		background: rgba(249, 226, 175, 0.1);
		border: 1px solid #f9e2af;
		border-radius: 8px;
		padding: 14px 20px;
		color: #f9e2af;
		font-weight: 600;
		text-align: center;
	}

	@media (max-width: 900px) {
		.cards { grid-template-columns: 1fr; }
		.stat-grid { grid-template-columns: repeat(3, 1fr); }
	}
</style>
