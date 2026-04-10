<script>
	import { api } from '$lib/api.js';

	let activeTab = $state('general');
	let settings = $state({});
	let health = $state(null);
	let devices = $state([]);
	let projects = $state([]);
	let sessions = $state([]);
	let users = $state([]);
	let authProviders = $state({});
	let authMode = $state('none');
	let tailscaleStatus = $state(null);
	let treasurySettings = $state({});
	let statusMsg = $state('');
	let voiceKeyCapturing = $state(false);
	let usageToday = $state('--');
	let usageWeek = $state('--');
	let usageAllTime = $state('--');
	let usageBreakdown = $state([]);
	let customModels = $state([]);
	let jobModels = $state({});
	let deviceSettings = $state({});

	// Add model form
	let newModelName = $state('');
	let newModelType = $state('');
	let newModelUrl = $state('');
	let newModelId = $state('');
	let newModelKey = $state('');

	// Password
	let pwCurrent = $state('');
	let pwNew = $state('');

	// Terminal appearance — persisted in localStorage, read on mount
	const TERM_DEFAULTS = {
		username: 'Tereseus',
		llmName: 'Claude',
		userColor: '#89b4fa',  // blue
		userTextColor: '',     // empty = auto-derive (lighter shade of name color)
		llmColor: '#fab387',   // orange
		llmTextColor: '',      // empty = auto-derive
		toolColor: '#f9e2af',
		bgColor: '#11111b',
	};
	const TERM_KEY_MAP = {
		username: 'pan_username',
		llmName: 'pan_llm_name',
		userColor: 'pan_term_user_color',
		userTextColor: 'pan_term_user_text_color',
		llmColor: 'pan_term_llm_color',
		llmTextColor: 'pan_term_llm_text_color',
		toolColor: 'pan_term_tool_color',
		bgColor: 'pan_term_bg_color',
	};
	let termSettings = $state({ ...TERM_DEFAULTS });
	// Branding — logo image (data URL) or text, shown in sidebar + loading screen
	let brandingLogo = $state('ΠΑΝ');
	let brandingImage = $state('');
	if (typeof localStorage !== 'undefined') {
		for (const [field, key] of Object.entries(TERM_KEY_MAP)) {
			const v = localStorage.getItem(key);
			if (v) termSettings[field] = v;
		}
		const bl = localStorage.getItem('pan_branding_logo');
		if (bl) brandingLogo = bl;
		const bi = localStorage.getItem('pan_branding_image');
		if (bi) brandingImage = bi;
	}
	function updateBrandingLogo(value) {
		brandingLogo = value;
		localStorage.setItem('pan_branding_logo', value);
		fireBrandingChange();
	}
	function updateBrandingImage(dataUrl) {
		brandingImage = dataUrl;
		if (dataUrl) {
			localStorage.setItem('pan_branding_image', dataUrl);
		} else {
			localStorage.removeItem('pan_branding_image');
		}
		fireBrandingChange();
	}
	function fireBrandingChange() {
		window.dispatchEvent(new CustomEvent('pan-branding-changed', { detail: { logo: brandingLogo, image: brandingImage } }));
	}
	function handleLogoUpload(e) {
		const file = e.target.files?.[0];
		if (!file) return;
		if (file.size > 512 * 1024) { statusMsg = 'Logo too large (max 512KB)'; return; }
		const reader = new FileReader();
		reader.onload = () => updateBrandingImage(reader.result);
		reader.readAsDataURL(file);
	}
	function clearLogoImage() {
		updateBrandingImage('');
	}
	function updateTermSetting(key, value) {
		localStorage.setItem(key, value);
		// Update local reactive state so the color inputs stay in sync
		for (const [field, mapped] of Object.entries(TERM_KEY_MAP)) {
			if (mapped === key) { termSettings[field] = value; break; }
		}
		// Notify the terminal page to re-render
		window.dispatchEvent(new CustomEvent('pan-terminal-settings-changed'));
	}
	function resetTermSettings() {
		for (const [field, key] of Object.entries(TERM_KEY_MAP)) {
			localStorage.setItem(key, TERM_DEFAULTS[field]);
			termSettings[field] = TERM_DEFAULTS[field];
		}
		window.dispatchEvent(new CustomEvent('pan-terminal-settings-changed'));
	}

	// Rename device
	let renameDeviceId = $state(null);
	let renameDeviceName = $state('');

	// Device expand/remove
	let expandedDeviceId = $state(null);
	let confirmRemoveDeviceId = $state(null);

	const tabs = [
		{ id: 'general', label: 'General' },
		{ id: 'ai', label: 'AI & Usage' },
		{ id: 'controls', label: 'Controls' },
		{ id: 'devices', label: 'Devices' },
		{ id: 'security', label: 'Security' },
		{ id: 'auth', label: 'Authentication' },
		{ id: 'users', label: 'Users' },
		{ id: 'network', label: 'Remote Access' },
		{ id: 'treasury', label: 'Treasury' },
	];

	const jobDefs = [
		{ key: 'router', name: 'Ferry', tech: 'Router', desc: 'Voice command classification + response' },
		{ key: 'scout', name: 'Scout', tech: 'Scout', desc: 'Discovers new tools & CLIs' },
		{ key: 'dream', name: 'Dream', tech: 'Dream', desc: 'Consolidates memories into state file' },
		{ key: 'autodev', name: 'Forge', tech: 'AutoDev', desc: 'Automated development tasks' },
		{ key: 'classifier', name: 'Augur', tech: 'Classifier', desc: 'Extracts memories from events' },
		{ key: 'recall', name: 'Remembrance', tech: 'Recall', desc: 'On-demand memory search' },
		{ key: 'vision', name: 'Vision', tech: 'Vision', desc: 'Photo/image analysis' },
	];

	function fmtTime(ts) {
		if (!ts) return '--';
		const d = new Date(ts);
		return d.toLocaleString();
	}

	function isRecent(ts) {
		if (!ts) return false;
		return Date.now() - new Date(ts).getTime() < 5 * 60 * 1000;
	}

	function flash(msg) {
		statusMsg = msg;
		setTimeout(() => { statusMsg = ''; }, 3000);
	}

	async function loadHealth() {
		try {
			const res = await fetch(window.location.origin + '/health');
			health = await res.json();
		} catch { health = null; }
	}

	async function loadSettings() {
		try {
			const s = await api('/api/v1/settings');
			settings = s;
			customModels = s.custom_models || [];
			jobModels = s.job_models || {};
			treasurySettings = {
				wallet: s.treasury_wallet_address || '',
				panBalance: s.treasury_pan_balance || '0',
				adaBalance: s.treasury_ada_balance || '0',
				dataScore: s.treasury_data_score || '--',
				dataCategories: s.treasury_data_categories || '--',
				totalEarned: s.treasury_total_earned || '--',
				dataStaking: s.data_staking === 'true',
				anonLevel: s.anon_level || 'standard',
			};
			authMode = s.auth_mode || 'none';
		} catch { /* empty */ }
	}

	async function loadDevices() {
		try {
			const d = await api('/dashboard/api/devices');
			devices = Array.isArray(d) ? d : (d.devices || []);
			// Load per-device settings
			for (const dev of devices) {
				try {
					const ds = await api(`/api/v1/devices/${dev.id}/settings`);
					deviceSettings[dev.id] = ds;
				} catch { /* ignore */ }
			}
			deviceSettings = { ...deviceSettings };
		} catch { /* empty */ }
	}

	async function loadProjects() {
		try { projects = await api('/dashboard/api/projects'); } catch { projects = []; }
	}

	async function loadSessions() {
		try {
			const s = await api('/dashboard/api/sessions');
			sessions = (Array.isArray(s) ? s : []).slice(0, 20);
		} catch { sessions = []; }
	}

	async function loadUsers() {
		try {
			const d = await api('/api/v1/auth/users');
			users = d.users || d || [];
		} catch { users = []; }
	}

	async function loadAuthProviders() {
		try {
			const d = await api('/api/v1/auth/providers');
			authProviders = d || {};
		} catch { /* empty */ }
	}

	async function loadTailscaleStatus() {
		try { tailscaleStatus = await api('/api/v1/tailscale/status'); }
		catch { tailscaleStatus = null; }
	}

	async function loadUsage() {
		try {
			const u = await api('/api/automation/usage');
			usageToday = u.today?.total_cost_cents != null ? `$${(u.today.total_cost_cents / 100).toFixed(2)}` : '--';
			usageWeek = u.week?.total_cost_cents != null ? `$${(u.week.total_cost_cents / 100).toFixed(2)}` : '--';
			usageAllTime = u.all_time?.total_cost_cents != null ? `$${(u.all_time.total_cost_cents / 100).toFixed(2)}` : '--';
			usageBreakdown = [];
		} catch { /* empty */ }
	}

	async function restartServer() {
		flash('Restarting server...');
		try {
			await api('/api/admin/restart?hard=true', { method: 'POST' });
		} catch {}
		// Poll for server to come back — retry every 2s for up to 60s
		flash('Waiting for server to restart...');
		let attempts = 0;
		const poll = setInterval(async () => {
			attempts++;
			try {
				const resp = await fetch('/dashboard/api/stats');
				if (resp.ok) {
					clearInterval(poll);
					flash('Server restarted successfully');
					setTimeout(() => location.reload(), 1000);
				}
			} catch {}
			if (attempts >= 30) {
				clearInterval(poll);
				flash('Server did not come back after 60s — check manually');
			}
		}, 2000);
	}

	async function saveSetting(key, value) {
		try {
			await api('/api/v1/settings', {
				method: 'PUT',
				body: JSON.stringify({ [key]: value })
			});
			flash('Saved');
			await loadSettings();
		} catch { flash('Save failed'); }
	}

	async function saveAIModel(val) {
		await saveSetting('ai_model', val);
	}

	async function saveTerminalAI() {
		const payload = {
			terminal_ai_provider: settings.terminal_ai_provider || 'claude',
			terminal_ai_model: settings.terminal_ai_model || '',
			terminal_ai_cmd: settings.terminal_ai_cmd || '',
		};
		try {
			await api('/api/v1/settings', { method: 'PUT', body: JSON.stringify(payload) });
			flash('Terminal AI saved');
		} catch { flash('Save failed'); }
	}

	async function saveJobModel(key, val) {
		const updated = { ...jobModels, [key]: val };
		await saveSetting('job_models', updated);
	}

	async function addModelProvider() {
		if (!newModelName || !newModelId) { flash('Name and Model ID required'); return; }
		const model = {
			name: newModelName,
			provider: newModelType || 'openai-compat',
			url: newModelUrl,
			id: newModelId,
			key: newModelKey,
		};
		const updated = [...customModels, model];
		await saveSetting('custom_models', updated);
		newModelName = ''; newModelType = ''; newModelUrl = ''; newModelId = ''; newModelKey = '';
	}

	async function removeModelProvider(idx) {
		const updated = customModels.filter((_, i) => i !== idx);
		await saveSetting('custom_models', updated);
	}

	async function saveControlSetting(key, value) {
		await saveSetting('control_' + key, value);
	}

	function captureVoiceKey(e) {
		if (!voiceKeyCapturing) return;
		e.preventDefault();
		settings.control_voice_key = e.key;
		voiceKeyCapturing = false;
	}

	async function renameDevice() {
		if (!renameDeviceId || !renameDeviceName) return;
		try {
			await api(`/api/v1/devices/${renameDeviceId}/rename`, {
				method: 'PUT',
				body: JSON.stringify({ name: renameDeviceName })
			});
			flash('Device renamed');
			renameDeviceName = '';
			renameDeviceId = null;
			await loadDevices();
		} catch { flash('Rename failed'); }
	}

	async function removeDevice(deviceId) {
		try {
			await api(`/api/v1/devices/${deviceId}`, { method: 'DELETE' });
			flash('Device removed');
			confirmRemoveDeviceId = null;
			expandedDeviceId = null;
			await loadDevices();
		} catch { flash('Remove failed'); }
	}

	async function toggleDeviceRemoteAccess(deviceId, enabled) {
		try {
			await api(`/api/v1/devices/${deviceId}/settings`, {
				method: 'PUT',
				body: JSON.stringify({ remote_access_enabled: enabled })
			});
		} catch {
			// Revert on failure
			deviceSettings[deviceId] = { ...deviceSettings[deviceId], remote_access_enabled: !enabled };
			deviceSettings = { ...deviceSettings };
		}
	}

	async function changePassword() {
		if (!pwNew) { flash('Enter a new password'); return; }
		try {
			await api('/api/v1/auth/password', {
				method: 'PUT',
				body: JSON.stringify({ current: pwCurrent, new_password: pwNew })
			});
			flash('Password changed');
			pwCurrent = ''; pwNew = '';
		} catch { flash('Password change failed'); }
	}

	async function saveAuthMode(mode) {
		await saveSetting('auth_mode', mode);
	}

	async function saveOAuthProviders() {
		try {
			await api('/api/v1/auth/providers', {
				method: 'POST',
				body: JSON.stringify(authProviders)
			});
			flash('OAuth settings saved');
		} catch { flash('Save failed'); }
	}

	async function changeUserRole(userId, role) {
		try {
			await api(`/api/v1/auth/users/${userId}/role`, {
				method: 'PUT',
				body: JSON.stringify({ role })
			});
			flash('Role updated');
			await loadUsers();
		} catch { flash('Role update failed'); }
	}

	async function toggleTailscale() {
		try {
			await api('/api/v1/tailscale/toggle', { method: 'POST' });
			flash('Toggled');
			setTimeout(loadTailscaleStatus, 2000);
		} catch { flash('Toggle failed'); }
	}

	async function installRemoteAccess() {
		try {
			await api('/api/v1/tailscale/install', { method: 'POST' });
			flash('Installing...');
			setTimeout(loadTailscaleStatus, 5000);
		} catch { flash('Install failed'); }
	}

	async function toggleDataStaking(enabled) {
		await saveSetting('data_staking', String(enabled));
	}

	async function setAnonLevel(level) {
		await saveSetting('anon_level', level);
	}

	async function createTreasuryWallet() {
		try {
			const data = await api('/api/v1/treasury/wallet', { method: 'POST' });
			if (data.address) {
				await saveSetting('treasury_wallet_address', data.address);
			}
		} catch { flash('Wallet creation failed'); }
	}

	async function connectExternalWallet() {
		const addr = prompt('Enter your Cardano wallet address (addr1...):');
		if (addr && addr.startsWith('addr')) {
			await saveSetting('treasury_wallet_address', addr);
		}
	}

	function copyWalletAddress() {
		if (treasurySettings.wallet) {
			navigator.clipboard.writeText(treasurySettings.wallet);
			flash('Copied');
		}
	}

	async function toggleScrubMode(enabled) {
		await saveSetting('scrub_mode', String(enabled));
	}

	async function toggleVoicePermApproval(enabled) {
		await saveSetting('voice_permission_approval', String(enabled));
	}

	$effect(() => {
		loadHealth();
		loadSettings();
		loadDevices();
		loadProjects();
		loadSessions();
		loadUsers();
		loadAuthProviders();
		loadTailscaleStatus();
		loadUsage();
	});
