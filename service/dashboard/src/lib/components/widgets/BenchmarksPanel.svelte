<!--
  BenchmarksPanel.svelte — AI benchmark suite results + AutoDev recommendations.
  Self-managed: polls /dashboard/api/benchmarks/latest every 30s, also fetches
  AutoDev report.
-->
<script>
	import { onMount, onDestroy } from 'svelte';
	import { api } from '$lib/api.js';

	// 2026-05-28: migrated to read voiceSettings from voice store. No props.
	import { voice } from '$lib/stores/voice.svelte.js';
	const voiceSettings = $derived(voice.settings);

	let benchmarksData = $state(null);
	let benchmarkRunning = $state(false);
	let benchmarkRunningSuite = $state(null);
	let autodevReport = $state(null);
	let _pollTimer = null;

	async function loadBenchmarks() {
		try {
			[benchmarksData, autodevReport] = await Promise.all([
				api('/dashboard/api/benchmarks/latest'),
				api('/dashboard/api/autodev/report').catch(() => null),
			]);
		} catch {}
	}

	async function runBenchmark(suite) {
		benchmarkRunning = true;
		benchmarkRunningSuite = suite;
		try {
			const model = voiceSettings.terminal_ai_model || voiceSettings.ai_model || 'cerebras:qwen-3-235b';
			await api('/api/v1/ai/benchmark', { method: 'POST', body: JSON.stringify({ suite, model }) });
			await loadBenchmarks();
		} catch (e) { console.error('[Benchmarks] run failed', e); }
		finally { benchmarkRunning = false; benchmarkRunningSuite = null; }
	}

	async function runAllBenchmarks() {
		benchmarkRunning = true;
		benchmarkRunningSuite = 'all';
		try {
			const model = voiceSettings.terminal_ai_model || voiceSettings.ai_model || 'cerebras:qwen-3-235b';
			await api('/api/v1/ai/benchmark/all', { method: 'POST', body: JSON.stringify({ model }) });
			await loadBenchmarks();
		} catch (e) { console.error('[Benchmarks] run-all failed', e); }
		finally { benchmarkRunning = false; benchmarkRunningSuite = null; }
	}

	function benchScoreLabel(key) {
		const MAP = {
			hearing: 'Hearing', reflex_ms: 'Reflex', clarity: 'Clarity', reasoning: 'Reasoning',
			memory: 'Memory', voice: 'Voice', coherence: 'Coherence', novelty: 'Novelty',
			accuracy: 'Accuracy', store: 'Store', recall: 'Recall', associative: 'Assoc',
			relevance: 'Relevance', coverage: 'Coverage', freshness: 'Freshness',
			pattern_det: 'Pattern', inference: 'Infer', auth_accuracy: 'Auth',
			persona_consistency: 'Persona', hit_rate: 'Hit Rate', e2e_pass: 'E2E',
			multi_intent: 'Multi-Intent', decay_ok: 'Decay', bump_ok: 'Bump',
			policy_ok: 'Policy', scope_ok: 'Scope',
		};
		return MAP[key] || key;
	}

	onMount(() => {
		loadBenchmarks();
		_pollTimer = setInterval(loadBenchmarks, 30_000);
	});
	onDestroy(() => { if (_pollTimer) clearInterval(_pollTimer); });
</script>

<div class="benchmarks-panel">
	{#if !benchmarksData}
		<div class="empty-state">Loading benchmarks...</div>
	{:else}
		{@const suites = benchmarksData.suites || []}
		{@const latest = benchmarksData.latest || {}}
		<div class="bench-summary">
			<div class="bench-summary-score">
				<span class="bench-summary-num" class:all-pass={benchmarksData.suites_passed === benchmarksData.total_suites}>{benchmarksData.suites_passed ?? 0}/{benchmarksData.total_suites ?? 12}</span>
				<span class="bench-summary-label">suites passing</span>
			</div>
			<button class="bench-run-btn bench-run-all" onclick={() => runAllBenchmarks()} disabled={benchmarkRunning}>{benchmarkRunningSuite === 'all' ? 'Running All...' : 'Run All'}</button>
		</div>
		{#if autodevReport && (autodevReport.recommendations?.length > 0)}
			<div class="bench-autodev-report">
				<div class="bench-report-title">AutoDev Findings</div>
				{#each autodevReport.recommendations as rec}
					<div class="bench-rec" class:rec-fix={rec.action === 'fix'} class:rec-research={rec.action === 'research'}>
						<span class="bench-rec-badge" class:fix={rec.action === 'fix'} class:research={rec.action === 'research'}>{rec.action === 'fix' ? 'FIX' : 'RESEARCH'}</span>
						<span class="bench-rec-text">{rec.label}</span>
						<span class="bench-rec-score">{rec.suite} {rec.axis}={rec.score}</span>
					</div>
				{/each}
			</div>
		{/if}
		{#each suites as suite}
			{@const run = latest[suite]}
			{@const s = run?.scores || {}}
			{@const composite = s.composite ?? null}
			{@const isRunning = benchmarkRunningSuite === suite}
			<div class="bench-suite" class:bench-not-run={!run}>
				<div class="bench-suite-header">
					<span class="bench-suite-name">{suite.toUpperCase()}</span>
					<div class="bench-suite-right">
						{#if run}<span class="bench-suite-status" class:pass={run.passed} class:fail={!run.passed}>{run.passed ? '✓' : '✗'}</span>{:else}<span class="bench-suite-status bench-unrun">—</span>{/if}
						<button class="bench-mini-run" onclick={() => runBenchmark(suite)} disabled={benchmarkRunning}>{isRunning ? '…' : '▶'}</button>
					</div>
				</div>
				{#if run}
					{#if composite != null}
						<div class="bench-row bench-composite-row">
							<span class="bench-label">Score</span>
							<div class="bench-bar-wrap"><div class="bench-bar" class:green={composite >= 8} class:yellow={composite >= 6 && composite < 8} class:red={composite < 6} style="width:{Math.min(composite / 10 * 100, 100)}%"></div></div>
							<span class="bench-val bench-composite-val" class:pass={composite >= 8} class:warn={composite >= 6 && composite < 8} class:fail={composite < 6}>{composite.toFixed(1)}</span>
						</div>
					{/if}
					{@const secKeys = Object.keys(s).filter(k => k !== 'composite' && typeof s[k] === 'number')}
					{#if secKeys.length > 0}
						<div class="bench-metrics">
							{#each secKeys.slice(0, 4) as key}
								{#if key === 'reflex_ms'}
									<span class="bench-chip" class:chip-ok={s[key] <= 400} class:chip-warn={s[key] > 400}>{s[key]}ms</span>
								{:else}
									<span class="bench-chip" class:chip-ok={s[key] >= 8} class:chip-warn={s[key] >= 6 && s[key] < 8} class:chip-fail={s[key] < 6}>{benchScoreLabel(key)}: {typeof s[key] === 'number' && s[key] % 1 !== 0 ? s[key].toFixed(1) : s[key]}</span>
								{/if}
							{/each}
						</div>
					{/if}
					<div class="bench-ran-at">{run.ran_at ? new Date(typeof run.ran_at === 'string' ? run.ran_at.replace(' ','T')+'Z' : run.ran_at).toLocaleString() : ''}</div>
				{:else}
					<div class="bench-not-run-label">not yet run</div>
				{/if}
			</div>
		{/each}
	{/if}
</div>
