<!--
  ApprovalsPanel.svelte — extracted from terminal/+page.svelte (Shape-2 refactor).

  Renders pending PTY/terminal permission prompts. Each row has Allow/Deny.
  Self-contained: fetches its own list, subscribes to the same WS push the
  parent dispatches via `pan:approvals-update` custom event.
-->
<script>
	import { onMount, onDestroy } from 'svelte';

	let approvalsData = $state([]);

	async function loadApprovals() {
		try {
			const resp = await fetch('/api/v1/terminal/permissions');
			if (resp.ok) {
				const data = await resp.json();
				approvalsData = data.permissions || [];
			}
		} catch {}
	}

	async function respondToApproval(permId, action) {
		try {
			const response = action === 'allow' ? 'allow' : 'deny';
			await fetch('/api/v1/terminal/permissions/respond', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ perm_id: permId, response })
			});
			approvalsData = approvalsData.filter(p => p.id !== permId);
		} catch {}
	}

	let _wsHandler = null;
	onMount(() => {
		loadApprovals();
		_wsHandler = () => loadApprovals();
		if (typeof window !== 'undefined') {
			window.addEventListener('pan:approvals-update', _wsHandler);
		}
	});
	onDestroy(() => {
		if (typeof window !== 'undefined' && _wsHandler) {
			window.removeEventListener('pan:approvals-update', _wsHandler);
		}
	});

	// Expose count for parent badges via $bindable
	let { count = $bindable(0) } = $props();
	$effect(() => { count = approvalsData.length; });
</script>

{#if approvalsData.length === 0}
	<div class="empty-state">No pending approvals</div>
{:else}
	{#each approvalsData as perm}
		<div class="approval-row">
			<div class="approval-tool">{perm.tool || perm.type || 'Permission'}</div>
			<div class="approval-desc">{perm.description || perm.message || ''}</div>
			<div class="approval-actions">
				<button class="approval-btn approve" onclick={() => respondToApproval(perm.id, 'allow')}>Allow</button>
				<button class="approval-btn deny" onclick={() => respondToApproval(perm.id, 'deny')}>Deny</button>
			</div>
		</div>
	{/each}
{/if}
