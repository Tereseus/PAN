<!--
  PerfPanel.svelte — the Performance widget. Reads everything from the perf
  store; parent's existing 27+ tracker call sites (`markLoad`, `markSend`,
  `markSendPhase`, `trackWidget`, `trackWsMsg`) already write into the same
  store, so no prop wiring is needed.

  This is what was the `{#snippet perfPanelContents()}` block — lifted
  verbatim and rewired to read store paths instead of parent locals.
-->
<script>
	import { onMount, onDestroy } from 'svelte';
	import {
		perf,
		STAGE_LABELS, LOAD_STAGE_ORDER,
		PERF_PHASE_LABELS, PERF_PHASE_ORDER,
		fmtMs,
		forceProbeStage,
		killProcess,
		persistPanelView,
		startPerfPolling,
		stopPerfPolling,
	} from '$lib/stores/perf.svelte.js';

	// 2026-05-28: kick the 5s carrier-trace + processes poll when the panel
	// mounts. Without this the "Loading perf trace…" placeholder was sticking
	// forever because the loaders were only called from the parent's
	// section-onchange handler, which doesn't fire on initial page load.
	onMount(() => { startPerfPolling(); });
	onDestroy(() => { stopPerfPolling(); });

	// Top-level template projections — Svelte 5 disallows `{@const}` at the
	// component template root, so the derivations live here as `$derived`.
	const stages       = $derived(perf.trace.stages || []);
	const downCount    = $derived(stages.filter(s => s.state === 'failed' && s.required).length);
	const memPct       = $derived(Math.round((perf.server.rss_mb || 0) / 512 * 100));
	const overallBad   = $derived(downCount > 0 || !perf.trace.system_ready || perf.data.wsLatency > 200 || perf.server.rss_mb > 500);
	const overallWarn  = $derived(perf.data.wsLatency > 50 || perf.server.rss_mb > 200 || perf.server.slow_requests > 5);
	const readyCount   = $derived(stages.filter(s => s.state === 'ready').length);
	const totalCount   = $derived(stages.length);
	const phaseOrder   = PERF_PHASE_ORDER;

	// Persist panel view choice (parent used a $effect at the top of its
	// script — now this component owns the persistence).
	$effect(() => { perf.panelView; persistPanelView(); });

	// Widget-health derivations. Top-level @const isn't allowed in Svelte 5
	// component templates so the work happens here as $derived.
	let _nowTick = $state(Date.now());
	// 1s tick so "X seconds ago" labels update live.
	$effect(() => {
		const id = setInterval(() => { _nowTick = Date.now(); }, 1000);
		return () => clearInterval(id);
	});
	const _wEntries = $derived(Object.entries(perf.widgetHealth));
	const _wStale   = $derived(_wEntries.filter(([, w]) => w.ts > 0 && (_nowTick - w.ts) > 120_000));
	const _wsTopTypes = $derived(Object.entries(perf.wsMsgCounts).sort((a, b) => b[1] - a[1]).slice(0, 8));
</script>

<!-- Overall banner -->
<div class="perf-overall" class:perf-overall-good={!overallBad && !overallWarn} class:perf-overall-warn={overallWarn && !overallBad} class:perf-overall-bad={overallBad}>
	<span class="perf-overall-icon">{overallBad ? '!!' : overallWarn ? '!' : 'OK'}</span>
	<span class="perf-overall-text">{overallBad ? 'Issues detected' : overallWarn ? 'Minor issues' : 'All good'}</span>
</div>

