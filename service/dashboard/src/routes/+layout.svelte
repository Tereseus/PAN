<script>
	import { page } from '$app/state';
	import { base } from '$app/paths';
	import { onMount } from 'svelte';
	import { isSidebarCollapsed, toggleSidebar, setPanMode, getPanMode } from '$lib/stores.svelte.js';

	let { children } = $props();

	const allTabs = [
		{ label: 'Terminal', href: `${base}/terminal`, icon: '⌨', userOnly: true },
		{ label: 'Automation', href: `${base}/automation`, icon: '⚡' },
		{ label: 'Projects', href: `${base}/projects`, icon: '📁' },
		{ label: 'Sensors', href: `${base}/sensors`, icon: '📡' },
		{ label: 'Data', href: `${base}/data`, icon: '🗄' },
		{ label: 'Settings', href: `${base}/settings`, icon: '⚙' },
	];
	// Hide userOnly tabs (Terminal) when the connected server is in service mode.
	// Until /health responds we render all tabs (assume user mode by default).
	let tabs = $derived(allTabs.filter(t => !(t.userOnly && getPanMode() === 'service')));

	let commsOpen = $state(typeof window !== 'undefined' && localStorage.getItem('pan_comms_open') === '1');
	let commsView = $state('contacts'); // 'contacts' | 'calendar' | 'mail'
	let unreadMessages = $state(0);
	let commsContacts = $state([]);
	let commsActiveContact = $state(null);   // contact object currently expanded
	let commsActiveThread = $state(null);    // thread_id for active contact
	let commsMessages = $state([]);          // messages in the active thread
	let commsInput = $state('');             // chat input text
	let commsMessagesEl;                     // scroll container ref
	let commsSearch = $state('');            // contact search filter

	// Unified messages state
	let unifiedMessages = $state([]);
	let unifiedFilter = $state('all');  // 'all' | 'pan' | 'email'
	let unifiedLoading = $state(false);
	let unifiedExpandedEmail = $state(null); // email_db_id of expanded email
	let unifiedEmailConfigured = $state(false);
	let unifiedEmailDetail = $state(null); // full email object when expanded

	// Unified compose state
	let unifiedCompose = $state(false);
	let composeToQuery = $state('');
	let composeToResults = $state([]);
	let composeToSelected = $state(null); // { type: 'contact', id, display_name } or { type: 'email', address }
	let composeSubject = $state('');
	let composeBody = $state('');
	let composeSending = $state(false);
	let composeIsEmail = $derived(
		composeToSelected?.type === 'email' ||
		(!composeToSelected && composeToQuery.includes('@'))
	);

	async function loadUnifiedInbox() {
		unifiedLoading = true;
		try {
			const res = await fetch(`${window.location.origin}/api/v1/chat/mail?limit=50&filter=${unifiedFilter}`);
			if (res.ok) {
				const data = await res.json();
				unifiedMessages = data.messages || [];
			}
		} catch (e) {
			console.error('[PAN Comms] loadUnifiedInbox failed:', e);
		} finally {
			unifiedLoading = false;
		}
		// Check email status in background (lazy)
		try {
			const sres = await fetch(`${window.location.origin}/api/v1/email/status`);
			if (sres.ok) {
				const st = await sres.json();
				unifiedEmailConfigured = st.configured;
			}
		} catch {}
	}

	async function syncEmailFromUnified() {
		unifiedLoading = true;
		try {
			await fetch(`${window.location.origin}/api/v1/email/sync`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ folder: 'INBOX', full: true }),
			});
			await loadUnifiedInbox();
		} catch (e) {
			console.error('[PAN Comms] syncEmail failed:', e);
		} finally {
			unifiedLoading = false;
		}
	}

	async function unifiedClickMessage(msg) {
		if (msg.type === 'pan') {
			// Open contact chat
			const contactId = msg.sender_id;
			commsView = 'contacts';
			await loadCommsContacts();
			const contact = commsContacts.find(c => c.id === contactId);
			if (contact) commsClickContact(contact);
		} else if (msg.type === 'email') {
			// Toggle expand inline
			if (unifiedExpandedEmail === msg.id) {
				unifiedExpandedEmail = null;
				unifiedEmailDetail = null;
			} else {
				unifiedExpandedEmail = msg.id;
				unifiedEmailDetail = null;
				// Fetch full email body
				try {
					const dbId = msg.email_db_id;
					const res = await fetch(`${window.location.origin}/api/v1/email/messages?folder=INBOX&limit=200`);
					if (res.ok) {
						const all = await res.json();
						unifiedEmailDetail = all.find(e => e.id === dbId) || null;
					}
				} catch {}
				// Mark as read
				if (!msg.read && msg.message_id) {
					try {
						await fetch(`${window.location.origin}/api/v1/email/mark-read`, {
							method: 'POST',
							headers: { 'Content-Type': 'application/json' },
							body: JSON.stringify({ message_id: msg.message_id }),
						});
						unifiedMessages = unifiedMessages.map(m =>
							m.id === msg.id ? { ...m, read: true } : m
						);
					} catch {}
				}
			}
		}
	}

	async function composeSearch(q) {
		if (!q || q.length < 2) { composeToResults = []; return; }
		try {
			const res = await fetch(`${window.location.origin}/api/v1/chat/contact-search?q=${encodeURIComponent(q)}`);
			if (res.ok) composeToResults = await res.json();
		} catch { composeToResults = []; }
	}

	function composeSelectContact(contact) {
		composeToSelected = { type: 'contact', id: contact.id, display_name: contact.display_name, thread_id: null };
		composeToQuery = contact.display_name;
		composeToResults = [];
	}

	function composeSelectEmailAddr() {
		composeToSelected = { type: 'email', address: composeToQuery.trim() };
		composeToResults = [];
	}

	async function unifiedSend() {
		if (!composeBody.trim()) return;
		composeSending = true;
		try {
			if (composeIsEmail) {
				// Send via email
				const toAddr = composeToSelected?.address || composeToQuery.trim();
				if (!toAddr || !composeSubject) { composeSending = false; return; }
				await fetch(`${window.location.origin}/api/v1/email/send`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ to: toAddr, subject: composeSubject, body: composeBody }),
				});
			} else if (composeToSelected?.type === 'contact') {
				// Send via PAN — get or create thread
				const tRes = await fetch(`${window.location.origin}/api/v1/chat/threads/dm`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ contact_id: composeToSelected.id }),
				});
				if (tRes.ok) {
					const t = await tRes.json();
					await fetch(`${window.location.origin}/api/v1/chat/threads/${t.thread_id}/messages`, {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({ body: composeBody }),
					});
				}
			}
			// Reset compose
			unifiedCompose = false;
			composeToQuery = '';
			composeToSelected = null;
			composeSubject = '';
			composeBody = '';
			composeToResults = [];
			// Refresh
			loadUnifiedInbox();
		} catch (e) {
			console.error('[PAN Comms] send failed:', e);
		} finally {
			composeSending = false;
		}
	}

	function openExpandedCommsView(view) {
		const urls = {
			contacts: `${window.location.origin}/v2/comms?view=contacts`,
			mail: `${window.location.origin}/v2/comms?view=mail`,
			calendar: `${window.location.origin}/v2/comms?view=calendar`,
		};
		const titles = { contacts: 'Contacts', mail: 'Mail', calendar: 'Calendar' };
		openPanWindow(urls[view] || urls.contacts, { width: 900, height: 700, title: titles[view] || 'Comms' });
	}

	function openComposeWindow(contact = null) {
		const params = new URLSearchParams();
		if (contact) {
			params.set('contact', contact.id);
			params.set('name', contact.display_name);
			if (contact.email) params.set('email', contact.email);
		}
		openPanWindow(`${window.location.origin}/v2/compose?${params.toString()}`, { width: 640, height: 520, title: 'Compose' });
	}

	async function openMessageThread(msg) {
		// Find the contact for this message and open the chat
		const contactName = msg.sender_name || msg.recipient_name || msg.from_name;
		const contactId = msg.sender_id !== 'self' ? msg.sender_id : null;
		commsView = 'contacts';
		await loadCommsContacts();
		const contact = commsContacts.find(c => c.id === contactId) ||
			commsContacts.find(c => c.display_name === contactName);
		if (contact) commsClickContact(contact);
	}

	function commsTimeAgo(ts) {
		if (!ts) return '';
		const now = Date.now();
		const diff = now - (typeof ts === 'number' ? ts : parseInt(ts));
		if (diff < 60000) return 'now';
		if (diff < 3600000) return Math.floor(diff / 60000) + 'm';
		if (diff < 86400000) return Math.floor(diff / 3600000) + 'h';
		if (diff < 604800000) return Math.floor(diff / 86400000) + 'd';
		return new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric' });
	}

	function toggleComms() {
		commsOpen = !commsOpen;
		if (typeof window !== 'undefined') localStorage.setItem('pan_comms_open', commsOpen ? '1' : '0');
		if (commsOpen) loadCommsContacts();
	}

	let commsLoading = $state(false);
	let commsError = $state('');

	async function loadCommsContacts() {
		commsLoading = true;
		commsError = '';
		console.log('[PAN Comms] Loading contacts from', window.location.origin);
		try {
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), 5000);
			const res = await fetch(`${window.location.origin}/api/v1/chat/contacts`, { signal: controller.signal });
			clearTimeout(timeout);
			console.log('[PAN Comms] Response status:', res.status);
			if (res.ok) {
				const data = await res.json();
				console.log('[PAN Comms] Got', data.length, 'contacts');
				commsContacts = data;
			} else {
				commsError = `Failed (${res.status})`;
			}
		} catch (e) {
			commsError = e.name === 'AbortError' ? 'Timeout — server unreachable' : (e.message || 'Network error');
			console.error('[PAN Comms] loadCommsContacts failed:', e);
		} finally {
			commsLoading = false;
			console.log('[PAN Comms] Done. contacts:', commsContacts.length, 'error:', commsError);
		}
	}

	// Load contacts on mount if panel was left open
	onMount(() => {
		if (commsOpen) loadCommsContacts();
	});

	async function commsClickContact(contact) {
		// Toggle: click same contact again to collapse
		if (commsActiveContact?.id === contact.id) {
			commsActiveContact = null;
			commsActiveThread = null;
			commsMessages = [];
			return;
		}
		commsActiveContact = contact;
		// Get or create DM thread
		try {
			const res = await fetch('/api/v1/chat/threads/dm', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ contact_id: contact.id })
			});
			if (res.ok) {
				const data = await res.json();
				commsActiveThread = data.thread_id;
				await loadCommsMessages(data.thread_id);
				// Mark as read
				fetch(`/api/v1/chat/threads/${data.thread_id}/read`, { method: 'POST' });
				loadCommsContacts(); // refresh unread counts
			}
		} catch {}
	}

	async function loadCommsMessages(threadId) {
		try {
			const res = await fetch(`/api/v1/chat/threads/${threadId}/messages?limit=20`);
			if (res.ok) commsMessages = await res.json();
			// Scroll to bottom after render
			setTimeout(() => { if (commsMessagesEl) commsMessagesEl.scrollTop = commsMessagesEl.scrollHeight; }, 50);
		} catch {}
	}

	async function commsSendMessage() {
		if (!commsInput.trim() || !commsActiveThread) return;
		const body = commsInput.trim();
		commsInput = '';
		try {
			const res = await fetch(`/api/v1/chat/threads/${commsActiveThread}/messages`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ body })
			});
			if (res.ok) {
				const data = await res.json();
				commsMessages = [...commsMessages, { id: data.id, thread_id: commsActiveThread, sender_id: 'self', body, body_type: 'text', created_at: data.created_at }];
				setTimeout(() => { if (commsMessagesEl) commsMessagesEl.scrollTop = commsMessagesEl.scrollHeight; }, 50);
			}
		} catch {}
	}

	// Calendar state
	let calendarEvents = $state([]);
	let calendarMonth = $state(new Date().getMonth());
	let calendarYear = $state(new Date().getFullYear());
	let calendarSelectedDay = $state(null);
	let calendarAddModal = $state(false);
	let calendarNewTitle = $state('');
	let calendarNewTime = $state('12:00');
	let calendarFlash = $state(false);

	async function loadCalendarEvents() {
		try {
			const res = await fetch(`/api/v1/chat/calendar?month=${calendarMonth + 1}&year=${calendarYear}`);
			if (res.ok) calendarEvents = await res.json();
		} catch {}
	}

	async function addCalendarEvent() {
		if (!calendarNewTitle.trim() || calendarSelectedDay == null) return;
		const dt = new Date(calendarYear, calendarMonth, calendarSelectedDay);
		const [h, m] = calendarNewTime.split(':');
		dt.setHours(parseInt(h) || 12, parseInt(m) || 0);
		try {
			await fetch('/api/v1/chat/calendar', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ title: calendarNewTitle.trim(), starts_at: dt.getTime(), notify: true })
			});
			calendarNewTitle = '';
			calendarAddModal = false;
			loadCalendarEvents();
		} catch {}
	}

	function calendarDaysInMonth(y, m) {
		return new Date(y, m + 1, 0).getDate();
	}

	function calendarFirstDow(y, m) {
		return new Date(y, m, 1).getDay();
	}

	function calendarEventsOnDay(day) {
		return calendarEvents.filter(e => {
			const d = new Date(e.starts_at);
			return d.getDate() === day && d.getMonth() === calendarMonth && d.getFullYear() === calendarYear;
		});
	}

	function calendarPrev() {
		if (calendarMonth === 0) { calendarMonth = 11; calendarYear--; }
		else calendarMonth--;
		calendarSelectedDay = null;
		loadCalendarEvents();
	}

	function calendarNext() {
		if (calendarMonth === 11) { calendarMonth = 0; calendarYear++; }
		else calendarMonth++;
		calendarSelectedDay = null;
		loadCalendarEvents();
	}

	const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

	// Compose modal state
	let composeOpen = $state(false);
	let composeText = $state('');

	// Wrap (Tauri webview wrappers) state
	let wrapServices = $state([]);
	let wrapOpening = $state(null);
	let wrapMsg = $state('');

	async function loadWrapServices() {
		try {
			const res = await fetch(`${window.location.origin}/api/v1/wrap/services`);
			if (res.ok) {
				const data = await res.json();
				wrapServices = data.services || [];
			}
		} catch (e) { console.error('[PAN Wrap] services load failed:', e); }
	}

	async function openWrapper(serviceId) {
		wrapOpening = serviceId;
		wrapMsg = '';
		try {
			const res = await fetch(`${window.location.origin}/api/v1/wrap/open/${serviceId}`, { method: 'POST' });
			const data = await res.json();
			if (!res.ok || !data.ok) wrapMsg = data.error || 'Failed to open wrapper';
			else wrapMsg = `Opened ${serviceId} (${data.label})`;
		} catch (e) {
			wrapMsg = e.message || 'Failed to open wrapper';
		} finally {
			wrapOpening = null;
			setTimeout(() => { wrapMsg = ''; }, 3000);
		}
	}

	function openPanWindow(url, opts = {}) {
		// Always use Tauri shell API — window.open() doesn't create real windows in Tauri
		fetch('/api/v1/ui-commands', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				type: 'open_window',
				url,
				title: opts.title || 'PAN',
				width: opts.width || 600,
				height: opts.height || 500
			})
		}).catch(() => {});
	}

	async function toggleFavorite(contact, e) {
		e.stopPropagation();
		const newVal = contact.favorited ? 0 : 1;
		try {
			await fetch(`/api/v1/chat/contacts/${contact.id}`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ favorited: newVal })
			});
			contact.favorited = newVal;
			commsContacts = [...commsContacts]; // trigger reactivity
		} catch {}
	}

	let filteredContacts = $derived(() => {
		let list = [...commsContacts];
		if (commsSearch.trim()) {
			const q = commsSearch.trim().toLowerCase();
			list = list.filter(c => c.display_name.toLowerCase().includes(q));
		}
		// Sort: favorites first, then alphabetical
		return list.sort((a, b) => {
			if (a.favorited && !b.favorited) return -1;
			if (!a.favorited && b.favorited) return 1;
			return a.display_name.localeCompare(b.display_name);
		});
	});

	function commsInitials(name) {
		if (!name) return '?';
		const parts = name.trim().split(/\s+/);
		if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
		return name.substring(0, 2).toUpperCase();
	}

	// Check for calendar notifications every 30s
	$effect(() => {
		if (typeof window === 'undefined') return;
		const iv = setInterval(() => {
			const now = Date.now();
			for (const evt of calendarEvents) {
				const diff = evt.starts_at - now;
				if (diff > 0 && diff < 60000 && evt.notify) {
					calendarFlash = true;
					setTimeout(() => { calendarFlash = false; }, 3000);
				}
			}
		}, 30000);
		return () => clearInterval(iv);
	});

	function commsFormatTime(ts) {
		if (!ts) return '';
		const d = new Date(typeof ts === 'number' ? ts : parseInt(ts));
		const now = new Date();
		if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
		return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
	}

	async function loadUnread() {
		try {
			const res = await fetch('/api/v1/chat/unread');
			if (res.ok) {
				const data = await res.json();
				unreadMessages = data.unread || 0;
			}
		} catch {}
	}

	let serverStatus = $state('connecting');
	let userName = $state('');
	let userMenuOpen = $state(false);
	let orgList = $state([]);
	let activeOrg = $state(null);
	let orgSwitcherOpen = $state(false);

	const isDev = typeof window !== 'undefined' && window.location.port !== '7777' && window.location.port !== '';

	let collapsed = $derived(isSidebarCollapsed());
	let mobileMenuOpen = $state(false);

	// Sidebar resize
	let sidebarWidth = $state(210);
	let sidebarResizing = $state(false);
	let sidebarResizeStartX = 0;
	let sidebarResizeStartW = 0;

	function onSidebarResizeStart(e) {
		if (collapsed) return;
		e.preventDefault();
		sidebarResizing = true;
		sidebarResizeStartX = e.clientX;
		sidebarResizeStartW = sidebarWidth;
		document.addEventListener('mousemove', onSidebarResizeMove);
		document.addEventListener('mouseup', onSidebarResizeEnd);
	}
	function onSidebarResizeMove(e) {
		if (!sidebarResizing) return;
		const delta = e.clientX - sidebarResizeStartX;
		sidebarWidth = Math.min(400, Math.max(140, sidebarResizeStartW + delta));
	}
	function onSidebarResizeEnd() {
		sidebarResizing = false;
		document.removeEventListener('mousemove', onSidebarResizeMove);
		document.removeEventListener('mouseup', onSidebarResizeEnd);
	}

	// Branding — customizable logo image or text (cached in localStorage)
	let brandingLogo = $state('Π');
	let brandingImage = $state('');
	if (typeof window !== 'undefined') {
		const bl = localStorage.getItem('pan_branding_logo');
		if (bl) brandingLogo = bl.charAt(0);
		const bi = localStorage.getItem('pan_branding_image');
		if (bi) brandingImage = bi;
	}

	function handleBrandingChange(e) {
		const logo = e.detail?.logo;
		const image = e.detail?.image;
		if (logo) brandingLogo = logo.charAt(0);
		brandingImage = image || '';
	}

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

	async function loadOrgs() {
		try {
			const res = await fetch('/api/v1/orgs');
			if (res.ok) {
				const data = await res.json();
				orgList = data.orgs || [];
				activeOrg = orgList.find(o => o.id === data.active) || orgList[0] || null;
			}
		} catch {}
	}

	async function switchOrg(orgId) {
		try {
			await fetch('/api/v1/orgs/switch', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ org_id: orgId })
			});
			orgSwitcherOpen = false;
			await loadOrgs();
			// Reload page to reflect new org context
			window.location.reload();
		} catch {}
	}

	// Auto-reload on Craft swap — polls version.json, reloads if build changed
	let _knownVersion = null;
	async function checkVersion() {
		try {
			const r = await fetch(`/v2/_app/version.json?_=${Date.now()}`);
			if (!r.ok) return;
			const d = await r.json();
			if (_knownVersion && d.version !== _knownVersion) {
				console.log('[PAN] Build changed, auto-reloading...');
				try { if ('caches' in window) { const ks = await caches.keys(); ks.forEach(k => caches.delete(k)); } } catch {}
				window.location.reload();
				return;
			}
			_knownVersion = d.version;
		} catch {}
	}

	$effect(() => {
		checkHealth();
		loadUser();
		loadOrgs();
		loadUnread();
		checkVersion();
		const iv = setInterval(checkHealth, 10000);
		const uiv = setInterval(loadUnread, 15000);
		const viv = setInterval(checkVersion, 5000);
		window.addEventListener('pan-branding-changed', handleBrandingChange);
		return () => {
			clearInterval(iv);
			clearInterval(uiv);
			clearInterval(viv);
			window.removeEventListener('pan-branding-changed', handleBrandingChange);
		};
	});
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<!-- svelte-ignore a11y_click_events_have_key_events -->
{#if mobileMenuOpen}
	<div class="mobile-overlay" onclick={closeMobileMenu}></div>
{/if}

{#if page.url.pathname.includes('/atlas') || page.url.pathname.includes('/atlas-v2') || page.url.pathname.includes('/kronos') || page.url.pathname.includes('/crucible') || page.url.pathname.includes('/compose') || page.url.pathname.includes('/call') || page.url.pathname.includes('/comms')}
	{@render children()}
{:else}
<div class="shell">
	<nav class="sidebar" class:collapsed class:mobile-open={mobileMenuOpen} style={collapsed ? '' : `width: ${sidebarWidth}px; min-width: ${sidebarWidth}px`}>
		<div class="logo">
			{#if brandingImage}
				<img class="logo-img" src={brandingImage} alt="Logo" />
			{:else}
				<span class="logo-pi">{brandingLogo}</span>
			{/if}
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
					onclick={(e) => {
						closeMobileMenu();
						if (tab.openAsWindow) {
							e.preventDefault();
							const url = `${window.location.origin}${tab.href}`;
							window.open(url, tab.label, 'width=1200,height=800');
						}
					}}
				>
					<span class="tab-icon">{tab.icon}</span>
					{#if !collapsed}
						<span class="tab-label">{tab.label}</span>
					{/if}
				</a>
			{/each}
		</div>

		<!-- Comms — contact list with inline chat -->
		<div class="comms-section" class:comms-expanded={commsOpen && commsActiveContact}>
			<button class="comms-header" onclick={toggleComms} title={collapsed ? 'Comms' : ''}>
				<span class="tab-icon">📻</span>
				{#if !collapsed}
					<span class="comms-label">Comms</span>
					{#if unreadMessages > 0}
						<span class="comms-badge">{unreadMessages > 99 ? '99+' : unreadMessages}</span>
					{/if}
					<span class="comms-chevron">{commsOpen ? '▾' : '▸'}</span>
				{:else if unreadMessages > 0}
					<span class="comms-badge-dot"></span>
				{/if}
			</button>
			{#if commsOpen && !collapsed}
				<div class="comms-body">
					<!-- Contacts / Messages / Calendar toggle -->
					<div class="comms-view-toggle">
						<button class="comms-vtab" class:active={commsView === 'contacts'} onclick={() => { commsView = 'contacts'; loadCommsContacts(); }} title="Contacts">👤</button>
						<button class="comms-vtab" class:active={commsView === 'mail'} onclick={() => { commsView = 'mail'; commsActiveContact = null; loadUnifiedInbox(); }} title="Mail">
							📨
							{#if unreadMessages > 0}<span class="comms-msg-badge">{unreadMessages}</span>{/if}
						</button>
						<button class="comms-vtab" class:active={commsView === 'calendar'} class:flash={calendarFlash} onclick={() => { commsView = 'calendar'; commsActiveContact = null; loadCalendarEvents(); }} title="Calendar">📅</button>
						<button class="comms-vtab comms-expand-btn" onclick={() => openExpandedCommsView(commsView)} title="Open {commsView} in window">↗</button>
					</div>

					{#if commsView === 'mail'}
						<div class="comms-messages-view">
							<!-- Toolbar: filter tabs + actions -->
							<div class="comms-unified-toolbar">
								<div class="comms-msg-subtabs">
									<button class="comms-msg-subtab" class:active={unifiedFilter === 'all'} onclick={() => { unifiedFilter = 'all'; loadUnifiedInbox(); }}>All</button>
									<button class="comms-msg-subtab" class:active={unifiedFilter === 'pan'} onclick={() => { unifiedFilter = 'pan'; loadUnifiedInbox(); }}>PAN</button>
									<button class="comms-msg-subtab" class:active={unifiedFilter === 'email'} onclick={() => { unifiedFilter = 'email'; loadUnifiedInbox(); }}>Email</button>
								</div>
								<div class="comms-unified-actions">
									<button class="comms-action-btn" onclick={openComposeWindow} title="Compose">📝</button>
									{#if unifiedEmailConfigured}
										<button class="comms-action-btn" onclick={syncEmailFromUnified} disabled={unifiedLoading} title="Sync Email">↻</button>
									{/if}
								</div>
							</div>

							<!-- Message list (compose opens in Tauri window via 📝 button) -->
							{#if unifiedLoading && unifiedMessages.length === 0}
								<div class="comms-empty">Loading...</div>
							{:else if unifiedMessages.length === 0}
								<div class="comms-empty">No messages</div>
							{:else}
								<div class="comms-msg-list">
									{#each unifiedMessages as msg}
										<button class="comms-msg-row" class:unread={!msg.read} onclick={() => unifiedClickMessage(msg)}>
											{#if msg.type === 'email'}
												<span class="comms-avatar comms-avatar-sm comms-avatar-email">📧</span>
											{:else}
												<span class="comms-avatar comms-avatar-sm">{commsInitials(msg.from_name || '?')}</span>
											{/if}
											<div class="comms-msg-row-body">
												<div class="comms-msg-row-top">
													<span class="comms-msg-row-name" class:unread={!msg.read}>{msg.from_name || 'Unknown'}</span>
													<span class="comms-transport-badge" class:pan={msg.type === 'pan'} class:email={msg.type === 'email'}>{msg.type === 'pan' ? 'PAN' : 'Email'}</span>
													<span class="comms-msg-row-time">{commsTimeAgo(msg.date)}</span>
												</div>
												{#if msg.type === 'email' && msg.subject}
													<div class="comms-email-subject" class:unread={!msg.read}>{msg.subject}</div>
												{/if}
												<div class="comms-msg-row-preview">{msg.body_preview}</div>
											</div>
										</button>
										<!-- Expanded email view -->
										{#if msg.type === 'email' && unifiedExpandedEmail === msg.id}
											<div class="comms-email-expanded">
												{#if unifiedEmailDetail}
													<div class="comms-email-header">
														<div><strong>From:</strong> {unifiedEmailDetail.from_name ? `${unifiedEmailDetail.from_name} <${unifiedEmailDetail.from_address}>` : unifiedEmailDetail.from_address}</div>
														<div><strong>To:</strong> {unifiedEmailDetail.to_address}</div>
														<div><strong>Date:</strong> {new Date(unifiedEmailDetail.date).toLocaleString()}</div>
														{#if unifiedEmailDetail.attachments_json}
															{@const atts = JSON.parse(unifiedEmailDetail.attachments_json)}
															<div class="comms-email-attachments">
																{#each atts as att}
																	<span class="comms-email-att">📎 {att.filename}</span>
																{/each}
															</div>
														{/if}
													</div>
													<div class="comms-email-body-content">
														{#if unifiedEmailDetail.body_html}
															{@html unifiedEmailDetail.body_html}
														{:else}
															<pre class="comms-email-text">{unifiedEmailDetail.body_text || '(empty)'}</pre>
														{/if}
													</div>
												{:else}
													<div class="comms-empty">Loading email...</div>
												{/if}
											</div>
										{/if}
									{/each}
								</div>
							{/if}
						</div>
					{:else if commsView === 'calendar'}
						<div class="comms-calendar">
							<div class="cal-nav">
								<button class="cal-nav-btn" onclick={calendarPrev}>◂</button>
								<span class="cal-month">{monthNames[calendarMonth]} {calendarYear}</span>
								<button class="cal-nav-btn" onclick={calendarNext}>▸</button>
							</div>
							<div class="cal-grid">
								<span class="cal-dow">Su</span><span class="cal-dow">Mo</span><span class="cal-dow">Tu</span><span class="cal-dow">We</span><span class="cal-dow">Th</span><span class="cal-dow">Fr</span><span class="cal-dow">Sa</span>
								{#each Array(calendarFirstDow(calendarYear, calendarMonth)) as _}
									<span class="cal-blank"></span>
								{/each}
								{#each Array(calendarDaysInMonth(calendarYear, calendarMonth)) as _, i}
									{@const day = i + 1}
									{@const hasEvents = calendarEventsOnDay(day).length > 0}
									{@const isToday = day === new Date().getDate() && calendarMonth === new Date().getMonth() && calendarYear === new Date().getFullYear()}
									<button
										class="cal-day"
										class:today={isToday}
										class:has-events={hasEvents}
										class:selected={calendarSelectedDay === day}
										onclick={() => { calendarSelectedDay = day; }}
									>{day}</button>
								{/each}
							</div>
							{#if calendarSelectedDay}
								<div class="cal-day-detail">
									<div class="cal-day-header">
										<span>{monthNames[calendarMonth]} {calendarSelectedDay}</span>
										<button class="cal-add-btn" onclick={() => { calendarAddModal = true; }}>+ Event</button>
									</div>
									{#each calendarEventsOnDay(calendarSelectedDay) as evt}
										<div class="cal-event">{new Date(evt.starts_at).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})} — {evt.title}</div>
									{/each}
									{#if calendarEventsOnDay(calendarSelectedDay).length === 0}
										<div class="cal-no-events">No events</div>
									{/if}
								</div>
								{#if calendarAddModal}
									<div class="cal-add-form">
										<input type="text" class="comms-chat-input" placeholder="Event title" bind:value={calendarNewTitle} />
										<input type="time" class="comms-chat-input" bind:value={calendarNewTime} />
										<div class="comms-compose-actions">
											<button class="comms-compose-send" onclick={addCalendarEvent}>Add</button>
											<button class="comms-compose-cancel" onclick={() => { calendarAddModal = false; }}>Cancel</button>
										</div>
									</div>
								{/if}
							{/if}
						</div>
					{:else if commsLoading}
						<div class="comms-empty">Loading...</div>
					{:else if commsError}
						<div class="comms-empty">{commsError} <button class="comms-retry-btn" onclick={loadCommsContacts}>Retry</button></div>
					{:else if commsContacts.length === 0}
						<div class="comms-empty">No contacts</div>
					{:else}
						<div class="comms-search-bar">
							<input type="text" class="comms-search-input" placeholder="Search contacts..." bind:value={commsSearch} />
						</div>
						<div class="comms-list">
							{#each filteredContacts() as contact}
								<button
									class="comms-contact"
									class:active={commsActiveContact?.id === contact.id}
									onclick={() => commsClickContact(contact)}
									title={contact.display_name}
								>
									<span class="comms-avatar" class:online={contact.status === 'online'}>{contact.display_name.charAt(0).toUpperCase()}</span>
									<span class="comms-name">{contact.display_name}</span>
									<!-- svelte-ignore a11y_no_static_element_interactions -->
									<!-- svelte-ignore a11y_click_events_have_key_events -->
									<span class="comms-fav-btn" class:favorited={contact.favorited} onclick={(e) => toggleFavorite(contact, e)} title={contact.favorited ? 'Unfavorite' : 'Favorite'}>
										{contact.favorited ? '★' : '☆'}
									</span>
									{#if contact.unread_count > 0}
										<span class="comms-unread">{contact.unread_count}</span>
									{/if}
								</button>

								<!-- Inline chat: takes over most of the Comms area -->
								{#if commsActiveContact?.id === contact.id}
									<div class="comms-chat">
										<div class="comms-chat-messages" bind:this={commsMessagesEl}>
											{#if commsMessages.length === 0}
												<div class="comms-chat-empty">No messages yet — say hi</div>
											{:else}
												{#each commsMessages as msg}
													<div class="comms-msg" class:self={msg.sender_id === 'self'}>
														<span class="comms-msg-sender" class:self={msg.sender_id === 'self'}>{msg.sender_id === 'self' ? 'You' : commsInitials(contact.display_name)}</span>
														<span class="comms-msg-text">{msg.body}</span>
														<span class="comms-msg-time">{commsFormatTime(msg.created_at)}</span>
													</div>
												{/each}
											{/if}
										</div>
										<div class="comms-chat-input-row">
											<input
												type="text"
												class="comms-chat-input"
												placeholder="Message {contact.display_name}..."
												bind:value={commsInput}
												onkeydown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commsSendMessage(); } }}
											/>
										</div>
										<div class="comms-chat-actions">
											<button class="comms-action" title="Call / Video / Screen Share" onclick={() => openPanWindow(`${window.location.origin}/v2/call?thread=${commsActiveThread}&name=${encodeURIComponent(contact.display_name)}&contact=${contact.id}`, { width: 500, height: 600, title: `Call — ${contact.display_name}` })}>📞 Call</button>
											<button class="comms-action" title="Compose rich message" onclick={() => openPanWindow(`${window.location.origin}/v2/compose?thread=${commsActiveThread}&name=${encodeURIComponent(contact.display_name)}&contact=${contact.id}`, { width: 600, height: 500, title: `Compose — ${contact.display_name}` })}>📝 Compose</button>
										</div>
									</div>
								{/if}
							{/each}
						</div>
					{/if}
				</div>
			{:else if commsOpen && collapsed}
				<div class="comms-items collapsed">
					<button class="comms-item" title="Comms" onclick={() => { toggleSidebar(); }}>
						<span class="tab-icon">👤</span>
					</button>
				</div>
			{/if}
		</div>

		<div class="sidebar-spacer"></div>

		<div class="sidebar-bottom">
			{#if orgList.filter(o => o.id !== 'org_personal').length > 0}
				<div class="org-switcher" class:collapsed>
					<button class="org-current" onclick={() => orgSwitcherOpen = !orgSwitcherOpen} title={collapsed ? (activeOrg?.name || 'Org') : ''}>
						<span class="org-dot" style="background: {activeOrg?.color_primary || '#89b4fa'}"></span>
						{#if !collapsed}
							<span class="org-current-name">{activeOrg?.name || 'Personal'}</span>
							<span class="org-chevron">{orgSwitcherOpen ? '▴' : '▾'}</span>
						{/if}
					</button>
					{#if orgSwitcherOpen}
						<div class="org-dropdown-backdrop" onclick={() => orgSwitcherOpen = false}></div>
						<div class="org-dropdown">
							{#each orgList.filter(o => o.id !== 'org_personal') as org}
								<button
									class="org-option"
									class:active={org.id === activeOrg?.id}
									onclick={() => switchOrg(org.id)}
								>
									<span class="org-dot-sm" style="background: {org.color_primary || '#89b4fa'}"></span>
									<span class="org-option-name">{org.name}</span>
									{#if org.role_name}
										<span class="org-option-role">{org.role_name}</span>
									{/if}
								</button>
							{/each}
						</div>
					{/if}
				</div>
			{/if}

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
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div class="sidebar-resize-handle" onmousedown={onSidebarResizeStart}></div>
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
		border-right: none;
		display: flex;
		flex-direction: column;
		padding: 0;
		transition: width 0.2s ease, min-width 0.2s ease;
	}

	.sidebar-resize-handle {
		width: 4px;
		cursor: col-resize;
		background: #1e1e2e;
		flex-shrink: 0;
		transition: background 0.15s;
	}
	.sidebar-resize-handle:hover {
		background: #89b4fa;
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

	.logo-img {
		max-height: 28px;
		max-width: 120px;
		object-fit: contain;
		flex-shrink: 0;
	}

	.sidebar.collapsed .logo-img {
		max-width: 28px;
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

	/* Comms section */
	.comms-section {
		border-top: 1px solid #1e1e2e;
		padding: 8px 8px 0;
	}

	.sidebar.collapsed .comms-section {
		padding: 8px 4px 0;
	}

	.comms-header {
		display: flex;
		align-items: center;
		gap: 10px;
		width: 100%;
		padding: 9px 12px;
		border: none;
		border-radius: 6px;
		background: transparent;
		color: #6c7086;
		cursor: pointer;
		font-family: inherit;
		font-size: 13.5px;
		font-weight: 400;
		transition: all 0.15s;
		position: relative;
	}

	.sidebar.collapsed .comms-header {
		justify-content: center;
		padding: 9px 0;
		gap: 0;
	}

	.comms-header:hover {
		color: #cdd6f4;
		background: #1a1a25;
	}

	.comms-label {
		flex: 1;
		text-align: left;
		white-space: nowrap;
	}

	.comms-chevron {
		font-size: 10px;
		color: #6c7086;
		flex-shrink: 0;
	}

	.comms-badge {
		background: #f38ba8;
		color: #0a0a0f;
		font-size: 10px;
		font-weight: 700;
		padding: 1px 5px;
		border-radius: 8px;
		min-width: 16px;
		text-align: center;
		line-height: 14px;
	}

	.comms-badge-dot {
		position: absolute;
		top: 6px;
		right: 6px;
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: #f38ba8;
	}

	.comms-items {
		display: flex;
		flex-direction: column;
		gap: 1px;
		padding: 4px 0 4px 8px;
	}

	.comms-items.collapsed {
		padding: 4px 0;
	}

	.comms-item {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 7px 12px;
		border: none;
		border-radius: 5px;
		background: transparent;
		color: #585b70;
		cursor: pointer;
		font-family: inherit;
		font-size: 12.5px;
		transition: all 0.15s;
		white-space: nowrap;
	}

	.comms-items.collapsed .comms-item {
		justify-content: center;
		padding: 7px 0;
		gap: 0;
	}

	.comms-item:hover {
		color: #cdd6f4;
		background: #1a1a25;
	}

	.comms-item .tab-icon {
		font-size: 13px;
	}

	/* Comms mini-app */
	.comms-section.comms-expanded {
		flex: 1;
		display: flex;
		flex-direction: column;
		min-height: 0;
		overflow: hidden;
	}

	/* When chat is open, kill the spacer so comms eats that space */
	.comms-section.comms-expanded ~ .sidebar-spacer {
		flex: 0 !important;
	}

	.comms-body {
		padding: 0 6px 6px;
		overflow-y: auto;
		flex: 1;
		min-height: 0;
		display: flex;
		flex-direction: column;
	}

	.comms-section.comms-expanded .comms-body {
		flex: 1;
		overflow: hidden;
	}

	.comms-list {
		display: flex;
		flex-direction: column;
		gap: 1px;
		flex: 1;
		min-height: 0;
	}

	.comms-contact {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 5px 8px;
		background: none;
		border: none;
		color: #cdd6f4;
		cursor: pointer;
		border-radius: 4px;
		font-size: 12px;
		text-align: left;
		width: 100%;
		transition: background 0.1s;
	}

	.comms-contact:hover { background: rgba(137,180,250,0.08); }
	.comms-contact.active { background: rgba(137,180,250,0.12); }

	.comms-avatar {
		width: 24px;
		height: 24px;
		border-radius: 50%;
		background: #585b70;
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: 11px;
		font-weight: 600;
		color: #cdd6f4;
		flex-shrink: 0;
		position: relative;
	}

	.comms-avatar.online::after {
		content: '';
		position: absolute;
		bottom: -1px;
		right: -1px;
		width: 7px;
		height: 7px;
		background: #a6e3a1;
		border-radius: 50%;
		border: 1.5px solid #181825;
	}

	.comms-name {
		flex: 1;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.comms-fav {
		color: #f9e2af;
		font-size: 10px;
		flex-shrink: 0;
	}

	.comms-search-bar {
		padding: 0 0 4px;
		flex-shrink: 0;
	}

	.comms-search-input {
		width: 100%;
		background: #1e1e2e;
		border: 1px solid #313244;
		border-radius: 5px;
		color: #cdd6f4;
		padding: 5px 8px;
		font-size: 11px;
		outline: none;
		font-family: inherit;
	}

	.comms-search-input:focus {
		border-color: #89b4fa;
	}

	.comms-search-input::placeholder {
		color: #585b70;
	}

	.comms-fav-btn {
		background: none;
		border: none;
		color: #585b70;
		font-size: 12px;
		cursor: pointer;
		padding: 0 2px;
		flex-shrink: 0;
		line-height: 1;
		transition: color 0.1s;
	}

	.comms-fav-btn:hover {
		color: #f9e2af;
	}

	.comms-fav-btn.favorited {
		color: #f9e2af;
	}

	.comms-unread {
		background: #89b4fa;
		color: #11111b;
		font-size: 9px;
		font-weight: 700;
		padding: 1px 5px;
		border-radius: 8px;
		flex-shrink: 0;
	}

	.comms-view-toggle {
		display: flex;
		gap: 4px;
		margin-bottom: 6px;
		padding: 4px;
		background: #1e1e2e;
		border-radius: 5px;
		flex-shrink: 0;
	}

	.comms-vtab {
		flex: 1;
		background: none;
		border: none;
		color: #6c7086;
		font-size: 18px;
		padding: 6px 0;
		cursor: pointer;
		border-radius: 3px;
		transition: all 0.12s;
		line-height: 1;
		display: flex;
		align-items: center;
		justify-content: center;
		min-width: 32px;
		min-height: 32px;
	}

	.comms-vtab:hover { background: rgba(137,180,250,0.08); }
	.comms-vtab.active { background: rgba(137,180,250,0.15); color: #89b4fa; }
	.comms-expand-btn { flex: 0; font-size: 12px; padding: 4px 6px; color: #585b70; }
	.comms-expand-btn:hover { color: #89b4fa; }

	/* Messages tab badge */
	.comms-msg-badge {
		background: #f38ba8;
		color: #11111b;
		font-size: 8px;
		font-weight: 700;
		padding: 0 4px;
		border-radius: 6px;
		margin-left: 3px;
		vertical-align: top;
	}

	/* Messages sub-tabs (Inbox / Sent) */
	.comms-messages-view {
		display: flex;
		flex-direction: column;
		min-height: 0;
		flex: 1;
	}

	.comms-msg-subtabs {
		display: flex;
		gap: 6px;
		margin-bottom: 4px;
	}

	.comms-msg-subtab {
		flex: 1;
		background: none;
		border: none;
		border-bottom: 2px solid transparent;
		color: #6c7086;
		font-size: 10px;
		padding: 3px 0;
		cursor: pointer;
		transition: all 0.12s;
	}

	.comms-msg-subtab:hover { color: #a6adc8; }
	.comms-msg-subtab.active { color: #89b4fa; border-bottom-color: #89b4fa; }

	/* Message list */
	.comms-msg-list {
		display: flex;
		flex-direction: column;
		overflow-y: auto;
		flex: 1;
		min-height: 0;
	}

	.comms-msg-row {
		display: flex;
		gap: 8px;
		align-items: flex-start;
		padding: 6px 8px;
		background: none;
		border: none;
		border-bottom: 1px solid #1e1e2e;
		cursor: pointer;
		text-align: left;
		width: 100%;
		transition: background 0.1s;
		color: #bac2de;
	}

	.comms-msg-row:hover { background: rgba(137,180,250,0.06); }
	.comms-msg-row.unread { background: rgba(137,180,250,0.04); }

	.comms-avatar-sm {
		width: 26px;
		height: 26px;
		font-size: 9px;
		flex-shrink: 0;
	}

	.comms-msg-row-body {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 1px;
	}

	.comms-msg-row-top {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
	}

	.comms-msg-row-name {
		font-size: 11px;
		color: #cdd6f4;
		font-weight: 400;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.comms-msg-row-name.unread {
		font-weight: 700;
		color: #cdd6f4;
	}

	.comms-msg-row-time {
		font-size: 9px;
		color: #585b70;
		flex-shrink: 0;
		margin-left: 4px;
	}

	.comms-msg-row-preview {
		font-size: 10px;
		color: #6c7086;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		line-height: 1.3;
	}

	.comms-empty {
		text-align: center;
		color: #585b70;
		font-size: 11px;
		padding: 12px 0;
	}
	.comms-retry-btn {
		background: #313244;
		color: #cdd6f4;
		border: 1px solid #45475a;
		border-radius: 4px;
		padding: 2px 8px;
		font-size: 10px;
		cursor: pointer;
		margin-left: 4px;
	}
	.comms-retry-btn:hover { background: #45475a; }

	/* Wrap view */
	.comms-wrap-view { padding: 8px 10px; display: flex; flex-direction: column; gap: 8px; }
	.comms-wrap-header { font-size: 11px; color: #cdd6f4; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; }
	.comms-wrap-hint { font-size: 10px; color: #6c7086; line-height: 1.4; }
	.comms-wrap-list { display: flex; flex-direction: column; gap: 4px; }
	.comms-wrap-item {
		display: flex; align-items: center; gap: 8px;
		padding: 6px 8px; background: #1e1e2e; border: 1px solid #313244;
		border-radius: 6px;
	}
	.comms-wrap-info { flex: 1; min-width: 0; }
	.comms-wrap-name { font-size: 12px; color: #cdd6f4; font-weight: 500; }
	.comms-wrap-url { font-size: 9px; color: #6c7086; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.comms-wrap-open {
		background: #89b4fa; color: #1e1e2e; border: none;
		padding: 4px 10px; border-radius: 4px; font-size: 10px;
		font-weight: 600; cursor: pointer;
	}
	.comms-wrap-open:hover:not(:disabled) { background: #74c7ec; }
	.comms-wrap-open:disabled { opacity: 0.5; cursor: not-allowed; }
	.comms-wrap-msg { font-size: 10px; color: #a6e3a1; padding: 4px 0; }

	/* Inline chat — takes over most of sidebar when open */
	.comms-chat {
		display: flex;
		flex-direction: column;
		margin: 2px 0 4px 0;
		border-left: 2px solid #89b4fa;
		background: #11111b;
		border-radius: 0 6px 6px 0;
		overflow: hidden;
		flex: 1;
		min-height: 0;
	}

	.comms-chat-messages {
		flex: 1;
		min-height: 80px;
		overflow-y: auto;
		padding: 6px 8px;
		display: flex;
		flex-direction: column;
		gap: 3px;
	}

	.comms-chat-empty {
		color: #585b70;
		font-size: 10px;
		text-align: center;
		padding: 16px 0;
	}

	.comms-msg {
		display: flex;
		gap: 6px;
		align-items: baseline;
		font-size: 11px;
	}

	.comms-msg-sender {
		font-size: 9px;
		font-weight: 700;
		color: #f9e2af;
		flex-shrink: 0;
		min-width: 20px;
	}

	.comms-msg-sender.self {
		color: #89b4fa;
	}

	.comms-msg.self .comms-msg-text {
		color: #89b4fa;
	}

	.comms-msg-text {
		color: #bac2de;
		flex: 1;
		word-break: break-word;
	}

	.comms-msg-time {
		color: #45475a;
		font-size: 9px;
		flex-shrink: 0;
	}

	/* Compose modal */
	.comms-compose {
		padding: 6px;
		border-top: 1px solid #1e1e2e;
	}

	.comms-compose-input {
		width: 100%;
		background: #1e1e2e;
		border: 1px solid #313244;
		border-radius: 4px;
		color: #cdd6f4;
		padding: 6px 8px;
		font-size: 11px;
		font-family: inherit;
		outline: none;
		resize: vertical;
		min-height: 60px;
	}

	.comms-compose-input:focus { border-color: #89b4fa; }

	.comms-compose-actions {
		display: flex;
		gap: 4px;
		margin-top: 4px;
	}

	.comms-compose-send {
		background: #89b4fa;
		color: #11111b;
		border: none;
		padding: 4px 12px;
		border-radius: 4px;
		font-size: 10px;
		font-weight: 600;
		cursor: pointer;
	}

	.comms-compose-cancel {
		background: none;
		color: #6c7086;
		border: 1px solid #313244;
		padding: 4px 10px;
		border-radius: 4px;
		font-size: 10px;
		cursor: pointer;
	}

	.comms-chat-input-row {
		padding: 4px 6px;
		border-top: 1px solid #1e1e2e;
	}

	.comms-chat-input {
		width: 100%;
		background: #1e1e2e;
		border: 1px solid #313244;
		border-radius: 4px;
		color: #cdd6f4;
		padding: 5px 8px;
		font-size: 11px;
		outline: none;
	}

	.comms-chat-input:focus {
		border-color: #89b4fa;
	}

	.comms-chat-actions {
		display: flex;
		gap: 2px;
		padding: 3px 6px 5px;
		border-top: 1px solid #1e1e2e;
	}

	.comms-action {
		flex: 1;
		background: none;
		border: none;
		color: #6c7086;
		font-size: 13px;
		padding: 3px 0;
		cursor: pointer;
		border-radius: 4px;
		transition: all 0.1s;
	}

	.comms-action:hover {
		background: rgba(137,180,250,0.1);
		color: #89b4fa;
	}

	/* Unified Messages */
	.comms-unified-toolbar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 2px 4px;
		border-bottom: 1px solid #313244;
		flex-shrink: 0;
	}
	.comms-unified-actions {
		display: flex;
		gap: 2px;
	}
	.comms-action-btn {
		background: none;
		border: 1px solid #313244;
		color: #a6adc8;
		font-size: 13px;
		width: 24px;
		height: 24px;
		border-radius: 4px;
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: center;
		transition: all 0.15s;
	}
	.comms-action-btn:hover { background: rgba(137,180,250,0.1); color: #89b4fa; border-color: #89b4fa; }
	.comms-action-btn:disabled { opacity: 0.4; cursor: default; }

	.comms-transport-badge {
		font-size: 9px;
		padding: 0 4px;
		border-radius: 3px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.3px;
		flex-shrink: 0;
	}
	.comms-transport-badge.pan {
		background: rgba(137,180,250,0.15);
		color: #89b4fa;
	}
	.comms-transport-badge.email {
		background: rgba(108,112,134,0.2);
		color: #6c7086;
	}

	.comms-avatar-email {
		font-size: 14px;
		display: flex;
		align-items: center;
		justify-content: center;
		background: rgba(108,112,134,0.2);
	}

	/* Unified Compose */
	.comms-unified-compose {
		padding: 6px 8px;
		display: flex;
		flex-direction: column;
		gap: 4px;
		border-bottom: 1px solid #313244;
		background: rgba(30,30,46,0.5);
	}
	.comms-compose-to-wrap {
		position: relative;
	}
	.comms-compose-to-badge {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		background: rgba(137,180,250,0.15);
		color: #89b4fa;
		font-size: 11px;
		padding: 2px 6px;
		border-radius: 3px;
		margin-top: 2px;
	}
	.comms-compose-to-clear {
		background: none;
		border: none;
		color: #89b4fa;
		cursor: pointer;
		font-size: 11px;
		padding: 0 2px;
	}
	.comms-compose-dropdown {
		position: absolute;
		top: 100%;
		left: 0;
		right: 0;
		background: #1e1e2e;
		border: 1px solid #313244;
		border-radius: 4px;
		z-index: 100;
		max-height: 150px;
		overflow-y: auto;
		box-shadow: 0 4px 12px rgba(0,0,0,0.4);
	}
	.comms-compose-dropdown-item {
		display: flex;
		align-items: center;
		gap: 6px;
		width: 100%;
		padding: 6px 8px;
		background: none;
		border: none;
		color: #cdd6f4;
		font-size: 12px;
		cursor: pointer;
		text-align: left;
	}
	.comms-compose-dropdown-item:hover { background: rgba(137,180,250,0.1); }
	.comms-compose-dropdown-email { color: #6c7086; font-size: 10px; }
	.comms-compose-dropdown-icon { font-size: 14px; }
	.comms-avatar-xs {
		width: 20px;
		height: 20px;
		font-size: 9px;
	}
	.comms-compose-body {
		resize: vertical;
		min-height: 50px;
		font-family: inherit;
	}
	.comms-email-subject {
		font-size: 12px;
		color: #bac2de;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.comms-email-subject.unread {
		color: #cdd6f4;
		font-weight: 600;
	}
	.comms-email-expanded {
		background: #1e1e2e;
		border: 1px solid #313244;
		border-radius: 6px;
		margin: 0 4px 6px;
		padding: 8px;
		max-height: 300px;
		overflow-y: auto;
		font-size: 12px;
	}
	.comms-email-header {
		padding-bottom: 8px;
		border-bottom: 1px solid #313244;
		margin-bottom: 8px;
		color: #a6adc8;
		font-size: 11px;
		line-height: 1.6;
	}
	.comms-email-header strong {
		color: #cdd6f4;
	}
	.comms-email-attachments {
		margin-top: 4px;
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
	}
	.comms-email-att {
		background: #313244;
		padding: 2px 6px;
		border-radius: 4px;
		font-size: 10px;
		color: #89b4fa;
	}
	.comms-email-body-content {
		color: #cdd6f4;
		line-height: 1.5;
		word-break: break-word;
	}
	.comms-email-body-content :global(img) {
		max-width: 100%;
		height: auto;
	}
	.comms-email-text {
		white-space: pre-wrap;
		font-family: inherit;
		font-size: 12px;
		margin: 0;
		color: #cdd6f4;
	}

	/* Calendar */
	.comms-calendar {
		flex: 1;
		display: flex;
		flex-direction: column;
		min-height: 0;
		overflow-y: auto;
	}

	.cal-nav {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 4px 2px;
		flex-shrink: 0;
	}

	.cal-nav-btn {
		background: none;
		border: none;
		color: #6c7086;
		cursor: pointer;
		padding: 2px 6px;
		font-size: 12px;
	}

	.cal-nav-btn:hover { color: #89b4fa; }

	.cal-month {
		font-size: 11px;
		font-weight: 600;
		color: #cdd6f4;
	}

	.cal-grid {
		display: grid;
		grid-template-columns: repeat(7, 1fr);
		gap: 1px;
		flex-shrink: 0;
	}

	.cal-dow {
		font-size: 8px;
		color: #585b70;
		text-align: center;
		padding: 2px 0;
	}

	.cal-blank { }

	.cal-day {
		background: none;
		border: none;
		color: #bac2de;
		font-size: 10px;
		padding: 3px 0;
		cursor: pointer;
		border-radius: 3px;
		text-align: center;
		transition: all 0.1s;
	}

	.cal-day:hover { background: rgba(137,180,250,0.1); }
	.cal-day.today { color: #89b4fa; font-weight: 700; }
	.cal-day.selected { background: rgba(137,180,250,0.2); color: #89b4fa; }
	.cal-day.has-events { position: relative; }
	.cal-day.has-events::after {
		content: '';
		position: absolute;
		bottom: 1px;
		left: 50%;
		transform: translateX(-50%);
		width: 4px;
		height: 4px;
		background: #f9e2af;
		border-radius: 50%;
	}

	.cal-day-detail {
		padding: 6px;
		border-top: 1px solid #1e1e2e;
		flex-shrink: 0;
	}

	.cal-day-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		font-size: 11px;
		color: #cdd6f4;
		font-weight: 600;
		margin-bottom: 4px;
	}

	.cal-add-btn {
		background: none;
		border: 1px solid #313244;
		color: #89b4fa;
		font-size: 9px;
		padding: 2px 6px;
		border-radius: 3px;
		cursor: pointer;
	}

	.cal-add-btn:hover { background: rgba(137,180,250,0.1); }

	.cal-event {
		font-size: 10px;
		color: #bac2de;
		padding: 2px 0;
		border-left: 2px solid #f9e2af;
		padding-left: 6px;
		margin: 2px 0;
	}

	.cal-no-events {
		font-size: 10px;
		color: #585b70;
	}

	.cal-add-form {
		display: flex;
		flex-direction: column;
		gap: 4px;
		padding: 6px;
		border-top: 1px solid #1e1e2e;
	}

	/* Calendar flash notification */
	.comms-vtab.flash {
		animation: cal-flash 0.5s ease-in-out 6;
	}

	@keyframes cal-flash {
		0%, 100% { background: none; }
		50% { background: rgba(249,226,175,0.3); color: #f9e2af; }
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

	/* Org Switcher */
	.org-switcher {
		margin-bottom: 8px;
		position: relative;
	}

	.org-current {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		padding: 7px 8px;
		border: 1px solid #1e1e2e;
		border-radius: 6px;
		background: transparent;
		color: #cdd6f4;
		cursor: pointer;
		font-family: inherit;
		font-size: 12px;
		transition: all 0.15s;
	}

	.org-switcher.collapsed .org-current {
		justify-content: center;
		padding: 7px 0;
	}

	.org-current:hover {
		background: #1a1a25;
		border-color: #89b4fa44;
	}

	.org-dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		flex-shrink: 0;
	}

	.org-current-name {
		flex: 1;
		text-align: left;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-weight: 500;
	}

	.org-chevron {
		color: #6c7086;
		font-size: 10px;
		flex-shrink: 0;
	}

	.org-dropdown-backdrop {
		position: fixed;
		inset: 0;
		z-index: 99;
	}

	.org-dropdown {
		position: absolute;
		bottom: 100%;
		left: 0;
		right: 0;
		background: #1a1a25;
		border: 1px solid #1e1e2e;
		border-radius: 6px;
		padding: 4px;
		z-index: 100;
		box-shadow: 0 -4px 16px rgba(0,0,0,0.4);
		margin-bottom: 4px;
		max-height: 200px;
		overflow-y: auto;
	}

	.org-option {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		padding: 7px 10px;
		border: none;
		border-radius: 4px;
		background: transparent;
		color: #cdd6f4;
		font-size: 12px;
		font-family: inherit;
		cursor: pointer;
		transition: background 0.15s;
		text-align: left;
	}

	.org-option:hover {
		background: rgba(137, 180, 250, 0.1);
	}

	.org-option.active {
		background: rgba(137, 180, 250, 0.12);
		color: #89b4fa;
	}

	.org-dot-sm {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		flex-shrink: 0;
	}

	.org-option-name {
		flex: 1;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.org-option-role {
		font-size: 10px;
		color: #6c7086;
		flex-shrink: 0;
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
