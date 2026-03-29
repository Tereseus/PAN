<script>
	import { api } from '$lib/api.js';

	let devices = $state([]);
	let selectedDeviceId = $state('');
	let sensors = $state([]);
	let loading = $state(true);
	let expandedSensorId = $state(null);
	let pollInterval = $state(null);
	let lastSensorJson = $state('');

	async function loadDevices() {
		try {
			const res = await api('/api/v1/devices/list');
			const list = res.devices || res || [];
			devices = list;
			if (list.length > 0 && !selectedDeviceId) {
				selectedDeviceId = String(list[0].id);
				await loadSensors();
			}
		} catch { devices = []; }
		loading = false;
	}

	async function loadSensors() {
		if (!selectedDeviceId) {
			sensors = [];
			return;
		}
		try {
			const data = await api(`/api/sensors/devices/${selectedDeviceId}`);
			if (data.error) { sensors = []; return; }
			const newSensors = data.sensors || [];
			const newJson = JSON.stringify(newSensors.map(s => ({ id: s.id, enabled: s.enabled, muted: s.muted, policy: s.policy, attachments: s.attachments })));
			if (newJson === lastSensorJson) return;
			lastSensorJson = newJson;
			sensors = newSensors;
		} catch { sensors = []; }
	}

	async function toggleSensor(sensorId, enabled) {
		try {
			await api(`/api/sensors/devices/${selectedDeviceId}/${sensorId}`, {
				method: 'PUT',
				body: JSON.stringify({ enabled })
			});
			lastSensorJson = '';
			await loadSensors();
		} catch {}
	}

	async function toggleAttachment(sensorId, attachId, checked) {
		try {
			await api(`/api/sensors/devices/${selectedDeviceId}/${sensorId}`, {
				method: 'PUT',
				body: JSON.stringify({ attach: { [attachId]: checked } })
			});
			lastSensorJson = '';
			await loadSensors();
		} catch {}
	}

	function toggleExpand(sensorId) {
		expandedSensorId = expandedSensorId === sensorId ? null : sensorId;
		lastSensorJson = '';
		loadSensors();
	}

	function onDeviceChange(e) {
		selectedDeviceId = e.target.value;
		lastSensorJson = '';
		expandedSensorId = null;
		loadSensors();
	}

	$effect(() => {
		loadDevices();
		const iv = setInterval(loadSensors, 5000);
		return () => clearInterval(iv);
	});
</script>