<!-- Readiness summary (from /api/v1/perf/trace) -->
{#if perf.traceLoadedOnce}
	<div class="perf-ready-grid" title="Live from the carrier perf engine. Each cell is computed from the probe DAG in service/src/perf/stages.js.">
		<div class="perf-ready-cell" class:perf-ready-good={perf.trace.system_ready} class:perf-ready-bad={!perf.trace.system_ready}>
			<div class="perf-ready-val">{perf.trace.system_ready ? 'READY' : 'WAIT'}</div>
			<div class="perf-ready-lbl" title="AND of all REQUIRED stages being ready. Drives system_ready in the math spec.">System</div>
		</div>
		<div class="perf-ready-cell" class:perf-ready-good={perf.trace.interactive_ready} class:perf-ready-bad={!perf.trace.interactive_ready}>
			<div class="perf-ready-val">{perf.trace.interactive_ready ? 'READY' : 'WAIT'}</div>
			<div class="perf-ready-lbl" title="AND of INTERACTIVE_SET. When this flips to READY, keystrokes hit the PTY with no buffering lag.">Interactive</div>
		</div>
		<div class="perf-ready-cell" class:perf-ready-good={perf.trace.swap_safe?.safe} class:perf-ready-bad={!perf.trace.swap_safe?.safe}>
			<div class="perf-ready-val">{perf.trace.swap_safe?.safe ? 'SAFE' : 'HOLD'}</div>
			<div class="perf-ready-lbl" title={perf.trace.swap_safe?.safe ? 'All SWAP_GATE stages are ready. Lifeboat will allow commit.' : 'Lifeboat will NOT commit. Reason: ' + (perf.trace.swap_safe?.reason || 'unknown')}>Swap</div>
		</div>
		<div class="perf-ready-cell">
			<div class="perf-ready-val">{readyCount}<span style="opacity:0.4">/{totalCount}</span></div>
			<div class="perf-ready-lbl" title="Count of probes currently in the ready state (incl. non-required).">Probes</div>
		</div>
	</div>
	<div class="perf-metric" style="margin-top:2px">
		<span class="perf-label" title="Longest wall-clock path through the readiness DAG — the actual critical path for a cold start.">Critical path</span>
		<span class="perf-value">{fmtMs(perf.trace.critical_path_ms)}</span>
	</div>
	{#if !perf.trace.swap_safe?.safe && perf.trace.swap_safe?.reason}
		<div class="perf-metric" style="font-size:10px;opacity:0.75">
			<span class="perf-label perf-bad" title={perf.trace.swap_safe.reason}>⚠ {perf.trace.swap_safe.reason}</span>
		</div>
	{/if}

	<!-- View toggle -->
	<div class="perf-view-toggle" role="tablist" aria-label="Perf view">
		<button class="perf-view-btn" class:perf-view-active={perf.panelView === 'list'} onclick={() => perf.panelView = 'list'} title="Grouped stage list, one row per probe.">List</button>
		<button class="perf-view-btn" class:perf-view-active={perf.panelView === 'gantt'} onclick={() => perf.panelView = 'gantt'} title="Gantt bars on a shared timeline. Critical path stages highlighted.">Gantt</button>
	</div>

	{#if perf.panelView === 'list'}
		<!-- Stages grouped by phase -->
		{#each phaseOrder as phase}
			{@const phaseStages = stages.filter(s => s.phase === phase)}
			{#if phaseStages.length > 0}
				<div class="perf-section-title" style="margin-top:10px">{PERF_PHASE_LABELS[phase] || phase}</div>
				{#each phaseStages as s}
					{@const warn = s.budget?.warn_ms || 0}
					{@const bad = s.budget?.bad_ms || 0}
					{@const hard = s.budget?.hard_ms || 0}
					{@const overWarn = warn && s.last_probe_ms > warn}
					{@const overBad = bad && s.last_probe_ms > bad}
					<div class="perf-stage-row" class:perf-stage-ready={s.state === 'ready'} class:perf-stage-failed={s.state === 'failed'} class:perf-stage-running={s.state === 'running'} class:perf-stage-pending={s.state === 'pending'}>
						<span class="perf-stage-dot" title={s.state}></span>
						<span class="perf-stage-name" title={s.help || s.id}>{s.name}</span>
						<span class="perf-stage-val" class:perf-warn={overWarn && !overBad} class:perf-bad={overBad} title={'warn/bad/hard: ' + warn + '/' + bad + '/' + hard + 'ms  —  ' + (s.probe_method || 'probe')}>
							{s.state === 'ready' ? fmtMs(s.last_probe_ms) : s.state === 'running' ? '…' : s.state === 'failed' ? 'fail' : 'wait'}
						</span>
						<button class="perf-reprobe-btn" onclick={() => forceProbeStage(s.id)} title={'Re-run the ' + s.probe_method + ' probe now.'}>↻</button>
					</div>
					{#if s.state === 'failed' && s.error}
						<div class="perf-stage-err" title={s.error}>{s.error}</div>
					{/if}
				{/each}
			{/if}
		{/each}
	{:else}
		<!-- Gantt view -->
		{@const started = perf.trace.engine_started_at || 0}
		{@const nowT = perf.trace.now || Date.now()}
		{@const totalMs = Math.max(perf.trace.critical_path_ms || 0, nowT - started, 1000)}
		{@const scale = (ms) => Math.max(0, Math.min(100, (ms / totalMs) * 100))}

		<div class="perf-section-title" style="margin-top:10px">Gantt — critical path: {fmtMs(perf.trace.critical_path_ms)}</div>
		<div class="perf-gantt">
			{#each phaseOrder as phase}
				{@const phaseStages = stages.filter(s => s.phase === phase)}
				{#each phaseStages as s}
					{@const startMs = s.ready_at ? Math.max(0, s.ready_at - started - s.last_probe_ms) : 0}
					{@const endMs = s.ready_at ? Math.max(0, s.ready_at - started) : (nowT - started)}
					{@const widthPct = Math.max(0.5, scale(endMs) - scale(startMs))}
					{@const leftPct = scale(startMs)}
					<div class="perf-gantt-row" title={s.help || s.id}>
						<span class="perf-gantt-name">{s.name}</span>
						<div class="perf-gantt-track">
							{#if s.state === 'ready' || s.state === 'failed'}
								<div class="perf-gantt-bar"
									class:perf-gantt-ready={s.state === 'ready'}
									class:perf-gantt-failed={s.state === 'failed'}
									style="left:{leftPct}%;width:{widthPct}%"
									title={s.state === 'ready' ? fmtMs(endMs) + ' wall-clock · probe ' + fmtMs(s.last_probe_ms) : (s.error || 'failed')}>
								</div>
							{:else if s.state === 'running'}
								<div class="perf-gantt-bar perf-gantt-running" style="left:0%;width:100%" title="running…"></div>
							{:else}
								<div class="perf-gantt-bar perf-gantt-pending" style="left:0%;width:100%" title="waiting for dependencies"></div>
							{/if}
						</div>
						<span class="perf-gantt-ms">{s.state === 'ready' ? fmtMs(endMs) : s.state === 'failed' ? 'fail' : s.state === 'running' ? '…' : '—'}</span>
					</div>
				{/each}
			{/each}
		</div>
		<div class="perf-gantt-legend">
			<span><span class="perf-gantt-swatch perf-gantt-ready"></span>ready</span>
			<span><span class="perf-gantt-swatch perf-gantt-running"></span>running</span>
			<span><span class="perf-gantt-swatch perf-gantt-failed"></span>failed</span>
			<span><span class="perf-gantt-swatch perf-gantt-pending"></span>pending</span>
		</div>
	{/if}
{:else}
	<div class="perf-metric" style="opacity:0.6">
		<span class="perf-label">Loading perf trace…</span>
	</div>
{/if}

<!-- Last message (client-side send → ack → echo → assistant trace) -->
{#if perf.sendTimings.lastSendAt > 0}
	<div class="perf-section-title" style="margin-top:12px">Last message</div>
	<div class="perf-metric" style="font-size:10px;opacity:0.65">
		<span class="perf-label" title={perf.sendTimings.lastSendText}>&ldquo;{perf.sendTimings.lastSendText}{perf.sendTimings.lastSendText.length >= 40 ? '…' : ''}&rdquo;</span>
	</div>
	<div class="perf-metric">
		<span class="perf-label" title="Time from pressing Enter until server returned HTTP 200.">Server acked</span>
		<span class="perf-value" class:perf-warn={perf.sendTimings.lastAckMs > 300} class:perf-bad={perf.sendTimings.lastAckMs > 1500}>{perf.sendTimings.lastAckMs ? fmtMs(perf.sendTimings.lastAckMs) : (perf.sendTimings.awaitingAssistant ? '…' : '—')}</span>
	</div>
	<div class="perf-metric">
		<span class="perf-label" title="Time until your own message echoed back over the WebSocket.">Echo back</span>
		<span class="perf-value" class:perf-warn={perf.sendTimings.lastEchoMs > 500} class:perf-bad={perf.sendTimings.lastEchoMs > 2000}>{perf.sendTimings.lastEchoMs ? fmtMs(perf.sendTimings.lastEchoMs) : (perf.sendTimings.awaitingAssistant ? '…' : '—')}</span>
	</div>
	<div class="perf-metric">
		<span class="perf-label" title="Time until the assistant's first reply arrived via JSONL.">Assistant replied</span>
		<span class="perf-value" class:perf-warn={perf.sendTimings.lastAssistantMs > 5000} class:perf-bad={perf.sendTimings.lastAssistantMs > 15000}>{perf.sendTimings.lastAssistantMs ? fmtMs(perf.sendTimings.lastAssistantMs) : (perf.sendTimings.awaitingAssistant ? 'thinking…' : '—')}</span>
	</div>
{/if}

<!-- Page load trace -->
{#if perf.loadTimings.scriptInit}
	<div class="perf-section-title" style="margin-top:12px">Page load trace</div>
	{#each LOAD_STAGE_ORDER as key, i}
		{@const ms = perf.loadTimings[key]}
		{@const spec = STAGE_LABELS[key]}
		{#if ms}
			{@const prev = i > 0 ? perf.loadTimings[LOAD_STAGE_ORDER[i-1]] : 0}
			{@const delta = prev ? ms - prev : ms}
			<div class="perf-metric" class:perf-stage-final={key === 'interactive'}>
				<span class="perf-label" title={spec.help}>{spec.name}</span>
				<span class="perf-value" class:perf-warn={ms > spec.warn} class:perf-bad={ms > spec.bad}>
					{fmtMs(ms)}
					{#if delta > 0 && delta !== ms}<span style="opacity:0.45;font-size:9px">&nbsp;(+{fmtMs(delta)})</span>{/if}
				</span>
			</div>
		{:else}
			<div class="perf-metric" style="opacity:0.4">
				<span class="perf-label" title={spec.help}>{spec.name}</span>
				<span class="perf-value">pending…</span>
			</div>
		{/if}
	{/each}
{/if}

<!-- Speed -->
<div class="perf-section-title" style="margin-top:12px">Speed</div>
<div class="perf-metric">
	<span class="perf-label" title="Avg HTTP response time across all server routes.">Server response</span>
	<span class="perf-value" class:perf-warn={perf.server.avg_ms > 100} class:perf-bad={perf.server.avg_ms > 500}>
		{perf.server.avg_ms < 10 ? 'Instant' : perf.server.avg_ms < 100 ? 'Fast' : perf.server.avg_ms < 500 ? 'Slow' : 'Very slow'}
		<span style="opacity:0.5;font-size:9px">({Math.round(perf.server.avg_ms)}ms)</span>
	</span>
</div>
<div class="perf-metric">
	<span class="perf-label" title="Round-trip of a WebSocket ping. Your network + server wake-up.">WebSocket ping</span>
	<span class="perf-value" class:perf-warn={perf.data.wsLatency > 50} class:perf-bad={perf.data.wsLatency > 200}>
		{perf.data.wsLatency < 10 ? 'Instant' : perf.data.wsLatency < 50 ? 'Fast' : perf.data.wsLatency < 200 ? 'Laggy' : 'Frozen'}
		<span style="opacity:0.5;font-size:9px">({perf.data.wsLatency}ms)</span>
	</span>
</div>
{#if perf.server.slow_requests > 0}
	<div class="perf-metric">
		<span class="perf-label">Slow requests</span>
		<span class="perf-value perf-warn">{perf.server.slow_requests} of {perf.server.total_requests}</span>
	</div>
{/if}

<!-- Resources -->
<div class="perf-section-title" style="margin-top:12px">Resources</div>
<div class="perf-metric">
	<span class="perf-label">Memory</span>
	<span class="perf-value" class:perf-warn={perf.server.rss_mb > 200} class:perf-bad={perf.server.rss_mb > 500}>{perf.server.rss_mb}MB</span>
</div>
<div class="perf-bar-track"><div class="perf-bar-fill" class:perf-warn={memPct > 40} class:perf-bad={memPct > 80} style="width:{Math.min(memPct,100)}%"></div></div>
<div class="perf-metric">
	<span class="perf-label">Uptime</span>
	<span class="perf-value">{perf.server.uptime_s > 86400 ? (perf.server.uptime_s/86400).toFixed(1)+' days' : perf.server.uptime_s > 3600 ? (perf.server.uptime_s/3600).toFixed(1)+' hrs' : perf.server.uptime_s > 60 ? Math.round(perf.server.uptime_s/60)+' min' : perf.server.uptime_s+' sec'}</span>
</div>
<div class="perf-metric">
	<span class="perf-label">Connected clients</span>
	<span class="perf-value">{perf.server.ws_connections}</span>
</div>

{#if perf.server.top_routes?.length > 0}
	{@const slowRoutes = perf.server.top_routes.filter(r => r.maxMs > 500).slice(0, 3)}
	{#if slowRoutes.length > 0}
		<div class="perf-section-title" style="margin-top:12px">Bottlenecks</div>
		{#each slowRoutes as r}
			<div class="perf-metric" style="font-size:10px">
				<span class="perf-label" style="max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title={r.route}>{r.route.replace(/^\/api\/v1\//, '').replace(/^\/dashboard\/api\//, '').replace(/^\/_app\/.*\//, 'asset/')}</span>
				<span class="perf-value perf-bad">Peaked {r.maxMs > 1000 ? (r.maxMs/1000).toFixed(1)+'s' : Math.round(r.maxMs)+'ms'}</span>
			</div>
		{/each}
	{/if}
{/if}

<!-- Process liveness -->
{#if perf.services.length > 0}
	<div class="perf-section-title" style="margin-top:12px">Processes</div>
	{#each perf.services as svc}
		<div class="perf-proc" class:perf-zombie={svc.status === 'down' || svc.status === 'error'}>
			<div class="perf-proc-header">
				<span class="perf-proc-name vital">{svc.name}</span>
				{#if svc.inProcess}
					<span class="perf-proc-tag" title="Runs inside the PAN server process">built-in</span>
				{:else if svc.pid}
					<span class="perf-proc-tag perf-good" style="font-size:9px">{svc.memMB}MB</span>
					<button class="perf-kill-btn" onclick={() => killProcess(svc.pid)} title="Kill {svc.name} (pid {svc.pid})">Kill</button>
				{:else}
					<span class="perf-proc-tag perf-bad">Offline</span>
				{/if}
			</div>
			{#if svc.inProcess}
				<div class="perf-proc-stats"><span style="opacity:0.6">{svc.modelTierLabel || 'built-in'}</span></div>
			{:else if !svc.pid}
				<div class="perf-proc-stats"><span class="perf-bad">Not running</span></div>
			{/if}
			{#if svc.lastError}
				<div class="perf-proc-stats perf-bad" style="font-size:9px;margin-top:2px">{String(svc.lastError).slice(0,80)}</div>
			{/if}
		</div>
	{/each}
{/if}

{#if perf.other.length > 0}
	<div class="perf-section-title" style="margin-top:12px">Heavy Processes</div>
	{#each perf.other.slice(0, 5) as p}
		<div class="perf-proc">
			<div class="perf-proc-header">
				<span class="perf-proc-name" style="opacity:0.7">{p.exe}</span>
				<span class="perf-proc-tag" style="font-size:9px">{p.memMB}MB</span>
				<button class="perf-kill-btn" onclick={() => killProcess(p.pid)} title="Kill pid {p.pid}">Kill</button>
			</div>
		</div>
	{/each}
{/if}

<!-- Widget Health -->
<div class="perf-section-title" style="margin-top:12px">Widget Health
	{#if _wStale.length > 0}<span style="color:#f38ba8;font-size:9px;margin-left:6px">⚠ {_wStale.length} stale</span>{/if}
</div>
{#each _wEntries as [name, w]}
	{@const ageSec = w.ts ? Math.round((_nowTick - w.ts) / 1000) : null}
	{@const isStale = w.ts > 0 && (_nowTick - w.ts) > 120_000}
	{@const isPush = w.source === 'push'}
	{@const neverUpdated = w.ts === 0}
	<div class="perf-metric" style="font-size:10px">
		<span class="perf-label" style="text-transform:capitalize">{name}</span>
		<span style="display:flex;align-items:center;gap:5px">
			{#if neverUpdated}
				<span style="color:#6c7086">—</span>
			{:else}
				<span style="color:{isStale ? '#f38ba8' : isPush ? '#a6e3a1' : '#fab387'}" title="{isPush ? '📡 WS push' : '🔄 fallback poll'} · {w.pushes}p/{w.polls}x">
					{isPush ? '📡' : '🔄'} {ageSec < 60 ? ageSec + 's' : Math.round(ageSec/60) + 'm'} ago
				</span>
				{#if w.pushes > 0 || w.polls > 0}
					<span style="color:#6c7086;font-size:9px" title="WS push count / fallback poll count">{w.pushes}p/{w.polls}x</span>
				{/if}
			{/if}
		</span>
	</div>
{/each}

<!-- WS Message Rates -->
<div class="perf-section-title" style="margin-top:10px">WS Messages</div>
<div class="perf-metric" style="font-size:10px">
	<span class="perf-label">Total received</span>
	<span class="perf-value">{perf.wsTotalMsgs}</span>
</div>
{#if perf.wsLastMsgTs > 0}
	<div class="perf-metric" style="font-size:10px">
		<span class="perf-label">Last message</span>
		<span class="perf-value">{Math.round((_nowTick - perf.wsLastMsgTs)/1000)}s ago</span>
	</div>
{/if}
{#each _wsTopTypes as [type, count]}
	<div class="perf-metric" style="font-size:10px">
		<span class="perf-label" style="opacity:0.7">{type}</span>
		<span style="color:#cba6f7;font-size:10px">{count}×</span>
	</div>
{/each}
