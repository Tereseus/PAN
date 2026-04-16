<script>
	import { onMount, tick } from 'svelte';

	const API_BASE = typeof window !== 'undefined' ? window.location.origin : '';

	// ─── State ───
	let toQuery = $state('');
	let subject = $state('');
	let body = $state('');
	let sending = $state(false);
	let sent = $state(false);
	let sendError = $state('');

	// Contact resolution
	let suggestions = $state([]);
	let selectedContact = $state(null);
	let channels = $state([]);        // available channels for selected contact
	let selectedChannel = $state('');  // 'pan' | 'email' | 'sms' | ...
	let showSuggestions = $state(false);
	let toInputEl;

	// Pre-fill from URL params
	onMount(async () => {
		const params = new URLSearchParams(window.location.search);
		const contactId = params.get('contact');
		const contactName = params.get('name');
		const email = params.get('email');
		const prefillSubject = params.get('subject');
		const channel = params.get('channel');

		if (prefillSubject) subject = prefillSubject;
		if (channel) selectedChannel = channel;

		if (contactId && contactName && contactName !== 'undefined') {
			// Pre-selected contact
			toQuery = contactName;
			selectedContact = { id: contactId, display_name: contactName, email: email || null };
			loadChannels(contactId);
		} else if (contactId) {
			// Have ID but no name — fetch it
			try {
				const contacts = await api(`/api/v1/chat/contact-search?q=`);
				const found = (Array.isArray(contacts) ? contacts : []).find(c => c.id === contactId);
				if (found) {
					toQuery = found.display_name;
					selectedContact = { id: found.id, display_name: found.display_name, email: found.email || email || null };
					loadChannels(found.id);
				}
			} catch {}
		} else if (email) {
			toQuery = email;
			selectedChannel = 'email';
		}

		document.title = 'Compose';
		if (toInputEl) toInputEl.focus();
	});

	async function api(path, opts) {
		const res = await fetch(API_BASE + path, opts);
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		return res.json();
	}

	async function searchContacts() {
		const q = toQuery.trim();
		if (!q || q.length < 2) { suggestions = []; showSuggestions = false; return; }
		if (selectedContact) return; // already picked

		try {
			suggestions = await api(`/api/v1/chat/contact-search?q=${encodeURIComponent(q)}`);
			showSuggestions = suggestions.length > 0;
		} catch {
			suggestions = [];
		}
	}

	async function loadChannels(contactId) {
		try {
			const data = await api(`/api/v1/chat/contact-channels/${contactId}`);
			channels = data.channels || [];
			if (!selectedChannel && channels.length > 0) {
				selectedChannel = channels[0].id;
			}
		} catch {
			channels = [];
		}
	}

	function selectContact(contact) {
		selectedContact = contact;
		toQuery = contact.display_name;
		suggestions = [];
		showSuggestions = false;
		loadChannels(contact.id);
	}

	function clearContact() {
		selectedContact = null;
		channels = [];
		selectedChannel = '';
		toQuery = '';
		suggestions = [];
		tick().then(() => { if (toInputEl) toInputEl.focus(); });
	}

	function onToInput() {
		if (selectedContact) {
			// User is editing — deselect
			selectedContact = null;
			channels = [];
			selectedChannel = '';
		}
		searchContacts();

		// Auto-detect raw email
		if (toQuery.includes('@') && !selectedContact) {
			selectedChannel = 'email';
		}
	}

	function onToKeydown(e) {
		if (e.key === 'Escape') {
			showSuggestions = false;
		}
	}

	async function sendMessage() {
		if (sending) return;
		sendError = '';

		// Determine what we're sending
		const channel = selectedChannel || 'pan';

		if (!body.trim() && !subject.trim()) {
			sendError = 'Message cannot be empty';
			return;
		}

		if (!selectedContact && !toQuery.includes('@')) {
			sendError = 'Select a contact or enter an email address';
			return;
		}

		sending = true;
		try {
			const payload = {
				channel,
				subject: subject.trim() || undefined,
				body: body.trim(),
			};

			if (selectedContact) {
				payload.to_contact_id = selectedContact.id;
			} else if (toQuery.includes('@')) {
				payload.to_address = toQuery.trim();
			}

			const result = await api('/api/v1/chat/compose', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(payload)
			});

			sent = true;
			setTimeout(() => {
				try { window.close(); } catch {}
			}, 1500);
		} catch (e) {
			sendError = e.message || 'Failed to send';
		}
		sending = false;
	}
</script>

