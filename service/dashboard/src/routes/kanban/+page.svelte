<script>
	import { api } from '$lib/api.js';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { base } from '$app/paths';

	const COLUMNS = [
		{ id: 'backlog', label: 'Backlog', color: '#585b70' },
		{ id: 'todo', label: 'To Do', color: '#89b4fa' },
		{ id: 'in_progress', label: 'In Progress', color: '#f9e2af' },
		{ id: 'done', label: 'Done', color: '#a6e3a1' },
	];

	const PRIORITY_LABELS = { 0: '', 1: 'P1', 2: 'P2' };
	const PRIORITY_COLORS = { 0: '', 1: '#fab387', 2: '#f38ba8' };

	const TYPE_LABELS = { task: 'Task', bug: 'Bug', feature: 'Feature' };
	const TYPE_COLORS = { task: '#6c7086', bug: '#f38ba8', feature: '#a6e3a1' };

	let projects = $state([]);
	let selectedProjectId = $state(null);
	let tasks = $state([]);
	let milestones = $state([]);
	let members = $state([]);
	let allTeams = $state([]);
	let projectTeamId = $state(null);
	let loading = $state(true);
	let filterMilestone = $state(null);
	let filterPriority = $state(null);
	let filterType = $state(null);
	let filterAssignee = $state(null);
	let searchQuery = $state('');

	// Drag state
	let draggedTask = $state(null);
	let dragOverColumn = $state(null);
	let dragOverTaskId = $state(null);

	// Edit modal
	let editTask = $state(null);
	let editTitle = $state('');
	let editDesc = $state('');
	let editPriority = $state(0);
	let editMilestone = $state(null);
	let editType = $state('task');
	let editAssignee = $state(null);

	// Add task
	let addingToColumn = $state(null);
	let addTitle = $state('');

	function goBack() {
		goto(`${base}/projects`);
	}

	async function loadProjects() {
		loading = true;
		try {
			const data = await api('/dashboard/api/progress');
			projects = (data.projects || []).filter(p => p.total_tasks > 0 || true);
			// Read project ID from URL query param
			const urlProjectId = parseInt(page.url?.searchParams?.get('project'));
			if (urlProjectId && projects.find(p => p.id === urlProjectId)) {
				selectedProjectId = urlProjectId;
			} else if (projects.length > 0 && !selectedProjectId) {
				selectedProjectId = projects[0].id;
			}
			if (selectedProjectId) await loadTasks();
		} catch { projects = []; }
		loading = false;
	}

	async function loadTasks() {
		if (!selectedProjectId) return;
		try {
			const data = await api(`/dashboard/api/projects/${selectedProjectId}/tasks`);
			tasks = data.tasks || [];
			milestones = data.milestones || [];
			members = data.members || [];
			projectTeamId = data.team_id ?? null;
		} catch { tasks = []; milestones = []; members = []; }
		try {
			const td = await api('/api/v1/teams');
			allTeams = td.teams || [];
		} catch { allTeams = []; }
	}

	function filteredTasks(status) {
		let result = tasks.filter(t => t.status === status);
		if (filterMilestone !== null) result = result.filter(t => t.milestone_id === filterMilestone);
		if (filterPriority !== null) result = result.filter(t => t.priority === filterPriority);
		if (filterType !== null) result = result.filter(t => (t.type || 'task') === filterType);
		if (filterAssignee !== null) result = result.filter(t => t.assigned_to === filterAssignee);
		if (searchQuery) {
			const q = searchQuery.toLowerCase();
			result = result.filter(t => t.title.toLowerCase().includes(q) || (t.description || '').toLowerCase().includes(q));
		}
		return result.sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
	}

	function columnCount(status) {
		return tasks.filter(t => t.status === status).length;
	}

	// --- Drag and Drop ---
	function onDragStart(e, task) {
		draggedTask = task;
		e.dataTransfer.effectAllowed = 'move';
		e.dataTransfer.setData('text/plain', task.id.toString());
	}

	function onDragOver(e, columnId, taskId = null) {
		e.preventDefault();
		e.dataTransfer.dropEffect = 'move';
		dragOverColumn = columnId;
		dragOverTaskId = taskId;
	}

	function onDragLeave(e, columnId) {
		if (dragOverColumn === columnId) {
			dragOverColumn = null;
			dragOverTaskId = null;
		}
	}

	async function onDrop(e, targetStatus) {
		e.preventDefault();
		if (!draggedTask) return;

		const task = draggedTask;
		draggedTask = null;
		dragOverColumn = null;
		dragOverTaskId = null;

		if (task.status === targetStatus && !dragOverTaskId) return;

		// Calculate new sort_order
		const columnTasks = filteredTasks(targetStatus);
		let newOrder = 0;
		if (dragOverTaskId) {
			const idx = columnTasks.findIndex(t => t.id === dragOverTaskId);
			newOrder = idx >= 0 ? idx : columnTasks.length;
		} else {
			newOrder = columnTasks.length;
		}

		// Optimistic update
		const oldStatus = task.status;
		task.status = targetStatus;
		task.sort_order = newOrder;
		tasks = [...tasks];

		try {
			// Build reorder payload for the target column
			const reordered = filteredTasks(targetStatus).map((t, i) => ({
				id: t.id,
				status: targetStatus,
				sort_order: i,
			}));
			await api('/dashboard/api/tasks/reorder', {
				method: 'PUT',
				body: JSON.stringify({ tasks: reordered }),
			});
			await loadTasks();
		} catch {
			task.status = oldStatus;
			tasks = [...tasks];
		}
	}

	// --- Task CRUD ---
	async function openEdit(task) {
		editTask = task;
		editTitle = task.title;
		editDesc = task.description || '';
		editPriority = task.priority || 0;
		editMilestone = task.milestone_id;
		editType = task.type || 'task';
		editAssignee = task.assigned_to;
	}

	async function saveEdit() {
		if (!editTask || !editTitle.trim()) return;
		try {
			await api(`/dashboard/api/tasks/${editTask.id}`, {
				method: 'PUT',
				body: JSON.stringify({
					title: editTitle.trim(),
					description: editDesc.trim() || null,
					priority: editPriority,
					milestone_id: editMilestone,
					type: editType,
					assigned_to: editAssignee,
				}),
			});
			editTask = null;
			await loadTasks();
		} catch {}
	}

	async function deleteTask(id) {
		if (!confirm('Delete this task?')) return;
		try {
			await api(`/dashboard/api/tasks/${id}`, { method: 'DELETE' });
			editTask = null;
			await loadTasks();
		} catch {}
	}

	async function startAdd(columnId) {
		addingToColumn = columnId;
		addTitle = '';
		// Focus input next tick
		setTimeout(() => {
			const el = document.getElementById('kanban-add-input');
			if (el) el.focus();
		}, 50);
	}

	async function submitAdd() {
		if (!addTitle.trim() || !selectedProjectId) return;
		try {
			await api(`/dashboard/api/projects/${selectedProjectId}/tasks`, {
				method: 'POST',
				body: JSON.stringify({
					title: addTitle.trim(),
					status: addingToColumn,
					priority: 0,
				}),
			});
			addingToColumn = null;
			addTitle = '';
			await loadTasks();
		} catch {}
	}

	function cancelAdd() {
		addingToColumn = null;
		addTitle = '';
	}

	function addKeydown(e) {
		if (e.key === 'Enter') submitAdd();
		if (e.key === 'Escape') cancelAdd();
	}

	function milestoneName(id) {
		const m = milestones.find(ms => ms.id === id);
		return m ? m.name : '';
	}

	async function selectProject(id) {
		selectedProjectId = id;
		await loadTasks();
	}

	async function assignTeam(teamId) {
		if (!selectedProjectId) return;
		try {
			await api(`/dashboard/api/projects/${selectedProjectId}/team`, {
				method: 'PUT',
				body: JSON.stringify({ team_id: teamId || null }),
			});
			projectTeamId = teamId || null;
			await loadTasks(); // reload members based on new team
		} catch (e) { console.error('Failed to assign team:', e); }
	}

	$effect(() => { loadProjects(); });

	let selectedProjectName = $derived(projects.find(p => p.id === selectedProjectId)?.name || '');
