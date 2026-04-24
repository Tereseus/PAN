<script>
	import { onMount, tick } from 'svelte';

	const API_BASE = typeof window !== 'undefined' ? window.location.origin : '';

	// ─── View state ───
	let view = $state('mail'); // contacts | mail | calendar
	let loading = $state(true);

	// ─── Contacts state ───
	let contacts = $state([]);
	let contactSearch = $state('');
	let activeContact = $state(null);
	let chatMessages = $state([]);
	let chatInput = $state('');
	let chatThreadId = $state('');
	let messagesEl;

	// ─── Mail state ───
	let mailItems = $state([]);
	let mailFilter = $state('all'); // all | pan | email
	let mailPage = $state(0);
	let mailStatus = $state(null);
	let selectedMail = $state(null);

	// ─── Calendar state ───
	let calendarEvents = $state([]);
	let calMonth = $state(new Date().getMonth() + 1);
	let calYear = $state(new Date().getFullYear());
	let calSelectedDay = $state(null);

	const TAURI_PORT = 7790;
	const monthNames = ['', 'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

	onMount(() => {
		const params = new URLSearchParams(window.location.search);
		view = params.get('view') || 'mail';
		document.title = view === 'contacts' ? 'Contacts' : view === 'mail' ? 'Mail' : 'Calendar';
		loadData();

		// ─── Live polling ───
		// Poll active thread for new messages every 3s; refresh contact list every 10s.
		let pollTick = 0;
		const pollInterval = setInterval(async () => {
			pollTick++;
			// Refresh active thread
			if (chatThreadId) {
				try {
					const msgs = await api(`/api/v1/chat/threads/${chatThreadId}/messages`);
					if (Array.isArray(msgs) && msgs.length !== chatMessages.length) {
						const atBottom = !messagesEl || messagesEl.scrollTop + messagesEl.clientHeight >= messagesEl.scrollHeight - 40;
						chatMessages = msgs;
						if (atBottom) {
							await tick();
							if (messagesEl) messagesEl.scrollTop = messagesEl.scrollHeight;
						}
					}
				} catch {}
			}
			// Refresh contact list + mail unread counts every 10s
			if (pollTick % (10000 / 3000) === 0) {
				try {
					if (view === 'contacts') {
						const fresh = await api('/api/v1/chat/contacts');
						contacts = fresh;
					} else if (view === 'mail') {
						await loadMail();
					}
				} catch {}
			}
		}, 3000);

		return () => clearInterval(pollInterval);
	});

	async function api(path, opts) {
		const res = await fetch(API_BASE + path, opts);
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		return res.json();
	}

	async function loadData() {
		loading = true;
		try {
			if (view === 'contacts') {
				contacts = await api('/api/v1/chat/contacts');
			} else if (view === 'mail') {
				await loadMail();
				try { mailStatus = await api('/api/v1/email/status'); } catch {}
			} else if (view === 'calendar') {
				calendarEvents = await api(`/api/v1/chat/calendar?month=${calMonth}&year=${calYear}`);
			}
		} catch (e) {
			console.error('Load failed:', e);
		}
		loading = false;
	}

	async function loadMail() {
		try {
			const data = await api(`/api/v1/chat/mail?limit=50&offset=${mailPage * 50}&filter=${mailFilter}`);
			mailItems = data.messages || [];
		} catch {
			mailItems = [];
		}
	}

	async function openChat(contact) {
		activeContact = contact;
		try {
			const res = await api('/api/v1/chat/threads/dm', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ contact_id: contact.id })
			});
			chatThreadId = res.thread_id;
			const msgs = await api(`/api/v1/chat/threads/${chatThreadId}/messages`);
			chatMessages = Array.isArray(msgs) ? msgs : [];
			await api(`/api/v1/chat/threads/${chatThreadId}/read`, { method: 'POST' });
			await tick();
			if (messagesEl) messagesEl.scrollTop = messagesEl.scrollHeight;
		} catch (e) {
			console.error('Open chat failed:', e);
		}
	}

	async function sendChat() {
		if (!chatInput.trim() || !chatThreadId) return;
		const body = chatInput.trim();
		chatInput = '';
		try {
			const res = await api(`/api/v1/chat/threads/${chatThreadId}/messages`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ body })
			});
			chatMessages = [...chatMessages, { id: res.id, sender_id: 'self', body, body_type: 'text', created_at: res.created_at }];
			await tick();
			if (messagesEl) messagesEl.scrollTop = messagesEl.scrollHeight;

			// ΠΑΝ persona reply
			if (chatThreadId === 'thread-pan-system') {
				try {
					const reply = await api('/api/v1/chat/pan-reply', {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({ message: body })
					});
					if (reply?.reply) {
						chatMessages = [...chatMessages, {
							id: reply.reply.id,
							sender_id: 'contact-pan-system',
							body: reply.reply.body,
							body_type: 'text',
							created_at: reply.reply.created_at
						}];
						await tick();
						if (messagesEl) messagesEl.scrollTop = messagesEl.scrollHeight;
					}
				} catch (e) {
					console.error('ΠΑΝ reply failed:', e);
				}
			}
		} catch (e) {
			console.error('Send failed:', e);
		}
	}

	async function openCompose(contact = null, subject = '', email = '') {
		const params = new URLSearchParams();
		if (contact) {
			params.set('contact', contact.id);
			params.set('name', contact.display_name);
			if (contact.email) params.set('email', contact.email);
		} else if (email) {
			params.set('email', email);
		}
		if (subject) params.set('subject', subject);

		const composeUrl = `${API_BASE}/v2/compose?${params.toString()}`;
		try {
			await fetch(`http://127.0.0.1:${TAURI_PORT}/open`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ url: composeUrl, title: 'Compose', width: 640, height: 520 })
			});
		} catch {
			window.open(composeUrl, '_blank', 'width=640,height=520');
		}
	}

	async function syncMail() {
		loading = true;
		try {
			await api('/api/v1/email/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ folder: 'INBOX' }) });
			await loadMail();
		} catch (e) { console.error('Sync failed:', e); }
		loading = false;
	}

	function formatDate(ts) {
		if (!ts) return '';
		// SQLite datetime('now') returns "2026-04-22 21:13:10" (UTC, no timezone suffix).
		// V8/Chromium parses space-separated datetimes as LOCAL time — append 'Z' to force UTC.
		const normalized = typeof ts === 'string' ? ts.replace(' ', 'T').replace(/Z?$/, 'Z') : ts;
		const d = new Date(normalized);
		const now = new Date();
		if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
		return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
	}

	function filteredContacts() {
		if (!contactSearch) return contacts;
		const q = contactSearch.toLowerCase();
		return contacts.filter(c => c.display_name.toLowerCase().includes(q) || (c.email && c.email.toLowerCase().includes(q)));
	}

	// Calendar helpers
	function daysInMonth(y, m) { return new Date(y, m, 0).getDate(); }
	function firstDayOfWeek(y, m) { return new Date(y, m - 1, 1).getDay(); }
	function eventsOnDay(day) {
		const dayStart = new Date(calYear, calMonth - 1, day).getTime();
		const dayEnd = dayStart + 86400000;
		return calendarEvents.filter(e => e.starts_at >= dayStart && e.starts_at < dayEnd);
	}
	function isToday(day) {
		const now = new Date();
		return day === now.getDate() && calMonth === now.getMonth() + 1 && calYear === now.getFullYear();
	}
</script>

<div class="comms-app">
	<!-- Header -->
	<div class="app-header">
		<span class="app-logo">{'\u03A0\u0391\u039D'}</span>
		<div class="tab-bar">
			<button class="tab" class:active={view === 'contacts'} onclick={() => { view = 'contacts'; document.title = 'Contacts'; loadData(); }}>Contacts</button>
			<button class="tab" class:active={view === 'mail'} onclick={() => { view = 'mail'; document.title = 'Mail'; loadData(); }}>Mail</button>
			<button class="tab" class:active={view === 'calendar'} onclick={() => { view = 'calendar'; document.title = 'Calendar'; loadData(); }}>Calendar</button>
		</div>
	</div>

	<!-- CONTACTS VIEW -->
	{#if view === 'contacts'}
		<div class="split-view">
			<div class="list-pane">
				<div class="toolbar">
					<input type="text" class="search-input" placeholder="Search contacts..." bind:value={contactSearch} />
					<button class="tool-btn" onclick={() => openCompose()} title="Compose">{'\uD83D\uDCDD'}</button>
				</div>
				{#each filteredContacts() as contact}
					<div class="list-row" class:active={activeContact?.id === contact.id} onclick={() => openChat(contact)} role="button" tabindex="0">
						<span class="avatar">{contact.display_name.charAt(0).toUpperCase()}</span>
						<div class="row-info">
							<div class="row-name">
								{contact.display_name}
								{#if contact.unread_count > 0}<span class="badge">{contact.unread_count}</span>{/if}
							</div>
							<div class="row-sub">{contact.email || contact.phone || contact.pan_instance_id || ''}</div>
						</div>
						{#if contact.favorited}<span class="fav">&#9733;</span>{/if}
					</div>
				{/each}
				{#if contacts.length === 0 && !loading}
					<div class="empty">No contacts yet</div>
				{/if}
			</div>

			<div class="detail-pane">
				{#if activeContact}
					<div class="detail-header">
						<span class="avatar lg">{activeContact.display_name.charAt(0).toUpperCase()}</span>
						<div>
							<div class="detail-name">{activeContact.display_name}</div>
							<div class="detail-sub">{activeContact.email || activeContact.pan_instance_id || ''}</div>
						</div>
						<button class="tool-btn compose-btn" onclick={() => openCompose(activeContact)} title="Compose to this contact">{'\uD83D\uDCDD'}</button>
					</div>
					<div class="chat-messages" bind:this={messagesEl}>
						{#each chatMessages as msg}
							<div class="chat-bubble" class:self={msg.sender_id === 'self'}>
								<div class="bubble-text">{msg.body}</div>
								<div class="bubble-time">{formatDate(msg.created_at)}</div>
							</div>
						{/each}
						{#if chatMessages.length === 0}
							<div class="empty">No messages yet</div>
						{/if}
					</div>
					<div class="chat-input-bar">
						<textarea
							class="chat-input"
							placeholder="Type a message..."
							bind:value={chatInput}
							rows="1"
							onkeydown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); } }}
						></textarea>
						<button class="send-btn" onclick={sendChat} disabled={!chatInput.trim()}>Send</button>
					</div>
				{:else}
					<div class="empty-detail">Select a contact to start chatting</div>
				{/if}
			</div>
		</div>

	<!-- MAIL VIEW -->
	{:else if view === 'mail'}
		<div class="split-view">
			<div class="list-pane mail-list-pane">
				<div class="toolbar">
					<div class="filter-tabs">
						<button class="filter-tab" class:active={mailFilter === 'all'} onclick={() => { mailFilter = 'all'; loadMail(); }}>All</button>
						<button class="filter-tab" class:active={mailFilter === 'pan'} onclick={() => { mailFilter = 'pan'; loadMail(); }}>PAN</button>
						<button class="filter-tab" class:active={mailFilter === 'email'} onclick={() => { mailFilter = 'email'; loadMail(); }}>Email</button>
					</div>
					<button class="tool-btn" onclick={syncMail} title="Sync" disabled={loading}>&#x21BB;</button>
					<button class="tool-btn" onclick={() => openCompose()} title="Compose">{'\uD83D\uDCDD'}</button>
				</div>
				{#each mailItems as item}
					<div class="list-row mail-row" class:unread={!item.read} class:active={selectedMail?.id === item.id} onclick={() => { selectedMail = item; }} role="button" tabindex="0">
						<span class="type-icon" class:pan={item.channel === 'pan'} class:email={item.channel === 'email'}>
							{item.channel === 'pan' ? '\u25C6' : '\u2709'}
						</span>
						<div class="row-info">
							<div class="row-name">{item.direction === 'sent' ? `To: ${item.to}` : item.from}</div>
							{#if item.subject}<div class="row-subject">{item.subject}</div>{/if}
							<div class="row-sub">{item.preview || ''}</div>
						</div>
						<span class="row-date">{formatDate(item.date)}</span>
					</div>
				{/each}
				{#if mailItems.length === 0 && !loading}
					<div class="empty">No messages</div>
				{/if}
			</div>

			<div class="detail-pane">
				{#if selectedMail}
					<div class="detail-header">
						<div>
							<div class="detail-name">{selectedMail.direction === 'sent' ? `To: ${selectedMail.to}` : selectedMail.from}</div>
							{#if selectedMail.subject}<div class="detail-subject">{selectedMail.subject}</div>{/if}
							<div class="detail-sub">{formatDate(selectedMail.date)} &middot; via {selectedMail.channel === 'pan' ? 'PAN' : 'Email'}</div>
						</div>
						<button class="tool-btn" onclick={() => openCompose(null, selectedMail.subject ? 'Re: ' + selectedMail.subject : '', selectedMail.from_address || selectedMail.from || '')} title="Reply">&#x21A9;</button>
					</div>
					<div class="detail-body">
						<p>{selectedMail.preview || '(no content)'}</p>
					</div>
				{:else}
					<div class="empty-detail">Select a message to read</div>
				{/if}
			</div>
		</div>

	<!-- CALENDAR VIEW -->
	{:else if view === 'calendar'}
		<div class="calendar-view">
			<div class="toolbar cal-toolbar">
				<button class="tool-btn" onclick={() => { calMonth--; if (calMonth < 1) { calMonth = 12; calYear--; } calSelectedDay = null; loadData(); }}>&larr;</button>
				<span class="cal-title">{monthNames[calMonth]} {calYear}</span>
				<button class="tool-btn" onclick={() => { calMonth++; if (calMonth > 12) { calMonth = 1; calYear++; } calSelectedDay = null; loadData(); }}>&rarr;</button>
			</div>
			<div class="cal-grid-wrap">
				<div class="cal-grid">
					<span class="cal-dow">Sun</span><span class="cal-dow">Mon</span><span class="cal-dow">Tue</span><span class="cal-dow">Wed</span><span class="cal-dow">Thu</span><span class="cal-dow">Fri</span><span class="cal-dow">Sat</span>
					{#each Array(firstDayOfWeek(calYear, calMonth)) as _}
						<span class="cal-blank"></span>
					{/each}
					{#each Array(daysInMonth(calYear, calMonth)) as _, i}
						{@const day = i + 1}
						{@const hasEvents = eventsOnDay(day).length > 0}
						<button
							class="cal-day"
							class:today={isToday(day)}
							class:has-events={hasEvents}
							class:selected={calSelectedDay === day}
							onclick={() => { calSelectedDay = day; }}
						>
							<span class="cal-day-num">{day}</span>
							{#if hasEvents}
								<span class="cal-dot"></span>
							{/if}
						</button>
					{/each}
				</div>
			</div>
			{#if calSelectedDay}
				<div class="cal-day-detail">
					<div class="cal-day-title">{monthNames[calMonth]} {calSelectedDay}, {calYear}</div>
					{#each eventsOnDay(calSelectedDay) as ev}
						<div class="event-row">
							<div class="event-color" style="background: {ev.color || '#89b4fa'}"></div>
							<div class="event-info">
								<div class="event-title">{ev.title}</div>
								<div class="event-time">{formatDate(ev.starts_at)}{ev.ends_at ? ' - ' + formatDate(ev.ends_at) : ''}</div>
								{#if ev.description}<div class="event-desc">{ev.description}</div>{/if}
							</div>
						</div>
					{/each}
					{#if eventsOnDay(calSelectedDay).length === 0}
						<div class="empty sm">No events this day</div>
					{/if}
				</div>
			{:else}
				<div class="cal-upcoming">
					{#if calendarEvents.length > 0}
						<div class="cal-day-title">Events this month</div>
						{#each calendarEvents as ev}
							<div class="event-row">
								<div class="event-color" style="background: {ev.color || '#89b4fa'}"></div>
								<div class="event-info">
									<div class="event-title">{ev.title}</div>
									<div class="event-time">{formatDate(ev.starts_at)}</div>
								</div>
							</div>
						{/each}
					{:else if !loading}
						<div class="empty sm">No events this month</div>
					{/if}
				</div>
			{/if}
		</div>
	{/if}
</div>

<style>
	:global(body) {
		font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
		background: #11111b;
		color: #cdd6f4;
		margin: 0;
		overflow: hidden;
	}

	.comms-app {
		display: flex;
		flex-direction: column;
		height: 100vh;
	}

	/* ─── Header ─── */
	.app-header {
		display: flex;
		align-items: center;
		gap: 16px;
		padding: 0 16px;
		background: #181825;
		border-bottom: 1px solid #1e1e2e;
		flex-shrink: 0;
	}
	.app-logo {
		font-size: 18px;
		font-weight: 800;
		color: #89b4fa;
		letter-spacing: 2px;
	}

	/* ─── Tab bar ─── */
	.tab-bar {
		display: flex;
		gap: 0;
	}
	.tab {
		padding: 12px 24px;
		background: none;
		border: none;
		color: #6c7086;
		font-size: 13px;
		font-weight: 500;
		cursor: pointer;
		border-bottom: 2px solid transparent;
	}
	.tab:hover { color: #cdd6f4; }
	.tab.active { color: #89b4fa; border-bottom-color: #89b4fa; }

	/* ─── Split view ─── */
	.split-view {
		flex: 1;
		display: flex;
		min-height: 0;
	}
	.list-pane {
		width: 320px;
		border-right: 1px solid #1e1e2e;
		display: flex;
		flex-direction: column;
		overflow-y: auto;
	}
	.mail-list-pane { width: 380px; }
	.detail-pane {
		flex: 1;
		display: flex;
		flex-direction: column;
		min-width: 0;
	}

	/* ─── Toolbar ─── */
	.toolbar {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 8px 12px;
		border-bottom: 1px solid #1e1e2e;
		flex-shrink: 0;
	}
	.search-input {
		flex: 1;
		background: #1e1e2e;
		border: 1px solid #313244;
		border-radius: 6px;
		color: #cdd6f4;
		padding: 6px 10px;
		font-size: 12px;
		outline: none;
	}
	.search-input:focus { border-color: #89b4fa; }
	.tool-btn {
		background: #1e1e2e;
		border: 1px solid #313244;
		color: #6c7086;
		padding: 4px 10px;
		border-radius: 6px;
		cursor: pointer;
		font-size: 14px;
	}
	.tool-btn:hover { color: #cdd6f4; border-color: #45475a; }

	/* ─── Filter tabs ─── */
	.filter-tabs { display: flex; gap: 2px; flex: 1; }
	.filter-tab {
		background: none; border: 1px solid transparent; color: #6c7086;
		padding: 4px 12px; border-radius: 4px; font-size: 11px; cursor: pointer;
	}
	.filter-tab:hover { color: #cdd6f4; }
	.filter-tab.active { background: #313244; color: #89b4fa; border-color: #45475a; }

	/* ─── List rows ─── */
	.list-row {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 10px 12px;
		cursor: pointer;
		border-bottom: 1px solid #181825;
		transition: background 0.1s;
	}
	.list-row:hover { background: #1e1e2e; }
	.list-row.active { background: #313244; }
	.list-row.unread { border-left: 3px solid #89b4fa; }
	.avatar {
		width: 32px; height: 32px; border-radius: 50%; background: #585b70;
		display: flex; align-items: center; justify-content: center;
		font-size: 14px; font-weight: 600; flex-shrink: 0;
	}
	.avatar.lg { width: 40px; height: 40px; font-size: 18px; }
	.row-info { flex: 1; min-width: 0; }
	.row-name {
		font-size: 13px; font-weight: 500; color: #cdd6f4;
		white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
	}
	.row-subject {
		font-size: 12px; color: #a6adc8;
		white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
	}
	.row-sub {
		font-size: 11px; color: #6c7086;
		white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
	}
	.row-date { font-size: 10px; color: #6c7086; flex-shrink: 0; }
	.badge {
		background: #f38ba8; color: #11111b; font-size: 10px; font-weight: 700;
		padding: 1px 5px; border-radius: 8px; margin-left: 4px;
	}
	.fav { color: #f9e2af; font-size: 12px; }
	.type-icon { font-size: 14px; color: #6c7086; flex-shrink: 0; }
	.type-icon.pan { color: #a6e3a1; }
	.type-icon.email { color: #89b4fa; }
	.list-row.unread .row-name { font-weight: 700; }

	/* ─── Detail pane ─── */
	.detail-header {
		display: flex; align-items: center; gap: 12px;
		padding: 12px 16px; border-bottom: 1px solid #1e1e2e;
		flex-shrink: 0;
	}
	.detail-name { font-size: 15px; font-weight: 600; }
	.detail-subject { font-size: 13px; color: #a6adc8; margin-top: 2px; }
	.detail-sub { font-size: 11px; color: #6c7086; margin-top: 2px; }
	.compose-btn { margin-left: auto; }
	.detail-body { flex: 1; padding: 16px; overflow-y: auto; font-size: 13px; line-height: 1.6; color: #bac2de; }
	.empty-detail {
		flex: 1; display: flex; align-items: center; justify-content: center;
		color: #6c7086; font-size: 14px;
	}
	.empty { padding: 24px; text-align: center; color: #6c7086; font-size: 13px; }
	.empty.sm { padding: 16px; font-size: 12px; }

	/* ─── Chat messages ─── */
	.chat-messages {
		flex: 1; overflow-y: auto; padding: 12px 16px;
		display: flex; flex-direction: column; gap: 6px;
	}
	.chat-bubble {
		max-width: 70%; padding: 8px 12px; border-radius: 12px; word-break: break-word;
		align-self: flex-start; background: #313244;
	}
	.chat-bubble.self {
		align-self: flex-end; background: #45475a;
		border-bottom-right-radius: 4px;
	}
	.chat-bubble:not(.self) { border-bottom-left-radius: 4px; }
	.bubble-text { font-size: 13px; line-height: 1.4; }
	.bubble-time { font-size: 10px; color: #6c7086; margin-top: 2px; text-align: right; }

	.chat-input-bar {
		display: flex; gap: 8px; padding: 10px 16px; border-top: 1px solid #1e1e2e; flex-shrink: 0;
	}
	.chat-input {
		flex: 1; background: #1e1e2e; border: 1px solid #313244; border-radius: 8px;
		color: #cdd6f4; padding: 8px 12px; font-size: 13px; font-family: inherit; outline: none; resize: none;
	}
	.chat-input:focus { border-color: #89b4fa; }
	.send-btn {
		background: #89b4fa; color: #11111b; border: none; padding: 8px 16px;
		border-radius: 8px; font-size: 13px; font-weight: 600; cursor: pointer;
	}
	.send-btn:hover:not(:disabled) { background: #74c7ec; }
	.send-btn:disabled { opacity: 0.4; cursor: not-allowed; }

	/* ─── Calendar ─── */
	.calendar-view { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
	.cal-toolbar { justify-content: center; }
	.cal-title { font-size: 16px; font-weight: 600; min-width: 200px; text-align: center; }
	.cal-grid-wrap { padding: 8px 16px; flex-shrink: 0; }
	.cal-grid {
		display: grid;
		grid-template-columns: repeat(7, 1fr);
		gap: 2px;
		max-width: 500px;
		margin: 0 auto;
	}
	.cal-dow {
		text-align: center; font-size: 11px; color: #6c7086; font-weight: 600;
		padding: 4px 0;
	}
	.cal-blank { }
	.cal-day {
		aspect-ratio: 1;
		display: flex; flex-direction: column; align-items: center; justify-content: center;
		background: none; border: 1px solid transparent; border-radius: 8px;
		color: #cdd6f4; cursor: pointer; font-size: 13px; position: relative;
		gap: 2px;
	}
	.cal-day:hover { background: #1e1e2e; border-color: #313244; }
	.cal-day.today { border-color: #89b4fa; color: #89b4fa; font-weight: 700; }
	.cal-day.selected { background: #313244; border-color: #89b4fa; }
	.cal-day.has-events .cal-day-num { color: #a6e3a1; }
	.cal-day-num { font-size: 13px; }
	.cal-dot { width: 4px; height: 4px; border-radius: 50%; background: #a6e3a1; }
	.cal-day-detail, .cal-upcoming {
		flex: 1; overflow-y: auto; padding: 8px 16px; border-top: 1px solid #1e1e2e;
	}
	.cal-day-title { font-size: 13px; font-weight: 600; color: #a6adc8; margin-bottom: 8px; padding: 4px 0; }
	.event-row { display: flex; gap: 10px; padding: 8px 8px; border-bottom: 1px solid #181825; }
	.event-color { width: 4px; border-radius: 2px; flex-shrink: 0; }
	.event-info { flex: 1; }
	.event-title { font-size: 13px; font-weight: 500; }
	.event-time { font-size: 11px; color: #6c7086; margin-top: 2px; }
	.event-desc { font-size: 12px; color: #a6adc8; margin-top: 4px; }
</style>
