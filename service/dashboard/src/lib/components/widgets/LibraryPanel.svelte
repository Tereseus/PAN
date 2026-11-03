<!--
  LibraryPanel.svelte — extracted from terminal/+page.svelte (Shape-2 refactor).

  Search + filter view over /api/v1/library items (docs, memory, PAN state).
  Click a row to open the item in a new window.
-->
<script>
	import { onMount, onDestroy } from 'svelte';

	let libraryItems = $state([]);
	let libraryFilter = $state('all');
	let libraryQuery = $state('');

	async function loadLibrary() {
		try {
			const r = await fetch('/api/v1/library');
			const j = await r.json();
			libraryItems = j.items || [];
		} catch (e) { libraryItems = []; }
	}

	function openLibraryItem(item) {
		const url = `${window.location.origin}/api/v1/library/view?path=${encodeURIComponent(item.path)}`;
		const win = window.open(url, '_blank', 'width=1100,height=800');
		if (!win) {
			fetch('/api/v1/ui-commands', {
				method: 'POST', headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ type: 'open_window', url })
			});
		}
	}

	const filtered = $derived.by(() => {
		const q = libraryQuery.trim().toLowerCase();
		return libraryItems.filter(i => {
			if (libraryFilter !== 'all' && i.type !== libraryFilter) return false;
			if (q && !i.title.toLowerCase().includes(q) && !(i.snippet || '').toLowerCase().includes(q)) return false;
			return true;
		});
	});

	let _wsHandler = null;
	onMount(() => {
		loadLibrary();
		_wsHandler = () => loadLibrary();
		if (typeof window !== 'undefined') {
			window.addEventListener('pan:library-update', _wsHandler);
		}
	});
	onDestroy(() => {
		if (typeof window !== 'undefined' && _wsHandler) {
			window.removeEventListener('pan:library-update', _wsHandler);
		}
	});
</script>

<div class="library-panel">
	<div class="library-toolbar">
		<input type="text" class="library-search" placeholder="Search library..." bind:value={libraryQuery} />
		<select class="library-filter" bind:value={libraryFilter}>
			<option value="all">All</option>
			<option value="doc">Docs</option>
			<option value="memory">Memory</option>
			<option value="pan">PAN State</option>
		</select>
		<button class="library-refresh" onclick={loadLibrary}>↻</button>
	</div>
	<div class="library-list">
		{#each filtered as item (item.path)}
			<div class="library-row" onclick={() => openLibraryItem(item)}>
				<div class="library-row-head">
					<span class="library-type library-type-{item.type}">{item.type}</span>
					<span class="library-title">{item.title}</span>
				</div>
				{#if item.snippet}<div class="library-snippet">{item.snippet}</div>{/if}
			</div>
		{/each}
		{#if filtered.length === 0}
			<div class="empty-state">No items</div>
		{/if}
	</div>
</div>
