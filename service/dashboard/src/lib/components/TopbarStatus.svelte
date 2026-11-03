<!--
  TopbarStatus.svelte — at-a-glance dashboard health chip.

  Lives at the right side of the topbar. Every 1s it scans the whole document
  for elements carrying `data-widget="<name>"` + `data-widget-state="loading|
  ok|empty|error|stale"` (the contract every dashboard widget already emits —
  see docs/DASHBOARD-WIDGETS.md). Aggregates counts and shows:

    [↻ 4/12 loading]    ← active load happening; spinner pulse
    [✓ 12 ready]        ← steady state, no issues
    [⚠ 2 issues]        ← one or more widgets in error/stale state

  Click the chip → expands a small panel listing each non-OK widget with its
  current state. So when the user yells "what the fuck is loading?" they can
  see the answer instead of guessing.

  Why DOM scan instead of a store: widgets are scattered across many components
  in many directories, each managing its own state internally. A DOM scan
  reads the contract that's already there with zero coupling — adding new
  widgets requires no change to this component as long as they keep emitting
  data-widget-state.
-->
<script>
	import { onMount, onDestroy } from 'svelte';

	let scanTimer = null;
	let panels = $state([]);            // [{ name, state }]
	let counts = $state({ loading: 0, ok: 0, empty: 0, error: 0, stale: 0, total: 0 });
	let expanded = $state(false);
	let chipEl = $state(null);

	function scanWidgets() {
		if (typeof document === 'undefined') return;
		const nodes = document.querySelectorAll('[data-widget][data-widget-state]');
		const seen = new Map(); // dedupe — sometimes the same widget renders twice (left + right sections)
		for (const n of nodes) {
			const name = n.getAttribute('data-widget');
			const state = n.getAttribute('data-widget-state');
			if (!name || !state) continue;
			// Priority for dedupe: error > stale > empty > loading > ok (worst wins)
			const prev = seen.get(name);
			if (!prev || _statePriority(state) > _statePriority(prev)) {
				seen.set(name, state);
			}
		}
		const next = [...seen.entries()].map(([name, state]) => ({ name, state })).sort((a, b) => a.name.localeCompare(b.name));
		panels = next;
		const c = { loading: 0, ok: 0, empty: 0, error: 0, stale: 0, total: next.length };
		for (const p of next) c[p.state] = (c[p.state] || 0) + 1;
		counts = c;
	}

	function _statePriority(state) {
		switch (state) {
			case 'error':   return 5;
			case 'stale':   return 4;
			case 'empty':   return 3;
			case 'loading': return 2;
			case 'ok':      return 1;
			default:        return 0;
		}
	}

	// Click anywhere outside the chip closes the expanded panel.
	function onDocClick(ev) {
		if (!expanded) return;
		if (chipEl && !chipEl.contains(ev.target)) expanded = false;
	}

	onMount(() => {
		scanWidgets();
		scanTimer = setInterval(scanWidgets, 1000);
		document.addEventListener('click', onDocClick);
	});

	onDestroy(() => {
		if (scanTimer) clearInterval(scanTimer);
		if (typeof document !== 'undefined') document.removeEventListener('click', onDocClick);
	});

	let summaryLabel = $derived.by(() => {
		if (counts.total === 0) return '…';
		const issues = counts.error + counts.stale + counts.empty;
		if (counts.loading > 0) {
			const done = counts.total - counts.loading;
			return `↻ ${done}/${counts.total} loading`;
		}
		if (issues > 0) return `⚠ ${issues} issue${issues > 1 ? 's' : ''}`;
		return `✓ ${counts.ok} ready`;
	});

	let summaryClass = $derived.by(() => {
		if (counts.total === 0) return 'pending';
		if (counts.loading > 0) return 'loading';
		if (counts.error > 0 || counts.stale > 0 || counts.empty > 0) return 'issues';
		return 'ok';
	});

	let issueRows = $derived(panels.filter((p) => p.state !== 'ok'));
</script>

