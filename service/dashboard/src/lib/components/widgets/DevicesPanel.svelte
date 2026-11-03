<!--
  DevicesPanel.svelte — extracted from terminal/+page.svelte (Shape-2 refactor).

  Renders the Devices widget: pending pan-client approvals, then a filter bar
  (All / Computers / Phones / Pendants / Other), then category-grouped device
  rows with expandable detail + per-device CPU/RAM/disk metric bars.

  Reads from `$lib/stores/devices.svelte.js` directly — no props. AppsPanel
  reads the same store so both widgets stay in sync without prop drilling.
  Approval actions call `approveClient` / `denyClient` from the same store.

  Only internal state is the local filter pill choice + the per-row expand set
  (which device cards are open to show capabilities + last-seen).
-->
<script>
	// 2026-05-28: migrated to read from `devices` store directly + call
	// approveClient/denyClient from the store. No prop drilling.
	import { devices, approveClient, denyClient } from '$lib/stores/devices.svelte.js';

	let deviceFilter = $state('all'); // 'all' | 'computers' | 'phones' | 'pendants' | 'other'
	let deviceExpandedIds = $state(new Set());

	function devCatOf(d) {
		if (d.device_type === 'pc') return 'computers';
		if (d.device_type === 'phone') return 'phones';
		if (d.device_type === 'pendant') return 'pendants';
		return 'other';
	}

	const catCounts = $derived(devices.all.reduce((acc, d) => { const c = devCatOf(d); acc[c] = (acc[c]||0)+1; return acc; }, {}));
	const filteredDevices = $derived(deviceFilter === 'all' ? devices.all : devices.all.filter(d => devCatOf(d) === deviceFilter));
	const pendingClients = $derived(devices.panClients.filter(d => d.trusted === false));
	const categories = $derived(deviceFilter === 'all'
		? [['computers','Computers','#89b4fa'],['phones','Phones','#fab387'],['pendants','Pendants','#cba6f7'],['other','Other','#6c7086']]
		: [[deviceFilter, deviceFilter.charAt(0).toUpperCase()+deviceFilter.slice(1), '#89b4fa']]);
</script>

