<!--
  AppsPanel.svelte — Device-first app grid. Root view shows utility buttons
  (Atlas, Kronos) plus a per-device list of detected app capabilities; clicking
  a device drills into a detail view with installed apps + extra capabilities +
  web wrappers (PAN Wrap services).

  Parent owns allDevices (loaded by startAllDevicesPolling); we receive it as
  a prop. Wrap-services + appsView are internal to this component.
-->
<script>
	// 2026-05-28: migrated to read `devices.all` from store. No props.
	import { devices } from '$lib/stores/devices.svelte.js';
	const allDevices = $derived(devices.all);

	let wrapServices = $state([]);
	let wrapOpening = $state(null);
	let wrapMsg = $state('');
	let appsView = $state('root');

	const APP_META = {
		vlc:      { label: 'VLC',        cat: 'Media',    icon: '🎬' },
		mpv:      { label: 'MPV',        cat: 'Media',    icon: '▶️' },
		spotify:  { label: 'Spotify',    cat: 'Media',    icon: '🎵' },
		chrome:   { label: 'Chrome',     cat: 'Browser',  icon: '🌐' },
		firefox:  { label: 'Firefox',    cat: 'Browser',  icon: '🦊' },
		discord:  { label: 'Discord',    cat: 'Comms',    icon: '💬' },
		obs:      { label: 'OBS',        cat: 'Creative', icon: '📺' },
		steam:    { label: 'Steam',      cat: 'Gaming',   icon: '🎮' },
		code:     { label: 'VS Code',    cat: 'Dev',      icon: '💻' },
		'windows-media-player': { label: 'Windows Media', cat: 'Media', icon: '🎞️' },
		rustdesk: { label: 'RustDesk',   cat: 'Remote',   icon: '🖥️' },
	};

	async function loadWrapServices() {
		try {
			const res = await fetch(`${window.location.origin}/api/v1/wrap/services`);
			if (res.ok) {
				const data = await res.json();
				wrapServices = data.services || [];
			}
		} catch (e) { console.error('[PAN Wrap] services load failed:', e); }
	}

	async function openWrapper(serviceId) {
		wrapOpening = serviceId;
		wrapMsg = '';
		try {
			const res = await fetch(`${window.location.origin}/api/v1/wrap/open/${serviceId}`, { method: 'POST' });
			const data = await res.json();
			if (!res.ok || !data.ok) wrapMsg = data.error || 'Failed to open wrapper';
			else wrapMsg = `Opened ${serviceId}`;
		} catch (e) {
			wrapMsg = e.message || 'Failed to open wrapper';
		} finally {
			wrapOpening = null;
			setTimeout(() => { wrapMsg = ''; }, 3000);
		}
	}
</script>

