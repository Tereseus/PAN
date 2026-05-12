<script>
	import { onMount } from 'svelte';

	// Phone Atlas — live topology of the Android voice/sensor/AI pipeline.
	// Distinct from the main Π Atlas (radial server map). The phone is a linear
	// pipeline at heart (Mic → STT → Router → AI → TTS) so we render it as
	// horizontal stages with side-branches for camera, sensors, intuition.
	// Status comes from /api/v1/logs?device_type=phone — we mine the most recent
	// log per component to color the node green/yellow/red.

	let logs = $state([]);
	let intuition = $state(null);
	let phoneDevice = $state(null);
	let serverApk = $state(null);   // /api/v1/apk/version — what the server is publishing
	let selected = $state(null);
	let loading = $state(true);
	let lastRefresh = $state(0);
	let refreshTimer = null;

	// Parse the phone's installed build out of recent logs.
	// PanForegroundService logs: "Build: versionCode=4 versionName=0.4.1 appId=dev.pan.app"
	function phoneInstalled() {
		for (const l of logs) {
			const m = (l.message || '').match(/^Build: versionCode=(\d+) versionName=(\S+) appId=(\S+)/);
			if (m) return { versionCode: +m[1], versionName: m[2], appId: m[3], seenAt: l.created_at };
		}
		return null;
	}

	// Each stage maps a node id to its log-message detector. A node turns:
	//   green  → matched a recent log within OK_WINDOW_MS
	//   yellow → matched but >OK_WINDOW_MS ago (stale)
	//   red    → matched an error pattern OR never matched
	//   grey   → never seen (idle / not exercised yet)
	const OK_WINDOW_MS = 5 * 60_000; // 5 minutes = "live"

	const NODES = [
		// [id, label, x, y, kind, detect(message) => 'ok'|'err'|null, oneLineDesc]
		{ id: 'mic',      label: 'Phone Mic',          x: 60,   y: 220, kind: 'sensor',
		  detect: m => m.startsWith('[STT] Listening') ? 'ok' : null,
		  desc: 'Android always-on PCM capture. No wake word — raw stream into Google STT.' },
		{ id: 'stt',      label: 'Google STT',         x: 220,  y: 220, kind: 'sensor',
		  detect: m => m.startsWith('[STT] Final') ? 'ok' : (m.startsWith('[STT] Error') ? 'err' : null),
		  desc: 'Google Streaming STT. Cloud round-trip 300-500ms. Final transcripts go to onSpeech().' },
		{ id: 'heard',    label: 'onSpeech',           x: 380,  y: 220, kind: 'router',
		  detect: m => m.startsWith('Heard:') ? 'ok' : null,
		  desc: 'PanForegroundService.onSpeech() — dedup, wake-word strip, route to handler.' },
		{ id: 'router',   label: 'Router',             x: 540,  y: 220, kind: 'router',
		  detect: m => m.startsWith('Camera command detected') || m.startsWith('Instant:') || m.startsWith('Stream (first=') ? 'ok' : null,
		  desc: 'Classifies query: instant hardware? camera? calendar? location? else → askPanStream().' },

		// Branches
		{ id: 'instant',  label: 'Instant',            x: 700,  y: 80,  kind: 'branch',
		  detect: m => m.startsWith('Instant:') ? 'ok' : null,
		  desc: 'Pure-local instant commands: time, flashlight, timer. Zero latency, no LLM.' },
		{ id: 'camera',   label: 'Camera',             x: 700,  y: 150, kind: 'branch',
		  detect: m => m.startsWith('Camera command detected') || m.startsWith('Taking photo') || m.startsWith('Photo captured') ? 'ok' : null,
		  desc: 'CameraCapture takes JPEG → base64 → server /api/v1/vision. Result spoken via panSpeak.' },
		{ id: 'vision',   label: 'Vision',             x: 860,  y: 150, kind: 'branch',
		  detect: m => m.startsWith('Vision result') ? 'ok' : null,
		  desc: 'Server-side image analysis. Typical latency 10-15s — that\'s why we say "Let me have a look" up front.' },
		{ id: 'askpan',   label: 'askPanStream',       x: 700,  y: 220, kind: 'core',
		  detect: m => m.startsWith('Stream (first=') ? 'ok' : (m.startsWith('Stream returned null') || m.startsWith('Server unreachable') ? 'err' : null),
		  desc: 'Streaming server call with conversation history + sensor envelope. First-chunk + total latency logged here.' },
		{ id: 'cerebras', label: 'Cerebras / Claude',  x: 860,  y: 220, kind: 'ai',
		  detect: m => m.startsWith('Stream (first=') ? 'ok' : null,
		  desc: 'AI backbone. Cerebras qwen-3-235b default (~150ms inference, free tier). Claude Haiku fallback.' },

		{ id: 'tts',      label: 'Piper / TTS',        x: 1020, y: 220, kind: 'speak',
		  detect: m => m.startsWith('Piper TTS') || m.startsWith('User interrupted TTS') ? 'ok' : null,
		  desc: 'On-device Piper voice or Android TTS fallback. 100-300ms synthesis. Stops STT during playback.' },
		{ id: 'bargein',  label: 'BargeIn',            x: 1180, y: 220, kind: 'speak',
		  detect: m => m.startsWith('[BargeIn]') ? 'ok' : (m === 'User interrupted TTS' ? 'err' : null),
		  desc: 'AEC-attached audio monitor. Detects user speech during TTS. Tuned for sustained signal — no false positives on echo residual.' },

		// Side rail: sensors, intuition, AI usage
		{ id: 'sensors',  label: 'Sensors',            x: 380,  y: 340, kind: 'sensor',
		  detect: m => m.startsWith('Sensors started') || m.startsWith('All sensors toggled') ? 'ok' : null,
		  desc: 'GPS, IMU, ambient light, etc. Server-controlled enable/disable. Envelope attached to every askPanStream call.' },
		{ id: 'intuition',label: 'Intuition',          x: 540,  y: 340, kind: 'ui',
		  detect: () => null,  // status from /api/v1/intuition/current instead
		  desc: 'Live commander state (where, activity, mood, focus). Drives the JARVIS IntuitionCard on the phone home screen.' },
		{ id: 'thinking', label: 'PanThinkingCard',    x: 700,  y: 340, kind: 'ui',
		  detect: m => m.startsWith('Stream (first=') ? 'ok' : null,
		  desc: 'Native Compose card showing what PAN is thinking + last response time. Filler ("hold on...") shown if first chunk takes >1.5s.' },
		{ id: 'service',  label: 'PAN Service',        x: 60,   y: 80,  kind: 'core',
		  detect: m => m === 'PAN service created' ? 'ok' : null,
		  desc: 'Foreground service. Hosts STT, TTS, sensors, log shipper, sync manager. Battery-exempt.' },
		{ id: 'logship',  label: 'LogShipper',         x: 60,   y: 340, kind: 'core',
		  detect: () => 'ok',  // we're seeing logs at all → ok
		  desc: 'Batches phone logs every 5s and POSTs to /api/v1/logs. This page reads back from there.' },

		// Updater — OTA self-update path. Fires 8s after MainActivity boots,
		// hits /api/v1/apk/version, compares versionCode, downloads + sha256-verifies
		// + hands to the system installer. Click for live version comparison.
		{ id: 'updater',  label: 'Updater (OTA)',      x: 1180, y: 80,  kind: 'core',
		  detect: m => {
			if (m.startsWith('Update check error') || m.includes('sha256 mismatch') || m.includes('download failed')) return 'err';
			if (m.startsWith('Build: versionCode=')) return 'ok';
			if (m.startsWith('Update check:') || m.startsWith('Update check starting') ||
			    m.startsWith('Update available:') || m.startsWith('Launching system installer') ||
			    m.startsWith('sha256 verified')) return 'ok';
			return null;
		  },
		  desc: 'Self-update OTA. Every MainActivity boot pings /api/v1/apk/version; if server reports a higher versionCode, downloads APK to cacheDir/updates, verifies sha256, hands to system installer via FileProvider. One-tap "Update this app?" dialog — no manual sideload.' },
	];

	const EDGES = [
		['service', 'mic', 'spawn'],
		['mic', 'stt', 'audio'],
		['stt', 'heard', 'text'],
		['heard', 'router', 'route'],
		['router', 'instant', null],
		['router', 'camera', null],
		['camera', 'vision', 'jpeg→vision'],
		['router', 'askpan', null],
		['askpan', 'cerebras', null],
		['cerebras', 'tts', 'response'],
		['tts', 'bargein', 'AEC ref'],
		['bargein', 'mic', 'barge→stop TTS', 'curve'],
		['mic', 'sensors', null],
		['sensors', 'intuition', null],
		['intuition', 'thinking', null],
		['askpan', 'thinking', 'first-chunk ms'],
		['vision', 'tts', 'spoken result'],
		['logship', 'mic', 'logs', 'dim'],
		['service', 'updater', '8s boot ping', 'dim'],
	];

	async function loadPhone() {
		try {
			const [logRes, intuRes, devRes, apkRes] = await Promise.all([
				fetch('/api/v1/logs?device_type=phone&limit=200').then(r => r.json()).catch(() => []),
				fetch('/api/v1/intuition/current').then(r => r.json()).catch(() => null),
				fetch('/api/v1/devices/list').then(r => r.json()).catch(() => []),
				fetch('/api/v1/apk/version').then(r => r.ok ? r.json() : null).catch(() => null),
			]);
			logs = Array.isArray(logRes) ? logRes : [];
			intuition = intuRes?.snapshot || null;
			const devs = Array.isArray(devRes) ? devRes : [];
			phoneDevice = devs.find(d => d?.device_type === 'phone') || null;
			serverApk = apkRes || null;
			lastRefresh = Date.now();
		} catch (e) {
			console.error('Phone Atlas load failed:', e);
		}
		loading = false;
	}

	// For each node, find the most recent matching log entry.
	function nodeState(node) {
		if (node.id === 'intuition') {
			return intuition?.now ? { status: 'ok', msg: intuition.now.activity || '—', age: 0 } : { status: 'idle', msg: 'no snapshot', age: null };
		}
		let best = null;
		for (const l of logs) {
			const verdict = node.detect(l.message || '');
			if (verdict) {
				const t = Date.parse(l.created_at?.replace(' ', 'T') + 'Z') || 0;
				if (!best || t > best.t) best = { verdict, msg: l.message, t };
			}
		}
		if (!best) return { status: 'idle', msg: 'no recent events', age: null };
		const age = Date.now() - best.t;
		let status = best.verdict;
		if (status === 'ok' && age > OK_WINDOW_MS) status = 'stale';
		return { status, msg: best.msg, age };
	}

	function nodeRecent(node, limit = 6) {
		const matches = [];
		for (const l of logs) {
			if (node.detect(l.message || '')) matches.push(l);
			if (matches.length >= limit) break;
		}
		return matches;
	}

	function fmtAge(ms) {
		if (ms == null) return '';
		if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
		if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
		return `${Math.round(ms / 3_600_000)}h ago`;
	}

	const STATUS_COLOR = {
		ok:    '#a6e3a1',
		stale: '#f9e2af',
		err:   '#f38ba8',
		idle:  '#6c7086',
	};
	const KIND_BG = {
		sensor: '#1e293b',
		router: '#1f1d2e',
		branch: '#2a1f2e',
		core:   '#1e2538',
		ai:     '#2d1e2e',
		speak:  '#1e2e2b',
		ui:     '#23252e',
	};

	onMount(() => {
		loadPhone();
		refreshTimer = setInterval(loadPhone, 5000); // 5s — this is a debug surface, freshness matters
		return () => { if (refreshTimer) clearInterval(refreshTimer); };
	});

	function nodeById(id) { return NODES.find(n => n.id === id); }
	// Compute an SVG path for an edge. Mostly straight, but 'curve' edges arc
	// (for the bargein→mic feedback loop so it doesn't overlap the main rail).
	function edgePath(from, to, kind) {
		const a = nodeById(from), b = nodeById(to);
		if (!a || !b) return '';
		const ax = a.x + 70, ay = a.y + 24;
		const bx = b.x + 70, by = b.y + 24;
		if (kind === 'curve') {
			const midY = Math.min(ay, by) - 80;
			return `M ${ax} ${ay} C ${ax} ${midY}, ${bx} ${midY}, ${bx} ${by}`;
		}
		return `M ${ax} ${ay} L ${bx} ${by}`;
	}
