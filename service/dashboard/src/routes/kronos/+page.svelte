<script>
	import { onMount } from 'svelte';

	// ── State ──
	let entries = $state([]);
	let stats = $state(null);
	let chainStatus = $state(null);
	let loading = $state(true);
	let day0Ts = $state(null);
	let totalDays = $state(0);

	// View transform
	let transform = $state({ x: 0, y: 0, scale: 1 });
	let dragging = $state(false);
	let dragStart = $state({ x: 0, y: 0, tx: 0, ty: 0 });

	// Interaction
	let hoveredId = $state(null);
	let selectedEntry = $state(null);
	let filterCategory = $state('');
	let searchText = $state('');

	// Tree layout constants
	const TRUNK_X = 500;         // center trunk x position
	const DAY_HEIGHT = 180;      // pixels per day (vertical)
	const BRANCH_MIN = 80;       // min branch length
	const BRANCH_MAX = 260;      // max branch length
	const NODE_SPACING_Y = 28;   // vertical spacing between nodes in same day
	const MIN_SCALE = 0.03;
	const MAX_SCALE = 4;

	// Categories
	const CATS = {
		auth:      { icon: '🔑', color: '#f5c2e7', label: 'Auth' },
		team:      { icon: '👥', color: '#a6e3a1', label: 'Teams' },
		org:       { icon: '🏢', color: '#89b4fa', label: 'Org' },
		sensor:    { icon: '📡', color: '#f9e2af', label: 'Sensors' },
		zone:      { icon: '📍', color: '#fab387', label: 'Zones' },
		guardian:  { icon: '🛡', color: '#f38ba8', label: 'Guardian' },
		sync:      { icon: '🔄', color: '#94e2d5', label: 'Sync' },
		db:        { icon: '💾', color: '#cba6f7', label: 'Database' },
		incognito: { icon: '👻', color: '#585b70', label: 'Incognito' },
		settings:  { icon: '⚙', color: '#6c7086', label: 'Settings' },
		backup:    { icon: '📦', color: '#74c7ec', label: 'Backup' },
		other:     { icon: '📝', color: '#cdd6f4', label: 'Other' },
	};

	function categorize(action) {
		if (!action) return 'other';
		const p = action.split('.')[0].split('_')[0];
		return CATS[p] ? p : 'other';
	}

	function dayNumber(ts) {
		if (!day0Ts) return 0;
		return Math.floor((ts - day0Ts) / 86400000);
	}

	function dayLabel(d) {
		return `Day ${d}`;
	}

	function actionLabel(action) {
		if (!action) return 'Unknown';
		return action.replace(/[._]/g, ' ');
	}

	function formatTime(ts) {
		return new Date(ts).toLocaleString();
	}

	function relativeTime(ts) {
		const diff = Date.now() - ts;
		if (diff < 60000) return 'just now';
		if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
		if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
		return `${Math.floor(diff / 86400000)}d ago`;
	}

	// ── Layout: vertical tree, growing upward ──
	// Y increases downward in SVG, so "bottom" = large Y = oldest, "top" = small Y = newest
	function layoutEntries(raw) {
		if (!raw.length) return [];
		const sorted = [...raw].sort((a, b) => a.ts - b.ts);
		day0Ts = sorted[0].ts;
		const lastTs = sorted[sorted.length - 1].ts;
		totalDays = Math.max(1, dayNumber(lastTs) + 1);

		// Group by day
		const dayBuckets = {};
		for (const e of sorted) {
			const d = dayNumber(e.ts);
			if (!dayBuckets[d]) dayBuckets[d] = [];
			dayBuckets[d].push(e);
		}

		const positioned = [];
		for (const [day, bucket] of Object.entries(dayBuckets)) {
			const d = parseInt(day);
			// Y: invert so newest is at top. Day 0 (oldest) gets highest Y
			const baseY = (totalDays - d) * DAY_HEIGHT + 100;

			for (let i = 0; i < bucket.length; i++) {
				const e = bucket[i];
				const cat = categorize(e.action);
				// Alternate left/right
				const side = i % 2 === 0 ? -1 : 1;
				const tier = Math.floor(i / 2);
				// Branch length varies by tier — inner nodes shorter
				const branchLen = BRANCH_MIN + (tier % 4) * 50;
				const xOffset = side * branchLen;
				// Slight vertical offset within day
				const dayStart = day0Ts + d * 86400000;
				const frac = (e.ts - dayStart) / 86400000;
				const subY = frac * DAY_HEIGHT * 0.7;

				positioned.push({
					...e,
					cat,
					catInfo: CATS[cat],
					x: TRUNK_X + xOffset,
					y: baseY - subY,
					trunkY: baseY - subY, // where the branch meets the trunk
					day: d,
					side,
					branchLen: Math.abs(xOffset),
					metadata: e.metadata_json ? (() => { try { return JSON.parse(e.metadata_json); } catch { return null; } })() : null,
				});
			}
		}
		return positioned;
	}

	// ── Filtered + laid out entries ──
	let laidOut = $state([]);
	let filteredLayout = $derived(() => {
		let result = laidOut;
		if (filterCategory) result = result.filter(e => e.cat === filterCategory);
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

	// Day markers along the vertical trunk
	let dayMarkers = $derived(() => {
		const markers = [];
		for (let d = 0; d <= totalDays; d++) {
			markers.push({ day: d, y: (totalDays - d) * DAY_HEIGHT + 100 });
		}
		return markers;
	});

	// Computed SVG height based on data
	let svgHeight = $derived(Math.max(900, (totalDays + 2) * DAY_HEIGHT + 200));
	const SVG_W = 1000;

	// ── Generate organic trunk path (slightly wavy vertical line) ──
	let trunkPath = $derived(() => {
		if (!totalDays) return '';
		const topY = 40;
		const bottomY = (totalDays + 1) * DAY_HEIGHT + 150;
		// Create a gentle wavering trunk
		let d = `M ${TRUNK_X} ${bottomY}`;
		const segments = Math.max(4, totalDays);
		const segH = (bottomY - topY) / segments;
		for (let i = 1; i <= segments; i++) {
			const y = bottomY - i * segH;
			const wobble = Math.sin(i * 0.7) * 8; // gentle sway
			d += ` Q ${TRUNK_X + wobble} ${y + segH * 0.5}, ${TRUNK_X + wobble * 0.3} ${y}`;
		}
		return d;
	});

	// ── Root bulge at bottom ──
	let rootY = $derived((totalDays + 1) * DAY_HEIGHT + 150);

	// ── Data loading ──
	async function loadAll() {
		loading = true;
		try {
			const [logData, statsData] = await Promise.all([
				fetchJson('/api/v1/audit/log?limit=500'),
				fetchJson('/api/v1/audit/stats'),
			]);
			entries = logData.entries || [];
			stats = statsData;
			chainStatus = statsData?.chain || null;
			laidOut = layoutEntries(entries);
		} catch (e) {
			console.error('Kronos load failed:', e);
		}
		loading = false;
	}

	async function fetchJson(url) {
		const r = await fetch(url);
		if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
		return r.json();
	}

	// ── Pan / Zoom ──
	function handleWheel(e) {
		e.preventDefault();
		const factor = e.deltaY > 0 ? 0.92 : 1.08;
		const newScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, transform.scale * factor));

		const rect = e.currentTarget.getBoundingClientRect();
		const mx = e.clientX - rect.left;
		const my = e.clientY - rect.top;
		const dx = mx - transform.x;
		const dy = my - transform.y;

		transform = {
			x: mx - dx * (newScale / transform.scale),
			y: my - dy * (newScale / transform.scale),
			scale: newScale,
		};
	}

	function handlePointerDown(e) {
		if (e.button !== 0) return;
		dragging = true;
		dragStart = { x: e.clientX, y: e.clientY, tx: transform.x, ty: transform.y };
		e.currentTarget.setPointerCapture(e.pointerId);
	}

	function handlePointerMove(e) {
		if (!dragging) return;
		transform = {
			...transform,
			x: dragStart.tx + (e.clientX - dragStart.x),
			y: dragStart.ty + (e.clientY - dragStart.y),
		};
	}

	function handlePointerUp() {
		dragging = false;
	}

	function fitView() {
		if (!laidOut.length) return;
		const el = document.querySelector('.kronos-canvas');
		if (!el) return;
		const rect = el.getBoundingClientRect();
		const padding = 60;
		const contentW = SVG_W;
		const contentH = svgHeight;
		const scaleX = (rect.width - padding * 2) / contentW;
		const scaleY = (rect.height - padding * 2) / contentH;
		const scale = Math.min(scaleX, scaleY, 1);
		transform = {
			x: padding + (rect.width - padding * 2 - contentW * scale) / 2,
			y: padding,
			scale,
		};
	}

	function goToday() {
		if (!laidOut.length) return;
		const el = document.querySelector('.kronos-canvas');
		if (!el) return;
		const rect = el.getBoundingClientRect();
		// Today is at the top of the tree (small Y)
		const todayY = 100;
		transform = {
			x: (rect.width - SVG_W * transform.scale) / 2,
			y: -todayY * transform.scale + 80,
			scale: transform.scale,
		};
	}

	// ── Branch path: organic curve from trunk to node ──
	function branchPath(entry) {
		const tx = TRUNK_X;
		const ty = entry.trunkY;
		const nx = entry.x;
		const ny = entry.y;
		// Quadratic bezier with control point creating a natural curve
		const cpx = tx + (nx - tx) * 0.3;
		const cpy = ty - 20;  // slight upward curve like a real branch
		return `M ${tx} ${ty} Q ${cpx} ${cpy}, ${nx} ${ny}`;
	}

	// ── Lifecycle ──
	let refreshTimer;
	onMount(() => {
		loadAll().then(() => {
			setTimeout(fitView, 100);
		});
		refreshTimer = setInterval(loadAll, 60000);
		return () => clearInterval(refreshTimer);
	});
