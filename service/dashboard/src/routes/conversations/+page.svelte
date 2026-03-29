<script>
	import { api } from '$lib/api.js';

	const PAGE_SIZE = 50;

	let conversations = $state([]);
	let total = $state(0);
	let offset = $state(0);
	let loading = $state(true);
	let filter = $state('all');
	let search = $state('');
	let expandedId = $state(null);

	const filterOptions = [
		{ value: 'all', label: 'All' },
		{ value: 'voice', label: 'Voice' },
		{ value: 'commands', label: 'Commands' },
		{ value: 'photos', label: 'Photos' },
		{ value: 'sensors', label: 'Sensors' },
		{ value: 'system', label: 'System' },
	];

	const typeClasses = {
		PhoneAudio: 'type-voice',
		RouterCommand: 'type-command',
		SessionStart: 'type-session',
		SessionEnd: 'type-session',
		PhoneSync: 'type-sync',
		PandantPhoto: 'type-photo',
		SensorData: 'type-sensor',
		VisionAnalysis: 'type-vision',
	};

	async function loadConversations() {
		loading = true;
		try {
			let url = `/dashboard/api/conversations?limit=${PAGE_SIZE}&offset=${offset}`;
			if (filter !== 'all') url += `&filter=${filter}`;
			if (search) url += `&q=${encodeURIComponent(search)}`;
			const data = await api(url);
			conversations = data.conversations || [];
			total = data.total || 0;
		} catch {
			conversations = [];
			total = 0;
		}
		loading = false;
	}

	function doSearch() {
		offset = 0;
		loadConversations();
	}

	function onFilterChange(e) {
		filter = e.target.value;
		offset = 0;
		loadConversations();
	}

	function onSearchKey(e) {
		if (e.key === 'Enter') doSearch();
	}

	function prevPage() {
		if (offset > 0) {
			offset = Math.max(0, offset - PAGE_SIZE);
			loadConversations();
		}
	}

	function nextPage() {
		if (offset + PAGE_SIZE < total) {
			offset += PAGE_SIZE;
			loadConversations();
		}
	}

	function toggleExpand(id) {
		expandedId = expandedId === id ? null : id;
	}

	function fmtTime(ts) {
		if (!ts) return '';
		return new Date(ts).toLocaleString();
	}

	function timeAgo(ts) {
		if (!ts) return '';
		const diff = Date.now() - new Date(ts).getTime();
		const mins = Math.floor(diff / 60000);
		if (mins < 1) return 'just now';
		if (mins < 60) return `${mins}m ago`;
		const hrs = Math.floor(mins / 60);
		if (hrs < 24) return `${hrs}h ago`;
		const days = Math.floor(hrs / 24);
		return `${days}d ago`;
	}

	function extractTranscript(c) {
		if (c.transcript) return c.transcript;
		if (c.data) {
			const d = typeof c.data === 'string' ? (() => { try { return JSON.parse(c.data); } catch { return {}; } })() : c.data;
			return d.transcript || d.text || '';
		}
		return '';
	}

	function extractImage(c) {
		const d = typeof c.data === 'string' ? (() => { try { return JSON.parse(c.data); } catch { return {}; } })() : (c.data || {});
		return d.image_file || '';
	}

	function formatJson(data) {
		try {
			const obj = typeof data === 'string' ? JSON.parse(data) : data;
			return JSON.stringify(obj, null, 2);
		} catch { return String(data); }
	}

	$effect(() => {
		loadConversations();
	});

	let pageNum = $derived(Math.floor(offset / PAGE_SIZE) + 1);
	let totalPages = $derived(Math.ceil(total / PAGE_SIZE));
</script>

