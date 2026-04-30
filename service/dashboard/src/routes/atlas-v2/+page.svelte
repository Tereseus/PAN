<script>
	import { onMount } from 'svelte';

	let services = $state([]);
	let projects = $state([]);
	let stats = $state(null);
	let usage = $state(null);
	let loading = $state(true);
	const FIT_SCALE = 0.60;
	const CX_CENTER = 1300, CY_CENTER = 1300;
	function fitTransform(s = FIT_SCALE) { return { x: CX_CENTER * (1 - s), y: CY_CENTER * (1 - s), scale: s }; }
	let transform = $state(fitTransform());
	let panDragging = $state(false);
	let dragStart = $state({ x: 0, y: 0 });
	let hovered = $state(null);
	let selected = $state(null);
	let scrubMode = $state(false);
	let refreshTimer = null;
	let animTimer = null;
	let elapsed = $state(0);

	let draggedNode = $state(null);
	let customPositions = $state({});
	let dragNodeStart = $state({ x: 0, y: 0, mx: 0, my: 0 });

	const CX = 1300, CY = 1300;

	// ==================== CODENAME MAP ====================
	const CODENAMES = {
		'pan-server': { code: 'Nexus', tech: 'PAN Server' },
		'database':   { code: 'Vault', tech: 'SQLite/SQLCipher' },
		'dashboard':  { code: 'Mirror', tech: 'SvelteKit Dashboard' },
		'steward':    { code: 'Steward', tech: 'Service Orchestrator' },
		'tauri':      { code: 'Shell', tech: 'Tauri Desktop Shell' },
		'tailscale':  { code: 'Tether', tech: 'Tailscale VPN Mesh' },
		'ollama':     { code: 'Oracle', tech: 'Ollama Model Server' },
		'embeddings': { code: 'Resonance', tech: 'Vector Embeddings (1024D)' },
		'whisper':    { code: 'Listener', tech: 'Whisper STT' },
		'voice-shell':{ code: 'Voice Shell', tech: 'Tauri Hotkeys' },
		'classifier': { code: 'Augur', tech: 'Event Classifier' },
		'intuition':  { code: 'Intuition', tech: 'Dimensional State Daemon' },
		'stack-scanner':{ code: 'Cartographer', tech: 'Stack Scanner' },
		'dream':      { code: 'Dream', tech: 'Dream Cycle (6h)' },
		'consolidation':{ code: 'Archivist', tech: 'Memory Consolidation' },
		'scout':      { code: 'Scout', tech: 'Tool Discovery' },
		'orchestrator':{ code: 'Orchestrator', tech: 'Task Agent' },
		'evolution':  { code: 'Evolution', tech: 'Self-Improvement Engine' },
		'autodev':    { code: 'Forge', tech: 'AutoDev (Headless Claude)' },
		'guardian':   { code: 'Guardian', tech: 'Request Validator' },
		'guillotine': { code: 'Guillotine', tech: 'Orphan Reaper' },
		'sensitivity':{ code: 'Sentinel', tech: 'Sensitivity Router' },
		'privacy':    { code: 'Shroud', tech: 'Privacy Compute' },
		'memory-hub': { code: 'Memoria', tech: 'Memory Hub' },
		'episodic':   { code: 'Episodes', tech: 'Episodic Memory' },
		'semantic':   { code: 'Knowledge', tech: 'Semantic Triples' },
		'procedural': { code: 'Habits', tech: 'Procedural Memory' },
		'inject-ctx': { code: 'Injector', tech: 'Context Injection' },
		'caveman':    { code: 'Caveman', tech: 'Context Compressor' },
	};

	function label(id) {
		const m = CODENAMES[id];
		if (!m) return id;
		return scrubMode ? m.tech : m.code;
	}

	// ==================== SOLAR SYSTEM LAYOUT ====================
	// Each planet at a UNIQUE orbital radius — no two share an orbit.
	// Closer = more fundamental. Further = more autonomous.
	//
	// Nexus (Sun) ── r=0
	//   └─ Moons: Mirror, Shell, Tether (infrastructure)
	//
	// Orbit 1: Vault ── r=180 (database, everything depends on it)
	//
	// Orbit 2: Steward ── r=320 (health monitor, close to core)
	//   └─ Moons: Guardian, Guillotine, Oracle, Listener, Voice Shell, Cartographer
	//
	// Orbit 3: Memoria ── r=500 (memory system)
	//   └─ Moons: Episodes, Knowledge, Habits, Resonance, Injector
	//
	// Orbit 4: Dream ── r=680 (processing pipeline)
	//   └─ Moons: Augur, Intuition, Archivist, Evolution
	//
	// Orbit 5: Forge ── r=860 (intelligence, most autonomous)
	//   └─ Moons: Orchestrator, Scout, Sentinel, Shroud
	//
	// Outer Belt: Projects ── r=1000-1100 (pulled toward relevant planet)

	const NEXUS_MOONS = [
		{ id: 'dashboard', baseAngle: 120, type: 'ui' },
		{ id: 'tauri',     baseAngle: 240, type: 'ui' },
		{ id: 'tailscale', baseAngle: 0,   type: 'service' },
	];
	const NEXUS_MOON_R = 110;
	const NEXUS_MOON_SPEED = 0.25;

	const PLANETS = [
		{
			id: 'database', orbitR: 220, baseAngle: 45, orbitSpeed: 0.3,
			moonR: 0, moonSpeed: 0, moons: [],
		},
		{
			id: 'steward', orbitR: 420, baseAngle: 200, orbitSpeed: -0.15,
			moonR: 105, moonSpeed: 0.35,
			moons: [
				{ id: 'guardian',      baseAngle: 0,   type: 'security', virtual: true },
				{ id: 'guillotine',    baseAngle: 60,  type: 'security', virtual: true },
				{ id: 'ollama',        baseAngle: 120, type: 'service' },
				{ id: 'whisper',       baseAngle: 180, type: 'service' },
				{ id: 'voice-shell',   baseAngle: 240, type: 'service' },
				{ id: 'stack-scanner', baseAngle: 300, type: 'service' },
			],
		},
		{
			id: 'memory-hub', orbitR: 640, baseAngle: 100, orbitSpeed: 0.1,
			moonR: 115, moonSpeed: -0.3,
			moons: [
				{ id: 'episodic',   baseAngle: 0,   type: 'memory', virtual: true },
				{ id: 'semantic',   baseAngle: 72,  type: 'memory', virtual: true },
				{ id: 'procedural', baseAngle: 144, type: 'memory', virtual: true },
				{ id: 'embeddings', baseAngle: 216, type: 'memory' },
				{ id: 'inject-ctx', baseAngle: 288, type: 'memory', virtual: true },
			],
		},
		{
			id: 'dream', orbitR: 870, baseAngle: 300, orbitSpeed: -0.08,
			moonR: 110, moonSpeed: 0.25,
			moons: [
				{ id: 'classifier',    baseAngle: 0,   type: 'process' },
				{ id: 'intuition',     baseAngle: 72,  type: 'process' },
				{ id: 'consolidation', baseAngle: 144, type: 'process' },
				{ id: 'evolution',     baseAngle: 216, type: 'process' },
				{ id: 'caveman',       baseAngle: 288, type: 'process' },
			],
		},
		{
			id: 'autodev', orbitR: 1100, baseAngle: 160, orbitSpeed: 0.06,
			moonR: 110, moonSpeed: -0.2,
			moons: [
				{ id: 'orchestrator', baseAngle: 0,   type: 'ai' },
				{ id: 'scout',        baseAngle: 90,  type: 'ai' },
				{ id: 'sensitivity',  baseAngle: 180, type: 'security', virtual: true },
				{ id: 'privacy',      baseAngle: 270, type: 'security', virtual: true },
			],
		},
	];

	// Which planet each project is gravitationally closest to
	// Based on what the project primarily uses
	function projectGravity(projName) {
		const n = projName.toLowerCase();
		if (n.includes('game') || n.includes('woe') || n.includes('godot')) return 'autodev';
		if (n.includes('discord') || n.includes('bot')) return 'autodev';
		if (n.includes('blood') || n.includes('atc')) return 'steward';
		return 'memory-hub'; // default: most projects touch memory
	}

	function polar(cx, cy, angle, radius) {
		const rad = (angle * Math.PI) / 180;
		return { x: cx + radius * Math.cos(rad), y: cy + radius * Math.sin(rad) };
	}

	function getNodes() {
		const nodes = [];

		// Sun
		nodes.push({ id: 'pan-server', ring: 0, x: CX, y: CY, type: 'core', sector: 'core', isPlanet: false });

		// Nexus moons (infrastructure)
		for (const m of NEXUS_MOONS) {
			const angle = m.baseAngle + NEXUS_MOON_SPEED * elapsed;
			const pos = customPositions[m.id] || polar(CX, CY, angle, NEXUS_MOON_R);
			nodes.push({ ...m, ring: 0.5, sector: 'core', parentPlanet: 'pan-server', x: pos.x, y: pos.y, isPlanet: false });
		}

		// Planets and moons
		for (const planet of PLANETS) {
			const pAngle = planet.baseAngle + planet.orbitSpeed * elapsed;
			const pPos = customPositions[planet.id] || polar(CX, CY, pAngle, planet.orbitR);
			nodes.push({
				id: planet.id, type: planet.moons.length > 0 ? (CODENAMES[planet.id]?.code === 'Vault' ? 'data' : planet.moons[0]?.type || 'core') : 'data',
				ring: 2, sector: planet.id, x: pPos.x, y: pPos.y,
				isPlanet: true, moonCount: planet.moons.length, orbitR: planet.orbitR,
			});

			for (const moon of planet.moons) {
				const mAngle = moon.baseAngle + planet.moonSpeed * elapsed;
				const mPos = customPositions[moon.id] || polar(pPos.x, pPos.y, mAngle, planet.moonR);
				nodes.push({
					...moon, ring: 3, sector: planet.id, parentPlanet: planet.id,
					x: mPos.x, y: mPos.y, isPlanet: false,
				});
			}
		}

		// Projects — positioned near their gravitational planet
		if (projects.length > 0) {
			const projSpeed = 0.03;
			projects.forEach((p, i) => {
				const pid = `proj-${p.id}`;
				if (!CODENAMES[pid]) CODENAMES[pid] = { code: p.name, tech: p.name };

				const gravPlanet = projectGravity(p.name);
				const pNode = nodes.find(n => n.id === gravPlanet);
				if (!pNode) return;

				// Orbit around the gravitational planet at a large radius
				const projOrbitR = 220 + i * 35;
				const projAngle = (i * 137.5) + projSpeed * elapsed; // golden angle spread
				const pos = customPositions[pid] || polar(pNode.x, pNode.y, projAngle, projOrbitR);

				nodes.push({
					id: pid, type: 'project', ring: 5, sector: 'projects',
					x: pos.x, y: pos.y, isPlanet: false, projectData: p,
					gravPlanet,
				});
			});
		}

		// Collision avoidance — push overlapping moons apart
		const MIN_DIST = 140;
		for (let pass = 0; pass < 4; pass++) {
			for (let i = 1; i < nodes.length; i++) {
				if (nodes[i].id === 'pan-server' || customPositions[nodes[i].id]) continue;
				for (let j = i + 1; j < nodes.length; j++) {
					if (nodes[j].id === 'pan-server' || customPositions[nodes[j].id]) continue;
					// Don't push planets (they have fixed orbits)
					if (nodes[i].isPlanet || nodes[j].isPlanet) continue;
					const dx = nodes[j].x - nodes[i].x;
					const dy = nodes[j].y - nodes[i].y;
					const dist = Math.sqrt(dx * dx + dy * dy);
					if (dist < MIN_DIST && dist > 1) {
						const push = (MIN_DIST - dist) / 2;
						const nx = (dx / dist) * push;
						const ny = (dy / dist) * push;
						nodes[i].x -= nx; nodes[i].y -= ny;
						nodes[j].x += nx; nodes[j].y += ny;
					}
				}
			}
		}

		return nodes;
	}

	// ==================== EDGES ====================
	function getEdges(nodes) {
		const nm = Object.fromEntries(nodes.map(n => [n.id, n]));
		const edges = [];
		function e(from, to, color, animated, lbl) {
			if (nm[from] && nm[to]) edges.push({ from, to, color, animated: !!animated, label: lbl || '' });
		}

		// Sun → Nexus moons
		for (const m of NEXUS_MOONS) e('pan-server', m.id, '#89dceb50');

		// Sun → planets (gravitational lines)
		e('pan-server', 'database', '#fab38740');
		e('pan-server', 'steward', '#a6e3a130');
		e('pan-server', 'memory-hub', '#cba6f730');
		e('pan-server', 'dream', '#f9e2af25');
		e('pan-server', 'autodev', '#f38ba820');

		// Planet → moon connections (faint orbital tethers)
		for (const planet of PLANETS) {
			for (const moon of planet.moons) {
				const c = COLORS[moon.type] || '#45475a';
				e(planet.id, moon.id, c + '40');
			}
		}

		// ===== DATA HIGHWAYS (the important flows) =====
		// Vault feeds events to Dream and Memoria
		e('database', 'dream', '#f9e2af', true, 'Events');
		e('database', 'memory-hub', '#cba6f7', true, 'Events');

		// Dream processing feeds back into Memoria
		e('dream', 'memory-hub', '#b4befe', true, 'Memories');

		// Memoria injects context into Forge
		e('memory-hub', 'autodev', '#f38ba8', true, 'Context');

		// Steward monitors the other planets (visible health lines)
		e('steward', 'dream', '#a6e3a1', false, 'Monitors');
		e('steward', 'memory-hub', '#a6e3a1', false, 'Monitors');
		e('steward', 'autodev', '#a6e3a1', false, 'Monitors');

		// Project → gravitational planet
		for (const p of projects) {
			const pid = `proj-${p.id}`;
			const node = nm[pid];
			if (node?.gravPlanet) {
				e(node.gravPlanet, pid, '#94e2d515');
			}
		}

		return edges;
	}

	// ==================== DATA FETCH ====================
	async function api(path) {
		try { const r = await fetch(path); if (!r.ok) return null; return r.json(); } catch { return null; }
	}
	async function refresh() {
		const [a, s, u, p] = await Promise.all([
			api('/api/v1/atlas/services'), api('/dashboard/api/stats'),
			api('/api/automation/usage'), api('/dashboard/api/projects'),
		]);
		if (a?.services) services = a.services;
		if (s) stats = s;
		if (u) usage = u;
		if (p) projects = p;
		loading = false;
	}

	function svc(id) { return services.find(s => s.id === id); }
	function svcStatus(id) {
		const s = svc(id);
		if (!s) return 'unknown';
		if (s.status === 'running') return 'up';
		if (s.status === 'stopped') return 'idle';
		return s.status === 'down' || s.status === 'error' ? 'down' : 'unknown';
	}

	function getRealtimeValue(id) {
		const s = svc(id);
		switch (id) {
			case 'pan-server': return stats ? `${(stats.total_events / 1000).toFixed(1)}K Events` : null;
			case 'database': return stats ? `${(stats.db_size_bytes / 1048576).toFixed(0)} MB` : null;
			case 'dashboard': return stats ? `${stats.total_sessions} Sessions` : null;
			case 'classifier': {
				const c = usage?.today?.by_caller?.['intuition-classifier']?.calls;
				return c ? `${c} Today` : s?.lastRun ? ago(s.lastRun) : null;
			}
			case 'dream': return s?.lastRun ? ago(s.lastRun) : null;
			case 'consolidation': return s?.lastRun ? ago(s.lastRun) : null;
			case 'evolution': return s?.lastRun ? ago(s.lastRun) : null;
			case 'orchestrator': return s?.lastRun ? ago(s.lastRun) : null;
			case 'scout': return s?.lastRun ? ago(s.lastRun) : (s?.status === 'stopped' ? 'Disabled' : null);
			case 'autodev': return s?.status === 'stopped' ? 'Standby' : (s?.lastRun ? ago(s.lastRun) : null);
			case 'intuition': return s?.lastRun ? ago(s.lastRun) : null;
			case 'embeddings': return '1024D';
			case 'ollama': return s?.status === 'running' ? 'Serving' : 'Offline';
			case 'whisper': return s?.status === 'running' ? 'Listening' : 'Offline';
			case 'tailscale': return s?.status === 'running' ? 'Mesh Active' : 'Disconnected';
			case 'memory-hub': return stats ? `${(stats.total_memory / 1000).toFixed(1)}K Memories` : null;
			case 'episodic': return 'What Happened';
			case 'semantic': return 'Facts & Triples';
			case 'procedural': return 'Learned Workflows';
			case 'inject-ctx': return 'CLAUDE.md ← Memory';
			case 'sensitivity': return 'Levels 0–3';
			case 'privacy': return 'Anonymize L2+';
			case 'guardian': return 'Auth + Rate Limit';
			case 'guillotine': return stats ? `${stats.total_restarts} Kills` : 'Zombie Hunter';
			default: {
				if (id.startsWith('proj-')) {
					const n = allNodes.find(n => n.id === id);
					const p = n?.projectData;
					if (p?.total_tasks) return `${p.done_tasks || 0}/${p.total_tasks} Tasks`;
					return p?.session_count ? `${p.session_count} Sessions` : null;
				}
				return s?.lastRun ? ago(s.lastRun) : null;
			}
		}
	}

	function ago(ts) {
		if (!ts) return '';
		const m = Math.round((Date.now() - ts) / 60000);
		if (m < 1) return 'Just Now';
		if (m < 60) return `${m}m Ago`;
		const h = Math.round(m / 60);
		if (h < 24) return `${h}h Ago`;
		return `${Math.round(h / 24)}d Ago`;
	}

	const COLORS = {
		core: '#89b4fa', data: '#fab387', ui: '#89dceb', service: '#a6e3a1',
		memory: '#cba6f7', process: '#f9e2af', ai: '#f38ba8', security: '#f5c2e7',
		project: '#94e2d5',
	};
	function nodeColor(type) { return COLORS[type] || '#6c7086'; }
	function statusColor(id) {
		const st = svcStatus(id);
		return st === 'up' ? '#a6e3a1' : st === 'down' ? '#f38ba8' : st === 'idle' ? '#f9e2af' : '#6c7086';
	}
	function modelBadge(id) {
		const s = svc(id);
		if (!s || !s.modelCurrent || s.modelTier === 'none') return null;
		return { label: s.modelTierLabel, color: s.modelTierColor, model: s.modelCurrent };
	}

	// ==================== INTERACTION ====================
	// Edge panning — mouse near screen edges auto-scrolls
	const EDGE_ZONE = 60;  // pixels from edge to trigger
	const EDGE_SPEED = 8;  // pixels per frame
	let edgePanTimer = null;

	function startEdgePan() {
		if (edgePanTimer) return;
		edgePanTimer = setInterval(() => {
			if (!mousePos) return;
			let dx = 0, dy = 0;
			if (mousePos.x < EDGE_ZONE) dx = EDGE_SPEED;
			else if (mousePos.x > window.innerWidth - EDGE_ZONE) dx = -EDGE_SPEED;
			if (mousePos.y < EDGE_ZONE + 40) dy = EDGE_SPEED; // +40 for topbar
			else if (mousePos.y > window.innerHeight - EDGE_ZONE) dy = -EDGE_SPEED;
			if (dx || dy) transform = { ...transform, x: transform.x + dx, y: transform.y + dy };
		}, 16);
	}
	function stopEdgePan() {
		if (edgePanTimer) { clearInterval(edgePanTimer); edgePanTimer = null; }
	}
	let mousePos = null;

	function handleWheel(e) {
		e.preventDefault();
		transform = { ...transform, scale: Math.max(0.1, Math.min(5, transform.scale * (e.deltaY > 0 ? 0.92 : 1.08))) };
	}
	function handlePointerDown(e) {
		if (e.target.closest('.node-g')) return;
		panDragging = true;
		dragStart = { x: e.clientX - transform.x, y: e.clientY - transform.y };
	}
	function handlePointerMove(e) {
		mousePos = { x: e.clientX, y: e.clientY };
		if (draggedNode) {
			const dx = (e.clientX - dragNodeStart.mx) / transform.scale;
			const dy = (e.clientY - dragNodeStart.my) / transform.scale;
			customPositions = { ...customPositions, [draggedNode]: { x: dragNodeStart.x + dx, y: dragNodeStart.y + dy } };
			return;
		}
		if (panDragging) transform = { ...transform, x: e.clientX - dragStart.x, y: e.clientY - dragStart.y };
	}
	function handlePointerUp() { panDragging = false; draggedNode = null; }
	function startNodeDrag(e, node) {
		e.stopPropagation();
		draggedNode = node.id;
		dragNodeStart = { x: node.x, y: node.y, mx: e.clientX, my: e.clientY };
	}
	function selectNode(id) { if (!draggedNode) selected = selected === id ? null : id; }

	onMount(() => {
		refresh();
		refreshTimer = setInterval(refresh, 5000);
		const t0 = Date.now();
		animTimer = setInterval(() => { elapsed = (Date.now() - t0) / 1000; }, 50);
		startEdgePan();
		return () => { clearInterval(refreshTimer); clearInterval(animTimer); stopEdgePan(); };
	});

	let allNodes = $derived(getNodes());
	let allEdges = $derived(getEdges(allNodes));
	let nodeMap = $derived(Object.fromEntries(allNodes.map(n => [n.id, n])));
	let todayCalls = $derived(usage?.today?.total_calls || 0);
	let totalEvents = $derived(stats?.total_events || 0);
	let dbSize = $derived(stats ? `${(stats.db_size_bytes / 1048576).toFixed(0)} MB` : '—');
