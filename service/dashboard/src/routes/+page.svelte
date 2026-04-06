<script>
	import { api, escapeHtml } from '$lib/api.js';
	import { getActiveProject, setActiveProject, getChatMessages, setChatMessages, getChatInput, setChatInput, getChatImages, setChatImages, isStarred, toggleStar, sortProjects, saveProjectOrder } from '$lib/stores.svelte.js';

	/** @type {Array<{id: number, name: string, path: string, cwd?: string}>} */
	let projects = $state([]);
	let activeProject = $derived(getActiveProject());
	let messages = $state([]);
	let input = $state(getChatInput());
	let loading = $state(false);
	let chatEl;
	let textareaEl;
	let initialScrollDone = $state(false);
	let chatLastHash = $state('');
	let pastedImages = $state(getChatImages());

	// Smart Scroll state
	let ssBookmark = $state(null);
	let ssNewCount = $state(0);
	let ssPrevCount = $state(0);

	// Performance guards
	let loadingHistory = false; // concurrency guard (NOT reactive — no re-renders)
	let lastSessionKey = ''; // skip re-fetch if sessions unchanged

	// Session color accents for multi-session view
	const sessionColors = ['#89b4fa', '#a6e3a1', '#f9e2af', '#f38ba8', '#cba6f7'];

	// Restore messages from store when project changes (track last project to avoid loop)
	let lastRestoredProjectId = null;
	$effect(() => {
		const pid = activeProject?.id;
		if (pid && pid !== lastRestoredProjectId) {
			lastRestoredProjectId = pid;
			const stored = getChatMessages(pid);
			if (stored.length) messages = stored;
		}
	});

	// Persist messages to store whenever they change (debounced, no cascade)
	let persistTimer = null;
	$effect(() => {
		const pid = activeProject?.id;
		const msgs = messages; // subscribe to reactive value
		if (pid && msgs.length) {
			clearTimeout(persistTimer);
			persistTimer = setTimeout(() => setChatMessages(pid, msgs), 200);
		}
	});

	// Save input and images to store on change
	$effect(() => { setChatInput(input); });
	$effect(() => { setChatImages(pastedImages); });

	// Restore textarea height on mount
	$effect(() => {
		if (textareaEl && input) {
			textareaEl.style.height = 'auto';
			textareaEl.style.height = Math.min(textareaEl.scrollHeight, 160) + 'px';
		}
	});

	async function loadProjects() {
		try {
			const data = await api('/dashboard/api/projects');
			const list = Array.isArray(data) ? data : (data.projects || []);
			projects = sortProjects(list);
			if (list.length && !getActiveProject()) {
				setActiveProject(projects[0]); // load starred/first project
			}
		} catch (e) {
			console.error('Failed to load projects:', e);
		}
	}

	async function loadChatHistory() {
		if (!activeProject) {
			messages = [];
			return;
		}
		// Concurrency guard — skip if previous fetch is still running
		if (loadingHistory) {
			console.debug('[PAN Chat] skipping loadChatHistory — previous still running');
			return;
		}
		loadingHistory = true;
		const t0 = performance.now();

		try {
			const projectPath = activeProject.path || activeProject.cwd || '';
			if (!projectPath) { messages = []; return; }

			const probe = await api('/dashboard/api/events?limit=50&project_path=' + encodeURIComponent(projectPath));
			const t1 = performance.now();
			let sessionIds = [];
			if (probe && probe.events) {
				const seen = new Set();
				for (const evt of probe.events) {
					const sid = evt.session_id || '';
					if (sid && !seen.has(sid)
						&& !sid.startsWith('system-')
						&& !sid.startsWith('phone-')
						&& !sid.startsWith('router-')
						&& !sid.startsWith('dash-')
						&& !sid.startsWith('mob-')) {
						seen.add(sid);
						sessionIds.push(sid);
						if (sessionIds.length >= 5) break;
					}
				}
			}

			// Skip transcript re-fetch if same sessions as last time
			const sessionKey = sessionIds.join(',');
			if (sessionIds.length === 0 && !getChatMessages(activeProject.id)?.length) {
				messages = [];
				return;
			}

			// If sessions haven't changed and we already have data, skip the expensive transcript reads
			if (sessionKey === lastSessionKey && chatLastHash && messages.some(m => m.fromHistory)) {
				console.debug(`[PAN Chat] sessions unchanged, skipping transcript fetch (${(t1 - t0).toFixed(0)}ms for events probe)`);
				return;
			}

			const allMessages = [];
			await Promise.all(sessionIds.map(async (sid, idx) => {
				try {
					const data = await api('/dashboard/api/transcript?session_id=' + encodeURIComponent(sid) + '&limit=300');
					if (data && data.messages) {
						for (const msg of data.messages) {
							msg._sessionIdx = idx;
							msg._sessionId = sid;
							allMessages.push(msg);
						}
					}
				} catch (err) {
					console.warn(`[PAN Chat] transcript fetch failed for ${sid}:`, err.message);
				}
			}));
			const t2 = performance.now();

			allMessages.sort((a, b) => (a.ts || '').localeCompare(b.ts || ''));
			const multiSession = sessionIds.length > 1;

			const processed = [];
			for (const msg of allMessages) {
				if (msg.role === 'user') {
					if (msg.text && /^ΠΑΝ remembers/i.test(msg.text.trim())) continue;
					processed.push({ role: 'user', text: msg.text || '', images: msg.images || [], sessionIdx: msg._sessionIdx, multiSession, ts: msg.ts, fromHistory: true });
				} else if (msg.type === 'text') {
					processed.push({ role: 'assistant', text: msg.text || '', sessionIdx: msg._sessionIdx, multiSession, ts: msg.ts, fromHistory: true });
				} else if (msg.type === 'tool') {
					processed.push({ role: 'tool', text: msg.text || '', sessionIdx: msg._sessionIdx, ts: msg.ts, fromHistory: true });
				}
			}

			const existingLocal = messages.filter(m => !m.fromHistory);
			const newHash = processed.length + ':' + processed.map(m => (m.text || '').length).join(',');
			if (newHash !== chatLastHash || existingLocal.length) {
				chatLastHash = newHash;
				lastSessionKey = sessionKey;

				// Save scroll state BEFORE re-render
				const wasNearBottom = chatEl ? (chatEl.scrollHeight - chatEl.scrollTop - chatEl.clientHeight) < 80 : true;
				const savedScrollTop = chatEl?.scrollTop ?? 0;
				const savedScrollHeight = chatEl?.scrollHeight ?? 0;

				// Smart Scroll: track new messages when scrolled up
				const oldCount = ssPrevCount;
				const newCount = processed.length + existingLocal.length;
				if (oldCount > 0 && newCount > oldCount && !wasNearBottom) {
					ssNewCount += (newCount - oldCount);
				}
				ssPrevCount = newCount;

				messages = [...processed, ...existingLocal];

				// Restore scroll AFTER Svelte re-renders the DOM (double-rAF ensures post-render)
				requestAnimationFrame(() => { requestAnimationFrame(() => {
					if (!chatEl) return;
					if (!initialScrollDone) {
						chatEl.scrollTop = chatEl.scrollHeight;
						initialScrollDone = true;
					} else if (wasNearBottom) {
						chatEl.scrollTop = chatEl.scrollHeight;
					} else {
						// Keep the user's reading position: adjust for any height change
						const heightDelta = chatEl.scrollHeight - savedScrollHeight;
						chatEl.scrollTop = savedScrollTop + heightDelta;
					}
				}); });
			} else {
				lastSessionKey = sessionKey; // still cache the key even if hash matches
			}

			console.debug(`[PAN Chat] loaded ${processed.length} msgs from ${sessionIds.length} sessions — events: ${(t1 - t0).toFixed(0)}ms, transcripts: ${(t2 - t1).toFixed(0)}ms, total: ${(t2 - t0).toFixed(0)}ms`);
		} catch (err) {
			console.error('[PAN Chat] loadChatHistory error:', err);
		} finally {
			loadingHistory = false;
		}
	}

	async function send() {
		const text = input.trim();
		if ((!text && !pastedImages.length) || loading) return;
		const images = [...pastedImages];
		input = '';
		pastedImages = [];
		// Reset textarea height
		if (textareaEl) textareaEl.style.height = 'auto';
		messages = [...messages, { role: 'user', text, images, sessionIdx: 0, multiSession: false, ts: new Date().toISOString() }];
		scrollToBottom();
		loading = true;
		try {
			const data = await api('/api/v1/chat', {
				method: 'POST',
				body: JSON.stringify({ message: text, project_id: activeProject?.id, source: 'dashboard' })
			});
			messages = [...messages, { role: 'assistant', text: data.response || data.message || '', sessionIdx: 0, multiSession: false, ts: new Date().toISOString() }];
		} catch (e) {
			messages = [...messages, { role: 'assistant', text: `Error: ${e.message}`, sessionIdx: 0, multiSession: false, ts: new Date().toISOString() }];
		}
		loading = false;
		scrollToBottom();
	}

	function scrollToBottom() {
		requestAnimationFrame(() => {
			if (chatEl) chatEl.scrollTop = chatEl.scrollHeight;
		});
	}

	function isNearBottom() {
		if (!chatEl) return true;
		return (chatEl.scrollHeight - chatEl.scrollTop - chatEl.clientHeight) < 80;
	}

	function ssJumpToBottom() {
		if (!chatEl) return;
		if (!isNearBottom()) {
			ssBookmark = chatEl.scrollTop;
		}
		chatEl.scrollTo({ top: chatEl.scrollHeight, behavior: 'smooth' });
		ssNewCount = 0;
	}

	function ssJumpToBookmark() {
		if (!chatEl || ssBookmark === null) return;
		chatEl.scrollTo({ top: ssBookmark, behavior: 'smooth' });
	}

	function ssOnScroll() {
		if (isNearBottom()) ssNewCount = 0;
	}

	function selectProject(p) {
		setActiveProject(p);
		initialScrollDone = false;
		chatLastHash = '';
		messages = getChatMessages(p.id) || [];
		loadChatHistory();
	}

	function handleKey(e) {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			send();
		}
	}

	function handlePaste(e) {
		const items = e.clipboardData?.items;
		if (!items) return;
		for (const item of items) {
			if (item.type.startsWith('image/')) {
				e.preventDefault();
				const file = item.getAsFile();
				if (!file) continue;
				const reader = new FileReader();
				reader.onload = () => {
					pastedImages = [...pastedImages, { dataUrl: reader.result, name: file.name || 'clipboard.png' }];
				};
				reader.readAsDataURL(file);
			}
		}
	}

	function removeImage(idx) {
		pastedImages = pastedImages.filter((_, i) => i !== idx);
	}

	function autoResize(e) {
		const el = e.target;
		el.style.height = 'auto';
		el.style.height = Math.min(el.scrollHeight, 160) + 'px';
	}

	function handleStar(e, p) {
		e.stopPropagation();
		toggleStar(p.id);
		projects = sortProjects(projects);
	}

	// Drag and drop reordering
	let dragIdx = $state(null);
	let dragOverIdx = $state(null);

	function handleDragStart(e, idx) {
		dragIdx = idx;
		e.dataTransfer.effectAllowed = 'move';
	}

	function handleDragOver(e, idx) {
		e.preventDefault();
		e.dataTransfer.dropEffect = 'move';
		dragOverIdx = idx;
	}

	function handleDrop(e, idx) {
		e.preventDefault();
		if (dragIdx === null || dragIdx === idx) { dragIdx = null; dragOverIdx = null; return; }
		const items = [...projects];
		const [moved] = items.splice(dragIdx, 1);
		items.splice(idx, 0, moved);
		projects = items;
		saveProjectOrder(items.map(p => p.id));
		dragIdx = null;
		dragOverIdx = null;
	}

	function handleDragEnd() {
		dragIdx = null;
		dragOverIdx = null;
	}

	function getSessionColor(idx) {
		return sessionColors[idx % sessionColors.length];
	}

	function renderText(text) {
		return escapeHtml(text)
			.replace(/\[Image:?\s*source:?\s*[^\]]*pan-clipboard[/\\](clipboard_\d+\.\w+)[^\]]*\]/gi,
				(_, filename) => `<img src="/clipboard/${filename}" class="chat-image" />`)
			.replace(/\[Image #\d+\]/g, '');
	}

	// One-time setup — load data and start polling (no reactive deps to avoid re-triggering)
	$effect(() => {
		loadProjects();
		loadChatHistory();
		const iv = setInterval(loadChatHistory, 15000); // 15s instead of 10s to reduce load
		return () => { clearInterval(iv); clearTimeout(persistTimer); };
	});
</script>

<div class="chat-layout">
	<aside class="project-list">
		<h3>Projects</h3>
		{#each projects as p, i}
			<button
				class="project-item"
				class:active={activeProject?.id === p.id}
				class:drag-over={dragOverIdx === i && dragIdx !== i}
				onclick={() => selectProject(p)}
				draggable="true"
				ondragstart={(e) => handleDragStart(e, i)}
				ondragover={(e) => handleDragOver(e, i)}
				ondrop={(e) => handleDrop(e, i)}
				ondragend={handleDragEnd}
			>
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<span
					class="star-btn"
					class:starred={isStarred(p.id)}
					onclick={(e) => handleStar(e, p)}
					role="button"
					tabindex="-1"
					title={isStarred(p.id) ? 'Unstar' : 'Star'}
				>
					{isStarred(p.id) ? '★' : '☆'}
				</span>
				<span class="project-dot" class:online={activeProject?.id === p.id}></span>
				{p.name || p.path?.split(/[/\\]/).pop() || 'Unnamed'}
			</button>
		{/each}
		{#if !projects.length}
			<span class="muted">No projects found</span>
		{/if}
	</aside>

	<div class="chat-main">
		<div class="chat-header">
			<h2>{activeProject?.name || 'Select a Project'}</h2>
			{#if activeProject?.path}
				<span class="chat-path">{activeProject.path}</span>
			{/if}
		</div>

		<div class="chat-messages" bind:this={chatEl} onscroll={ssOnScroll}>
			{#each messages as msg}
				{#if msg.role === 'user'}
					<div class="message user">
						{#if msg.multiSession}
							<span class="session-dot" style="background:{getSessionColor(msg.sessionIdx)}"></span>
						{/if}
						<div class="cloud-bubble">
							{@html renderText(msg.text)}
							{#if msg.images?.length}
								{#each msg.images as img}
									{#if img.clipboardFile}
										<div class="chat-image-wrap">
											<img src="/clipboard/{img.clipboardFile}" alt="clipboard" class="chat-image" />
										</div>
									{:else if img.dataUrl}
										<div class="chat-image-wrap">
											<img src={img.dataUrl} alt={img.name || 'pasted'} class="chat-image" />
										</div>
									{/if}
								{/each}
							{/if}
						</div>
					</div>
				{:else if msg.role === 'assistant'}
					<div class="message assistant">
						<div class="assistant-bubble" style={msg.multiSession ? `border-left: 2px solid ${getSessionColor(msg.sessionIdx)}` : ''}>
							{@html renderText(msg.text)}
						</div>
					</div>
				{:else if msg.role === 'tool'}
					<div class="message tool">
						<div class="tool-bubble">{msg.text}</div>
					</div>
				{/if}
			{/each}

			{#if loading}
				<div class="message assistant">
					<div class="assistant-bubble typing">Thinking...</div>
				</div>
			{/if}

			{#if !messages.length && !loading}
				<div class="empty-state">
					<span class="empty-pi">Π</span>
					<p>No conversation yet</p>
					{#if activeProject}
						<span class="empty-hint">Chat history for {activeProject.name} will appear here</span>
					{:else}
						<span class="empty-hint">Select a project to view conversations</span>
					{/if}
				</div>
			{/if}
		</div>

		{#if pastedImages.length}
			<div class="image-preview-bar">
				{#each pastedImages as img, i}
					<div class="image-preview">
						<img src={img.dataUrl} alt={img.name} />
						<button class="remove-img" onclick={() => removeImage(i)}>×</button>
					</div>
				{/each}
			</div>
		{/if}

		<div class="chat-input">
			<textarea
				bind:this={textareaEl}
				bind:value={input}
				onkeydown={handleKey}
				oninput={autoResize}
				onpaste={handlePaste}
				placeholder="Message ΠΑΝ..."
				rows="1"
			></textarea>
			<button class="send-btn" onclick={send} disabled={loading || (!input.trim() && !pastedImages.length)} title="Send">
				<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<line x1="22" y1="2" x2="11" y2="13"></line>
					<polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
				</svg>
			</button>
		</div>

		<!-- Smart Scroll nav -->
		<div class="ss-nav">
			<button class="ss-btn" class:has-bookmark={ssBookmark !== null} class:dim={ssBookmark === null} onclick={ssJumpToBookmark} title="Jump to bookmark">↑</button>
			<button class="ss-btn" onclick={ssJumpToBottom} title="Jump to bottom">↓</button>
		</div>

		{#if ssNewCount > 0}
			<button class="ss-pill" onclick={ssJumpToBottom}>
				{ssNewCount} new message{ssNewCount > 1 ? 's' : ''} ↓
			</button>
		{/if}
	</div>
</div>

<style>
	.chat-layout {
		display: flex;
		height: 100%;
		overflow: hidden;
	}

	.project-list {
		width: 200px;
		min-width: 200px;
		background: #0e0e16;
		border-right: 1px solid #1e1e2e;
		padding: 16px 12px;
		overflow-y: auto;
		display: flex;
		flex-direction: column;
	}

	.project-list h3 {
		font-size: 11px;
		text-transform: uppercase;
		letter-spacing: 1.2px;
		color: #6c7086;
		margin-bottom: 12px;
		padding: 0 4px;
	}

	.project-item {
		display: flex;
		align-items: center;
		gap: 6px;
		width: 100%;
		text-align: left;
		padding: 8px 10px;
		border: none;
		border-radius: 6px;
		background: transparent;
		color: #6c7086;
		font-size: 13px;
		font-family: inherit;
		cursor: pointer;
		margin-bottom: 2px;
		transition: all 0.15s;
	}

	.project-item:hover { background: #1a1a25; color: #cdd6f4; }
	.project-item.active { background: rgba(137, 180, 250, 0.1); color: #89b4fa; }
	.project-item.drag-over { border-top: 2px solid #89b4fa; margin-top: -2px; }

	.star-btn {
		background: none;
		border: none;
		cursor: pointer;
		font-size: 14px;
		color: #45475a;
		padding: 0;
		line-height: 1;
		transition: color 0.15s, transform 0.15s;
		flex-shrink: 0;
	}

	.star-btn:hover { color: #f9e2af; transform: scale(1.2); }
	.star-btn.starred { color: #f9e2af; }

	.project-dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: #6c7086;
		flex-shrink: 0;
	}

	.project-dot.online {
		background: #89b4fa;
		box-shadow: 0 0 4px rgba(137, 180, 250, 0.4);
	}

	.muted { color: #45475a; font-size: 12px; padding: 8px 4px; }

	.chat-main {
		flex: 1;
		display: flex;
		flex-direction: column;
		overflow: hidden;
		background: #0a0a0f;
		position: relative;
	}

	.chat-header {
		padding: 14px 20px;
		border-bottom: 1px solid #1e1e2e;
		background: #0e0e16;
		flex-shrink: 0;
	}

	.chat-header h2 { font-size: 15px; font-weight: 600; color: #cdd6f4; margin: 0; }
	.chat-path { font-size: 11px; color: #6c7086; font-family: 'JetBrains Mono', 'Fira Code', monospace; }

	.chat-messages {
		flex: 1;
		overflow-y: auto;
		padding: 20px;
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	.message { max-width: 85%; display: flex; align-items: flex-start; gap: 6px; }
	.message.user { align-self: flex-end; flex-direction: row-reverse; }
	.message.assistant { align-self: flex-start; }
	.message.tool { align-self: flex-start; max-width: 95%; }

	.session-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; margin-top: 12px; }

	.cloud-bubble {
		position: relative;
		background: rgba(255, 255, 255, 0.92);
		color: #1a1a2e;
		border-radius: 20px 20px 6px 20px;
		padding: 10px 14px;
		font-size: 14px;
		line-height: 1.5;
		word-break: break-word;
		white-space: pre-wrap;
		box-shadow: 0 1px 4px rgba(0, 0, 0, 0.18);
	}

	.cloud-bubble::after {
		content: '';
		position: absolute;
		bottom: -6px;
		right: 12px;
		width: 10px;
		height: 10px;
		background: rgba(255, 255, 255, 0.92);
		border-radius: 50%;
		box-shadow: 0 1px 3px rgba(0, 0, 0, 0.12);
	}

	.cloud-bubble::before {
		content: '';
		position: absolute;
		bottom: -11px;
		right: 20px;
		width: 6px;
		height: 6px;
		background: rgba(255, 255, 255, 0.92);
		border-radius: 50%;
		box-shadow: 0 1px 2px rgba(0, 0, 0, 0.10);
	}

	.assistant-bubble {
		background: #1a1a25;
		border-radius: 8px 8px 8px 2px;
		padding: 10px 14px;
		font-size: 13px;
		line-height: 1.6;
		color: #cdd6f4;
		word-break: break-word;
		white-space: pre-wrap;
	}

	.tool-bubble {
		background: transparent;
		border-left: 2px solid #1e1e2e;
		padding: 2px 10px;
		font-size: 11px;
		color: #6c7086;
		font-family: 'JetBrains Mono', 'Fira Code', monospace;
		word-break: break-all;
	}

	.typing { color: #6c7086; animation: pulse 1.5s ease-in-out infinite; }
	@keyframes pulse { 0%, 100% { opacity: 0.4; } 50% { opacity: 1; } }

	.chat-image-wrap { margin: 6px 0; text-align: center; }
	:global(.chat-image) {
		max-width: 100%;
		max-height: 200px;
		border-radius: 6px;
		border: 1px solid rgba(255, 255, 255, 0.15);
		cursor: pointer;
		display: inline-block;
	}

	.image-preview-bar {
		padding: 8px 20px 0;
		display: flex;
		gap: 8px;
		flex-wrap: wrap;
		background: #0e0e16;
	}

	.image-preview {
		position: relative;
		width: 64px;
		height: 64px;
		border-radius: 8px;
		overflow: hidden;
		border: 1px solid #1e1e2e;
	}

	.image-preview img { width: 100%; height: 100%; object-fit: cover; }

	.remove-img {
		position: absolute;
		top: 2px;
		right: 2px;
		width: 18px;
		height: 18px;
		background: rgba(0, 0, 0, 0.7);
		color: #fff;
		border: none;
		border-radius: 50%;
		font-size: 12px;
		line-height: 1;
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.empty-state {
		flex: 1;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 8px;
		color: #45475a;
	}

	.empty-pi { font-family: serif; font-size: 64px; font-weight: 700; color: rgba(137, 180, 250, 0.08); user-select: none; }
	.empty-state p { font-size: 16px; color: #6c7086; }
	.empty-hint { font-size: 12px; color: #45475a; }

	.chat-input {
		padding: 12px 20px;
		border-top: 1px solid #1e1e2e;
		display: flex;
		gap: 8px;
		align-items: flex-end;
		background: #0e0e16;
		flex-shrink: 0;
	}

	.chat-input textarea {
		flex: 1;
		background: #1a1a25;
		border: 1px solid #1e1e2e;
		border-radius: 10px;
		padding: 10px 14px;
		color: #cdd6f4;
		font-family: inherit;
		font-size: 14px;
		resize: none;
		outline: none;
		min-height: 40px;
		max-height: 160px;
		line-height: 1.4;
		overflow-y: auto;
	}

	.chat-input textarea:focus { border-color: #89b4fa; box-shadow: 0 0 0 1px rgba(137, 180, 250, 0.15); }
	.chat-input textarea::placeholder { color: #6c7086; }

	.send-btn {
		width: 40px;
		height: 40px;
		background: #89b4fa;
		color: #0a0a0f;
		border: none;
		border-radius: 10px;
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
		transition: opacity 0.15s;
	}

	.send-btn:disabled { opacity: 0.25; cursor: not-allowed; }
	.send-btn:not(:disabled):hover { opacity: 0.85; }

	/* Smart Scroll */
	.ss-nav {
		position: absolute;
		bottom: 80px;
		right: 24px;
		display: flex;
		flex-direction: column;
		gap: 6px;
		align-items: center;
		z-index: 10;
	}

	.ss-btn {
		width: 36px;
		height: 36px;
		border-radius: 50%;
		border: 1px solid rgba(255, 255, 255, 0.15);
		background: rgba(30, 30, 46, 0.95);
		color: #cdd6f4;
		font-size: 16px;
		cursor: pointer;
		transition: all 0.15s;
		box-shadow: 0 2px 8px rgba(0, 0, 0, 0.4);
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.ss-btn:hover { background: #89b4fa; color: #000; transform: scale(1.1); }
	.ss-btn.has-bookmark { border-color: #89b4fa; box-shadow: 0 0 8px rgba(137, 180, 250, 0.4); }
	.ss-btn.dim { opacity: 0.3; pointer-events: none; }

	.ss-pill {
		position: absolute;
		bottom: 72px;
		left: 50%;
		transform: translateX(-50%);
		background: #89b4fa;
		color: #000;
		padding: 6px 16px;
		border-radius: 20px;
		border: none;
		font-size: 13px;
		font-weight: 600;
		cursor: pointer;
		box-shadow: 0 2px 12px rgba(0, 0, 0, 0.4);
		transition: opacity 0.2s;
		z-index: 10;
	}

	.ss-pill:hover { opacity: 0.9; }
</style>
