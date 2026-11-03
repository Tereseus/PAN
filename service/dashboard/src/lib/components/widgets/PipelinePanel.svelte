<!--
  PipelinePanel.svelte — Beta pipeline state: production slot, beta slot,
  pending count. Buttons to trigger / abort / promote.
-->
<script>
	import { onMount, onDestroy } from 'svelte';
	import { api } from '$lib/api.js';

	let pipelineData = $state(null);
	let pipelineStarting = $state(false);
	let _pollTimer = null;

	async function loadPipeline() {
		try { pipelineData = await api('/api/carrier/pipeline/status'); } catch {}
	}

	async function triggerPipeline() {
		pipelineStarting = true;
		try {
			await api('/api/carrier/pipeline/start', { method: 'POST', body: JSON.stringify({ source: 'manual' }) });
			await loadPipeline();
		} catch (e) { console.error('[Pipeline] start failed', e); }
		finally { pipelineStarting = false; }
	}

	async function abortPipelineAction() {
		try { await api('/api/carrier/pipeline/abort', { method: 'POST', body: '{}' }); await loadPipeline(); }
		catch (e) { console.error('[Pipeline] abort failed', e); }
	}

	async function promotePipelineManual() {
		try { await api('/api/carrier/pipeline/promote', { method: 'POST', body: '{}' }); await loadPipeline(); }
		catch (e) { console.error('[Pipeline] promote failed', e); }
	}

	function pipelineStatusColor(status) {
		if (!status || status === 'idle') return '#666';
		if (status === 'failed') return '#e55';
		if (status === 'ready' || status === 'promoting') return '#5e5';
		return '#f90';
	}

	let _wsHandler = null;
	onMount(() => {
		loadPipeline();
		_pollTimer = setInterval(loadPipeline, 10_000);
		_wsHandler = () => loadPipeline();
		if (typeof window !== 'undefined') {
			window.addEventListener('pan:pipeline-update', _wsHandler);
		}
	});
	onDestroy(() => {
		if (_pollTimer) clearInterval(_pollTimer);
		if (typeof window !== 'undefined' && _wsHandler) {
			window.removeEventListener('pan:pipeline-update', _wsHandler);
		}
	});
</script>

<div class="pipeline-panel">
	{#if !pipelineData}
		<div class="empty-state">Loading pipeline...</div>
	{:else}
		{@const pl = pipelineData.pipeline || {}}
		{@const beta = pipelineData.beta}
		{@const prod = pipelineData.production}
		{@const status = pl.status || 'idle'}
		<div class="pl-header">
			<div class="pl-status-dot" style="background:{pipelineStatusColor(status)}"></div>
			<span class="pl-status-label">{status.toUpperCase()}</span>
			{#if pl.source && status !== 'idle'}<span class="pl-source">({pl.source})</span>{/if}
			<div class="pl-spacer"></div>
			{#if status === 'idle' || status === 'failed'}
				<button class="pl-btn pl-btn-run" onclick={triggerPipeline} disabled={pipelineStarting}>{pipelineStarting ? 'Starting…' : '▶ Run Pipeline'}</button>
			{:else}
				<button class="pl-btn pl-btn-abort" onclick={abortPipelineAction}>✕ Abort</button>
			{/if}
		</div>
		{#if pl.error}<div class="pl-error">{pl.error}</div>{/if}
		<div class="pl-slot-label">PRODUCTION</div>
		<div class="pl-slot pl-slot-prod">
			{#if prod}<span class="pl-slot-id">Craft-{prod.id}</span><span class="pl-slot-port">:{prod.port}</span><span class="pl-slot-health" class:healthy={prod.healthy}>{prod.healthy ? '●' : '○'}</span><span class="pl-slot-uptime">{prod.uptimeMs ? (prod.uptimeMs / 60000).toFixed(0) + 'm' : ''}</span>{:else}<span class="pl-slot-none">—</span>{/if}
		</div>
		<div class="pl-slot-label">BETA {status === 'benchmarking' ? '(benchmarking…)' : status === 'spawning' ? '(spawning…)' : ''}</div>
		<div class="pl-slot pl-slot-beta" class:active={!!beta}>
			{#if beta}<span class="pl-slot-id">Craft-{beta.id}</span><span class="pl-slot-port">:{beta.port}</span><span class="pl-slot-health" class:healthy={beta.healthy}>{beta.healthy ? '●' : '○'}</span>{#if status === 'ready'}<button class="pl-btn pl-btn-promote" onclick={promotePipelineManual}>Promote ↑</button>{/if}{:else}<span class="pl-slot-none">{status === 'idle' ? '—' : '…'}</span>{/if}
		</div>
		{#if pipelineData.pending > 0}<div class="pl-slot-label">PENDING ({pipelineData.pending})</div>{/if}
		{#if pl.scores && Object.keys(pl.scores).length > 0}
			<div class="pl-bench-title">Benchmark Results</div>
			{#each Object.entries(pl.scores) as [suite, result]}
				<div class="pl-bench-row" class:pl-pass={result?.passed} class:pl-fail={result && !result.passed}>
					<span class="pl-bench-suite">{suite}</span><span class="pl-bench-result">{result?.passed ? '✓' : '✗'}</span>
					{#if result?.scores?.composite != null}<span class="pl-bench-score">{result.scores.composite.toFixed(1)}</span>{/if}
				</div>
			{/each}
		{/if}
		{#if pl.startedAt}<div class="pl-elapsed">Started {new Date(pl.startedAt).toLocaleTimeString()}{#if pl.completedAt} → {((pl.completedAt - pl.startedAt) / 1000).toFixed(0)}s{/if}</div>{/if}
	{/if}
</div>
