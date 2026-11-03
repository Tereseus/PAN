<!--
  ServicesPanel.svelte — extracted from terminal/+page.svelte (Shape-2 refactor).

  Shows PAN Core services + Device services with up/down/unknown status dots.
  Loaded from /dashboard/api/services; refreshed by parent via WS push and on
  reconnect. Parent passes the data as a prop so a single fetch feeds both
  left- and right-column mounts.
-->
<script>
	// 2026-05-28: migrated to read from `services` store directly. No props.
	// Parent's `servicesData` was lifted to `lib/stores/services.svelte.js`.
	import { services } from '$lib/stores/services.svelte.js';

	const coreServices = $derived(services.list.filter(s => s.category === 'PAN Core'));
	const deviceServices = $derived(services.list.filter(s => s.category === 'Devices'));
</script>

{#if coreServices.length > 0}
	<div class="svc-category">PAN Core</div>
	{#each coreServices as svc}
		<div class="svc-row">
			<span class="svc-dot" class:up={svc.status === 'up'} class:down={svc.status === 'down' || svc.status === 'offline'} class:unknown={svc.status === 'unknown'}></span>
			<div class="svc-info">
				<div class="svc-name">{svc.name}</div>
				{#if svc.role}<div class="svc-detail" style="color:#cba6f7;font-size:10px">{svc.role}</div>{/if}
				<div class="svc-detail">{svc.detail}</div>
			</div>
		</div>
	{/each}
{/if}
{#if deviceServices.length > 0}
	<div class="svc-category">Devices</div>
	{#each deviceServices as svc}
		<div class="svc-row">
			<span class="svc-dot" class:up={svc.status === 'up'} class:down={svc.status === 'down'} class:unknown={svc.status === 'unknown'}></span>
			<div class="svc-info">
				<div class="svc-name">{svc.name}</div>
				<div class="svc-detail">{svc.detail}</div>
			</div>
		</div>
	{/each}
{/if}
{#if services.list.length === 0}
	<div class="empty-state">Loading services...</div>
{/if}