<div class="sensors-page">
	<div class="sensors-header">
		<h2>Sensors</h2>
		<select class="device-select" value={selectedDeviceId} onchange={onDeviceChange}>
			<option value="">Select Device...</option>
			{#each devices as d}
				<option value={String(d.id)}>{d.name || d.hostname}</option>
			{/each}
		</select>
	</div>

	{#if loading}
		<div class="muted">Loading...</div>
	{:else if !selectedDeviceId}
		<div class="muted">Select a device to configure sensors.</div>
	{:else if sensors.length === 0}
		<div class="muted">No sensors found for this device.</div>
	{:else}
		<div class="sensor-grid">
			{#each sensors as s}
				{@const isOn = s.enabled}
				{@const isExpanded = expandedSensorId === s.id}
				{@const isLocked = s.locked}
				<div
					class="sensor-card"
					class:on={isOn}
					onclick={() => toggleExpand(s.id)}
				>
					<div class="sensor-main">
						<span class="sensor-icon">{s.icon}</span>
						<div class="sensor-info">
							<div class="sensor-name-row">
								<span class="sensor-name">{s.name}</span>
								{#if isLocked}
									<span class="policy-badge" title={s.policy_reason || s.policy}>
										{s.policy === 'force_on' ? 'Required' : 'Disabled'}
									</span>
								{/if}
							</div>
							<div class="sensor-desc">{s.description}</div>
						</div>

						{#if isLocked}
							<div
								class="toggle-track locked"
								class:on={isOn}
								title={s.policy_reason || 'Locked by organization policy'}
							>
								<div class="toggle-knob" class:on={isOn}></div>
							</div>
						{:else}
							<div
								class="toggle-track"
								class:on={isOn}
								onclick={(e) => { e.stopPropagation(); toggleSensor(s.id, !isOn); }}
							>
								<div class="toggle-knob" class:on={isOn}></div>
							</div>
						{/if}
					</div>

					<!-- Attachments (expanded + on) -->
					{#if isExpanded && isOn}
						{@const others = sensors.filter(o => o.id !== s.id && o.enabled)}
						<div class="attachments" onclick={(e) => e.stopPropagation()}>
							<div class="attach-label">When {s.name} captures, also attach:</div>
							{#if others.length > 0}
								<div class="attach-grid">
									{#each others as o}
										{@const attached = s.attachments?.[o.id] || false}
										<label class="attach-item">
											<input
												type="checkbox"
												checked={attached}
												onchange={(e) => toggleAttachment(s.id, o.id, e.target.checked)}
											/>
											{o.icon} {o.name}
										</label>
									{/each}
								</div>
							{:else}
								<div class="muted-sm">Turn on other sensors to attach their data.</div>
							{/if}
						</div>
					{/if}
				</div>
			{/each}
		</div>
	{/if}
</div>

<style>
	.sensors-page {
		padding: 24px;
		overflow-y: auto;
		height: 100%;
	}

	.sensors-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 16px;
		flex-wrap: wrap;
		gap: 12px;
	}

	h2 {
		font-size: 18px;
		font-weight: 600;
		color: #cdd6f4;
		margin: 0;
	}

	.device-select {
		background: #12121a;
		color: #cdd6f4;
		border: 1px solid #1e1e2e;
		border-radius: 6px;
		padding: 6px 12px;
		font-size: 13px;
		font-family: 'Inter', sans-serif;
		outline: none;
	}

	.device-select:focus { border-color: #89b4fa; }

	.muted { color: #6c7086; font-size: 14px; padding: 16px; }
	.muted-sm { color: #6c7086; font-size: 11px; }

	.sensor-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
		gap: 12px;
	}

	.sensor-card {
		background: #12121a;
		border: 1px solid #1e1e2e;
		border-radius: 8px;
		padding: 12px;
		opacity: 0.5;
		cursor: pointer;
		transition: all 0.15s;
	}

	.sensor-card.on {
		opacity: 1;
		border-color: rgba(166, 227, 161, 0.25);
	}

	.sensor-card:hover { border-color: #89b4fa; }

	.sensor-main {
		display: flex;
		align-items: center;
		gap: 10px;
	}

	.sensor-icon { font-size: 22px; flex-shrink: 0; }

	.sensor-info { flex: 1; min-width: 0; }

	.sensor-name-row {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.sensor-name { font-weight: 600; font-size: 14px; color: #cdd6f4; }

	.policy-badge {
		font-size: 9px;
		color: #f9e2af;
		padding: 1px 4px;
		border-radius: 3px;
		background: rgba(249, 226, 175, 0.1);
	}

	.sensor-desc {
		font-size: 11px;
		color: #6c7086;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	/* Toggle track */
	.toggle-track {
		width: 40px;
		height: 22px;
		border-radius: 11px;
		background: #484f58;
		position: relative;
		cursor: pointer;
		transition: background 0.2s;
		flex-shrink: 0;
	}

	.toggle-track.on { background: #a6e3a1; }
	.toggle-track.locked { opacity: 0.5; cursor: not-allowed; }

	.toggle-knob {
		width: 18px;
		height: 18px;
		border-radius: 50%;
		background: #fff;
		position: absolute;
		top: 2px;
		left: 2px;
		transition: transform 0.2s;
		box-shadow: 0 1px 3px rgba(0,0,0,0.3);
	}

	.toggle-knob.on { transform: translateX(18px); }

	/* Attachments */
	.attachments {
		border-top: 1px solid #1e1e2e;
		padding-top: 8px;
		margin-top: 8px;
	}

	.attach-label {
		font-size: 11px;
		color: #6c7086;
		margin-bottom: 6px;
		font-weight: 500;
	}

	.attach-grid {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 2px 12px;
		max-height: 140px;
		overflow-y: auto;
	}

	.attach-item {
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: 11px;
		color: #cdd6f4;
		cursor: pointer;
		padding: 2px 0;
	}

	.attach-item input { accent-color: #89b4fa; cursor: pointer; }
</style>
