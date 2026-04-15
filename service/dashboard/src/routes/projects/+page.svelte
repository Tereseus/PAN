<script>
	import { api } from '$lib/api.js';
	import { goto } from '$app/navigation';
	import { base } from '$app/paths';

	let projectsData = $state(null);
	let loading = $state(true);

	// Overall stats
	let totalTasks = $state(0);
	let totalDone = $state(0);

	function pctColor(pct) {
		if (pct >= 80) return 'green';
		if (pct >= 30) return 'blue';
		if (pct > 0) return 'yellow';
		return 'gray';
	}

	function pctCssColor(pct) {
		if (pct >= 80) return '#a6e3a1';
		if (pct >= 30) return '#89b4fa';
		if (pct > 0) return '#f9e2af';
		return '#6c7086';
	}

	async function loadProjects() {
		loading = true;
		try {
			const data = await api('/dashboard/api/progress');
			projectsData = data;
			const projects = data.projects || [];
			totalTasks = 0;
			totalDone = 0;
			for (const p of projects) {
				totalTasks += p.total_tasks;
				totalDone += p.done_tasks;
			}
		} catch {
			projectsData = { projects: [] };
		}
		loading = false;
	}

	function openKanban(project) {
		goto(`${base}/kanban?project=${project.id}`);
	}

	async function unlinkProject(id, name) {
		if (!confirm(`Unlink "${name}" from PAN?\n\nThis removes the project from PAN's dashboard and deletes the .pan file. Your actual project files are not touched.`)) return;
		if (!confirm('Are you sure? This cannot be undone.')) return;
		try {
			await api(`/dashboard/api/projects/${id}`, { method: 'DELETE' });
			await loadProjects();
		} catch {}
	}

	$effect(() => {
		loadProjects();
	});

	let overallPct = $derived(totalTasks > 0 ? Math.round(totalDone / totalTasks * 100) : 0);
	let projects = $derived(projectsData?.projects || []);
</script>

