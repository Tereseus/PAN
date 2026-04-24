<script>
	import { api } from '$lib/api.js';
	import { THEMES, THEME_META, applyTheme, loadTheme } from '$lib/theme.js';

	let activeTab = $state('general');
	let currentTheme = $state(typeof window !== 'undefined' ? (localStorage.getItem('pan-theme') || 'cool-guy') : 'cool-guy');
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
	let claudeModels = $state([]);
	let claudeModelsSource = $state('hardcoded');
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

	// Email settings
	let emailConfig = $state({});
	let emailProvider = $state('custom');
	let emailTestResult = $state(null);
	let emailTesting = $state(false);
	let emailMsg = $state('');

	const emailPresets = {
		gmail: { imap_host: 'imap.gmail.com', imap_port: '993', smtp_host: 'smtp.gmail.com', smtp_port: '587' },
		outlook: { imap_host: 'outlook.office365.com', imap_port: '993', smtp_host: 'smtp.office365.com', smtp_port: '587' },
	};

	async function loadEmailConfig() {
		try {
			const res = await fetch(window.location.origin + '/api/v1/email/config');
			if (res.ok) {
				emailConfig = await res.json();
				emailProvider = emailConfig.email_provider || 'custom';
			}
		} catch {}
	}

	function applyEmailPreset(provider) {
		emailProvider = provider;
		emailConfig.email_provider = provider;
		if (emailPresets[provider]) {
			const p = emailPresets[provider];
			emailConfig.email_imap_host = p.imap_host;
			emailConfig.email_imap_port = p.imap_port;
			emailConfig.email_smtp_host = p.smtp_host;
			emailConfig.email_smtp_port = p.smtp_port;
		}
		emailConfig = { ...emailConfig };
	}

	async function saveEmailConfig() {
		try {
			const res = await fetch(window.location.origin + '/api/v1/email/config', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(emailConfig),
			});
			if (res.ok) {
				emailMsg = 'Saved';
				setTimeout(() => { emailMsg = ''; }, 3000);
			} else {
				emailMsg = 'Save failed';
			}
		} catch { emailMsg = 'Save failed'; }
	}

	async function testEmailConnection() {
		emailTesting = true;
		emailTestResult = null;
		try {
			const res = await fetch(window.location.origin + '/api/v1/email/test', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(emailConfig),
			});
			emailTestResult = await res.json();
		} catch (e) {
			emailTestResult = { ok: false, errors: [{ type: 'general', error: e.message }] };
		} finally {
			emailTesting = false;
		}
	}

	// Terminal appearance — persisted in localStorage, read on mount
	const TERM_DEFAULTS = {
		username: 'User',
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

	// Rename device (inline per-device)
	let renameDeviceId = $state(null);
	let renameDeviceName = $state('');

	// Device expand/remove
	let expandedDeviceId = $state(null);
	let confirmRemoveDeviceId = $state(null);
	let confirmRemoveTyped = $state('');

	// --- Org management state ---
	let orgList = $state([]);
	let orgMembers = $state([]);
	let orgInvites = $state([]);
	let orgDetail = $state(null);
	let activeOrgId = $state('org_personal');
	let selectedOrgTab = $state('users');
	let newOrgName = $state('');
	let inviteEmail = $state('');
	let inviteRole = $state('user');
	let inviteMaxUses = $state(1);
	let inviteExpiry = $state(72);
	let orgMsg = $state('');

	// --- Teams state ---
	let teamsList = $state([]);
	let selectedTeam = $state(null);
	let teamMembers = $state([]);
	let newTeamName = $state('');
	let newTeamColor = $state('#89b4fa');
	let newTeamDesc = $state('');
	let teamMsg = $state('');

	const tabs = [
		{ id: 'appearance', label: 'Appearance' },
		{ id: 'general', label: 'General' },
		{ id: 'ai', label: 'AI & Usage' },
		{ id: 'controls', label: 'Controls' },
		{ id: 'devices', label: 'Devices' },
		{ id: 'orgs', label: 'Organizations' },
		{ id: 'security', label: 'Security' },
		{ id: 'auth', label: 'Authentication' },
		{ id: 'network', label: 'Remote Access' },
		{ id: 'treasury', label: 'Treasury' },
		{ id: 'email', label: 'Email' },
	];

	function selectTheme(name) {
		currentTheme = name;
		applyTheme(name);
	}

	const jobDefs = [
		{ key: 'router', name: 'Ferry', tech: 'Router', desc: 'Voice command classification + response' },
		{ key: 'scout', name: 'Scout', tech: 'Scout', desc: 'Discovers new tools & CLIs' },
		{ key: 'dream', name: 'Dream', tech: 'Dream', desc: 'Consolidates memories into state file' },
		{ key: 'autodev', name: 'Forge', tech: 'AutoDev', desc: 'Automated development tasks' },
		{ key: 'classifier', name: 'Augur', tech: 'Classifier', desc: 'Extracts memories from events' },
		{ key: 'recall', name: 'Remembrance', tech: 'Recall', desc: 'On-demand memory search' },
		{ key: 'vision', name: 'Vision', tech: 'Vision', desc: 'Photo/image analysis' },
		{ key: 'benchmark_judge', name: 'Judge', tech: 'Benchmark', desc: 'Scores benchmark results — default: claude-sonnet-4-5-20250514 (free via Max plan)' },
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

	async function loadUsersWithTeams() {
		await loadUsers();
		// Enrich each user with their team memberships
		for (const u of users) {
			try {
				const d = await api(`/api/v1/teams/user/${u.id}`);
				u._teams = d.teams || [];
			} catch { u._teams = []; }
		}
		users = [...users]; // trigger reactivity
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

	async function loadOrgs() {
		try {
			const d = await api('/api/v1/orgs');
			orgList = d.orgs || [];
			activeOrgId = d.active || 'org_personal';
		} catch { orgList = []; }
	}

	async function loadOrgMembers(orgId) {
		try {
			const d = await api(`/api/v1/orgs/${orgId}/members`);
			orgMembers = d.members || [];
		} catch { orgMembers = []; }
	}

	async function loadOrgInvites(orgId) {
		try {
			const d = await api(`/api/v1/orgs/${orgId}/invites`);
			orgInvites = d.invites || [];
		} catch { orgInvites = []; }
	}

	async function loadOrgDetail(orgId) {
		try {
			orgDetail = await api(`/api/v1/orgs/${orgId}`);
		} catch { orgDetail = null; }
	}

	async function selectOrgForManage(orgId) {
		activeOrgId = orgId;
		await Promise.all([loadOrgDetail(orgId), loadOrgMembers(orgId), loadOrgInvites(orgId), loadTeams()]);
	}

	async function createOrg() {
		if (!newOrgName.trim()) return;
		try {
			const d = await api('/api/v1/orgs', { method: 'POST', body: JSON.stringify({ name: newOrgName.trim() }) });
			if (d.ok) {
				newOrgName = '';
				orgMsg = `Created "${d.org.name}"`;
				await loadOrgs();
				await selectOrgForManage(d.org.id);
				setTimeout(() => orgMsg = '', 3000);
			}
		} catch (e) { orgMsg = e.message; }
	}

	async function createInvite() {
		try {
			const d = await api(`/api/v1/orgs/${activeOrgId}/invites`, {
				method: 'POST',
				body: JSON.stringify({
					email: inviteEmail || undefined,
					role_name: inviteRole,
					max_uses: inviteMaxUses,
					expires_in_hours: inviteExpiry,
				})
			});
			if (d.ok) {
				orgMsg = `Invite created! Token: ${d.invite.token}`;
				inviteEmail = '';
				await loadOrgInvites(activeOrgId);
				setTimeout(() => orgMsg = '', 8000);
			}
		} catch (e) { orgMsg = e.message; }
	}

	async function revokeInvite(inviteId) {
		try {
			await api(`/api/v1/orgs/${activeOrgId}/invites/${inviteId}`, { method: 'DELETE' });
			await loadOrgInvites(activeOrgId);
		} catch {}
	}

	async function changeMemberRole(userId, roleName) {
		try {
			await api(`/api/v1/orgs/${activeOrgId}/members/${userId}/role`, {
				method: 'PUT',
				body: JSON.stringify({ role_name: roleName })
			});
			orgMsg = 'Role updated';
			await loadOrgMembers(activeOrgId);
			setTimeout(() => orgMsg = '', 3000);
		} catch (e) { orgMsg = e.message; setTimeout(() => orgMsg = '', 4000); }
	}

	async function removeMember(userId) {
		if (!confirm('Remove this member from the organization?')) return;
		try {
			await api(`/api/v1/orgs/${activeOrgId}/members/${userId}`, { method: 'DELETE' });
			orgMsg = 'Member removed';
			await loadOrgMembers(activeOrgId);
			setTimeout(() => orgMsg = '', 3000);
		} catch (e) { orgMsg = e.message; setTimeout(() => orgMsg = '', 4000); }
	}

	async function deleteOrg(orgId) {
		if (!confirm('Delete this organization? This cannot be undone.')) return;
		try {
			await api(`/api/v1/orgs/${orgId}`, { method: 'DELETE' });
			orgMsg = 'Organization deleted';
			await loadOrgs();
			activeOrgId = 'org_personal';
			orgDetail = null;
			orgMembers = [];
			orgInvites = [];
			setTimeout(() => orgMsg = '', 3000);
		} catch (e) { orgMsg = e.message; setTimeout(() => orgMsg = '', 4000); }
	}

	// --- Teams functions ---
	async function loadTeams() {
		try {
			const d = await api('/api/v1/teams');
			teamsList = d.teams || [];
		} catch { teamsList = []; }
	}

	async function loadTeamDetail(teamId) {
		try {
			const d = await api(`/api/v1/teams/${teamId}`);
			selectedTeam = d.team;
			teamMembers = d.members || [];
		} catch { selectedTeam = null; teamMembers = []; }
	}

	async function createTeam() {
		if (!newTeamName.trim()) return;
		try {
			const d = await api('/api/v1/teams', {
				method: 'POST',
				body: JSON.stringify({ name: newTeamName.trim(), description: newTeamDesc || undefined, color: newTeamColor })
			});
			if (d.ok) {
				newTeamName = '';
				newTeamDesc = '';
				newTeamColor = '#89b4fa';
				teamMsg = `Created team "${d.team.name}"`;
				await loadTeams();
				await loadTeamDetail(d.team.id);
				setTimeout(() => teamMsg = '', 3000);
			}
		} catch (e) { teamMsg = e.message; setTimeout(() => teamMsg = '', 4000); }
	}

	async function deleteTeam(teamId) {
		if (!confirm('Delete this team? Projects and tasks will be unassigned.')) return;
		try {
			await api(`/api/v1/teams/${teamId}`, { method: 'DELETE' });
			teamMsg = 'Team deleted';
			selectedTeam = null;
			teamMembers = [];
			await loadTeams();
			setTimeout(() => teamMsg = '', 3000);
		} catch (e) { teamMsg = e.message; setTimeout(() => teamMsg = '', 4000); }
	}

	async function addTeamMember(teamId, userId) {
		try {
			await api(`/api/v1/teams/${teamId}/members`, {
				method: 'POST',
				body: JSON.stringify({ user_id: userId })
			});
			teamMsg = 'Member added';
			await loadTeamDetail(teamId);
			setTimeout(() => teamMsg = '', 3000);
		} catch (e) { teamMsg = e.message; setTimeout(() => teamMsg = '', 4000); }
	}

	async function removeTeamMember(teamId, userId) {
		try {
			await api(`/api/v1/teams/${teamId}/members/${userId}`, { method: 'DELETE' });
			teamMsg = 'Member removed';
			await loadTeamDetail(teamId);
			setTimeout(() => teamMsg = '', 3000);
		} catch (e) { teamMsg = e.message; setTimeout(() => teamMsg = '', 4000); }
	}

	async function changeTeamMemberRole(teamId, userId, role) {
		try {
			await api(`/api/v1/teams/${teamId}/members/${userId}`, {
				method: 'PUT',
				body: JSON.stringify({ role })
			});
			teamMsg = 'Role updated';
			await loadTeamDetail(teamId);
			setTimeout(() => teamMsg = '', 3000);
		} catch (e) { teamMsg = e.message; setTimeout(() => teamMsg = '', 4000); }
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
		// Full Carrier restart — used when carrier.js / perf stages / engine code
		// changed (a Craft swap cannot pick up carrier-level changes).
		// For Craft-only changes use the Lifeboat widget (POST /api/carrier/swap).
		// See FEATURES.md → "Settings → Restart PAN" for the full spec.
		flash('Restarting PAN (carrier + craft)...');
		let startedOk = false;
		try {
			const r = await fetch('/api/carrier/restart', { method: 'POST' });
			const d = await r.json().catch(() => ({}));
			if (r.status === 409) {
				// Probe-gate refused — tell the user which stages are failing.
				const failed = Array.isArray(d.failed_stages) ? d.failed_stages.join(', ') : 'unknown';
				const proceed = confirm(`PAN is not fully healthy (failed: ${failed}). Force restart anyway?`);
				if (!proceed) { flash('Restart cancelled'); return; }
				const r2 = await fetch('/api/carrier/restart?force=1', { method: 'POST' });
				startedOk = r2.ok;
			} else {
				startedOk = r.ok;
			}
		} catch {
			// Network error is actually expected mid-restart — keep going.
			startedOk = true;
		}
		if (!startedOk) { flash('Restart endpoint refused — check console'); return; }

		// Poll for the new Carrier to be back up. /api/carrier/status is a
		// Carrier-side route, so getting a 200 means the fresh carrier is live.
		flash('Waiting for PAN to come back...');
		let attempts = 0;
		const poll = setInterval(async () => {
			attempts++;
			try {
				const resp = await fetch('/api/carrier/status', { cache: 'no-store' });
				if (resp.ok) {
					clearInterval(poll);
					flash('PAN back online ✓');
					setTimeout(() => location.reload(), 800);
				}
			} catch {}
			if (attempts >= 60) {
				clearInterval(poll);
				flash('PAN did not come back after 60s — check pan-loop.bat window');
			}
		}, 1000);
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
			// Signal all open terminal tabs to clear their launch guard so ΠΑΝ Remembers re-fires
			localStorage.setItem('pan_ai_changed', Date.now().toString());
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
				method: 'PATCH',
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
			confirmRemoveTyped = '';
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

	async function loadClaudeModels() {
		try {
			const data = await api('/api/v1/ai/models');
			claudeModels = data.models || [];
			claudeModelsSource = data.source || 'hardcoded';
		} catch {
			claudeModels = [];
		}
	}

	$effect(() => {
		loadHealth();
		loadSettings();
		loadDevices();
		loadProjects();
		loadSessions();
		loadUsersWithTeams();
		loadAuthProviders();
		loadTailscaleStatus();
		loadUsage();
		loadClaudeModels();
		loadOrgs();
		loadTeams();
		loadEmailConfig();

		// Deep-link: ?section=email jumps to the email tab
		if (typeof window !== 'undefined') {
			const sec = new URLSearchParams(window.location.search).get('section');
			if (sec && tabs.some(t => t.id === sec)) activeTab = sec;
		}
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

		<!-- Appearance -->
		{#if activeTab === 'appearance'}
			<h2>Appearance</h2>
			<section class="section">
				<h3>Theme</h3>
				<div class="theme-grid">
					{#each Object.entries(THEME_META) as [id, meta]}
						<button
							class="theme-card"
							class:active={currentTheme === id}
							onclick={() => selectTheme(id)}
							data-theme-preview={id}
						>
							<span class="theme-emoji">{meta.emoji}</span>
							<span class="theme-label">{meta.label}</span>
							{#if currentTheme === id}
								<span class="theme-check">✓</span>
							{/if}
						</button>
					{/each}
				</div>
			</section>
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
					<button class="btn warn" onclick={restartServer} title="Full PAN restart — kills carrier, pan-loop.bat respawns it. Use when carrier.js / perf stages / engine code changed. For Craft-only changes use the Lifeboat widget instead.">Restart PAN</button>
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
					<input type="text" class="term-input" value={termSettings.username} oninput={(e) => updateTermSetting('pan_username', e.target.value)} placeholder="Your name" />
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
							<div class="small muted">Which AI CLI launches in your terminals</div>
						</div>
						<select bind:value={settings.terminal_ai_provider} onchange={saveTerminalAI} class="input" style="width:220px">
							<option value="claude">Claude Code</option>
							<option value="gemini">Gemini CLI</option>
							<option value="aider">Aider</option>
							<option value="copilot">GitHub Copilot</option>
							{#if settings.terminal_ai_provider && !['claude','gemini','aider','copilot'].includes(settings.terminal_ai_provider)}
								<option value={settings.terminal_ai_provider}>{settings.terminal_ai_provider} (custom)</option>
							{/if}
						</select>
					</div>
					<div class="form-row">
						<div class="form-label">
							<div class="fw500">Terminal Model</div>
							<div class="small muted">Passed to the CLI via --model</div>
						</div>
						{#if settings.terminal_ai_provider === 'claude'}
							<div style="display:flex;align-items:center;gap:6px">
								<select bind:value={settings.terminal_ai_model} onchange={saveTerminalAI} class="input" style="width:220px">
									<option value="">Default</option>
									{#if claudeModels.length > 0}
										{#each claudeModels as m}
											<option value={m.id}>{m.name || m.id}</option>
										{/each}
									{:else}
										<option value="claude-haiku-4-5-20251001">Haiku 4.5 (fast)</option>
										<option value="claude-sonnet-4-6">Sonnet 4.6</option>
										<option value="claude-opus-4-6">Opus 4.6</option>
										<option value="claude-opus-4-7">Opus 4.7</option>
									{/if}
								</select>
								<button class="btn btn-sm" onclick={loadClaudeModels} title={claudeModelsSource === 'anthropic_api' ? 'Live from Anthropic API' : 'Refresh from Anthropic API'} style="padding:4px 8px;font-size:11px">
									{claudeModelsSource === 'anthropic_api' ? '🔴 live' : '↻'}
								</button>
							</div>
						{:else if settings.terminal_ai_provider === 'gemini'}
							<select bind:value={settings.terminal_ai_model} onchange={saveTerminalAI} class="input" style="width:220px">
								<option value="">Default</option>
								<option value="gemini-2.5-pro">Gemini 2.5 Pro</option>
								<option value="gemini-2.0-flash">Gemini 2.0 Flash</option>
								<option value="gemini-1.5-pro">Gemini 1.5 Pro</option>
							</select>
						{:else}
							<input type="text" bind:value={settings.terminal_ai_model} onchange={saveTerminalAI} placeholder="model name..." class="input" style="width:220px" />
						{/if}
					</div>
					<div class="form-row" style="flex-direction:column;align-items:stretch">
						<div class="form-label">
							<div class="fw500">Full CLI Command <span class="small muted">(optional — overrides provider + model above)</span></div>
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
						{@const isHub = d.device_type === 'pc' && !d.client_version}
						{@const staleMs = d.device_type === 'phone' ? 15 * 60 * 1000 : 5 * 60 * 1000}
						{@const ageMs = d.last_seen ? Date.now() - new Date(d.last_seen).getTime() : Infinity}
						{@const isOnline = ageMs < staleMs}
						<div class="device-card" class:expanded={expandedDeviceId === d.id}>
							<div class="device-row">
								<div style="flex:1">
									<div class="fw500" style="display:flex;align-items:center;gap:6px">
										{#if renameDeviceId === d.id}
											<input
												type="text"
												class="input"
												style="width:160px;padding:2px 6px;font-size:13px"
												bind:value={renameDeviceName}
												onkeydown={(e) => { if (e.key === 'Enter') renameDevice(); if (e.key === 'Escape') { renameDeviceId = null; renameDeviceName = ''; } }}
											/>
											<button class="btn accent" style="padding:2px 10px;font-size:12px" onclick={renameDevice}>Save</button>
											<button class="btn" style="padding:2px 10px;font-size:12px" onclick={() => { renameDeviceId = null; renameDeviceName = ''; }}>Cancel</button>
										{:else}
											<span>{d.name || d.device_name || 'Unknown'}</span>
											<button class="btn-icon" style="opacity:0.5;font-size:11px" title="Rename" onclick={() => { renameDeviceId = d.id; renameDeviceName = d.name || d.device_name || ''; }}>✏️</button>
										{/if}
										{#if isHub}
											<span style="font-size:10px;font-weight:600;padding:1px 6px;border-radius:4px;background:#89b4fa22;color:#89b4fa;border:1px solid #89b4fa44">HUB</span>
										{:else if d.client_version}
											<span style="font-size:10px;font-weight:600;padding:1px 6px;border-radius:4px;background:#a6e3a122;color:#a6e3a1;border:1px solid #a6e3a144">CLIENT</span>
										{/if}
									</div>
									<div class="small muted">{d.device_type || '--'} · {d.hostname || ''} · Last seen: {fmtTime(d.last_seen)}</div>
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
									<span class="dot" class:online={isOnline} class:stale={!isOnline}></span>
									{#if !isHub}
										<button class="btn-icon" onclick={() => { expandedDeviceId = expandedDeviceId === d.id ? null : d.id; confirmRemoveDeviceId = null; confirmRemoveTyped = ''; }} title="More options">
											<span class="chevron" class:rotated={expandedDeviceId === d.id}>&#9656;</span>
										</button>
									{/if}
								</div>
							</div>
							{#if expandedDeviceId === d.id && !isHub}
								<div class="device-options">
									<div class="device-option">
										<span class="small muted">ID: {d.id} | Hostname: {d.hostname}{d.client_version ? ` | Client v${d.client_version}` : ''}</span>
									</div>
									{#if confirmRemoveDeviceId === d.id}
										<div class="device-option danger-zone">
											<span class="small" style="display:block;margin-bottom:8px">To remove <strong>{d.name || d.hostname}</strong>, type the device name to confirm:</span>
											<input
												type="text"
												class="input"
												style="width:220px;margin-bottom:8px"
												placeholder={d.name || d.hostname}
												bind:value={confirmRemoveTyped}
											/>
											<div style="display:flex;gap:8px">
												<button
													class="btn danger"
													disabled={confirmRemoveTyped.trim() !== (d.name || d.hostname)}
													onclick={() => removeDevice(d.id)}
												>Confirm Remove</button>
												<button class="btn" onclick={() => { confirmRemoveDeviceId = null; confirmRemoveTyped = ''; }}>Cancel</button>
											</div>
										</div>
									{:else}
										<div class="device-option">
											<button class="btn danger-outline" onclick={() => { confirmRemoveDeviceId = d.id; confirmRemoveTyped = ''; }}>Remove Device</button>
										</div>
									{/if}
								</div>
							{/if}
						</div>
					{/each}
				{:else}
					<span class="muted">No devices registered</span>
				{/if}
			</section>
		{/if}

		<!-- Organizations -->
		{#if activeTab === 'orgs'}
			<h2>Organizations</h2>

			{#if orgMsg}
				<div class="flash">{orgMsg}</div>
			{/if}

			<section class="section">
				<h3>Your Organizations</h3>
				<div class="org-list">
					{#each orgList as org}
						<button
							class="org-card" class:active={activeOrgId === org.id}
							onclick={() => selectOrgForManage(org.id)}
						>
							<span class="org-card-dot" style="background: {org.color_primary || '#89b4fa'}"></span>
							<span class="org-card-name">{org.name}</span>
							<span class="org-card-role">{org.role_name || 'owner'}</span>
						</button>
					{/each}
				</div>

				<div style="display:flex;gap:8px;align-items:center;margin-top:12px">
					<input type="text" bind:value={newOrgName} placeholder="New org name..." class="input" style="width:200px" />
					<button class="btn accent" onclick={createOrg}>Create Org</button>
				</div>
			</section>

			<!-- Sub-tabs: always show Users/Teams; show Members/Invites/Settings for non-personal orgs -->
			<div class="org-sub-tabs">
				<button class="org-sub-tab" class:active={selectedOrgTab === 'users'} onclick={() => { selectedOrgTab = 'users'; loadUsersWithTeams(); }}>Users ({users.length})</button>
				<button class="org-sub-tab" class:active={selectedOrgTab === 'teams'} onclick={() => { selectedOrgTab = 'teams'; loadTeams(); }}>Teams ({teamsList.length})</button>
				{#if activeOrgId !== 'org_personal'}
					<button class="org-sub-tab" class:active={selectedOrgTab === 'members'} onclick={() => selectedOrgTab = 'members'}>Members ({orgMembers.length})</button>
					<button class="org-sub-tab" class:active={selectedOrgTab === 'invites'} onclick={() => selectedOrgTab = 'invites'}>Invites ({orgInvites.length})</button>
					<button class="org-sub-tab" class:active={selectedOrgTab === 'settings'} onclick={() => selectedOrgTab = 'settings'}>Settings</button>
				{/if}
			</div>

			{#if selectedOrgTab === 'users'}
				<section class="section">
					<h3>All Users</h3>
					{#if users.length}
						{#each users as u}
							<div class="member-row">
								<div class="member-avatar" style="background: #89b4fa">{(u.display_name || u.email || '?').charAt(0).toUpperCase()}</div>
								<div class="member-info">
									<span class="member-name">{u.display_name || u.email}</span>
									<span class="member-email">{u.email && !u.email.endsWith('@localhost') ? u.email : ''}</span>
								</div>
								<select class="input role-select" value={u.role} onchange={(e) => changeUserRole(u.id, e.target.value)}>
									<option value="user">User</option>
									<option value="admin">Admin</option>
									<option value="owner">Owner</option>
								</select>
								{#if u._teams && u._teams.length > 0}
									<div style="display:flex;gap:4px;flex-wrap:wrap">
										{#each u._teams as t}
											<span class="team-badge" style="border-color: {t.color || '#89b4fa'}; color: {t.color || '#89b4fa'}">{t.name}</span>
										{/each}
									</div>
								{/if}
							</div>
						{/each}
					{:else}
						<div class="muted">No users registered</div>
					{/if}
				</section>
			{/if}

			{#if selectedOrgTab === 'teams'}
				<section class="section">
					{#if teamMsg}
						<div class="flash">{teamMsg}</div>
					{/if}

					<h3>Teams</h3>

					<!-- Team list -->
					<div class="teams-grid">
						{#each teamsList as team}
							<button
								class="team-card" class:active={selectedTeam?.id === team.id}
								onclick={() => loadTeamDetail(team.id)}
							>
								<span class="team-dot" style="background: {team.color || '#89b4fa'}"></span>
								<div class="team-card-info">
									<span class="team-card-name">{team.name}</span>
									<span class="team-card-count">{team.member_count} Member{team.member_count !== 1 ? 's' : ''}</span>
								</div>
							</button>
						{/each}
						{#if teamsList.length === 0}
							<div class="muted">No teams yet</div>
						{/if}
					</div>

					<!-- Create team -->
					<div style="display:flex;gap:8px;align-items:center;margin-top:12px;flex-wrap:wrap">
						<input type="text" bind:value={newTeamName} placeholder="Team name..." class="input" style="width:160px" />
						<input type="text" bind:value={newTeamDesc} placeholder="Description (optional)" class="input" style="width:200px" />
						<input type="color" bind:value={newTeamColor} style="width:36px;height:32px;border:none;background:none;cursor:pointer" />
						<button class="btn accent" onclick={createTeam}>Create Team</button>
					</div>

					<!-- Selected team detail -->
					{#if selectedTeam}
						<div style="margin-top:20px;border-top:1px solid #313244;padding-top:16px">
							<div style="display:flex;justify-content:space-between;align-items:center">
								<h4 style="margin:0;color:#cdd6f4">
									<span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:{selectedTeam.color || '#89b4fa'};margin-right:8px"></span>
									{selectedTeam.name}
								</h4>
								<button class="btn-icon danger" onclick={() => deleteTeam(selectedTeam.id)} title="Delete team">🗑</button>
							</div>
							{#if selectedTeam.description}
								<div class="muted" style="margin-top:4px">{selectedTeam.description}</div>
							{/if}

							<h4 style="margin:16px 0 8px;color:#cdd6f4">Team Members</h4>
							<div class="members-list">
								{#each teamMembers as member}
									<div class="member-row">
										<div class="member-avatar" style="background: {selectedTeam.color || '#89b4fa'}">{(member.display_name || member.email || '?').charAt(0).toUpperCase()}</div>
										<div class="member-info">
											<span class="member-name">{member.display_name || member.email}</span>
											<span class="member-email">{member.email && !member.email.endsWith('@localhost') ? member.email : ''}</span>
										</div>
										<select
											class="input role-select"
											value={member.role}
											onchange={(e) => changeTeamMemberRole(selectedTeam.id, member.user_id, e.target.value)}
										>
											<option value="member">Member</option>
											<option value="lead">Lead</option>
										</select>
										<button class="btn-icon danger" onclick={() => removeTeamMember(selectedTeam.id, member.user_id)} title="Remove">✕</button>
									</div>
								{/each}
								{#if teamMembers.length === 0}
									<div class="muted">No members yet</div>
								{/if}
							</div>

							<!-- Add member from users list -->
							{#if users.filter(u => !teamMembers.find(tm => tm.user_id === u.id)).length > 0}
								<div style="margin-top:12px;display:flex;gap:8px;align-items:center">
									<select class="input" id="addTeamMember" style="width:200px">
										{#each users.filter(u => !teamMembers.find(tm => tm.user_id === u.id)) as u}
											<option value={u.id}>{u.display_name || u.email}</option>
										{/each}
									</select>
									<button class="btn accent" onclick={() => {
										const sel = document.getElementById('addTeamMember');
										if (sel?.value) addTeamMember(selectedTeam.id, parseInt(sel.value));
									}}>Add to Team</button>
								</div>
							{/if}
						</div>
					{/if}
				</section>
			{/if}

			{#if selectedOrgTab === 'members' && activeOrgId !== 'org_personal'}
				<section class="section">
					<h3>Members — {orgDetail?.name || 'Org'}</h3>
					<div class="members-list">
						{#each orgMembers as member}
							<div class="member-row">
								<div class="member-avatar" style="background: {member.role_color || '#89b4fa'}">{(member.display_name || member.email || '?').charAt(0).toUpperCase()}</div>
								<div class="member-info">
									<span class="member-name">{member.display_name || member.email}</span>
									<span class="member-email">{member.email}</span>
								</div>
								<select
									class="input role-select"
									value={member.role_name || 'user'}
									onchange={(e) => changeMemberRole(member.id, e.target.value)}
								>
									<option value="viewer">Viewer</option>
									<option value="user">User</option>
									<option value="manager">Manager</option>
									<option value="admin">Admin</option>
									<option value="owner">Owner</option>
								</select>
								<button class="btn-icon danger" onclick={() => removeMember(member.id)} title="Remove member">✕</button>
							</div>
						{/each}
						{#if orgMembers.length === 0}
							<div class="muted">No members</div>
						{/if}
					</div>
				</section>
			{/if}

			{#if selectedOrgTab === 'invites' && activeOrgId !== 'org_personal'}
				<section class="section">
					<h3>Invite People</h3>
					<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:12px">
						<input type="email" bind:value={inviteEmail} placeholder="Email (optional)" class="input" style="width:200px" />
						<select bind:value={inviteRole} class="input" style="width:100px">
							<option value="viewer">Viewer</option>
							<option value="user">User</option>
							<option value="manager">Manager</option>
							<option value="admin">Admin</option>
						</select>
						<input type="number" bind:value={inviteMaxUses} min="1" max="100" class="input" style="width:80px" title="Max uses" />
						<button class="btn accent" onclick={createInvite}>Generate Invite</button>
					</div>

					<h4 style="margin:16px 0 8px;color:#cdd6f4">Active Invites</h4>
					{#each orgInvites as inv}
						<div class="invite-row">
							<code class="invite-token">{inv.token}</code>
							<span class="invite-meta">
								{inv.role_name || 'user'} · {inv.use_count}/{inv.max_uses} used
								{#if inv.email} · {inv.email}{/if}
							</span>
							<button class="btn-icon danger" onclick={() => revokeInvite(inv.id)} title="Revoke">✕</button>
						</div>
					{/each}
					{#if orgInvites.length === 0}
						<div class="muted">No active invites</div>
					{/if}
				</section>
			{/if}

			{#if selectedOrgTab === 'settings' && activeOrgId !== 'org_personal'}
				<section class="section">
					<h3>Org Settings — {orgDetail?.name || 'Org'}</h3>
					<div class="setting-row">
						<span class="setting-label">Name</span>
						<span class="setting-value">{orgDetail?.name}</span>
					</div>
					<div class="setting-row">
						<span class="setting-label">Slug</span>
						<span class="setting-value">{orgDetail?.slug}</span>
					</div>
					<div class="setting-row">
						<span class="setting-label">Members</span>
						<span class="setting-value">{orgDetail?.member_count}</span>
					</div>
					<div class="setting-row">
						<span class="setting-label">Incognito Allowed</span>
						<span class="setting-value">{orgDetail?.policy_incognito_allowed ? 'Yes' : 'No'}</span>
					</div>
					<div class="setting-row">
						<span class="setting-label">Blackout Allowed</span>
						<span class="setting-value">{orgDetail?.policy_blackout_allowed ? 'Yes' : 'No'}</span>
					</div>
					<div class="setting-row">
						<span class="setting-label">Data Retention</span>
						<span class="setting-value">{orgDetail?.policy_data_retention_days ? `${orgDetail.policy_data_retention_days} days` : 'Forever'}</span>
					</div>

					<div style="margin-top:20px">
						<button class="btn danger" onclick={() => deleteOrg(activeOrgId)}>Delete Organization</button>
					</div>
				</section>
			{/if}
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

		<!-- Email -->
		{#if activeTab === 'email'}
			<h2>Email</h2>
			{#if emailMsg}
				<div class="flash-msg">{emailMsg}</div>
			{/if}

			<section class="section">
				<h3>Provider</h3>
				<p class="hint">Select your email provider for auto-configuration, or choose Custom for manual IMAP/SMTP settings.</p>
				<div class="form-row">
					<div class="form-label"><div class="fw500">Provider</div></div>
					<select class="input" style="width:200px" bind:value={emailProvider} onchange={(e) => applyEmailPreset(e.target.value)}>
						<option value="gmail">Gmail</option>
						<option value="outlook">Outlook / Office 365</option>
						<option value="custom">Custom</option>
					</select>
				</div>
			</section>

			<section class="section">
				<h3>Account</h3>
				<div class="form-row">
					<div class="form-label">
						<div class="fw500">Email Address</div>
						<div class="small muted">Your full email address</div>
					</div>
					<input type="email" class="input" style="width:260px" bind:value={emailConfig.email_user} placeholder="you@example.com" />
				</div>
				<div class="form-row">
					<div class="form-label">
						<div class="fw500">Password / App Password</div>
						<div class="small muted">For Gmail, use an App Password</div>
					</div>
					<input type="password" class="input" style="width:260px" bind:value={emailConfig.email_password} placeholder="App password..." />
				</div>
				<div class="form-row">
					<div class="form-label">
						<div class="fw500">From Address</div>
						<div class="small muted">Optional — defaults to email address</div>
					</div>
					<input type="email" class="input" style="width:260px" bind:value={emailConfig.email_from} placeholder="Same as email address" />
				</div>
			</section>

			<section class="section">
				<h3>IMAP (Receive)</h3>
				<div class="form-row">
					<div class="form-label"><div class="fw500">IMAP Host</div></div>
					<input type="text" class="input" style="width:220px" bind:value={emailConfig.email_imap_host} placeholder="imap.example.com" />
				</div>
				<div class="form-row">
					<div class="form-label"><div class="fw500">IMAP Port</div></div>
					<input type="text" class="input" style="width:80px" bind:value={emailConfig.email_imap_port} placeholder="993" />
				</div>
			</section>

			<section class="section">
				<h3>SMTP (Send)</h3>
				<div class="form-row">
					<div class="form-label"><div class="fw500">SMTP Host</div></div>
					<input type="text" class="input" style="width:220px" bind:value={emailConfig.email_smtp_host} placeholder="smtp.example.com" />
				</div>
				<div class="form-row">
					<div class="form-label"><div class="fw500">SMTP Port</div></div>
					<input type="text" class="input" style="width:80px" bind:value={emailConfig.email_smtp_port} placeholder="587" />
				</div>
			</section>

			<section class="section">
				<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
					<button class="btn accent" onclick={saveEmailConfig}>Save</button>
					<button class="btn secondary" onclick={testEmailConnection} disabled={emailTesting}>
						{emailTesting ? 'Testing...' : 'Test Connection'}
					</button>
				</div>
				{#if emailTestResult}
					<div style="margin-top:10px;padding:10px;border-radius:6px;background:{emailTestResult.ok ? 'rgba(166,227,161,0.1)' : 'rgba(243,139,168,0.1)'};border:1px solid {emailTestResult.ok ? 'rgba(166,227,161,0.3)' : 'rgba(243,139,168,0.3)'}">
						{#if emailTestResult.ok}
							<span style="color:#a6e3a1">Connection successful</span>
						{:else}
							<span style="color:#f38ba8">Connection failed:</span>
							{#each emailTestResult.errors || [] as err}
								<div class="small" style="color:#f38ba8;margin-top:4px">{err.type}: {err.error}</div>
							{/each}
						{/if}
					</div>
				{/if}
			</section>

			<section class="section">
				<h3>Help</h3>
				<div class="small muted" style="line-height:1.7">
					<strong style="color:var(--text)">Gmail:</strong> Enable 2FA, then create an App Password at myaccount.google.com/apppasswords. Use the 16-char code as password.<br/>
					<strong style="color:var(--text)">Outlook:</strong> Use your regular password. If 2FA is on, create an App Password in your Microsoft account security settings.<br/>
					<strong style="color:var(--text)">Custom:</strong> Enter your provider's IMAP/SMTP host and port. Port 993 = SSL, 587 = STARTTLS.
				</div>
			</section>
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

	/* Organizations tab */
	.org-list {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		margin-bottom: 8px;
	}

	.org-card {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 8px 14px;
		border: 1px solid #1e1e2e;
		border-radius: 6px;
		background: transparent;
		color: #cdd6f4;
		cursor: pointer;
		font-family: inherit;
		font-size: 13px;
		transition: all 0.15s;
	}

	.org-card:hover { background: #1a1a25; border-color: #89b4fa44; }
	.org-card.active { border-color: #89b4fa; background: rgba(137,180,250,0.08); }

	.org-card-dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		flex-shrink: 0;
	}

	.org-card-name { font-weight: 500; }

	.org-card-role {
		font-size: 10px;
		color: #6c7086;
		padding: 1px 6px;
		background: #1a1a25;
		border-radius: 3px;
	}

	.teams-grid {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		margin-bottom: 8px;
	}

	.team-card {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 8px 14px;
		border: 1px solid #1e1e2e;
		border-radius: 6px;
		background: transparent;
		color: #cdd6f4;
		cursor: pointer;
		font-family: inherit;
		font-size: 13px;
		transition: all 0.15s;
	}

	.team-card:hover { background: #1a1a25; border-color: #89b4fa44; }
	.team-card.active { border-color: #89b4fa; background: rgba(137,180,250,0.08); }

	.team-dot {
		width: 10px;
		height: 10px;
		border-radius: 50%;
		flex-shrink: 0;
	}

	.team-card-info {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
	}

	.team-card-name { font-weight: 500; }

	.team-card-count {
		font-size: 10px;
		color: #6c7086;
	}

	.team-badge {
		font-size: 10px;
		padding: 1px 6px;
		border: 1px solid;
		border-radius: 3px;
		background: transparent;
	}

	.org-sub-tabs {
		display: flex;
		gap: 4px;
		margin: 16px 0 12px;
		border-bottom: 1px solid #1e1e2e;
		padding-bottom: 8px;
	}

	.org-sub-tab {
		padding: 6px 14px;
		border: none;
		border-radius: 4px;
		background: transparent;
		color: #6c7086;
		cursor: pointer;
		font-family: inherit;
		font-size: 12px;
		transition: all 0.15s;
	}

	.org-sub-tab:hover { color: #cdd6f4; background: #1a1a25; }
	.org-sub-tab.active { color: #89b4fa; background: rgba(137,180,250,0.1); }

	.members-list {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.member-row {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 8px 10px;
		border-radius: 6px;
		background: #0e0e16;
	}

	.member-avatar {
		width: 32px;
		height: 32px;
		border-radius: 50%;
		display: flex;
		align-items: center;
		justify-content: center;
		font-weight: 600;
		font-size: 14px;
		color: #0a0a0f;
		flex-shrink: 0;
	}

	.member-info {
		flex: 1;
		display: flex;
		flex-direction: column;
		gap: 1px;
		min-width: 0;
	}

	.member-name { font-size: 13px; font-weight: 500; }
	.member-email { font-size: 11px; color: #6c7086; }

	.role-select {
		width: 100px;
		font-size: 11px;
		padding: 4px 6px;
	}

	.btn-icon {
		background: none;
		border: none;
		cursor: pointer;
		color: #6c7086;
		font-size: 14px;
		padding: 4px 6px;
		border-radius: 4px;
		transition: all 0.15s;
	}

	.btn-icon:hover { background: #1a1a25; }
	.btn-icon.danger { color: #f38ba8; }
	.btn-icon.danger:hover { background: rgba(243,139,168,0.1); }

	.invite-row {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 6px 8px;
		border-radius: 4px;
		margin-bottom: 4px;
		background: #0e0e16;
	}

	.invite-token {
		font-family: 'JetBrains Mono', monospace;
		font-size: 11px;
		color: #a6e3a1;
		background: #1a1a25;
		padding: 2px 8px;
		border-radius: 3px;
		max-width: 200px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.invite-meta {
		flex: 1;
		font-size: 11px;
		color: #6c7086;
	}

	.setting-row {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 6px 0;
		border-bottom: 1px solid #1e1e2e11;
	}

	.setting-label {
		width: 160px;
		font-size: 12px;
		color: #6c7086;
		flex-shrink: 0;
	}

	.setting-value {
		font-size: 13px;
	}

	.flash {
		padding: 8px 14px;
		border-radius: 6px;
		background: rgba(137,180,250,0.1);
		border: 1px solid #89b4fa44;
		color: #89b4fa;
		font-size: 12px;
		margin-bottom: 12px;
	}

	/* ── Theme picker ── */
	.theme-grid {
		display: grid;
		grid-template-columns: repeat(2, 1fr);
		gap: 12px;
		margin-top: 8px;
	}

	.theme-card {
		position: relative;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 8px;
		padding: 20px 16px;
		border-radius: 10px;
		border: 2px solid #1e1e2e;
		background: #12121a;
		color: #cdd6f4;
		cursor: pointer;
		font-family: 'Inter', -apple-system, sans-serif;
		transition: border-color 0.15s, background 0.15s, transform 0.1s;
	}

	.theme-card:hover {
		border-color: #89b4fa;
		transform: translateY(-2px);
	}

	.theme-card.active {
		border-color: var(--pan-accent, #89b4fa);
		background: var(--pan-surface2, #1a1a25);
		box-shadow: 0 0 12px var(--pan-glow, rgba(137,180,250,0.2));
	}

	.theme-emoji {
		font-size: 28px;
		line-height: 1;
	}

	.theme-label {
		font-size: 13px;
		font-weight: 600;
		color: var(--pan-text, #cdd6f4);
	}

	.theme-check {
		position: absolute;
		top: 8px;
		right: 10px;
		font-size: 14px;
		color: var(--pan-accent, #89b4fa);
		font-weight: 700;
	}
</style>