<div class="conversations-page">
	<div class="toolbar">
		<select class="filter-select" value={filter} onchange={onFilterChange}>
			{#each filterOptions as opt}
				<option value={opt.value}>{opt.label}</option>
			{/each}
		</select>
		<input
			type="text"
			class="search-input"
			placeholder="Search conversations..."
			bind:value={search}
			onkeydown={onSearchKey}
		/>
		<button class="btn" onclick={doSearch}>Search</button>
		<span class="result-count">{total} results</span>
	</div>

	{#if loading}
		<div class="muted">Loading...</div>
	{:else if conversations.length === 0}
		<div class="muted">No results found</div>
	{:else}
		<div class="convo-list">
			{#each conversations as c}
				{@const transcript = extractTranscript(c)}
				{@const image = extractImage(c)}
				{@const typeClass = typeClasses[c.event_type] || 'type-default'}
				{@const isExpanded = expandedId === c.id}
				<div class="convo-item">
					<div class="convo-meta">
						<span class="event-type {typeClass}">{c.event_type}</span>
						<span class="event-time">{fmtTime(c.created_at)} ({timeAgo(c.created_at)})</span>
						{#if c.route}
							<span class="event-type type-default">{c.route}</span>
						{/if}
						{#if c.model}
							<span class="model-tag">{c.model}</span>
						{/if}
					</div>
					{#if transcript}
						<div class="convo-user">{transcript}</div>
					{/if}
					{#if image}
						<div class="convo-image">
							<img src="/photos/{image}" alt="Captured" onerror={(e) => e.target.style.display='none'} />
						</div>
					{/if}
					{#if c.response}
						<div class="convo-response">{c.response}</div>
					{/if}
					<button class="expand-btn" onclick={() => toggleExpand(c.id)}>
						{isExpanded ? 'Hide Details' : 'Show Details'}
					</button>
					{#if isExpanded}
						<div class="convo-detail">
							<pre>{formatJson(c.data)}</pre>
						</div>
					{/if}
				</div>
			{/each}
		</div>

		<!-- Pagination -->
		{#if totalPages > 1}
			<div class="pagination">
				<button class="btn" onclick={prevPage} disabled={offset === 0}>Previous</button>
				<span class="page-info">Page {pageNum} of {totalPages}</span>
				<button class="btn" onclick={nextPage} disabled={offset + PAGE_SIZE >= total}>Next</button>
			</div>
		{/if}
	{/if}
</div>

<style>
	.conversations-page {
		padding: 24px;
		overflow-y: auto;
		height: 100%;
	}

	.toolbar {
		display: flex;
		align-items: center;
		gap: 8px;
		margin-bottom: 16px;
		flex-wrap: wrap;
	}

	.filter-select {
		background: #0a0a0f;
		color: #cdd6f4;
		border: 1px solid #1e1e2e;
		border-radius: 6px;
		padding: 6px 10px;
		font-size: 13px;
		font-family: 'Inter', sans-serif;
		outline: none;
	}

	.filter-select:focus { border-color: #89b4fa; }

	.search-input {
		flex: 1;
		min-width: 150px;
		background: #0a0a0f;
		color: #cdd6f4;
		border: 1px solid #1e1e2e;
		border-radius: 6px;
		padding: 6px 10px;
		font-size: 13px;
		font-family: 'Inter', sans-serif;
		outline: none;
	}

	.search-input:focus { border-color: #89b4fa; }

	.btn {
		padding: 6px 14px;
		background: #1a1a25;
		color: #cdd6f4;
		border: 1px solid #1e1e2e;
		border-radius: 6px;
		font-size: 12px;
		cursor: pointer;
		font-family: 'Inter', sans-serif;
	}

	.btn:hover { background: #252530; }
	.btn:disabled { opacity: 0.4; cursor: not-allowed; }

	.result-count { color: #6c7086; font-size: 12px; }

	.muted { color: #6c7086; font-size: 14px; text-align: center; padding: 20px; }

	.convo-list { display: grid; gap: 8px; }

	.convo-item {
		background: #12121a;
		border: 1px solid #1e1e2e;
		border-radius: 8px;
		padding: 12px 16px;
	}

	.convo-meta {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
		margin-bottom: 6px;
	}

	.event-type {
		font-size: 11px;
		padding: 2px 8px;
		border-radius: 4px;
		font-weight: 500;
	}

	.type-voice { background: rgba(137, 180, 250, 0.15); color: #89b4fa; }
	.type-command { background: rgba(166, 227, 161, 0.15); color: #a6e3a1; }
	.type-session { background: rgba(249, 226, 175, 0.15); color: #f9e2af; }
	.type-sync { background: rgba(108, 112, 134, 0.2); color: #6c7086; }
	.type-photo { background: rgba(203, 166, 247, 0.15); color: #cba6f7; }
	.type-sensor { background: rgba(148, 226, 213, 0.15); color: #94e2d5; }
	.type-vision { background: rgba(243, 139, 168, 0.15); color: #f38ba8; }
	.type-default { background: #1a1a25; color: #6c7086; }

	.event-time { font-size: 12px; color: #6c7086; }
	.model-tag { font-size: 12px; color: #6c7086; }

	.convo-user {
		font-size: 14px;
		color: #cdd6f4;
		line-height: 1.5;
		margin-bottom: 4px;
	}

	.convo-image {
		margin: 8px 0;
	}

	.convo-image img {
		max-width: 300px;
		max-height: 200px;
		border-radius: 8px;
		border: 1px solid #1e1e2e;
	}

	.convo-response {
		font-size: 13px;
		color: #89b4fa;
		line-height: 1.5;
		padding: 8px 12px;
		background: rgba(137, 180, 250, 0.05);
		border-radius: 6px;
		margin-top: 4px;
	}

	.expand-btn {
		background: none;
		border: none;
		color: #6c7086;
		font-size: 11px;
		cursor: pointer;
		padding: 4px 0;
		margin-top: 4px;
		font-family: 'Inter', sans-serif;
	}

	.expand-btn:hover { color: #89b4fa; }

	.convo-detail {
		margin-top: 8px;
		padding: 10px;
		background: #0a0a0f;
		border-radius: 6px;
		overflow-x: auto;
	}

	.convo-detail pre {
		font-size: 11px;
		color: #6c7086;
		white-space: pre-wrap;
		word-break: break-all;
		font-family: 'JetBrains Mono', monospace;
		margin: 0;
	}

	.pagination {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 12px;
		margin-top: 16px;
		padding: 12px 0;
	}

	.page-info { font-size: 13px; color: #6c7086; }
</style>
