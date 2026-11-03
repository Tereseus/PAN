<!-- ProjectPanel.svelte — project + milestone progress widget. -->
<script>
	// 2026-05-28: migrated to read from `project` store + use the store's
	// filterByMilestone helper directly. No props needed.
	import { project, filterByMilestone } from '$lib/stores/project.svelte.js';

	function pctColor(pct) {
		if (pct < 50) return 'green';
		if (pct < 80) return 'yellow';
		return 'red';
	}
</script>

{#if project.data}
	<div class="project-info">
		<div class="project-name">{project.data.name}</div>
		<div class="project-progress-row">
			<span class="project-pct">{project.data.percentage}%</span>
			<span class="project-count">{project.data.done_tasks}/{project.data.total_tasks}</span>
		</div>
		<div class="progress-bar">
			<div class="progress-fill {pctColor(project.data.percentage)}" style="width:{project.data.percentage}%"></div>
		</div>
		<div class="project-sessions">{project.data.session_count} sessions</div>
	</div>
	{#if project.data.milestones}
		{#each project.data.milestones as m}
			<div class="milestone" onclick={() => filterByMilestone(m.id)}>
				<div class="milestone-row">
					<span class="milestone-name">{m.name}</span>
					<span class="milestone-pct">{m.percentage}%</span>
				</div>
				<div class="progress-bar small">
					<div class="progress-fill {pctColor(m.percentage)}" style="width:{m.percentage}%"></div>
				</div>
			</div>
		{/each}
	{/if}
{:else}
	<div class="empty-state">Select a project</div>
{/if}
