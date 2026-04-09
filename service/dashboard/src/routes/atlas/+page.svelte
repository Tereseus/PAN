<script>
	import { onMount } from 'svelte';

	let atlasData = $state(null);
	let atlasLoading = $state(true);
	let atlasTransform = $state({ x: 0, y: 0, scale: 1 });
	let atlasDragging = $state(false);
	let atlasDragStart = $state({ x: 0, y: 0 });
	let atlasHovered = $state(null);
	let atlasSelected = $state(null);
	let drilldownData = $state(null);
	let refreshTimer = null;
	const EC = { core: '#f5c2e7', svc: '#a6e3a1', proc: '#f9e2af', mem: '#cba6f7', intel: '#89b4fa', dev: '#fab387', proj: '#94e2d5' };

	async function api(path) {
		const r = await fetch(path);
		if (!r.ok) return null;
		return r.json();
	}

	async function loadAtlas() {
		try {
			const [svcResp, atlasResp, statsResp, projResp, progressResp] = await Promise.all([
				api('/dashboard/api/services'),
				api('/api/v1/atlas/services'),
				api('/dashboard/api/stats'),
				api('/dashboard/api/projects'),
				api('/dashboard/api/progress'),
			]);
			// Merge per-project task progress so each project node can show
			// "X% · done/total tasks" in its detail row instead of being empty.
			let mergedProjs = projResp || [];
			if (Array.isArray(mergedProjs) && progressResp?.projects) {
				const pmap = Object.fromEntries(progressResp.projects.map(p => [p.id, p]));
				mergedProjs = mergedProjs.map(p => ({ ...p, ...(pmap[p.id] || {}) }));
			}
			atlasData = buildGraph(svcResp, atlasResp, statsResp, mergedProjs);
		} catch (e) {
			console.error('Atlas load failed:', e);
		}
		atlasLoading = false;
	}

	function svcStatus(atlasMap, id) {
		const s = atlasMap[id];
		if (!s) return 'unknown';
		if (s.status === 'running') return 'up';
		if (s.status === 'stopped') return 'idle';
		if (s.status === 'down' || s.status === 'error') return 'down';
		return 'unknown';
	}

	function svcDetail(atlasMap, id) {
		const s = atlasMap[id];
		if (!s) return '';
		const parts = [];
		if (s.port) parts.push(`Port ${s.port}`);
		if (s.interval) parts.push(`Every ${s.interval}`);
		if (s.lastRun) {
			const ago = Math.round((Date.now() - s.lastRun) / 60000);
			parts.push(ago < 60 ? `${ago}m ago` : `${Math.round(ago / 60)}h ago`);
		}
		if (s.modelTierLabel && s.modelTier !== 'none') parts.push(s.modelTierLabel);
		return parts.join(' — ') || s.status;
	}

	function buildGraph(svcResp, atlasResp, statsResp, projResp) {
		const nodes = [];
		const edges = [];
		const nodeMap = {};
		const rings = []; // radial ring labels

		const atlasSvcs = atlasResp?.services || [];
		const am = Object.fromEntries(atlasSvcs.map(s => [s.id, s]));
		const dashServices = svcResp?.services || [];
		const devices = dashServices.filter(s => s.category === 'Devices');
		const uniqueDevices = [];
		const seenDev = new Set();
		for (const d of devices) { if (!seenDev.has(d.name)) { seenDev.add(d.name); uniqueDevices.push(d); } }
		const projs = projResp || [];

		const CX = 700, CY = 450; // center

		function add(id, label, type, status, detail, ring, x, y, desc, drilldown) {
			const raw = am[id] || null;
			const n = {
				id, label, type, status,
				technicalName: raw?.technicalName || null,
				detail: detail || '',
				ring, x, y,
				description: desc || '',
				drilldown: drilldown || null,
				// Surface raw service fields so the detail panel can show errors,
				// dependencies, last-check time, etc.
				error: raw?.lastError || null,
				lastCheck: raw?.lastCheck || null,
				lastRun: raw?.lastRun || null,
				dependsOn: raw?.dependsOn || [],
				port: raw?.port || null,
				interval: raw?.interval || null,
			};
			nodes.push(n);
			nodeMap[id] = n;
		}

		// Place items evenly on an arc segment (startAngle to endAngle in degrees).
		// If `radius` is too small for `count` 140-px-wide nodes to fit without
		// overlap, auto-bump the radius outward until they clear. This is what
		// prevents the "everything overlaps" bug when sectors get crowded.
		const NODE_WIDTH = 140;
		const NODE_GAP = 24; // breathing room between adjacent nodes
		function arc(cx, cy, radius, startDeg, endDeg, count) {
			const positions = [];
			const startRad = (startDeg * Math.PI) / 180;
			const endRad = (endDeg * Math.PI) / 180;
			// Required chord length between centers so they don't visually collide.
			const minChord = NODE_WIDTH + NODE_GAP;
			// For the given angular span and count, derive the smallest radius
			// such that the chord between adjacent items >= minChord.
			if (count > 1) {
				const stepRad = (endRad - startRad) / (count - 1);
				// chord = 2 * r * sin(step/2). Solve for r.
				const minR = minChord / (2 * Math.sin(stepRad / 2));
				if (minR > radius) radius = Math.ceil(minR);
			}
			const step = count > 1 ? (endRad - startRad) / (count - 1) : 0;
			for (let i = 0; i < count; i++) {
				const angle = count === 1 ? (startRad + endRad) / 2 : startRad + step * i;
				positions.push({ x: Math.round(cx + radius * Math.cos(angle)), y: Math.round(cy + radius * Math.sin(angle)) });
			}
			return positions;
		}

		const EC = { core: '#f5c2e7', svc: '#a6e3a1', proc: '#f9e2af', mem: '#cba6f7', intel: '#89b4fa', dev: '#fab387', proj: '#94e2d5' };

		// ===== RING 0: CENTER — PAN Core =====
		add('pan-server', 'PAN Server', 'core', 'up',
			statsResp ? `${statsResp.total_events} events` : 'Port 7777',
			'core', CX, CY, 'Central server. Node.js/Express on port 7777.');
		rings.push({ r: 0, label: '' });

		// ===== RING 1 (r=140): Core services — DB, Dashboard, Tauri, Steward =====
		const r1 = 140;
		rings.push({ r: r1, label: 'CORE', color: EC.core });
		const r1pos = arc(CX, CY, r1, 200, 340, 4);
		add('database', 'SQLite DB', 'data', 'up',
			statsResp ? `${(statsResp.db_size_bytes / 1048576).toFixed(1)}MB` : 'SQLCipher',
			'core', r1pos[0].x, r1pos[0].y, 'SQLCipher AES-256 encrypted.');
		add('dashboard', 'Dashboard', 'ui', 'up', 'Svelte v2', 'core', r1pos[1].x, r1pos[1].y, 'Svelte dashboard.');
		add('steward', 'Steward', 'service', svcStatus(am, 'pan-server'), 'Health monitor', 'core', r1pos[2].x, r1pos[2].y, 'Monitors and restarts all services.');
		add('tauri', 'Tauri Shell', 'ui', 'up', 'Port 7790', 'core', r1pos[3].x, r1pos[3].y, 'Desktop shell.');

		edges.push({ from: 'pan-server', to: 'database', color: EC.core });
		edges.push({ from: 'pan-server', to: 'dashboard', color: EC.core });
		edges.push({ from: 'pan-server', to: 'steward', color: EC.core });
		edges.push({ from: 'pan-server', to: 'tauri', color: EC.core });

		// ===== RING 2 (r=300): Subsystems — Services, Memory, Processing, Intelligence =====
		const r2 = 300;
		rings.push({ r: r2, label: '', color: '#313244' });

		// Services sector (top-right, 300°-360°)
		const svcItems = [
			['whisper', 'Whisper STT', svcStatus(am, 'whisper'), svcDetail(am, 'whisper') || 'Port 7782', 'Voice transcription.'],
			['ollama', 'Ollama', svcStatus(am, 'ollama'), svcDetail(am, 'ollama') || 'Port 11434', 'Local model server.'],
			['ahk', 'Voice Hotkeys', svcStatus(am, 'ahk'), 'AHK', 'AutoHotkey voice triggers.'],
			['tailscale', 'Tailscale', svcStatus(am, 'tailscale'), 'VPN mesh', 'Encrypted remote access.'],
		];
		const svcPos = arc(CX, CY, r2, -50, 30, svcItems.length);
		svcItems.forEach(([id, label, status, detail, desc], i) => {
			add(id, label, 'service', status, detail, 'services', svcPos[i].x, svcPos[i].y, desc);
			edges.push({ from: 'steward', to: id, color: EC.svc });
		});

		// Memory sector (bottom-left, 140°-210°)
		const memItems = [
			['memory-hub', 'Memory Hub', 'up', 'Context builder', 'Assembles memories for Claude.'],
			['episodic', 'Episodic', 'up', 'Events + outcomes', 'What happened.'],
			['semantic', 'Semantic', 'up', 'Knowledge triples', 'Facts with contradiction detection.'],
			['procedural', 'Procedural', 'up', 'Learned workflows', 'Multi-step procedures.'],
			['embeddings', 'Embeddings', svcStatus(am, 'embeddings'), 'Vector encoding', 'Vector search.'],
			['inject-ctx', 'Context Inject', 'up', 'CLAUDE.md ← memory', 'Injects memory before sessions.'],
		];
		const memPos = arc(CX, CY, r2, 130, 220, memItems.length);
		memItems.forEach(([id, label, status, detail, desc], i) => {
			add(id, label, 'memory', status, detail, 'memory', memPos[i].x, memPos[i].y, desc);
		});
		edges.push({ from: 'database', to: 'memory-hub', color: EC.mem });
		edges.push({ from: 'memory-hub', to: 'episodic', color: EC.mem });
		edges.push({ from: 'memory-hub', to: 'semantic', color: EC.mem });
		edges.push({ from: 'memory-hub', to: 'procedural', color: EC.mem });
		edges.push({ from: 'memory-hub', to: 'embeddings', color: EC.mem });
		edges.push({ from: 'memory-hub', to: 'inject-ctx', color: EC.mem });

		// Processing sector (top-left, 230°-290°)
		const procItems = [
			['classifier', 'Classifier', svcStatus(am, 'classifier'), svcDetail(am, 'classifier'), 'Marks events every 5 minutes.'],
			['dream', 'Dream Cycle', svcStatus(am, 'dream'), svcDetail(am, 'dream'), 'Rewrites .pan-state.md every 6h.'],
			['consolidation', 'Consolidation', svcStatus(am, 'consolidation'), svcDetail(am, 'consolidation'), 'Extracts memories.'],
			['evolution', 'Evolution', svcStatus(am, 'evolution'), svcDetail(am, 'evolution'), '6-step optimization.'],
		];
		const procPos = arc(CX, CY, r2, 230, 300, procItems.length);
		procItems.forEach(([id, label, status, detail, desc], i) => {
			add(id, label, 'process', status, detail, 'processing', procPos[i].x, procPos[i].y, desc);
		});
		edges.push({ from: 'database', to: 'classifier', color: EC.proc });
		edges.push({ from: 'classifier', to: 'dream', color: EC.proc });
		edges.push({ from: 'dream', to: 'consolidation', color: EC.proc });
		edges.push({ from: 'dream', to: 'evolution', color: EC.proc });

		// Intelligence sector (right, 40°-120°)
		const intelItems = [
			['claude', 'Claude Code', 'up', 'CLI sessions', 'Claude Code with memory injection.'],
			['scout', 'Scout', svcStatus(am, 'scout'), svcDetail(am, 'scout'), 'Tool/repo discovery.'],
			['orchestrator', 'Orchestrator', svcStatus(am, 'orchestrator'), svcDetail(am, 'orchestrator'), 'Autonomous task agent.'],
			['autodev', 'AutoDev', svcStatus(am, 'autodev'), svcDetail(am, 'autodev'), 'Headless Claude sessions.'],
		];
		const intelPos = arc(CX, CY, r2, 40, 120, intelItems.length);
		intelItems.forEach(([id, label, status, detail, desc], i) => {
			add(id, label, 'ai', status, detail, 'intel', intelPos[i].x, intelPos[i].y, desc);
		});
		edges.push({ from: 'inject-ctx', to: 'claude', color: EC.intel });
		edges.push({ from: 'scout', to: 'orchestrator', color: EC.intel });
		edges.push({ from: 'orchestrator', to: 'autodev', color: EC.intel });
		edges.push({ from: 'consolidation', to: 'memory-hub', color: EC.proc });

		// ===== RING 3 (r=440): Devices + Projects =====
		const r3 = 440;
		rings.push({ r: r3, label: '', color: '#1e1e2e' });

		// Devices (top, -30° to 30°)
		if (uniqueDevices.length > 0) {
			const devPos = arc(CX, CY, r3, -20, 20, uniqueDevices.length);
			uniqueDevices.forEach((d, i) => {
				add(`dev-${d.name}`, d.name, 'device', d.status === 'up' ? 'up' : 'down',
					d.detail, 'devices', devPos[i].x, devPos[i].y, d.detail || d.name,
					{ type: 'device', name: d.name });
				edges.push({ from: 'pan-server', to: `dev-${d.name}`, color: EC.dev });
			});
		}

		// Projects (bottom, 150°-210° — no status dots).
		// Show task progress as the visible detail so the user can see at-a-glance
		// what each project is and how far along it is, instead of an empty card.
		if (projs.length > 0) {
			const projPos = arc(CX, CY, r3, 140, 220, projs.length);
			projs.forEach((p, i) => {
				const done = p.done_tasks ?? 0;
				const total = p.total_tasks ?? 0;
				const pct = p.percentage ?? (total ? Math.round((done / total) * 100) : 0);
				const detail = total > 0 ? `${pct}% · ${done}/${total} tasks` : (p.path ? p.path.split(/[/\\]/).slice(-2).join('/') : '');
				const desc = [p.path, total > 0 ? `${done} of ${total} tasks done` : null, p.session_count ? `${p.session_count} sessions` : null]
					.filter(Boolean).join(' · ');
				add(`proj-${p.id}`, p.name, 'project', 'none', detail, 'projects', projPos[i].x, projPos[i].y, desc,
					{ type: 'project', name: p.name, id: p.id });
			});
		}

		// Sector labels on the rings
		const sectorLabels = [
			{ text: 'SERVICES', angle: -10, r: r2 + 40, color: EC.svc },
			{ text: 'MEMORY', angle: 175, r: r2 + 40, color: EC.mem },
			{ text: 'PROCESSING', angle: 265, r: r2 + 40, color: EC.proc },
			{ text: 'INTELLIGENCE', angle: 80, r: r2 + 40, color: EC.intel },
			{ text: 'DEVICES', angle: 0, r: r3 + 30, color: EC.dev },
			{ text: 'PROJECTS', angle: 180, r: r3 + 30, color: EC.proj },
		];

		// Real dependency edges from the steward's dependsOn field. These are
		// drawn on top of the hand-laid-out layout edges so the user can see
		// what each service actually relies on.
		const depEdges = [];
		for (const node of nodes) {
			for (const dep of node.dependsOn || []) {
				if (nodeMap[dep] && nodeMap[node.id]) {
					depEdges.push({ from: dep, to: node.id, color: '#45475a', kind: 'depends', label: 'depends on' });
				}
			}
		}

		// All connections for the detail panel — combines layout + dependency edges
		const allConnections = [...edges, ...depEdges];

		return { nodes, edges, depEdges, nodeMap, rings, sectorLabels, stats: statsResp, viewBox: '0 0 1400 900', allConnections, CX, CY };
	}

	function nodeColor(node) {
		const c = { core: '#89b4fa', service: '#a6e3a1', device: '#f9e2af', data: '#fab387', project: '#74c7ec', ui: '#89dceb', ai: '#f38ba8', memory: '#f5c2e7', process: '#cba6f7' };
		return c[node.type] || '#6c7086';
	}

	function statusDot(status) {
		if (status === 'up') return '#a6e3a1';
		if (status === 'down') return '#f38ba8';
		if (status === 'warn' || status === 'idle') return '#f9e2af';
		return '#6c7086';
	}

	function handleWheel(e) {
		e.preventDefault();
		const delta = e.deltaY > 0 ? 0.92 : 1.08;
		atlasTransform = { ...atlasTransform, scale: Math.max(0.2, Math.min(4, atlasTransform.scale * delta)) };
	}

	function handlePointerDown(e) {
		if (e.target.closest('.atlas-node')) return;
		atlasDragging = true;
		atlasDragStart = { x: e.clientX - atlasTransform.x, y: e.clientY - atlasTransform.y };
	}

	function handlePointerMove(e) {
		if (!atlasDragging) return;
		atlasTransform = { ...atlasTransform, x: e.clientX - atlasDragStart.x, y: e.clientY - atlasDragStart.y };
	}

	function handlePointerUp() {
		atlasDragging = false;
	}

	function resetView() {
		atlasTransform = { x: 0, y: 0, scale: 1 };
	}

	function fitToScreen() {
		atlasTransform = { x: 0, y: 0, scale: 0.85 };
	}

	onMount(() => {
		loadAtlas();
		refreshTimer = setInterval(loadAtlas, 30000);
		return () => { if (refreshTimer) clearInterval(refreshTimer); };
	});
