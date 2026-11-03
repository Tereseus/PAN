<!--
  InstancesPanel.svelte — Prod/Dev/Test environment switcher.
-->
<script>
	let { isDev = false } = $props();
</script>

<div class="instances-panel">
	<div class="svc-category">Switch Between Environments</div>
	<div class="instance-row">
		<span class="svc-dot up"></span>
		<div class="svc-info">
			<div class="svc-name">Prod</div>
			<div class="svc-detail">{isDev ? 'Port 7777' : 'Current'}</div>
		</div>
	</div>
	<div class="instance-row">
		<span class="svc-dot" class:up={isDev} class:unknown={!isDev}></span>
		<div class="svc-info">
			<div class="svc-name">Dev</div>
			<div class="svc-detail">{isDev ? 'Current' : 'Run: npm run dev'}</div>
		</div>
		{#if !isDev}
			<button class="instance-btn" onclick={async () => {
				const r = await fetch('/api/v1/dev/start', { method: 'POST' });
				const d = await r.json();
				const port = d.port || 7781;
				fetch('/api/v1/ui-commands', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ type: 'open_window', url: `http://localhost:${port}/v2/terminal` })
				});
			}}>Open</button>
			<button class="instance-btn restart" onclick={async () => {
				const r = await fetch('/api/v1/dev/restart', { method: 'POST' });
				const d = await r.json();
				if (d.ok) {
					const port = d.port || 7781;
					fetch('/api/v1/ui-commands', {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({ type: 'focus_window', url: `http://localhost:${port}/v2/terminal` })
					});
				}
			}}>Restart</button>
		{/if}
	</div>
	<div class="instance-row">
		<span class="svc-dot unknown"></span>
		<div class="svc-info">
			<div class="svc-name">Test</div>
			<div class="svc-detail">Coming Soon</div>
		</div>
	</div>
</div>
