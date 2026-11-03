<!--
  TeamsPanel.svelte — extracted from terminal/+page.svelte (Shape-2 refactor).

  Renders the list of teams; clicking one expands its members list below.
-->
<script>
	import { onMount, onDestroy } from 'svelte';

	let teamsData = $state([]);
	let selectedTeamWidget = $state(null);
	let teamMembersWidget = $state([]);

	async function loadTeamsWidget() {
		try {
			const resp = await fetch('/api/v1/teams');
			if (resp.ok) {
				const d = await resp.json();
				teamsData = d.teams || [];
			}
		} catch {}
	}

	async function loadTeamDetailWidget(teamId) {
		try {
			const resp = await fetch(`/api/v1/teams/${teamId}`);
			if (resp.ok) {
				const d = await resp.json();
				selectedTeamWidget = d.team;
				teamMembersWidget = d.members || [];
			}
		} catch {}
	}

	let _wsHandler = null;
	onMount(() => {
		loadTeamsWidget();
		_wsHandler = () => loadTeamsWidget();
		if (typeof window !== 'undefined') {
			window.addEventListener('pan:teams-update', _wsHandler);
		}
	});
	onDestroy(() => {
		if (typeof window !== 'undefined' && _wsHandler) {
			window.removeEventListener('pan:teams-update', _wsHandler);
		}
	});
</script>

<div class="teams-panel">
	{#if teamsData.length === 0}
		<div class="empty-state">No teams yet</div>
	{:else}
		{#each teamsData as team}
			<div
				class="svc-row clickable"
				class:selected={selectedTeamWidget?.id === team.id}
				onclick={() => loadTeamDetailWidget(team.id)}
			>
				<span class="team-dot-widget" style="background: {team.color || '#89b4fa'}"></span>
				<div class="svc-info">
					<div class="svc-name">{team.name}</div>
					<div class="svc-detail">{team.member_count} Member{team.member_count !== 1 ? 's' : ''}</div>
				</div>
			</div>
		{/each}
	{/if}
	{#if selectedTeamWidget}
		<div class="svc-category" style="margin-top:12px">
			<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:{selectedTeamWidget.color || '#89b4fa'};margin-right:6px"></span>
			{selectedTeamWidget.name}
		</div>
		{#each teamMembersWidget as member}
			<div class="svc-row">
				<span class="svc-dot up"></span>
				<div class="svc-info">
					<div class="svc-name">{member.display_name || member.email || 'Unknown'}</div>
					<div class="svc-detail">{member.role === 'lead' ? 'Lead' : 'Member'}</div>
				</div>
			</div>
		{/each}
		{#if teamMembersWidget.length === 0}
			<div class="empty-state small">No members</div>
		{/if}
	{/if}
</div>
