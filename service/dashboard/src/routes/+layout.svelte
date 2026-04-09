<script>
	import { page } from '$app/state';
	import { base } from '$app/paths';
	import { isSidebarCollapsed, toggleSidebar, setPanMode, getPanMode } from '$lib/stores.svelte.js';

	let { children } = $props();

	const allTabs = [
		{ label: 'Terminal', href: `${base}/terminal`, icon: '⌨', userOnly: true },
		{ label: 'Automation', href: `${base}/automation`, icon: '⚡' },
		{ label: 'Projects', href: `${base}/projects`, icon: '📁' },
		{ label: 'Conversations', href: `${base}/conversations`, icon: '💬' },
		{ label: 'Sensors', href: `${base}/sensors`, icon: '📡' },
		{ label: 'Data', href: `${base}/data`, icon: '🗄' },
		{ label: 'Settings', href: `${base}/settings`, icon: '⚙' },
	];
	// Hide userOnly tabs (Terminal) when the connected server is in service mode.
	// Until /health responds we render all tabs (assume user mode by default).
	let tabs = $derived(allTabs.filter(t => !(t.userOnly && getPanMode() === 'service')));

	let serverStatus = $state('connecting');
	let userName = $state('');
	let userMenuOpen = $state(false);

	const isDev = typeof window !== 'undefined' && window.location.port !== '7777' && window.location.port !== '';

	let collapsed = $derived(isSidebarCollapsed());
	let mobileMenuOpen = $state(false);

	function closeMobileMenu() {
		mobileMenuOpen = false;
	}

	function isActive(tab) {
		const path = page.url.pathname;
		if (tab.href === base || tab.href === `${base}/`) {
			return path === base || path === `${base}/`;
		}
		return path.startsWith(tab.href);
	}

	async function checkHealth() {
		try {
			const res = await fetch('/health');
			serverStatus = res.ok ? 'online' : 'offline';
			if (res.ok) {
				try {
					const j = await res.json();
					if (j.mode) setPanMode(j.mode);
				} catch {}
			}
		} catch {
			serverStatus = 'offline';
		}
	}

	async function loadUser() {
		try {
			const res = await fetch('/auth/me');
			if (res.ok) {
				const data = await res.json();
				userName = data.name || data.email || '';
			}
		} catch { /* Not logged in */ }
	}

	function closeUserMenu() {
		userMenuOpen = false;
	}

	// Hard refresh — force a full reload that bypasses the browser HTTP cache.
	// Adds a cache-busting query param to the current URL so the browser MUST
	// fetch fresh JS/CSS bundles. Then reloads.
	function hardRefresh() {
		try {
			// Clear any service worker / app caches if present
			if ('caches' in window) {
				caches.keys().then(keys => keys.forEach(k => caches.delete(k)));
			}
		} catch {}
		const url = new URL(window.location.href);
		url.searchParams.set('_r', String(Date.now()));
		window.location.replace(url.toString());
	}

	$effect(() => {
		checkHealth();
		loadUser();
		const iv = setInterval(checkHealth, 10000);
		return () => clearInterval(iv);
	});
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<!-- svelte-ignore a11y_click_events_have_key_events -->
{#if mobileMenuOpen}
	<div class="mobile-overlay" onclick={closeMobileMenu}></div>
{/if}

{#if page.url.pathname.includes('/atlas')}
	{@render children()}
{:else}
<div class="shell">
	<nav class="sidebar" class:collapsed class:mobile-open={mobileMenuOpen}>
		<div class="logo">
			<span class="logo-pi">Π</span>
			<span
				class="status"
				class:online={serverStatus === 'online'}
				class:offline={serverStatus === 'offline'}
				title={serverStatus === 'online' ? 'Server Online' : 'Server Offline'}
			></span>
			<button class="logo-refresh" onclick={hardRefresh} title="Hard Refresh (bypass cache)">↻</button>
		</div>

		<button class="collapse-btn" onclick={toggleSidebar} title={collapsed ? 'Expand' : 'Collapse'}>
			{collapsed ? '▸' : '◂'}
		</button>

		<div class="nav-tabs">
			{#each tabs as tab}
				<a
					href={tab.href}
					class="tab"
					class:active={isActive(tab)}
					title={collapsed ? tab.label : ''}
					onclick={closeMobileMenu}
				>
					<span class="tab-icon">{tab.icon}</span>
					{#if !collapsed}
						<span class="tab-label">{tab.label}</span>
					{/if}
				</a>
			{/each}
		</div>

		<div class="sidebar-spacer"></div>

		<div class="sidebar-bottom">
			{#if userName}
				<button class="user-area" onclick={() => userMenuOpen = !userMenuOpen}>
					<div class="user-avatar">{userName.charAt(0).toUpperCase()}</div>
					{#if !collapsed}
						<span class="user-name">{userName}</span>
					{/if}
				</button>
				{#if userMenuOpen}
					<!-- svelte-ignore a11y_no_static_element_interactions -->
					<!-- svelte-ignore a11y_click_events_have_key_events -->
					<div class="user-dropdown-backdrop" onclick={closeUserMenu}></div>
					<div class="user-dropdown">
						<a href="{base}/settings" class="dropdown-item" onclick={closeUserMenu}>Settings</a>
						<button class="dropdown-item danger" onclick={() => { localStorage.removeItem('pan_token'); location.reload(); }}>Sign Out</button>
					</div>
				{/if}
			{:else if !collapsed}
				<div class="server-info">
					<span class="server-label">PAN Server</span>
					<span class="server-status-text">{serverStatus === 'online' ? 'Connected' : 'Disconnected'}</span>
				</div>
			{/if}
		</div>
	</nav>
	<main class="content">
		<div class="topbar">
			<button class="hamburger" onclick={() => mobileMenuOpen = !mobileMenuOpen}>☰</button>
			{#if isDev}<span class="dev-badge">DEV</span>{/if}
			<span class="topbar-title">{tabs.find(t => isActive(t))?.label || 'PAN'}</span>
			<div class="topbar-spacer"></div>
		</div>
		<div class="content-body">
			{@render children()}
		</div>
	</main>
</div>
{/if}

<style>
	:global(*) {
		margin: 0;
		padding: 0;
		box-sizing: border-box;
	}

	:global(html) {
		height: 100%;
		overflow: hidden;
	}

	:global(body) {
		font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
		background: #0a0a0f;
		color: #cdd6f4;
		overflow: hidden;
		height: 100%;
	}

	:global(::-webkit-scrollbar) { width: 6px; height: 6px; }
	:global(::-webkit-scrollbar-track) { background: transparent; }
	:global(::-webkit-scrollbar-thumb) { background: #6c708644; border-radius: 3px; }
	:global(::-webkit-scrollbar-thumb:hover) { background: #6c708688; }

	.shell {
		display: flex;
		height: 100%;
		width: 100%;
		overflow: hidden;
	}

	.sidebar {
		width: 210px;
		min-width: 210px;
		background: #12121a;
		border-right: 1px solid #1e1e2e;
		display: flex;
		flex-direction: column;
		padding: 0;
		transition: width 0.2s ease, min-width 0.2s ease;
	}

	.sidebar.collapsed {
		width: 54px;
		min-width: 54px;
	}

	.logo {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 18px 14px 16px;
		border-bottom: 1px solid #1e1e2e;
		overflow: hidden;
	}

	.sidebar.collapsed .logo {
		justify-content: center;
		padding: 18px 0 16px;
	}

	.logo-pi {
		font-family: serif;
		font-size: 24px;
		font-weight: 700;
		color: #89b4fa;
		flex-shrink: 0;
	}

	.logo-refresh {
		background: none;
		border: none;
		cursor: pointer;
		padding: 2px 4px;
		font-size: 14px;
		color: #6c7086;
		transition: color 0.15s, transform 0.2s;
		margin-left: auto;
	}

	.logo-refresh:hover { color: #89b4fa; transform: rotate(90deg); }
	.logo-refresh:active { color: #cdd6f4; }

	.status {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: #6c7086;
		margin-left: auto;
		flex-shrink: 0;
	}

	.sidebar.collapsed .status {
		display: none;
	}

	.status.online {
		background: #a6e3a1;
		box-shadow: 0 0 6px #a6e3a1;
	}

	.status.offline {
		background: #f38ba8;
		box-shadow: 0 0 4px #f38ba8;
	}

	.collapse-btn {
		display: block;
		width: 100%;
		padding: 8px 0;
		background: none;
		border: none;
		border-bottom: 1px solid #1e1e2e;
		color: #6c7086;
		cursor: pointer;
		font-size: 14px;
		transition: all 0.15s;
	}

	.collapse-btn:hover {
		color: #89b4fa;
		background: #1a1a25;
	}

	.nav-tabs {
		display: flex;
		flex-direction: column;
		gap: 2px;
		padding: 12px 8px;
	}

	.sidebar.collapsed .nav-tabs {
		padding: 12px 4px;
	}

	.tab {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 9px 12px;
		border-radius: 6px;
		color: #6c7086;
		text-decoration: none;
		font-size: 13.5px;
		font-weight: 400;
		transition: all 0.15s;
		cursor: pointer;
		overflow: hidden;
		white-space: nowrap;
	}

	.sidebar.collapsed .tab {
		justify-content: center;
		padding: 9px 0;
		gap: 0;
	}

	.tab:hover {
		color: #cdd6f4;
		background: #1a1a25;
	}

	.tab.active {
		color: #89b4fa;
		background: rgba(137, 180, 250, 0.1);
		font-weight: 500;
	}

	.tab-icon {
		font-size: 15px;
		width: 20px;
		text-align: center;
		flex-shrink: 0;
	}

	.tab-label {
		white-space: nowrap;
		overflow: hidden;
	}

	.sidebar-spacer {
		flex: 1;
	}

	.sidebar-bottom {
		padding: 12px;
		border-top: 1px solid #1e1e2e;
		position: relative;
	}

	.sidebar.collapsed .sidebar-bottom {
		padding: 8px 4px;
	}

	.user-area {
		display: flex;
		align-items: center;
		gap: 10px;
		width: 100%;
		padding: 8px;
		border: none;
		border-radius: 6px;
		background: transparent;
		color: #cdd6f4;
		cursor: pointer;
		font-family: inherit;
		font-size: 13px;
		transition: background 0.15s;
	}

	.sidebar.collapsed .user-area {
		justify-content: center;
		padding: 8px 0;
	}

	.user-area:hover {
		background: #1a1a25;
	}

	.user-avatar {
		width: 28px;
		height: 28px;
		border-radius: 50%;
		background: #89b4fa;
		color: #0a0a0f;
		display: flex;
		align-items: center;
		justify-content: center;
		font-weight: 600;
		font-size: 13px;
		flex-shrink: 0;
	}

	.user-name {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.user-dropdown-backdrop {
		position: fixed;
		inset: 0;
		z-index: 99;
	}

	.user-dropdown {
		position: absolute;
		bottom: 100%;
		left: 12px;
		right: 12px;
		background: #1a1a25;
		border: 1px solid #1e1e2e;
		border-radius: 6px;
		padding: 4px;
		z-index: 100;
		box-shadow: 0 -4px 16px rgba(0,0,0,0.4);
	}

	.dropdown-item {
		display: block;
		width: 100%;
		padding: 8px 12px;
		border: none;
		border-radius: 4px;
		background: transparent;
		color: #cdd6f4;
		font-size: 13px;
		font-family: inherit;
		text-decoration: none;
		text-align: left;
		cursor: pointer;
		transition: background 0.15s;
	}

	.dropdown-item:hover {
		background: rgba(137, 180, 250, 0.1);
	}

	.dropdown-item.danger {
		color: #f38ba8;
	}

	.dropdown-item.danger:hover {
		background: rgba(243, 139, 168, 0.1);
	}

	.server-info {
		display: flex;
		flex-direction: column;
		gap: 2px;
		padding: 4px 8px;
	}

	.server-label {
		font-size: 11px;
		color: #6c7086;
		letter-spacing: 0.5px;
	}

	.server-status-text {
		font-size: 12px;
		color: #a6e3a1;
	}

	.content {
		flex: 1;
		min-height: 0;
		overflow: hidden;
		display: flex;
		flex-direction: column;
	}

	.topbar {
		display: flex;
		align-items: center;
		height: 36px;
		min-height: 36px;
		padding: 0 12px;
		background: #0e0e16;
		border-bottom: 1px solid #1e1e2e;
		gap: 8px;
	}

	.dev-badge {
		background: #f9e2af;
		color: #0a0a0f;
		font-size: 10px;
		font-weight: 700;
		padding: 1px 6px;
		border-radius: 3px;
		letter-spacing: 1px;
	}

	.topbar-title {
		font-size: 13px;
		font-weight: 500;
		color: #6c7086;
		letter-spacing: 0.5px;
	}

	.topbar-spacer {
		flex: 1;
	}

	.topbar-btn {
		background: none;
		border: 1px solid #1e1e2e;
		border-radius: 4px;
		color: #6c7086;
		cursor: pointer;
		font-size: 14px;
		padding: 2px 8px;
		transition: all 0.15s;
		line-height: 1;
	}

	.topbar-btn:hover {
		color: #89b4fa;
		border-color: #89b4fa;
		background: rgba(137, 180, 250, 0.05);
	}

	.content-body {
		flex: 1;
		min-height: 0;
		overflow: hidden;
		display: flex;
		flex-direction: column;
	}

	/* Hamburger — hidden on desktop */
	.hamburger {
		display: none;
		background: none;
		border: none;
		color: #cdd6f4;
		font-size: 20px;
		cursor: pointer;
		padding: 4px 8px;
	}

	/* Mobile overlay */
	.mobile-overlay {
		display: none;
	}

	/* Mobile responsive */
	@media (max-width: 768px) {
		.sidebar {
			position: fixed;
			left: -260px;
			top: 0;
			bottom: 0;
			z-index: 1000;
			width: 240px;
			min-width: 240px;
			transition: left 0.25s ease;
		}

		.sidebar.collapsed {
			width: 240px;
			min-width: 240px;
			left: -260px;
		}

		.sidebar.mobile-open {
			left: 0;
		}

		.sidebar.mobile-open.collapsed {
			left: 0;
			width: 240px;
			min-width: 240px;
		}

		/* Force show labels on mobile sidebar */
		.sidebar.mobile-open .tab-label {
			display: inline !important;
		}

		.collapse-btn {
			display: none;
		}

		.hamburger {
			display: block;
		}

		.mobile-overlay {
			display: block;
			position: fixed;
			inset: 0;
			background: rgba(0, 0, 0, 0.5);
			z-index: 999;
		}

		.content {
			width: 100vw;
		}

		.topbar {
			padding: 8px 12px;
		}

		.content-body {
			padding: 0;
		}
	}

	@media (max-width: 480px) {
		.topbar-title {
			font-size: 14px;
		}
	}
</style>
