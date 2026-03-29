<script>
	import { api } from '$lib/api.js';

	let activeTab = $state('jobs');

	const tabs = [
		{ id: 'jobs', label: 'Jobs' },
		{ id: 'stacks', label: 'Tech Stacks' },
		{ id: 'scout', label: 'Scout' },
		{ id: 'approvals', label: 'Approvals' },
		{ id: 'autodev', label: 'AutoDev' },
	];

	// Jobs state
	let features = $state({});
	let jobsLoading = $state(true);

	// Tech Stacks state
	let stacks = $state([]);
	let stacksLoading = $state(true);
	let scanning = $state(false);

	// Scout state
	let scoutFindings = $state([]);
	let scoutTopics = $state([]);
	let scoutLoading = $state(true);
	let newTopic = $state('');
	let scouting = $state(false);

	// Approvals state
	let pendingApprovals = $state([]);
	let approvedItems = $state([]);
	let approvalsLoading = $state(true);

	// AutoDev state
	let autodevConfig = $state({ enabled: false, run_at_hour: 2, max_files_per_run: 5, enabled_projects: [], allowed_actions: [], scout_topics: [] });
	let autodevLog = $state([]);
	let autodevProjects = $state([]);
	let autodevLoading = $state(true);
	let autodevRunning = $state(false);

	const featureNames = {
		classifier: 'Classifier',
		project_sync: 'Project Sync',
		scout: 'Scout',
		dream: 'Dream',
		autodev: 'AutoDev',
	};

	const featureDescs = {
		classifier: 'Extracts memories from events',
		project_sync: 'Scans disk for .pan files',
		scout: 'Discovers new AI tools & CLIs',
		dream: 'Consolidates memories into state file',
		autodev: 'Automated development tasks',
	};

	const statusColors = {
		running: '#a6e3a1', ready: '#89b4fa', connected: '#a6e3a1',
		online: '#a6e3a1', configured: '#89b4fa', training: '#f9e2af',
		downloading: '#f9e2af', collecting: '#f9e2af', stopped: '#6c7086',
		offline: '#6c7086', not_started: '#6c7086', error: '#f38ba8',
		unknown: '#6c7086',
	};

	async function loadJobs() {
		jobsLoading = true;
		try {
			const data = await api('/api/automation/status');
			features = data.features || {};
		} catch { features = {}; }
		jobsLoading = false;
	}

	async function toggleFeature(key, enabled) {
		try {
			await api('/api/automation/toggle', {
				method: 'POST',
				body: JSON.stringify({ feature: key, enabled })
			});
		} catch (e) { console.error('Toggle failed:', e); }
	}

	async function loadStacks() {
		stacksLoading = true;
		try {
			const data = await api('/api/v1/stacks');
			stacks = Array.isArray(data) ? data : [];
		} catch { stacks = []; }
		stacksLoading = false;
	}

	async function rescanStacks() {
		scanning = true;
		try {
			await api('/api/v1/stacks/scan', { method: 'POST' });
			await new Promise(r => setTimeout(r, 2000));
			await loadStacks();
		} catch {}
		scanning = false;
	}

	async function loadScout() {
		scoutLoading = true;
		try {
			const raw = await api('/dashboard/api/scout');
			const data = raw.findings || raw;
			scoutFindings = Array.isArray(data) ? data.slice(0, 15) : [];
		} catch { scoutFindings = []; }
		await loadScoutTopics();
		scoutLoading = false;
	}

	async function loadScoutTopics() {
		try {
			const row = await api('/api/v1/autodev/config');
			scoutTopics = row.scout_topics || [];
		} catch { scoutTopics = []; }
	}

	async function addTopic() {
		const t = newTopic.trim();
		if (!t) return;
		newTopic = '';
		try {
			const config = await api('/api/v1/autodev/config');
			config.scout_topics = config.scout_topics || [];
			if (!config.scout_topics.includes(t)) config.scout_topics.push(t);
			await api('/api/v1/autodev/config', { method: 'PUT', body: JSON.stringify(config) });
			scoutTopics = config.scout_topics;
		} catch {}
	}

	async function removeTopic(topic) {
		try {
			const config = await api('/api/v1/autodev/config');
			config.scout_topics = (config.scout_topics || []).filter(t => t !== topic);
			await api('/api/v1/autodev/config', { method: 'PUT', body: JSON.stringify(config) });
			scoutTopics = config.scout_topics;
		} catch {}
	}

	async function runScout() {
		scouting = true;
		try {
			await api('/dashboard/api/scout/run', { method: 'POST' });
			await new Promise(r => setTimeout(r, 5000));
			await loadScout();
		} catch {}
		scouting = false;
	}

	async function loadApprovals() {
		approvalsLoading = true;
		try {
			const [rawNew, rawApproved] = await Promise.all([
				api('/dashboard/api/scout?status=new'),
				api('/dashboard/api/scout?status=approved')
			]);
			pendingApprovals = Array.isArray(rawNew.findings || rawNew) ? (rawNew.findings || rawNew).slice(0, 10) : [];
			approvedItems = Array.isArray(rawApproved.findings || rawApproved) ? (rawApproved.findings || rawApproved).slice(0, 5) : [];
		} catch {
			pendingApprovals = [];
			approvedItems = [];
		}
		approvalsLoading = false;
	}

	async function approveItem(id) {
		try {
			await api(`/dashboard/api/scout/${id}`, { method: 'PATCH', body: JSON.stringify({ status: 'approved' }) });
			await loadApprovals();
		} catch {}
	}

	async function dismissItem(id) {
		try {
			await api(`/dashboard/api/scout/${id}`, { method: 'PATCH', body: JSON.stringify({ status: 'dismissed' }) });
			await loadApprovals();
		} catch {}
	}

	async function installItem(id, name) {
		try {
			await api('/api/v1/terminal/send', {
				method: 'POST',
				body: JSON.stringify({ text: `npx -y ${name}`, session_id: 'dash-pan' })
			});
			await api(`/dashboard/api/scout/${id}`, { method: 'PATCH', body: JSON.stringify({ status: 'integrated' }) });
			await loadApprovals();
		} catch {}
	}

	async function loadAutodev() {
		autodevLoading = true;
		try {
			const [config, projects, logs] = await Promise.all([
				api('/api/v1/autodev/config'),
				api('/dashboard/api/projects'),
				api('/api/v1/autodev/log').catch(() => [])
			]);
			autodevConfig = {
				enabled: config.enabled || false,
				run_at_hour: config.run_at_hour ?? 2,
				max_files_per_run: config.max_files_per_run ?? 5,
				enabled_projects: config.enabled_projects || [],
				allowed_actions: config.allowed_actions || [],
				scout_topics: config.scout_topics || [],
			};
			autodevProjects = Array.isArray(projects) ? projects : [];
			autodevLog = Array.isArray(logs) ? logs : [];
		} catch {}
		autodevLoading = false;
	}

	async function saveAutodevConfig() {
		try {
			await api('/api/v1/autodev/config', {
				method: 'PUT',
				body: JSON.stringify(autodevConfig)
			});
		} catch (e) { console.error('Save autodev config failed:', e); }
	}

	function toggleAction(action) {
		const actions = autodevConfig.allowed_actions || [];
		if (actions.includes(action)) {
			autodevConfig.allowed_actions = actions.filter(a => a !== action);
		} else {
			autodevConfig.allowed_actions = [...actions, action];
		}
		saveAutodevConfig();
	}

	function toggleProject(id) {
		const projects = autodevConfig.enabled_projects || [];
		if (projects.includes(id)) {
			autodevConfig.enabled_projects = projects.filter(p => p !== id);
		} else {
			autodevConfig.enabled_projects = [...projects, id];
		}
		saveAutodevConfig();
	}

	async function runAutodev() {
		autodevRunning = true;
		try {
			await api('/api/v1/autodev/run', { method: 'POST' });
			await new Promise(r => setTimeout(r, 10000));
			await loadAutodev();
		} catch {}
		autodevRunning = false;
	}

	function fmtTime(ts) {
		if (!ts) return '';
		const d = new Date(ts);
		return d.toLocaleString();
	}

	$effect(() => {
		loadJobs();
		loadStacks();
		loadScout();
		loadApprovals();
		loadAutodev();
	});
