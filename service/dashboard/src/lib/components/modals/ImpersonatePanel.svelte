<!--
  ImpersonatePanel.svelte — extracted from terminal/+page.svelte (Shape-2
  refactor, 2026-05-27).

  Owner-only modal that lets you preview the dashboard as a different power
  level, a specific user, or as a member of an org at a given role/power.

  Props:
    open (bindable) — boolean controlling modal visibility. Toggle from parent
                      toolbar button. Component sets it back to false on close.
    onApplied        — callback invoked after the impersonation API resolves.
                      Parent should call its own reloadPermsMatrix() in there.

  All modal state (tabs, sliders, user selection, org selection, roles,
  applying-flag) lives inside the component. The lists of users/orgs/roles
  are lazy-loaded the first time the modal opens so the network calls don't
  fire on every page load.

  See docs/DASHBOARD-REFACTOR-MAP.md for the full extraction plan.
-->
<script>
	import { api } from '$lib/api.js';

	// ────────────────────────────────────────────────────────────────────────
	//  Props
	// ────────────────────────────────────────────────────────────────────────
	let {
		open = $bindable(false),
		onApplied = () => {},
	} = $props();

	const IMPERSONATE_PRESETS = [
		{ label: 'Child',   power: 5  },
		{ label: 'Guest',   power: 15 },
		{ label: 'User',    power: 25 },
		{ label: 'Manager', power: 50 },
		{ label: 'Admin',   power: 75 },
	];

	// ────────────────────────────────────────────────────────────────────────
	//  Modal state
	// ────────────────────────────────────────────────────────────────────────
	let impersonateTab  = $state('power'); // 'power' | 'user' | 'group'
	let impPowerSlider  = $state(25);
	let impUsers        = $state([]);
	let impUsersLoaded  = $state(false);
	let impSelectedUser = $state(null);
	let impOrgs         = $state([]);
	let impOrgsLoaded   = $state(false);
	let impSelectedOrg  = $state(null);
	let impGroupPower   = $state(25);
	let impGroupRole    = $state('Member');
	let impRoles        = $state([]);
	let impApplying     = $state(false);

	// ────────────────────────────────────────────────────────────────────────
	//  Lazy-load users / orgs / roles the first time the modal opens.
	// ────────────────────────────────────────────────────────────────────────
	async function loadUsersIfNeeded() {
		if (impUsersLoaded) return;
		try {
			const r = await api('/api/v1/users');
			impUsers = (r.users || []).filter(u => (u.power_lvl ?? 0) < 100);
		} catch { impUsers = []; }
		impUsersLoaded = true;
	}
	async function loadOrgsIfNeeded() {
		if (impOrgsLoaded) return;
		try {
			const r = await api('/api/v1/orgs');
			impOrgs = r.orgs || [];
			if (impOrgs.length) impSelectedOrg = impOrgs[0].id;
			const rr = await api('/api/v1/roles');
			impRoles = rr.roles || [];
		} catch { impOrgs = []; impRoles = []; }
		impOrgsLoaded = true;
	}

	// When `open` flips from false to true, lazy-load the lists.
	$effect(() => {
		if (open) {
			loadUsersIfNeeded();
			loadOrgsIfNeeded();
		}
	});

	async function applyImpersonation() {
		impApplying = true;
		try {
			if (impersonateTab === 'power') {
				await api('/api/v1/impersonate', {
					method: 'POST',
					body: JSON.stringify({ type: 'power', power: impPowerSlider }),
					headers: { 'Content-Type': 'application/json' },
				});
			} else if (impersonateTab === 'user') {
				if (!impSelectedUser) return;
				await api('/api/v1/impersonate', {
					method: 'POST',
					body: JSON.stringify({ type: 'user', userId: impSelectedUser.id }),
					headers: { 'Content-Type': 'application/json' },
				});
			} else if (impersonateTab === 'group') {
				if (!impSelectedOrg) return;
				const roleName = impRoles.find(r => r.level === impGroupPower)?.name || impGroupRole;
				await api('/api/v1/impersonate', {
					method: 'POST',
					body: JSON.stringify({ type: 'group', orgId: impSelectedOrg, power: impGroupPower, roleName }),
					headers: { 'Content-Type': 'application/json' },
				});
			}
			await onApplied();
			open = false;
		} finally {
			impApplying = false;
		}
	}
</script>