</script>

<div class="atlas-fullscreen"
	onwheel={handleWheel}
	onpointerdown={handlePointerDown}
	onpointermove={handlePointerMove}
	onpointerup={handlePointerUp}
	onpointerleave={handlePointerUp}
>
	<div class="atlas-topbar">
		<span class="atlas-title">Π Atlas</span>
		<button class="tb" onclick={fitToScreen}>Fit</button>
		<button class="tb" onclick={resetView}>Reset</button>
		<button class="tb" onclick={() => { atlasTransform = { ...atlasTransform, scale: atlasTransform.scale * 1.2 }; }}>+</button>
		<button class="tb" onclick={() => { atlasTransform = { ...atlasTransform, scale: Math.max(0.2, atlasTransform.scale * 0.8) }; }}>−</button>
		<span class="atlas-zoom">{Math.round(atlasTransform.scale * 100)}%</span>
		{#if atlasData?.stats}
			<span class="atlas-stat">{atlasData.stats.total_events} events</span>
			<span class="atlas-stat">{atlasData.stats.total_sessions} sessions</span>
			<span class="atlas-stat">{atlasData.nodes.length} nodes</span>
		{/if}
		<span class="atlas-live">● LIVE</span>
	</div>

	{#if atlasLoading}
		<div class="atlas-loading">Loading Atlas...</div>
	{:else if atlasData}
		<svg class="atlas-svg" viewBox={atlasData.viewBox || '0 0 1400 900'} preserveAspectRatio="xMidYMid meet">
			<defs>
				<filter id="glow"><feGaussianBlur stdDeviation="3" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
			</defs>
			<g transform="translate({atlasTransform.x},{atlasTransform.y}) scale({atlasTransform.scale})">
				<!-- Radial rings -->
				{#each atlasData.rings as ring}
					{#if ring.r > 0}
						<circle cx={atlasData.CX} cy={atlasData.CY} r={ring.r} fill="none" stroke={ring.color || '#1e1e2e'} stroke-width="1" stroke-opacity="0.2" stroke-dasharray="4,6"/>
					{/if}
				{/each}
				<!-- Sector labels -->
				{#each atlasData.sectorLabels || [] as sl}
					{@const lx = atlasData.CX + sl.r * Math.cos(sl.angle * Math.PI / 180)}
					{@const ly = atlasData.CY + sl.r * Math.sin(sl.angle * Math.PI / 180)}
					<text x={lx} y={ly} fill={sl.color + '66'} font-size="10" font-weight="700" letter-spacing="2" text-anchor="middle" dominant-baseline="middle">{sl.text}</text>
				{/each}

				{#each atlasData.edges as edge}
					{@const f = atlasData.nodeMap[edge.from]}
					{@const t = atlasData.nodeMap[edge.to]}
					{#if f && t}
						<line x1={f.x} y1={f.y} x2={t.x} y2={t.y} stroke={edge.color || '#313244'} stroke-width="1.2" stroke-opacity="0.25"/>
					{/if}
				{/each}
				<!-- Real dependency edges from steward.dependsOn — dashed and brighter
				     when either endpoint is the selected/hovered node -->
				{#each atlasData.depEdges || [] as edge}
					{@const f = atlasData.nodeMap[edge.from]}
					{@const t = atlasData.nodeMap[edge.to]}
					{@const lit = atlasSelected === edge.from || atlasSelected === edge.to || atlasHovered === edge.from || atlasHovered === edge.to}
					{#if f && t}
						<line x1={f.x} y1={f.y} x2={t.x} y2={t.y}
							stroke={lit ? '#89b4fa' : '#45475a'}
							stroke-width={lit ? 1.6 : 1}
							stroke-opacity={lit ? 0.9 : 0.35}
							stroke-dasharray="3,4"/>
					{/if}
				{/each}

				{#each atlasData.nodes as node}
					<g class="atlas-node" transform="translate({node.x},{node.y})"
						onpointerenter={() => { atlasHovered = node.id; }}
						onpointerleave={() => { atlasHovered = null; }}
						onclick={async () => {
						if (atlasSelected === node.id && node.drilldown) {
							if (node.drilldown.type === 'device') {
								try {
									const r = await fetch(`/api/v1/sensors?device=${encodeURIComponent(node.drilldown.name)}`);
									if (r.ok) drilldownData = { type: 'device', name: node.drilldown.name, data: await r.json() };
									else drilldownData = { type: 'device', name: node.drilldown.name, data: null };
								} catch { drilldownData = { type: 'device', name: node.drilldown.name, data: null }; }
							} else if (node.drilldown.type === 'project') {
								try {
									const r = await fetch(`/dashboard/api/projects/${node.drilldown.id}/tasks`);
									if (r.ok) drilldownData = { type: 'project', name: node.drilldown.name, data: await r.json() };
									else drilldownData = { type: 'project', name: node.drilldown.name, data: null };
								} catch { drilldownData = { type: 'project', name: node.drilldown.name, data: null }; }
							}
						}
						atlasSelected = atlasSelected === node.id ? null : node.id;
					}}
						style="cursor:pointer"
					>
						{#if node.id === 'pan-server'}
							<!-- Center node — larger, prominent -->
							<circle r="50"
								fill={atlasHovered === node.id ? '#1e1e2e' : '#11111b'}
								stroke={atlasSelected === node.id ? EC.core : atlasHovered === node.id ? '#45475a' : EC.core + '40'}
								stroke-width={atlasSelected === node.id ? 3 : 1.5}
								filter={atlasSelected === node.id ? 'url(#glow)' : ''}
							/>
							<text y="-8" fill="#89b4fa" font-size="22" font-weight="700" text-anchor="middle" font-family="serif">Π</text>
							<text y="12" fill="#cdd6f4" font-size="10" font-weight="600" text-anchor="middle">PAN Server</text>
							<text y="26" fill="#6c7086" font-size="8" text-anchor="middle">{node.detail}</text>
						{:else}
							<rect x="-70" y="-22" width="140" height="44" rx="8"
								fill={atlasHovered === node.id || atlasSelected === node.id ? '#1e1e2e' : '#11111b'}
								stroke={atlasSelected === node.id ? nodeColor(node) : atlasHovered === node.id ? '#45475a' : nodeColor(node) + '30'}
								stroke-width={atlasSelected === node.id ? 2 : 1}
								filter={atlasSelected === node.id ? 'url(#glow)' : ''}
							/>
							{#if node.status !== 'none'}
								<circle cx="-55" cy="-6" r="4.5" fill={statusDot(node.status)}/>
							{/if}
							<text x={node.status !== 'none' ? -44 : -55} y="-2" fill="#cdd6f4" font-size="12" font-weight="600">{node.label.length > 16 ? node.label.slice(0,15)+'..' : node.label}</text>
							<text x="-55" y="13" fill="#6c7086" font-size="8.5">{(node.detail||'').length > 24 ? (node.detail||'').slice(0,23)+'..' : (node.detail||'')}</text>
						{/if}
					</g>
				{/each}
			</g>
		</svg>

		{#if atlasSelected && atlasData.nodeMap[atlasSelected]}
			{@const sel = atlasData.nodeMap[atlasSelected]}
			{@const conns = (atlasData.allConnections || atlasData.edges).filter(e => e.from === atlasSelected || e.to === atlasSelected)}
			<div class="detail">
				<div class="detail-head">
					<span class="dot" style="background:{statusDot(sel.status)}"></span>
					<strong>{sel.label}</strong>
					{#if sel.technicalName && sel.technicalName !== sel.label}
						<span class="tech-name">({sel.technicalName})</span>
					{/if}
					<span class="dtype" style="color:{nodeColor(sel)}">{sel.type}</span>
					<button class="detail-x" onclick={() => { atlasSelected = null; }}>&times;</button>
				</div>
				<div class="detail-body">
					<div class="detail-status">
						<span class="dot" style="background:{statusDot(sel.status)}"></span>
						{sel.status === 'up' ? 'Running' : sel.status === 'down' ? 'Offline' : sel.status === 'idle' ? 'Idle' : 'Unknown'}
					</div>
					{#if sel.detail}<div class="detail-info">{sel.detail}</div>{/if}
					{#if sel.description}<div class="detail-desc">{sel.description}</div>{/if}
					{#if sel.error}
						<div class="detail-error">
							<div class="detail-error-label">Last error</div>
							<div class="detail-error-msg">{sel.error}</div>
						</div>
					{/if}
					{#if sel.lastCheck || sel.lastRun}
						<div class="detail-meta">
							{#if sel.lastCheck}<span>Checked {Math.round((Date.now() - sel.lastCheck) / 1000)}s ago</span>{/if}
							{#if sel.lastRun}<span>Last run {Math.round((Date.now() - sel.lastRun) / 1000)}s ago</span>{/if}
						</div>
					{/if}
					{#if conns.length > 0}
						<div class="detail-section">Connected To</div>
						{#each conns as edge}
							{@const otherId = edge.from === atlasSelected ? edge.to : edge.from}
							{@const other = atlasData.nodeMap[otherId]}
							{#if other}
								<button class="detail-conn" onclick={() => { atlasSelected = otherId; }}>
									<span class="dot" style="background:{statusDot(other.status)}"></span>
									{other.label}
									{#if edge.label}<span class="conn-label">{edge.label}</span>{/if}
								</button>
							{/if}
						{/each}
					{/if}
				</div>
			</div>
		{/if}
	{/if}

	{#if drilldownData}
		<div class="drilldown">
			<div class="detail-head">
				<strong>{drilldownData.name}</strong>
				<span class="dtype">{drilldownData.type}</span>
				<button class="detail-x" onclick={() => { drilldownData = null; }}>&times;</button>
			</div>
			<div class="detail-body">
				{#if drilldownData.type === 'project'}
					{#if Array.isArray(drilldownData.data) && drilldownData.data.length > 0}
						<div class="detail-section">Tasks ({drilldownData.data.length})</div>
						{#each drilldownData.data.slice(0, 30) as task}
							<div class="sensor-row">
								<span class="dot" style="background:{task.status === 'done' ? '#a6e3a1' : task.status === 'in_progress' ? '#f9e2af' : '#6c7086'}"></span>
								<span class="sensor-name">{task.title}</span>
								<span class="sensor-val">{task.status || ''}</span>
							</div>
						{/each}
					{:else}
						<div class="detail-info">No tasks recorded for this project</div>
					{/if}
				{:else if drilldownData.type === 'device'}
					{#if drilldownData.data?.sensors?.length > 0}
						<div class="detail-section">Sensors ({drilldownData.data.sensors.length})</div>
						{#each drilldownData.data.sensors as sensor}
							<div class="sensor-row">
								<span class="dot" style="background:{sensor.enabled ? '#a6e3a1' : '#6c7086'}"></span>
								<span class="sensor-name">{sensor.name || sensor.category}</span>
								<span class="sensor-val">{sensor.value ?? sensor.last_value ?? '—'}</span>
							</div>
						{/each}
					{:else}
						<div class="detail-info">No sensors found for this device</div>
					{/if}
				{/if}
			</div>
		</div>
	{/if}
</div>

<style>
	:global(html), :global(body) { margin: 0; padding: 0; height: 100%; overflow: hidden; background: #0a0a0f; }

	.atlas-fullscreen {
		width: 100vw;
		height: 100vh;
		background: #0a0a0f;
		overflow: hidden;
		user-select: none;
		position: relative;
	}

	.atlas-topbar {
		position: absolute;
		top: 0; left: 0; right: 0;
		height: 36px;
		background: #11111bee;
		border-bottom: 1px solid #1e1e2e;
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 0 12px;
		z-index: 10;
	}

	.atlas-title { color: #89b4fa; font-weight: 700; font-size: 15px; font-family: serif; }
	.tb { background: #1e1e2e; border: 1px solid #313244; color: #cdd6f4; padding: 3px 10px; border-radius: 4px; cursor: pointer; font-size: 12px; }
	.tb:hover { background: #313244; }
	.atlas-zoom { color: #6c7086; font-size: 11px; }
	.atlas-stat { color: #585b70; font-size: 10px; background: #1e1e2e; padding: 2px 6px; border-radius: 3px; }
	.atlas-live { color: #a6e3a1; font-size: 10px; margin-left: auto; animation: pulse 2s infinite; }
	@keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }
	.atlas-loading { color: #6c7086; text-align: center; margin-top: 40vh; font-size: 16px; }

	.atlas-svg { width: 100%; height: calc(100vh - 36px); margin-top: 36px; }

	.detail {
		position: absolute;
		bottom: 16px; left: 16px;
		background: #1e1e2e;
		border: 1px solid #313244;
		border-radius: 8px;
		padding: 12px 16px;
		min-width: 260px;
		max-width: 380px;
		max-height: 50vh;
		overflow-y: auto;
		z-index: 10;
		box-shadow: 0 4px 20px rgba(0,0,0,0.5);
	}

	.detail-head { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; padding-bottom: 8px; border-bottom: 1px solid #313244; }
	.detail-head strong { color: #cdd6f4; font-size: 14px; }
	.dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; flex-shrink: 0; }
	.dtype { font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px; }
	.detail-x { margin-left: auto; background: none; border: none; color: #6c7086; cursor: pointer; font-size: 18px; }
	.detail-x:hover { color: #cdd6f4; }
	.detail-body { font-size: 11px; color: #a6adc8; line-height: 1.6; }
	.detail-status { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; }
	.detail-info { color: #6c7086; margin-bottom: 4px; }
	.detail-desc { margin-bottom: 8px; }
	.detail-section { color: #585b70; font-size: 10px; text-transform: uppercase; letter-spacing: 1px; margin: 8px 0 4px; }
	.detail-conn { display: flex; align-items: center; gap: 6px; width: 100%; padding: 4px 8px; background: #11111b; border: 1px solid #1e1e2e; border-radius: 4px; color: #cdd6f4; cursor: pointer; font-size: 11px; margin-bottom: 3px; font-family: inherit; }
	.detail-conn:hover { background: #1e1e2e; border-color: #45475a; }
	.conn-label { color: #6c7086; font-size: 9px; margin-left: auto; }
	.detail-error { background: #2e1a1f; border: 1px solid #f38ba8; border-radius: 4px; padding: 6px 8px; margin: 6px 0; }
	.detail-error-label { color: #f38ba8; font-size: 9px; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 2px; }
	.detail-error-msg { color: #fab0b9; font-family: monospace; font-size: 10.5px; word-break: break-word; }
	.detail-meta { display: flex; gap: 10px; color: #585b70; font-size: 10px; margin-top: 6px; }

	.drilldown {
		position: absolute;
		bottom: 16px; right: 16px;
		background: #1e1e2e;
		border: 1px solid #313244;
		border-radius: 8px;
		padding: 12px 16px;
		min-width: 260px;
		max-width: 380px;
		max-height: 50vh;
		overflow-y: auto;
		z-index: 10;
		box-shadow: 0 4px 20px rgba(0,0,0,0.5);
	}
	.sensor-row { display: flex; align-items: center; gap: 8px; padding: 4px 0; border-bottom: 1px solid #11111b; font-size: 11px; }
	.sensor-name { color: #cdd6f4; flex: 1; }
	.sensor-val { color: #89b4fa; font-family: monospace; font-size: 10px; }
</style>
