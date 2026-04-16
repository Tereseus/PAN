<script>
	import { api } from '$lib/api.js';
	import { base } from '$app/paths';

	// Action categories for color coding & icons
	const CATEGORIES = {
		auth:     { icon: '🔑', color: '#f5c2e7', label: 'Auth' },
		team:     { icon: '👥', color: '#a6e3a1', label: 'Teams' },
		org:      { icon: '🏢', color: '#89b4fa', label: 'Org' },
		sensor:   { icon: '📡', color: '#f9e2af', label: 'Sensors' },
		zone:     { icon: '📍', color: '#fab387', label: 'Zones' },
		guardian: { icon: '🛡️', color: '#f38ba8', label: 'Guardian' },
		sync:     { icon: '🔄', color: '#94e2d5', label: 'Sync' },
		db:       { icon: '💾', color: '#cba6f7', label: 'Database' },
		incognito:{ icon: '👻', color: '#585b70', label: 'Incognito' },
		settings: { icon: '⚙️', color: '#6c7086', label: 'Settings' },
		backup:   { icon: '📦', color: '#74c7ec', label: 'Backup' },
		other:    { icon: '📝', color: '#cdd6f4', label: 'Other' },
	};

	function categorize(action) {
		if (!action) return 'other';
		const prefix = action.split('.')[0].split('_')[0];
		return CATEGORIES[prefix] ? prefix : 'other';
	}

	function actionLabel(action) {
		if (!action) return 'Unknown';
		return action.replace(/[._]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
	}

	function relativeTime(ts) {
		const diff = Date.now() - ts;
		if (diff < 60000) return 'just now';
		if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
		if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
		return `${Math.floor(diff / 86400000)}d ago`;
	}

	function formatTime(ts) {
		return new Date(ts).toLocaleString();
	}

	let entries = $state([]);
	let total = $state(0);
	let stats = $state(null);
	let chainStatus = $state(null);
	let loading = $state(true);
	let offset = $state(0);
	let limit = $state(50);
	let filterAction = $state('');
	let filterCategory = $state('');
	let searchText = $state('');
	let expandedId = $state(null);
	let guardianDecisions = $state([]);
	let showGuardian = $state(false);
	let users = $state({});

	async function loadEntries() {
		loading = true;
		try {
			let url = `/api/v1/audit/log?limit=${limit}&offset=${offset}`;
			if (filterAction) url += `&action=${encodeURIComponent(filterAction)}`;
			const data = await api(url);
			entries = data.entries || [];
			total = data.total || 0;

			// Load user display names
			const userIds = [...new Set(entries.map(e => e.user_id).filter(Boolean))];
			for (const uid of userIds) {
				if (!users[uid]) {
					try {
						const u = await api(`/dashboard/api/users/${uid}`);
						if (u?.display_name) users[uid] = u.display_name;
					} catch { /* ignore */ }
				}
			}
		} catch (e) {
			console.error('Failed to load audit log:', e);
			entries = [];
		}
		loading = false;
	}

	async function loadStats() {
		try {
			stats = await api('/api/v1/audit/stats');
			chainStatus = stats?.chain || null;
		} catch { stats = null; }
	}

	async function loadGuardian() {
		try {
			const d = await api('/api/v1/guardian/decisions');
			guardianDecisions = d.decisions || [];
		} catch { guardianDecisions = []; }
	}

	async function verifyChain() {
		try {
			chainStatus = await api('/api/v1/audit/verify');
		} catch { chainStatus = { ok: false, reason: 'Failed to verify' }; }
	}

	function nextPage() {
		if (offset + limit < total) {
			offset += limit;
			loadEntries();
		}
	}

	function prevPage() {
		if (offset > 0) {
			offset = Math.max(0, offset - limit);
			loadEntries();
		}
	}

	function setFilter(action) {
		filterAction = filterAction === action ? '' : action;
		offset = 0;
		loadEntries();
	}

	function toggleExpand(id) {
		expandedId = expandedId === id ? null : id;
	}

	let filteredEntries = $derived(() => {
		let result = entries;
		if (filterCategory) {
			result = result.filter(e => categorize(e.action) === filterCategory);
		}
		if (searchText) {
			const q = searchText.toLowerCase();
			result = result.filter(e =>
				e.action?.toLowerCase().includes(q) ||
				e.target?.toLowerCase().includes(q) ||
				(e.metadata_json || '').toLowerCase().includes(q)
			);
		}
		return result;
	});

	$effect(() => {
		loadEntries();
		loadStats();
		loadGuardian();
	});
</script>

<div class="timeline-page">
	<!-- Header -->
	<div class="timeline-header">
		<div class="header-left">
			<h2>Decision Timeline</h2>
			<span class="entry-count">{total} entries</span>
		</div>
		<div class="header-right">
			<input
				type="text"
				class="search-input"
				placeholder="Search actions..."
				bind:value={searchText}
			/>
			<select class="filter-select" bind:value={filterCategory}>
				<option value="">All categories</option>
				{#each Object.entries(CATEGORIES) as [key, cat]}
					<option value={key}>{cat.icon} {cat.label}</option>
				{/each}
			</select>
			<button class="btn-sm" class:active={showGuardian} onclick={() => showGuardian = !showGuardian}>
				🛡️ Guardian
			</button>
		</div>
	</div>

	<!-- Stats bar -->
	{#if stats}
		<div class="stats-bar">
			<div class="stat-card">
				<div class="stat-value">{stats.total || 0}</div>
				<div class="stat-label">Total Events</div>
			</div>
			<div class="stat-card">
				<div class="stat-value">{stats.by_action?.length || 0}</div>
				<div class="stat-label">Action Types</div>
			</div>
			<div class="stat-card">
				<div class="stat-value">{stats.by_user?.length || 0}</div>
				<div class="stat-label">Users</div>
			</div>
			<div class="stat-card chain" class:chain-ok={chainStatus?.ok} class:chain-broken={chainStatus && !chainStatus.ok}>
				<div class="stat-value">{chainStatus?.ok ? '✓' : chainStatus ? '✗' : '?'}</div>
				<div class="stat-label">Chain {chainStatus?.ok ? 'Valid' : chainStatus ? 'Broken' : 'Unknown'}</div>
				<button class="verify-btn" onclick={verifyChain} title="Verify HMAC chain">⟳</button>
			</div>

			<!-- Action type breakdown (top 6) -->
			{#if stats.by_action?.length > 0}
				<div class="stat-card wide">
					<div class="stat-label" style="margin-bottom: 6px">Top Actions</div>
					<div class="action-chips">
						{#each stats.by_action.slice(0, 6) as a}
							{@const cat = categorize(a.action)}
							<button
								class="action-chip"
								class:active={filterAction === a.action}
								style="border-color: {CATEGORIES[cat]?.color || '#6c7086'}"
								onclick={() => setFilter(a.action)}
							>
								{CATEGORIES[cat]?.icon || '📝'} {a.action} <span class="chip-count">{a.count}</span>
							</button>
						{/each}
					</div>
				</div>
			{/if}
		</div>
	{/if}

	<!-- Guardian Decisions panel -->
	{#if showGuardian}
		<div class="guardian-panel">
			<h3>🛡️ Guardian Security Decisions</h3>
			{#if guardianDecisions.length === 0}
				<div class="muted">No guardian decisions recorded yet.</div>
			{:else}
				<div class="guardian-list">
					{#each guardianDecisions.slice(0, 20) as d}
						<div class="guardian-entry" class:blocked={d.decision === 'blocked'} class:warned={d.decision === 'warned'}>
							<div class="guardian-top">
								<span class="guardian-decision" class:decision-blocked={d.decision === 'blocked'} class:decision-warned={d.decision === 'warned'} class:decision-allowed={d.decision === 'allowed'}>
									{d.decision?.toUpperCase()}
								</span>
								<span class="guardian-class">{d.classification}</span>
								<span class="guardian-risk">Risk: {(d.risk_score * 100).toFixed(0)}%</span>
								<span class="guardian-time">{relativeTime(d.ts)}</span>
							</div>
							{#if d.content_preview}
								<div class="guardian-preview">{d.content_preview}</div>
							{/if}
							{#if d.risk_reasons}
								<div class="guardian-reasons">
									{#each (typeof d.risk_reasons === 'string' ? JSON.parse(d.risk_reasons) : d.risk_reasons || []) as reason}
										<span class="reason-tag">{reason}</span>
									{/each}
								</div>
							{/if}
						</div>
					{/each}
				</div>
			{/if}
		</div>
	{/if}

	<!-- Timeline -->
	{#if loading}
		<div class="muted">Loading timeline...</div>
	{:else if filteredEntries().length === 0}
		<div class="muted">No audit events found{filterAction ? ` for "${filterAction}"` : ''}.</div>
	{:else}
		<div class="timeline">
			<div class="timeline-line"></div>
			{#each filteredEntries() as entry (entry.id)}
				{@const cat = categorize(entry.action)}
				{@const catInfo = CATEGORIES[cat] || CATEGORIES.other}
				<div class="timeline-entry" class:expanded={expandedId === entry.id} onclick={() => toggleExpand(entry.id)}>
					<div class="entry-dot" style="background: {catInfo.color}">
						<span class="entry-icon">{catInfo.icon}</span>
					</div>
					<div class="entry-card">
						<div class="entry-header">
							<span class="entry-action">{actionLabel(entry.action)}</span>
							<span class="entry-category" style="color: {catInfo.color}">{catInfo.label}</span>
							<span class="entry-time" title={formatTime(entry.ts)}>{relativeTime(entry.ts)}</span>
						</div>
						{#if entry.target}
							<div class="entry-target">→ {entry.target}</div>
						{/if}
						{#if entry.user_id}
							<div class="entry-user">by {users[entry.user_id] || `User #${entry.user_id}`}</div>
						{/if}

						{#if expandedId === entry.id}
							<div class="entry-details">
								<div class="detail-row"><span class="detail-key">ID</span><span class="detail-val">{entry.id}</span></div>
								<div class="detail-row"><span class="detail-key">Time</span><span class="detail-val">{formatTime(entry.ts)}</span></div>
								<div class="detail-row"><span class="detail-key">Org</span><span class="detail-val">{entry.org_id}</span></div>
								{#if entry.signature}
									<div class="detail-row"><span class="detail-key">Sig</span><span class="detail-val sig">{entry.signature.slice(0, 16)}...</span></div>
								{/if}
								{#if entry.metadata}
									<div class="detail-meta">
										<span class="detail-key">Metadata</span>
										<pre class="meta-json">{JSON.stringify(entry.metadata, null, 2)}</pre>
									</div>
								{/if}
							</div>
						{/if}
					</div>
				</div>
			{/each}
		</div>

		<!-- Pagination -->
		<div class="pagination">
			<button class="btn-sm" disabled={offset === 0} onclick={prevPage}>← Prev</button>
			<span class="page-info">{offset + 1}–{Math.min(offset + limit, total)} of {total}</span>
			<button class="btn-sm" disabled={offset + limit >= total} onclick={nextPage}>Next →</button>
		</div>
	{/if}
</div>

<style>
	.timeline-page {
		padding: 20px 24px;
		height: 100%;
		overflow-y: auto;
		font-family: 'Inter', sans-serif;
		color: #cdd6f4;
	}

	/* Header */
	.timeline-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		margin-bottom: 16px;
		flex-wrap: wrap;
		gap: 12px;
	}

	.header-left {
		display: flex;
		align-items: baseline;
		gap: 12px;
	}

	.header-left h2 {
		margin: 0;
		font-size: 20px;
		color: #cdd6f4;
	}

	.entry-count {
		font-size: 12px;
		color: #6c7086;
		background: #1e1e2e;
		padding: 2px 8px;
		border-radius: 10px;
	}

	.header-right {
		display: flex;
		gap: 8px;
		align-items: center;
		flex-wrap: wrap;
	}

	.search-input {
		background: #12121a;
		color: #cdd6f4;
		border: 1px solid #1e1e2e;
		border-radius: 6px;
		padding: 6px 10px;
		font-size: 13px;
		font-family: 'Inter', sans-serif;
		width: 180px;
	}

	.search-input:focus { border-color: #89b4fa; outline: none; }
	.search-input::placeholder { color: #585b70; }

	.filter-select {
		background: #12121a;
		color: #cdd6f4;
		border: 1px solid #1e1e2e;
		border-radius: 6px;
		padding: 6px 10px;
		font-size: 13px;
		font-family: 'Inter', sans-serif;
		cursor: pointer;
	}

	.filter-select:focus { border-color: #89b4fa; outline: none; }

	.btn-sm {
		padding: 5px 12px;
		font-size: 12px;
		border-radius: 4px;
		border: 1px solid #1e1e2e;
		background: #12121a;
		color: #cdd6f4;
		cursor: pointer;
		font-family: 'Inter', sans-serif;
	}

	.btn-sm:hover { border-color: #89b4fa; }
	.btn-sm:disabled { opacity: 0.4; cursor: default; }
	.btn-sm.active { background: #89b4fa; color: #0a0a0f; border-color: #89b4fa; }

	/* Stats bar */
	.stats-bar {
		display: flex;
		gap: 10px;
		margin-bottom: 16px;
		flex-wrap: wrap;
	}

	.stat-card {
		background: #12121a;
		border: 1px solid #1e1e2e;
		border-radius: 8px;
		padding: 10px 14px;
		min-width: 90px;
		position: relative;
	}

	.stat-card.wide {
		flex: 1;
		min-width: 300px;
	}

	.stat-value {
		font-size: 20px;
		font-weight: 700;
		color: #cdd6f4;
	}

	.stat-label {
		font-size: 11px;
		color: #6c7086;
	}

	.stat-card.chain-ok { border-color: #a6e3a1; }
	.stat-card.chain-ok .stat-value { color: #a6e3a1; }
	.stat-card.chain-broken { border-color: #f38ba8; }
	.stat-card.chain-broken .stat-value { color: #f38ba8; }

	.verify-btn {
		position: absolute;
		top: 6px;
		right: 6px;
		background: none;
		border: none;
		color: #6c7086;
		font-size: 14px;
		cursor: pointer;
		padding: 2px;
	}

	.verify-btn:hover { color: #89b4fa; }

	.action-chips {
		display: flex;
		gap: 6px;
		flex-wrap: wrap;
	}

	.action-chip {
		background: #0a0a0f;
		border: 1px solid #1e1e2e;
		border-radius: 4px;
		padding: 3px 8px;
		font-size: 11px;
		color: #cdd6f4;
		cursor: pointer;
		font-family: 'Inter', sans-serif;
	}

	.action-chip:hover { border-color: #89b4fa; }
	.action-chip.active { background: #1e1e2e; }

	.chip-count {
		color: #6c7086;
		font-size: 10px;
		margin-left: 3px;
	}

	/* Guardian panel */
	.guardian-panel {
		background: #12121a;
		border: 1px solid #f38ba8;
		border-radius: 8px;
		padding: 14px 16px;
		margin-bottom: 16px;
	}

	.guardian-panel h3 {
		margin: 0 0 10px;
		font-size: 14px;
		color: #f38ba8;
	}

	.guardian-list {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.guardian-entry {
		background: #0a0a0f;
		border: 1px solid #1e1e2e;
		border-radius: 6px;
		padding: 8px 10px;
	}

	.guardian-entry.blocked { border-color: #f38ba8; }
	.guardian-entry.warned { border-color: #f9e2af; }

	.guardian-top {
		display: flex;
		gap: 10px;
		align-items: center;
		font-size: 12px;
	}

	.guardian-decision {
		font-weight: 700;
		font-size: 10px;
		padding: 1px 6px;
		border-radius: 3px;
		background: #a6e3a1;
		color: #0a0a0f;
	}

	.decision-blocked { background: #f38ba8; }
	.decision-warned { background: #f9e2af; }
	.decision-allowed { background: #a6e3a1; }

	.guardian-class { color: #6c7086; }
	.guardian-risk { color: #fab387; }
	.guardian-time { color: #585b70; margin-left: auto; }

	.guardian-preview {
		font-size: 11px;
		color: #6c7086;
		margin-top: 4px;
		line-height: 1.3;
		word-break: break-word;
	}

	.guardian-reasons {
		display: flex;
		gap: 4px;
		flex-wrap: wrap;
		margin-top: 4px;
	}

	.reason-tag {
		font-size: 10px;
		background: rgba(243, 139, 168, 0.15);
		color: #f38ba8;
		padding: 1px 6px;
		border-radius: 3px;
	}

	/* Timeline */
	.timeline {
		position: relative;
		padding-left: 40px;
	}

	.timeline-line {
		position: absolute;
		left: 18px;
		top: 0;
		bottom: 0;
		width: 2px;
		background: #1e1e2e;
	}

	.timeline-entry {
		position: relative;
		margin-bottom: 6px;
		cursor: pointer;
	}

	.entry-dot {
		position: absolute;
		left: -32px;
		top: 10px;
		width: 26px;
		height: 26px;
		border-radius: 50%;
		display: flex;
		align-items: center;
		justify-content: center;
		border: 2px solid #0a0a0f;
		z-index: 1;
	}

	.entry-icon {
		font-size: 12px;
	}

	.entry-card {
		background: #12121a;
		border: 1px solid #1e1e2e;
		border-radius: 6px;
		padding: 10px 14px;
		transition: border-color 0.15s;
	}

	.timeline-entry:hover .entry-card { border-color: #313244; }
	.timeline-entry.expanded .entry-card { border-color: #89b4fa; }

	.entry-header {
		display: flex;
		gap: 10px;
		align-items: center;
	}

	.entry-action {
		font-size: 13px;
		font-weight: 500;
		color: #cdd6f4;
	}

	.entry-category {
		font-size: 10px;
		font-weight: 600;
	}

	.entry-time {
		font-size: 11px;
		color: #585b70;
		margin-left: auto;
	}

	.entry-target {
		font-size: 11px;
		color: #89b4fa;
		margin-top: 3px;
	}

	.entry-user {
		font-size: 11px;
		color: #6c7086;
		margin-top: 2px;
	}

	/* Expanded details */
	.entry-details {
		margin-top: 10px;
		padding-top: 10px;
		border-top: 1px solid #1e1e2e;
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.detail-row {
		display: flex;
		gap: 10px;
		font-size: 11px;
	}

	.detail-key {
		color: #6c7086;
		min-width: 50px;
		font-weight: 500;
	}

	.detail-val {
		color: #cdd6f4;
	}

	.detail-val.sig {
		font-family: monospace;
		color: #a6e3a1;
		font-size: 10px;
	}

	.detail-meta {
		margin-top: 4px;
	}

	.meta-json {
		background: #0a0a0f;
		border: 1px solid #1e1e2e;
		border-radius: 4px;
		padding: 8px;
		font-size: 11px;
		font-family: monospace;
		color: #94e2d5;
		overflow-x: auto;
		margin-top: 4px;
		white-space: pre-wrap;
		word-break: break-word;
	}

	/* Pagination */
	.pagination {
		display: flex;
		gap: 12px;
		align-items: center;
		justify-content: center;
		margin: 16px 0;
	}

	.page-info {
		font-size: 12px;
		color: #6c7086;
	}

	.muted {
		color: #585b70;
		font-size: 13px;
		text-align: center;
		padding: 40px 0;
	}
</style>
