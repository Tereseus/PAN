<script>
	// Root route — redirect to /terminal so PAN dashboard lands on the
	// terminal view by default instead of the chat view.
	// Chat view is preserved at /chat.
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { base } from '$app/paths';

	onMount(() => {
		goto(`${base}/terminal`, { replaceState: true });
	});
</script>

<div class="redirecting">Loading Terminal…</div>

<style>
	.redirecting {
		height: 100%;
		display: flex;
		align-items: center;
		justify-content: center;
		color: #6c7086;
		font-size: 13px;
	}
</style>