</script>

<svelte:window onkeydown={captureVoiceKey} />

<div class="settings-layout">
	<aside class="nav">
		{#each tabs as tab}
			<button
				class="nav-item"
				class:active={activeTab === tab.id}
				onclick={() => activeTab = tab.id}
			>
				{tab.label}
			</button>
		{/each}
	</aside>

	<div class="panel">
		{#if statusMsg}
			<div class="toast">{statusMsg}</div>
		{/if}

		<!-- General -->
		{#if activeTab === 'general'}
			<h2>General</h2>

			<section class="section">
				<h3>Server Health</h3>
				{#if health}
					<div class="row">
						<span class="label">Status</span>
						<span class="value"><span class="dot online"></span> Running</span>
					</div>
					<div class="row">
						<span class="label">Server Time</span>
						<span class="value">{fmtTime(health.timestamp)}</span>
					</div>
					<div class="row">
						<span class="label">Uptime</span>
						<span class="value">{health.uptime || 'Running'}</span>
					</div>
				{:else}
					<div class="row">
						<span class="label">Status</span>
						<span class="value"><span class="dot offline"></span> Offline</span>
					</div>
				{/if}
				<div style="margin-top:10px">
					<button class="btn warn" onclick={restartServer}>Restart Server</button>
				</div>
			</section>

			<section class="section">
				<h3>Scrub Mode</h3>
				<div class="toggle-row">
					<label class="toggle">
						<input type="checkbox" checked={settings.scrub_mode === 'true'} onchange={(e) => toggleScrubMode(e.target.checked)} />
						<span class="slider"></span>
					</label>
					<span>Enable Scrub Mode</span>
				</div>
				<p class="hint">When enabled, PAN adds extra confirmations before destructive actions and explains technical concepts in plain language.</p>
			</section>

			<section class="section">
				<h3>Personality</h3>
				<p class="hint">Describe how PAN should talk. Examples: "Talk like Morgan Freeman — calm, wise, measured", "Be sarcastic and witty like Tony Stark", "Speak with a British butler's formality", "Be enthusiastic and energetic like a sports commentator"</p>
				<textarea
					class="personality-input"
					value={settings.personality || ''}
					placeholder="Leave empty for default PAN personality..."
					oninput={(e) => { settings.personality = e.target.value; }}
					rows="3"
				></textarea>
				<button class="btn" onclick={async () => {
					await fetch('/api/v1/settings', {
						method: 'PUT',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({ personality: settings.personality || '' })
					});
					statusMsg = 'Personality saved';
					setTimeout(() => statusMsg = '', 2000);
				}}>Save Personality</button>
			</section>

			<section class="section">
				<h3>Branding</h3>
				<p class="hint">Upload a logo image, or set text. Image takes priority — clear the image to use text instead.</p>
				<div class="row">
					<span class="label">Logo Image</span>
					<div style="display:flex; align-items:center; gap:8px;">
						<input type="file" accept="image/*" onchange={handleLogoUpload} style="font-size:12px; color:#cdd6f4;" />
						{#if brandingImage}
							<button class="btn warn" style="font-size:11px; padding:3px 8px;" onclick={clearLogoImage}>Clear</button>
						{/if}
					</div>
				</div>
				<div class="row">
					<span class="label">Logo Text (Fallback)</span>
					<input type="text" class="term-input" value={brandingLogo} oninput={(e) => updateBrandingLogo(e.target.value)} placeholder="ΠΑΝ" />
				</div>
				<div class="row">
					<span class="label">Preview</span>
					<div style="display:flex; align-items:center; gap:12px; background:#0a0a0f; padding:12px 20px; border-radius:8px;">
						{#if brandingImage}
							<img src={brandingImage} alt="Logo" style="max-height:48px; max-width:120px; object-fit:contain;" />
						{:else}
							<span style="font-family: serif; font-size: 32px; font-weight: 700; color: #89b4fa;">{brandingLogo || 'ΠΑΝ'}</span>
						{/if}
					</div>
				</div>
			</section>

			<section class="section">
				<h3>Terminal Appearance</h3>
				<p class="hint">Customize your name, LLM name, and terminal colors. Changes apply immediately to the terminal view.</p>
				<div class="row">
					<span class="label">Your Name</span>
					<input type="text" class="term-input" value={termSettings.username} oninput={(e) => updateTermSetting('pan_username', e.target.value)} placeholder="Tereseus" />
				</div>
				<div class="row">
					<span class="label">LLM Name</span>
					<input type="text" class="term-input" value={termSettings.llmName} oninput={(e) => updateTermSetting('pan_llm_name', e.target.value)} placeholder="Claude" />
				</div>
				<div class="row">
					<span class="label">Your Prompt Color</span>
					<input type="color" value={termSettings.userColor} oninput={(e) => updateTermSetting('pan_term_user_color', e.target.value)} />
				</div>
				<div class="row">
					<span class="label">Your Text Color</span>
					<input type="color" value={termSettings.userTextColor} oninput={(e) => updateTermSetting('pan_term_user_text_color', e.target.value)} />
				</div>
				<div class="row">
					<span class="label">LLM Prompt Color</span>
					<input type="color" value={termSettings.llmColor} oninput={(e) => updateTermSetting('pan_term_llm_color', e.target.value)} />
				</div>
				<div class="row">
					<span class="label">LLM Text Color</span>
					<input type="color" value={termSettings.llmTextColor} oninput={(e) => updateTermSetting('pan_term_llm_text_color', e.target.value)} />
				</div>
				<div class="row">
					<span class="label">Tool Call Color</span>
					<input type="color" value={termSettings.toolColor} oninput={(e) => updateTermSetting('pan_term_tool_color', e.target.value)} />
				</div>
				<div class="row">
					<span class="label">Background Color</span>
					<input type="color" value={termSettings.bgColor} oninput={(e) => updateTermSetting('pan_term_bg_color', e.target.value)} />
				</div>
				<div style="margin-top:10px">
					<button class="btn" onclick={resetTermSettings}>Reset to Defaults</button>
				</div>
			</section>

			<section class="section">
				<h3>Projects</h3>
				{#if projects.length}
					{#each projects as p}
						<div class="row">
							<div>
								<div class="fw500">{p.name}</div>
								<div class="small muted">{p.path}</div>
							</div>
							<span class="small muted">{fmtTime(p.updated_at || p.created_at)}</span>
						</div>
					{/each}
				{:else}
					<span class="muted">No projects found</span>
				{/if}
			</section>

			<section class="section">
				<h3>Recent Sessions</h3>
				{#if sessions.length}
					{#each sessions as s}
						<div class="row">
							<div>
								<div class="small">{s.id?.slice(0, 20)}...</div>
								<div class="small muted">{s.cwd} {s.model ? '| ' + s.model : ''}</div>
							</div>
							<div style="text-align:right">
								<div class="small muted">{fmtTime(s.started_at)}</div>
								<div class="small" style="color:{s.ended_at ? '#a6e3a1' : '#f9e2af'}">{s.ended_at ? 'Ended' : 'Active'}</div>
							</div>
						</div>
					{/each}
				{:else}
					<span class="muted">No sessions found</span>
				{/if}
			</section>
		{/if}

		<!-- AI & Usage -->
		{#if activeTab === 'ai'}
			<h2>AI & Usage</h2>

			<section class="section">
				<h3>Terminal AI</h3>
				<p class="hint">The AI that runs in your terminal sessions. PAN launches this when you open project tabs.</p>
				<div class="form-grid">
					<div class="form-row">
						<div class="form-label">
							<div class="fw500">CLI Provider</div>
							<div class="small muted">Type a provider name or pick from suggestions</div>
						</div>
						<input type="text" bind:value={settings.terminal_ai_provider} onchange={saveTerminalAI} placeholder="e.g. claude, gemini, aider..." class="input" />
					</div>
					<div class="form-row">
						<div class="form-label">
							<div class="fw500">Terminal Model</div>
							<div class="small muted">Model override passed to the CLI via --model</div>
						</div>
						<input type="text" bind:value={settings.terminal_ai_model} onchange={saveTerminalAI} placeholder="e.g. sonnet, opus, pro..." class="input" />
					</div>
					<div class="form-row" style="flex-direction:column;align-items:stretch">
						<div class="form-label">
							<div class="fw500">Full CLI Command <span class="small muted">(optional -- overrides provider + model above)</span></div>
						</div>
						<input type="text" bind:value={settings.terminal_ai_cmd} onchange={saveTerminalAI} placeholder="e.g. gemini --model pro, aider --model gpt-4o" class="input mono" style="width:100%" />
						<div class="small muted" style="margin-top:4px">Use {'{project}'} for project name, {'{path}'} for project path.</div>
					</div>
				</div>
			</section>

			<section class="section">
				<h3>Server API Model</h3>
				<p class="hint">The model PAN uses for its own API calls -- voice routing, background jobs, phone queries.</p>
				<div class="form-row">
					<div class="form-label">
						<div class="fw500">Default API Model</div>
					</div>
					<input type="text" value={settings.ai_model || ''} onchange={(e) => saveAIModel(e.target.value)} placeholder="e.g. claude-haiku-4-5-20251001" class="input" style="width:260px" />
				</div>
			</section>

			<section class="section">
				<h3>Phone AI (Gemini Flash)</h3>
				<p class="hint">Gemini Flash handles complex voice commands directly from the phone with sub-second latency. Free tier: 1,500 requests/day.</p>
				<div class="form-row">
					<div class="form-label">
						<div class="fw500">Gemini API Key</div>
						<div class="small muted">Get free from aistudio.google.com/apikey</div>
					</div>
					<input type="password" value={settings.gemini_api_key || ''} onchange={(e) => saveSetting('gemini_api_key', e.target.value)} placeholder="AIza..." class="input" style="width:260px" />
				</div>
			</section>

			<section class="section">
				<h3>Job Models</h3>
				<p class="hint">Each background job can use a different model. Leave empty to use the default above.</p>
				<div class="form-grid">
					{#each jobDefs as j}
						<div class="form-row">
							<div class="form-label">
								<div class="fw500">{j.name}</div>
								<div class="small muted">{j.desc}</div>
							</div>
							<input type="text" value={jobModels[j.key] || ''} onchange={(e) => saveJobModel(j.key, e.target.value)} placeholder="Use Default" class="input" style="width:180px" />
						</div>
					{/each}
				</div>
			</section>

			<section class="section">
				<h3>Model Providers</h3>
				<p class="hint">Add models here and they appear as suggestions everywhere. For local models, PAN routes API calls to their endpoints.</p>
				{#if customModels.length}
					<div class="form-grid" style="margin-bottom:12px">
						{#each customModels as m, i}
							<div class="model-card">
								<div style="flex:1">
									<div class="fw500">{m.name}</div>
									<div class="small muted">{m.provider || 'openai-compat'} {m.url ? '| ' + m.url : ''} | {m.id}</div>
								</div>
								<button class="btn danger small" onclick={() => removeModelProvider(i)}>Remove</button>
							</div>
						{/each}
					</div>
				{:else}
					<p class="muted small" style="margin-bottom:12px">No custom models added.</p>
				{/if}
				<details class="add-model-details">
					<summary>Add Model</summary>
					<div class="add-model-form">
						<div style="display:flex;gap:8px;flex-wrap:wrap">
							<input type="text" bind:value={newModelName} placeholder="Display name (e.g. Llama 3.2 8B)" class="input" style="flex:1;min-width:180px" />
							<input type="text" bind:value={newModelType} placeholder="Provider type (e.g. ollama, lmstudio)" class="input" style="flex:0 0 200px" />
						</div>
						<div style="display:flex;gap:8px;flex-wrap:wrap">
							<input type="text" bind:value={newModelUrl} placeholder="Base URL (e.g. http://localhost:11434)" class="input" style="flex:1;min-width:200px" />
							<input type="text" bind:value={newModelId} placeholder="Model ID (e.g. llama3.2:8b)" class="input" style="flex:1;min-width:150px" />
						</div>
						<div style="display:flex;gap:8px;flex-wrap:wrap">
							<input type="password" bind:value={newModelKey} placeholder="API key (optional for local)" class="input" style="flex:1;min-width:200px" />
							<button class="btn accent" onclick={addModelProvider}>Add Model</button>
						</div>
					</div>
				</details>
			</section>

			<section class="section">
				<h3>Usage</h3>
				<div class="stat-row">
					<div class="stat-card">
						<div class="stat-value">{usageToday}</div>
						<div class="stat-label">Today</div>
					</div>
					<div class="stat-card">
						<div class="stat-value">{usageWeek}</div>
						<div class="stat-label">This Week</div>
					</div>
					<div class="stat-card">
						<div class="stat-value">{usageAllTime}</div>
						<div class="stat-label">All Time</div>
					</div>
				</div>
			</section>

			{#if usageBreakdown.length}
				<section class="section">
					<h3>Cost by Feature (Today)</h3>
					<div class="form-grid">
						{#each usageBreakdown as item}
							<div class="row">
								<span class="fw500">{item.caller || item.feature || 'Unknown'}</span>
								<span class="muted">{item.cost || '--'}</span>
							</div>
						{/each}
					</div>
				</section>
			{/if}
		{/if}

		<!-- Controls -->
		{#if activeTab === 'controls'}
			<h2>Controls</h2>

			<section class="section">
				<h3>Voice-to-Text</h3>
				<p class="hint">Press this key anywhere in the dashboard to start voice input. Speak, and your words go straight to the terminal.</p>
				<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
					<input
						type="text"
						value={settings.control_voice_key || ''}
						readonly
						placeholder="Click and press a key..."
						class="input"
						style="width:200px;text-align:center;font-weight:600;cursor:pointer"
						onfocus={() => voiceKeyCapturing = true}
						onblur={() => voiceKeyCapturing = false}
					/>
					<button class="btn accent" onclick={() => saveControlSetting('voice_key', settings.control_voice_key || '')}>Save</button>
					<button class="btn secondary" onclick={() => { settings.control_voice_key = ''; saveControlSetting('voice_key', ''); }}>Clear</button>
				</div>
				<p class="hint" style="margin-top:6px">Default: Win+H (Windows built-in voice typing)</p>
			</section>

			<section class="section">
				<h3>Screenshots</h3>
				<div class="hint">
					<div style="margin-bottom:6px"><kbd>Print Screen</kbd> -- capture screenshot</div>
					<div><kbd>Ctrl+V</kbd> -- paste into terminal chat</div>
				</div>
			</section>

			<section class="section">
				<h3>Voice Permission Approval</h3>
				<div class="toggle-row">
					<label class="toggle">
						<input type="checkbox" checked={settings.voice_permission_approval === 'true'} onchange={(e) => toggleVoicePermApproval(e.target.checked)} />
						<span class="slider"></span>
					</label>
					<span>Approve Permissions by Voice</span>
				</div>
				<p class="hint">When enabled, say "permission granted" to approve Claude's permission requests instead of tapping the notification.</p>
			</section>
		{/if}

		<!-- Devices -->
		{#if activeTab === 'devices'}
			<h2>Devices</h2>

			<section class="section">
				<h3>Connected Devices</h3>
				{#if devices.length}
					{#each devices as d}
						<div class="device-card" class:expanded={expandedDeviceId === d.id}>
							<div class="device-row">
								<div style="flex:1">
									<div class="fw500">
										{d.name || d.device_name || 'Unknown'}
										<span class="small muted">({d.hostname || ''})</span>
									</div>
									<div class="small muted">Type: {d.device_type || d.type || '--'} | Last seen: {fmtTime(d.last_seen)}</div>
								</div>
								<div style="display:flex;align-items:center;gap:10px">
									<span class="small muted">Remote Access</span>
									<label class="toggle">
										<input
											type="checkbox"
											checked={deviceSettings[d.id]?.remote_access_enabled || false}
											onchange={(e) => toggleDeviceRemoteAccess(d.id, e.target.checked)}
										/>
										<span class="slider"></span>
									</label>
									<span class="dot" class:online={isRecent(d.last_seen)} class:stale={!isRecent(d.last_seen)}></span>
									<button class="btn-icon" onclick={() => expandedDeviceId = expandedDeviceId === d.id ? null : d.id} title="More options">
										<span class="chevron" class:rotated={expandedDeviceId === d.id}>&#9656;</span>
									</button>
								</div>
							</div>
							{#if expandedDeviceId === d.id}
								<div class="device-options">
									<div class="device-option">
										<span class="small muted">ID: {d.id} | Hostname: {d.hostname}</span>
									</div>
									{#if confirmRemoveDeviceId === d.id}
										<div class="device-option danger-zone">
											<span class="small">Remove <strong>{d.name || d.hostname}</strong>? This revokes access and the device must re-register.</span>
											<div style="display:flex;gap:8px;margin-top:6px">
												<button class="btn danger" onclick={() => removeDevice(d.id)}>Confirm Remove</button>
												<button class="btn" onclick={() => confirmRemoveDeviceId = null}>Cancel</button>
											</div>
										</div>
									{:else}
										<div class="device-option">
											<button class="btn danger-outline" onclick={() => confirmRemoveDeviceId = d.id}>Remove Device</button>
										</div>
									{/if}
								</div>
							{/if}
						</div>
					{/each}
				{:else}
					<span class="muted">No devices registered</span>
				{/if}

				<div style="margin-top:12px;display:flex;gap:8px;align-items:center">
					<select class="input" bind:value={renameDeviceId} style="width:180px">
						<option value={null}>Select device...</option>
						{#each devices as d}
							<option value={d.id}>{d.name || d.device_name || d.hostname}</option>
						{/each}
					</select>
					<input type="text" bind:value={renameDeviceName} placeholder="New name..." class="input" style="width:180px" />
					<button class="btn accent" onclick={renameDevice}>Rename</button>
				</div>
			</section>
		{/if}

		<!-- Security -->
		{#if activeTab === 'security'}
			<h2>Security</h2>

			<section class="section">
				<h3>Change Password</h3>
				<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
					<input type="password" bind:value={pwCurrent} placeholder="Current password" class="input" style="width:160px" autocomplete="off" />
					<input type="password" bind:value={pwNew} placeholder="New password" class="input" style="width:160px" autocomplete="off" />
					<button class="btn accent" onclick={changePassword}>Change Password</button>
				</div>
				<p class="hint" style="margin-top:6px">Change your delete password above.</p>
			</section>
		{/if}

		<!-- Authentication -->
		{#if activeTab === 'auth'}
			<h2>Authentication</h2>

			<section class="section">
				<h3>Auth Mode</h3>
				<select class="input" style="width:320px" value={authMode} onchange={(e) => saveAuthMode(e.target.value)}>
					<option value="none">None (single user, no login required)</option>
					<option value="token">Token (multi-user, login required)</option>
				</select>
				<p class="hint" style="margin-top:4px">In "none" mode, the dashboard works without signing in. Switch to "token" when you're ready for multi-user.</p>
			</section>

			<section class="section">
				<h3>OAuth Providers</h3>
				<div class="oauth-grid">
					{#each ['google', 'microsoft', 'github', 'apple'] as provider}
						<div class="oauth-card">
							<div class="fw500" style="margin-bottom:8px;text-transform:capitalize">{provider}</div>
							{#if provider !== 'apple'}
								<input type="text" bind:value={authProviders[provider + '_client_id']} placeholder="{provider} Client ID" class="input mono" style="width:100%;margin-bottom:4px" />
								<input type="password" bind:value={authProviders[provider + '_client_secret']} placeholder="{provider} Client Secret" class="input mono" style="width:100%;margin-bottom:4px" />
							{:else}
								<input type="text" bind:value={authProviders.apple_services_id} placeholder="Apple Services ID" class="input mono" style="width:100%;margin-bottom:4px" />
							{/if}
							<div class="small muted">
								{#if provider === 'google'}Get from console.cloud.google.com
								{:else if provider === 'microsoft'}Get from portal.azure.com
								{:else if provider === 'github'}Get from github.com Settings > Developer Settings
								{:else}Requires Apple Developer account ($99/year)
								{/if}
							</div>
						</div>
					{/each}
				</div>
				<button class="btn accent" style="margin-top:12px" onclick={saveOAuthProviders}>Save OAuth Settings</button>
			</section>
		{/if}

		<!-- Users -->
		{#if activeTab === 'users'}
			<h2>Users</h2>

			<section class="section">
				<h3>User List</h3>
				{#if users.length}
					{#each users as u}
						<div class="row">
							<div style="flex:1">
								<div class="fw500">{u.display_name || u.email}</div>
								<div class="small muted">{u.email}</div>
							</div>
							<div style="display:flex;align-items:center;gap:8px">
								<select class="input small" value={u.role} onchange={(e) => changeUserRole(u.id, e.target.value)}>
									<option value="user">User</option>
									<option value="admin">Admin</option>
									<option value="owner">Owner</option>
								</select>
								{#if u.avatar_url}
									<img src={u.avatar_url} alt="" style="width:28px;height:28px;border-radius:50%" />
								{/if}
							</div>
						</div>
					{/each}
				{:else}
					<span class="muted">No users registered</span>
				{/if}
			</section>
		{/if}

		<!-- Remote Access -->
		{#if activeTab === 'network'}
			<h2>Remote Access</h2>

			<section class="section">
				<h3>Remote Access</h3>
				<p class="hint">Access PAN from anywhere, not just your home WiFi. One-click setup -- no technical knowledge needed.</p>

				<div class="status-box">
					<span class="dot" class:online={tailscaleStatus?.running} class:offline={tailscaleStatus && !tailscaleStatus.running}></span>
					<div style="flex:1">
						<div class="fw500">
							{#if tailscaleStatus?.running}
								Remote Access: Connected
							{:else if tailscaleStatus}
								Remote Access: Off
							{:else}
								Checking...
							{/if}
						</div>
						{#if tailscaleStatus?.hostname}
							<div class="small muted">{tailscaleStatus.hostname}</div>
						{/if}
					</div>
					{#if tailscaleStatus}
						<button class="btn accent" onclick={toggleTailscale}>
							{tailscaleStatus.running ? 'Disable' : 'Enable'}
						</button>
					{/if}
				</div>

				{#if tailscaleStatus && !tailscaleStatus.installed}
					<div class="warn-box">
						<div class="fw500">Remote Access: Not Set Up</div>
						<p class="hint">Enable remote access so you can reach PAN from anywhere -- your phone on cellular, a laptop at a coffee shop, or another network entirely.</p>
						<button class="btn accent" onclick={installRemoteAccess}>Enable Remote Access</button>
					</div>
				{/if}
			</section>

			<section class="section">
				<h3>Set Up Phone</h3>
				<p class="hint">Install the remote access app on your phone to connect from anywhere.</p>
				<a href="https://play.google.com/store/apps/details?id=com.tailscale.ipn" target="_blank" class="btn accent" style="text-decoration:none;display:inline-block">Set Up Phone</a>
			</section>

				<section class="section">
				<h3>Auto-Auth (Admin)</h3>
				<p class="hint">Add Tailscale OAuth credentials so new devices connect silently without a second login. Get these from the Tailscale admin console → Settings → OAuth clients.</p>
				<div class="form-row">
					<div class="form-label"><div class="fw500">OAuth Client ID</div></div>
					<input type="text" value={settings.tailscale_oauth_client_id || ''} onchange={(e) => saveSetting('tailscale_oauth_client_id', e.target.value)} placeholder="tskey-client-..." class="input mono" style="width:260px" />
				</div>
				<div class="form-row">
					<div class="form-label"><div class="fw500">OAuth Client Secret</div></div>
					<input type="password" value={settings.tailscale_oauth_client_secret || ''} onchange={(e) => saveSetting('tailscale_oauth_client_secret', e.target.value)} placeholder="tskey-client-secret-..." class="input mono" style="width:260px" />
				</div>
				<p class="hint" style="margin-top:4px">When set, new phones auto-join your Tailscale network after signing into PAN. No separate Tailscale login needed.</p>
			</section>

			<div style="text-align:center;padding-top:12px">
				<span class="small muted" style="opacity:0.6">Powered by Tailscale + WireGuard</span>
			</div>
		{/if}

		<!-- Treasury -->
		{#if activeTab === 'treasury'}
			<h2>Treasury</h2>

			<section class="section">
				<h3>Data Dividend</h3>
				<p class="hint">Stake your anonymized data to help improve AI. You earn PAN tokens when your data is purchased. All personal information is stripped on-device before anything leaves your machine.</p>
				<div class="toggle-row">
					<label class="toggle">
						<input type="checkbox" checked={treasurySettings.dataStaking} onchange={(e) => toggleDataStaking(e.target.checked)} />
						<span class="slider"></span>
					</label>
					<span>Enable Data Staking</span>
				</div>
				<p class="small muted" style="margin-top:4px">When enabled, anonymized data is contributed to the PAN network. You earn rewards proportional to your contribution.</p>
			</section>

			<section class="section">
				<h3>Wallet</h3>
				{#if treasurySettings.wallet}
					<div class="wallet-info">
						<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
							<span class="small muted" style="text-transform:uppercase;letter-spacing:0.5px">Wallet Address</span>
							<button class="btn secondary small" onclick={copyWalletAddress}>Copy</button>
						</div>
						<div class="mono accent" style="word-break:break-all;font-size:12px">{treasurySettings.wallet}</div>
					</div>
					<div class="stat-row" style="margin-top:12px">
						<div class="stat-card">
							<div class="stat-value accent">{treasurySettings.panBalance}</div>
							<div class="stat-label">PAN Balance</div>
						</div>
						<div class="stat-card">
							<div class="stat-value">{treasurySettings.adaBalance}</div>
							<div class="stat-label">ADA Balance</div>
						</div>
					</div>
				{:else}
					<p class="hint">Connect or create a Cardano wallet to receive your Data Dividend rewards.</p>
					<div style="display:flex;gap:8px">
						<button class="btn accent" onclick={createTreasuryWallet}>Create Wallet</button>
						<button class="btn secondary" onclick={connectExternalWallet}>Connect External Wallet</button>
					</div>
				{/if}
			</section>

			<section class="section">
				<h3>Contribution</h3>
				<div class="stat-row">
					<div class="stat-card">
						<div class="stat-value accent2">{treasurySettings.dataScore}</div>
						<div class="stat-label">Data Score</div>
					</div>
					<div class="stat-card">
						<div class="stat-value">{treasurySettings.dataCategories}</div>
						<div class="stat-label">Categories</div>
					</div>
					<div class="stat-card">
						<div class="stat-value accent">{treasurySettings.totalEarned}</div>
						<div class="stat-label">Total Earned</div>
					</div>
				</div>
			</section>

			<section class="section">
				<h3>Anonymization Level</h3>
				<p class="hint">Control how much data you share. Higher tiers earn more but share more detail. Your name, home address, and personal identifiers are ALWAYS stripped at every level. Data dividends are valid forever — as long as you generate data, you earn.</p>
				<div class="radio-group">
					<label class="radio-item" class:selected={treasurySettings.anonLevel === 'tier1'}>
						<input type="radio" name="anon-level" value="tier1" checked={treasurySettings.anonLevel === 'tier1'} onchange={() => setAnonLevel('tier1')} />
						<div style="flex:1">
							<div class="fw500">Tier 1 — Full Anonymize <span class="small muted">(safest)</span></div>
							<div class="small muted" style="margin-top:4px">All PII stripped. Conversations reduced to topics and sentiment only. Photos converted to text descriptions, faces blurred. GPS removed entirely.</div>
							<div class="small" style="margin-top:6px;color:var(--accent2)">Who buys this: AI companies training language models. They want conversation patterns, not your identity.</div>
							<div class="small" style="margin-top:2px;color:var(--accent)">Earnings: Base rate</div>
						</div>
					</label>
					<label class="radio-item" class:selected={treasurySettings.anonLevel === 'tier2'}>
						<input type="radio" name="anon-level" value="tier2" checked={treasurySettings.anonLevel === 'tier2'} onchange={() => setAnonLevel('tier2')} />
						<div style="flex:1">
							<div class="fw500">Tier 2 — Partial Anonymize</div>
							<div class="small muted" style="margin-top:4px">GPS rounded to city level. Timestamps rounded to hour. Conversations kept but names and specific references removed. Photos kept with faces blurred, EXIF stripped.</div>
							<div class="small" style="margin-top:6px;color:var(--accent2)">Who buys this: Urban planning, traffic analysis, retail analytics. They need location patterns but not your exact address.</div>
							<div class="small" style="margin-top:2px;color:var(--accent)">Earnings: ~3x base rate</div>
						</div>
					</label>
					<label class="radio-item" class:selected={treasurySettings.anonLevel === 'tier3'}>
						<input type="radio" name="anon-level" value="tier3" checked={treasurySettings.anonLevel === 'tier3'} onchange={() => setAnonLevel('tier3')} />
						<div style="flex:1">
							<div class="fw500">Tier 3 — Minimal Anonymize <span class="small muted">(highest value)</span></div>
							<div class="small muted" style="margin-top:4px">Precise GPS kept. Full sensor data (speed, altitude, bearing, environmental readings). Conversations kept with context. Photos with location metadata. Name and personal identifiers always stripped.</div>
							<div class="small" style="margin-top:6px;color:var(--accent2)">Who buys this: Climate and air quality research, smart city infrastructure planning, autonomous navigation training, health and fitness analytics.</div>
							<div class="small" style="margin-top:2px;color:var(--accent)">Earnings: ~5x base rate</div>
						</div>
					</label>
				</div>
				<div style="margin-top:12px;padding:10px;background:rgba(137,180,250,0.06);border-radius:6px;border:1px solid rgba(137,180,250,0.1)">
					<div class="fw500" style="font-size:13px;margin-bottom:6px">What's valuable in 2026</div>
					<div class="small muted" style="line-height:1.6">
						<strong style="color:var(--text)">Conversational data</strong> — highest demand. Every AI company needs diverse conversation patterns to improve their models.<br/>
						<strong style="color:var(--text)">Sensor + location data</strong> — climate research, urban infrastructure, transit systems, air quality monitoring.<br/>
						<strong style="color:var(--text)">Photos with context</strong> — visual AI training benefits from real-world images with descriptions and metadata.<br/>
						<strong style="color:var(--text)">Daily patterns</strong> — app usage, routines, activity cycles. Product designers and researchers use this to build better tools.<br/><br/>
						This is what's valuable <em>now</em>. Technology's needs evolve constantly. Your data is valuable forever — as long as you generate it, data dividends exist. At every tier, your name, home address, and personal identifiers are permanently removed before anything leaves your device.
					</div>
				</div>
			</section>

			<section class="section">
				<h3>Transaction History</h3>
				<p class="muted small">No transactions yet. Enable data staking to start earning.</p>
			</section>

			<div style="text-align:center;padding-top:12px">
				<span class="small muted" style="opacity:0.6">Powered by Cardano</span>
			</div>
		{/if}
	</div>
</div>

<style>
	.settings-layout {
		display: flex;
		height: 100%;
		overflow: hidden;
	}

	.nav {
		width: 180px;
		min-width: 180px;
		background: #0e0e16;
		border-right: 1px solid #1e1e2e;
		padding: 12px;
		overflow-y: auto;
	}

	.nav-item {
		display: block;
		width: 100%;
		text-align: left;
		padding: 8px 10px;
		border: none;
		border-radius: 4px;
		background: transparent;
		color: #6c7086;
		font-size: 13px;
		cursor: pointer;
		margin-bottom: 2px;
		font-family: 'Inter', -apple-system, sans-serif;
	}

	.nav-item:hover {
		background: #1a1a25;
		color: #cdd6f4;
	}

	.nav-item.active {
		background: rgba(137, 180, 250, 0.1);
		color: #89b4fa;
	}

	.panel {
		flex: 1;
		padding: 24px;
		overflow-y: auto;
		position: relative;
	}

	h2 {
		font-size: 18px;
		font-weight: 500;
		margin-bottom: 20px;
		color: #cdd6f4;
	}

	h3 {
		font-size: 14px;
		font-weight: 600;
		color: #cdd6f4;
		margin-bottom: 10px;
	}

	.section {
		margin-bottom: 24px;
		padding-bottom: 20px;
		border-bottom: 1px solid #1e1e2e;
	}

	.section:last-child {
		border-bottom: none;
	}

	.row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 10px 0;
		border-bottom: 1px solid #1a1a25;
	}

	.row:last-child {
		border-bottom: none;
	}

	.label {
		font-size: 13px;
		color: #6c7086;
	}

	.value {
		font-size: 13px;
		color: #cdd6f4;
		display: flex;
		align-items: center;
		gap: 6px;
	}

	.dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: #6c7086;
		display: inline-block;
	}

	.dot.online {
		background: #a6e3a1;
		box-shadow: 0 0 6px #a6e3a1;
	}

	.dot.offline {
		background: #f38ba8;
	}

	.dot.stale {
		background: #f9e2af;
	}

	.input {
		background: #1a1a25;
		border: 1px solid #1e1e2e;
		border-radius: 6px;
		padding: 6px 12px;
		color: #cdd6f4;
		font-size: 13px;
		outline: none;
		font-family: 'Inter', -apple-system, sans-serif;
	}

	.input:focus {
		border-color: #89b4fa;
	}

	.input.mono {
		font-family: 'JetBrains Mono', monospace;
		font-size: 12px;
	}

	.input.small {
		font-size: 12px;
		padding: 4px 8px;
	}

	.btn {
		padding: 8px 16px;
		border: none;
		border-radius: 6px;
		font-size: 13px;
		font-weight: 500;
		cursor: pointer;
		font-family: 'Inter', -apple-system, sans-serif;
		transition: opacity 0.15s;
	}

	.btn:hover {
		opacity: 0.85;
	}

	.term-input {
		background: #1e1e2e;
		color: #cdd6f4;
		border: 1px solid #45475a;
		border-radius: 4px;
		padding: 6px 10px;
		font-size: 13px;
		font-family: inherit;
		min-width: 180px;
	}
	.term-input:focus {
		outline: none;
		border-color: #89b4fa;
	}

	.btn.accent {
		background: #89b4fa;
		color: #0a0a0f;
	}

	.btn.secondary {
		background: #1a1a25;
		color: #6c7086;
		border: 1px solid #1e1e2e;
	}

	.btn.warn {
		background: #f9e2af;
		color: #0a0a0f;
	}

	.btn.danger {
		background: #f38ba8;
		color: #0a0a0f;
	}

	.btn.small {
		padding: 4px 10px;
		font-size: 11px;
	}

	.toggle-row {
		display: flex;
		align-items: center;
		gap: 12px;
		margin-bottom: 8px;
	}

	.toggle {
		position: relative;
		display: inline-block;
		width: 36px;
		height: 20px;
	}

	.toggle input {
		opacity: 0;
		width: 0;
		height: 0;
	}

	.slider {
		position: absolute;
		cursor: pointer;
		top: 0; left: 0; right: 0; bottom: 0;
		background: #1e1e2e;
		border-radius: 10px;
		transition: 0.2s;
	}

	.slider::before {
		content: '';
		position: absolute;
		height: 14px;
		width: 14px;
		left: 3px;
		bottom: 3px;
		background: #6c7086;
		border-radius: 50%;
		transition: 0.2s;
	}

	.toggle input:checked + .slider {
		background: #a6e3a1;
	}

	.toggle input:checked + .slider::before {
		transform: translateX(16px);
		background: #0a0a0f;
	}

	.hint {
		font-size: 12px;
		color: #6c7086;
		line-height: 1.5;
		margin-bottom: 10px;
	}
	.personality-input {
		width: 100%;
		min-height: 60px;
		padding: 8px 12px;
		background: #1a1a25;
		border: 1px solid #1e1e2e;
		border-radius: 6px;
		color: #cdd6f4;
		font-family: inherit;
		font-size: 13px;
		resize: vertical;
		outline: none;
		margin-bottom: 8px;
	}
	.personality-input:focus { border-color: #89b4fa; }

	.muted {
		color: #6c7086;
	}

	.small {
		font-size: 12px;
	}

	.fw500 {
		font-weight: 500;
	}

	.mono {
		font-family: 'JetBrains Mono', monospace;
	}

	.accent {
		color: #89b4fa;
	}

	.accent2 {
		color: #a6e3a1;
	}

	.form-grid {
		display: grid;
		gap: 8px;
	}

	.form-row {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 10px 12px;
		background: #0a0a0f;
		border-radius: 6px;
	}

	.form-label {
		flex: 1;
	}

	.model-card {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 10px 12px;
		background: #0a0a0f;
		border-radius: 6px;
	}

	.add-model-details {
		background: #0a0a0f;
		border: 1px solid #1e1e2e;
		border-radius: 8px;
	}

	.add-model-details summary {
		padding: 10px 12px;
		cursor: pointer;
		font-weight: 500;
		font-size: 13px;
		color: #cdd6f4;
	}

	.add-model-form {
		padding: 0 12px 12px;
		display: grid;
		gap: 8px;
	}

	.stat-row {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
		gap: 12px;
	}

	.stat-card {
		padding: 12px;
		background: #0a0a0f;
		border: 1px solid #1e1e2e;
		border-radius: 8px;
		text-align: center;
	}

	.stat-value {
		font-size: 22px;
		font-weight: 600;
		color: #89b4fa;
	}

	.stat-value.accent2 {
		color: #a6e3a1;
	}

	.stat-label {
		font-size: 11px;
		color: #6c7086;
		margin-top: 4px;
	}

	.device-card {
		background: #0a0a0f;
		border: 1px solid #1e1e2e;
		border-radius: 8px;
		margin-bottom: 8px;
		overflow: hidden;
	}
	.device-card.expanded {
		border-color: #2a2a3e;
	}
	.device-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 12px;
	}
	.btn-icon {
		background: none;
		border: none;
		color: #888;
		cursor: pointer;
		padding: 4px 6px;
		font-size: 14px;
		transition: color 0.15s;
	}
	.btn-icon:hover { color: #ccc; }
	.chevron {
		display: inline-block;
		transition: transform 0.2s;
	}
	.chevron.rotated { transform: rotate(90deg); }
	.device-options {
		border-top: 1px solid #1e1e2e;
		padding: 8px 12px;
	}
	.device-option {
		padding: 6px 0;
	}
	.device-option + .device-option {
		border-top: 1px solid #141420;
	}
	.danger-zone {
		background: rgba(220, 50, 50, 0.06);
		border-radius: 6px;
		padding: 10px;
		margin: 4px 0;
	}
	.btn.danger-outline {
		background: transparent;
		border: 1px solid #c0392b;
		color: #e74c3c;
	}
	.btn.danger-outline:hover {
		background: rgba(220, 50, 50, 0.1);
	}
	.btn.danger {
		background: #c0392b;
		color: #fff;
		border: none;
	}
	.btn.danger:hover {
		background: #e74c3c;
	}

	.oauth-grid {
		display: grid;
		gap: 12px;
	}

	.oauth-card {
		background: #0a0a0f;
		border: 1px solid #1e1e2e;
		border-radius: 8px;
		padding: 12px;
	}

	.radio-group {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.radio-item {
		display: flex;
		align-items: center;
		gap: 8px;
		cursor: pointer;
	}

	.radio-item input[type="radio"] {
		accent-color: #89b4fa;
	}

	.status-box {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 12px;
		background: #0a0a0f;
		border: 1px solid #1e1e2e;
		border-radius: 8px;
		margin-bottom: 12px;
	}

	.warn-box {
		padding: 12px;
		background: #0a0a0f;
		border: 1px solid rgba(249, 226, 175, 0.25);
		border-radius: 8px;
		margin-bottom: 12px;
	}

	.wallet-info {
		background: #0a0a0f;
		border: 1px solid #1e1e2e;
		border-radius: 8px;
		padding: 16px;
	}

	.toast {
		position: sticky;
		top: 0;
		background: rgba(137, 180, 250, 0.15);
		color: #89b4fa;
		padding: 8px 16px;
		border-radius: 6px;
		font-size: 13px;
		margin-bottom: 16px;
		text-align: center;
		z-index: 10;
	}

	kbd {
		background: #1a1a25;
		padding: 1px 5px;
		border-radius: 3px;
		border: 1px solid #1e1e2e;
		font-size: 11px;
	}
</style>
