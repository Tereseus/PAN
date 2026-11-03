<!--
  AtlasPanel.svelte — animated SVG orrery view shown when the center column
  is set to `centerView === 'atlas'`. Reads everything from the atlas store;
  the only outside touchpoint is `setLeftSection` from the terminal store,
  used by the per-node "Go to Devices/Projects" navigation buttons.
-->
<script>
	import { onMount, onDestroy } from 'svelte';
	import {
		atlas,
		loadAtlasData,
		stopAtlasTimers,
		atlasNodeColor,
		handleAtlasWheel,
		handleAtlasPointerDown,
		handleAtlasPointerMove,
		handleAtlasPointerUp,
		atlasResetView,
	} from '$lib/stores/atlas.svelte.js';
	import { setLeftSection } from '$lib/stores/terminal.svelte.js';

	onMount(() => { loadAtlasData(); });
	onDestroy(() => { stopAtlasTimers(); });
</script>

<div class="atlas-container"
	onwheel={handleAtlasWheel}
	onpointerdown={handleAtlasPointerDown}
	onpointermove={handleAtlasPointerMove}
	onpointerup={handleAtlasPointerUp}
	onpointerleave={handleAtlasPointerUp}
>
	{#if atlas.loading}
		<div class="term-empty">
			<div class="term-empty-title">Initializing Orrery...</div>
		</div>
	{:else if atlas.data}
		<div class="atlas-toolbar">
			<button class="atlas-btn" onclick={atlasResetView}>Reset</button>
			<button class="atlas-btn" onclick={() => { atlas.transform = { ...atlas.transform, scale: atlas.transform.scale * 1.2 }; }}>+</button>
			<button class="atlas-btn" onclick={() => { atlas.transform = { ...atlas.transform, scale: Math.max(0.2, atlas.transform.scale * 0.8) }; }}>-</button>
			<span class="atlas-zoom">{Math.round(atlas.transform.scale * 100)}%</span>
			{#if atlas.data.stats}
				<span class="atlas-stat">{atlas.data.stats.total_events || 0} events</span>
				<span class="atlas-stat">{atlas.data.stats.total_sessions || 0} sessions</span>
			{/if}
			<span class="atlas-live">● LIVE</span>
		</div>
		<svg class="atlas-svg" viewBox="0 0 2300 1600" preserveAspectRatio="xMidYMid meet">
			<defs>
				<filter id="ag"><feGaussianBlur stdDeviation="5" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
				<filter id="ag2"><feGaussianBlur stdDeviation="2" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
				<radialGradient id="asg" cx="50%" cy="50%" r="50%">
					<stop offset="0%" stop-color="#89b4fa" stop-opacity="0.10"/>
					<stop offset="100%" stop-color="#89b4fa" stop-opacity="0"/>
				</radialGradient>
				<filter id="mapglow">
					<feGaussianBlur stdDeviation="1.5" result="b"/>
					<feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
				</filter>
			</defs>
			<!-- World map background -->
			<image href="/world-map.svg" x="0" y="50" width="2300" height="1500" opacity="0.75" preserveAspectRatio="xMidYMid meet"/>
			<g transform="translate({atlas.transform.x},{atlas.transform.y}) scale({atlas.transform.scale})">
				<!-- Starfield -->
				{#each [45,123,234,367,489,521,648,712,834,956,1067,1178,1289,1345,1423,1567,1689,1789,1867,1934,201,302,412,534,645,756,867,978,1089,1190,1312,1456,1578,1645,1723,1823,1912,1978,2034,2112,2156,2234] as sx, si}
					<circle cx={sx} cy={[89,178,267,356,445,89,134,223,312,401,490,579,89,134,223,312,401,490,579,668,757,89,134,223,312,401,490,579,668,757,89,134,223,312,401,490,579,668,757,89,134,223][si] % 1600} r={[0.8,1.2,0.6,1.0,0.7,1.1,0.9,0.6,1.3,0.8,0.7,1.0,0.9,1.1,0.6,0.8,1.2,0.7,1.0,0.6,0.8,0.9,1.1,0.7,1.0,0.8,0.6,1.2,0.9,0.7,1.0,0.8,0.6,1.1,0.9,0.7,1.0,0.8,1.2,0.6,0.9,0.7][si]} fill="#cdd6f4" opacity={[0.15,0.25,0.10,0.20,0.12,0.18,0.22,0.08,0.30,0.15,0.12,0.20,0.18,0.25,0.10,0.15,0.22,0.12,0.18,0.08,0.15,0.20,0.25,0.10,0.18,0.15,0.08,0.22,0.18,0.12,0.20,0.15,0.10,0.25,0.18,0.12,0.20,0.15,0.22,0.08,0.18,0.12][si]}/>
				{/each}

				<!-- Sun corona glow -->
				<circle cx={atlas.data.CX} cy={atlas.data.CY} r="380" fill="url(#asg)"/>

				<!-- Planetary orbit rings -->
				{#each atlas.data.planets as planet}
					<circle cx={atlas.data.CX} cy={atlas.data.CY} r={planet.orbitR}
						fill="none" stroke={atlasNodeColor(planet.type)}
						stroke-width="1" stroke-opacity="0.07" stroke-dasharray="4,14"/>
				{/each}

				<!-- Data flow particles (animated with SVG animateMotion) -->
				{#each [['database','memory-hub','#cba6f7',6],['memory-hub','autodev','#f38ba8',8],['database','dream-cycle','#f9e2af',7]] as hw, hi}
					{@const pa = atlas.data.planets.find(p => p.id === hw[0])}
					{@const pb = atlas.data.planets.find(p => p.id === hw[1])}
					{#if pa && pb}
						{@const pax = atlas.data.CX + pa.orbitR * Math.cos((pa.baseAngle + pa.orbitSpeed * atlas.elapsed) * Math.PI / 180)}
						{@const pay = atlas.data.CY + pa.orbitR * Math.sin((pa.baseAngle + pa.orbitSpeed * atlas.elapsed) * Math.PI / 180)}
						{@const pbx = atlas.data.CX + pb.orbitR * Math.cos((pb.baseAngle + pb.orbitSpeed * atlas.elapsed) * Math.PI / 180)}
						{@const pby = atlas.data.CY + pb.orbitR * Math.sin((pb.baseAngle + pb.orbitSpeed * atlas.elapsed) * Math.PI / 180)}
						<line x1={pax} y1={pay} x2={pbx} y2={pby} stroke={hw[2]} stroke-width="1" stroke-opacity="0.08"/>
						<circle r="4" fill={hw[2]} opacity="0.5" filter="url(#ag2)">
							<animateMotion dur="{hw[3]}s" repeatCount="indefinite"
								path="M{pax},{pay} L{pbx},{pby}"/>
						</circle>
					{/if}
				{/each}

				<!-- PLANETS + MOONS -->
				{#each atlas.data.planets as planet}
					{@const pAngle = (planet.baseAngle + planet.orbitSpeed * atlas.elapsed) * Math.PI / 180}
					{@const px = atlas.data.CX + planet.orbitR * Math.cos(pAngle)}
					{@const py = atlas.data.CY + planet.orbitR * Math.sin(pAngle)}
					{@const pColor = atlasNodeColor(planet.type)}
					{@const pStatus = atlas.data.ss(planet.id)}
					{@const pSelOrHov = atlas.selected === planet.id || atlas.hovered === planet.id}

					{#if planet.moonR > 0}
						<circle cx={px} cy={py} r={planet.moonR}
							fill="none" stroke={pColor}
							stroke-width="0.5" stroke-opacity="0.08" stroke-dasharray="2,6"/>
					{/if}

					{#each planet.moons as moon}
						{@const mAngle = (moon.baseAngle + planet.moonSpeed * atlas.elapsed) * Math.PI / 180}
						{@const mx = px + planet.moonR * Math.cos(mAngle)}
						{@const my = py + planet.moonR * Math.sin(mAngle)}
						{@const mColor = atlasNodeColor(moon.type)}
						{@const mStatus = atlas.data.ss(moon.id)}
						{@const mSel = atlas.selected === moon.id}
						{@const mHov = atlas.hovered === moon.id}
						<g class="atlas-node"
							onpointerenter={() => { atlas.hovered = moon.id; }}
							onpointerleave={() => { atlas.hovered = null; }}
							onclick={() => { atlas.selected = atlas.selected === moon.id ? null : moon.id; }}
							style="cursor:pointer"
						>
							<rect x={mx - 52} y={my - 16} width="104" height="32" rx="6"
								fill={mSel || mHov ? '#1a1a24' : '#0c0c12dd'}
								stroke={mSel ? mColor : mHov ? '#45475a' : mColor + '25'}
								stroke-width={mSel ? 1.8 : 0.8}
								filter={mSel ? 'url(#ag2)' : ''}
							/>
							{#if mStatus !== 'unknown'}
								<circle cx={mx - 40} cy={my - 3} r="3.5"
									fill={mStatus === 'up' ? '#a6e3a1' : mStatus === 'down' ? '#f38ba8' : '#f9e2af'}/>
							{/if}
							<text x={mx - 30} y={my + 2} fill="#cdd6f4" font-size="10" font-weight="600">{moon.label.length > 12 ? moon.label.slice(0,11)+'..' : moon.label}</text>
							{#if atlas.data.rv(moon.id)}
								<text x={mx - 42} y={my + 13} fill={mColor + '88'} font-size="8" font-family="monospace">{atlas.data.rv(moon.id)}</text>
							{/if}
						</g>
					{/each}

					<!-- Planet body -->
					{@const pr = planet.moons.length > 3 ? 40 : 34}
					<g class="atlas-node"
						onpointerenter={() => { atlas.hovered = planet.id; }}
						onpointerleave={() => { atlas.hovered = null; }}
						onclick={() => { atlas.selected = atlas.selected === planet.id ? null : planet.id; }}
						style="cursor:pointer"
					>
						<circle cx={px} cy={py} r={pr}
							fill="#0c0c12"
							stroke={pSelOrHov ? pColor : pColor + '30'}
							stroke-width={pSelOrHov ? 2.2 : 1.5}
							filter={pSelOrHov ? 'url(#ag2)' : ''}
						/>
						{#if pStatus !== 'unknown'}
							<circle cx={px} cy={py - pr + 8} r="4.5"
								fill={pStatus === 'up' ? '#a6e3a1' : pStatus === 'down' ? '#f38ba8' : '#f9e2af'}/>
						{/if}
						<text x={px} y={py + 4} fill="#cdd6f4" font-size="11" font-weight="700" text-anchor="middle">{planet.label.length > 10 ? planet.label.slice(0,9)+'..' : planet.label}</text>
						{#if atlas.data.rv(planet.id)}
							<text x={px} y={py + 17} fill={pColor + '99'} font-size="8" font-family="monospace" text-anchor="middle">{atlas.data.rv(planet.id)}</text>
						{/if}
					</g>
				{/each}

				<!-- DEVICES — outer belt at fixed angle arc -->
				{#each atlas.data.devNodes as devNode, di}
					{@const devAngle = (devNode.baseAngle + 0.04 * atlas.elapsed) * Math.PI / 180}
					{@const dR = 1100}
					{@const dx = atlas.data.CX + dR * Math.cos(devAngle)}
					{@const dy = atlas.data.CY + dR * Math.sin(devAngle)}
					{@const dColor = atlasNodeColor('device')}
					{@const dSel = atlas.selected === devNode.id}
					{@const dHov = atlas.hovered === devNode.id}
					<g class="atlas-node"
						onpointerenter={() => { atlas.hovered = devNode.id; }}
						onpointerleave={() => { atlas.hovered = null; }}
						onclick={() => { atlas.selected = atlas.selected === devNode.id ? null : devNode.id; if (dSel) { setLeftSection('devices'); atlas.selected = null; } }}
						style="cursor:pointer"
					>
						<rect x={dx - 55} y={dy - 17} width="110" height="34" rx="7"
							fill={dSel || dHov ? '#1a1a24' : '#0c0c12dd'}
							stroke={dSel ? dColor : dHov ? '#45475a' : dColor + '30'}
							stroke-width={dSel ? 2 : 1}
							filter={dSel ? 'url(#ag2)' : ''}
						/>
						<circle cx={dx - 42} cy={dy} r="4"
							fill={devNode.status === 'up' ? '#a6e3a1' : '#6c7086'}/>
						<text x={dx - 32} y={dy + 4} fill="#cdd6f4" font-size="10.5" font-weight="600">{devNode.label.length > 12 ? devNode.label.slice(0,11)+'..' : devNode.label}</text>
					</g>
				{/each}

				<!-- PROJECTS — outermost, gravitating near Forge -->
				{#each atlas.data.projs as proj, pi}
					{@const projAngle = (proj.baseAngle + 0.03 * atlas.elapsed) * Math.PI / 180}
					{@const projR = 1250 + pi * 60}
					{@const prjx = atlas.data.CX + projR * Math.cos(projAngle)}
					{@const prjy = atlas.data.CY + projR * Math.sin(projAngle)}
					{@const pjColor = atlasNodeColor('project')}
					{@const pjSel = atlas.selected === proj.id}
					{@const pjHov = atlas.hovered === proj.id}
					<g class="atlas-node"
						onpointerenter={() => { atlas.hovered = proj.id; }}
						onpointerleave={() => { atlas.hovered = null; }}
						onclick={() => { atlas.selected = atlas.selected === proj.id ? null : proj.id; }}
						style="cursor:pointer"
					>
						<rect x={prjx - 58} y={prjy - 15} width="116" height="30" rx="6"
							fill={pjSel || pjHov ? '#1a1a24' : '#0c0c12bb'}
							stroke={pjSel ? pjColor : pjHov ? '#45475a' : pjColor + '20'}
							stroke-width={pjSel ? 2 : 0.8}
							stroke-dasharray={pjSel ? 'none' : '3,3'}
						/>
						<text x={prjx} y={prjy + 4} fill={pjColor + 'bb'} font-size="10" font-weight="500" text-anchor="middle">{proj.label.length > 15 ? proj.label.slice(0,14)+'..' : proj.label}</text>
					</g>
				{/each}

				<!-- SUN (PAN Server) -->
				<g class="atlas-node"
					onpointerenter={() => { atlas.hovered = 'pan-server'; }}
					onpointerleave={() => { atlas.hovered = null; }}
					onclick={() => { atlas.selected = atlas.selected === 'pan-server' ? null : 'pan-server'; }}
					style="cursor:pointer"
				>
					<circle cx={atlas.data.CX} cy={atlas.data.CY} r="72"
						fill="#090912" stroke={atlas.selected === 'pan-server' ? '#89b4fa' : '#89b4fa30'}
						stroke-width={atlas.selected === 'pan-server' ? 3 : 1.5} filter="url(#ag)"/>
					<text x={atlas.data.CX} y={atlas.data.CY - 14} fill="#89b4fa" font-size="32" font-weight="700" text-anchor="middle" font-family="serif">Π</text>
					<text x={atlas.data.CX} y={atlas.data.CY + 12} fill="#cdd6f4" font-size="12" font-weight="600" text-anchor="middle">PAN Server</text>
					{#if atlas.data.stats}
						<text x={atlas.data.CX} y={atlas.data.CY + 28} fill="#89b4fa99" font-size="9" text-anchor="middle" font-family="monospace">{(atlas.data.stats.total_events/1000).toFixed(1)}K events</text>
					{/if}
				</g>

				<text x={atlas.data.CX + 1050} y={atlas.data.CY - 20} fill="#89b4fa18" font-size="11" font-weight="700" letter-spacing="3" text-anchor="middle">DEVICES</text>
				<text x={atlas.data.CX} y={atlas.data.CY - 1050} fill="#cba6f718" font-size="11" font-weight="700" letter-spacing="3" text-anchor="middle">MEMORY</text>
			</g>
		</svg>

		<!-- Detail panel -->
		{#if atlas.selected}
			{@const selPlanet = atlas.data.planets.find(p => p.id === atlas.selected)}
			{@const selMoon = atlas.data.planets.flatMap(p => p.moons).find(m => m.id === atlas.selected)}
			{@const selDev = atlas.data.devNodes.find(d => d.id === atlas.selected)}
			{@const selProj = atlas.data.projs.find(p => p.id === atlas.selected)}
			{@const selAny = selPlanet || selMoon || selDev || selProj || (atlas.selected === 'pan-server' ? { label: 'PAN Server', type: 'core' } : null)}
			{#if selAny}
				<div class="atlas-detail">
					<div class="atlas-detail-header">
						<span class="atlas-detail-dot" style="background:{atlasNodeColor(selAny.type)}"></span>
						<strong>{selAny.label}</strong>
						<span class="atlas-detail-type" style="color:{atlasNodeColor(selAny.type)}">{selAny.type}</span>
						<button class="atlas-detail-close" onclick={() => { atlas.selected = null; }}>&times;</button>
					</div>
					<div class="atlas-detail-body">
						{#if selPlanet || selMoon}
							{@const sid = selAny.id}
							{@const status = atlas.data.ss(sid)}
							<div class="atlas-detail-status">
								<span class="atlas-detail-status-dot" style="background:{status === 'up' ? '#a6e3a1' : status === 'down' ? '#f38ba8' : '#6c7086'}"></span>
								{status === 'up' ? 'Running' : status === 'down' ? 'Offline' : status === 'idle' ? 'Idle' : 'Unknown'}
							</div>
							{#if atlas.data.sd(sid)}<div class="atlas-detail-info">{atlas.data.sd(sid)}</div>{/if}
							{#if atlas.data.rv(sid)}<div class="atlas-detail-info">{atlas.data.rv(sid)}</div>{/if}
							{#if selPlanet && selPlanet.moons.length > 0}
								<div class="atlas-detail-section-title">Moons ({selPlanet.moons.length})</div>
								{#each selPlanet.moons as moon}
									<button class="atlas-detail-conn" onclick={() => { atlas.selected = moon.id; }}>
										<span class="atlas-detail-conn-dot" style="background:{atlas.data.ss(moon.id) === 'up' ? '#a6e3a1' : '#6c7086'}"></span>
										<span class="atlas-detail-conn-name">{moon.label}</span>
									</button>
								{/each}
							{/if}
						{:else if selDev}
							<div class="atlas-detail-status">
								<span class="atlas-detail-status-dot" style="background:{selDev.status === 'up' ? '#a6e3a1' : '#6c7086'}"></span>
								{selDev.status === 'up' ? 'Online' : 'Offline'}
							</div>
							<button class="atlas-nav-btn" onclick={() => { setLeftSection('devices'); atlas.selected = null; }}>Go to Devices &rarr;</button>
						{:else if selProj}
							<button class="atlas-nav-btn" onclick={() => { setLeftSection('projects'); atlas.selected = null; }}>Go to Projects &rarr;</button>
						{:else}
							<div class="atlas-detail-info">Central server. Port 7777.</div>
							{#if atlas.data.stats}<div class="atlas-detail-info">{atlas.data.stats.total_events} events · {atlas.data.stats.total_sessions} sessions</div>{/if}
						{/if}
					</div>
				</div>
			{/if}
		{/if}
	{:else}
		<div class="term-empty">
			<div class="term-empty-icon">&#x1F5FA;</div>
			<div class="term-empty-title">Atlas</div>
			<div class="term-empty-sub">System orrery</div>
		</div>
	{/if}
</div>
