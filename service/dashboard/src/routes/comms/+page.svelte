<script>
	import { api } from '$lib/api.js';

	let loading = $state(true);

	$effect(() => {
		loading = false;
	});
</script>

<div class="comms-page">
	<h2>Comms</h2>
	{#if loading}
		<p>Loading...</p>
	{:else}
		<p class="empty-state">Communications hub — coming soon.</p>
	{/if}
</div>

<style>
	.comms-page {
		padding: 1.5rem;
		color: var(--text, #e0e0e0);
	}
	h2 {
		margin: 0 0 1rem;
		font-size: 1.4rem;
	}
	.empty-state {
		color: var(--text-muted, #888);
		font-style: italic;
	}
</style>