</script>

<div class="phone-atlas">
	<header class="topbar">
		<div class="title">
			<span class="brand">Π</span>
			<span>Phone Atlas</span>
			<span class="sep">·</span>
			<span class="sub">live pipeline · {phoneDevice?.name || 'Pixel'} · {logs.length} log lines</span>
		</div>
		<div class="actions">
			<a class="link" href="/atlas">← back to Π Atlas</a>
			<a class="link" href="/v2/terminal">terminal</a>
			<span class="live">● LIVE · {fmtAge(Date.now() - lastRefresh)}</span>
		</div>
	</header>

	{#if loading}
		<div class="loading">Loading phone topology…</div>
	{:else}
		<div class="canvas-wrap">
			<svg viewBox="0 0 1320 460" class="canvas">
				<!-- Edges first so nodes draw on top -->
				{#each EDGES as [from, to, label, kind] (from + '→' + to)}
					{@const fromState = nodeState(nodeById(from))}
					{@const toState = nodeState(nodeById(to))}
					{@const live = fromState.status === 'ok' && toState.status === 'ok'}
					{@const dim = kind === 'dim'}
					<path
						d={edgePath(from, to, kind)}
						stroke={live ? '#94e2d5' : dim ? '#313244' : '#45475a'}
						stroke-width={live ? 2 : 1.2}
						stroke-dasharray={live ? '0' : '4 4'}
						fill="none"
						opacity={dim ? 0.5 : 1}
					/>
					{#if label}
						{@const a = nodeById(from)}
						{@const b = nodeById(to)}
						<text
							x={(a.x + b.x) / 2 + 70}
							y={(a.y + b.y) / 2 + 14}
							class="edge-label"
							fill="#6c7086"
						>{label}</text>
					{/if}
				{/each}

				<!-- Nodes -->
				{#each NODES as node (node.id)}
					{@const state = nodeState(node)}
					{@const color = STATUS_COLOR[state.status]}
					{@const isSel = selected?.id === node.id}
					<g
						class="node"
						class:selected={isSel}
						transform="translate({node.x}, {node.y})"
						onclick={() => selected = selected?.id === node.id ? null : node}
						onkeydown={(e) => e.key === 'Enter' && (selected = node)}
						role="button"
						tabindex="0"
					>
						<rect width="140" height="48" rx="8"
							fill={KIND_BG[node.kind]}
							stroke={isSel ? '#cba6f7' : color}
							stroke-width={isSel ? 2.5 : 1.5} />
						<circle cx="14" cy="24" r="5" fill={color} />
						<text x="28" y="22" class="node-label" fill="#cdd6f4">{node.label}</text>
						<text x="28" y="38" class="node-detail" fill="#9399b2">
							{state.status === 'ok' ? fmtAge(state.age) : state.status}
						</text>
					</g>
				{/each}
			</svg>
		</div>

		<aside class="detail">
			{#if selected}
				{@const state = nodeState(selected)}
				<div class="dh">
					<span class="dot" style:background={STATUS_COLOR[state.status]}></span>
					<h2>{selected.label}</h2>
					<button class="x" onclick={() => selected = null}>✕</button>
				</div>
				<p class="dd">{selected.desc}</p>
				<div class="kv"><span>Status</span><strong style:color={STATUS_COLOR[state.status]}>{state.status.toUpperCase()}</strong></div>
				<div class="kv"><span>Last event</span><strong>{fmtAge(state.age)}</strong></div>
				<div class="kv last-msg"><span>Message</span><code>{state.msg}</code></div>

				{#if selected.id === 'updater'}
					{@const inst = phoneInstalled()}
					{@const behind = inst && serverApk && serverApk.versionCode > inst.versionCode}
					{@const ahead = inst && serverApk && serverApk.versionCode < inst.versionCode}
					<h3>Version comparison</h3>
					<div class="kv"><span>Phone (installed)</span><strong>
						{#if inst}{inst.versionName} (code {inst.versionCode}){:else}<em style:color="#6c7086">no Build log yet — relaunch phone app</em>{/if}
					</strong></div>
					<div class="kv"><span>Server (published)</span><strong>
						{#if serverApk}{serverApk.versionName} (code {serverApk.versionCode}){:else}<em style:color="#f38ba8">/api/v1/apk/version unreachable</em>{/if}
					</strong></div>
					{#if behind}
						<div class="kv"><span>Status</span><strong style:color="#f9e2af">Update pending — phone will fetch on next boot</strong></div>
					{:else if ahead}
						<div class="kv"><span>Status</span><strong style:color="#cba6f7">Phone is AHEAD of server (dev build?)</strong></div>
					{:else if inst && serverApk}
						<div class="kv"><span>Status</span><strong style:color="#a6e3a1">In sync</strong></div>
					{/if}
					{#if serverApk}
						<div class="kv"><span>APK size</span><strong>{Math.round((serverApk.apkSize || 0) / 1024 / 1024)} MB</strong></div>
						<div class="kv last-msg"><span>sha256</span><code>{serverApk.sha256 || '—'}</code></div>
					{/if}
				{/if}

				{#if selected.id === 'intuition' && intuition?.now}
					<h3>Snapshot</h3>
					<div class="kv"><span>Where</span><strong>{intuition.now.where || '—'}</strong></div>
					<div class="kv"><span>Activity</span><strong>{intuition.now.activity || '—'}</strong></div>
					<div class="kv"><span>Focus</span><strong>{intuition.now.focus || '—'}</strong></div>
					<div class="kv"><span>Mood</span><strong>{intuition.now.mood || '—'}</strong></div>
					<div class="kv"><span>Direction</span><strong>{intuition.now.direction || '—'}</strong></div>
				{/if}

				<h3>Recent log lines</h3>
				<ul class="loglist">
					{#each nodeRecent(selected, 10) as l}
						<li>
							<span class="ts">{l.created_at?.slice(11, 19)}</span>
							<span class="msg">{l.message}</span>
						</li>
					{:else}
						<li class="empty">No matching log lines yet — exercise this component on the phone to see it light up.</li>
					{/each}
				</ul>
			{:else}
				<div class="hint">
					<h2>Phone subsystem at a glance</h2>
					<p>Each box is a phone component. Color = freshest log status (green=live, yellow=stale, red=error, grey=idle). Click any box to drill in.</p>
					<div class="legend">
						<span><span class="dot" style:background={STATUS_COLOR.ok}></span> Live (&lt;5min)</span>
						<span><span class="dot" style:background={STATUS_COLOR.stale}></span> Stale</span>
						<span><span class="dot" style:background={STATUS_COLOR.err}></span> Error</span>
						<span><span class="dot" style:background={STATUS_COLOR.idle}></span> Idle</span>
					</div>
					<h3>Quick triage</h3>
					<ul class="triage">
						<li><strong>"PAN cut itself off"</strong> → check <em>BargeIn</em> node — red means false self-interrupt</li>
						<li><strong>"Camera ignored"</strong> → check <em>Camera</em> + <em>Vision</em> path — vision is 10-15s by design</li>
						<li><strong>"Slow replies"</strong> → check <em>askPanStream</em> first-chunk ms in logs</li>
						<li><strong>"No response at all"</strong> → check <em>onSpeech</em> for "Heard:" entry</li>
					</ul>
				</div>
			{/if}
		</aside>
	{/if}
</div>

<style>
	.phone-atlas {
		position: fixed;
		inset: 0;
		background: #11111b;
		color: #cdd6f4;
		font-family: 'Inter', system-ui, sans-serif;
		display: grid;
		grid-template-rows: auto 1fr;
		grid-template-columns: 1fr 380px;
	}
	.topbar {
		grid-column: 1 / -1;
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 10px 16px;
		border-bottom: 1px solid #313244;
		background: #181825;
	}
	.title { display: flex; align-items: center; gap: 8px; font-size: 15px; }
	.brand { color: #cba6f7; font-weight: 700; font-size: 20px; }
	.sep { color: #45475a; }
	.sub { color: #6c7086; font-size: 13px; }
	.actions { display: flex; align-items: center; gap: 14px; font-size: 13px; }
	.link { color: #89b4fa; text-decoration: none; }
	.link:hover { text-decoration: underline; }
	.live { color: #a6e3a1; font-size: 12px; }
	.loading { padding: 40px; color: #6c7086; }

	.canvas-wrap {
		overflow: auto;
		padding: 16px;
	}
	.canvas {
		width: 100%;
		min-width: 1320px;
		height: 460px;
		display: block;
	}

	.node { cursor: pointer; }
	.node:hover rect { filter: brightness(1.2); }
	.node-label { font-size: 13px; font-weight: 600; }
	.node-detail { font-size: 10px; }
	.edge-label { font-size: 10px; }

	.detail {
		border-left: 1px solid #313244;
		background: #181825;
		padding: 16px;
		overflow-y: auto;
		font-size: 13px;
	}
	.dh { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
	.dh h2 { margin: 0; font-size: 16px; flex: 1; }
	.dh .x { background: transparent; border: 0; color: #6c7086; cursor: pointer; font-size: 16px; }
	.dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; }
	.dd { color: #bac2de; line-height: 1.4; margin: 0 0 12px; }
	.kv { display: flex; justify-content: space-between; padding: 4px 0; border-bottom: 1px dashed #313244; gap: 8px; }
	.kv span { color: #6c7086; }
	.kv strong { color: #cdd6f4; font-weight: 500; }
	.kv.last-msg { flex-direction: column; align-items: stretch; }
	.kv.last-msg code { background: #1e1e2e; padding: 4px 6px; border-radius: 4px; font-size: 11px; word-break: break-all; margin-top: 2px; }

	h3 { font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; color: #6c7086; margin: 16px 0 6px; }
	.loglist { list-style: none; padding: 0; margin: 0; max-height: 260px; overflow-y: auto; }
	.loglist li { display: flex; gap: 8px; padding: 3px 0; border-bottom: 1px dotted #313244; font-size: 11px; }
	.loglist .ts { color: #6c7086; font-family: monospace; flex-shrink: 0; }
	.loglist .msg { color: #bac2de; word-break: break-word; }
	.loglist .empty { color: #6c7086; font-style: italic; padding: 8px 0; }

	.hint h2 { font-size: 15px; margin: 0 0 8px; }
	.hint p { color: #9399b2; line-height: 1.5; }
	.legend { display: flex; flex-wrap: wrap; gap: 10px; margin: 12px 0; font-size: 12px; }
	.legend span { display: flex; align-items: center; gap: 4px; color: #9399b2; }
	.triage { padding-left: 18px; line-height: 1.6; color: #bac2de; }
	.triage strong { color: #cdd6f4; }
	.triage em { color: #89dceb; font-style: normal; }
</style>
