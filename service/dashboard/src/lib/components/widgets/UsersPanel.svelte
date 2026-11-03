<!--
  UsersPanel.svelte — extracted from terminal/+page.svelte (Shape-2 refactor).

  Lists registered users grouped by role/group, with active/inactive dot.
  Owner/admin (power ≥ 75) sees an "Add Member" form. Child-row gets an
  "Open child view" button that spawns a Tauri kiosk window.

  Props:
    permsMatrix — parent's permission matrix (read-only). Used to gate the
                  Add Member form behind power ≥ 75.
-->
<script>
	import { onMount, onDestroy } from 'svelte';
	import { api } from '$lib/api.js';

	// 2026-05-28: migrated to read permsMatrix from org store. No props.
	import { org } from '$lib/stores/org.svelte.js';
	const permsMatrix = $derived(org.permsMatrix);

	let usersData = $state([]);

	async function loadUsers() {
		try {
			const token = localStorage.getItem('pan_token');
			const headers = token ? { 'Authorization': `Bearer ${token}` } : {};
			const resp = await fetch('/api/v1/auth/users', { headers });
			if (resp.ok) {
				const d = await resp.json();
				usersData = d.users || d || [];
			}
		} catch {}
	}

	async function openChildView(user) {
		const url = `${window.location.origin}/child/?user=${encodeURIComponent(user.display_name || user.name || 'Child')}`;
		const title = `PAN — ${user.display_name || 'Child View'}`;
		try {
			await fetch(`http://127.0.0.1:${typeof TAURI_PORT !== 'undefined' ? TAURI_PORT : 7790}/open`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ url, title, width: 480, height: 700, kiosk: true })
			});
		} catch {
			window.open(url, '_blank', 'width=480,height=700,menubar=no,toolbar=no,location=no,status=no');
		}
	}

	async function addUserSubmit(e) {
		e.preventDefault();
		const form = e.target;
		const name = form.querySelector('[name=uname]').value.trim();
		const role = form.querySelector('[name=urole]').value;
		if (!name) return;
		try {
			const r = await api('/api/v1/auth/users', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ display_name: name, role })
			});
			if (r.ok) { form.reset(); loadUsers(); }
			else alert(r.error || 'Failed to add user');
		} catch (err) { alert(String(err)); }
	}

	let _wsHandler = null;
	onMount(() => {
		loadUsers();
		_wsHandler = () => loadUsers();
		if (typeof window !== 'undefined') {
			window.addEventListener('pan:users-update', _wsHandler);
		}
	});
	onDestroy(() => {
		if (typeof window !== 'undefined' && _wsHandler) {
			window.removeEventListener('pan:users-update', _wsHandler);
		}
	});

	const groups = $derived([...new Set(usersData.map(u => u.role || u.group || 'Default'))]);
</script>

<div class="users-panel">
	{#if usersData.length === 0}
		<div class="empty-state">No users yet</div>
	{:else}
		{#each groups as group}
			<div class="svc-category">{group.charAt(0).toUpperCase() + group.slice(1)}</div>
			{#each usersData.filter(u => (u.role || u.group || 'Default') === group) as user}
				<div class="svc-row">
					<span class="svc-dot" class:up={user.is_active !== 0 || user.status === 'active' || user.status === 'online'} class:unknown={user.is_active === 0 && !user.status}></span>
					<div class="svc-info">
						<div class="svc-name">{user.display_name || user.name || 'Unknown'}</div>
						<div class="svc-detail">{(user.role || 'User').charAt(0).toUpperCase() + (user.role || 'User').slice(1)}{user.power_lvl != null ? ` · lvl ${user.power_lvl}` : ''}</div>
					</div>
					{#if user.role === 'child' || (user.power_lvl != null && user.power_lvl <= 5)}
						<button class="svc-action-btn" title="Open child view" onclick={() => openChildView(user)}>🧒</button>
					{/if}
					{#if user.id !== 1}
						<button class="svc-action-btn danger" title="Remove" onclick={async () => {
							if (!confirm(`Remove ${user.display_name}?`)) return;
							await api(`/api/v1/auth/users/${user.id}`, { method: 'DELETE' });
							loadUsers();
						}}>✕</button>
					{/if}
				</div>
			{/each}
		{/each}
	{/if}
	{#if permsMatrix?.power >= 75}
		<div class="svc-category" style="margin-top:12px">Add Member</div>
		<form class="add-user-form" onsubmit={addUserSubmit} style="display:flex;flex-direction:column;gap:6px;padding:6px 0">
			<input name="uname" class="settings-input" placeholder="Name (e.g. Emma)" autocomplete="off" style="font-size:11px;padding:4px 8px" />
			<select name="urole" class="right-select" style="font-size:11px">
				<option value="child">Child (lvl 5 — actions only)</option>
				<option value="guest">Guest (lvl 15 — chat + browse)</option>
				<option value="user" selected>User (lvl 25 — standard)</option>
				<option value="manager">Manager (lvl 50)</option>
				<option value="admin">Admin (lvl 75)</option>
			</select>
			<button class="action-btn" type="submit" style="font-size:11px;padding:4px 10px">+ Add</button>
		</form>
	{/if}
</div>
