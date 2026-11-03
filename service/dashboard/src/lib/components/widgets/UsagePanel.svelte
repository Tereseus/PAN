<!--
  UsagePanel.svelte — Claude/Gemini token + rate-limit usage view shown in
  the right-column "Usage" dropdown option.

  Sections:
   - This Session (only if there's a current sessionCost — derived from the
     active tab's per-tab message map)
   - Claude Plan Limits OR Gemini CLI Usage (whichever provider is active)
   - Burn Rate (tokens-per-message + messages-left estimate)
   - All Sessions (today / week breakdown with cost estimate)
   - PAN Stats (events / sessions / memory items / DB size)

  Reads from the `usage` and `terminal` stores. No props.
-->
<script>
	import { onMount, onDestroy } from 'svelte';
	import {
		usage,
		startUsagePolling, stopUsagePolling,
		formatTokens, formatResetTime,
	} from '$lib/stores/usage.svelte.js';
	import { terminal, getPushed } from '$lib/stores/terminal.svelte.js';

	onMount(() => { startUsagePolling(); });
	onDestroy(() => { stopUsagePolling(); });

	// sessionCost — last turn_stats message on the active tab's transcript.
	// Has cumulative session totals plus the cost of the current turn.
	const sessionCost = $derived.by(() => {
		const active = terminal.tabs.find(t => t.id === terminal.activeTabId);
		const msgs = getPushed(active?.id);
		for (let i = msgs.length - 1; i >= 0; i--) {
			const m = msgs[i];
			if (m.type === 'turn_stats' && m.tokens) {
				return {
					cost:        m.tokens.total_cost ?? null,
					input:       m.tokens.total_input        || 0,
					output:      m.tokens.total_output       || 0,
					cacheRead:   m.tokens.total_cache_read   || 0,
					cacheCreate: m.tokens.total_cache_create || 0,
				};
			}
		}
		return null;
	});
</script>

{#if !usage.data}
	<div class="empty-state">Loading usage...</div>
{:else}
	{#if sessionCost}
		<div class="usage-section" style="background:rgba(203,166,247,0.08);border:1px solid rgba(203,166,247,0.2)">
			<div class="usage-heading" style="color:#cba6f7">This Session</div>
			<div class="usage-row" style="font-size:15px;font-weight:700">
				<span class="usage-label">Cost</span>
				<span class="usage-val" style="color:#cba6f7;font-size:16px">{sessionCost.cost != null ? '$' + sessionCost.cost.toFixed(4) : '--'}</span>
			</div>
			<div class="usage-row"><span class="usage-label">Input</span><span class="usage-val">{formatTokens(sessionCost.input)}</span></div>
			<div class="usage-row"><span class="usage-label">Output</span><span class="usage-val">{formatTokens(sessionCost.output)}</span></div>
			{#if sessionCost.cacheRead}
				<div class="usage-row"><span class="usage-label">Cache Read</span><span class="usage-val">{formatTokens(sessionCost.cacheRead)}</span></div>
			{/if}
			{#if sessionCost.cacheCreate}
				<div class="usage-row"><span class="usage-label">Cache Write</span><span class="usage-val">{formatTokens(sessionCost.cacheCreate)}</span></div>
			{/if}
		</div>
	{/if}

	<div class="usage-section">
		{#if usage.data.gemini}
			<div class="usage-heading">Gemini CLI Usage</div>
			{@const g = usage.data.gemini}
			<div class="usage-row"><span class="usage-label">Model</span><span class="usage-val" style="color:#a6e3a1">{g.model || 'gemini-1.5-pro'}</span></div>
			<div class="usage-row"><span class="usage-label">Session Output</span><span class="usage-val">{formatTokens(g.session?.output)}</span></div>
			<div class="usage-row"><span class="usage-label">Session Input</span><span class="usage-val">{formatTokens(g.session?.input)}</span></div>
			<div class="usage-row"><span class="usage-label">Session Msgs</span><span class="usage-val">{g.session?.messages || 0}</span></div>
			<div class="usage-subhead">Today</div>
			<div class="usage-row"><span class="usage-label">Output</span><span class="usage-val">{formatTokens(g.today?.output)}</span></div>
			<div class="usage-row"><span class="usage-label">Input</span><span class="usage-val">{formatTokens(g.today?.input)}</span></div>
			<div class="usage-row"><span class="usage-label">Messages</span><span class="usage-val">{g.today?.messages || 0}</span></div>
		{:else if usage.data.claude?.rateLimits}
			{@const rl = usage.data.claude.rateLimits}
			<div class="usage-heading">Claude Plan Limits</div>
			<div class="usage-row" style="opacity:0.6; font-size:11px;">
				<span class="usage-label">{rl.subscriptionType?.toUpperCase() || 'Plan'}</span>
				<span class="usage-val">{rl.rateLimitTier || ''}</span>
			</div>
			{#if rl.five_hour}
				<div class="usage-subhead">Session (5hr Window)</div>
				<div class="usage-bar-wrap">
					<div class="usage-bar" style="width:{Math.min(rl.five_hour.utilization, 100)}%; background:{rl.five_hour.utilization >= 80 ? '#f38ba8' : rl.five_hour.utilization >= 50 ? '#f9e2af' : '#a6e3a1'}"></div>
				</div>
				<div class="usage-row">
					<span class="usage-label" style="color:{rl.five_hour.utilization >= 80 ? '#f38ba8' : rl.five_hour.utilization >= 50 ? '#f9e2af' : '#a6e3a1'}">{Math.round(rl.five_hour.utilization)}% Used</span>
					<span class="usage-val">Resets in {formatResetTime(rl.five_hour.resets_at)}</span>
				</div>
			{/if}
			{#if rl.seven_day}
				<div class="usage-subhead">Weekly Limit</div>
				<div class="usage-bar-wrap">
					<div class="usage-bar" style="width:{Math.min(rl.seven_day.utilization, 100)}%; background:{rl.seven_day.utilization >= 80 ? '#f38ba8' : rl.seven_day.utilization >= 50 ? '#f9e2af' : '#a6e3a1'}"></div>
				</div>
				<div class="usage-row">
					<span class="usage-label" style="color:{rl.seven_day.utilization >= 80 ? '#f38ba8' : rl.seven_day.utilization >= 50 ? '#f9e2af' : '#a6e3a1'}">{Math.round(rl.seven_day.utilization)}% Used</span>
					<span class="usage-val">Resets in {formatResetTime(rl.seven_day.resets_at)}</span>
				</div>
			{/if}
		{:else}
			<div class="usage-heading">Usage</div>
			<div class="usage-row" style="opacity:0.5"><span class="usage-label">No usage data available</span></div>
		{/if}
	</div>

	<div class="usage-section">
		<div class="usage-heading">Burn Rate</div>
		{#if (usage.data.claude?.session?.messages || usage.data.gemini?.session?.messages) > 0}
			{@const c       = usage.data.gemini || usage.data.claude}
			{@const msgs    = c.session.messages || 1}
			{@const totalTok= (c.session.input || 0) + (c.session.output || 0)}
			{@const perMsg  = Math.round(totalTok / msgs)}
			<div class="usage-row" style="font-size:13px; font-weight:600;">
				<span class="usage-label">Per Message</span>
				<span class="usage-val" style="color:#cba6f7">{formatTokens(perMsg)} tok</span>
			</div>
			{#if usage.data.claude?.rateLimits}
				{@const utilPct   = usage.data.claude.rateLimits.five_hour?.utilization || 0}
				{@const pctPerMsg = msgs > 0 ? (utilPct / msgs) : 0}
				{@const remaining = pctPerMsg > 0 ? Math.floor((100 - utilPct) / pctPerMsg) : '?'}
				<div class="usage-row" style="font-size:13px; font-weight:600;">
					<span class="usage-label">% Per Message</span>
					<span class="usage-val" style="color:{pctPerMsg > 5 ? '#f38ba8' : pctPerMsg > 2 ? '#f9e2af' : '#a6e3a1'}">{pctPerMsg.toFixed(1)}%</span>
				</div>
				<div class="usage-row" style="font-size:13px; font-weight:600;">
					<span class="usage-label">Messages Left</span>
					<span class="usage-val" style="color:{remaining !== '?' && remaining < 10 ? '#f38ba8' : remaining !== '?' && remaining < 30 ? '#f9e2af' : '#a6e3a1'}">{remaining === '?' ? '?' : '~' + remaining}</span>
				</div>
			{/if}
			<div class="usage-row"><span class="usage-label">Sent</span><span class="usage-val">{msgs} msgs</span></div>
			<div class="usage-row"><span class="usage-label">Total Used</span><span class="usage-val">{formatTokens(totalTok)}</span></div>
			{#if c.session.cache_read}
				<div class="usage-row">
					<span class="usage-label">Cache Hits</span>
					<span class="usage-val">{formatTokens(c.session.cache_read)} ({totalTok > 0 ? Math.round((c.session.cache_read || 0) / ((c.session.cache_read || 0) + (c.session.input || 1)) * 100) : 0}%)</span>
				</div>
			{/if}
		{:else}
			<div class="usage-row" style="opacity:0.5"><span class="usage-label">No messages yet</span></div>
		{/if}
	</div>

	<div class="usage-section">
		<div class="usage-heading">All Sessions</div>
		{#if usage.data.claude || usage.data.gemini}
			{@const c2 = usage.data.gemini || usage.data.claude}
			{@const todayTotal = (c2.today?.input || 0) + (c2.today?.output || 0) + (c2.today?.cache_read || 0) + (c2.today?.cache_create || 0)}
			{@const weekTotal  = (c2.week?.input  || 0) + (c2.week?.output  || 0) + (c2.week?.cache_read  || 0) + (c2.week?.cache_create  || 0)}
			{@const estCost   = (inp, out, cr, cw) => ((inp||0)*3 + (out||0)*15 + (cr||0)*0.3 + (cw||0)*3.75) / 1000000}
			{@const todayCost = estCost(c2.today?.input, c2.today?.output, c2.today?.cache_read, c2.today?.cache_create)}
			{@const weekCost  = estCost(c2.week?.input,  c2.week?.output,  c2.week?.cache_read,  c2.week?.cache_create)}
			<div class="usage-subhead">Today</div>
			<div class="usage-row" style="font-weight:700;font-size:14px"><span class="usage-label">Est. Cost</span><span class="usage-val" style="color:#a6e3a1">${todayCost.toFixed(2)}</span></div>
			<div class="usage-row"><span class="usage-label">Tokens</span><span class="usage-val">{formatTokens(todayTotal)}</span></div>
			<div class="usage-row"><span class="usage-label">Input</span><span class="usage-val">{formatTokens(c2.today?.input)}</span></div>
			<div class="usage-row"><span class="usage-label">Output</span><span class="usage-val">{formatTokens(c2.today?.output)}</span></div>
			{#if c2.today?.cache_read}
				<div class="usage-row"><span class="usage-label">Cache Read</span><span class="usage-val">{formatTokens(c2.today?.cache_read)}</span></div>
			{/if}
			<div class="usage-row"><span class="usage-label">Messages</span><span class="usage-val">{c2.today?.messages || 0}</span></div>
			{#if c2.week}
				<div class="usage-subhead">This Week</div>
				<div class="usage-row" style="font-weight:700;font-size:14px"><span class="usage-label">Est. Cost</span><span class="usage-val" style="color:#a6e3a1">${weekCost.toFixed(2)}</span></div>
				<div class="usage-row"><span class="usage-label">Tokens</span><span class="usage-val">{formatTokens(weekTotal)}</span></div>
				<div class="usage-row"><span class="usage-label">Input</span><span class="usage-val">{formatTokens(c2.week?.input)}</span></div>
				<div class="usage-row"><span class="usage-label">Output</span><span class="usage-val">{formatTokens(c2.week?.output)}</span></div>
				{#if c2.week?.cache_read}
					<div class="usage-row"><span class="usage-label">Cache Read</span><span class="usage-val">{formatTokens(c2.week?.cache_read)}</span></div>
				{/if}
				<div class="usage-row"><span class="usage-label">Messages</span><span class="usage-val">{c2.week?.messages || 0}</span></div>
			{/if}
			<div style="margin-top:6px;font-size:9px;opacity:0.4;text-align:right">Based on Opus pricing: $3/$15/MTok in/out, $0.30 cache read</div>
		{:else}
			<div class="usage-row" style="opacity:0.5"><span class="usage-label">Loading tokens...</span></div>
		{/if}
	</div>

	<div class="usage-section">
		<div class="usage-heading">PAN Stats</div>
		{#if usage.data.stats}
			{@const s = usage.data.stats}
			<div class="usage-row"><span class="usage-label">Total Events</span><span class="usage-val">{s.total_events?.toLocaleString() || 0}</span></div>
			<div class="usage-row"><span class="usage-label">Total Sessions</span><span class="usage-val">{s.total_sessions?.toLocaleString() || 0}</span></div>
			<div class="usage-row"><span class="usage-label">Memory Items</span><span class="usage-val">{s.total_memory_items?.toLocaleString() || 0}</span></div>
			<div class="usage-row"><span class="usage-label">DB Size</span><span class="usage-val">{s.db_size || '--'}</span></div>
		{/if}
	</div>

	<!-- LLM Routing — where do PAN's internal LLM calls actually go.
	     Distinct from the Claude/Gemini sections above which show YOUR CLI
	     subscription burn. This shows the SERVER-side calls:
	     scout/router/intuition-classifier/etc → Cerebras vs Ollama (local). -->
	{#if usage.data.llmRouting}
		{@const r = usage.data.llmRouting}
		{@const cap = r.cerebras_personal_tier}
		{@const t = r.totals}
		{@const tpdPct = cap.tpd_cap > 0 ? (t.cloud_tokens_per_day / cap.tpd_cap * 100) : 0}
		{@const rpdPct = cap.rpd_cap > 0 ? (t.cloud_calls_per_day / cap.rpd_cap * 100) : 0}
		<div class="usage-section" style="background:rgba(116,199,236,0.06);border:1px solid rgba(116,199,236,0.18)">
			<div class="usage-heading" style="color:#74c7ec">PAN LLM Routing (7d)</div>
			<div class="usage-row" style="opacity:0.6; font-size:10px;">
				<span class="usage-label">where PAN's server-side calls go</span>
				<span class="usage-val">{r.window || '7d'}</span>
			</div>

			<!-- Cloud vs local split — the headline split the user actually
			     cares about. Vision/screen-watcher are LOCAL and don't burn
			     Cerebras quota. -->
			<div class="usage-subhead">Cloud vs Local</div>
			<div class="usage-row">
				<span class="usage-label" style="color:#74c7ec">Cloud / day</span>
				<span class="usage-val">{t.cloud_calls_per_day} calls · {formatTokens(t.cloud_tokens_per_day)} tok</span>
			</div>
			<div class="usage-row">
				<span class="usage-label" style="color:#a6e3a1">Local / day</span>
				<span class="usage-val">{t.local_calls_per_day} calls · free</span>
			</div>

			<!-- Cerebras personal-tier daily caps. % bar shows how close to
			     the wall you are; daily token cap (1M) is the real ceiling
			     for most users — RPM is rarely the binding constraint. -->
			<div class="usage-subhead">Cerebras Free Tier Caps</div>
			<div class="usage-bar-wrap">
				<div class="usage-bar" style="width:{Math.min(tpdPct, 100)}%; background:{tpdPct >= 80 ? '#f38ba8' : tpdPct >= 50 ? '#f9e2af' : '#a6e3a1'}"></div>
			</div>
			<div class="usage-row">
				<span class="usage-label" style="color:{tpdPct >= 80 ? '#f38ba8' : tpdPct >= 50 ? '#f9e2af' : '#a6e3a1'}">{tpdPct.toFixed(0)}% of {formatTokens(cap.tpd_cap)} tok/day</span>
				<span class="usage-val">{formatTokens(t.cloud_tokens_per_day)} avg</span>
			</div>
			<div class="usage-bar-wrap">
				<div class="usage-bar" style="width:{Math.min(rpdPct, 100)}%; background:{rpdPct >= 80 ? '#f38ba8' : rpdPct >= 50 ? '#f9e2af' : '#a6e3a1'}"></div>
			</div>
			<div class="usage-row">
				<span class="usage-label" style="color:{rpdPct >= 80 ? '#f38ba8' : rpdPct >= 50 ? '#f9e2af' : '#a6e3a1'}">{rpdPct.toFixed(0)}% of {cap.rpd_cap.toLocaleString()} req/day</span>
				<span class="usage-val">{t.cloud_calls_per_day} avg</span>
			</div>

			<!-- Per-caller table. Sorted by token usage so the biggest
			     budget burner is on top. Each row shows: caller name,
			     configured destination (the model it WILL hit next),
			     and 7d cloud spend so you know what's safe to keep on
			     Cerebras vs what should be moved to local if quota gets tight. -->
			<div class="usage-subhead">Top Callers (by 7d cloud tokens)</div>
			{#each r.callers.slice(0, 12) as c}
				{@const tok = c.cloud_tokens_7d}
				{@const isLocal = c.where_primary === 'local'}
				<div class="usage-row" style="font-size:11px;">
					<span class="usage-label" title={c.configured_model || ''}>
						<span style="color:{isLocal ? '#a6e3a1' : '#74c7ec'}">●</span>
						{c.caller}
					</span>
					<span class="usage-val">
						{c.calls_7d}/wk · {tok > 0 ? formatTokens(tok) : '—'}
					</span>
				</div>
				<div class="usage-row" style="font-size:9px; opacity:0.5; margin-top:-4px;">
					<span class="usage-label" style="padding-left:14px">→ {c.provider_primary || 'unknown'}</span>
					<span class="usage-val">{(c.configured_model || '').replace(/^cerebras:|^ollama:/, '')}</span>
				</div>
			{/each}

			<div style="margin-top:6px;font-size:9px;opacity:0.4;text-align:right">
				● cloud (Cerebras/Anthropic) · ● local (Ollama) · see docs/LLM-CALLERS.md
			</div>
		</div>
	{/if}
{/if}
