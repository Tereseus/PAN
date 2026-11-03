<!--
  BugsPanel.svelte — bug-priority subset of tasksData. Click to cycle status.
-->
<script>
	// 2026-05-28: migrated to read tasksData from `project` store.
	import { project } from '$lib/stores/project.svelte.js';

	let {
		/** @type {(id:string|number, status:string) => void} */
		onCycle = () => {},
	} = $props();

	const bugs = $derived.by(() => {
		if (!project.tasks?.tasks) return [];
		const bugKeywords = /bug|fix|issue|error|broken|crash|fail/i;
		return project.tasks.tasks.filter(t => t.priority > 0 || bugKeywords.test(t.title));
	});
</script>

{#if bugs.length === 0}
	<div class="empty-state">No bugs tracked</div>
{:else}
	{#each bugs as t}
		<div class="task-row" onclick={() => onCycle(t.id, t.status)}>
			<span class="task-icon bug" class:done={t.status === 'done'}>
				{t.status === 'done' ? '✓' : '⚠'}
			</span>
			<span class="task-title" class:done={t.status === 'done'}>{t.title}</span>
		</div>
	{/each}
{/if}
