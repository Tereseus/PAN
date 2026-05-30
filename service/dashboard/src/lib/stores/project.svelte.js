// project.svelte.js — active project + its task list and custom sections.
// Populated by `loadTerminalSidebar(projectId, projectName)` in +page.svelte
// whenever the active tab changes. Read by ProjectPanel, TasksPanel, BugsPanel.
//
// The right-column milestone filter (clicking a milestone in ProjectPanel
// scopes TasksPanel to that milestone) lives here too so the two widgets
// can coordinate without prop drilling.

import { api } from '$lib/api.js';

export const project = $state({
	/** @type {{name:string, percentage:number, done_tasks:number, total_tasks:number, milestones:Array<{id, name, percentage}>, session_count:number}|null} */
	data: null,
	/** @type {{tasks:Array<{id, title, status, priority, milestone_id}>, milestones:Array}|null} */
	tasks: null,
	/** @type {Array<{id, name, items:Array}>} */
	sections: [],
	/** When set, TasksPanel filters to just this milestone. */
	milestoneFilter: null,
});

/** Single source of truth for cycling task status. Called from TasksPanel + BugsPanel. */
export async function cycleTask(taskId, currentStatus, reloadFn) {
	const next = currentStatus === 'todo' ? 'in_progress'
	          : currentStatus === 'in_progress' ? 'done'
	          : 'todo';
	try {
		await fetch('/dashboard/api/tasks/' + taskId, {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ status: next })
		});
		if (typeof reloadFn === 'function') await reloadFn();
	} catch {}
}

/** Toggle the milestone filter — clicking the same milestone twice clears it. */
export function filterByMilestone(milestoneId) {
	project.milestoneFilter = project.milestoneFilter === milestoneId ? null : milestoneId;
}