{#if pendingClients.length > 0}
	<div class="svc-category" style="color:#f38ba8">⚠ Pending Approval</div>
	{#each pendingClients as device}
		<div class="svc-row" style="background:rgba(243,139,168,0.08);border-radius:6px;padding:4px 6px;margin-bottom:4px">
			<span class="svc-dot unknown"></span>
			<div class="svc-info" style="flex:1">
				<div class="svc-name">{device.name || device.device_id}</div>
				<div class="svc-detail">{device.platform || 'unknown'} — waiting for approval</div>
			</div>
			<div style="display:flex;gap:4px;flex-shrink:0">
				<button class="approval-btn approve" onclick={() => approveClient(device.device_id)} title="Approve">✓</button>
				<button class="approval-btn deny" onclick={() => denyClient(device.device_id)} title="Deny">✕</button>
			</div>
		</div>
	{/each}
{/if}

{#if devices.all.length > 0}
	<div style="display:flex;gap:4px;align-items:center;padding:4px 0 6px 0;flex-wrap:wrap">
		{#each [['all','All'], ['computers','Computers'], ['phones','Phones'], ['pendants','Pendants'], ['other','Other']] as [val, label]}
			{@const count = val === 'all' ? devices.all.length : (catCounts[val] || 0)}
			{#if count > 0 || val === 'all'}
				<button
					onclick={() => deviceFilter = val}
					style="font-size:10px;padding:2px 7px;border-radius:10px;border:1px solid {deviceFilter===val ? '#89b4fa' : 'rgba(255,255,255,0.1)'};background:{deviceFilter===val ? 'rgba(137,180,250,0.15)' : 'transparent'};color:{deviceFilter===val ? '#89b4fa' : '#6c7086'};cursor:pointer;white-space:nowrap"
				>{label}{count > 0 ? ` · ${count}` : ''}</button>
			{/if}
		{/each}
	</div>
	{#each categories as [catKey, catLabel, catColor]}
		{@const catDevs = filteredDevices.filter(d => devCatOf(d) === catKey)}
		{#if catDevs.length > 0}
			<div class="svc-category" style="color:{catColor};margin-top:6px">{catLabel} · {catDevs.length}</div>
			{#each catDevs as dev}
				{@const STALE = dev.device_type === 'phone' ? 30 * 60 * 1000 : 5 * 60 * 1000}
				{@const ageMs = dev.last_seen ? Date.now() - new Date(dev.last_seen).getTime() : Infinity}
				{@const isOnline = dev.online === 1 && ageMs < STALE}
				{@const isHub = dev.is_hub === true}
				{@const isPanClient = !!dev.client_version}
				{@const ageStr = ageMs < 60000 ? 'just now' : ageMs < 3600000 ? Math.round(ageMs/60000)+'m ago' : ageMs < 86400000 ? Math.round(ageMs/3600000)+'h ago' : Math.round(ageMs/86400000)+'d ago'}
				{@const metrics = devices.metrics[dev.hostname] || devices.metrics[dev.name] || null}
				{@const caps = Array.isArray(dev.capabilities) ? dev.capabilities : (typeof dev.capabilities === 'string' ? JSON.parse(dev.capabilities || '[]') : [])}
				{@const isExpanded = deviceExpandedIds.has(dev.hostname)}
				<div class="svc-row" style="flex-direction:column;align-items:stretch;gap:0;padding:3px 0">
					<div style="display:flex;align-items:center;gap:6px;cursor:pointer" onclick={() => { const s = new Set(deviceExpandedIds); s.has(dev.hostname) ? s.delete(dev.hostname) : s.add(dev.hostname); deviceExpandedIds = s; }}>
						<span class="svc-dot" class:up={isOnline} class:down={!isOnline}></span>
						<div style="flex:1;min-width:0">
							<div class="svc-name" style="display:flex;align-items:center;gap:4px">
								{dev.name || dev.hostname}
								{#if isHub}<span style="font-size:9px;background:#89b4fa22;color:#89b4fa;padding:1px 4px;border-radius:3px;font-weight:600">HUB</span>{/if}
								{#if isPanClient && !isHub}<span style="font-size:9px;background:#a6e3a122;color:#a6e3a1;padding:1px 4px;border-radius:3px;font-weight:600">CLIENT</span>{/if}
								{#if isPanClient && !isHub && dev.service_state}
									{@const _ssLabel = dev.service_state === 'system' ? 'BOOT' : dev.service_state === 'user' ? 'LOGIN' : 'AD-HOC'}
									{@const _ssColor = dev.service_state === 'system' ? '#a6e3a1' : dev.service_state === 'user' ? '#f9e2af' : '#fab387'}
									{@const _ssTip = dev.service_state === 'system' ? 'Windows Service (starts at boot)' : dev.service_state === 'user' ? 'Scheduled Task (starts at user login)' : 'Ad-hoc start — no persistent service registered (pre-#497 install). Re-install client to upgrade.'}
									<span style="font-size:9px;background:{_ssColor}22;color:{_ssColor};padding:1px 4px;border-radius:3px;font-weight:600;border:1px solid {_ssColor}44" title="{_ssTip} · Manager: {dev.service_manager || 'unknown'}{dev.service_installed_at ? ' · since ' + dev.service_installed_at : ''}">{_ssLabel}</span>
								{/if}
							</div>
							{#if dev.hostname !== dev.name}<div style="font-size:9px;color:#585b70;margin-top:1px">{dev.hostname} · {dev.device_type}</div>{/if}
						</div>
						<div style="display:flex;align-items:center;gap:4px">
							{#if metrics}<span style="font-size:9px;background:#cba6f722;color:#cba6f7;padding:1px 4px;border-radius:3px">📊</span>{/if}
							<div class="svc-detail" title={isOnline ? 'pan-client heartbeating' : 'pan-client process not heartbeating (machine may still be reachable via Tailscale)'}>{isOnline ? 'Client online' : 'Client offline'} · {ageStr}</div>
							<span style="font-size:10px;color:#585b70;transition:transform 0.15s;display:inline-block;transform:rotate({isExpanded?'90deg':'0deg'})">&rsaquo;</span>
						</div>
					</div>
					{#if isExpanded}
						<div style="padding:6px 0 4px 16px;border-left:1px solid #313244;margin-left:5px;margin-top:4px">
							<div style="font-size:9px;color:#6c7086;margin-bottom:4px">
								<span style="color:#cdd6f4">Hostname:</span> {dev.hostname}
								&nbsp;·&nbsp;<span style="color:#cdd6f4">Type:</span> {dev.device_type}
								{#if dev.tailscale_hostname}&nbsp;·&nbsp;<span style="color:#cdd6f4">Tailscale:</span> {dev.tailscale_hostname}{/if}
								{#if dev.service_state}
									<br><span style="color:#cdd6f4">Service:</span> {dev.service_state === 'system' ? 'system (boot-time, Windows Service)' : dev.service_state === 'user' ? 'user-session (login-time, Scheduled Task)' : 'ad-hoc (no persistent service — pre-#497 install)'} via {dev.service_manager || '—'}{dev.service_installed_at ? ` · installed ${dev.service_installed_at}` : ''}
								{/if}
							</div>
							{#if caps.length > 0}
								<div style="font-size:9px;color:#6c7086;margin-bottom:3px"><span style="color:#cdd6f4">Capabilities:</span></div>
								<div style="display:flex;flex-wrap:wrap;gap:3px">
									{#each caps as cap}
										<span style="font-size:9px;padding:1px 5px;border-radius:3px;background:{cap.startsWith('app:') ? '#a6e3a122' : '#89b4fa11'};color:{cap.startsWith('app:') ? '#a6e3a1' : '#89b4fa'};border:1px solid {cap.startsWith('app:') ? '#a6e3a133' : '#89b4fa22'}">{cap.startsWith('app:') ? cap.slice(4) : cap}</span>
									{/each}
								</div>
							{/if}
							{#if dev.last_seen}<div style="font-size:9px;color:#585b70;margin-top:4px">Last seen: {dev.last_seen}</div>{/if}
						</div>
					{/if}
					{#if metrics}
						{@const cpuColor = (metrics.cpu_pct||0) > 85 ? '#f38ba8' : (metrics.cpu_pct||0) > 60 ? '#fab387' : '#a6e3a1'}
						{@const ramColor = (metrics.ram_pct||0) > 85 ? '#f38ba8' : (metrics.ram_pct||0) > 70 ? '#fab387' : '#89b4fa'}
						<div style="display:grid;grid-template-columns:1fr 1fr;gap:4px;margin-top:4px;padding-left:16px">
							<div>
								<div style="display:flex;justify-content:space-between;font-size:9px;color:#6c7086;margin-bottom:1px">
									<span>CPU</span><span style="color:{cpuColor}">{Math.round(metrics.cpu_pct||0)}%</span>
								</div>
								<div style="height:3px;background:#313244;border-radius:2px">
									<div style="height:100%;width:{Math.min(metrics.cpu_pct||0,100)}%;background:{cpuColor};border-radius:2px;transition:width 0.5s"></div>
								</div>
							</div>
							<div>
								<div style="display:flex;justify-content:space-between;font-size:9px;color:#6c7086;margin-bottom:1px">
									<span>RAM</span>
									<span style="color:{ramColor}">
										{#if metrics.ram_used_mb && metrics.ram_total_mb}
											{metrics.ram_used_mb > 1024 ? (metrics.ram_used_mb/1024).toFixed(1)+'G' : metrics.ram_used_mb+'M'}/{metrics.ram_total_mb > 1024 ? (metrics.ram_total_mb/1024).toFixed(1)+'G' : metrics.ram_total_mb+'M'}
										{:else}{Math.round(metrics.ram_pct||0)}%{/if}
									</span>
								</div>
								<div style="height:3px;background:#313244;border-radius:2px">
									<div style="height:100%;width:{Math.min(metrics.ram_pct||0,100)}%;background:{ramColor};border-radius:2px;transition:width 0.5s"></div>
								</div>
							</div>
							{#if metrics.disk_pct != null}
								{@const diskColor = (metrics.disk_pct||0) > 90 ? '#f38ba8' : (metrics.disk_pct||0) > 75 ? '#fab387' : '#6c7086'}
								<div style="grid-column:1/-1">
									<div style="display:flex;justify-content:space-between;font-size:9px;color:#6c7086;margin-bottom:1px">
										<span>Disk</span>
										<span style="color:{diskColor}">{Math.round(metrics.disk_pct||0)}%{metrics.disk_free_gb != null ? ` · ${metrics.disk_free_gb.toFixed(0)}G free` : ''}</span>
									</div>
									<div style="height:3px;background:#313244;border-radius:2px">
										<div style="height:100%;width:{Math.min(metrics.disk_pct||0,100)}%;background:{diskColor};border-radius:2px;transition:width 0.5s"></div>
									</div>
								</div>
							{/if}
						</div>
					{/if}
				</div>
			{/each}
		{/if}
	{/each}
{:else}
	<div class="empty-state small">No devices registered</div>
{/if}