</script>

<div class="automation-layout">
	<aside class="sub-tabs">
		{#each tabs as tab}
			<button
				class="sub-tab"
				class:active={activeTab === tab.id}
				onclick={() => activeTab = tab.id}
			>
				{tab.label}
			</button>
		{/each}
	</aside>

	<div class="panel">
		<!-- Jobs -->
		{#if activeTab === 'jobs'}
			<h2>Scheduled Jobs</h2>
			{#if jobsLoading}
				<div class="muted">Loading...</div>
			{:else if Object.keys(features).length === 0}
				<div class="muted">No jobs found.</div>
			{:else}
				<div class="jobs-list">
					{#each Object.entries(features) as [key, f]}
						<div class="job-row">
							{#if f.required}
								<span class="dot" style="background: #a6e3a1"></span>
							{:else}
								<label class="toggle">
									<input type="checkbox" checked={f.enabled} onchange={(e) => toggleFeature(key, e.target.checked)} />
									<span class="slider"></span>
								</label>
							{/if}
							<div class="job-info">
								<div class="job-name">
									{featureNames[key] || key}
									{#if f.required}
										<span class="tag-muted">(Required)</span>
									{/if}
								</div>
								<div class="job-desc">{featureDescs[key] || ''}</div>
							</div>
							<span class="job-interval">Every {f.interval}</span>
						</div>
					{/each}
				</div>
			{/if}
		{/if}

		<!-- Tech Stacks -->
		{#if activeTab === 'stacks'}
			<div class="panel-header">
				<h2>Project Tech Stacks</h2>
				<button class="btn" onclick={rescanStacks} disabled={scanning}>
					{scanning ? 'Scanning...' : 'Rescan'}
				</button>
			</div>
			{#if stacksLoading}
				<div class="muted">Loading...</div>
			{:else if stacks.length === 0}
				<div class="muted">No stacks detected. Click "Rescan" to scan projects.</div>
			{:else}
				<div class="stacks-grid">
					{#each stacks as s}
						<div class="stack-card">
							<div class="stack-name">{s.project_name}</div>
							<div class="tag-row">
								{#each (s.runtimes || []) as r}
									<span class="tag runtime">{r}</span>
								{/each}
								{#each (s.frameworks || []) as f}
									<span class="tag framework">{f}</span>
								{/each}
							</div>
							<div class="tag-row">
								{#each Object.entries(s.languages || {}).sort((a, b) => b[1] - a[1]).slice(0, 5) as [lang, count]}
									<span class="tag lang">{lang} ({count})</span>
								{/each}
							</div>
							<div class="tag-row">
								{#each (s.dependencies || []).slice(0, 8) as dep}
									<span class="tag dep">{dep}</span>
								{/each}
								{#if (s.dependencies || []).length > 8}
									<span class="muted-sm">+{s.dependencies.length - 8} more</span>
								{/if}
							</div>
						</div>
					{/each}
				</div>
			{/if}
		{/if}

		<!-- Scout -->
		{#if activeTab === 'scout'}
			<div class="panel-header">
				<h2>Scout Findings</h2>
				<button class="btn" onclick={runScout} disabled={scouting}>
					{scouting ? 'Scanning...' : 'Scan Now'}
				</button>
			</div>
			<div class="topics-section">
				<div class="muted-sm">Custom search topics (scout will look for these):</div>
				<div class="topic-input-row">
					<input
						type="text"
						class="input"
						placeholder="e.g. ESP32 BLE libraries, voice cloning, ..."
						bind:value={newTopic}
						onkeydown={(e) => { if (e.key === 'Enter') addTopic(); }}
					/>
					<button class="btn" onclick={addTopic}>Add</button>
				</div>
				<div class="topics-list">
					{#each scoutTopics as topic}
						<span class="topic-chip">
							{topic}
							<span class="topic-remove" onclick={() => removeTopic(topic)}>&times;</span>
						</span>
					{/each}
					{#if scoutTopics.length === 0}
						<span class="muted-sm">No custom topics</span>
					{/if}
				</div>
			</div>
			{#if scoutLoading}
				<div class="muted">Loading...</div>
			{:else if scoutFindings.length === 0}
				<div class="muted">No findings yet. Click "Scan Now" to discover tools.</div>
			{:else}
				<div class="findings-list">
					{#each scoutFindings as f}
						<div class="finding-row">
							<span class="finding-name">{f.tool_name}</span>
							<span class="finding-desc">{f.description || ''}</span>
							<span class="finding-score">{f.relevance_score || ''}</span>
							<span class="finding-status" class:new={f.status === 'new'}>{f.status}</span>
						</div>
					{/each}
				</div>
			{/if}
		{/if}

		<!-- Approvals -->
		{#if activeTab === 'approvals'}
			<h2>Approval Queue</h2>
			<div class="muted-sm" style="margin-bottom: 12px">Scout recommendations and AutoDev proposals awaiting your review</div>
			{#if approvalsLoading}
				<div class="muted">Loading...</div>
			{:else if pendingApprovals.length === 0 && approvedItems.length === 0}
				<div class="muted">No pending approvals</div>
			{:else}
				<div class="approvals-list">
					{#each pendingApprovals as f}
						<div class="approval-card pending">
							<div class="approval-info">
								<div class="approval-name">{f.tool_name}</div>
								<div class="approval-desc">{f.description || ''}</div>
								<div class="approval-relevance">{f.relevance || ''}</div>
							</div>
							<button class="btn btn-approve" onclick={() => approveItem(f.id)}>Approve</button>
							<button class="btn btn-dismiss" onclick={() => dismissItem(f.id)}>Dismiss</button>
						</div>
					{/each}
					{#each approvedItems as f}
						<div class="approval-card approved">
							<div class="approval-info">
								<div class="approval-name">{f.tool_name} <span class="approved-badge">Approved</span></div>
								<div class="approval-desc">{f.description || ''}</div>
							</div>
							<button class="btn" onclick={() => installItem(f.id, f.tool_name)}>Install</button>
						</div>
					{/each}
				</div>
			{/if}
		{/if}

		<!-- AutoDev -->
		{#if activeTab === 'autodev'}
			<div class="panel-header">
				<h2>AutoDev</h2>
				<button class="btn" onclick={runAutodev} disabled={autodevRunning || !autodevConfig.enabled}>
					{autodevRunning ? 'Running...' : 'Run Now'}
				</button>
			</div>
			<div class="danger-notice">
				Use at your own risk — AutoDev modifies code autonomously. Review all changes before committing.
			</div>
			{#if autodevLoading}
				<div class="muted">Loading config...</div>
			{:else}
				<div class="autodev-form">
					<label class="check-label">
						<input type="checkbox" bind:checked={autodevConfig.enabled} onchange={saveAutodevConfig} />
						<span>Enable AutoDev</span>
					</label>
					<div class="form-row">
						<label class="field-label">
							Run At Hour:
							<input type="number" class="input small" bind:value={autodevConfig.run_at_hour} min="0" max="23" onchange={saveAutodevConfig} />
						</label>
						<label class="field-label">
							Max Files/Run:
							<input type="number" class="input small" bind:value={autodevConfig.max_files_per_run} min="1" max="20" onchange={saveAutodevConfig} />
						</label>
					</div>
					<div class="field-label">Projects:</div>
					<div class="check-grid">
						{#each autodevProjects as p}
							<label class="check-chip">
								<input type="checkbox" checked={autodevConfig.enabled_projects?.includes(p.id)} onchange={() => toggleProject(p.id)} />
								{p.name}
							</label>
						{/each}
					</div>
					<div class="field-label">Allowed Actions:</div>
					<div class="check-grid">
						<label class="check-chip">
							<input type="checkbox" checked={autodevConfig.allowed_actions?.includes('new_files')} onchange={() => toggleAction('new_files')} />
							Create Files
						</label>
						<label class="check-chip">
							<input type="checkbox" checked={autodevConfig.allowed_actions?.includes('edit')} onchange={() => toggleAction('edit')} />
							Edit Files
						</label>
						<label class="check-chip">
							<input type="checkbox" checked={autodevConfig.allowed_actions?.includes('delete')} onchange={() => toggleAction('delete')} />
							Delete Files
						</label>
					</div>
				</div>

				<h3 class="section-title">Recent Activity</h3>
				{#if autodevLog.length === 0}
					<div class="muted">No activity yet</div>
				{:else}
					<div class="autodev-log">
						{#each autodevLog as entry}
							{@const d = typeof entry.data === 'string' ? JSON.parse(entry.data) : entry.data}
							<div class="log-entry" class:success={d.success} class:failure={!d.success}>
								<div class="log-header">
									<span class="log-task">{d.task_title || 'Unknown Task'}</span>
									<span class="log-time">{fmtTime(entry.created_at)}</span>
								</div>
								{#if d.summary}
									<div class="log-summary">{d.summary}</div>
								{/if}
							</div>
						{/each}
					</div>
				{/if}
			{/if}
		{/if}
	</div>
</div>

<style>
	.automation-layout {
		display: flex;
		height: 100%;
		overflow: hidden;
	}

	.sub-tabs {
		width: 160px;
		min-width: 160px;
		background: #0e0e16;
		border-right: 1px solid #1e1e2e;
		padding: 12px;
	}

	.sub-tab {
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
		font-family: 'Inter', sans-serif;
	}

	.sub-tab:hover { background: #1a1a25; color: #cdd6f4; }
	.sub-tab.active { background: rgba(137, 180, 250, 0.1); color: #89b4fa; }

	.panel {
		flex: 1;
		padding: 24px;
		overflow-y: auto;
	}

	h2 {
		font-size: 18px;
		font-weight: 500;
		margin-bottom: 16px;
		color: #cdd6f4;
	}

	h3.section-title {
		font-size: 13px;
		color: #6c7086;
		margin: 16px 0 8px;
	}

	.panel-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		margin-bottom: 16px;
	}

	.panel-header h2 { margin-bottom: 0; }

	.muted { color: #6c7086; font-size: 14px; }
	.muted-sm { color: #6c7086; font-size: 12px; }
	.tag-muted { font-size: 10px; color: #6c7086; }

	.btn {
		padding: 6px 14px;
		background: #1a1a25;
		color: #cdd6f4;
		border: 1px solid #1e1e2e;
		border-radius: 6px;
		font-size: 12px;
		cursor: pointer;
		font-family: 'Inter', sans-serif;
	}

	.btn:hover { background: #252530; }
	.btn:disabled { opacity: 0.4; cursor: not-allowed; }

	.btn-approve { background: #a6e3a1; color: #0a0a0f; border-color: #a6e3a1; font-size: 10px; padding: 3px 8px; }
	.btn-dismiss { font-size: 10px; padding: 3px 8px; }

	.input {
		background: #1a1a25;
		border: 1px solid #1e1e2e;
		border-radius: 6px;
		padding: 6px 10px;
		color: #cdd6f4;
		font-size: 12px;
		outline: none;
		font-family: 'Inter', sans-serif;
	}

	.input:focus { border-color: #89b4fa; }
	.input.small { width: 60px; }

	/* Toggle switch */
	.toggle {
		position: relative;
		display: inline-block;
		width: 36px;
		height: 20px;
		flex-shrink: 0;
	}

	.toggle input { opacity: 0; width: 0; height: 0; }

	.slider {
		position: absolute;
		cursor: pointer;
		top: 0; left: 0; right: 0; bottom: 0;
		background: #484f58;
		border-radius: 20px;
		transition: background 0.2s;
	}

	.slider::before {
		content: '';
		position: absolute;
		width: 16px;
		height: 16px;
		left: 2px;
		bottom: 2px;
		background: #fff;
		border-radius: 50%;
		transition: transform 0.2s;
		box-shadow: 0 1px 3px rgba(0,0,0,0.3);
	}

	.toggle input:checked + .slider { background: #a6e3a1; }
	.toggle input:checked + .slider::before { transform: translateX(16px); }

	/* Jobs */
	.jobs-list { display: grid; gap: 8px; }

	.job-row {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 10px;
		background: #0a0a0f;
		border-radius: 6px;
	}

	.dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		flex-shrink: 0;
	}

	.job-info { flex: 1; }
	.job-name { font-weight: 500; font-size: 13px; color: #cdd6f4; }
	.job-desc { font-size: 11px; color: #6c7086; }
	.job-interval { font-size: 11px; color: #6c7086; }

	/* Tech Stacks */
	.stacks-grid { display: grid; gap: 10px; }

	.stack-card {
		padding: 12px;
		background: #0a0a0f;
		border-radius: 6px;
	}

	.stack-name { font-weight: 500; font-size: 14px; margin-bottom: 6px; color: #cdd6f4; }

	.tag-row { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 4px; }

	.tag {
		padding: 2px 8px;
		border-radius: 4px;
		font-size: 11px;
		font-weight: 500;
	}

	.tag.runtime { background: #89b4fa; color: #fff; }
	.tag.framework { background: #a6e3a1; color: #0a0a0f; }
	.tag.lang { background: #1a1a25; color: #cdd6f4; font-size: 10px; padding: 1px 6px; border-radius: 3px; }
	.tag.dep { background: #0a0a0f; color: #cdd6f4; font-size: 10px; padding: 1px 6px; border-radius: 3px; border: 1px solid #1e1e2e; }

	/* Scout */
	.topics-section { margin-bottom: 16px; }

	.topic-input-row {
		display: flex;
		gap: 6px;
		margin-top: 4px;
	}

	.topic-input-row .input { flex: 1; }

	.topics-list {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
		margin-top: 6px;
	}

	.topic-chip {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		padding: 2px 8px;
		background: #1a1a25;
		border-radius: 12px;
		font-size: 11px;
		color: #cdd6f4;
	}

	.topic-remove { cursor: pointer; opacity: 0.5; }
	.topic-remove:hover { opacity: 1; }

	.findings-list { display: grid; gap: 6px; }

	.finding-row {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 6px 8px;
		background: #0a0a0f;
		border-radius: 4px;
		font-size: 12px;
	}

	.finding-name { font-weight: 500; flex-shrink: 0; color: #cdd6f4; }
	.finding-desc { color: #6c7086; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.finding-score { color: #6c7086; font-size: 10px; }

	.finding-status {
		font-size: 10px;
		padding: 2px 6px;
		border-radius: 3px;
		background: #1a1a25;
		color: #6c7086;
		text-transform: uppercase;
	}

	.finding-status.new { background: #89b4fa; color: #fff; }

	/* Approvals */
	.approvals-list { display: grid; gap: 8px; }

	.approval-card {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 10px;
		background: #0a0a0f;
		border-radius: 6px;
		font-size: 12px;
	}

	.approval-card.approved {
		background: rgba(166, 227, 161, 0.05);
		border: 1px solid rgba(166, 227, 161, 0.15);
	}

	.approval-info { flex: 1; }
	.approval-name { font-weight: 500; color: #cdd6f4; }
	.approval-desc { color: #6c7086; }
	.approval-relevance { color: #6c7086; font-size: 10px; margin-top: 2px; }
	.approved-badge { color: #a6e3a1; font-size: 10px; }

	/* AutoDev */
	.danger-notice {
		color: #f38ba8;
		font-size: 12px;
		margin-bottom: 12px;
		padding: 6px 10px;
		background: rgba(243, 139, 168, 0.07);
		border-radius: 4px;
	}

	.autodev-form { display: grid; gap: 10px; font-size: 13px; }

	.check-label {
		display: flex;
		align-items: center;
		gap: 8px;
		cursor: pointer;
		color: #cdd6f4;
	}

	.form-row { display: flex; gap: 16px; flex-wrap: wrap; }

	.field-label {
		font-size: 12px;
		color: #6c7086;
		display: flex;
		align-items: center;
		gap: 6px;
	}

	.check-grid { display: flex; gap: 8px; flex-wrap: wrap; }

	.check-chip {
		display: flex;
		align-items: center;
		gap: 4px;
		font-size: 12px;
		padding: 4px 8px;
		background: #0a0a0f;
		border-radius: 4px;
		cursor: pointer;
		color: #cdd6f4;
	}

	.autodev-log { display: grid; gap: 6px; }

	.log-entry {
		padding: 8px;
		background: #0a0a0f;
		border-radius: 6px;
		font-size: 12px;
		border-left: 3px solid #6c7086;
	}

	.log-entry.success { border-left-color: #a6e3a1; }
	.log-entry.failure { border-left-color: #f38ba8; }

	.log-header { display: flex; justify-content: space-between; }
	.log-task { font-weight: 500; color: #cdd6f4; }
	.log-time { color: #6c7086; }
	.log-summary { color: #6c7086; margin-top: 4px; }
</style>