</script>

<div class="atlas-v2"
	onwheel={handleWheel}
	onpointerdown={handlePointerDown}
	onpointermove={handlePointerMove}
	onpointerup={handlePointerUp}
	onpointerleave={handlePointerUp}
>
	<div class="topbar">
		<span class="title">Π Atlas <span class="v2">v2</span></span>
		<div class="controls">
			<button class="tb" onclick={() => { transform = fitTransform(); }}>Fit</button>
			<button class="tb" onclick={() => { transform = fitTransform(1); }}>1:1</button>
			<button class="tb" onclick={() => { transform = { ...transform, scale: transform.scale * 1.2 }; }}>+</button>
			<button class="tb" onclick={() => { transform = { ...transform, scale: Math.max(0.1, transform.scale * 0.8) }; }}>−</button>
			<span class="zoom">{Math.round(transform.scale * 100)}%</span>
		</div>
		<div class="stats-bar">
			<span class="stat">{totalEvents.toLocaleString()} Events</span>
			<span class="stat">{dbSize} DB</span>
			<span class="stat">{todayCalls} AI Calls Today</span>
			<span class="stat">{allNodes.length} Bodies</span>
		</div>
		<button class="scrub-toggle" class:active={scrubMode} onclick={() => { scrubMode = !scrubMode; }}>
			{scrubMode ? '⚙ Technical' : '✦ Codenames'}
		</button>
		<span class="live-dot">● LIVE</span>
	</div>

	{#if loading}
		<div class="loading">Initializing Solar System...</div>
	{:else}
		<svg class="svg" viewBox="0 0 2600 2600" preserveAspectRatio="xMidYMid meet">
			<defs>
				<filter id="glow"><feGaussianBlur stdDeviation="6" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
				<filter id="glow-sm"><feGaussianBlur stdDeviation="2.5" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
				<filter id="glow-xs"><feGaussianBlur stdDeviation="1.5" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
				<radialGradient id="sunGlow" cx="50%" cy="50%" r="50%">
					<stop offset="0%" stop-color="#89b4fa" stop-opacity="0.12"/>
					<stop offset="40%" stop-color="#89b4fa" stop-opacity="0.04"/>
					<stop offset="100%" stop-color="#89b4fa" stop-opacity="0"/>
				</radialGradient>
			</defs>

			<g transform="translate({transform.x},{transform.y}) scale({transform.scale})">
				<!-- Sun glow -->
				<circle cx={CX} cy={CY} r="400" fill="url(#sunGlow)"/>

				<!-- Planetary orbital rings — each at unique radius -->
				{#each PLANETS as planet}
					<circle cx={CX} cy={CY} r={planet.orbitR} fill="none"
						stroke={nodeColor(planet.moons[0]?.type || 'data')}
						stroke-width="1" stroke-opacity="0.06" stroke-dasharray="4,12"/>
				{/each}
				<!-- Nexus moon orbit -->
				<circle cx={CX} cy={CY} r={NEXUS_MOON_R} fill="none"
					stroke="#89dceb" stroke-width="0.6" stroke-opacity="0.06" stroke-dasharray="2,8"/>

				<!-- Moon orbital rings around each planet -->
				{#each PLANETS as planet}
					{@const pNode = nodeMap[planet.id]}
					{#if pNode && planet.moonR > 0}
						<circle cx={pNode.x} cy={pNode.y} r={planet.moonR} fill="none"
							stroke={nodeColor(planet.moons[0]?.type || 'core')}
							stroke-width="0.6" stroke-opacity="0.06" stroke-dasharray="2,6"/>
					{/if}
				{/each}

				<!-- Planet labels (orbit with the planet) -->
				{#each PLANETS as planet}
					{@const pNode = nodeMap[planet.id]}
					{#if pNode}
						{@const lblAngle = (planet.baseAngle + planet.orbitSpeed * elapsed + 90) * Math.PI / 180}
						{@const lblR = planet.moonR > 0 ? planet.moonR + 40 : 60}
						<text x={pNode.x + lblR * Math.cos(lblAngle)} y={pNode.y + lblR * Math.sin(lblAngle)}
							fill={nodeColor(planet.moons[0]?.type || 'data') + '25'} font-size="11" font-weight="700"
							letter-spacing="3" text-anchor="middle" dominant-baseline="middle">
							{planet.id === 'database' ? 'DATA' : planet.id === 'steward' ? 'SERVICES' : planet.id === 'memory-hub' ? 'MEMORY' : planet.id === 'dream' ? 'PROCESSING' : 'INTELLIGENCE'}
						</text>
					{/if}
				{/each}

				<!-- EDGES -->
				{#each allEdges as edge}
					{@const f = nodeMap[edge.from]}
					{@const t = nodeMap[edge.to]}
					{#if f && t}
						{@const isHL = selected === edge.from || selected === edge.to || hovered === edge.from || hovered === edge.to}
						{@const isMoon = !!allNodes.find(n => n.id === edge.to && n.parentPlanet === edge.from)}
						<line x1={f.x} y1={f.y} x2={t.x} y2={t.y}
							stroke={edge.color || '#313244'}
							stroke-width={isHL ? 2 : (isMoon ? 0.5 : 1)}
							stroke-opacity={isHL ? 0.7 : (isMoon ? 0.1 : 0.08)}
						/>
						{#if edge.animated && !isMoon}
							<line x1={f.x} y1={f.y} x2={t.x} y2={t.y}
								stroke={edge.color || '#cba6f7'}
								stroke-width={isHL ? 2.5 : 1.5}
								stroke-opacity={isHL ? 0.8 : 0.25}
								stroke-dasharray="6,28"
								class="flow-line"
							/>
						{/if}
						{#if edge.label && isHL && !isMoon}
							{@const mx = (f.x + t.x) / 2}
							{@const my = (f.y + t.y) / 2}
							<rect x={mx - edge.label.length * 3.5 - 6} y={my - 16} width={edge.label.length * 7 + 12} height="16" rx="4" fill="#0e0e14dd"/>
							<text x={mx} y={my - 5} fill={edge.color || '#6c7086'} font-size="9" text-anchor="middle" font-weight="500">{edge.label}</text>
						{/if}
					{/if}
				{/each}

				<!-- Data highway flow particles -->
				{#each [['database','dream','#f9e2af'],['database','memory-hub','#cba6f7'],['dream','memory-hub','#b4befe'],['memory-hub','autodev','#f38ba8']] as hw, i}
					{#if nodeMap[hw[0]] && nodeMap[hw[1]]}
						{@const from = nodeMap[hw[0]]}
						{@const to = nodeMap[hw[1]]}
						<circle r="4" fill={hw[2]} opacity="0.5" filter="url(#glow-xs)">
							<animateMotion dur="{5 + i * 1.5}s" repeatCount="indefinite"
								path="M{from.x},{from.y} L{to.x},{to.y}"/>
						</circle>
					{/if}
				{/each}

				<!-- NODES -->
				{#each allNodes as node}
					{@const color = nodeColor(node.type)}
					{@const st = svcStatus(node.id)}
					{@const isV = node.virtual}
					{@const isSel = selected === node.id}
					{@const isHov = hovered === node.id}
					{@const rtV = getRealtimeValue(node.id)}
					{@const mdl = modelBadge(node.id)}
					{@const nm = label(node.id)}
					<g class="node-g" transform="translate({node.x},{node.y})"
						onpointerenter={() => { hovered = node.id; }}
						onpointerleave={() => { hovered = null; }}
						onpointerdown={(e) => startNodeDrag(e, node)}
						onclick={() => selectNode(node.id)}
						style="cursor:{draggedNode === node.id ? 'grabbing' : 'grab'}"
					>
						{#if node.id === 'pan-server'}
							<!-- ☀ SUN -->
							<circle r="85" fill="#0e0e14" stroke={isSel ? '#89b4fa' : '#89b4fa25'}
								stroke-width={isSel ? 3 : 1.5} filter="url(#glow)" class="pulse-ring"/>
							<circle r="76" fill="none" stroke="#89b4fa" stroke-width="0.5" stroke-opacity="0.1"
								stroke-dasharray="4,8" class="spin-ring"/>
							<text y="-18" fill="#89b4fa" font-size="38" font-weight="700" text-anchor="middle" font-family="serif">Π</text>
							<text y="10" fill="#cdd6f4" font-size="14" font-weight="600" text-anchor="middle">{nm}</text>
							{#if rtV}
								<text y="30" fill="#89b4fa" font-size="11" text-anchor="middle" font-family="monospace">{rtV}</text>
							{/if}

						{:else if node.isPlanet}
							<!-- 🪐 PLANET -->
							{@const pr = node.moonCount > 4 ? 48 : (node.moonCount > 0 ? 42 : 35)}
							<circle r={pr} fill="#0e0e14"
								stroke={isSel ? color : (isHov ? color + 'aa' : color + '25')}
								stroke-width={isSel ? 2.5 : 1.5}
								filter={isSel || isHov ? 'url(#glow-sm)' : ''}/>
							<circle r={pr - 5} fill="none" stroke={color} stroke-width="0.4" stroke-opacity="0.08"
								stroke-dasharray="2,4" class="spin-ring-slow"/>
							{#if svcStatus(node.id) !== 'unknown'}
								<circle cx="0" cy={-(pr - 10)} r="4.5" fill={statusColor(node.id)}>
									{#if st === 'up'}
										<animate attributeName="opacity" values="1;0.3;1" dur="3s" repeatCount="indefinite"/>
									{/if}
								</circle>
							{/if}
							<text y="3" fill="#cdd6f4" font-size="12" font-weight="700" text-anchor="middle">
								{nm.length > 12 ? nm.slice(0,11)+'..' : nm}
							</text>
							{#if rtV}
								<text y="17" fill={color + '99'} font-size="9" font-family="monospace" text-anchor="middle">{rtV}</text>
							{/if}
							{#if mdl}
								<text y="30" fill={mdl.color + '70'} font-size="7.5" text-anchor="middle">
									{mdl.model.length > 20 ? mdl.model.slice(0,19)+'..' : mdl.model}
								</text>
							{/if}

						{:else}
							<!-- 🌙 MOON -->
							{@const w = node.type === 'project' ? 130 : (isV ? 105 : 125)}
							{@const h = mdl ? 54 : (rtV ? 44 : 36)}
							<rect x={-w/2} y={-h/2} width={w} height={h} rx="7"
								fill={isHov || isSel ? '#1a1a24' : (isV ? '#0e0e14cc' : '#0e0e14')}
								stroke={isSel ? color : (isHov ? '#45475a' : color + '18')}
								stroke-width={isSel ? 2 : (isV ? 0.5 : 0.8)}
								stroke-dasharray={isV ? '3,3' : 'none'}
								filter={isSel ? 'url(#glow-xs)' : ''}
							/>
							{#if !isV}
								<circle cx={-w/2 + 13} cy={-3} r="3.5" fill={statusColor(node.id)}>
									{#if st === 'up'}
										<animate attributeName="opacity" values="1;0.4;1" dur="3s" repeatCount="indefinite"/>
									{/if}
								</circle>
							{/if}
							<text x={isV ? 0 : -w/2 + 22} y={-1}
								fill={isV ? color + 'bb' : '#cdd6f4'}
								font-size={isV ? '10' : '11'} font-weight="600"
								text-anchor={isV ? 'middle' : 'start'}>
								{nm.length > 15 ? nm.slice(0,14)+'..' : nm}
							</text>
							{#if rtV}
								<text x={isV ? 0 : -w/2 + 13} y="12"
									fill={color + '99'} font-size="8.5" font-family="monospace"
									text-anchor={isV ? 'middle' : 'start'}>{rtV}</text>
							{/if}
							{#if mdl}
								<rect x={-w/2 + 7} y="18" width={Math.min(w - 14, mdl.model.length * 5.5 + 12)} height="12" rx="3" fill={mdl.color + '15'}/>
								<text x={-w/2 + 13} y="27" fill={mdl.color || '#6c7086'} font-size="7.5" font-weight="500">
									{mdl.model.length > 18 ? mdl.model.slice(0,17)+'..' : mdl.model}
								</text>
							{/if}
						{/if}
					</g>
				{/each}
			</g>
		</svg>

		<!-- DETAIL PANEL -->
		{#if selected && nodeMap[selected]}
			{@const sel = nodeMap[selected]}
			{@const s = svc(selected)}
			{@const mdl = modelBadge(selected)}
			{@const conns = allEdges.filter(e => e.from === selected || e.to === selected)}
			<div class="detail">
				<div class="detail-head">
					{#if !sel.virtual}
						<span class="dot" style="background:{statusColor(selected)}"></span>
					{/if}
					<strong>{label(selected)}</strong>
					{#if CODENAMES[selected]}
						<span class="alt-name">({scrubMode ? CODENAMES[selected].code : CODENAMES[selected].tech})</span>
					{/if}
					<span class="dtype" style="color:{nodeColor(sel.type)}">
						{sel.isPlanet ? '● Planet' : sel.parentPlanet ? '○ Moon of ' + label(sel.parentPlanet) : sel.type}
					</span>
					<button class="detail-x" onclick={() => { selected = null; }}>&times;</button>
				</div>
				<div class="detail-body">
					{#if s}
						<div class="detail-status">
							<span class="dot" style="background:{statusColor(selected)}"></span>
							{s.status === 'running' ? 'Running' : s.status === 'stopped' ? 'Stopped' : 'Unknown'}
							{#if s.port}<span class="port">:{s.port}</span>{/if}
						</div>
						{#if s.description}<div class="detail-desc">{s.description}</div>{/if}
						{#if s.interval}<div class="detail-meta">Interval: {s.interval}</div>{/if}
						{#if s.lastRun}<div class="detail-meta">Last Run: {ago(s.lastRun)}</div>{/if}
						{#if s.lastError}<div class="detail-error">{s.lastError}</div>{/if}
					{:else if sel.virtual}
						<div class="detail-desc" style="color:#6c7086">
							{sel.parentPlanet ? `Moon of ${label(sel.parentPlanet)}` : 'Virtual subsystem node'}
						</div>
					{/if}
					{#if mdl}
						<div class="detail-section">AI Model</div>
						<div class="model-row">
							<span class="model-badge" style="background:{mdl.color}18; color:{mdl.color}; border:1px solid {mdl.color}40">{mdl.label}</span>
							<span class="model-name">{mdl.model}</span>
						</div>
					{/if}
					{#if getRealtimeValue(selected)}
						<div class="detail-section">Live Value</div>
						<div class="rt-display">{getRealtimeValue(selected)}</div>
					{/if}
					{#if conns.length > 0}
						<div class="detail-section">Connections ({conns.length})</div>
						{#each conns.slice(0, 12) as edge}
							{@const oid = edge.from === selected ? edge.to : edge.from}
							{@const dir = edge.from === selected ? '→' : '←'}
							{#if nodeMap[oid]}
								<button class="detail-conn" onclick={() => { selected = oid; }}>
									<span class="conn-dir">{dir}</span>
									{label(oid)}
									{#if edge.label}<span class="conn-label">{edge.label}</span>{/if}
								</button>
							{/if}
						{/each}
					{/if}
				</div>
			</div>
		{/if}
	{/if}
</div>

<style>
	:global(html), :global(body) { margin: 0; padding: 0; height: 100%; overflow: hidden; background: #08080c; }
	.atlas-v2 {
		width: 100vw; height: 100vh;
		background: radial-gradient(ellipse at center, #0c0c12 0%, #08080c 60%);
		overflow: hidden; user-select: none; position: relative;
	}
	.topbar {
		position: absolute; top: 0; left: 0; right: 0; height: 40px;
		background: #0c0c12ee; border-bottom: 1px solid #18182a;
		display: flex; align-items: center; gap: 10px; padding: 0 16px; z-index: 10;
	}
	.title { color: #89b4fa; font-weight: 700; font-size: 16px; font-family: serif; }
	.v2 { color: #cba6f7; font-size: 10px; vertical-align: super; font-family: sans-serif; }
	.controls { display: flex; gap: 4px; }
	.tb { background: #18182a; border: 1px solid #22223a; color: #cdd6f4; padding: 3px 10px; border-radius: 4px; cursor: pointer; font-size: 12px; }
	.tb:hover { background: #22223a; }
	.zoom { color: #6c7086; font-size: 11px; min-width: 36px; }
	.stats-bar { display: flex; gap: 6px; margin-left: auto; }
	.stat { color: #585b70; font-size: 10px; background: #18182a; padding: 2px 8px; border-radius: 3px; font-family: monospace; }
	.scrub-toggle {
		background: #18182a; border: 1px solid #22223a; color: #cdd6f4;
		padding: 3px 12px; border-radius: 12px; cursor: pointer; font-size: 11px; transition: all 0.2s;
	}
	.scrub-toggle:hover { border-color: #cba6f7; }
	.scrub-toggle.active { background: #cba6f720; border-color: #cba6f7; color: #cba6f7; }
	.live-dot { color: #a6e3a1; font-size: 10px; animation: pulse 2s infinite; }
	@keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.3; } }
	.loading { color: #6c7086; text-align: center; margin-top: 45vh; font-size: 16px; }
	.svg { width: 100%; height: calc(100vh - 40px); margin-top: 40px; }
	.flow-line { animation: flow 3s linear infinite; }
	@keyframes flow { from { stroke-dashoffset: 0; } to { stroke-dashoffset: -68; } }
	.pulse-ring { animation: corePulse 5s ease-in-out infinite; }
	@keyframes corePulse { 0%, 100% { stroke-opacity: 0.25; } 50% { stroke-opacity: 0.7; } }
	.spin-ring { animation: spin 25s linear infinite; transform-origin: center; }
	.spin-ring-slow { animation: spin 40s linear infinite; transform-origin: center; }
	@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
	.detail {
		position: absolute; bottom: 16px; left: 16px;
		background: #10101aee; border: 1px solid #22223a; border-radius: 10px;
		padding: 14px 18px; min-width: 280px; max-width: 380px;
		max-height: 55vh; overflow-y: auto; z-index: 10;
		box-shadow: 0 4px 30px rgba(0,0,0,0.7); backdrop-filter: blur(12px);
	}
	.detail-head { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; padding-bottom: 8px; border-bottom: 1px solid #22223a; flex-wrap: wrap; }
	.detail-head strong { color: #cdd6f4; font-size: 14px; }
	.alt-name { color: #585b70; font-size: 11px; }
	.dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; flex-shrink: 0; }
	.dtype { font-size: 9px; letter-spacing: 0.5px; }
	.detail-x { margin-left: auto; background: none; border: none; color: #6c7086; cursor: pointer; font-size: 18px; }
	.detail-x:hover { color: #cdd6f4; }
	.detail-body { font-size: 11px; color: #a6adc8; line-height: 1.6; }
	.detail-status { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; }
	.port { color: #6c7086; font-family: monospace; font-size: 10px; }
	.detail-desc { color: #a6adc8; margin-bottom: 6px; }
	.detail-meta { color: #585b70; font-size: 10px; }
	.detail-error { background: #2e1a1f; border: 1px solid #f38ba840; border-radius: 4px; padding: 6px 8px; margin: 6px 0; color: #f38ba8; font-size: 10px; }
	.detail-section { color: #585b70; font-size: 9px; text-transform: uppercase; letter-spacing: 1px; margin: 10px 0 4px; }
	.model-row { display: flex; align-items: center; gap: 8px; margin: 4px 0; }
	.model-badge { padding: 2px 8px; border-radius: 4px; font-size: 10px; font-weight: 600; }
	.model-name { color: #cdd6f4; font-size: 11px; font-family: monospace; }
	.rt-display { color: #89b4fa; font-family: monospace; font-size: 13px; font-weight: 600; padding: 4px 0; }
	.detail-conn {
		display: flex; align-items: center; gap: 6px; width: 100%;
		padding: 4px 8px; background: #0c0c12; border: 1px solid #18182a;
		border-radius: 4px; color: #cdd6f4; cursor: pointer; font-size: 11px;
		margin-bottom: 3px; font-family: inherit;
	}
	.detail-conn:hover { background: #18182a; border-color: #45475a; }
	.conn-dir { color: #6c7086; font-family: monospace; font-size: 10px; }
	.conn-label { color: #6c7086; font-size: 9px; margin-left: auto; }
</style>