{#if appsView.startsWith('device:')}
	{@const devHostname = appsView.slice(7)}
	{@const dev = allDevices.find(d => d.hostname === devHostname)}
	{@const devCaps = dev ? (Array.isArray(dev.capabilities) ? dev.capabilities : (typeof dev.capabilities === 'string' ? JSON.parse(dev.capabilities || '[]') : [])) : []}
	{@const devAppKeys = devCaps.filter(c => c.startsWith('app:')).map(c => c.slice(4))}
	{@const devOtherCaps = devCaps.filter(c => !c.startsWith('app:'))}
	<div class="apps-drilldown">
		<button class="apps-back-btn" onclick={() => { appsView = 'root'; }}>← Devices</button>
		<div style="padding:8px 12px 4px">
			<div style="display:flex;align-items:center;gap:7px;margin-bottom:10px">
				<span class="svc-dot {dev?.online ? 'up' : ''}"></span>
				<span style="font-size:13px;font-weight:700;color:#eee">{dev?.name || devHostname}</span>
				<span style="font-size:9px;opacity:.45;margin-left:auto">{dev?.device_type || 'pc'}</span>
			</div>
			{#if devAppKeys.length > 0}
				<div class="apps-cat-label">Installed Apps</div>
				<div class="apps-grid">
					{#each devAppKeys as appKey}
						{@const meta = APP_META[appKey]}
						<div class="app-card" style="opacity:{dev?.online ? 1 : 0.55}">
							<div class="app-icon">{meta?.icon || '📦'}</div>
							<div class="app-name">{meta?.label || appKey}</div>
						</div>
					{/each}
				</div>
			{/if}
			{#if devOtherCaps.length > 0}
				<div class="apps-cat-label" style="margin-top:8px">Capabilities</div>
				<div style="display:flex;gap:4px;flex-wrap:wrap;padding-bottom:8px">
					{#each devOtherCaps as cap}
						<span style="font-size:9px;background:rgba(255,255,255,.07);border-radius:3px;padding:2px 6px;color:#bbb">{cap}</span>
					{/each}
				</div>
			{/if}
			{#if devAppKeys.length === 0 && devOtherCaps.length === 0}
				<div style="font-size:10px;opacity:.45;padding:8px 0">No capabilities detected yet.</div>
			{/if}
		</div>
		{#if wrapServices.length > 0}
			<div class="apps-cat-label" style="margin-top:4px">Web Apps</div>
			<div class="apps-grid" style="padding:0 8px 8px">
				{#each wrapServices as svc}
					<button class="app-card" disabled={wrapOpening === svc.id} onclick={() => openWrapper(svc.id)}>
						<div class="app-icon"><img src="https://www.google.com/s2/favicons?domain={svc.url ? svc.url.replace(/^https?:\/\//, '').split('/')[0] : ''}&sz=32" alt="🪟" style="width:24px;height:24px;border-radius:4px" onerror={(e) => { e.target.style.display = 'none'; }} /></div>
						<div class="app-name">{svc.title || svc.id}</div>
						<div class="app-desc">{wrapOpening === svc.id ? 'Opening...' : svc.has_module ? 'Module' : 'Web'}</div>
					</button>
				{/each}
			</div>
		{/if}
	</div>
{:else}
	<div style="display:flex;gap:5px;padding:6px 8px 0;flex-wrap:wrap">
		<button class="app-card" style="flex:1;min-width:60px;max-width:90px" onclick={() => {
			fetch('/api/v1/ui-commands', { method:'POST', headers:{'Content-Type':'application/json'},
			body: JSON.stringify({ type:'open_window', url:`${window.location.origin}/v2/atlas-v2`, title:'Atlas', width:1400, height:900 }) });
		}}>
			<div class="app-icon">
				<img src="/atlas-icon.png" width="36" height="36" style="object-fit:cover;border-radius:4px;" alt="Atlas"/>
			</div>
			<div class="app-name">Atlas</div>
		</button>
		<button class="app-card" style="flex:1;min-width:60px;max-width:90px" onclick={() => {
			fetch('/api/v1/ui-commands', { method:'POST', headers:{'Content-Type':'application/json'},
			body: JSON.stringify({ type:'open_window', url:`${window.location.origin}/v2/kronos`, title:'Kronos', width:1200, height:800 }) });
		}}>
			<div class="app-icon">📜</div>
			<div class="app-name">Kronos</div>
		</button>
	</div>
	<div style="padding:6px 8px 0">
		{#each allDevices as dev}
			{@const devCaps = Array.isArray(dev.capabilities) ? dev.capabilities : (typeof dev.capabilities === 'string' ? JSON.parse(dev.capabilities || '[]') : [])}
			{@const devAppKeys = devCaps.filter(c => c.startsWith('app:')).map(c => c.slice(4))}
			{@const devOtherCaps = devCaps.filter(c => !c.startsWith('app:'))}
			<button onclick={() => { appsView = 'device:' + dev.hostname; loadWrapServices(); }}
				style="width:100%;text-align:left;background:none;border:none;border-bottom:1px solid rgba(255,255,255,.06);padding:7px 0;cursor:pointer">
				<div style="display:flex;align-items:center;gap:6px;margin-bottom:5px">
					<span class="svc-dot {dev.online ? 'up' : ''}"></span>
					<span style="font-size:11px;font-weight:600;color:#e0e0e0">{dev.name || dev.hostname}</span>
					<span style="font-size:9px;opacity:.4;margin-left:auto">{dev.device_type || 'pc'}</span>
				</div>
				{#if devAppKeys.length > 0}
					<div style="display:flex;gap:5px;flex-wrap:wrap;padding-left:16px">
						{#each devAppKeys as appKey}
							{@const meta = APP_META[appKey]}
							<span title="{meta?.label || appKey}" style="font-size:15px;opacity:{dev.online ? 1 : 0.45}">{meta?.icon || '📦'}</span>
						{/each}
					</div>
				{:else if devOtherCaps.length > 0}
					<div style="padding-left:16px;font-size:9px;opacity:.35;line-height:1.4">{devOtherCaps.slice(0,4).join(' · ')}</div>
				{/if}
			</button>
		{/each}
		{#if allDevices.length === 0}
			<div style="padding:16px 0;text-align:center;font-size:10px;opacity:.4">No devices found</div>
		{/if}
	</div>
{/if}
{#if wrapMsg}
	<div style="padding:4px 8px;font-size:10px;color:#a6e3a1">{wrapMsg}</div>
{/if}