</script>

<div class="kronos-app">
	<!-- Top bar -->
	<div class="kronos-topbar">
		<div class="topbar-left">
			<a href="/" class="back-link" title="Back to Dashboard">&larr;</a>
			<h1 class="kronos-title">KRONOS</h1>
			<span class="kronos-sub">Decision Tree</span>
			{#if day0Ts}
				<span class="epoch-badge">Root: {new Date(day0Ts).toLocaleDateString()}</span>
			{/if}
		</div>
		<div class="topbar-center">
			<input
				type="text"
				class="kronos-search"
				placeholder="Search decisions..."
				bind:value={searchText}
			/>
			<select class="kronos-filter" bind:value={filterCategory}>
				<option value="">All</option>
				{#each Object.entries(CATS) as [key, cat]}
					<option value={key}>{cat.label}</option>
				{/each}
			</select>
		</div>
		<div class="topbar-right">
			{#if stats}
				<span class="topbar-stat">{stats.total || 0} events</span>
				<span class="topbar-stat">{totalDays}d span</span>
				<span class="chain-badge" class:ok={chainStatus?.ok} class:broken={chainStatus && !chainStatus.ok}>
					{chainStatus?.ok ? 'Chain ✓' : chainStatus ? 'Chain ✗' : 'Chain ?'}
				</span>
			{/if}
			<button class="topbar-btn" onclick={fitView} title="Fit view">Fit</button>
			<button class="topbar-btn" onclick={goToday} title="Go to today">Today</button>
			<span class="zoom-pct">{(transform.scale * 100).toFixed(0)}%</span>
			<span class="live-dot"></span>
		</div>
	</div>

	<!-- Canvas -->
	<div
		class="kronos-canvas"
		class:grabbing={dragging}
		onwheel={handleWheel}
		onpointerdown={handlePointerDown}
		onpointermove={handlePointerMove}
		onpointerup={handlePointerUp}
	>
		{#if loading && !laidOut.length}
			<div class="loading-msg">Growing the tree...</div>
		{:else}
			<svg
				width="100%"
				height="100%"
				viewBox="0 0 {SVG_W} {svgHeight}"
				preserveAspectRatio="xMidYMid meet"
				style="overflow: visible"
			>
				<defs>
					<filter id="glow">
						<feGaussianBlur stdDeviation="3" result="blur"/>
						<feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
					</filter>
					<filter id="glow-strong">
						<feGaussianBlur stdDeviation="6" result="blur"/>
						<feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
					</filter>
					<!-- Gradient for the trunk — darker at base, lighter at crown -->
					<linearGradient id="trunk-grad" x1="0" y1="1" x2="0" y2="0">
						<stop offset="0%" stop-color="#45475a" />
						<stop offset="40%" stop-color="#585b70" />
						<stop offset="100%" stop-color="#6c7086" />
					</linearGradient>
					<!-- Subtle ambient glow for the trunk -->
					<filter id="trunk-glow">
						<feGaussianBlur stdDeviation="4" result="blur"/>
						<feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
					</filter>
				</defs>

				<g transform="translate({transform.x}, {transform.y}) scale({transform.scale})">

					<!-- ── Roots at bottom ── -->
					{#if totalDays > 0}
						{@const ry = rootY}
						<!-- Root tendrils -->
						<path d="M {TRUNK_X} {ry} Q {TRUNK_X - 40} {ry + 30}, {TRUNK_X - 70} {ry + 60}"
							stroke="#313244" stroke-width="3" fill="none" opacity="0.5" />
						<path d="M {TRUNK_X} {ry} Q {TRUNK_X + 30} {ry + 25}, {TRUNK_X + 55} {ry + 55}"
							stroke="#313244" stroke-width="2.5" fill="none" opacity="0.4" />
						<path d="M {TRUNK_X} {ry} Q {TRUNK_X - 15} {ry + 40}, {TRUNK_X - 30} {ry + 70}"
							stroke="#313244" stroke-width="2" fill="none" opacity="0.3" />
						<path d="M {TRUNK_X} {ry} Q {TRUNK_X + 50} {ry + 35}, {TRUNK_X + 80} {ry + 50}"
							stroke="#313244" stroke-width="1.5" fill="none" opacity="0.3" />
						<!-- Root base circle -->
						<circle cx={TRUNK_X} cy={ry} r="10" fill="#313244" opacity="0.6" />
						<text
							x={TRUNK_X} y={ry + 90}
							text-anchor="middle"
							fill="#45475a"
							font-size="11"
							font-family="Inter, sans-serif"
							font-weight="600"
							letter-spacing="2"
						>GENESIS</text>
					{/if}

					<!-- ── Trunk (organic wavering line) ── -->
					<path
						d={trunkPath()}
						stroke="url(#trunk-grad)"
						stroke-width="4"
						fill="none"
						stroke-linecap="round"
						filter="url(#trunk-glow)"
					/>

					<!-- ── Day markers along trunk ── -->
					{#each dayMarkers() as m}
						<!-- Small branch stubs as day markers -->
						<line
							x1={TRUNK_X - 14} y1={m.y}
							x2={TRUNK_X + 14} y2={m.y}
							stroke="#313244"
							stroke-width="1.5"
							opacity="0.6"
						/>
						<!-- Day label on the left -->
						<text
							x={TRUNK_X - 22} y={m.y + 4}
							text-anchor="end"
							fill="#45475a"
							font-size="10"
							font-family="Inter, sans-serif"
						>
							{dayLabel(m.day)}
						</text>
						<!-- Date on the right (show every Nth day to avoid clutter) -->
						{#if day0Ts && m.day % Math.max(1, Math.floor(totalDays / 20)) === 0}
							<text
								x={TRUNK_X + 22} y={m.y + 4}
								text-anchor="start"
								fill="#45475a"
								font-size="9"
								font-family="Inter, sans-serif"
							>
								{new Date(day0Ts + m.day * 86400000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
							</text>
						{/if}
					{/each}

					<!-- ── Today marker ── -->
					{#if day0Ts}
						{@const todayD = dayNumber(Date.now())}
						{@const todayY = (totalDays - todayD) * DAY_HEIGHT + 100}
						<line
							x1={TRUNK_X - 120} y1={todayY}
							x2={TRUNK_X + 120} y2={todayY}
							stroke="#89b4fa"
							stroke-width="1.5"
							stroke-dasharray="4,3"
							filter="url(#glow)"
						/>
						<text
							x={TRUNK_X + 130} y={todayY + 4}
							text-anchor="start"
							fill="#89b4fa"
							font-size="11"
							font-weight="600"
							font-family="Inter, sans-serif"
						>
							TODAY
						</text>
						<!-- Crown / canopy hint at top -->
						<circle
							cx={TRUNK_X} cy={todayY - 30}
							r="18"
							fill="none"
							stroke="#a6e3a1"
							stroke-width="1"
							opacity="0.2"
							filter="url(#glow)"
						/>
					{/if}

					<!-- ── Branch lines (organic curves) ── -->
					{#each filteredLayout() as entry}
						<path
							d={branchPath(entry)}
							stroke={entry.catInfo.color}
							stroke-width="1.5"
							fill="none"
							stroke-opacity="0.4"
							stroke-linecap="round"
						/>
					{/each}

					<!-- ── Event nodes (leaves) ── -->
					{#each filteredLayout() as entry}
						{@const isHovered = hoveredId === entry.id}
						{@const isSelected = selectedEntry?.id === entry.id}
						<g
							class="event-node"
							onpointerenter={() => hoveredId = entry.id}
							onpointerleave={() => hoveredId = null}
							onclick={(e) => { e.stopPropagation(); selectedEntry = selectedEntry?.id === entry.id ? null : entry; }}
							style="cursor: pointer"
						>
							<!-- Leaf / node -->
							{#if isSelected}
								<!-- Selected: larger glowing orb -->
								<circle
									cx={entry.x} cy={entry.y}
									r="10"
									fill={entry.catInfo.color}
									stroke="#cdd6f4"
									stroke-width="2"
									filter="url(#glow-strong)"
								/>
							{:else if isHovered}
								<circle
									cx={entry.x} cy={entry.y}
									r="7"
									fill={entry.catInfo.color}
									opacity="1"
									filter="url(#glow)"
								/>
							{:else}
								<!-- Normal: small leaf dot -->
								<circle
									cx={entry.x} cy={entry.y}
									r="4.5"
									fill={entry.catInfo.color}
									opacity="0.8"
								/>
							{/if}

							<!-- Junction point on trunk -->
							<circle
								cx={TRUNK_X} cy={entry.trunkY}
								r="2.5"
								fill={entry.catInfo.color}
								opacity="0.4"
							/>

							<!-- Hover label -->
							{#if isHovered && !isSelected}
								{@const labelX = entry.side < 0 ? entry.x - 170 : entry.x + 12}
								<rect
									x={labelX} y={entry.y - 11}
									width="158" height="22"
									rx="4"
									fill="#0a0a0f"
									fill-opacity="0.92"
									stroke={entry.catInfo.color}
									stroke-width="0.5"
								/>
								<text
									x={labelX + 79} y={entry.y + 3}
									text-anchor="middle"
									fill="#cdd6f4"
									font-size="10"
									font-family="Inter, sans-serif"
								>
									{actionLabel(entry.action).slice(0, 26)}
								</text>
							{/if}
						</g>
					{/each}

					<!-- ── Selected entry detail card ── -->
					{#if selectedEntry}
						{@const cardSide = selectedEntry.side < 0 ? -1 : 1}
						{@const sx = cardSide < 0 ? selectedEntry.x - 296 : selectedEntry.x + 16}
						{@const sy = selectedEntry.y - 80}
						<foreignObject x={sx} y={sy} width="280" height="170">
							<div class="detail-card" xmlns="http://www.w3.org/1999/xhtml">
								<div class="dc-header">
									<span class="dc-cat" style="color: {selectedEntry.catInfo.color}">{selectedEntry.catInfo.label}</span>
									<span class="dc-day">{dayLabel(selectedEntry.day)}</span>
									<span class="dc-time">{relativeTime(selectedEntry.ts)}</span>
								</div>
								<div class="dc-action">{actionLabel(selectedEntry.action)}</div>
								{#if selectedEntry.target}
									<div class="dc-target">→ {selectedEntry.target}</div>
								{/if}
								<div class="dc-ts">{formatTime(selectedEntry.ts)}</div>
								{#if selectedEntry.metadata}
									<pre class="dc-meta">{JSON.stringify(selectedEntry.metadata, null, 2).slice(0, 200)}</pre>
								{/if}
								{#if selectedEntry.signature}
									<div class="dc-sig">Sig: {selectedEntry.signature.slice(0, 20)}...</div>
								{/if}
							</div>
						</foreignObject>
					{/if}
				</g>
			</svg>
		{/if}
	</div>

	<!-- Bottom legend -->
	<div class="kronos-legend">
		{#each Object.entries(CATS) as [key, cat]}
			<button
				class="legend-item"
				class:active={filterCategory === key}
				onclick={() => filterCategory = filterCategory === key ? '' : key}
			>
				<span class="legend-dot" style="background: {cat.color}"></span>
				<span class="legend-label">{cat.label}</span>
			</button>
		{/each}
	</div>
</div>

<style>
	/* ── App shell ── */
	.kronos-app {
		display: flex;
		flex-direction: column;
		height: 100vh;
		width: 100vw;
		background: #0a0a0f;
		font-family: 'Inter', sans-serif;
		color: #cdd6f4;
		overflow: hidden;
	}

	/* ── Top bar ── */
	.kronos-topbar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 8px 16px;
		background: #12121a;
		border-bottom: 1px solid #1e1e2e;
		gap: 12px;
		flex-shrink: 0;
		z-index: 10;
	}

	.topbar-left, .topbar-center, .topbar-right {
		display: flex;
		align-items: center;
		gap: 10px;
	}

	.back-link {
		color: #6c7086;
		text-decoration: none;
		font-size: 18px;
		padding: 2px 6px;
	}

	.back-link:hover { color: #89b4fa; }

	.kronos-title {
		margin: 0;
		font-size: 16px;
		font-weight: 700;
		letter-spacing: 3px;
		color: #cdd6f4;
	}

	.kronos-sub {
		font-size: 11px;
		color: #585b70;
	}

	.epoch-badge {
		font-size: 10px;
		color: #a6e3a1;
		background: rgba(166, 227, 161, 0.1);
		padding: 2px 8px;
		border-radius: 10px;
	}

	.kronos-search {
		background: #0a0a0f;
		color: #cdd6f4;
		border: 1px solid #1e1e2e;
		border-radius: 6px;
		padding: 5px 10px;
		font-size: 12px;
		font-family: 'Inter', sans-serif;
		width: 160px;
	}

	.kronos-search:focus { border-color: #89b4fa; outline: none; }
	.kronos-search::placeholder { color: #585b70; }

	.kronos-filter {
		background: #0a0a0f;
		color: #cdd6f4;
		border: 1px solid #1e1e2e;
		border-radius: 6px;
		padding: 5px 10px;
		font-size: 12px;
		font-family: 'Inter', sans-serif;
		cursor: pointer;
	}

	.kronos-filter:focus { border-color: #89b4fa; outline: none; }

	.topbar-stat {
		font-size: 11px;
		color: #6c7086;
		background: #1e1e2e;
		padding: 2px 8px;
		border-radius: 4px;
	}

	.chain-badge {
		font-size: 10px;
		font-weight: 600;
		padding: 2px 8px;
		border-radius: 4px;
		background: #1e1e2e;
		color: #6c7086;
	}

	.chain-badge.ok { color: #a6e3a1; border: 1px solid #a6e3a1; }
	.chain-badge.broken { color: #f38ba8; border: 1px solid #f38ba8; }

	.topbar-btn {
		background: #1e1e2e;
		border: 1px solid #313244;
		color: #cdd6f4;
		border-radius: 4px;
		padding: 4px 10px;
		font-size: 11px;
		cursor: pointer;
		font-family: 'Inter', sans-serif;
	}

	.topbar-btn:hover { border-color: #89b4fa; }

	.zoom-pct {
		font-size: 11px;
		color: #585b70;
		min-width: 36px;
		text-align: right;
	}

	.live-dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: #a6e3a1;
		animation: pulse 2s infinite;
	}

	@keyframes pulse {
		0%, 100% { opacity: 1; }
		50% { opacity: 0.4; }
	}

	/* ── Canvas ── */
	.kronos-canvas {
		flex: 1;
		cursor: grab;
		overflow: hidden;
		position: relative;
		background:
			radial-gradient(circle at 50% 80%, rgba(166, 227, 161, 0.02) 0%, transparent 60%),
			#0a0a0f;
	}

	.kronos-canvas.grabbing { cursor: grabbing; }

	.loading-msg {
		position: absolute;
		top: 50%;
		left: 50%;
		transform: translate(-50%, -50%);
		color: #585b70;
		font-size: 14px;
	}

	/* ── Detail card (foreignObject) ── */
	:global(.detail-card) {
		background: #12121a;
		border: 1px solid #313244;
		border-radius: 8px;
		padding: 10px 12px;
		font-family: 'Inter', sans-serif;
		box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5);
		overflow: hidden;
	}

	:global(.dc-header) {
		display: flex;
		gap: 8px;
		align-items: center;
		margin-bottom: 4px;
	}

	:global(.dc-cat) {
		font-size: 11px;
		font-weight: 600;
	}

	:global(.dc-day) {
		font-size: 10px;
		color: #a6e3a1;
		background: rgba(166, 227, 161, 0.1);
		padding: 1px 6px;
		border-radius: 3px;
	}

	:global(.dc-time) {
		font-size: 10px;
		color: #585b70;
		margin-left: auto;
	}

	:global(.dc-action) {
		font-size: 13px;
		color: #cdd6f4;
		font-weight: 500;
	}

	:global(.dc-target) {
		font-size: 11px;
		color: #89b4fa;
		margin-top: 2px;
	}

	:global(.dc-ts) {
		font-size: 10px;
		color: #6c7086;
		margin-top: 2px;
	}

	:global(.dc-meta) {
		font-size: 9px;
		color: #94e2d5;
		background: #0a0a0f;
		border-radius: 4px;
		padding: 4px 6px;
		margin-top: 4px;
		overflow: hidden;
		white-space: pre-wrap;
		word-break: break-word;
		max-height: 50px;
		font-family: monospace;
	}

	:global(.dc-sig) {
		font-size: 9px;
		color: #a6e3a1;
		font-family: monospace;
		margin-top: 3px;
	}

	/* ── Bottom legend ── */
	.kronos-legend {
		display: flex;
		align-items: center;
		gap: 4px;
		padding: 6px 16px;
		background: #12121a;
		border-top: 1px solid #1e1e2e;
		flex-shrink: 0;
		overflow-x: auto;
	}

	.legend-item {
		display: flex;
		align-items: center;
		gap: 4px;
		background: none;
		border: 1px solid transparent;
		border-radius: 4px;
		padding: 3px 8px;
		cursor: pointer;
		font-family: 'Inter', sans-serif;
		white-space: nowrap;
	}

	.legend-item:hover { border-color: #313244; }
	.legend-item.active { border-color: #89b4fa; background: #1e1e2e; }

	.legend-dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
	}

	.legend-label {
		font-size: 11px;
		color: #6c7086;
	}
</style>