</script>

<div class="kanban-page">
	<!-- Header -->
	<div class="kanban-header">
		<div class="header-left">
			<button class="back-btn" onclick={goBack} title="Back to Projects">&larr;</button>
			<h2>{selectedProjectName || 'Kanban'}</h2>
			<select class="project-select" onchange={(e) => selectProject(parseInt(e.target.value))}>
				{#each projects as p}
					<option value={p.id} selected={p.id === selectedProjectId}>{p.name}</option>
				{/each}
			</select>
			{#if allTeams.length > 0}
				<select class="team-select" onchange={(e) => assignTeam(e.target.value ? parseInt(e.target.value) : null)}>
					<option value="" selected={!projectTeamId}>No team</option>
					{#each allTeams as t}
						<option value={t.id} selected={t.id === projectTeamId}>{t.name}</option>
					{/each}
				</select>
			{:else}
				<span class="no-teams-hint">No teams — create in Settings</span>
			{/if}
		</div>
		<div class="header-right">
			<input
				type="text"
				class="search-input"
				placeholder="Search tasks..."
				bind:value={searchQuery}
			/>
			<select class="filter-select" onchange={(e) => filterMilestone = e.target.value === '' ? null : parseInt(e.target.value)}>
				<option value="">All milestones</option>
				{#each milestones as m}
					<option value={m.id}>{m.name}</option>
				{/each}
			</select>
			<select class="filter-select" onchange={(e) => filterPriority = e.target.value === '' ? null : parseInt(e.target.value)}>
				<option value="">All priorities</option>
				<option value="2">Critical</option>
				<option value="1">High</option>
				<option value="0">Normal</option>
			</select>
			<select class="filter-select" onchange={(e) => filterType = e.target.value || null}>
				<option value="">All types</option>
				<option value="task">Task</option>
				<option value="bug">Bug</option>
				<option value="feature">Feature</option>
			</select>
			{#if members.length > 0}
				<select class="filter-select" onchange={(e) => filterAssignee = e.target.value === '' ? null : parseInt(e.target.value)}>
					<option value="">All assignees</option>
					{#each members as m}
						<option value={m.id}>{m.display_name || m.email}</option>
					{/each}
				</select>
			{/if}
		</div>
	</div>

	{#if loading}
		<div class="muted">Loading...</div>
	{:else if tasks.length === 0 && projects.length === 0}
		<div class="muted">No projects. Create a .pan file in a project directory.</div>
	{:else}
		<!-- Board -->
		<div class="board">
			{#each COLUMNS as col}
				{@const colTasks = filteredTasks(col.id)}
				<div
					class="column"
					class:drag-over={dragOverColumn === col.id}
					ondragover={(e) => onDragOver(e, col.id)}
					ondragleave={(e) => onDragLeave(e, col.id)}
					ondrop={(e) => onDrop(e, col.id)}
				>
					<div class="column-header">
						<span class="column-dot" style="background: {col.color}"></span>
						<span class="column-label">{col.label}</span>
						<span class="column-count">{columnCount(col.id)}</span>
						<button class="add-btn" onclick={() => startAdd(col.id)} title="Add task">+</button>
					</div>

					<div class="column-body">
						{#if addingToColumn === col.id}
							<div class="add-card">
								<input
									id="kanban-add-input"
									type="text"
									class="add-input"
									placeholder="Task title..."
									bind:value={addTitle}
									onkeydown={addKeydown}
									onblur={() => { if (!addTitle.trim()) cancelAdd(); }}
								/>
								<div class="add-actions">
									<button class="btn-sm primary" onclick={submitAdd}>Add</button>
									<button class="btn-sm" onclick={cancelAdd}>Cancel</button>
								</div>
							</div>
						{/if}

						{#each colTasks as task (task.id)}
							<div
								class="card"
								class:dragging={draggedTask?.id === task.id}
								class:drag-target={dragOverTaskId === task.id}
								draggable="true"
								ondragstart={(e) => onDragStart(e, task)}
								ondragover={(e) => onDragOver(e, col.id, task.id)}
								onclick={() => openEdit(task)}
							>
								<div class="card-top">
									<span class="card-title">{task.title}</span>
									<div class="card-badges">
										{#if (task.type || 'task') !== 'task'}
											<span class="type-badge" style="background: {TYPE_COLORS[task.type] || '#6c7086'}">{TYPE_LABELS[task.type] || task.type}</span>
										{/if}
										{#if task.priority > 0}
											<span class="priority-badge" style="background: {PRIORITY_COLORS[task.priority]}">{PRIORITY_LABELS[task.priority]}</span>
										{/if}
									</div>
								</div>
								{#if task.description}
									<div class="card-desc">{task.description.slice(0, 80)}{task.description.length > 80 ? '...' : ''}</div>
								{/if}
								<div class="card-meta">
									{#if task.milestone_id}
										<span class="card-milestone">{milestoneName(task.milestone_id)}</span>
									{/if}
									{#if task.assigned_name}
										<span class="card-assignee">{task.assigned_name}</span>
									{/if}
									{#if task.completed_at}
										<span class="card-date">Done {task.completed_at.split('T')[0]}</span>
									{/if}
								</div>
							</div>
						{/each}

						{#if colTasks.length === 0 && addingToColumn !== col.id}
							<div class="empty-col">No tasks</div>
						{/if}
					</div>
				</div>
			{/each}
		</div>
	{/if}
</div>

<!-- Edit Modal -->
{#if editTask}
	<div class="modal-overlay" onclick={() => editTask = null}>
		<div class="modal" onclick={(e) => e.stopPropagation()}>
			<div class="modal-header">
				<h3>Edit Task</h3>
				<button class="close-btn" onclick={() => editTask = null}>&times;</button>
			</div>
			<div class="modal-body">
				<label>Title</label>
				<input type="text" class="modal-input" bind:value={editTitle} />

				<label>Description</label>
				<textarea class="modal-textarea" bind:value={editDesc} rows="3"></textarea>

				<div class="modal-row">
					<div class="modal-field">
						<label>Type</label>
						<select class="modal-select" bind:value={editType}>
							<option value="task">Task</option>
							<option value="bug">Bug</option>
							<option value="feature">Feature</option>
						</select>
					</div>
					<div class="modal-field">
						<label>Priority</label>
						<select class="modal-select" bind:value={editPriority}>
							<option value={0}>Normal</option>
							<option value={1}>High</option>
							<option value={2}>Critical</option>
						</select>
					</div>
				</div>

				<div class="modal-row">
					<div class="modal-field">
						<label>Milestone</label>
						<select class="modal-select" bind:value={editMilestone}>
							<option value={null}>None</option>
							{#each milestones as m}
								<option value={m.id}>{m.name}</option>
							{/each}
						</select>
					</div>
					<div class="modal-field">
						<label>Assigned To</label>
						<select class="modal-select" bind:value={editAssignee}>
							<option value={null}>Unassigned</option>
							{#each members as m}
								<option value={m.id}>{m.display_name || m.email}</option>
							{/each}
						</select>
					</div>
				</div>

				<div class="modal-row">
					<div class="modal-field">
						<label>Status</label>
						<select class="modal-select" onchange={async (e) => {
							await api(`/dashboard/api/tasks/${editTask.id}`, {
								method: 'PUT',
								body: JSON.stringify({ status: e.target.value }),
							});
							editTask.status = e.target.value;
							await loadTasks();
						}}>
							{#each COLUMNS as col}
								<option value={col.id} selected={editTask.status === col.id}>{col.label}</option>
							{/each}
						</select>
					</div>
				</div>
			</div>
			<div class="modal-footer">
				<button class="btn-danger" onclick={() => deleteTask(editTask.id)}>Delete</button>
				<div class="modal-spacer"></div>
				<button class="btn-secondary" onclick={() => editTask = null}>Cancel</button>
				<button class="btn-primary" onclick={saveEdit}>Save</button>
			</div>
		</div>
	</div>
{/if}

<style>
	.kanban-page {
		height: 100%;
		display: flex;
		flex-direction: column;
		overflow: hidden;
		background: #0a0a0f;
	}

	.muted { color: #6c7086; font-size: 14px; padding: 24px; }

	/* Header */
	.kanban-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 12px 20px;
		border-bottom: 1px solid #1e1e2e;
		flex-shrink: 0;
		flex-wrap: wrap;
		gap: 8px;
	}

	.header-left {
		display: flex;
		align-items: center;
		gap: 12px;
	}

	.back-btn {
		background: none;
		border: 1px solid #1e1e2e;
		color: #6c7086;
		font-size: 16px;
		cursor: pointer;
		padding: 4px 10px;
		border-radius: 6px;
		font-family: 'Inter', sans-serif;
	}

	.back-btn:hover { color: #cdd6f4; border-color: #89b4fa; }

	.header-left h2 {
		font-size: 18px;
		font-weight: 600;
		color: #cdd6f4;
		margin: 0;
	}

	.header-right {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.team-select {
		background: #12121a;
		color: #a6e3a1;
		border: 1px solid #313244;
		border-radius: 6px;
		padding: 6px 10px;
		font-size: 12px;
		font-family: 'Inter', sans-serif;
		cursor: pointer;
	}

	.team-select:focus { border-color: #a6e3a1; outline: none; }

	.no-teams-hint {
		font-size: 11px;
		color: #585b70;
		font-style: italic;
		padding: 6px 0;
	}

	.project-select, .filter-select {
		background: #12121a;
		color: #cdd6f4;
		border: 1px solid #1e1e2e;
		border-radius: 6px;
		padding: 6px 10px;
		font-size: 13px;
		font-family: 'Inter', sans-serif;
		cursor: pointer;
	}

	.project-select:focus, .filter-select:focus { border-color: #89b4fa; outline: none; }

	.search-input {
		background: #12121a;
		color: #cdd6f4;
		border: 1px solid #1e1e2e;
		border-radius: 6px;
		padding: 6px 10px;
		font-size: 13px;
		font-family: 'Inter', sans-serif;
		width: 160px;
	}

	.search-input:focus { border-color: #89b4fa; outline: none; }
	.search-input::placeholder { color: #585b70; }

	/* Board */
	.board {
		display: flex;
		flex: 1;
		overflow-x: auto;
		padding: 16px;
		gap: 12px;
	}

	.column {
		flex: 1;
		min-width: 240px;
		max-width: 360px;
		background: #12121a;
		border: 1px solid #1e1e2e;
		border-radius: 8px;
		display: flex;
		flex-direction: column;
		transition: border-color 0.15s;
	}

	.column.drag-over {
		border-color: #89b4fa;
		background: #14141f;
	}

	.column-header {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 12px 14px;
		border-bottom: 1px solid #1e1e2e;
		flex-shrink: 0;
	}

	.column-dot {
		width: 10px;
		height: 10px;
		border-radius: 50%;
		flex-shrink: 0;
	}

	.column-label {
		font-size: 13px;
		font-weight: 600;
		color: #cdd6f4;
		flex: 1;
	}

	.column-count {
		font-size: 12px;
		color: #6c7086;
		background: #1e1e2e;
		padding: 1px 7px;
		border-radius: 10px;
	}

	.add-btn {
		background: none;
		border: none;
		color: #6c7086;
		font-size: 18px;
		cursor: pointer;
		padding: 0 4px;
		line-height: 1;
	}

	.add-btn:hover { color: #89b4fa; }

	.column-body {
		flex: 1;
		overflow-y: auto;
		padding: 8px;
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	/* Cards */
	.card {
		background: #1a1a25;
		border: 1px solid #252530;
		border-radius: 6px;
		padding: 10px 12px;
		cursor: grab;
		transition: border-color 0.1s, transform 0.1s, opacity 0.1s;
	}

	.card:hover { border-color: #89b4fa; }
	.card.dragging { opacity: 0.4; transform: scale(0.95); }
	.card.drag-target { border-color: #f9e2af; border-style: dashed; }
	.card:active { cursor: grabbing; }

	.card-top {
		display: flex;
		justify-content: space-between;
		align-items: flex-start;
		gap: 8px;
	}

	.card-title {
		font-size: 13px;
		color: #cdd6f4;
		line-height: 1.3;
		word-break: break-word;
		display: -webkit-box;
		-webkit-line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}

	.priority-badge {
		font-size: 10px;
		font-weight: 700;
		color: #0a0a0f;
		padding: 1px 6px;
		border-radius: 3px;
		flex-shrink: 0;
	}

	.card-desc {
		font-size: 11px;
		color: #6c7086;
		margin-top: 4px;
		line-height: 1.3;
	}

	.card-meta {
		display: flex;
		gap: 8px;
		margin-top: 6px;
	}

	.card-milestone {
		font-size: 10px;
		color: #89b4fa;
		background: rgba(137, 180, 250, 0.1);
		padding: 1px 6px;
		border-radius: 3px;
	}

	.card-date {
		font-size: 10px;
		color: #6c7086;
	}

	.card-badges {
		display: flex;
		gap: 4px;
		flex-wrap: wrap;
		margin-top: 6px;
	}

	.type-badge {
		font-size: 10px;
		font-weight: 600;
		color: #0a0a0f;
		padding: 1px 6px;
		border-radius: 3px;
	}

	.card-assignee {
		font-size: 10px;
		color: #89b4fa;
		background: rgba(137, 180, 250, 0.1);
		padding: 1px 6px;
		border-radius: 3px;
	}

	.empty-col {
		color: #585b70;
		font-size: 12px;
		text-align: center;
		padding: 20px 0;
	}

	/* Add card inline */
	.add-card {
		background: #1a1a25;
		border: 1px solid #89b4fa;
		border-radius: 6px;
		padding: 8px;
	}

	.add-input {
		width: 100%;
		background: transparent;
		border: none;
		color: #cdd6f4;
		font-size: 13px;
		font-family: 'Inter', sans-serif;
		outline: none;
		padding: 4px 0;
	}

	.add-input::placeholder { color: #585b70; }

	.add-actions {
		display: flex;
		gap: 6px;
		margin-top: 6px;
	}

	.btn-sm {
		padding: 3px 10px;
		font-size: 11px;
		border-radius: 4px;
		border: 1px solid #1e1e2e;
		background: #12121a;
		color: #cdd6f4;
		cursor: pointer;
		font-family: 'Inter', sans-serif;
	}

	.btn-sm.primary { background: #89b4fa; color: #0a0a0f; border-color: #89b4fa; }
	.btn-sm:hover { opacity: 0.85; }

	/* Modal */
	.modal-overlay {
		position: fixed;
		top: 0;
		left: 0;
		right: 0;
		bottom: 0;
		background: rgba(0, 0, 0, 0.6);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 1000;
	}

	.modal {
		background: #12121a;
		border: 1px solid #1e1e2e;
		border-radius: 10px;
		width: 480px;
		max-width: 90vw;
		max-height: 80vh;
		overflow-y: auto;
	}

	.modal-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 16px 20px;
		border-bottom: 1px solid #1e1e2e;
	}

	.modal-header h3 {
		margin: 0;
		font-size: 16px;
		color: #cdd6f4;
	}

	.close-btn {
		background: none;
		border: none;
		color: #6c7086;
		font-size: 20px;
		cursor: pointer;
	}

	.close-btn:hover { color: #cdd6f4; }

	.modal-body {
		padding: 20px;
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	.modal-body label {
		font-size: 12px;
		color: #6c7086;
		font-weight: 500;
		margin-bottom: 0;
	}

	.modal-input, .modal-textarea, .modal-select {
		background: #0a0a0f;
		color: #cdd6f4;
		border: 1px solid #1e1e2e;
		border-radius: 6px;
		padding: 8px 10px;
		font-size: 13px;
		font-family: 'Inter', sans-serif;
	}

	.modal-input:focus, .modal-textarea:focus, .modal-select:focus {
		border-color: #89b4fa;
		outline: none;
	}

	.modal-textarea { resize: vertical; min-height: 60px; }

	.modal-row {
		display: flex;
		gap: 16px;
	}

	.modal-field {
		flex: 1;
		display: flex;
		flex-direction: column;
		gap: 4px;
		min-width: 0;
		overflow: hidden;
	}

	.modal-footer {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 12px 20px;
		border-top: 1px solid #1e1e2e;
	}

	.modal-spacer { flex: 1; }

	.btn-primary {
		padding: 7px 16px;
		background: #89b4fa;
		color: #0a0a0f;
		border: none;
		border-radius: 6px;
		font-size: 13px;
		font-weight: 500;
		cursor: pointer;
		font-family: 'Inter', sans-serif;
	}

	.btn-secondary {
		padding: 7px 16px;
		background: #1a1a25;
		color: #cdd6f4;
		border: 1px solid #1e1e2e;
		border-radius: 6px;
		font-size: 13px;
		cursor: pointer;
		font-family: 'Inter', sans-serif;
	}

	.btn-danger {
		padding: 7px 16px;
		background: #f38ba8;
		color: #0a0a0f;
		border: none;
		border-radius: 6px;
		font-size: 13px;
		font-weight: 500;
		cursor: pointer;
		font-family: 'Inter', sans-serif;
	}

	.btn-primary:hover, .btn-secondary:hover, .btn-danger:hover { opacity: 0.85; }
</style>