<div class="compose-window">
	{#if sent}
		<div class="compose-sent">
			<div class="sent-icon">&#x2713;</div>
			<div class="sent-text">Message sent via {selectedChannel || 'PAN'}</div>
		</div>
	{:else}
		<div class="compose-header">
			<div class="compose-title">Compose</div>
			<button class="compose-close" onclick={() => window.close()}>&times;</button>
		</div>

		{#if sendError}
			<div class="compose-error">
				{sendError}
				{#if /not configured|SMTP|Email not/i.test(sendError)}
					<button
						class="error-action"
						onclick={() => { window.open(`${API_BASE}/v2/settings?section=email`, '_blank', 'width=900,height=700'); }}
					>Open Email Settings →</button>
				{/if}
			</div>
		{/if}

		<div class="compose-fields">
			<!-- To field -->
			<div class="field-row">
				<label class="field-label">To</label>
				<div class="to-wrapper">
					{#if selectedContact}
						<div class="to-chip">
							<span class="chip-avatar">{selectedContact.display_name.charAt(0).toUpperCase()}</span>
							<span class="chip-name">{selectedContact.display_name}</span>
							<button class="chip-remove" onclick={clearContact}>&times;</button>
						</div>
					{:else}
						<input
							bind:this={toInputEl}
							type="text"
							class="field-input"
							placeholder="Name, email, or PAN ID..."
							bind:value={toQuery}
							oninput={onToInput}
							onkeydown={onToKeydown}
							onfocus={() => { if (suggestions.length) showSuggestions = true; }}
							autocomplete="off"
						/>
					{/if}

					<!-- Channel selector -->
					{#if channels.length > 0}
						<div class="channel-picker">
							{#each channels as ch}
								<button
									class="channel-btn"
									class:active={selectedChannel === ch.id}
									onclick={() => { selectedChannel = ch.id; }}
									title="Send via {ch.label}"
								>
									{ch.icon} {ch.label}
								</button>
							{/each}
						</div>
					{:else if toQuery.includes('@') && !selectedContact}
						<span class="channel-badge">&#x2709; Email</span>
					{/if}

					<!-- Suggestions dropdown -->
					{#if showSuggestions}
						<div class="suggestions">
							{#each suggestions as c}
								<button class="suggestion-row" onclick={() => selectContact(c)}>
									<span class="sug-avatar">{c.display_name.charAt(0).toUpperCase()}</span>
									<div class="sug-info">
										<div class="sug-name">{c.display_name}</div>
										<div class="sug-detail">{c.email || c.phone || 'PAN contact'}</div>
									</div>
								</button>
							{/each}
						</div>
					{/if}
				</div>
			</div>

			<!-- Subject field -->
			<div class="field-row">
				<label class="field-label">Subject</label>
				<input type="text" class="field-input" placeholder="Subject (optional)" bind:value={subject} />
			</div>
		</div>

		<!-- Body -->
		<textarea
			class="compose-body"
			placeholder="Write your message..."
			bind:value={body}
			rows="14"
		></textarea>

		<!-- Toolbar -->
		<div class="compose-toolbar">
			<div class="compose-formatting">
				<button class="fmt-btn" title="Bold" onclick={() => { body += '**bold**'; }}>B</button>
				<button class="fmt-btn" title="Italic" onclick={() => { body += '_italic_'; }}><em>I</em></button>
				<button class="fmt-btn" title="Code" onclick={() => { body += '`code`'; }}>&lt;/&gt;</button>
				<button class="fmt-btn" title="Bullet list" onclick={() => { body += '\n- item'; }}>&#x2022;</button>
			</div>
			<div class="compose-actions">
				<button class="compose-cancel" onclick={() => window.close()}>Cancel</button>
				<button class="compose-send" onclick={sendMessage} disabled={sending || (!body.trim() && !subject.trim())}>
					{sending ? 'Sending...' : 'Send'}
				</button>
			</div>
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

	.compose-window {
		display: flex;
		flex-direction: column;
		height: 100vh;
		max-width: 100%;
	}

	/* ─── Header ─── */
	.compose-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 14px 20px 10px;
		border-bottom: 1px solid #1e1e2e;
		flex-shrink: 0;
	}
	.compose-title { font-size: 16px; font-weight: 700; }
	.compose-close {
		background: none; border: none; color: #6c7086; font-size: 22px;
		cursor: pointer; padding: 0 4px;
	}
	.compose-close:hover { color: #f38ba8; }

	/* ─── Fields ─── */
	.compose-fields {
		padding: 12px 20px 0;
		display: flex;
		flex-direction: column;
		gap: 8px;
		flex-shrink: 0;
	}
	.field-row {
		display: flex;
		align-items: center;
		gap: 10px;
	}
	.field-label {
		font-size: 12px;
		color: #6c7086;
		width: 50px;
		flex-shrink: 0;
		text-align: right;
	}
	.field-input {
		flex: 1;
		background: #1e1e2e;
		border: 1px solid #313244;
		border-radius: 6px;
		color: #cdd6f4;
		padding: 8px 12px;
		font-size: 13px;
		outline: none;
	}
	.field-input:focus { border-color: #89b4fa; }

	/* ─── To wrapper + chip ─── */
	.to-wrapper {
		flex: 1;
		position: relative;
		display: flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
	}
	.to-chip {
		display: flex;
		align-items: center;
		gap: 6px;
		background: #313244;
		border: 1px solid #45475a;
		border-radius: 16px;
		padding: 4px 10px 4px 4px;
	}
	.chip-avatar {
		width: 22px; height: 22px; border-radius: 50%; background: #585b70;
		display: flex; align-items: center; justify-content: center;
		font-size: 11px; font-weight: 600;
	}
	.chip-name { font-size: 13px; color: #cdd6f4; }
	.chip-remove {
		background: none; border: none; color: #6c7086; cursor: pointer;
		font-size: 14px; padding: 0 2px; line-height: 1;
	}
	.chip-remove:hover { color: #f38ba8; }

	/* ─── Channel picker ─── */
	.channel-picker {
		display: flex;
		gap: 4px;
		flex-shrink: 0;
	}
	.channel-btn {
		background: #1e1e2e;
		border: 1px solid #313244;
		color: #6c7086;
		padding: 4px 10px;
		border-radius: 12px;
		font-size: 11px;
		cursor: pointer;
		white-space: nowrap;
	}
	.channel-btn:hover { color: #cdd6f4; border-color: #45475a; }
	.channel-btn.active {
		background: #313244;
		color: #89b4fa;
		border-color: #89b4fa;
	}
	.channel-badge {
		font-size: 11px;
		padding: 3px 8px;
		border-radius: 10px;
		background: #1e1e2e;
		color: #89b4fa;
		border: 1px solid #313244;
		flex-shrink: 0;
	}

	/* ─── Suggestions ─── */
	.suggestions {
		position: absolute;
		top: 100%;
		left: 0;
		right: 0;
		z-index: 100;
		background: #181825;
		border: 1px solid #313244;
		border-radius: 8px;
		margin-top: 4px;
		max-height: 200px;
		overflow-y: auto;
		box-shadow: 0 8px 24px rgba(0,0,0,0.4);
	}
	.suggestion-row {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 8px 12px;
		cursor: pointer;
		background: none;
		border: none;
		width: 100%;
		text-align: left;
		color: inherit;
	}
	.suggestion-row:hover { background: #313244; }
	.sug-avatar {
		width: 28px; height: 28px; border-radius: 50%; background: #585b70;
		display: flex; align-items: center; justify-content: center;
		font-size: 12px; font-weight: 600; flex-shrink: 0;
	}
	.sug-info { min-width: 0; }
	.sug-name { font-size: 13px; color: #cdd6f4; }
	.sug-detail { font-size: 11px; color: #6c7086; }

	/* ─── Body ─── */
	.compose-body {
		flex: 1;
		margin: 12px 20px;
		background: #1e1e2e;
		border: 1px solid #313244;
		border-radius: 6px;
		color: #cdd6f4;
		padding: 12px 14px;
		font-size: 13px;
		font-family: inherit;
		line-height: 1.5;
		outline: none;
		resize: none;
		min-height: 0;
	}
	.compose-body:focus { border-color: #89b4fa; }

	/* ─── Toolbar ─── */
	.compose-toolbar {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 10px 20px 16px;
		flex-shrink: 0;
	}
	.compose-formatting { display: flex; gap: 4px; }
	.fmt-btn {
		background: #1e1e2e; border: 1px solid #313244; color: #6c7086;
		width: 30px; height: 28px; border-radius: 4px; cursor: pointer;
		font-size: 12px; font-weight: 600;
	}
	.fmt-btn:hover { color: #89b4fa; border-color: #89b4fa; }

	.compose-actions { display: flex; gap: 8px; }
	.compose-cancel {
		background: none; border: 1px solid #313244; color: #6c7086;
		padding: 8px 16px; border-radius: 6px; font-size: 13px; cursor: pointer;
	}
	.compose-cancel:hover { color: #cdd6f4; border-color: #6c7086; }
	.compose-send {
		background: #89b4fa; color: #11111b; border: none;
		padding: 8px 24px; border-radius: 6px; font-size: 13px;
		font-weight: 600; cursor: pointer;
	}
	.compose-send:hover { background: #74c7ec; }
	.compose-send:disabled { opacity: 0.4; cursor: not-allowed; }

	/* ─── Status ─── */
	.compose-error {
		background: #45273a; color: #f38ba8;
		padding: 8px 20px; font-size: 13px; border-bottom: 1px solid #f38ba8;
		display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
	}
	.error-action {
		background: #f38ba8; color: #1e1e2e; border: none;
		padding: 4px 10px; border-radius: 4px; font-size: 12px;
		font-weight: 600; cursor: pointer; margin-left: auto;
	}
	.error-action:hover { background: #eba0ac; }
	.compose-sent {
		display: flex; flex-direction: column;
		align-items: center; justify-content: center;
		flex: 1; gap: 12px;
	}
	.sent-icon { font-size: 48px; color: #a6e3a1; }
	.sent-text { font-size: 16px; color: #a6e3a1; font-weight: 600; }
</style>