<div class="status-chip-wrap" bind:this={chipEl}>
	<button
		class="status-chip {summaryClass}"
		onclick={() => (expanded = !expanded)}
		title="Click for details"
		aria-expanded={expanded}
	>
		<span class="status-text">{summaryLabel}</span>
	</button>

	{#if expanded}
		<div class="status-panel">
			<div class="status-panel-header">
				<span>Dashboard status</span>
				<span class="status-counts">
					{#if counts.ok}<span class="badge ok">{counts.ok} ok</span>{/if}
					{#if counts.loading}<span class="badge loading">{counts.loading} load</span>{/if}
					{#if counts.empty}<span class="badge empty">{counts.empty} empty</span>{/if}
					{#if counts.stale}<span class="badge stale">{counts.stale} stale</span>{/if}
					{#if counts.error}<span class="badge error">{counts.error} err</span>{/if}
				</span>
			</div>
			{#if issueRows.length === 0}
				<div class="status-row-empty">All widgets healthy.</div>
			{:else}
				<div class="status-rows">
					{#each issueRows as row}
						<div class="status-row" data-state={row.state}>
							<span class="status-dot" data-state={row.state}></span>
							<span class="status-name">{row.name}</span>
							<span class="status-state">{row.state}</span>
						</div>
					{/each}
				</div>
			{/if}
			<div class="status-footer">
				Scanning every 1s · {counts.total} widgets reporting
			</div>
		</div>
	{/if}
</div>

<style>
	.status-chip-wrap {
		position: relative;
		display: inline-flex;
		align-items: center;
		margin-right: 8px;
	}

	.status-chip {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		padding: 4px 10px;
		font-size: 11px;
		font-weight: 600;
		font-family: 'Inter', -apple-system, sans-serif;
		border-radius: 12px;
		border: 1px solid transparent;
		cursor: pointer;
		transition: background 120ms, border-color 120ms;
		background: rgba(108, 112, 134, 0.18);
		color: #cdd6f4;
		white-space: nowrap;
		user-select: none;
		min-width: 80px;
		justify-content: center;
	}
	.status-chip:hover { background: rgba(108, 112, 134, 0.3); }
	.status-chip.pending { color: #6c7086; }
	.status-chip.loading {
		background: rgba(137, 180, 250, 0.15);
		border-color: rgba(137, 180, 250, 0.35);
		color: #89b4fa;
		animation: pulse 1.4s ease-in-out infinite;
	}
	.status-chip.issues {
		background: rgba(243, 139, 168, 0.18);
		border-color: rgba(243, 139, 168, 0.42);
		color: #f38ba8;
	}
	.status-chip.ok {
		background: rgba(166, 227, 161, 0.15);
		border-color: rgba(166, 227, 161, 0.32);
		color: #a6e3a1;
	}

	@keyframes pulse {
		0%, 100% { opacity: 1; }
		50%      { opacity: 0.55; }
	}

	.status-panel {
		position: absolute;
		top: calc(100% + 6px);
		right: 0;
		min-width: 280px;
		max-width: 380px;
		max-height: 60vh;
		overflow-y: auto;
		background: #1e1e2e;
		border: 1px solid #45475a;
		border-radius: 8px;
		box-shadow: 0 10px 32px rgba(0, 0, 0, 0.45);
		z-index: 50;
		font-family: 'Inter', -apple-system, sans-serif;
	}
	.status-panel-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 8px;
		padding: 10px 12px;
		border-bottom: 1px solid #313244;
		font-size: 12px;
		font-weight: 600;
		color: #cdd6f4;
	}
	.status-counts {
		display: inline-flex;
		gap: 4px;
		flex-wrap: wrap;
		justify-content: flex-end;
	}
	.badge {
		font-size: 10px;
		padding: 1px 6px;
		border-radius: 8px;
		font-weight: 600;
	}
	.badge.ok { background: rgba(166, 227, 161, 0.18); color: #a6e3a1; }
	.badge.loading { background: rgba(137, 180, 250, 0.18); color: #89b4fa; }
	.badge.empty { background: rgba(249, 226, 175, 0.18); color: #f9e2af; }
	.badge.stale { background: rgba(250, 179, 135, 0.18); color: #fab387; }
	.badge.error { background: rgba(243, 139, 168, 0.18); color: #f38ba8; }

	.status-row-empty {
		padding: 14px 12px;
		font-size: 11px;
		color: #a6adc8;
		text-align: center;
	}
	.status-rows { padding: 4px 0; }
	.status-row {
		display: grid;
		grid-template-columns: 12px 1fr auto;
		align-items: center;
		gap: 8px;
		padding: 6px 12px;
		font-size: 11px;
		color: #cdd6f4;
	}
	.status-row:hover { background: rgba(108, 112, 134, 0.1); }
	.status-name { font-weight: 500; }
	.status-state {
		font-size: 10px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.3px;
		color: #a6adc8;
	}
	.status-row[data-state="error"] .status-state { color: #f38ba8; }
	.status-row[data-state="stale"] .status-state { color: #fab387; }
	.status-row[data-state="empty"] .status-state { color: #f9e2af; }
	.status-row[data-state="loading"] .status-state { color: #89b4fa; }
	.status-dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: #6c7086;
	}
	.status-dot[data-state="ok"] { background: #a6e3a1; }
	.status-dot[data-state="loading"] { background: #89b4fa; }
	.status-dot[data-state="empty"] { background: #f9e2af; }
	.status-dot[data-state="stale"] { background: #fab387; }
	.status-dot[data-state="error"] { background: #f38ba8; }

	.status-footer {
		padding: 6px 12px;
		font-size: 10px;
		color: #6c7086;
		border-top: 1px solid #313244;
		text-align: center;
	}
</style>