{#if open}
	<!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
	<div class="imp-backdrop" onclick={() => open = false}></div>
	<div class="imp-modal" role="dialog" aria-label="Impersonate">
		<div class="imp-header">
			<span class="imp-title">👁 Impersonate</span>
			<button class="imp-close" onclick={() => open = false}>✕</button>
		</div>

		<div class="imp-tabs">
			<button class="imp-tab" class:active={impersonateTab === 'power'} onclick={() => impersonateTab = 'power'}>⚡ Power Level</button>
			<button class="imp-tab" class:active={impersonateTab === 'user'}  onclick={() => impersonateTab = 'user'}>👤 User</button>
			<button class="imp-tab" class:active={impersonateTab === 'group'} onclick={() => impersonateTab = 'group'}>🏢 Group</button>
		</div>

		{#if impersonateTab === 'power'}
			<div class="imp-body">
				<p class="imp-desc">Preview the dashboard as any power level (0–99). Use the presets or drag the slider.</p>
				<div class="imp-presets">
					{#each IMPERSONATE_PRESETS as p}
						<button class="imp-preset" class:active={impPowerSlider === p.power} onclick={() => impPowerSlider = p.power}>
							{p.label}<br><span class="imp-preset-sub">lvl {p.power}</span>
						</button>
					{/each}
				</div>
				<div class="imp-slider-row">
					<span class="imp-slider-label">0</span>
					<input type="range" min="0" max="99" bind:value={impPowerSlider} class="imp-slider" />
					<span class="imp-slider-label">99</span>
					<span class="imp-slider-val">{impPowerSlider}</span>
				</div>
			</div>

		{:else if impersonateTab === 'user'}
			<div class="imp-body">
				<p class="imp-desc">View the dashboard as a specific registered user.</p>
				{#if !impUsersLoaded}
					<div class="imp-loading">Loading users…</div>
				{:else if impUsers.length === 0}
					<div class="imp-empty">No non-owner users registered yet.</div>
				{:else}
					<div class="imp-user-list">
						{#each impUsers as u}
							<!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
							<div class="imp-user-row" class:selected={impSelectedUser?.id === u.id} onclick={() => impSelectedUser = u}>
								<span class="imp-user-avatar">{(u.display_nickname || u.display_name || '?').charAt(0).toUpperCase()}</span>
								<div class="imp-user-info">
									<span class="imp-user-name">{u.display_nickname || u.display_name || `User #${u.id}`}</span>
									{#if u.email}<span class="imp-user-email">{u.email}</span>{/if}
								</div>
								<span class="imp-user-power">lvl {u.power_lvl ?? 0}</span>
							</div>
						{/each}
					</div>
				{/if}
			</div>

		{:else if impersonateTab === 'group'}
			<div class="imp-body">
				<p class="imp-desc">Preview as a member of an org at a specific role/power level.</p>
				{#if !impOrgsLoaded}
					<div class="imp-loading">Loading orgs…</div>
				{:else}
					<div class="imp-field">
						<label class="imp-label" for="imp-org-select">Organisation</label>
						<select id="imp-org-select" class="imp-select" bind:value={impSelectedOrg}>
							{#each impOrgs as o}
								<option value={o.id}>{o.name}</option>
							{/each}
						</select>
					</div>
					<div class="imp-field">
						<label class="imp-label">Role / Power Level</label>
						{#if impRoles.length}
							<div class="imp-presets">
								{#each impRoles as r}
									<button class="imp-preset" class:active={impGroupPower === r.level} onclick={() => { impGroupPower = r.level; impGroupRole = r.name; }}>
										{r.name}<br><span class="imp-preset-sub">lvl {r.level}</span>
									</button>
								{/each}
							</div>
						{/if}
						<div class="imp-slider-row">
							<span class="imp-slider-label">0</span>
							<input type="range" min="0" max="99" bind:value={impGroupPower} class="imp-slider" />
							<span class="imp-slider-label">99</span>
							<span class="imp-slider-val">{impGroupPower}</span>
						</div>
					</div>
				{/if}
			</div>
		{/if}

		<div class="imp-footer">
			<button class="imp-cancel" onclick={() => open = false}>Cancel</button>
			<button class="imp-apply" onclick={applyImpersonation} disabled={impApplying || (impersonateTab === 'user' && !impSelectedUser) || (impersonateTab === 'group' && !impSelectedOrg)}>
				{impApplying ? 'Applying…' : '👁 Apply'}
			</button>
		</div>
	</div>
{/if}

<style>
	.imp-backdrop {
		position: fixed; inset: 0;
		background: rgba(0,0,0,0.55);
		z-index: 3000;
	}
	.imp-modal {
		position: fixed;
		top: 50%; left: 50%;
		transform: translate(-50%, -50%);
		z-index: 3001;
		background: #181825;
		border: 1px solid #45475a;
		border-radius: 12px;
		width: 420px;
		max-width: calc(100vw - 32px);
		max-height: 80vh;
		display: flex;
		flex-direction: column;
		box-shadow: 0 24px 80px rgba(0,0,0,0.7);
		font-size: 13px;
	}
	.imp-header {
		display: flex; align-items: center;
		padding: 14px 16px 10px;
		border-bottom: 1px solid #313244;
	}
	.imp-title { font-size: 14px; font-weight: 600; color: #cdd6f4; flex: 1; }
	.imp-close {
		background: none; border: none;
		color: #6c7086; cursor: pointer; font-size: 14px; padding: 0 2px;
	}
	.imp-close:hover { color: #f38ba8; }

	.imp-tabs {
		display: flex;
		gap: 4px;
		padding: 10px 16px 0;
	}
	.imp-tab {
		background: none;
		border: 1px solid transparent;
		border-radius: 6px;
		color: #6c7086;
		cursor: pointer;
		font-size: 12px;
		padding: 5px 12px;
		transition: all .15s;
	}
	.imp-tab:hover { color: #cdd6f4; border-color: #45475a; }
	.imp-tab.active { background: #313244; color: #cdd6f4; border-color: #45475a; }

	.imp-body {
		padding: 14px 16px;
		overflow-y: auto;
		flex: 1;
	}
	.imp-desc { color: #6c7086; font-size: 12px; margin: 0 0 12px; line-height: 1.4; }
	.imp-loading, .imp-empty { color: #6c7086; font-size: 12px; text-align: center; padding: 20px 0; }

	.imp-presets {
		display: flex; flex-wrap: wrap; gap: 6px;
		margin-bottom: 14px;
	}
	.imp-preset {
		background: #1e1e2e;
		border: 1px solid #45475a;
		border-radius: 8px;
		color: #a6adc8;
		cursor: pointer;
		font-size: 11px;
		padding: 6px 12px;
		text-align: center;
		transition: all .15s;
		line-height: 1.3;
	}
	.imp-preset:hover { border-color: #89b4fa; color: #89b4fa; }
	.imp-preset.active { background: rgba(137,180,250,0.15); border-color: #89b4fa; color: #89b4fa; }
	.imp-preset-sub { font-size: 10px; opacity: .7; }

	.imp-slider-row {
		display: flex; align-items: center; gap: 8px;
	}
	.imp-slider {
		flex: 1;
		accent-color: #89b4fa;
		cursor: pointer;
	}
	.imp-slider-label { font-size: 11px; color: #6c7086; min-width: 14px; text-align: center; }
	.imp-slider-val {
		background: #313244;
		border-radius: 5px;
		color: #89b4fa;
		font-size: 13px; font-weight: 600;
		min-width: 34px;
		padding: 2px 6px;
		text-align: center;
	}

	.imp-user-list { display: flex; flex-direction: column; gap: 4px; }
	.imp-user-row {
		display: flex; align-items: center; gap: 10px;
		padding: 8px 10px;
		border: 1px solid transparent;
		border-radius: 8px;
		cursor: pointer;
		transition: all .15s;
	}
	.imp-user-row:hover { background: #1e1e2e; border-color: #45475a; }
	.imp-user-row.selected { background: rgba(137,180,250,0.1); border-color: #89b4fa; }
	.imp-user-avatar {
		background: #313244;
		border-radius: 50%;
		color: #89b4fa;
		font-size: 13px; font-weight: 600;
		width: 30px; height: 30px;
		display: flex; align-items: center; justify-content: center;
		flex-shrink: 0;
	}
	.imp-user-info { flex: 1; display: flex; flex-direction: column; gap: 1px; }
	.imp-user-name { font-size: 13px; color: #cdd6f4; }
	.imp-user-email { font-size: 11px; color: #6c7086; }
	.imp-user-power {
		font-size: 11px; color: #a6adc8;
		background: #313244; border-radius: 4px; padding: 1px 6px;
	}

	.imp-field { margin-bottom: 14px; }
	.imp-label { display: block; font-size: 11px; color: #6c7086; margin-bottom: 5px; }
	.imp-select {
		width: 100%;
		background: #1e1e2e; border: 1px solid #45475a; border-radius: 6px;
		color: #cdd6f4; font-size: 12px; padding: 6px 8px; cursor: pointer;
	}
	.imp-select:focus { border-color: #89b4fa; outline: none; }

	.imp-footer {
		display: flex; justify-content: flex-end; gap: 8px;
		padding: 12px 16px;
		border-top: 1px solid #313244;
	}
	.imp-cancel {
		background: none; border: 1px solid #45475a; border-radius: 6px;
		color: #6c7086; cursor: pointer; font-size: 12px; padding: 6px 14px;
	}
	.imp-cancel:hover { border-color: #cdd6f4; color: #cdd6f4; }
	.imp-apply {
		background: rgba(137,180,250,0.15);
		border: 1px solid #89b4fa;
		border-radius: 6px;
		color: #89b4fa;
		cursor: pointer;
		font-size: 12px;
		font-weight: 600;
		padding: 6px 18px;
		transition: all .15s;
	}
	.imp-apply:hover:not(:disabled) { background: rgba(137,180,250,0.25); }
	.imp-apply:disabled { opacity: .45; cursor: not-allowed; }
</style>