<div class="projects-page">
	{#if loading}
		<div class="muted">Loading projects...</div>
	{:else if projects.length === 0}
		<div class="muted">No projects registered. Create a .pan file in a project directory.</div>
	{:else}
		<!-- Overall Stats -->
		{#if totalTasks > 0}
			<div class="overall-stats">
				<div class="overall-header">
					<span class="overall-pct" style="color: {pctCssColor(overallPct)}">{overallPct}%</span>
					<span class="overall-label">{totalDone} / {totalTasks} tasks complete across all projects</span>
				</div>
				<div class="progress-bar large">
					<div class="progress-fill {pctColor(overallPct)}" style="width: {overallPct}%"></div>
				</div>
			</div>
		{/if}

		<!-- Project Cards Grid -->
		<div class="project-grid">
			{#each projects as p}
				{@const clr = pctColor(p.percentage)}
				<div class="project-card" onclick={() => openKanban(p)}>
					<div class="card-header">
						<h3>{p.name}</h3>
						<button class="unlink-btn" onclick={(e) => { e.stopPropagation(); unlinkProject(p.id, p.name); }} title="Unlink Project From PAN">&times;</button>
					</div>
					{#if p.classification}
						<div class="card-class">{p.classification}</div>
					{/if}
					{#if p.description}
						<div class="card-desc">{p.description}</div>
					{/if}
					<div class="card-pct" style="color: {pctCssColor(p.percentage)}">{p.percentage}%</div>
					<div class="progress-bar">
						<div class="progress-fill {clr}" style="width: {p.percentage}%"></div>
					</div>
					<div class="card-meta">{p.done_tasks}/{p.total_tasks} tasks &middot; {p.session_count} sessions</div>

					{#if p.milestones && p.milestones.length > 0}
						<div class="milestones-mini">
							{#each p.milestones as m}
								{@const mclr = pctColor(m.percentage)}
								<div class="milestone-row">
									<span class="milestone-name">{m.name}</span>
									<div class="milestone-bar">
										<div class="progress-fill {mclr}" style="width: {m.percentage}%"></div>
									</div>
									<span class="milestone-pct">{m.percentage}%</span>
								</div>
							{/each}
						</div>
					{/if}
				</div>
			{/each}
		</div>

		<!-- Click any project card to open its Kanban board -->
	{/if}
</div>

<style>
	.projects-page {
		padding: 24px;
		overflow-y: auto;
		height: 100%;
	}

	.muted { color: #6c7086; font-size: 14px; }
	.muted-sm { color: #6c7086; font-size: 12px; }

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

	/* Overall */
	.overall-stats {
		background: #12121a;
		border: 1px solid #1e1e2e;
		border-radius: 8px;
		padding: 20px;
		margin-bottom: 20px;
	}

	.overall-header {
		display: flex;
		align-items: baseline;
		gap: 12px;
		margin-bottom: 8px;
	}

	.overall-pct { font-size: 32px; font-weight: 700; }
	.overall-label { color: #6c7086; font-size: 14px; }

	/* Progress bars */
	.progress-bar {
		height: 6px;
		background: #1e1e2e;
		border-radius: 3px;
		overflow: hidden;
	}

	.progress-bar.large { height: 12px; border-radius: 6px; }

	.progress-fill {
		height: 100%;
		border-radius: inherit;
		transition: width 0.3s;
	}

	.progress-fill.green { background: #a6e3a1; }
	.progress-fill.blue { background: #89b4fa; }
	.progress-fill.yellow { background: #f9e2af; }
	.progress-fill.gray { background: #6c7086; }

	/* Grid */
	.project-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
		gap: 16px;
	}

	.project-card {
		background: #12121a;
		border: 1px solid #1e1e2e;
		border-radius: 8px;
		padding: 16px;
		cursor: pointer;
		transition: border-color 0.15s;
	}

	.project-card:hover { border-color: #89b4fa; }

	.card-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
	}

	.card-header h3 {
		font-size: 16px;
		font-weight: 600;
		color: #cdd6f4;
		margin: 0;
	}

	.unlink-btn {
		background: none;
		border: none;
		color: #6c7086;
		font-size: 16px;
		cursor: pointer;
		opacity: 0.4;
		padding: 0 4px;
	}

	.unlink-btn:hover { opacity: 1; color: #f38ba8; }

	.card-class { font-size: 11px; color: #89b4fa; margin: 4px 0; }
	.card-desc { font-size: 12px; color: #6c7086; margin-bottom: 8px; line-height: 1.4; }
	.card-pct { font-size: 24px; font-weight: 700; margin-bottom: 4px; }
	.card-meta { font-size: 12px; color: #6c7086; margin-top: 6px; }

	/* Milestones mini */
	.milestones-mini { margin-top: 12px; }

	.milestone-row {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 4px 0;
		border-top: 1px solid #1e1e2e;
	}

	.milestone-name { flex: 1; font-size: 12px; color: #cdd6f4; }

	.milestone-bar {
		width: 80px;
		height: 4px;
		background: #1e1e2e;
		border-radius: 2px;
		overflow: hidden;
	}

	.milestone-pct { font-size: 11px; color: #6c7086; width: 30px; text-align: right; }

	/* Detail Panel */
	.detail-panel {
		background: #12121a;
		border: 1px solid #1e1e2e;
		border-radius: 8px;
		margin-top: 20px;
	}

	.detail-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 16px;
		border-bottom: 1px solid #1e1e2e;
	}

	.detail-header h3 {
		font-size: 18px;
		color: #cdd6f4;
		margin: 0;
	}

	.milestone-section { border-bottom: 1px solid #1e1e2e; }

	.milestone-header {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 12px 16px;
		background: #0e0e16;
	}

	.milestone-header strong { flex: 1; font-size: 14px; color: #cdd6f4; }

	.task-item {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 8px 16px;
		cursor: pointer;
		transition: background 0.1s;
	}

	.task-item:hover { background: #1a1a25; }

	.task-check {
		width: 20px;
		height: 20px;
		border: 2px solid #6c7086;
		border-radius: 4px;
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: 12px;
		flex-shrink: 0;
		color: transparent;
	}

	.task-check.done {
		background: #a6e3a1;
		border-color: #a6e3a1;
		color: #0a0a0f;
	}

	.task-check.in_progress {
		background: #f9e2af;
		border-color: #f9e2af;
		color: #0a0a0f;
	}

	.task-check.backlog {
		background: #585b70;
		border-color: #585b70;
		color: #cdd6f4;
	}

	.task-title { font-size: 13px; color: #cdd6f4; }
	.task-title.done { text-decoration: line-through; color: #6c7086; }

	.add-hint {
		text-align: center;
		padding: 8px;
		font-size: 11px;
		color: #6c7086;
	}
</style>
