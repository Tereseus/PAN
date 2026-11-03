<!--
  TasksPanel.svelte — milestone-grouped task list with click-to-cycle status.
  Parent owns tasksData + cycleTask (project loader still in +page.svelte
  because cycleTask uses the active tab).
-->
<script>
	// 2026-05-28: migrated to read tasksData + milestoneFilter from `project`
	// store. cycleTask is provided as a callback prop because the actual
	// status update calls back into the parent's loadTerminalSidebar to
	// re-fetch (which needs active tab context).
	import { project } from '$lib/stores/project.svelte.js';

	let {
		/** @type {(id:string|number, status:string) => void} */
		onCycle = () => {},
	} = $props();

	const view = $derived.by(() => {
		const tasksData = project.tasks;
		const milestoneFilter = project.milestoneFilter;
		if (!tasksData?.tasks) return { byMilestone: {}, noMilestone: [], milestones: [] };
		const byMilestone = {};
		const noMilestone = [];
		for (const t of tasksData.tasks) {
			if (milestoneFilter && t.milestone_id !== milestoneFilter && t.milestone_id !== null) continue;
			if (milestoneFilter && t.milestone_id === null) continue;
			if (t.milestone_id) {
				if (!byMilestone[t.milestone_id]) byMilestone[t.milestone_id] = [];
				byMilestone[t.milestone_id].push(t);
			} else {
				noMilestone.push(t);
			}
		}
		return { byMilestone, noMilestone, milestones: tasksData.milestones || [] };
	});
</script>

{#each view.milestones as m}
	{#if view.byMilestone[m.id]?.length > 0}
		<div class="task-group-header">{m.name}</div>
		{#each view.byMilestone[m.id] as t}
			<div class="task-row" onclick={() => onCycle(t.id, t.status)}>
				<span class="task-icon" class:done={t.status === 'done'} class:in-progress={t.status === 'in_progress'}>
					{t.status === 'done' ? '✓' : t.status === 'in_progress' ? '◆' : '○'}
				</span>
				<span class="task-title" class:done={t.status === 'done'}>{t.title}</span>
			</div>
		{/each}
	{/if}
{/each}
{#if view.noMilestone.length > 0}
	<div class="task-group-header">Other</div>
	{#each view.noMilestone as t}
		<div class="task-row" onclick={() => onCycle(t.id, t.status)}>
			<span class="task-icon" class:done={t.status === 'done'} class:in-progress={t.status === 'in_progress'}>
				{t.status === 'done' ? '✓' : t.status === 'in_progress' ? '◆' : '○'}
			</span>
			<span class="task-title" class:done={t.status === 'done'}>{t.title}</span>
		</div>
	{/each}
{/if}
