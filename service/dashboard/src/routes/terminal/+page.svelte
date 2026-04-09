<script>
	import { onMount, tick } from 'svelte';
	import { api, wsUrl } from '$lib/api.js';
	import { getActiveProject, setActiveProject, sortProjects, getTerminalInput, setTerminalInput } from '$lib/stores.svelte.js';

	// --- State ---
	let projects = $state([]);
	let tabs = $state([]);
	let activeTabId = $state(null);
	let allProjectTabs = $state([]); // All tabs (open + closed) for current project dropdown
	let leftSection = $state('transcript'); // same widget options as right panel
	let centerView = $state('terminal'); // 'terminal' | 'chat'
	let rightSection = $state('services'); // alphabetized panel widgets
	// Terminal input bar — persisted across tab switches
	let terminalInputText = $state(getTerminalInput());
	let terminalInputEl;
	// Approval prompt detection — populated when Claude shows a 1/2/3 style menu
	let approvalOptions = $state(null); // null | [{ num: 1, label: 'Yes' }, ...]
	// Claude ready state — false while processing, true when waiting for user input
	let claudeReady = $state(true);
	// Number of messages sent but not yet confirmed in the JSONL transcript
	let pendingSendCount = $state(0);

	// Live PTY status from /api/v1/terminal/sessions, polled every 2s.
	// This is the source of truth for "is the PTY alive / is Claude thinking"
	// — replaces the lying local claudeReady flag that desyncs across refreshes.
	// Shape: { pid, thinking, lastInputTs, lastOutputTs, clients, createdAt } | null
	let ptyStatus = $state(null);
	let ptyStatusNow = $state(Date.now()); // ticks every 1s for live duration display

	// Users
	let usersData = $state([]);

	// Tests
	let testSuites = $state([]);
	let selectedSuite = $state('');
	let testResults = $state([]);
	let testsRunning = $state(false);
	let usageData = $state(null);
	let rightMilestoneFilter = $state(null);

	// Panel resize state
	let leftPanelWidth = $state(260);
	let rightPanelWidth = $state(280);
	let resizingPanel = $state(null); // 'left' | 'right' | null
	let resizeStartX = $state(0);
	let resizeStartWidth = $state(0);
	let hostLabel = $state('');
	let sessionsCount = $state(0);

	// Project/task data for sidebar
	let projectData = $state(null);
	let tasksData = $state(null);
	let sectionsData = $state([]);
	let servicesData = $state([]);
	let approvalsData = $state([]);

	// Atlas state
	let atlasData = $state(null);
	let atlasLoading = $state(false);
	let atlasTransform = $state({ x: 0, y: 0, scale: 1 });
	let atlasDragging = $state(false);
	let atlasDragStart = $state({ x: 0, y: 0 });
	let atlasHovered = $state(null);
	let atlasSelected = $state(null);
	let atlasSvgEl;
	let chatBubbles = $state([]);
	let chatCurrentProject = $state('');

	// --- Panel Resize Handlers ---
	function onResizeStart(panel, e) {
		e.preventDefault();
		resizingPanel = panel;
		resizeStartX = e.clientX;
		resizeStartWidth = panel === 'left' ? leftPanelWidth : rightPanelWidth;
		document.addEventListener('mousemove', onResizeMove);
		document.addEventListener('mouseup', onResizeEnd);
		document.body.style.cursor = 'col-resize';
		document.body.style.userSelect = 'none';
	}
	function onResizeMove(e) {
		if (!resizingPanel) return;
		const delta = e.clientX - resizeStartX;
		if (resizingPanel === 'left') {
			leftPanelWidth = Math.min(500, Math.max(180, resizeStartWidth + delta));
		} else {
			// Right panel: dragging left = bigger, dragging right = smaller
			rightPanelWidth = Math.min(500, Math.max(180, resizeStartWidth - delta));
		}
	}
	function onResizeEnd() {
		resizingPanel = null;
		document.removeEventListener('mousemove', onResizeMove);
		document.removeEventListener('mouseup', onResizeEnd);
		document.body.style.cursor = '';
		document.body.style.userSelect = '';
		// ResizeObserver on termContainerEl handles resize automatically — no synthetic event needed
	}

	// Persist chat across refresh (localStorage survives tab close + refresh)
	function saveChatToStorage() {
		try {
			if (chatBubbles.length > 0) {
				localStorage.setItem('pan-chat-bubbles', JSON.stringify(chatBubbles.slice(-200)));
				localStorage.setItem('pan-chat-project', chatCurrentProject);
			}
		} catch {}
	}
	function restoreChatFromStorage() {
		try {
			const saved = localStorage.getItem('pan-chat-bubbles');
			const proj = localStorage.getItem('pan-chat-project');
			if (saved) {
				chatBubbles = JSON.parse(saved);
				if (proj) chatCurrentProject = proj;
			}
		} catch {}
	}

	// Persist terminal tabs to server DB
	function saveSessionState() {
		try {
			// Save to localStorage as fast fallback
			const state = tabs.map((t, i) => ({
				sessionId: t.sessionId,
				tabName: t.tabName || '',
				project: t.project,
				cwd: t.cwd,
				projectId: t.projectId,
				tabIndex: i,
				claudeSessionIds: t.claudeSessionIds || []
			}));
			localStorage.setItem('pan-terminal-sessions', JSON.stringify(state));
			localStorage.setItem('pan-terminal-active', activeTabId || '');

			// Save to DB for persistence across restarts (includes claudeSessionIds)
			api('/dashboard/api/open-tabs', {
				method: 'POST',
				body: JSON.stringify({ tabs: state.map(t => ({
					session_id: t.sessionId,
					tab_name: t.tabName || '',
					project_id: t.projectId,
					cwd: t.cwd,
					tab_index: t.tabIndex,
					claude_session_ids: JSON.stringify(t.claudeSessionIds || [])
				})) }),
				headers: { 'Content-Type': 'application/json' }
			}).catch(() => {});
		} catch {}
	}
	function getSavedSessionState() {
		try {
			const saved = localStorage.getItem('pan-terminal-sessions');
			return saved ? JSON.parse(saved) : [];
		} catch { return []; }
	}
	async function getDbSessionState() {
		try {
			const tabs = await api('/dashboard/api/open-tabs');
			if (!Array.isArray(tabs) || tabs.length === 0) return [];
			return tabs.map(t => {
				let csids = [];
				try { csids = JSON.parse(t.claude_session_ids || '[]'); } catch {}
				return {
					sessionId: t.session_id,
					tabName: t.tab_name || '',
					project: t.project_name || 'Shell',
					cwd: t.project_path || t.cwd || 'C:\\Users\\tzuri\\Desktop',
					projectId: t.project_id,
					tabIndex: t.tab_index ?? 0,
					claudeSessionIds: csids
				};
			});
		} catch { return []; }
	}

	// Tab naming
	let tabNameCounter = 0;
	function getNextTabName() {
		tabNameCounter++;
		return `PAN ${tabNameCounter}`;
	}
	let renamingTabId = $state(null);
	let renameValue = $state('');

	function startRenameTab(tabId) {
		const tab = tabs.find(t => t.id === tabId);
		if (!tab) return;
		renamingTabId = tabId;
		renameValue = tab.tabName || tab.project || '';
	}
	function finishRenameTab() {
		if (!renamingTabId) return;
		const tab = tabs.find(t => t.id === renamingTabId);
		if (tab && renameValue.trim()) {
			tab.tabName = renameValue.trim();
			tabs = [...tabs];
			// Persist rename to DB
			api(`/dashboard/api/open-tabs/${encodeURIComponent(tab.sessionId)}/rename`, {
				method: 'PATCH',
				body: JSON.stringify({ name: tab.tabName }),
				headers: { 'Content-Type': 'application/json' }
			}).catch(() => {});
			saveSessionState();
		}
		renamingTabId = null;
		renameValue = '';
	}
	function cancelRenameTab() {
		renamingTabId = null;
		renameValue = '';
	}

	// Load all tabs (open + closed) for a given project, deduped by name
	async function loadAllProjectTabs(projectId) {
		if (!projectId) { allProjectTabs = []; return; }
		try {
			const result = await api('/dashboard/api/all-tabs?project_id=' + encodeURIComponent(projectId));
			const raw = Array.isArray(result) ? result : [];
			// Always show open tabs; for closed tabs, only keep the most recent per tab_name
			const open = raw.filter(t => !t.closed_at);
			const closed = raw.filter(t => t.closed_at);
			const closedByName = {};
			for (const t of closed) {
				const name = t.tab_name || 'Unnamed';
				// Skip closed tabs that duplicate an open tab's name
				if (open.some(o => (o.tab_name || 'Unnamed') === name)) continue;
				if (!closedByName[name] || t.last_active > closedByName[name].last_active) {
					closedByName[name] = t;
				}
			}
			allProjectTabs = [...open, ...Object.values(closedByName)];
		} catch { allProjectTabs = []; }
	}

	// Reopen a closed tab — creates a new PTY with fresh Claude, injects that tab's transcript
	async function reopenTab(dbTab) {
		// Mark it as reopened in DB
		await api(`/dashboard/api/open-tabs/${dbTab.id}/reopen`, { method: 'POST' }).catch(() => {});

		// Parse saved claude session IDs
		let csids = [];
		try { csids = JSON.parse(dbTab.claude_session_ids || '[]'); } catch {}

		// Create new PTY session with a new ID but carry the tab name and transcript
		const projectName = dbTab.project_name || 'Shell';
		const cwd = dbTab.project_path || dbTab.cwd || 'C:\\Users\\tzuri\\Desktop';
		const newSessionId = sessionPrefix + (projectName || 'shell').toLowerCase().replace(/[^a-z0-9]/g, '-') + '-' + Date.now();

		// Update the DB record with the new session ID
		await api(`/dashboard/api/open-tabs/${dbTab.id}/reopen`, { method: 'POST' }).catch(() => {});

		await createTab(newSessionId, projectName, cwd, dbTab.project_id, false, dbTab.tab_name || null, csids);

		// Refresh the project tabs dropdown
		if (dbTab.project_id) loadAllProjectTabs(dbTab.project_id);
	}

	// Dev mode detection — Vite dev server runs on a different port than Prod (7777)
	const isDev = typeof window !== 'undefined' && window.location.port !== '7777' && window.location.port !== '';
	const sessionPrefix = isDev ? 'dev-dash-' : 'dash-';

	// Terminal container refs
	let termContainerEl;
	let chatSidebarEl;

	// Center chat input
	let centerChatInput = $state('');
	let centerChatLoading = $state(false);
	let centerChatMessages = $state([]);
	let centerChatEl;
	let centerChatUserScrolledUp = false;
	let voiceSettings = $state({});
	let isListening = $state(false);
	let recognition = null;
	let pastedImages = $state([]); // { dataUrl, path } — preview before send

	// Perf widget
	let perfData = $state({ wsLatency: 0, domTime: 0, linesChanged: 0, serverRender: 0, serverTotal: 0, msgSize: 0, fps: 0 });
	let perfProcesses = $state([]);
	// New panel data: canonical PAN services from steward + outside-PAN noise.
	let perfServices = $state([]);
	let perfOther = $state([]);
	let perfProcessTimer = null;
	let perfFrames = 0;
	let perfLastFpsTime = Date.now();

	async function loadPerfProcesses() {
		try {
			const data = await api('/dashboard/api/processes');
			// New endpoint returns { services, other, processes }. Prefer the
			// canonical `services` list (steward registry → real PIDs); fall
			// back to legacy `processes` so an old server build still works.
			if (data?.services) {
				perfServices = data.services;
				perfOther = data.other || [];
				perfProcesses = data.processes || [];
			} else if (data?.processes) {
				perfProcesses = data.processes;
			}
		} catch {}
	}

	function startPerfPolling() {
		if (perfProcessTimer) return;
		loadPerfProcesses();
		perfProcessTimer = setInterval(loadPerfProcesses, 5000);
	}
	function stopPerfPolling() {
		if (perfProcessTimer) { clearInterval(perfProcessTimer); perfProcessTimer = null; }
	}

	async function killProcess(pid) {
		try {
			await api('/dashboard/api/processes/kill', { method: 'POST', body: JSON.stringify({ pid }), headers: { 'Content-Type': 'application/json' } });
			setTimeout(loadPerfProcesses, 500);
		} catch {}
	}

	function updatePerfOverlay(data) {
		perfFrames++;
		const now = Date.now();
		if (now - perfLastFpsTime >= 1000) {
			data.fps = perfFrames;
			perfFrames = 0;
			perfLastFpsTime = now;
		} else {
			data.fps = perfData.fps;
		}
		perfData = data;
	}

	// Intervals
	let chatRefreshInterval = null;
	let termInitialized = false;

	// Tab counter
	let tabCounter = 0;

	// ==================== Projects ====================

	async function loadProjects() {
		try {
			const data = await api('/dashboard/api/projects');
			projects = Array.isArray(data) ? data : (data.projects || []);
		} catch (e) {
			console.error('Failed to load projects:', e);
		}
	}

	async function loadTerminalProjects() {
		return loadProjects();
	}

	// ==================== Tab Management ====================

	function getActiveTab() {
		return tabs.find(t => t.id === activeTabId);
	}

	async function switchTerminalProject(projectOrValue) {
		let projectName, projectId, cwd;

		if (typeof projectOrValue === 'object' && projectOrValue) {
			projectName = projectOrValue.name || 'Shell';
			projectId = projectOrValue.id || null;
			cwd = projectOrValue.path || projectOrValue.cwd || 'C:\\Users\\tzuri\\Desktop';
		} else {
			return;
		}

		// Check if tab already exists for this project (match by project name, not session ID)
		const existing = tabs.find(t => t.project === projectName);
		if (existing) {
			switchToTab(existing.id);
			return;
		}

		const sessionId = sessionPrefix + (projectName || 'shell').toLowerCase().replace(/[^a-z0-9]/g, '-');
		await createTab(sessionId, projectName, cwd, projectId, false, null);
		if (projectId) loadAllProjectTabs(projectId);
	}

	function newTerminalTab() {
		const active = getActiveTab();
		const projectName = active?.project || 'Shell';
		const projectId = active?.projectId || null;
		const cwd = active?.cwd || 'C:\\Users\\tzuri\\Desktop';
		const sessionId = sessionPrefix + (projectName || 'shell').toLowerCase().replace(/[^a-z0-9]/g, '-') + '-' + Date.now();
		createTab(sessionId, projectName, cwd, projectId, false, null);
	}

	async function createTab(sessionId, projectName, cwd, projectId, isReconnect, tabName, savedClaudeSessionIds) {
		const tabId = 'tab-' + (++tabCounter);

		// Server-side rendered terminal — just a scrollable div that displays pre-rendered HTML lines
		const tabContainer = document.createElement('div');
		tabContainer.id = 'term-' + tabId;
		tabContainer.className = 'term-output';
		tabContainer.style.cssText = 'position:absolute;top:0;left:0;right:0;bottom:0;display:none;overflow-y:auto;overflow-x:hidden;font-family:"JetBrains Mono","Cascadia Code","Fira Code",Consolas,monospace;font-size:13px;line-height:1.35;color:#cdd6f4;background:#11111b;';

		// Scrollback div — tight terminal-style line rendering
		const scrollbackDiv = document.createElement('div');
		scrollbackDiv.className = 'term-scrollback';
		scrollbackDiv.style.cssText = 'padding:6px 10px 12px 10px;white-space:pre-wrap;word-break:break-word;overflow-wrap:break-word;position:relative;z-index:2;background:#11111b;';
		tabContainer.appendChild(scrollbackDiv);

		// Screen div — hidden. We use msg.lines server-side data only for detecting
		// approval prompts (1/2/3 menus) and surface them as numbered buttons in the
		// input area. The visual scrollback comes entirely from the transcript JSON.
		const screenDiv = document.createElement('div');
		screenDiv.className = 'term-screen';
		screenDiv.style.cssText = 'display:none;';
		tabContainer.appendChild(screenDiv);

		// Cache of previous line HTML for diffing
		let prevLines = [];

		termContainerEl.appendChild(tabContainer);

		const tabData = {
			id: tabId,
			sessionId,
			tabName: tabName || getNextTabName(),
			ws: null,
			project: projectName,
			cwd,
			projectId,
			claudeStarted: false,
			container: tabContainer,
			scrollbackDiv,
			screenDiv,
			host: '',
			_closing: false,
			claudeSessionIds: savedClaudeSessionIds || [],
			userScrolledUp: false,
			logLines: [],       // Append-only log from server (immune to corruption)
		};

		// Track if user has scrolled up (don't auto-scroll if so)
		tabContainer.addEventListener('scroll', () => {
			const atBottom = tabContainer.scrollHeight - tabContainer.scrollTop - tabContainer.clientHeight < 40;
			tabData.userScrolledUp = !atBottom;
		});

		// Show only this tab's container
		tabs.forEach(t => { if (t.container) t.container.style.display = 'none'; });
		tabContainer.style.display = 'block';

		tabs = [...tabs, tabData];
		activeTabId = tabId;
		sessionsCount = tabs.length;

		// Initial transcript render — populate from clean message data
		setTimeout(() => renderTranscriptToTerminal(tabData), 100);

		// (REMOVED) HTTP polling. The server now pushes parsed transcript
		// messages via the `transcript_messages` WebSocket event whenever
		// any JSONL in the project's Claude Code dir changes (via fs.watch).
		// renderTranscriptToTerminal is called from that handler.
		tabData._pollTimer = null;
		// (REMOVED) The 30-second full-refresh "safety net" was causing the page to
		// flash visibly. It was the wrong fix for a polling problem — root cause
		// should be fixed instead of nuking the DOM periodically.

		// Connect WebSocket — server sends pre-rendered HTML via ScreenBuffer
		{
			// Calculate cols from container width (monospace char ~8.4px at 14px font)
			const charWidth = 8.4;
			const containerWidth = termContainerEl ? termContainerEl.clientWidth - 24 : 900; // 24px padding
			const calcCols = Math.max(80, Math.floor(containerWidth / charWidth));
			const calcRows = termContainerEl ? Math.max(20, Math.floor(termContainerEl.clientHeight / 21)) : 30; // line-height ~21px
			const wsUrlStr = wsUrl(`/ws/terminal?session=${encodeURIComponent(sessionId)}&project=${encodeURIComponent(projectName)}&cwd=${encodeURIComponent(cwd)}&cols=${calcCols}&rows=${calcRows}`);

			const ws = new WebSocket(wsUrlStr);
			tabData.ws = ws;

			let hasExistingBuffer = false;
			let reconnectAttempts = 0;
			let reconnectTimer = null;
			let serverRestarting = false;
			let pingTimer = null;

			function startPing() {
				if (pingTimer) clearInterval(pingTimer);
				pingTimer = setInterval(() => {
					if (tabData.ws && tabData.ws.readyState === 1) {
						tabData.ws.send(JSON.stringify({ type: 'ping' }));
					}
				}, 25000);
				tabData._pingTimer = pingTimer;
			}

			function stopPing() {
				if (pingTimer) { clearInterval(pingTimer); pingTimer = null; tabData._pingTimer = null; }
			}

			function handleMessage(event) {
				try {
					const tRecv = performance.now();
					const msg = JSON.parse(event.data);
					switch (msg.type) {
						case 'transcript_messages': {
							// Server pushed parsed messages from the JSONL file watcher.
							// Replaces polling. We get the full deduped message list each
							// time any JSONL in the project's dir changes.
							tabData._pushedMessages = msg.messages || [];
							renderTranscriptToTerminal(tabData);
							break;
						}
						case 'screen-v2': {
							// Visual scrollback comes from transcript JSON. Here we only
							// scan the live screen text to detect Claude's interactive
							// approval menus. The "thinking" indicator is now driven by
							// actual message arrival, not screen scanning (the regex was
							// unreliable and left the indicator stuck on).
							if (!hasExistingBuffer) {
								hasExistingBuffer = true;
								renderTranscriptToTerminal(tabData);
							}
							const allLines = msg.lines || [];
							const plainLines = allLines.map(l => (l || '').replace(/<[^>]*>/g, '').trim());
							const detected = detectApprovalOptions(plainLines);
							if (activeTabId === tabData.id) {
								if (detected) {
									approvalOptions = detected;
								} else {
									approvalOptions = null;
								}
							}
							// Reality-check the "thinking" indicator against the actual
							// live PTY screen. The send-driven flag (`claudeReady=false`
							// after a send, cleared when the transcript HTML stabilizes)
							// has historically gotten stuck when sends fail or transcript
							// updates don't arrive. The PTY screen IS the source of truth:
							// if the input prompt (❯) is visible at the bottom and there's
							// no spinner text, Claude is idle no matter what flags say.
							// This forcibly clears the indicator the instant reality says
							// it should be cleared.
							const ptySaysReady = detectClaudeReady(plainLines);
							if (ptySaysReady) {
								if (tabData.claudeReady === false) {
									tabData.claudeReady = true;
									tabData._htmlAtSend = null;
									if (tabData._readyTimer) { clearTimeout(tabData._readyTimer); tabData._readyTimer = null; }
								}
								if (activeTabId === tabData.id && !claudeReady) {
									claudeReady = true;
								}
							} else {
								// PTY says busy — make sure the flag agrees so the indicator
								// shows even when the user did not initiate the activity
								// (e.g. AutoDev sent a prompt, or a hook is running).
								if (activeTabId === tabData.id && claudeReady) {
									claudeReady = false;
								}
							}
							const linesChanged = 0;

							// Perf metrics
							const tDom = performance.now();
							const wsLatency = msg._ts ? (Date.now() - msg._ts) : -1;
							const domTime = +(tDom - tRecv).toFixed(1);
							updatePerfOverlay({
								wsLatency,
								domTime,
								linesChanged,
								serverRender: 0,
								serverSerialize: 0,
								serverTotal: 0,
								msgSize: event.data.length,
							});

							// Auto-scroll
							if (!tabData.userScrolledUp) {
								tabContainer.scrollTop = tabContainer.scrollHeight;
							} else if (scrollHeightBefore > 0) {
								const scrollHeightAfter = tabContainer.scrollHeight;
								const delta = scrollHeightAfter - scrollHeightBefore;
								if (delta > 0) tabContainer.scrollTop += delta;
							}

							if (!hasExistingBuffer && msg.lines.some(l => l.trim().length > 0)) {
								hasExistingBuffer = true;
							}
							break;
						}
						case 'screen': {
							// Legacy v1 fallback
							const scrollHeightBefore2 = tabData.userScrolledUp ? tabContainer.scrollHeight : 0;
							if (msg.scrollback && msg.scrollback.length > 0) {
								const newLines = msg.scrollback;
								const prevScrollbackLen = parseInt(scrollbackDiv.dataset.len || '0');
								if (newLines.length > prevScrollbackLen) {
									const toAdd = newLines.slice(prevScrollbackLen);
									scrollbackDiv.insertAdjacentHTML('beforeend', (prevScrollbackLen > 0 ? '\n' : '') + toAdd.join('\n'));
								} else if (newLines.length < prevScrollbackLen) {
									scrollbackDiv.innerHTML = newLines.join('\n');
								}
								scrollbackDiv.dataset.len = String(newLines.length);
							}
							screenDiv.innerHTML = (msg.lines || []).join('\n');
							if (!tabData.userScrolledUp) {
								tabContainer.scrollTop = tabContainer.scrollHeight;
							}
							if (!hasExistingBuffer && msg.lines.some(l => l.trim().length > 0)) {
								hasExistingBuffer = true;
							}
							break;
						}
						case 'info':
							tabData.host = msg.host || '';
							if (msg.claudeLaunched) tabData.claudeStarted = true;
							if (activeTabId === tabId) {
								hostLabel = `${msg.host} \u2014 ${msg.project || 'shell'}`;
							}
							tabs = [...tabs];
							break;
						case 'exit': {
							// PTY died. Clear thinking state, paint a red banner, and surface
							// the exit code. Without this the tab silently freezes — which is
							// exactly the 30-minute black hole that prompted this fix.
							const uptimeSec = Math.round((msg.uptime_ms || 0) / 1000);
							tabData.claudeReady = true;
							tabData.claudeStarted = false;
							tabData.ptyDead = true;
							tabData.ptyExitCode = msg.code;
							if (activeTabId === tabData.id) claudeReady = true;
							scrollbackDiv.innerHTML += '\n<div style="margin:8px 0;padding:8px 12px;background:#3c1f24;border-left:3px solid #f38ba8;color:#f38ba8;font-weight:600">⚠ Claude PTY exited (code ' + msg.code + ', uptime ' + uptimeSec + 's) — switch tabs and back, or refresh, to relaunch.</div>';
							tabs = [...tabs];
							break;
						}
						case 'error':
							scrollbackDiv.innerHTML += '\n<span style="color:#f38ba8">[Error: ' + msg.message + ']</span>';
							break;
						case 'chat_update': {
							const updateSid = msg.session_id || '';
							if (updateSid && !updateSid.startsWith('system-') && !updateSid.startsWith('phone-') && !updateSid.startsWith('router-') && !updateSid.startsWith('dash-') && !updateSid.startsWith('dev-dash-') && !updateSid.startsWith('mob-')) {
								const ownerTab = tabs.find(t => t.claudeSessionIds.includes(updateSid));
								if (!ownerTab) {
									const activeTab = getActiveTab();
									if (activeTab) {
										activeTab.claudeSessionIds = [...new Set([...activeTab.claudeSessionIds, updateSid])];
										tabs = [...tabs];
									}
								}
							}
							if (leftSection === 'transcript') {
								debouncedLoadChatHistory();
							}
							// Refresh main terminal view from transcript
							renderTranscriptToTerminal(tabData);
							break;
						}
						case 'permission_prompt':
							break;
						case 'server_restarting':
							serverRestarting = true;
							reconnectAttempts = 0;
							scrollbackDiv.innerHTML += '\n<span style="color:#f9e2af">[Server restarting \u2014 will reconnect automatically...]</span>';
							break;
						case 'voice_toggle':
							// Only handle ONCE — use a global flag to prevent multiple tabs from recording
							if (!window._panVoiceHandled) {
								window._panVoiceHandled = true;
								setTimeout(() => { window._panVoiceHandled = false; }, 300);
								toggleVoiceInput();
							}
							break;
						case 'voice_result': {
							// Deduplicate — only process once per message across all tab WebSockets
							const vrKey = `${msg.text?.substring(0,30)}_${msg.partial}`;
							if (window._lastVoiceResult === vrKey) break;
							window._lastVoiceResult = vrKey;
							setTimeout(() => { if (window._lastVoiceResult === vrKey) window._lastVoiceResult = null; }, 200);
							console.log('[Voice] voice_result received, partial=', msg.partial, 'text=', msg.text?.substring(0, 50), 'action=', msg.action);
							// 'done' action = process exited, just reset state
							if (msg.action === 'done') {
								isListening = false;
								window._voiceBaseText = undefined;
								break;
							}
							if (msg.text !== undefined && msg.text !== '') {
								// Snapshot existing text when voice session starts
								if (!window._voiceBaseText && window._voiceBaseText !== '') {
									window._voiceBaseText = terminalInputText.trim();
								}
								// Both partials and finals contain cumulative text — always replace, never append
								const base = window._voiceBaseText || '';
								terminalInputText = base ? base + ' ' + msg.text : msg.text;
								requestAnimationFrame(() => autoGrowInput());
								// Clear base text tracker and listening state when final result arrives
								if (!msg.partial) {
									window._voiceBaseText = undefined;
									isListening = false;
								}
							} else if (!msg.partial) {
								// Empty final = no speech detected, just reset
								isListening = false;
								window._voiceBaseText = undefined;
							}
							if (msg.action === 'send') {
								setTimeout(() => sendTerminalInput(), 100);
							}
							break;
						}
					}
				} catch {}
			}

			function reconnect() {
				if (tabData._closing) return;
				if (reconnectTimer) return;
				reconnectAttempts++;
				const delay = Math.min(reconnectAttempts * 1000, 5000);
				const label = serverRestarting ? 'Server restarting' : 'Reconnecting';
				scrollbackDiv.innerHTML += `\n<span style="color:#f9e2af">[${label}... attempt ${reconnectAttempts}]</span>`;

				reconnectTimer = setTimeout(() => {
					reconnectTimer = null;
					tabData._reconnectTimer = null;
					if (tabData._closing) return;
					if (tabData.ws && tabData.ws.readyState <= 1) return;

					const newWs = new WebSocket(wsUrlStr);
					newWs.onopen = () => {
						const wasServerRestart = serverRestarting;
						reconnectAttempts = 0;
						serverRestarting = false;
						tabData.ws = newWs;
						prevLines = [];
						scrollbackDiv.innerHTML += '\n<span style="color:#a6e3a1">[Reconnected]</span>';
						startPing();

						// Only relaunch Claude on reconnect if the SERVER actually restarted
						// (which means a fresh PTY). For network-blip reconnects, the existing
						// PTY is still alive and Claude is still running — re-running the
						// trigger would type the printf on top of an active Claude session.
						if (wasServerRestart && projectName && projectName !== 'Shell') {
							const launchKey = 'pan_claude_launched:' + sessionId;
							sessionStorage.removeItem(launchKey); // server restart = invalidate guard
							tabData.claudeStarted = false;
							setTimeout(async () => {
								if (newWs.readyState !== 1 || tabData.claudeStarted) return;
								if (sessionStorage.getItem(launchKey) === '1') return;
								tabData.claudeStarted = true;
								sessionStorage.setItem(launchKey, '1');
								try {
									await api('/api/v1/inject-context', {
										method: 'POST',
										headers: { 'Content-Type': 'application/json' },
										body: JSON.stringify({ cwd })
									});
									await new Promise(r => setTimeout(r, 300));
								} catch {}
								newWs.send(JSON.stringify({ type: 'input', data: 'printf "\\033[1;96m\u03A0\u0391\u039D remembers..\\033[0m\\n" && claude --permission-mode auto "\u03A0\u0391\u039D remembers..."\n' }));
							}, 2000);
						}
					};
					newWs.onmessage = handleMessage;
					newWs.onclose = () => {
						stopPing();
						if (tabData._closing) return;
						if (reconnectAttempts < 30) reconnect();
						else scrollbackDiv.innerHTML += '\n<span style="color:#f38ba8">[Connection lost \u2014 refresh page to retry]</span>';
					};
					newWs.onerror = () => {};
				}, delay);
				tabData._reconnectTimer = reconnectTimer;
			}

			ws.onopen = () => {
				startPing();

				// Auto-launch Claude (PAN) for project tabs — but only ONCE per project session.
				// Previously this fired on every WebSocket reconnect, re-running the printf trigger.
				if (projectName && projectName !== 'Shell') {
					setTimeout(async () => {
						if (ws.readyState !== 1) return;

						// Persistent guard: if we already launched Claude for this project's
						// PTY session, never re-run the trigger. Keyed by sessionId so a real
						// fresh session (different sessionId) will still launch.
						const launchKey = 'pan_claude_launched:' + sessionId;
						if (sessionStorage.getItem(launchKey) === '1') {
							tabData.claudeStarted = true;
							return;
						}

						// Check if Claude is already running (❯ prompt visible)
						await new Promise(r => setTimeout(r, 500));
						const screenText = tabData.screenDiv ? tabData.screenDiv.textContent : '';
						const lastLine = screenText.trim().split('\n').pop() || '';
						if (lastLine.includes('❯')) {
							tabData.claudeStarted = true;
							sessionStorage.setItem(launchKey, '1');
							return;
						}

						tabData.claudeStarted = true;
						sessionStorage.setItem(launchKey, '1');

						// Inject context into CLAUDE.md
						let briefingReady = false;
						try {
							await api('/api/v1/inject-context', {
								method: 'POST',
								headers: { 'Content-Type': 'application/json' },
								body: JSON.stringify({ cwd })
							});
							briefingReady = true;
							await new Promise(r => setTimeout(r, 300));
						} catch {}

						if (briefingReady) {
							ws.send(JSON.stringify({ type: 'input', data: 'printf "\\033[1;96m\u03A0\u0391\u039D remembers..\\033[0m\\n" && claude --permission-mode auto "\u03A0\u0391\u039D remembers..."\n' }));
						} else {
							ws.send(JSON.stringify({ type: 'input', data: 'claude --permission-mode auto\n' }));
						}
					}, 1500);
				}
			};

			ws.onmessage = handleMessage;

			ws.onclose = () => {
				stopPing();
				if (!tabData._closing) reconnect();
			};

			ws.onerror = () => {};
		}

		// Load sidebar data
		loadTerminalSidebar(projectId, projectName);

		return tabId;
	}

	function switchToTab(tabId) {
		const tab = tabs.find(t => t.id === tabId);
		if (!tab) return;

		tabs.forEach(t => {
			if (t.container) t.container.style.display = t.id === tabId ? 'block' : 'none';
		});

		activeTabId = tabId;
		hostLabel = tab.host ? `${tab.host} \u2014 ${tab.project || 'shell'}` : '';
		// Sync thinking indicator to the tab we just switched to. Without this,
		// a top-level `claudeReady=false` from a prior send on a different tab
		// would leak across tabs and pin "Claude is thinking…" forever.
		claudeReady = tab.claudeReady !== false;

		// Scroll to bottom on tab switch
		setTimeout(() => {
			if (tab.container && !tab.userScrolledUp) {
				tab.container.scrollTop = tab.container.scrollHeight;
			}
		}, 50);
		// Reload sidebar
		loadTerminalSidebar(tab.projectId, tab.project);
	}

	function closeTab(tabId) {
		const tab = tabs.find(t => t.id === tabId);
		if (!tab) return;

		// Kill server-side PTY
		try { fetch(`/api/v1/terminal/sessions/${encodeURIComponent(tab.sessionId)}`, { method: 'DELETE' }); } catch {}
		// Remove from DB
		api(`/dashboard/api/open-tabs/${encodeURIComponent(tab.sessionId)}`, { method: 'DELETE' }).catch(() => {});

		tab._closing = true;
		if (tab._pollTimer) { clearInterval(tab._pollTimer); tab._pollTimer = null; }
		if (tab.ws) tab.ws.close();
		if (tab.container) tab.container.remove();

		tabs = tabs.filter(t => t.id !== tabId);
		sessionsCount = tabs.length;

		// Immediately update localStorage so closed tabs don't reopen on refresh
		saveSessionState();

		if (activeTabId === tabId) {
			if (tabs.length > 0) {
				switchToTab(tabs[tabs.length - 1].id);
			} else {
				activeTabId = null;
				hostLabel = '';
			}
		}
	}

	// ==================== Left Sidebar ====================

	function switchLeftSection(tab) {
		leftSection = tab;
		if (tab === 'transcript') {
			loadChatHistory();
			if (chatRefreshInterval) clearInterval(chatRefreshInterval);
			chatRefreshInterval = setInterval(loadChatHistory, 30000);
		} else {
			if (chatRefreshInterval) { clearInterval(chatRefreshInterval); chatRefreshInterval = null; }
		}
	}

	function escapeHtml(str) {
		if (!str) return '';
		return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
	}

	// Listen for terminal settings changes — wipe cached renders so colors apply immediately
	if (typeof window !== 'undefined') {
		window.addEventListener('pan-terminal-settings-changed', () => {
			for (const t of tabs) {
				if (t.scrollbackDiv) t.scrollbackDiv.innerHTML = '';
				t._renderedMsgCount = 0;
				renderTranscriptToTerminal(t);
			}
		});
	}

	// Seed default username/LLM name + terminal colors on first run.
	// All are overridable from Settings → Terminal. Names are first-cap.
	if (typeof localStorage !== 'undefined') {
		if (!localStorage.getItem('pan_username')) localStorage.setItem('pan_username', 'Tereseus');
		const existingLlm = localStorage.getItem('pan_llm_name');
		if (!existingLlm || existingLlm === 'claude') localStorage.setItem('pan_llm_name', 'Claude');
		// Color defaults — blue for user, orange for Claude.
		// Force-migrate the OLD defaults (green/mauve from previous build) to the
		// new ones, so users who didn't manually pick a color get the update.
		const userColorCur = localStorage.getItem('pan_term_user_color');
		if (!userColorCur || userColorCur === '#a6e3a1') localStorage.setItem('pan_term_user_color', '#89b4fa');
		const llmColorCur = localStorage.getItem('pan_term_llm_color');
		if (!llmColorCur || llmColorCur === '#cba6f7') localStorage.setItem('pan_term_llm_color', '#fab387');
		// Wipe any explicitly-set text colors so they auto-derive from name colors
		// going forward. (Users can re-set explicit text colors in settings if desired.)
		if (localStorage.getItem('pan_term_user_text_color') === '#cdd6f4') localStorage.removeItem('pan_term_user_text_color');
		if (localStorage.getItem('pan_term_llm_text_color') === '#bac2de') localStorage.removeItem('pan_term_llm_text_color');
		if (!localStorage.getItem('pan_term_tool_color')) localStorage.setItem('pan_term_tool_color', '#f9e2af');
		if (!localStorage.getItem('pan_term_bg_color')) localStorage.setItem('pan_term_bg_color', '#11111b');
	}

	// Render the main terminal view from clean transcript data instead of raw VT100 PTY output.
	// This avoids escape-code rendering issues by using the same parsed messages the sidebar uses.
	// No inflight guard — concurrent calls are fine, the latest write wins on the DOM.
	async function renderTranscriptToTerminal(tabData) {
		if (!tabData || !tabData.scrollbackDiv) return;
		// Skip render entirely if user has an active text selection inside the
		// scrollback — replacing innerHTML would wipe their selection mid-copy.
		const sel = window.getSelection();
		if (sel && sel.rangeCount > 0 && !sel.isCollapsed) {
			const range = sel.getRangeAt(0);
			if (tabData.scrollbackDiv.contains(range.commonAncestorContainer)) return;
		}
		try {
			// PUSH-BASED: messages come from the server's transcript file watcher
			// via the WebSocket `transcript_messages` event, stored on tabData.
			// No more HTTP polling, no session ID resolution, no stale cache.
			const allMessages = tabData._pushedMessages || [];
			console.log('[PAN DIAG] RENDER ← tab.sessionId =', tabData.sessionId, '| messages =', allMessages.length);
			if (allMessages.length === 0) return;

			// Terminal-style rendering: tight monospace lines, simple prompt prefix.
			// Username + LLM name + colors come from settings (localStorage). Names first-cap.
			const firstCap = s => s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
			const username = firstCap((localStorage.getItem('pan_username') || 'User').replace(/[^a-zA-Z0-9_-]/g, ''));
			const llmName = firstCap((localStorage.getItem('pan_llm_name') || 'Claude').replace(/[^a-zA-Z0-9_-]/g, ''));
			const userColor = localStorage.getItem('pan_term_user_color') || '#89b4fa';
			const llmColor = localStorage.getItem('pan_term_llm_color') || '#fab387';
			// Lighten a hex color by mixing it with white. ratio 0..1, higher = lighter.
			function lightenHex(hex, ratio) {
				const m = /^#?([0-9a-f]{6})$/i.exec(hex);
				if (!m) return hex;
				const n = parseInt(m[1], 16);
				let r = (n >> 16) & 0xff, g = (n >> 8) & 0xff, b = n & 0xff;
				r = Math.round(r + (255 - r) * ratio);
				g = Math.round(g + (255 - g) * ratio);
				b = Math.round(b + (255 - b) * ratio);
				return '#' + ((r << 16) | (g << 8) | b).toString(16).padStart(6, '0');
			}
			// Text colors auto-derive from name color (lighter shade) unless user
			// has explicitly overridden them in settings.
			const userTextColor = localStorage.getItem('pan_term_user_text_color') || lightenHex(userColor, 0.55);
			const llmTextColor = localStorage.getItem('pan_term_llm_text_color') || lightenHex(llmColor, 0.55);
			const toolColor = localStorage.getItem('pan_term_tool_color') || '#f9e2af';
			const bgColor = localStorage.getItem('pan_term_bg_color') || '#11111b';
			// Apply background to the container on every render (cheap, idempotent)
			if (tabData.container) tabData.container.style.background = bgColor;
			if (tabData.scrollbackDiv) tabData.scrollbackDiv.style.background = bgColor;

			function buildLineHtml(msg) {
				if (msg.role === 'user' && msg.type === 'prompt') {
					let raw = (msg.text || '').trim();
					// Strip Claude Code's "[Pasted text #N +M lines]" prefix that gets
					// added to long multi-line pasted prompts. The actual user text
					// follows immediately after the placeholder in the same string.
					raw = raw.replace(/^\[Pasted text #\d+ \+\d+ lines\]/, '').trimStart();
					// Skip the ΠΑΝ remembers trigger — match the bare text OR the full
					// printf launch command (either can end up in the transcript).
					if (/^\u03A0\u0391\u039D remembers/i.test(raw)) return null;
					if (/printf\s+["'][^"']*\u03A0\u0391\u039D\s*remembers/i.test(raw)) return null;
					if (/claude\s+--permission-mode\s+auto\s+["']\u03A0\u0391\u039D\s*remembers/i.test(raw)) return null;
					// Skip Claude Code system-injected messages that come in as "user" role
					// but aren't actually from the user: task-notification, system-reminder,
					// command-message, command-name, local-command-stdout, etc. These are
					// XML-tagged blocks injected by the Claude Code harness.
					if (/^<(task-notification|system-reminder|command-message|command-name|command-args|local-command-stdout|local-command-stderr|user-prompt-submit-hook)[\s>]/i.test(raw)) return null;
					// Skip messages that are ONLY an XML tag wrapper (e.g. just <tag>...</tag>)
					if (/^<[a-z-]+>[\s\S]*<\/[a-z-]+>$/i.test(raw) && !/\n[^<]/.test(raw)) return null;
					const text = escapeHtml(raw);
					return (
						`<div class="t-line t-user">` +
						`<span style="color:${userColor};font-weight:bold;">${escapeHtml(username)}</span>` +
						`<span style="color:#89b4fa;">$ </span>` +
						`<span style="color:${userTextColor};">${text}</span>` +
						`</div>`
					);
				} else if (msg.role === 'assistant' && msg.type === 'text') {
					return (
						`<div class="t-line t-assistant">` +
						`<span style="color:${llmColor};font-weight:bold;">${escapeHtml(llmName)}</span>` +
						`<span style="color:#89b4fa;">$ </span>` +
						`<span style="color:${llmTextColor};">${escapeHtml(msg.text || '')}</span>` +
						`</div>`
					);
				} else if (msg.role === 'assistant' && msg.type === 'tool') {
					return (
						`<div class="t-line t-tool">` +
						`<span style="color:#6c7086;">\u2192 </span>` +
						`<span style="color:${toolColor};">${escapeHtml(msg.text || '')}</span>` +
						`</div>`
					);
				}
				return null;
			}

			// Skip update entirely if user has an active selection inside the scrollback
			// — replacing innerHTML would wipe their selection mid-copy.
			const sel = window.getSelection();
			if (sel && sel.rangeCount > 0 && !sel.isCollapsed) {
				const range = sel.getRangeAt(0);
				if (tabData.scrollbackDiv.contains(range.commonAncestorContainer)) {
					return; // user is selecting text — don't re-render
				}
			}

			// FULL RE-RENDER every poll. Build all message HTML, replace innerHTML
			// in one go.
			//
			// Turn-grouped rendering: consecutive messages from the same speaker
			// (user / assistant text / tool) get wrapped in a single .turn block
			// so we can draw a left gutter bar, a header row (name · time), and
			// optionally collapse long runs of tool calls.
			let lastAssistantText = '';
			let lastAssistantTs = '';
			let lastUserTs = '';
			const normalize = s => (s || '').replace(/\s+/g, ' ').trim();
			const seenSig = new Set();

			// First pass: filter, dedupe, and bucket each surviving message into
			// a "kind" we group by: 'user' | 'assistant' | 'tool'.
			const items = [];
			for (const m of allMessages) {
				const cleanText = (m.text || '').replace(/^\[Pasted text #\d+ \+\d+ lines\]/, '').trimStart();
				const sig = (m.role || '') + '|' + (m.type || '') + '|' + normalize(cleanText);
				if (sig.length > 10 && seenSig.has(sig)) continue;
				seenSig.add(sig);

				const lineHtml = buildLineHtml(m);
				if (!lineHtml) continue;

				let kind = null;
				if (m.role === 'user' && m.type === 'prompt') kind = 'user';
				else if (m.role === 'assistant' && m.type === 'text') kind = 'assistant';
				else if (m.role === 'assistant' && m.type === 'tool') kind = 'tool';
				if (!kind) continue;

				items.push({ kind, html: lineHtml, ts: m.ts || '', model: m.model || null });

				if (kind === 'assistant') { lastAssistantText = m.text || ''; lastAssistantTs = m.ts || ''; }
				if (kind === 'user') { lastUserTs = m.ts || ''; }
			}

			// Second pass: collapse adjacent same-kind items into turn blocks.
			const turns = [];
			for (const it of items) {
				const last = turns[turns.length - 1];
				if (last && last.kind === it.kind) last.items.push(it);
				else turns.push({ kind: it.kind, items: [it] });
			}

			// Format a timestamp into HH:MM (cheap, no Date locale fuss).
			function fmtTs(ts) {
				if (!ts) return '';
				const d = new Date(ts);
				if (isNaN(d.getTime())) return '';
				const h = String(d.getHours()).padStart(2, '0');
				const m = String(d.getMinutes()).padStart(2, '0');
				return `${h}:${m}`;
			}

			// Trim Anthropic-style model IDs down to the useful tail:
			//   "claude-opus-4-6-20251015" → "opus-4-6"
			//   "claude-sonnet-4-6"        → "sonnet-4-6"
			function shortModel(id) {
				if (!id) return '';
				let s = String(id).replace(/^claude-/i, '');
				s = s.replace(/-\d{8}$/, ''); // strip trailing date stamp
				return s;
			}

			// Render each turn into HTML. Tool turns are ALWAYS expanded — every
			// Edit/Read/Bash/etc shows in the terminal exactly like in the transcript.
			// (Earlier collapse-into-<details> behavior was hiding them entirely.)
			const parts = [];
			let lastShownModel = null;
			for (const turn of turns) {
				const lastItem = turn.items[turn.items.length - 1];
				const headTs = fmtTs(lastItem.ts);
				let headLabel = '';
				let cls = '';
				let modelLabel = '';
				if (turn.kind === 'user') { headLabel = username; cls = 'turn turn-user'; }
				else if (turn.kind === 'assistant') {
					headLabel = llmName;
					cls = 'turn turn-assistant';
					// Show the model only when it changes between assistant turns,
					// so the user can spot which model produced which reply without
					// repeating the badge on every single turn.
					const m = shortModel(turn.items.find(i => i.model)?.model);
					if (m && m !== lastShownModel) {
						modelLabel = m;
						lastShownModel = m;
					}
				}
				else { headLabel = ''; cls = 'turn turn-tool'; }

				{
					parts.push(
						`<div class="${cls}">` +
						(headLabel
							? `<div class="turn-head">` +
								`<span class="turn-name">${escapeHtml(headLabel)}</span>` +
								(headTs ? `<span class="turn-time">${headTs}</span>` : '') +
								(modelLabel ? `<span class="turn-model">${escapeHtml(modelLabel)}</span>` : '') +
								`</div>`
							: '') +
						turn.items.map(i => i.html).join('') +
						`</div>`
					);
				}
			}
			const newHtml = parts.join('');
			if (newHtml !== tabData._lastRenderedHtml) {
				// Preserve scroll position across re-renders. innerHTML replacement
				// would otherwise snap the scroll to 0 every time the transcript
				// updates, which is what made re-reading old messages painful.
				const container = tabData.container;
				const prevScrollTop = container ? container.scrollTop : 0;
				const prevScrollHeight = container ? container.scrollHeight : 0;
				const distanceFromBottom = container ? (prevScrollHeight - prevScrollTop - container.clientHeight) : 0;
				const wasAtBottom = !tabData.userScrolledUp || distanceFromBottom < 8;

				tabData.scrollbackDiv.innerHTML = newHtml;
				tabData._lastRenderedHtml = newHtml;

				if (container) {
					if (wasAtBottom) {
						// Stick to the bottom while live conversation is streaming.
						container.scrollTop = container.scrollHeight;
					} else {
						// Scrolled up reading history — keep the same content under
						// the user's eye by anchoring to distance-from-bottom (so new
						// content appended below doesn't shove their view up or down).
						container.scrollTop = container.scrollHeight - container.clientHeight - distanceFromBottom;
					}
				}
			}
			// "Thinking" indicator — push-model aware. The previous "wait for 2
			// stable polls" logic was unreachable because the watcher only emits
			// on actual file changes. Instead: as soon as an assistant message
			// has appeared AFTER the user's last prompt (= Claude has replied),
			// debounce 800ms of no further changes and mark ready.
			if (tabData._htmlAtSend != null) {
				// Find the index of the last user prompt and check if any
				// assistant message appears after it.
				let lastUserIdx = -1;
				for (let i = allMessages.length - 1; i >= 0; i--) {
					if (allMessages[i].role === 'user') { lastUserIdx = i; break; }
				}
				const hasAssistantReply = lastUserIdx >= 0 &&
					allMessages.slice(lastUserIdx + 1).some(m => m.role === 'assistant');

				if (hasAssistantReply) {
					// Reset the settle timer on every new push (still streaming)
					if (tabData._readyTimer) clearTimeout(tabData._readyTimer);
					tabData._readyTimer = setTimeout(() => {
						tabData.claudeReady = true;
						tabData._htmlAtSend = null;
						tabData._readyTimer = null;
						if (activeTabId === tabData.id) claudeReady = true;
					}, 800);
				}
			}
			tabData._prevPolledHtml = newHtml;
		} catch (err) {
			console.error('[PAN Terminal] renderTranscriptToTerminal error:', err);
		}
	}

	let chatServerLoaded = false; // true once server data has been received
	let chatLoadInProgress = false;
	let chatLoadDebounceTimer = null;

	function debouncedLoadChatHistory() {
		if (chatLoadDebounceTimer) clearTimeout(chatLoadDebounceTimer);
		chatLoadDebounceTimer = setTimeout(() => {
			chatLoadDebounceTimer = null;
			loadChatHistory();
		}, 3000);
	}

	async function loadChatHistory() {
		if (chatLoadInProgress) return; // prevent concurrent loads
		chatLoadInProgress = true;
		const active = getActiveTab();
		if (!active) {
			if (chatServerLoaded) chatBubbles = [];
			chatLoadInProgress = false;
			return;
		}

		try {
			const sessionId = active.sessionId || '';
			const isDashboardSession = /^(dash|mob)-/.test(sessionId);
			const realSessionId = isDashboardSession ? '' : sessionId;
			const chatKey = realSessionId || active.cwd || '';

			if (chatCurrentProject !== chatKey) {
				chatCurrentProject = chatKey;
			}

			// Use this tab's saved Claude session IDs for its specific transcript
			let sessionIds = [];
			if (active.claudeSessionIds && active.claudeSessionIds.length > 0) {
				sessionIds = [...active.claudeSessionIds];
			} else if (realSessionId) {
				sessionIds = [realSessionId];
			} else {
				// Fallback: probe events for this project path (only when tab has no saved sessions yet)
				const projectKey = active.cwd || '';
				if (projectKey) {
					try {
						const probe = await api('/dashboard/api/events?limit=50&project_path=' + encodeURIComponent(projectKey));
						if (probe && probe.events) {
							const seen = new Set();
							for (const evt of probe.events) {
								const sid = evt.session_id || '';
								if (sid && !seen.has(sid) && !sid.startsWith('system-') && !sid.startsWith('phone-') && !sid.startsWith('router-') && !sid.startsWith('dash-') && !sid.startsWith('mob-')) {
									seen.add(sid);
									sessionIds.push(sid);
									if (sessionIds.length >= 5) break;
								}
							}
						}
					} catch {}
				}
			}

			if (sessionIds.length === 0) {
				if (chatServerLoaded) chatBubbles = [];
				return;
			}

			const allMessages = [];
			await Promise.all(sessionIds.map(async (sid, idx) => {
				const data = await api('/dashboard/api/transcript?session_id=' + encodeURIComponent(sid) + '&limit=300&_t=' + Date.now());
				if (data && data.messages) {
					for (const msg of data.messages) {
						msg._sessionIdx = idx;
						allMessages.push(msg);
					}
				}
			}));

			allMessages.sort((a, b) => (a.ts || '').localeCompare(b.ts || ''));

			if (allMessages.length === 0) {
				if (chatServerLoaded) chatBubbles = [];
				return;
			}

			const sessionColors = ['var(--accent)', '#a6e3a1', '#f9e2af', '#f38ba8', '#cba6f7'];
			const multiSession = sessionIds.length > 1;
			const newBubbles = [];

			// Same shortener as the main terminal renderer.
			const _shortModel = (id) => {
				if (!id) return '';
				let s = String(id).replace(/^claude-/i, '');
				return s.replace(/-\d{8}$/, '');
			};
			// Pull the same display names the main terminal uses so the two views
			// stay consistent.
			const _firstCap = s => s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
			const _username = _firstCap((localStorage.getItem('pan_username') || 'User').replace(/[^a-zA-Z0-9_-]/g, ''));
			const _llmName = _firstCap((localStorage.getItem('pan_llm_name') || 'Claude').replace(/[^a-zA-Z0-9_-]/g, ''));

			let _lastBubbleModel = null;
			for (const msg of allMessages) {
				const accentColor = multiSession ? (sessionColors[msg._sessionIdx] || 'var(--accent)') : 'var(--accent)';
				if (msg.role === 'user') {
					if (msg.text && /^\u03A0\u0391\u039D remembers/i.test(msg.text.trim())) continue;
					newBubbles.push({
						type: 'user',
						text: msg.text || '',
						accentColor,
						multiSession,
						speaker: _username,
					});
				} else if (msg.type === 'text') {
					const modelShort = _shortModel(msg.model);
					// Same "show on change" rule as the main terminal so the model
					// label only appears when it actually flips.
					const modelTag = (modelShort && modelShort !== _lastBubbleModel) ? modelShort : '';
					if (modelShort) _lastBubbleModel = modelShort;
					newBubbles.push({
						type: 'assistant',
						text: msg.text || '',
						accentColor,
						multiSession,
						speaker: _llmName,
						model: modelTag,
					});
				} else if (msg.type === 'tool') {
					newBubbles.push({
						type: 'tool',
						text: msg.text || '',
					});
				}
			}

			// Smart scroll — only auto-scroll if user is already at the bottom
			const wasAtBottom = chatSidebarEl ? (chatSidebarEl.scrollHeight - chatSidebarEl.scrollTop - chatSidebarEl.clientHeight < 30) : true;
			const savedPos = chatSidebarEl?.scrollTop;

			chatBubbles = newBubbles;
			chatServerLoaded = true;
			saveChatToStorage();

			await tick();
			if (chatSidebarEl) {
				if (wasAtBottom) {
					chatSidebarEl.scrollTop = chatSidebarEl.scrollHeight;
				} else {
					chatSidebarEl.scrollTop = savedPos;
				}
			}
		} catch (err) {
			console.error('[PAN Chat] loadChatHistory error:', err);
		} finally {
			chatLoadInProgress = false;
		}
	}

	// tick imported from svelte

	// ==================== Center Chat ====================

	async function loadCenterChat() {
		const active = getActiveTab();
		if (!active) { centerChatMessages = []; return; }
		try {
			const sessionId = active.sessionId || '';
			const isDash = /^(dash|mob)-/.test(sessionId);
			let sids = [];
			if (!isDash && sessionId) {
				sids = [sessionId];
			} else {
				const projectKey = active.cwd || '';
				if (projectKey) {
					const probe = await api('/dashboard/api/events?limit=50&project_path=' + encodeURIComponent(projectKey));
					if (probe?.events) {
						const seen = new Set();
						for (const evt of probe.events) {
							const sid = evt.session_id || '';
							if (sid && !seen.has(sid) && !/^(system|phone|router|dash|mob)-/.test(sid)) {
								seen.add(sid);
								sids.push(sid);
								if (sids.length >= 3) break;
							}
						}
					}
				}
			}
			if (!sids.length) { centerChatMessages = []; return; }
			const all = [];
			await Promise.all(sids.map(async (sid) => {
				const data = await api('/dashboard/api/transcript?session_id=' + encodeURIComponent(sid) + '&limit=200&_t=' + Date.now());
				if (data?.messages) all.push(...data.messages);
			}));
			all.sort((a, b) => (a.ts || '').localeCompare(b.ts || ''));
			const wasAtBottom = centerChatEl ? (centerChatEl.scrollHeight - centerChatEl.scrollTop - centerChatEl.clientHeight < 50) : true;
			centerChatMessages = all;
			await tick();
			// Restore saved scroll position on page load, or auto-scroll if at bottom
			const savedRatio = localStorage.getItem('pan_chat_scroll_ratio');
			const savedScrolledUp = localStorage.getItem('pan_chat_scrolled_up');
			if (centerChatEl && savedScrolledUp === '1' && savedRatio !== null) {
				// User was scrolled up — restore their position
				const ratio = parseFloat(savedRatio);
				centerChatEl.scrollTop = ratio * (centerChatEl.scrollHeight - centerChatEl.clientHeight);
				centerChatUserScrolledUp = true;
			} else if (centerChatEl && (wasAtBottom || !centerChatUserScrolledUp)) {
				centerChatEl.scrollTop = centerChatEl.scrollHeight;
			}
		} catch (err) {
			console.error('[Center Chat] load error:', err);
		}
	}

	// Detect whether Claude Code is ready for user input by scanning the live PTY screen.
	// Ready = the ❯ input prompt line is visible near the bottom AND no spinner/status text
	// is currently being shown. Busy = Claude is processing/streaming.
	function detectClaudeReady(plainLines) {
		if (!plainLines || plainLines.length === 0) return true; // assume ready if unknown
		// Look at the bottom 12 lines
		const start = Math.max(0, plainLines.length - 12);
		let sawPromptBox = false;
		let sawSpinner = false;
		for (let i = start; i < plainLines.length; i++) {
			const line = plainLines[i];
			if (!line) continue;
			// Claude's input prompt box has a ❯ character at the start
			if (/[\u276F>]\s*$/.test(line) || /^[│|]?\s*[\u276F>]\s/.test(line)) sawPromptBox = true;
			// Spinner / status indicators while busy
			if (/(\u2728|esc to interrupt|tokens|↓|↑\s*\d|Thinking|Pondering|Cogitating|Ruminating|Considering|Reasoning)/i.test(line)) {
				sawSpinner = true;
			}
		}
		if (sawSpinner) return false;
		return sawPromptBox;
	}

	// Detect Claude Code's interactive approval menus from the live PTY screen text.
	// Looks for lines like "1. Yes", "❯ 1. Yes", "  2. Yes, allow always", etc.
	// Returns an array of {num, label} or null if no menu is currently shown.
	function detectApprovalOptions(plainLines) {
		if (!plainLines || plainLines.length === 0) return null;
		// Scan the last 20 lines (approval menus live near the bottom)
		const start = Math.max(0, plainLines.length - 20);
		const opts = [];
		const seen = new Set();
		for (let i = start; i < plainLines.length; i++) {
			const line = plainLines[i];
			if (!line) continue;
			// Match: optional ❯, optional whitespace, digit, dot/paren, label
			const m = line.match(/^[\u276F>\s]*(\d)[.)]\s+(.{1,80})$/);
			if (m) {
				const num = parseInt(m[1]);
				if (num >= 1 && num <= 9 && !seen.has(num)) {
					seen.add(num);
					opts.push({ num, label: m[2].trim() });
				}
			}
		}
		// Need at least 2 numbered options to count as a menu
		if (opts.length < 2) return null;
		// Sort by number and ensure they're contiguous starting from 1
		opts.sort((a, b) => a.num - b.num);
		if (opts[0].num !== 1) return null;
		for (let i = 1; i < opts.length; i++) {
			if (opts[i].num !== opts[i - 1].num + 1) return null;
		}
		return opts;
	}

	function sendApproval(num) {
		const active = getActiveTab();
		if (!active?.ws || active.ws.readyState !== 1) {
			console.warn('[PAN Terminal] sendApproval: ws not ready');
			return;
		}
		console.log('[PAN Terminal] sendApproval', num);
		// Claude Code's approval prompt is a TUI select list, NOT a 1/2/3 keypress menu.
		// To pick option N: reset to top with up-arrows, then (N-1) down-arrows, then Enter.
		// This matches what the existing approvalsData handler does at handleTerminalInputKey.
		try {
			let seq = '\x1b[A\x1b[A\x1b[A\x1b[A\x1b[A'; // 5 up arrows — guarantees top
			for (let i = 1; i < num; i++) seq += '\x1b[B'; // (N-1) down arrows
			seq += '\r'; // Enter to confirm
			active.ws.send(JSON.stringify({ type: 'input', data: seq }));
			approvalOptions = null; // hide buttons immediately for responsiveness
		} catch (err) {
			console.error('[PAN Terminal] sendApproval failed:', err);
		}
	}

	async function sendTerminalInput(explicitValue) {
		// Resolution order: explicit value passed in (Enter handler) > textarea DOM > state.
		// Type-guard: button onclick passes a MouseEvent here, ignore non-strings.
		const explicit = (typeof explicitValue === 'string' ? explicitValue : '').trim();
		const domValue = (terminalInputEl?.value || '').trim();
		const stateValue = terminalInputText.trim();
		let text = explicit || domValue || stateValue;
		const imgPaths = pastedImages.filter(img => img.path).map(img => img.path.replace(/\\\\/g, '/').replace(/\\/g, '/'));
		if (imgPaths.length) text = (text ? text + ' ' : '') + imgPaths.join(' ');

		const active = getActiveTab();
		console.log('[PAN Terminal] sendTerminalInput', {
			textLen: text.length,
			textPreview: text.substring(0, 60),
			tabId: active?.id,
			sessionId: active?.sessionId,
		});

		if (!active) {
			console.warn('[PAN Terminal] sendTerminalInput: no active tab');
			return;
		}

		// Use HTTP POST to /api/v1/terminal/send instead of WebSocket. The WebSocket
		// silently queues sends to a possibly-dead socket; HTTP gives us a clear
		// success/failure response. This is the same endpoint the mobile page uses
		// and it has been proven reliable. We still keep the WebSocket connection
		// for RECEIVING screen updates and chat_update events.
		console.log('[PAN DIAG] SEND → session_id =', active.sessionId, '| text =', JSON.stringify(text.substring(0, 60)));

		// ALWAYS split the send into two HTTP POSTs: text first, then \r separately.
		// This prevents Claude Code's "[Pasted text +N lines]" buffer from
		// concatenating multiple sends into one prompt. Each send is its own
		// complete paste-then-submit cycle. Empty input (just Enter for prompts)
		// only does the second step.
		const httpSend = async (payload) => {
			const res = await fetch('/api/v1/terminal/send', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'X-PAN-Source': 'dashboard' },
				body: JSON.stringify({ session_id: active.sessionId, text: payload, raw: true, source: 'dashboard' }),
			});
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const data = await res.json();
			if (!data.ok) throw new Error(data.error || 'send failed');
		};
		try {
			if (text) {
				// Phase 1: send text only (no \r)
				await httpSend(text);
				// Delay so the REPL finishes paste-detection before the Enter
				await new Promise(r => setTimeout(r, 150));
			}
			// Phase 2: send the Enter to submit
			await httpSend('\r');
			// Phase 3: belt-and-suspenders second Enter. Sometimes the first \r
			// gets eaten by Claude Code's paste-detection buffer or never makes
			// it past the input-box "commit" step, leaving the message stuck.
			// A second Enter after a short delay reliably commits it. If Claude
			// is already processing, a stray Enter on the busy state is a no-op.
			await new Promise(r => setTimeout(r, 120));
			await httpSend('\r');
			console.log('[PAN Terminal] HTTP send ok (split, double-enter)');
		} catch (err) {
			console.error('[PAN Terminal] HTTP send failed:', err);
			if (terminalInputEl) {
				terminalInputEl.style.outline = '2px solid #f38ba8';
				setTimeout(() => { if (terminalInputEl) terminalInputEl.style.outline = ''; }, 1500);
			}
			return; // KEEP the text in the input box so the user can retry
		}

		// (REMOVED) Optimistic echo — was hiding messages when dedup matched them
		// to the wrong polled entry, or when polling early-returned. Reverted per
		// user request: "significantly worse for messages to be deleted".

		// Only clear AFTER successful send
		terminalInputText = '';
		setTerminalInput('');
		pastedImages = [];
		if (terminalInputEl) terminalInputEl.style.height = 'auto';
		// Mark Claude as busy. The poll loop watches the rendered HTML and clears
		// the indicator only when the DOM has been stable for 2 polls AND has
		// changed at least once since send. 60s hard failsafe.
		if (active) {
			active.claudeReady = false;
			active._htmlAtSend = active._lastRenderedHtml || '';
			active._stablePolls = 0;
		}
		claudeReady = false;
		setTimeout(() => {
			if (active && active.claudeReady === false) {
				active.claudeReady = true;
				active._htmlAtSend = null;
				if (activeTabId === active.id) claudeReady = true;
			}
		}, 60000);
	}

	function handleTerminalInputKey(e) {
		// Let Win+H pass through to Windows for voice typing
		if (e.key === 'h' && e.metaKey) return;

		const active = getActiveTab();
		const ws = active?.ws?.readyState === 1 ? active.ws : null;

		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			// Pass the textarea's CURRENT value directly — bypasses any Svelte state lag
			sendTerminalInput(e.target?.value);
			return;
		}
		// Escape → Ctrl+C to interrupt Claude
		if (e.key === 'Escape') {
			e.preventDefault();
			e.stopPropagation();
			if (ws) ws.send(JSON.stringify({ type: 'input', data: '\x03' }));
			return;
		}
		// Number keys 1-3 when input is empty AND there's a pending approval prompt
		// The prompt is a TUI select list: arrow-down to move, Enter to confirm
		if (/^[1-3]$/.test(e.key) && (e.target.value.length === 0 || !e.target.value.trim()) && approvalsData.length > 0) {
			e.preventDefault();
			e.stopImmediatePropagation();
			e.target.value = '';
			terminalInputText = '';
			if (ws) {
				const n = parseInt(e.key);
				let seq = '\x1b[A\x1b[A\x1b[A'; // 3 up arrows to ensure we're at top
				for (let i = 1; i < n; i++) seq += '\x1b[B'; // down arrows to reach option
				seq += '\r'; // Enter to confirm
				ws.send(JSON.stringify({ type: 'input', data: seq }));
			}
			return;
		}
	}

	async function sendCenterChat() {
		let text = centerChatInput.trim();
		const imgPaths = pastedImages.filter(img => img.path).map(img => `[Image: ${img.path}]`);
		if (imgPaths.length) text = (text ? text + ' ' : '') + imgPaths.join(' ');
		if (!text) return;
		centerChatInput = '';
		pastedImages = [];
		const textarea = document.querySelector('.center-input');
		if (textarea) textarea.style.height = 'auto';
		centerChatMessages = [...centerChatMessages, { role: 'user', text, ts: new Date().toISOString() }];
		await tick();
		if (centerChatEl) centerChatEl.scrollTop = centerChatEl.scrollHeight;
		centerChatUserScrolledUp = false;

		const active = getActiveTab();
		if (active?.ws?.readyState === 1) {
			active.ws.send(JSON.stringify({ type: 'input', data: text + '\r' }));
		}

		centerChatLoading = true;
		// Single delayed check instead of polling storm — WebSocket chat_update handles the rest
		setTimeout(async () => {
			await loadCenterChat();
			centerChatLoading = false;
		}, 3000);
	}

	async function handleCenterChatKey(e) {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			const active = getActiveTab();
			if (!active?.ws || active.ws.readyState !== 1) return;
			if (!centerChatInput && pastedImages.length === 0) {
				// Empty Enter — do nothing (use terminal directly for approvals/confirmations)
				return;
			}
			// Use sendCenterChat for consistent behavior (adds to chat, sends with newline)
			sendCenterChat();
			// Keep focus on chat input so user can keep typing
			await tick();
			const textarea = document.querySelector('.center-input');
			if (textarea) textarea.focus();
		}
	}

	function autoGrowInput(e) {
		const el = e?.target || terminalInputEl;
		if (!el) return;
		el.style.height = 'auto';
		const lineHeight = 20;
		const maxLines = 10;
		const maxHeight = lineHeight * maxLines;
		el.style.height = Math.min(el.scrollHeight, maxHeight) + 'px';
	}

	async function handleInputPaste(e) {
		const items = e.clipboardData?.items;
		if (!items) return;
		for (const item of items) {
			if (item.type.startsWith('image/')) {
				e.preventDefault();
				const blob = item.getAsFile();
				if (!blob) return;
				const reader = new FileReader();
				reader.onload = async () => {
					const dataUrl = reader.result;
					const base64 = dataUrl.split(',')[1];
					// Show preview immediately
					const previewEntry = { dataUrl, path: null, uploading: true };
					pastedImages = [...pastedImages, previewEntry];
					try {
						const resp = await fetch('/api/v1/clipboard-image', {
							method: 'POST',
							headers: { 'Content-Type': 'application/json' },
							body: JSON.stringify({ data: base64, mimeType: item.type })
						});
						const data = await resp.json();
						if (data.path) {
							previewEntry.path = data.path;
							previewEntry.uploading = false;
							pastedImages = [...pastedImages]; // trigger reactivity
						}
					} catch (err) {
						console.error('Image paste failed:', err);
						previewEntry.uploading = false;
						pastedImages = [...pastedImages];
					}
				};
				reader.readAsDataURL(blob);
				return;
			}
		}
	}

	function removePastedImage(idx) {
		pastedImages = pastedImages.filter((_, i) => i !== idx);
	}

	async function loadVoiceSettings() {
		try {
			const data = await api('/api/v1/settings');
			voiceSettings = data || {};
		} catch {}
	}

	let voiceStream = null;
	let voiceWs = null;
	let voiceProcessor = null;
	let voiceContext = null;
	let preVoiceText = '';  // Text in input box before voice started (to append, not replace)

	let voiceToggleLock = false;
	function toggleVoiceInput() {
		if (voiceToggleLock) return;
		voiceToggleLock = true;
		setTimeout(() => voiceToggleLock = false, 500);

		// Call server-side dictate-vad.py via toggle API (same as AHK XButton2)
		// Server spawns dictate-vad.py on first call, signals stop on second call
		// Results arrive via WebSocket voice_result messages (handled in WS handler)
		if (isListening) {
			// Stop recording — tell server to signal dictate-vad.py to stop
			console.log('[Voice] Stopping server-side dictation');
			fetch('/api/v1/voice/dictate', { method: 'POST' })
				.then(r => r.json())
				.then(data => console.log('[Voice] Dictate stop response:', data))
				.catch(err => console.error('[Voice] Dictate stop failed:', err));
			isListening = false;
			return;
		}

		// Start recording — snapshot existing text for appending
		preVoiceText = terminalInputText.trim();
		window._voiceBaseText = preVoiceText;
		isListening = true;
		console.log('[Voice] Starting server-side dictation');
		fetch('/api/v1/voice/dictate', { method: 'POST' })
			.then(r => r.json())
			.then(data => {
				console.log('[Voice] Dictate start response:', data);
				if (!data.ok) {
					console.error('[Voice] Dictate failed:', data.error);
					isListening = false;
				}
			})
			.catch(err => {
				console.error('[Voice] Dictate start failed:', err);
				isListening = false;
			});
	}

	// Kept for potential future WebSocket streaming use
	function _startAudioStreaming(stream) {
		// Create AudioContext at native rate — browsers ignore forced 16kHz
		voiceContext = new AudioContext();
		const nativeRate = voiceContext.sampleRate;
		const targetRate = 16000;
		const source = voiceContext.createMediaStreamSource(stream);

		// Tell Whisper the actual sample rate we're sending
		if (voiceWs && voiceWs.readyState === 1) {
			voiceWs.send(JSON.stringify({ type: 'config', sample_rate: targetRate }));
		}

		// ScriptProcessor for broad compatibility (AudioWorklet needs separate file)
		voiceProcessor = voiceContext.createScriptProcessor(4096, 1, 1);
		voiceProcessor.onaudioprocess = (e) => {
			if (!voiceWs || voiceWs.readyState !== 1) return;
			const float32 = e.inputBuffer.getChannelData(0);

			// Resample from native rate to 16kHz
			let samples;
			if (nativeRate !== targetRate) {
				const ratio = nativeRate / targetRate;
				const newLen = Math.round(float32.length / ratio);
				samples = new Float32Array(newLen);
				for (let i = 0; i < newLen; i++) {
					const srcIdx = i * ratio;
					const idx = Math.floor(srcIdx);
					const frac = srcIdx - idx;
					samples[i] = idx + 1 < float32.length
						? float32[idx] * (1 - frac) + float32[idx + 1] * frac
						: float32[idx];
				}
			} else {
				samples = float32;
			}

			// Convert float32 to int16 PCM
			const int16 = new Int16Array(samples.length);
			for (let i = 0; i < samples.length; i++) {
				int16[i] = Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767)));
			}
			voiceWs.send(int16.buffer);
		};

		source.connect(voiceProcessor);
		voiceProcessor.connect(voiceContext.destination);
	}

	function stopVoiceStreaming() {
		console.log('[Voice] stopping, mediaRecorder state=', mediaRecorder?.state);
		// Stop batch MediaRecorder (triggers onstop which transcribes)
		if (mediaRecorder && mediaRecorder.state === 'recording') {
			mediaRecorder.stop();
			// isListening will be set to false in onstop handler after transcription
			return;
		}

		isListening = false;
		// Stop audio capture immediately (WebSocket path, currently unused)
		if (voiceProcessor) { try { voiceProcessor.disconnect(); } catch {} voiceProcessor = null; }
		if (voiceContext) { try { voiceContext.close(); } catch {} voiceContext = null; }
		if (voiceStream) { voiceStream.getTracks().forEach(t => t.stop()); voiceStream = null; }

		const ws = voiceWs;
		voiceWs = null;
		if (ws && ws.readyState === 1) {
			ws.send(JSON.stringify({ type: 'stop' }));
			setTimeout(() => { try { ws.close(); } catch {} }, 3000);
		}
	}

	// Batch fallback if WebSocket streaming isn't available
	let mediaRecorder = null;
	let audioChunks = [];

	function startBatchRecording() {
		navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
			mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
			audioChunks = [];
			isListening = true;
			console.log('[Voice] Batch recording started');
			mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) audioChunks.push(e.data); };
			mediaRecorder.onstop = async () => {
				stream.getTracks().forEach(t => t.stop());
				isListening = false;
				mediaRecorder = null;
				if (audioChunks.length === 0) return;
				const blob = new Blob(audioChunks, { type: 'audio/webm' });
				audioChunks = [];
				console.log('[Voice] Batch recording stopped, transcribing', blob.size, 'bytes...');
				try {
					const resp = await fetch('/api/v1/whisper/transcribe', {
						method: 'POST', headers: { 'Content-Type': 'audio/webm' }, body: blob,
					});
					if (resp.ok) {
						const data = await resp.json();
						console.log('[Voice] Batch result:', data.text?.substring(0, 60));
						if (data.text) {
							terminalInputText = preVoiceText ? preVoiceText + ' ' + data.text.trim() : data.text.trim();
							requestAnimationFrame(() => autoGrowInput());
						}
						if (data.action === 'send') setTimeout(() => sendTerminalInput(), 100);
					}
				} catch (err) { console.error('[Voice] Batch transcribe failed:', err); }
			};
			mediaRecorder.start();
		}).catch((err) => { console.error('[Voice] Mic access failed:', err); isListening = false; });
	}

	function switchCenterView(view) {
		centerView = view;
		if (view === 'chat') {
			loadCenterChat();
		} else if (view === 'atlas') {
			loadAtlasData();
		}
	}

	// --- Atlas ---
	let atlasRefreshTimer = null;
	async function loadAtlasData() {
		atlasLoading = !atlasData; // only show loading on first load
		try {
			const [svcResp, atlasResp, statsResp, projResp] = await Promise.all([
				api('/dashboard/api/services'),
				api('/api/v1/atlas/services'),
				api('/dashboard/api/stats'),
				api('/dashboard/api/projects'),
			]);
			atlasData = buildAtlasGraph(svcResp, atlasResp, statsResp, projResp);
		} catch (e) {
			console.error('Atlas load failed:', e);
		}
		atlasLoading = false;
		// Auto-refresh every 30s
		if (!atlasRefreshTimer) {
			atlasRefreshTimer = setInterval(loadAtlasData, 30000);
		}
	}

	function buildAtlasGraph(svcResp, atlasResp, statsResp, projResp) {
		const nodes = [];
		const edges = [];
		const nodeMap = {};
		const zones = [];

		function addNode(id, label, type, status, detail, group, x, y, description, navigate) {
			const n = { id, label, type, status: status || 'unknown', detail: detail || '', group, x, y, description: description || '', navigate: navigate || null };
			nodes.push(n);
			nodeMap[id] = n;
			return n;
		}

		function addZone(id, label, x, y, w, h, color) {
			zones.push({ id, label, x, y, w, h, color });
		}

		// Use Atlas API for rich service data (status, interval, lastRun, port, model)
		const atlasSvcs = atlasResp?.services || [];
		const atlasMap = Object.fromEntries(atlasSvcs.map(s => [s.id, s]));

		// Dashboard services for device info
		const dashServices = svcResp?.services || [];
		const devices = dashServices.filter(s => s.category === 'Devices');

		function svcStatus(id) {
			const s = atlasMap[id];
			if (!s) return 'unknown';
			if (s.status === 'running') return 'up';
			if (s.status === 'stopped') return 'idle';
			if (s.status === 'down' || s.status === 'error') return 'down';
			return 'unknown';
		}

		function svcDetail(id) {
			const s = atlasMap[id];
			if (!s) return '';
			const parts = [];
			if (s.port) parts.push(`Port ${s.port}`);
			if (s.interval) parts.push(`Every ${s.interval}`);
			if (s.lastRun) {
				const ago = Math.round((Date.now() - s.lastRun) / 60000);
				parts.push(ago < 60 ? `${ago}m ago` : `${Math.round(ago/60)}h ago`);
			}
			if (s.modelTierLabel && s.modelTier !== 'none') parts.push(s.modelTierLabel);
			return parts.join(' \u2014 ') || s.status;
		}

		const EC = {
			intel: '#89b4fa', core: '#f5c2e7', svc: '#a6e3a1',
			mem: '#cba6f7', proc: '#f9e2af', dev: '#fab387', proj: '#94e2d5'
		};

		// ==================== ZONES ====================
		addZone('z-core', 'Core', 20, 20, 340, 180, '#f5c2e7');
		addZone('z-services', 'Services', 380, 20, 440, 180, '#a6e3a1');
		addZone('z-processing', 'Processing', 840, 20, 440, 180, '#f9e2af');
		addZone('z-memory', 'Memory', 20, 220, 560, 200, '#cba6f7');
		addZone('z-intel', 'Intelligence', 600, 220, 340, 200, '#89b4fa');
		addZone('z-devices', 'Devices', 960, 220, 320, 200, '#fab387');
		addZone('z-projects', 'Projects', 20, 440, 560, 130, '#94e2d5');

		// ==================== CORE ====================
		addNode('pan-server', 'PAN Server', 'core', 'up',
			statsResp ? `${statsResp.total_events} events, ${statsResp.total_sessions} sessions` : 'Port 7777',
			'core', 110, 80, 'Central PAN server on port 7777. Node.js/Express.', { page: 'settings' });
		addNode('database', 'SQLite DB', 'data', 'up',
			statsResp ? `${(statsResp.db_size_bytes / 1048576).toFixed(1)}MB encrypted` : 'SQLCipher',
			'core', 280, 80, 'SQLCipher AES-256 encrypted database.', { page: 'data' });
		addNode('dashboard', 'Dashboard', 'ui', 'up', 'Svelte v2 @ /v2/', 'core', 110, 150, 'Svelte dashboard with terminal, chat, atlas.', null);
		addNode('tauri', 'Tauri Shell', 'ui', 'up', 'Port 7790 \u2014 desktop app', 'core', 280, 150, 'Lightweight native desktop shell.', null);

		// ==================== SERVICES ====================
		addNode('steward', 'Steward', 'service', svcStatus('pan-server'), svcDetail('pan-server') || 'Health monitor',
			'services', 470, 80, 'Monitors all services, auto-restarts on failure. Heartbeat every 60s.', { page: 'services' });
		addNode('whisper', 'Whisper STT', 'service', svcStatus('whisper'), svcDetail('whisper') || 'Port 7782',
			'services', 660, 80, 'faster-whisper voice transcription on port 7782.', null);
		addNode('ahk', 'Voice Hotkeys', 'service', svcStatus('ahk'), svcDetail('ahk') || 'AHK',
			'services', 470, 150, 'AutoHotkey voice dictation hotkeys.', null);
		addNode('ollama', 'Ollama', 'service', svcStatus('ollama'), svcDetail('ollama') || 'Port 11434',
			'services', 660, 150, 'Local model server for embeddings.', null);
		addNode('tailscale', 'Tailscale', 'service', svcStatus('tailscale'), 'VPN mesh',
			'services', 565, 150, 'Encrypted VPN tunnel for remote access.', null);

		edges.push({ from: 'steward', to: 'whisper', label: 'monitors', color: EC.svc });
		edges.push({ from: 'steward', to: 'ahk', label: 'launches', color: EC.svc });
		edges.push({ from: 'steward', to: 'ollama', label: 'checks', color: EC.svc });
		edges.push({ from: 'pan-server', to: 'steward', label: '', color: EC.core });
		edges.push({ from: 'pan-server', to: 'whisper', label: 'transcribe', color: EC.core });
		edges.push({ from: 'pan-server', to: 'dashboard', label: 'serves', color: EC.core });
		edges.push({ from: 'pan-server', to: 'tauri', label: 'IPC', color: EC.core });
		edges.push({ from: 'pan-server', to: 'database', label: '', color: EC.core });

		// ==================== PROCESSING ====================
		addNode('classifier', 'Classifier', 'process', svcStatus('classifier'), svcDetail('classifier'),
			'processing', 940, 80, 'Marks events as processed every 5 minutes.', null);
		addNode('dream-cycle', 'Dream Cycle', 'process', svcStatus('dream'), svcDetail('dream'),
			'processing', 1130, 80, 'Rewrites .pan-state.md every 6 hours.', null);
		addNode('consolidation', 'Consolidation', 'process', svcStatus('consolidation'), svcDetail('consolidation'),
			'processing', 940, 150, 'Extracts episodic/semantic/procedural memories.', null);
		addNode('evolution', 'Evolution', 'process', svcStatus('evolution'), svcDetail('evolution'),
			'processing', 1130, 150, '6-step config optimization pipeline.', null);

		edges.push({ from: 'database', to: 'classifier', label: 'events', color: EC.proc });
		edges.push({ from: 'classifier', to: 'dream-cycle', label: 'triggers', color: EC.proc });
		edges.push({ from: 'dream-cycle', to: 'consolidation', label: '', color: EC.proc });
		edges.push({ from: 'dream-cycle', to: 'evolution', label: '', color: EC.proc });

		// ==================== MEMORY ====================
		addNode('memory-hub', 'Memory Hub', 'memory', 'up', 'Vector stores + context builder',
			'memory', 120, 290, 'Assembles memories for Claude session injection.', null);
		addNode('mem-episodic', 'Episodic', 'memory', 'up', 'Events + outcomes',
			'memory', 300, 290, 'What happened. Importance-weighted recall.', null);
		addNode('mem-semantic', 'Semantic', 'memory', 'up', 'Knowledge triples',
			'memory', 450, 290, 'Subject/predicate/object facts with contradiction detection.', null);
		addNode('embeddings', 'Embeddings', 'memory', svcStatus('embeddings'), svcDetail('embeddings') || 'Keyword fallback',
			'memory', 300, 370, 'Vector encoding for memory search.', null);
		addNode('inject-ctx', 'Context Inject', 'process', 'up', 'CLAUDE.md \u2190 memory',
			'memory', 120, 370, 'Injects memory into CLAUDE.md before each session.', null);
		addNode('mem-procedural', 'Procedural', 'memory', 'up', 'Learned workflows',
			'memory', 450, 370, 'Multi-step procedures with success tracking.', null);

		edges.push({ from: 'pan-server', to: 'memory-hub', label: '', color: EC.core });
		edges.push({ from: 'memory-hub', to: 'mem-episodic', label: '', color: EC.mem });
		edges.push({ from: 'memory-hub', to: 'mem-semantic', label: '', color: EC.mem });
		edges.push({ from: 'memory-hub', to: 'mem-procedural', label: '', color: EC.mem });
		edges.push({ from: 'mem-episodic', to: 'embeddings', label: '', color: EC.mem });
		edges.push({ from: 'mem-semantic', to: 'embeddings', label: '', color: EC.mem });
		edges.push({ from: 'memory-hub', to: 'inject-ctx', label: '', color: EC.mem });
		edges.push({ from: 'consolidation', to: 'memory-hub', label: 'writes', color: EC.proc });

		// ==================== INTELLIGENCE ====================
		addNode('claude', 'Claude Code', 'ai', 'up', 'CLI sessions via hooks',
			'intel', 700, 290, 'Claude Code CLI. Memory injected via hooks.', null);
		addNode('scout', 'Scout', 'ai', svcStatus('scout'), svcDetail('scout'),
			'intel', 850, 290, 'Tool discovery \u2014 GitHub trending, MCP servers.', null);
		addNode('orchestrator', 'Orchestrator', 'ai', svcStatus('orchestrator'), svcDetail('orchestrator'),
			'intel', 700, 370, 'Autonomous agent \u2014 processes findings, generates tasks.', null);
		addNode('autodev', 'AutoDev', 'ai', svcStatus('autodev'), svcDetail('autodev'),
			'intel', 850, 370, 'Spawns headless Claude sessions for tasks.', null);

		edges.push({ from: 'inject-ctx', to: 'claude', label: 'CLAUDE.md', color: EC.intel });
		edges.push({ from: 'scout', to: 'orchestrator', label: 'findings', color: EC.intel });
		edges.push({ from: 'orchestrator', to: 'autodev', label: 'tasks', color: EC.intel });

		// ==================== DEVICES ====================
		const seenDevices = new Set();
		devices.forEach((d, i) => {
			if (seenDevices.has(d.name)) return;
			seenDevices.add(d.name);
			const x = 1060 + (i % 2) * 160;
			const y = 290 + Math.floor(i / 2) * 70;
			addNode(`dev-${d.name}`, d.name, 'device', d.status === 'up' ? 'up' : 'down', d.detail, 'devices', x, y, d.detail || d.name, { page: 'devices', device: d.name });
			edges.push({ from: 'pan-server', to: `dev-${d.name}`, label: '', color: EC.dev });
		});
		if (!seenDevices.has('Phone') && !devices.find(d => d.name?.includes('Pixel'))) {
			addNode('dev-phone', 'Phone', 'device', 'unknown', 'Android', 'devices', 1060, 290, 'Android phone.', { page: 'devices' });
			edges.push({ from: 'pan-server', to: 'dev-phone', label: '', color: EC.dev });
		}

		// ==================== PROJECTS ====================
		const projs = projResp || [];
		projs.forEach((p, i) => {
			const x = 100 + (i % 5) * 120;
			const y = 490 + Math.floor(i / 5) * 50;
			addNode(`proj-${p.id}`, p.name, 'project', 'up', p.path || '', 'projects', x, y, `Project: ${p.name}`, { page: 'projects', project: p.name });
		});

		return { nodes, edges, nodeMap, zones, stats: statsResp, atlas: atlasResp };
	}

	function atlasNodeColor(node) {
		const typeColors = {
			core: '#89b4fa',
			service: '#a6e3a1',
			device: '#f9e2af',
			job: '#cba6f7',
			data: '#fab387',
			project: '#74c7ec',
			ui: '#89dceb',
			ai: '#f38ba8',
			memory: '#f5c2e7',
			process: '#cba6f7',
			injection: '#94e2d5',
		};
		return typeColors[node.type] || '#6c7086';
	}

	function atlasStatusDot(status) {
		if (status === 'up') return '#a6e3a1';
		if (status === 'down') return '#f38ba8';
		if (status === 'warn') return '#f9e2af';
		return '#6c7086';
	}

	function handleAtlasWheel(e) {
		e.preventDefault();
		const delta = e.deltaY > 0 ? 0.9 : 1.1;
		const newScale = Math.max(0.3, Math.min(3, atlasTransform.scale * delta));
		atlasTransform = { ...atlasTransform, scale: newScale };
	}

	function handleAtlasPointerDown(e) {
		if (e.target.closest('.atlas-node')) return;
		atlasDragging = true;
		atlasDragStart = { x: e.clientX - atlasTransform.x, y: e.clientY - atlasTransform.y };
	}

	function handleAtlasPointerMove(e) {
		if (!atlasDragging) return;
		atlasTransform = { ...atlasTransform, x: e.clientX - atlasDragStart.x, y: e.clientY - atlasDragStart.y };
	}

	function handleAtlasPointerUp() {
		atlasDragging = false;
	}

	function atlasResetView() {
		atlasTransform = { x: 0, y: 0, scale: 1 };
	}

	// ==================== Right Panel ====================

	async function loadTerminalSidebar(projectId, projectName) {
		const active = getActiveTab();
		if (projectId) loadAllProjectTabs(projectId);
		// Always load services regardless of project
		try {
			const svcResp = await api('/dashboard/api/services');
			servicesData = svcResp?.services || [];
		} catch {}

		if (!projectId) {
			if (leftSection === 'transcript') loadChatHistory();
			return;
		}

		try {
			const [progress, tasks, sections, svcResp] = await Promise.all([
				api('/dashboard/api/progress'),
				api(`/dashboard/api/projects/${projectId}/tasks`),
				api(`/dashboard/api/projects/${projectId}/sections`),
				api('/dashboard/api/services'),
			]);

			const proj = progress?.projects?.find(p => p.id === projectId);
			projectData = proj || null;
			tasksData = tasks || null;
			sectionsData = sections || [];
			servicesData = svcResp?.services || [];
		} catch (e) {
			console.error('Failed to load sidebar data:', e);
		}

		if (leftSection === 'transcript') loadChatHistory();
	}

	async function loadUsageData() {
		try {
			const [claude, stats] = await Promise.all([
				api('/api/v1/claude-usage'),
				api('/dashboard/api/stats'),
			]);
			usageData = { claude, stats };
		} catch (e) {
			console.error('Failed to load usage data:', e);
		}
	}

	function formatTokens(n) {
		if (!n) return '0';
		if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
		if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
		return String(n);
	}

	function pctColor(pct) {
		if (pct < 50) return 'green';
		if (pct < 80) return 'yellow';
		return 'red';
	}

	function formatResetTime(isoStr) {
		if (!isoStr) return '';
		const reset = new Date(isoStr);
		const now = new Date();
		const diff = reset - now;
		if (diff <= 0) return 'now';
		const h = Math.floor(diff / 3600000);
		const m = Math.floor((diff % 3600000) / 60000);
		if (h > 0) return `${h}h ${m}m`;
		return `${m}m`;
	}

	async function cycleTask(taskId, currentStatus) {
		const next = currentStatus === 'todo' ? 'in_progress' : currentStatus === 'in_progress' ? 'done' : 'todo';
		try {
			await fetch('/dashboard/api/tasks/' + taskId, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ status: next })
			});
			const active = getActiveTab();
			if (active?.projectId) await loadTerminalSidebar(active.projectId, active.project);
		} catch {}
	}

	async function cycleSectionItem(itemId, currentStatus, sectionId) {
		const next = currentStatus === 'open' ? 'done' : 'open';
		try {
			await fetch('/dashboard/api/section-items/' + itemId, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ status: next })
			});
			const active = getActiveTab();
			if (active?.projectId) await loadTerminalSidebar(active.projectId, active.project);
		} catch {}
	}

	async function addSectionItem(sectionId, inputEl) {
		const content = inputEl?.value?.trim();
		if (!content) return;
		try {
			await fetch(`/dashboard/api/sections/${sectionId}/items`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ content })
			});
			inputEl.value = '';
			const active = getActiveTab();
			if (active?.projectId) await loadTerminalSidebar(active.projectId, active.project);
		} catch {}
	}

	async function deleteSection(sectionId) {
		if (!confirm('Delete this section and all its items?')) return;
		try {
			await fetch('/dashboard/api/sections/' + sectionId, { method: 'DELETE' });
			rightSection = 'tasks';
			const active = getActiveTab();
			if (active?.projectId) await loadTerminalSidebar(active.projectId, active.project);
		} catch {}
	}

	async function addTask(inputEl) {
		const active = getActiveTab();
		const title = inputEl?.value?.trim();
		if (!title || !active?.projectId) return;
		try {
			await fetch(`/dashboard/api/projects/${active.projectId}/tasks`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ title, milestone_id: rightMilestoneFilter || null })
			});
			inputEl.value = '';
			await loadTerminalSidebar(active.projectId, active.project);
		} catch {}
	}

	async function addBug(inputEl) {
		const active = getActiveTab();
		const title = inputEl?.value?.trim();
		if (!title || !active?.projectId) return;
		try {
			await fetch(`/dashboard/api/projects/${active.projectId}/tasks`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ title, priority: 1 })
			});
			inputEl.value = '';
			await loadTerminalSidebar(active.projectId, active.project);
		} catch {}
	}

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

	// ==================== Users ====================
	async function loadUsers() {
		try {
			const resp = await fetch('/dashboard/api/users');
			if (resp.ok) usersData = await resp.json();
		} catch {}
	}

	// ==================== Test Suites ====================
	// Client-side suite IDs that run in the browser
	const CLIENT_SUITES = new Set(['page-refresh', 'terminal-protocol', 'widgets', 'input-box']);

	async function loadTestSuites() {
		try {
			const resp = await devFetch('/api/v1/tests');
			if (resp.ok) {
				const data = await resp.json();
				// Server returns {status, suites: [...], tests: [...], ...}
				// suites have: id, name, description, testCount, dependsOn
				// Convert server suites to the format the UI expects: {id, name, description, tests: [...]}
				const serverSuites = (data.suites || []).map(s => {
					// Find tests for this suite from the full test list
					const suiteTests = (data.tests || []).filter(t => t.suiteId === s.id).map(t => ({
						id: t.id, name: t.name, description: t.description
					}));
					// If no tests in current run, generate placeholder test entries from testCount
					const tests = suiteTests.length > 0 ? suiteTests :
						Array.from({length: s.testCount}, (_, i) => ({id: `${s.id}-${i}`, name: `Test ${i+1}`, description: ''}));
					return { id: s.id, name: s.name, description: s.description, tests, server: true };
				});
				testSuites = serverSuites;
				// If there's a last run, show those results
				if (data.status === 'done' && data.tests) {
					lastServerRun = data;
				}
				if (testSuites.length > 0 && !selectedSuite) selectedSuite = testSuites[0].id;
			}
		} catch {}
	}

	let lastServerRun = null;

	// Route test API calls: on dev hit directly, on prod proxy through production server (avoids CORS)
	function devFetch(path, opts) {
		if (isDev) return fetch(path, opts);
		return fetch('/api/v1/dev/proxy/' + path.replace(/^\//, ''), opts);
	}

	async function runAllTests() {
		testsRunning = true;
		testResults = [];
		if (!isDev) {
			try {
				const devCheck = await fetch('/api/v1/dev/start', { method: 'POST' });
				const devData = await devCheck.json();
				if (!devData.ok) {
					testResults = [{ id: 'dev-error', name: 'Dev Server', status: 'fail', detail: 'Dev server not running. Start with: node dev-server.js', description: '' }];
					testsRunning = false;
					return;
				}
				await fetch('/api/v1/ui-commands', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ type: 'open_window', url: `http://localhost:${devData.port}/v2/terminal` })
				});
			} catch {
				testResults = [{ id: 'dev-error', name: 'Dev Server', status: 'fail', detail: 'Could not reach dev server', description: '' }];
				testsRunning = false;
				return;
			}
		}
		try {
			await devFetch('/api/v1/tests/run', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ suite: 'all' })
			});
		} catch {}
		let done = false;
		for (let i = 0; i < 120 && !done; i++) {
			await new Promise(r => setTimeout(r, 1000));
			try {
				const resp = await devFetch('/api/v1/tests');
				if (resp.ok) {
					const data = await resp.json();
					const allTests = data.tests || [];
					if (allTests.length > 0) {
						testResults = allTests.map(t => ({
							id: t.id, name: t.name, description: t.description,
							status: t.status === 'passed' ? 'pass' : t.status === 'failed' ? 'fail' : t.status,
							detail: t.result || t.error || ''
						}));
					}
					if (data.status === 'done') done = true;
				}
			} catch {}
		}
		testsRunning = false;
	}

	async function runSuite() {
		const suite = testSuites.find(s => s.id === selectedSuite);
		if (!suite) return;
		testsRunning = true;

		if (suite.server) {
			// Always run tests on dev server, never production
			if (!isDev) {
				try {
					const devCheck = await fetch('/api/v1/dev/start', { method: 'POST' });
					const devData = await devCheck.json();
					if (!devData.ok) {
						testResults = [{ id: 'dev-error', name: 'Dev Server', status: 'fail', detail: 'Dev server not running. Start with: node dev-server.js', description: '' }];
						testsRunning = false;
						return;
					}
					await fetch('/api/v1/ui-commands', {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({ type: 'open_window', url: `http://localhost:${devData.port}/v2/terminal` })
					});
				} catch {
					testResults = [{ id: 'dev-error', name: 'Dev Server', status: 'fail', detail: 'Could not reach dev server', description: '' }];
					testsRunning = false;
					return;
				}
			}

			// Server-side suite — trigger via API and poll for results (uses proxy to avoid CORS)
			testResults = suite.tests.map(t => ({ ...t, status: 'pending', detail: '' }));
			try {
				await devFetch('/api/v1/tests/run', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ suite: suite.id })
				});
			} catch {}
			let done = false;
			for (let i = 0; i < 120 && !done; i++) {
				await new Promise(r => setTimeout(r, 1000));
				try {
					const resp = await devFetch('/api/v1/tests');
					if (resp.ok) {
						const data = await resp.json();
						const suiteTests = (data.tests || []).filter(t => t.suiteId === suite.id);
						if (suiteTests.length > 0) {
							testResults = suiteTests.map(t => ({
								id: t.id, name: t.name, description: t.description,
								status: t.status === 'passed' ? 'pass' : t.status === 'failed' ? 'fail' : t.status,
								detail: t.result || t.error || ''
							}));
						}
						if (data.status === 'done') done = true;
						const ss = data.suiteStatus?.[suite.id];
						if (ss && (ss.status === 'passed' || ss.status === 'failed' || ss.status === 'skipped')) done = true;
					}
				} catch {}
			}
			testsRunning = false;
			return;
		}

		// Client-side suite — run in browser
		testResults = suite.tests.map(t => ({ ...t, status: 'pending', detail: '' }));
		for (let i = 0; i < testResults.length; i++) {
			testResults[i].status = 'running';
			testResults = [...testResults];
			try {
				const detail = await executeTest(suite.id, testResults[i].id);
				testResults[i].status = 'pass';
				testResults[i].detail = detail || 'OK';
			} catch (err) {
				testResults[i].status = 'fail';
				testResults[i].detail = err.message || String(err);
			}
			testResults = [...testResults];
			await new Promise(r => setTimeout(r, 300));
		}
		testsRunning = false;
	}

	async function executeTest(suiteId, testId) {
		if (suiteId === 'page-refresh') return executePageRefreshTest(testId);
		if (suiteId === 'terminal-protocol') return executeProtocolTest(testId);
		if (suiteId === 'widgets') return executeWidgetTest(testId);
		if (suiteId === 'input-box') return executeInputBoxTest(testId);
		throw new Error('Unknown suite');
	}

	let testWs = null;
	let testSessionId = 'test-suite-' + Date.now();

	async function executePageRefreshTest(testId) {
		switch (testId) {
			case 'pr-1': {
				testSessionId = 'test-suite-' + Date.now();
				return new Promise((resolve, reject) => {
					testWs = new WebSocket(wsUrl(`/ws/terminal?session=${testSessionId}&project=Test&cwd=/tmp&cols=80&rows=24`));
					const timer = setTimeout(() => { reject(new Error('Timeout')); }, 5000);
					testWs.onopen = () => { clearTimeout(timer); resolve('Session opened: ' + testSessionId); };
					testWs.onerror = () => { clearTimeout(timer); reject(new Error('WebSocket failed')); };
				});
			}
			case 'pr-2': {
				if (!testWs || testWs.readyState !== 1) throw new Error('No WebSocket');
				testWs.send(JSON.stringify({ type: 'input', data: 'echo PAN_TEST_MARKER\n' }));
				await new Promise(r => setTimeout(r, 1000));
				return 'Sent test marker';
			}
			case 'pr-3': {
				if (testWs) testWs.close();
				testWs = null;
				await new Promise(r => setTimeout(r, 500));
				return 'WebSocket closed (simulated F5)';
			}
			case 'pr-4': {
				const resp = await fetch('/api/v1/terminal/sessions');
				const sessions = await resp.json();
				const found = sessions.find(s => s.id === testSessionId);
				if (!found) throw new Error('Session not found after disconnect');
				return 'Session alive on server';
			}
			case 'pr-5': {
				return new Promise((resolve, reject) => {
					testWs = new WebSocket(wsUrl(`/ws/terminal?session=${testSessionId}&project=Test&cwd=/tmp&cols=80&rows=24`));
					const timer = setTimeout(() => { reject(new Error('Reconnect timeout')); }, 5000);
					let gotData = false;
					testWs.onmessage = (e) => {
						if (!gotData) { gotData = true; clearTimeout(timer); resolve('Reconnected, receiving data'); }
					};
					testWs.onerror = () => { clearTimeout(timer); reject(new Error('Reconnect failed')); };
				});
			}
			case 'pr-6': {
				return new Promise((resolve, reject) => {
					let found = false;
					const timer = setTimeout(() => { if (!found) reject(new Error('Marker not in buffer')); }, 3000);
					const handler = (e) => {
						try {
							const msg = JSON.parse(e.data);
							if (msg.data?.includes('PAN_TEST_MARKER')) { found = true; clearTimeout(timer); resolve('Buffer contains test marker'); }
						} catch {}
					};
					if (testWs) testWs.addEventListener('message', handler);
					// Also check what we already received
					setTimeout(() => { if (!found) { clearTimeout(timer); resolve('Buffer replayed (marker may be in initial burst)'); } }, 2000);
				});
			}
			case 'pr-7': {
				if (testWs) testWs.close();
				testWs = null;
				// Delete session
				try { await fetch(`/api/v1/terminal/sessions/${testSessionId}`, { method: 'DELETE' }); } catch {}
				return 'Cleaned up';
			}
			default: throw new Error('Unknown test');
		}
	}

	async function executeProtocolTest(testId) {
		switch (testId) {
			case 'tp-1': {
				return new Promise((resolve, reject) => {
					const ws = new WebSocket(wsUrl('/ws/terminal?session=test-proto-' + Date.now() + '&project=Test&cwd=/tmp&cols=80&rows=24'));
					const timer = setTimeout(() => { ws.close(); reject(new Error('Timeout')); }, 5000);
					ws.onopen = () => { clearTimeout(timer); testWs = ws; resolve('Connected'); };
					ws.onerror = () => { clearTimeout(timer); reject(new Error('Failed')); };
				});
			}
			case 'tp-2': {
				if (!testWs) throw new Error('No connection');
				return new Promise((resolve, reject) => {
					const timer = setTimeout(() => reject(new Error('No echo')), 3000);
					testWs.onmessage = () => { clearTimeout(timer); resolve('Echo received'); };
					testWs.send(JSON.stringify({ type: 'input', data: 'echo ok\n' }));
				});
			}
			case 'tp-3': {
				if (!testWs) throw new Error('No connection');
				testWs.send(JSON.stringify({ type: 'resize', cols: 120, rows: 40 }));
				await new Promise(r => setTimeout(r, 500));
				return 'Resize sent, no error';
			}
			case 'tp-4': {
				if (!testWs) throw new Error('No connection');
				return new Promise((resolve, reject) => {
					const timer = setTimeout(() => reject(new Error('No pong')), 3000);
					testWs.onmessage = (e) => { try { if (JSON.parse(e.data).type === 'pong') { clearTimeout(timer); resolve('Pong received'); } } catch {} };
					testWs.send(JSON.stringify({ type: 'ping' }));
				});
			}
			case 'tp-5': {
				if (testWs) testWs.close();
				testWs = null;
				return 'Cleanup done';
			}
			default: throw new Error('Unknown test');
		}
	}

	async function executeWidgetTest(testId) {
		const endpoints = {
			'wd-1': ['/dashboard/api/services', 'services'],
			'wd-2': ['/dashboard/api/projects', 'projects'],
			'wd-3': [`/dashboard/api/projects/${getActiveTab()?.projectId || 791}/tasks`, 'tasks'],
			'wd-4': ['/dashboard/api/stats', 'stats'],
			'wd-5': ['/health', 'health'],
		};
		const [url, label] = endpoints[testId] || [];
		if (!url) throw new Error('Unknown test');
		const resp = await fetch(url);
		if (!resp.ok) throw new Error(`${label} returned ${resp.status}`);
		const data = await resp.json();
		if (Array.isArray(data)) return `${data.length} ${label}`;
		return `${label}: OK`;
	}

	async function executeInputBoxTest(testId) {
		switch (testId) {
			case 'ib-1': {
				const active = getActiveTab();
				if (!active?.ws || active.ws.readyState !== 1) throw new Error('No active terminal');
				return 'WebSocket connected, ready to receive input';
			}
			case 'ib-2': {
				const active = getActiveTab();
				if (!active?.ws || active.ws.readyState !== 1) throw new Error('No active terminal');
				active.ws.send(JSON.stringify({ type: 'input', data: '\n' }));
				return 'Newline sent';
			}
			case 'ib-3': {
				const resp = await fetch('/api/v1/clipboard-image', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', mimeType: 'image/png' })
				});
				if (!resp.ok) throw new Error(`Upload returned ${resp.status}`);
				return 'Image upload OK';
			}
			default: throw new Error('Unknown test');
		}
	}

	function filterByMilestone(milestoneId) {
		rightMilestoneFilter = rightMilestoneFilter === milestoneId ? null : milestoneId;
		rightSection = 'tasks';
	}

	// ==================== Derived data ====================

	function getFilteredTasks() {
		if (!tasksData?.tasks) return { byMilestone: {}, noMilestone: [], milestones: [] };
		const byMilestone = {};
		const noMilestone = [];
		for (const t of tasksData.tasks) {
			if (rightMilestoneFilter && t.milestone_id !== rightMilestoneFilter && t.milestone_id !== null) continue;
			if (rightMilestoneFilter && t.milestone_id === null) continue;
			if (t.milestone_id) {
				if (!byMilestone[t.milestone_id]) byMilestone[t.milestone_id] = [];
				byMilestone[t.milestone_id].push(t);
			} else {
				noMilestone.push(t);
			}
		}
		return { byMilestone, noMilestone, milestones: tasksData.milestones || [] };
	}

	function getBugs() {
		if (!tasksData?.tasks) return [];
		const bugKeywords = /bug|fix|issue|error|broken|crash|fail/i;
		return tasksData.tasks.filter(t => t.priority > 0 || bugKeywords.test(t.title));
	}

	function getSectionById(id) {
		return sectionsData.find(s => s.id === id);
	}

	// ==================== Init ====================

	onMount(() => {
		// Check URL params — apps open in new windows with ?view=atlas etc.
		const urlParams = new URLSearchParams(window.location.search);
		const viewParam = urlParams.get('view');
		if (viewParam === 'atlas') {
			switchCenterView('atlas');
		}

		restoreChatFromStorage(); // Instantly restore chat from before refresh
		loadTerminalProjects();
		loadVoiceSettings();
		loadTestSuites();

		// Load services and approvals immediately
		api('/dashboard/api/services').then(r => { servicesData = r?.services || []; }).catch(() => {});
		loadApprovals();

		// Start chat refresh
		chatRefreshInterval = setInterval(() => {
			if (leftSection === 'transcript') loadChatHistory();
		}, 10000);

		// Refresh services every 30s, approvals every 5s
		const svcInterval = setInterval(() => {
			api('/dashboard/api/services').then(r => { servicesData = r?.services || []; }).catch(() => {});
		}, 30000);
		const approvalInterval = setInterval(loadApprovals, 5000);

		// Poll live PTY status for the active tab every 1.5s. The server now
		// returns a real `thinking` flag derived from input-vs-output recency,
		// plus pid/uptime/lastInput/lastOutput so we can show what the PTY is
		// actually doing instead of guessing from local state.
		const ptyStatusInterval = setInterval(async () => {
			try {
				const tab = getActiveTab();
				if (!tab?.sessionId) { ptyStatus = null; return; }
				const r = await api('/api/v1/terminal/sessions');
				const list = r?.sessions || [];
				const match = list.find(s => s.id === tab.sessionId);
				ptyStatus = match || null;
				// Sync the legacy claudeReady flag from authoritative state so the
				// rest of the UI stops lying after refreshes / tab switches.
				if (match) {
					const realReady = !match.thinking;
					if (claudeReady !== realReady) claudeReady = realReady;
					if (tab.claudeReady !== realReady) tab.claudeReady = realReady;
				}
			} catch {}
		}, 1500);
		// 1s ticker so the "Xs ago" labels in the status bar update smoothly
		const ptyTicker = setInterval(() => { ptyStatusNow = Date.now(); }, 1000);

		// Poll for UI commands (window opens, etc.) — this runs in the renderer,
		// so window.open creates real Electron windows from the interactive session
		const uiCmdInterval = setInterval(async () => {
			try {
				const cmds = await api('/api/v1/ui-commands');
				if (!Array.isArray(cmds)) return;
				for (const cmd of cmds) {
					if (cmd.type === 'open_window' && cmd.url) {
						window.open(cmd.url, '_blank');
					}
				}
			} catch {}
		}, 2000);

		// Auto-connect: wait for projects to load, then start terminal
		setTimeout(async () => {
			// Make sure projects are loaded
			await loadTerminalProjects();
			if (projects.length === 0) {
				// Retry once after delay
				await new Promise(r => setTimeout(r, 1000));
				await loadTerminalProjects();
			}

			let reconnected = false;

			// Strategy 1: Check server for live PTY sessions — match with DB-saved tab names
			try {
				const [sessData, dbTabs] = await Promise.all([
					api('/api/v1/terminal/sessions').catch(() => ({ sessions: [] })),
					getDbSessionState()
				]);
				const sessions = sessData.sessions || [];
				const dbTabMap = new Map(dbTabs.map(t => [t.sessionId, t]));

				// Set tabNameCounter from DB tabs to avoid collisions
				for (const dt of dbTabs) {
					const match = dt.tabName?.match(/^PAN (\d+)$/);
					if (match) tabNameCounter = Math.max(tabNameCounter, parseInt(match[1]));
				}

				if (sessions.length > 0 && dbTabs.length > 0) {
					// Only reconnect to sessions that have a matching DB tab record
					// Kill orphan PTY sessions that aren't in the DB
					const dbSessionIds = new Set(dbTabs.map(t => t.sessionId));
					const liveSessions = sessions.filter(s =>
						(s.id.startsWith(sessionPrefix) || s.id.startsWith('mob-')) && dbSessionIds.has(s.id)
					);
					// Kill orphans — sessions with no DB tab AND no live clients.
					// A session with clients > 0 is being held by another window/tab
					// (or by a tab whose DB write just hasn't landed yet) — killing
					// it yanks the PTY out from under an active user. Only kill
					// sessions that nobody is currently watching.
					for (const s of sessions) {
						if ((s.id.startsWith(sessionPrefix) || s.id.startsWith('mob-')) && !dbSessionIds.has(s.id) && (s.clients || 0) === 0) {
							fetch(`/api/v1/terminal/sessions/${encodeURIComponent(s.id)}`, { method: 'DELETE' }).catch(() => {});
						}
					}
					// Sort by DB tab index
					liveSessions.sort((a, b) => {
						const aTab = dbTabMap.get(a.id);
						const bTab = dbTabMap.get(b.id);
						if (aTab && bTab) return (aTab.tabIndex || 0) - (bTab.tabIndex || 0);
						return (a.createdAt || 0) - (b.createdAt || 0);
					});
					for (const s of liveSessions) {
						const matchedProject = projects.find(p => p.name === s.project);
						const pid = matchedProject ? matchedProject.id : null;
						const savedTab = dbTabMap.get(s.id);
						await createTab(s.id, s.project || 'Shell', s.cwd || 'C:\\Users\\tzuri\\Desktop', pid, true, savedTab?.tabName || null, savedTab?.claudeSessionIds);
						reconnected = true;
					}
				}

				// If no live sessions, try restoring from DB-saved tabs (creates new PTY sessions)
				if (!reconnected && dbTabs.length > 0) {
					for (const dt of dbTabs) {
						const matchedProject = projects.find(p => p.name === dt.project);
						const pid = matchedProject ? matchedProject.id : dt.projectId;
						await createTab(dt.sessionId, dt.project || 'Shell', dt.cwd || 'C:\\Users\\tzuri\\Desktop', pid, false, dt.tabName || null, dt.claudeSessionIds);
						reconnected = true;
					}
				}
			} catch (e) {
				console.error('[Terminal] Session reconnect failed:', e);
			}

			// Strategy 2: Fall back to localStorage if DB failed
			if (!reconnected) {
				const savedSessions = getSavedSessionState();
				for (const s of savedSessions) {
					if (!s.sessionId) continue;
					await createTab(s.sessionId, s.project || 'Shell', s.cwd || 'C:\\Users\\tzuri\\Desktop', s.projectId, false, s.tabName || null, s.claudeSessionIds);
					reconnected = true;
				}
				saveSessionState();
			}

			if (!reconnected && projects.length > 0) {
				// Auto-start with shared project or PAN
				const sharedProject = getActiveProject();
				const target = sharedProject
					? projects.find(p => p.id === sharedProject.id)
					: projects.find(p => p.name === 'PAN') || projects[0];
				if (target) {
					setActiveProject(target);
					await switchTerminalProject(target);
				}
			}

			// Save session state periodically
			setInterval(saveSessionState, 5000);
		}, 300);

		// Save state on page unload (backup — Svelte cleanup may not fire on full refresh)
		const handleBeforeUnload = () => {
			saveSessionState();
			saveChatToStorage();
		};
		window.addEventListener('beforeunload', handleBeforeUnload);

		// Resize handler — ResizeObserver on terminal container (fires on drag, maximize, minimize)
		let resizeDebounce = null;
		let termResizeObserver = null;
		const handleResize = () => {
			if (resizeDebounce) clearTimeout(resizeDebounce);
			resizeDebounce = setTimeout(() => {
				if (!termContainerEl) return;
				const charWidth = 8.4;
				const cw = termContainerEl.clientWidth - 24;
				const ch = termContainerEl.clientHeight;
				const newCols = Math.max(80, Math.floor(cw / charWidth));
				const newRows = Math.max(20, Math.floor(ch / 21));
				for (const tab of tabs) {
					if (tab.ws && tab.ws.readyState === 1) {
						tab.ws.send(JSON.stringify({ type: 'resize', cols: newCols, rows: newRows }));
					}
				}
			}, 200);
		};
		if (termContainerEl) {
			termResizeObserver = new ResizeObserver(handleResize);
			termResizeObserver.observe(termContainerEl);
		}
		// Fallback for window-level resize (maximize/minimize when observer may miss)
		window.addEventListener('resize', handleResize);

		// Global key handler — Escape and number keys reach the terminal even without textarea focus
		function handleGlobalKeydown(e) {
			// Let Win+H pass through to Windows for voice typing
			if (e.key === 'h' && e.metaKey) return;
			// Skip if user is typing in a non-terminal input (e.g. rename, search)
			const tag = e.target?.tagName;
			if ((tag === 'INPUT' || tag === 'TEXTAREA') && e.target !== terminalInputEl) return;

			const active = getActiveTab();
			if (!active?.ws || active.ws.readyState !== 1) return;

			if (e.key === 'Escape') {
				e.preventDefault();
				active.ws.send(JSON.stringify({ type: 'input', data: '\x03' }));
				return;
			}
			// Number keys 1-3 when input is empty AND there's a pending approval
			if (/^[1-3]$/.test(e.key) && !terminalInputEl?.value?.trim() && approvalsData.length > 0) {
				e.preventDefault();
				const n = parseInt(e.key);
				let seq = '\x1b[A\x1b[A\x1b[A';
				for (let i = 1; i < n; i++) seq += '\x1b[B';
				seq += '\r';
				active.ws.send(JSON.stringify({ type: 'input', data: seq }));
				return;
			}
		}
		window.addEventListener('keydown', handleGlobalKeydown);

		return () => {
			saveSessionState(); // Persist session IDs before page unloads
			saveChatToStorage(); // Persist chat before page unloads
			window.removeEventListener('keydown', handleGlobalKeydown);
			window.removeEventListener('resize', handleResize);
			if (termResizeObserver) termResizeObserver.disconnect();
			window.removeEventListener('beforeunload', handleBeforeUnload);
			if (chatRefreshInterval) clearInterval(chatRefreshInterval);
			clearInterval(svcInterval);
			clearInterval(approvalInterval);
			clearInterval(ptyStatusInterval);
			clearInterval(ptyTicker);
			clearInterval(uiCmdInterval);
			for (const tab of tabs) {
				tab._closing = true;
				if (tab._reconnectTimer) { try { clearTimeout(tab._reconnectTimer); } catch {} tab._reconnectTimer = null; }
				if (tab._pingTimer) { try { clearInterval(tab._pingTimer); } catch {} tab._pingTimer = null; }
				if (tab.ws) tab.ws.close();
			}
		};
	});
</script>

<!-- TOOLBAR -->
<div class="toolbar">
	<select class="project-select" onchange={(e) => {
		const val = e.target.value;
		if (val === '__shell__') {
			createTab('dash-shell-' + Date.now(), 'Shell', 'C:\\Users\\tzuri\\Desktop', null, false);
		} else {
			const proj = projects.find(p => String(p.id) === val || p.path === val);
			if (proj) switchTerminalProject(proj);
		}
	}}>
		<option value="">Select Project...</option>
		{#each projects as p}
			<option value={p.id || p.path} data-name={p.name}>{p.name}</option>
		{/each}
		<option value="__shell__">Shell</option>
	</select>
	{#if allProjectTabs.length > 0}
		<select class="tab-history-select" onchange={(e) => {
			const val = e.target.value;
			if (!val) return;
			e.target.value = '';
			const dbTab = allProjectTabs.find(t => String(t.id) === val);
			if (!dbTab) return;
			if (dbTab.closed_at) {
				reopenTab(dbTab);
			} else {
				const openTab = tabs.find(t => t.sessionId === dbTab.session_id);
				if (openTab) switchToTab(openTab.id);
			}
		}}>
			<option value="">Threads...</option>
			{#each allProjectTabs as pt}
				<option value={pt.id}>{pt.closed_at ? '\u{1F4CB} ' : '\u25CF '}{pt.tab_name || 'Unnamed'}</option>
			{/each}
		</select>
	{/if}
	<span class="host-label">{hostLabel}</span>
	<div style="flex:1"></div>
	<span class="sessions-count">
		{#if sessionsCount > 0}{sessionsCount} tab{sessionsCount > 1 ? 's' : ''}{/if}
	</span>
</div>

<!-- TAB BAR -->
{#if tabs.length > 0}
	<div class="tab-bar">
		{#each tabs as tab (tab.id)}
			<button
				class="term-tab"
				class:active={activeTabId === tab.id}
				onclick={() => switchToTab(tab.id)}
				ondblclick={(e) => { e.preventDefault(); startRenameTab(tab.id); }}
			>
				{#if renamingTabId === tab.id}
					<!-- svelte-ignore a11y_autofocus -->
					<input
						class="tab-rename-input"
						type="text"
						bind:value={renameValue}
						autofocus
						onclick={(e) => e.stopPropagation()}
						onblur={finishRenameTab}
						onkeydown={(e) => { if (e.key === 'Enter') finishRenameTab(); if (e.key === 'Escape') cancelRenameTab(); }}
					/>
				{:else}
					<span class="tab-label">{tab.tabName || tab.project || 'Shell'}</span>
					{#if tab.tabName && tab.tabName !== tab.project}<span class="tab-project-hint">{tab.project || ''}</span>{/if}
				{/if}
				<span
					class="tab-close"
					onclick={(e) => { e.stopPropagation(); closeTab(tab.id); }}
				>&times;</span>
			</button>
		{/each}
		<button class="add-tab" onclick={newTerminalTab} title="New Tab">+</button>
	</div>
{/if}

<!-- MAIN LAYOUT -->
<div class="terminal-layout">
	<!-- LEFT PANEL -->
	<div class="left-panel" class:resizing={resizingPanel !== null} style="width: {leftPanelWidth}px">
		<div class="right-header">
			<select class="right-select" bind:value={leftSection} onchange={() => { if (leftSection === 'usage') loadUsageData(); if (leftSection === 'tests') loadTestSuites(); if (leftSection === 'perf') startPerfPolling(); else stopPerfPolling(); }}>
				<option value="approvals">Approvals{approvalsData.length > 0 ? ` (${approvalsData.length})` : ''}</option>
				<option value="apps">Apps</option>
				<option value="bugs">Bugs</option>
				<option value="devices">Devices</option>
				<option value="instances">Instances</option>
				<option value="perf">Performance</option>
				<option value="project">Project</option>
				<option value="services">Services</option>
				<option value="setup">Setup Guide</option>
				<option value="tasks">Tasks</option>
				<option value="tests">Tests</option>
				<option value="transcript">Transcript</option>
				<option value="usage">Usage</option>
				<option value="users">Users</option>
				{#each sectionsData as s}
					<option value="custom-{s.id}">{s.name}</option>
				{/each}
			</select>
		</div>
		<div class="left-content" bind:this={chatSidebarEl}>
			{#if leftSection === 'transcript'}
				{#if chatBubbles.length === 0}
					<div class="empty-state">No conversation yet</div>
				{:else}
					<div class="chat-container">
						{#each chatBubbles as bubble}
							{#if bubble.type === 'user'}
								<div class="chat-turn">
									<div class="chat-speaker chat-speaker-user">{bubble.speaker || 'You'}</div>
									<div class="chat-bubble user">
										{#if bubble.multiSession}
											<span class="session-dot" style="background:{bubble.accentColor}"></span>
										{/if}
										{bubble.text}
									</div>
								</div>
							{:else if bubble.type === 'assistant'}
								<div class="chat-turn">
									<div class="chat-speaker chat-speaker-assistant">
										{bubble.speaker || 'Claude'}
										{#if bubble.model}<span class="chat-model">{bubble.model}</span>{/if}
									</div>
									<div class="chat-bubble assistant" style={bubble.multiSession ? `border-left:2px solid ${bubble.accentColor}` : ''}>
										{bubble.text}
									</div>
								</div>
							{:else if bubble.type === 'tool'}
								<div class="chat-bubble tool">{bubble.text}</div>
							{/if}
						{/each}
					</div>
				{/if}
			{:else if leftSection === 'project'}
				{#if projectData}
					<div class="project-info">
						<div class="project-name">{projectData.name}</div>
						<div class="project-progress-row">
							<span class="project-pct">{projectData.percentage}%</span>
							<span class="project-count">{projectData.done_tasks}/{projectData.total_tasks}</span>
						</div>
						<div class="progress-bar">
							<div class="progress-fill {pctColor(projectData.percentage)}" style="width:{projectData.percentage}%"></div>
						</div>
						<div class="project-sessions">{projectData.session_count} sessions</div>
					</div>
					{#if projectData.milestones}
						{#each projectData.milestones as m}
							<div class="milestone" onclick={() => filterByMilestone(m.id)}>
								<div class="milestone-row">
									<span class="milestone-name">{m.name}</span>
									<span class="milestone-pct">{m.percentage}%</span>
								</div>
								<div class="progress-bar small">
									<div class="progress-fill {pctColor(m.percentage)}" style="width:{m.percentage}%"></div>
								</div>
							</div>
						{/each}
					{/if}
				{:else}
					<div class="empty-state">Select a project</div>
				{/if}
			{:else if leftSection === 'approvals'}
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
			{:else if leftSection === 'devices'}
				{@const deviceServices = servicesData.filter(s => s.category === 'Devices')}
				{#if deviceServices.length === 0}
					<div class="empty-state">No devices connected</div>
				{:else}
					{#each deviceServices as svc}
						<div class="svc-row">
							<span class="svc-dot" class:up={svc.status === 'up'} class:down={svc.status === 'down'} class:unknown={svc.status === 'unknown'}></span>
							<div class="svc-info">
								<div class="svc-name">{svc.name}</div>
								<div class="svc-detail">{svc.detail}</div>
							</div>
						</div>
					{/each}
				{/if}
			{:else if leftSection === 'services'}
				{@const coreServices = servicesData.filter(s => s.category === 'PAN Core')}
				{@const deviceServices2 = servicesData.filter(s => s.category === 'Devices')}
				{#if coreServices.length > 0}
					<div class="svc-category">PAN Core</div>
					{#each coreServices as svc}
						<div class="svc-row">
							<span class="svc-dot" class:up={svc.status === 'up'} class:down={svc.status === 'down' || svc.status === 'offline'} class:unknown={svc.status === 'unknown'}></span>
							<div class="svc-info">
								<div class="svc-name">{svc.name}</div>
								<div class="svc-detail">{svc.detail}</div>
							</div>
						</div>
					{/each}
				{/if}
				{#if deviceServices2.length > 0}
					<div class="svc-category">Devices</div>
					{#each deviceServices2 as svc}
						<div class="svc-row">
							<span class="svc-dot" class:up={svc.status === 'up'} class:down={svc.status === 'down'} class:unknown={svc.status === 'unknown'}></span>
							<div class="svc-info">
								<div class="svc-name">{svc.name}</div>
								<div class="svc-detail">{svc.detail}</div>
							</div>
						</div>
					{/each}
				{/if}
				{#if servicesData.length === 0}
					<div class="empty-state">Loading services...</div>
				{/if}
			{:else if leftSection === 'tasks'}
				{@const taskData2 = getFilteredTasks()}
				{#each taskData2.milestones as m}
					{#if taskData2.byMilestone[m.id]?.length > 0}
						<div class="task-group-header">{m.name}</div>
						{#each taskData2.byMilestone[m.id] as t}
							<div class="task-row" onclick={() => cycleTask(t.id, t.status)}>
								<span class="task-icon" class:done={t.status === 'done'} class:in-progress={t.status === 'in_progress'}>
									{t.status === 'done' ? '\u2713' : t.status === 'in_progress' ? '\u25C6' : '\u25CB'}
								</span>
								<span class="task-title" class:done={t.status === 'done'}>{t.title}</span>
							</div>
						{/each}
					{/if}
				{/each}
				{#if taskData2.noMilestone.length > 0}
					<div class="task-group-header">Other</div>
					{#each taskData2.noMilestone as t}
						<div class="task-row" onclick={() => cycleTask(t.id, t.status)}>
							<span class="task-icon" class:done={t.status === 'done'} class:in-progress={t.status === 'in_progress'}>
								{t.status === 'done' ? '\u2713' : t.status === 'in_progress' ? '\u25C6' : '\u25CB'}
							</span>
							<span class="task-title" class:done={t.status === 'done'}>{t.title}</span>
						</div>
					{/each}
				{/if}
			{:else if leftSection === 'bugs'}
				{@const bugs2 = getBugs()}
				{#if bugs2.length === 0}
					<div class="empty-state">No bugs tracked</div>
				{:else}
					{#each bugs2 as t}
						<div class="task-row" onclick={() => cycleTask(t.id, t.status)}>
							<span class="task-icon bug" class:done={t.status === 'done'}>
								{t.status === 'done' ? '\u2713' : '\u26A0'}
							</span>
							<span class="task-title" class:done={t.status === 'done'}>{t.title}</span>
						</div>
					{/each}
				{/if}
			{:else if leftSection === 'perf'}
				<div class="perf-widget">
					<div class="perf-section-title">Terminal Stream</div>
					<div class="perf-metric">
						<span class="perf-label">WS Latency</span>
						<span class="perf-value" class:perf-warn={perfData.wsLatency > 50} class:perf-bad={perfData.wsLatency > 200}>{perfData.wsLatency}ms</span>
					</div>
					<div class="perf-metric">
						<span class="perf-label">DOM Update</span>
						<span class="perf-value" class:perf-warn={perfData.domTime > 5} class:perf-bad={perfData.domTime > 16}>{perfData.domTime}ms</span>
					</div>
					<div class="perf-metric">
						<span class="perf-label">Server Render</span>
						<span class="perf-value" class:perf-warn={perfData.serverRender > 5} class:perf-bad={perfData.serverRender > 15}>{perfData.serverRender}ms</span>
					</div>
					<div class="perf-metric">
						<span class="perf-label">Msg Size</span>
						<span class="perf-value">{(perfData.msgSize / 1024).toFixed(1)} KB</span>
					</div>
					<div class="perf-metric">
						<span class="perf-label">FPS / Lines</span>
						<span class="perf-value">{perfData.fps} / {perfData.linesChanged}</span>
					</div>

					<div class="perf-section-title" style="margin-top:12px">PAN Services</div>
					{#if perfServices.length === 0}
						<div class="perf-metric"><span class="perf-label" style="opacity:0.5">Scanning...</span></div>
					{:else}
						{#each perfServices as svc}
							<div class="perf-proc" class:perf-zombie={svc.status === 'down' || svc.status === 'error'}>
								<div class="perf-proc-header">
									<span class="perf-proc-name vital">{svc.name}</span>
									{#if svc.inProcess}
										<span class="perf-proc-tag" title="Runs inside the PAN server process">in-proc</span>
									{:else if svc.pid}
										<button class="perf-kill-btn" onclick={() => killProcess(svc.pid)} title="Kill {svc.name} (pid {svc.pid})">Kill</button>
									{:else}
										<span class="perf-proc-tag perf-bad" title="No matching OS process found">offline</span>
									{/if}
								</div>
								<div class="perf-proc-stats">
									{#if svc.pid}
										<span>CPU: {svc.cpuSec > 3600 ? (svc.cpuSec/3600).toFixed(1)+'h' : svc.cpuSec > 60 ? (svc.cpuSec/60).toFixed(1)+'m' : svc.cpuSec+'s'}</span>
										<span>{svc.memMB}MB</span>
										<span>{svc.uptimeHrs > 24 ? (svc.uptimeHrs/24).toFixed(1)+'d' : svc.uptimeHrs+'h'}</span>
									{:else if svc.inProcess}
										<span style="opacity:0.6">{svc.modelTierLabel || 'in-process job'}</span>
									{:else}
										<span class="perf-bad">not running</span>
									{/if}
								</div>
								{#if svc.lastError}
									<div class="perf-proc-stats perf-bad" style="font-size:9px;margin-top:2px">{String(svc.lastError).slice(0,80)}</div>
								{/if}
							</div>
						{/each}
					{/if}

					{#if perfOther.length > 0}
						<div class="perf-section-title" style="margin-top:12px">Other (>10% CPU)</div>
						{#each perfOther.slice(0, 5) as p}
							<div class="perf-proc">
								<div class="perf-proc-header">
									<span class="perf-proc-name" style="opacity:0.7">{p.exe}</span>
									<button class="perf-kill-btn" onclick={() => killProcess(p.pid)} title="Kill pid {p.pid}">Kill</button>
								</div>
								<div class="perf-proc-stats">
									<span>CPU: {p.cpuSec > 3600 ? (p.cpuSec/3600).toFixed(1)+'h' : p.cpuSec > 60 ? (p.cpuSec/60).toFixed(1)+'m' : p.cpuSec+'s'}</span>
									<span>{p.memMB}MB</span>
									<span>{p.uptimeHrs > 24 ? (p.uptimeHrs/24).toFixed(1)+'d' : p.uptimeHrs+'h'}</span>
								</div>
							</div>
						{/each}
					{/if}

					{#if perfServices.filter(s => s.status === 'down' || s.status === 'error').length > 0}
						<div class="perf-metric perf-status" style="margin-top:8px">
							<span class="perf-bad">{perfServices.filter(s => s.status === 'down' || s.status === 'error').length} SERVICE{perfServices.filter(s => s.status === 'down' || s.status === 'error').length > 1 ? 'S' : ''} DOWN</span>
						</div>
					{:else if perfData.wsLatency > 200 || perfData.domTime > 16}
						<div class="perf-metric perf-status" style="margin-top:8px">
							<span class="perf-bad">STREAM BOTTLENECK</span>
						</div>
					{:else if perfData.wsLatency > 50 || perfData.domTime > 5}
						<div class="perf-metric perf-status" style="margin-top:8px">
							<span class="perf-warn">Moderate latency</span>
						</div>
					{:else}
						<div class="perf-metric perf-status" style="margin-top:8px">
							<span class="perf-good">Running smooth</span>
						</div>
					{/if}
				</div>
			{:else if leftSection === 'usage'}
				<div class="empty-state">Select Usage from the right panel</div>
			{:else if leftSection === 'setup'}
				<div class="setup-guide">
					<div class="setup-title">How to Use PAN</div>
					<div class="setup-desc">Use the terminal to do what you want -- speak or type.</div>
					<div class="setup-items">
						<div><strong>Create a Project:</strong> "Create a new project called my-app"</div>
						<div><strong>Add a Task:</strong> "Add a task to set up the database"</div>
						<div><strong>Change Settings:</strong> "Change the AI model to gpt-4o"</div>
						<div><strong>Ask Anything:</strong> Just say it or type it</div>
					</div>
				</div>
			{:else if leftSection === 'apps'}
				<div class="apps-grid">
					<button class="app-card" onclick={() => {
							const url = `${window.location.origin}/v2/atlas`;
							const win = window.open(url, '_blank', 'width=1400,height=900');
							if (!win) {
								fetch('/api/v1/ui-commands', {
									method: 'POST',
									headers: { 'Content-Type': 'application/json' },
									body: JSON.stringify({ type: 'open_window', url })
								});
							}
						}}>
							<div class="app-icon">&#x1F5FA;</div>
							<div class="app-name">Atlas</div>
							<div class="app-desc">System architecture</div>
						</button>
				</div>
			{:else if leftSection === 'instances'}
				<div class="instances-panel">
					<div class="svc-category">Switch Between Environments</div>
					<div class="instance-row">
						<span class="svc-dot up"></span>
						<div class="svc-info">
							<div class="svc-name">Prod</div>
							<div class="svc-detail">{isDev ? 'Port 7777' : 'Current'}</div>
						</div>
					</div>
					<div class="instance-row">
						<span class="svc-dot" class:up={isDev} class:unknown={!isDev}></span>
						<div class="svc-info">
							<div class="svc-name">Dev</div>
							<div class="svc-detail">{isDev ? 'Current' : 'Run: npm run dev'}</div>
						</div>
						{#if !isDev}
							<button class="instance-btn" onclick={async () => {
								const r = await fetch('/api/v1/dev/start', { method: 'POST' });
								const d = await r.json();
								const port = d.port || 7781;
								fetch('/api/v1/ui-commands', {
									method: 'POST',
									headers: { 'Content-Type': 'application/json' },
									body: JSON.stringify({ type: 'open_window', url: `http://localhost:${port}/v2/terminal-dev` })
								});
							}}>Open</button>
						{/if}
					</div>
					<div class="instance-row">
						<span class="svc-dot unknown"></span>
						<div class="svc-info">
							<div class="svc-name">Test</div>
							<div class="svc-detail">Coming Soon</div>
						</div>
					</div>
				</div>
			{:else if leftSection === 'tests'}
				<div class="tests-panel">
					{#if testSuites.length === 0}
						<div class="empty-state">Loading test suites...</div>
					{:else}
						<select class="right-select" bind:value={selectedSuite} style="margin-bottom:8px">
							{#each testSuites as suite}
								<option value={suite.id}>{suite.name} ({suite.tests.length} tests)</option>
							{/each}
						</select>
						{@const suite = testSuites.find(s => s.id === selectedSuite)}
						{#if suite}
							<div class="test-desc">{suite.description}</div>
							<button class="test-run-btn" onclick={runSuite} disabled={testsRunning}>
								{testsRunning ? 'Running...' : `Run ${suite.name}`}
							</button>
						{/if}
						{#each testResults as t}
							<div class="test-row">
								<span class="test-icon" class:pass={t.status === 'pass'} class:fail={t.status === 'fail'} class:running={t.status === 'running'} class:pending={t.status === 'pending'}>
									{t.status === 'pass' ? '\u2713' : t.status === 'fail' ? '\u2717' : t.status === 'running' ? '\u25CF' : '\u25CB'}
								</span>
								<div class="test-info">
									<div class="test-name">{t.name}</div>
									<div class="test-detail" class:fail={t.status === 'fail'}>{t.description || t.detail}</div>
									{#if t.detail && t.status !== 'pending'}
										<div class="test-detail" class:fail={t.status === 'fail'}>{t.detail}</div>
									{/if}
								</div>
							</div>
						{/each}
						{#if testResults.length > 0 && !testsRunning}
							{@const passed = testResults.filter(t => t.status === 'pass').length}
							{@const failed = testResults.filter(t => t.status === 'fail').length}
							<div class="test-summary" class:all-pass={failed === 0}>
								{passed}/{testResults.length} passed{failed > 0 ? `, ${failed} failed` : ''}
							</div>
						{/if}
					{/if}
				</div>
			{:else if leftSection === 'users'}
				<div class="users-panel">
					{#if usersData.length === 0}
						<div class="empty-state">No users registered</div>
					{:else}
						{@const groups = [...new Set(usersData.map(u => u.role || u.group || 'Default'))]}
						{#each groups as group}
							<div class="svc-category">{group}</div>
							{#each usersData.filter(u => (u.role || u.group || 'Default') === group) as user}
								<div class="svc-row">
									<span class="svc-dot" class:up={user.status === 'active' || user.status === 'online'} class:unknown={!user.status || user.status === 'offline'}></span>
									<div class="svc-info">
										<div class="svc-name">{user.name || user.email || 'Unknown'}</div>
										<div class="svc-detail">{user.role || 'User'}</div>
									</div>
								</div>
							{/each}
						{/each}
					{/if}
				</div>
			{/if}
		</div>
	</div>

	<!-- LEFT RESIZE HANDLE -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div class="resize-handle" onmousedown={(e) => onResizeStart('left', e)}></div>

	<!-- CENTER: Terminal / Chat -->
	<div class="center-panel">
		<div class="center-tabs">
			<button class="center-tab" class:active={centerView === 'terminal'} onclick={() => switchCenterView('terminal')}>{isDev ? 'Terminal - Dev' : 'Terminal'}</button>
			<button class="center-tab" class:active={centerView === 'chat'} onclick={() => switchCenterView('chat')}>Chat</button>
		</div>
		<div class="term-container" bind:this={termContainerEl} style={centerView === 'terminal' ? '' : 'display:none'}>
			{#if tabs.length === 0}
				<div class="term-empty">
					<div class="term-empty-icon">&loz;</div>
					<div class="term-empty-title">PAN Terminal</div>
					<div class="term-empty-sub">Select a project to start</div>
				</div>
			{/if}
		</div>
		{#if centerView === 'chat'}
			<div class="center-chat" bind:this={centerChatEl} onscroll={() => {
				if (centerChatEl) {
					centerChatUserScrolledUp = centerChatEl.scrollHeight - centerChatEl.scrollTop - centerChatEl.clientHeight > 50;
					// Persist scroll position for refresh survival
					try {
						const ratio = centerChatEl.scrollTop / Math.max(1, centerChatEl.scrollHeight - centerChatEl.clientHeight);
						localStorage.setItem('pan_chat_scroll_ratio', String(ratio));
						localStorage.setItem('pan_chat_scrolled_up', centerChatUserScrolledUp ? '1' : '0');
					} catch {}
				}
			}}>
				{#if centerChatMessages.length === 0}
					<div class="term-empty">
						<div class="term-empty-title">Chat</div>
						<div class="term-empty-sub">Send a message to the terminal session</div>
					</div>
				{:else}
					{#each centerChatMessages as msg}
						{#if msg.role === 'user'}
							<div class="cc-bubble cc-user">{msg.text}</div>
						{:else if msg.type === 'text'}
							<div class="cc-bubble cc-assistant">{msg.text}</div>
						{:else if msg.type === 'tool'}
							<div class="cc-bubble cc-tool">{msg.text}</div>
						{/if}
					{/each}
					{#if centerChatLoading}
						<div class="cc-bubble cc-assistant cc-thinking">Thinking...</div>
					{/if}
				{/if}
			</div>
		{/if}
		{#if centerView === 'atlas'}
			<div class="atlas-container"
				onwheel={handleAtlasWheel}
				onpointerdown={handleAtlasPointerDown}
				onpointermove={handleAtlasPointerMove}
				onpointerup={handleAtlasPointerUp}
				onpointerleave={handleAtlasPointerUp}
			>
				{#if atlasLoading}
					<div class="term-empty">
						<div class="term-empty-title">Loading Atlas...</div>
					</div>
				{:else if atlasData}
					<div class="atlas-toolbar">
						<button class="atlas-btn" onclick={atlasResetView} title="Reset View">Reset</button>
						<button class="atlas-btn" onclick={() => { atlasTransform = { ...atlasTransform, scale: atlasTransform.scale * 1.2 }; }}>+</button>
						<button class="atlas-btn" onclick={() => { atlasTransform = { ...atlasTransform, scale: Math.max(0.3, atlasTransform.scale * 0.8) }; }}>-</button>
						<span class="atlas-zoom">{Math.round(atlasTransform.scale * 100)}%</span>
						{#if atlasData.stats}
							<span class="atlas-stat">{atlasData.stats.total_events || 0} events</span>
							<span class="atlas-stat">{atlasData.stats.total_sessions || 0} sessions</span>
							<span class="atlas-stat">{atlasData.nodes.length} nodes</span>
						{/if}
					</div>
					<svg bind:this={atlasSvgEl} class="atlas-svg" viewBox="0 0 1320 590" preserveAspectRatio="xMidYMid meet">
						<defs>
							<filter id="glow">
								<feGaussianBlur stdDeviation="2" result="blur"/>
								<feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
							</filter>
						</defs>
						<g transform="translate({atlasTransform.x},{atlasTransform.y}) scale({atlasTransform.scale})">
							<!-- Zone backgrounds -->
							{#each atlasData.zones || [] as zone}
								<rect
									x={zone.x} y={zone.y} width={zone.w} height={zone.h}
									rx="16" fill="{zone.color}0a" stroke="{zone.color}40"
									stroke-width="1.5" stroke-dasharray="8,4"
								/>
								<text
									x={zone.x + 14} y={zone.y + 22}
									fill="{zone.color}bb" font-size="14" font-weight="700"
									letter-spacing="1.5"
								>{zone.label.toUpperCase()}</text>
							{/each}
							<!-- Edges -->
							{#each atlasData.edges as edge}
								{@const fromNode = atlasData.nodeMap[edge.from]}
								{@const toNode = atlasData.nodeMap[edge.to]}
								{#if fromNode && toNode}
									<line
										x1={fromNode.x} y1={fromNode.y}
										x2={toNode.x} y2={toNode.y}
										stroke={edge.color || '#313244'}
										stroke-width={edge.label ? 2 : 1.2}
										stroke-dasharray={edge.label ? '' : '5,5'}
										stroke-opacity={edge.label ? 0.6 : 0.3}
									/>
									{#if edge.label}
										<rect
											x={(fromNode.x + toNode.x) / 2 - edge.label.length * 3.5}
											y={(fromNode.y + toNode.y) / 2 - 14}
											width={edge.label.length * 7 + 8}
											height="16" rx="4"
											fill="#11111b" fill-opacity="0.85"
										/>
										<text
											x={(fromNode.x + toNode.x) / 2}
											y={(fromNode.y + toNode.y) / 2 - 3}
											fill={edge.color || '#6c7086'}
											font-size="10"
											text-anchor="middle"
										>{edge.label}</text>
									{/if}
								{/if}
							{/each}
							<!-- Nodes -->
							{#each atlasData.nodes as node}
								<g
									class="atlas-node"
									transform="translate({node.x},{node.y})"
									onpointerenter={() => { atlasHovered = node.id; }}
									onpointerleave={() => { atlasHovered = null; }}
									onclick={() => {
									if (atlasSelected === node.id && node.navigate) {
										// Double-click navigates
										if (node.navigate.page === 'services') { leftSection = 'services'; }
										else if (node.navigate.page === 'devices') { leftSection = 'devices'; }
										else if (node.navigate.page === 'data') { leftSection = 'data'; }
										else if (node.navigate.page === 'settings') { leftSection = 'settings'; }
										else if (node.navigate.page === 'projects') { leftSection = 'projects'; }
									}
									atlasSelected = atlasSelected === node.id ? null : node.id;
								}}
									style="cursor:pointer"
								>
									<!-- Node bg -->
									<rect
										x="-75" y="-24" width="150" height="48" rx="10"
										fill={atlasHovered === node.id || atlasSelected === node.id ? '#1e1e2e' : '#11111b'}
										stroke={atlasSelected === node.id ? atlasNodeColor(node) : atlasHovered === node.id ? '#45475a' : atlasNodeColor(node) + '30'}
										stroke-width={atlasSelected === node.id ? 2.5 : 1}
										filter={atlasSelected === node.id ? 'url(#glow)' : ''}
									/>
									<!-- Status dot -->
									<circle cx="-60" cy="-8" r="5" fill={atlasStatusDot(node.status)} />
									<!-- Label -->
									<text x="-48" y="-4" fill="#cdd6f4" font-size="13" font-weight="600">{node.label.length > 18 ? node.label.slice(0,17) + '..' : node.label}</text>
									<!-- Detail line -->
									<text x="-60" y="14" fill="#6c7086" font-size="9">{(node.detail || '').length > 26 ? (node.detail || '').slice(0,25) + '..' : (node.detail || '')}</text>
								</g>
							{/each}
						</g>
					</svg>
					<!-- Detail panel for selected node -->
					{#if atlasSelected && atlasData.nodeMap[atlasSelected]}
						{@const sel = atlasData.nodeMap[atlasSelected]}
						{@const connectedEdges = atlasData.edges.filter(e => e.from === atlasSelected || e.to === atlasSelected)}
						{@const filePaths = sel.description ? (sel.description.match(/File:\s*([^\n]+)/) || [])[1]?.split(',').map(f => f.trim()) || [] : []}
						<div class="atlas-detail">
							<div class="atlas-detail-header">
								<span class="atlas-detail-dot" style="background:{atlasStatusDot(sel.status)}"></span>
								<strong>{sel.label}</strong>
								<span class="atlas-detail-type" style="color:{atlasNodeColor(sel)}">{sel.type}</span>
								<button class="atlas-detail-close" onclick={() => { atlasSelected = null; }}>&times;</button>
							</div>
							<div class="atlas-detail-body">
								<div class="atlas-detail-status">
									<span class="atlas-detail-status-dot" style="background:{atlasStatusDot(sel.status)}"></span>
									{sel.status === 'up' ? 'Running' : sel.status === 'down' ? 'Offline' : sel.status === 'warn' ? 'Warning' : sel.status === 'idle' ? 'Idle' : 'Unknown'}
								</div>
								{#if sel.detail}<div class="atlas-detail-info">{sel.detail}</div>{/if}
								{#if sel.description}
									<div class="atlas-detail-desc">{sel.description.replace(/\s*File:.*$/, '')}</div>
								{/if}
								{#if connectedEdges.length > 0}
									<div class="atlas-detail-section-title">Connected To</div>
									<div class="atlas-detail-connections">
										{#each connectedEdges as edge}
											{@const otherId = edge.from === atlasSelected ? edge.to : edge.from}
											{@const otherNode = atlasData.nodeMap[otherId]}
											{#if otherNode}
												<button class="atlas-detail-conn" onclick={() => { atlasSelected = otherId; }}>
													<span class="atlas-detail-conn-dot" style="background:{atlasStatusDot(otherNode.status)}"></span>
													<span class="atlas-detail-conn-name">{otherNode.label}</span>
													{#if edge.label}<span class="atlas-detail-conn-label">{edge.label}</span>{/if}
													<span class="atlas-detail-conn-dir">{edge.from === atlasSelected ? '\u2192' : '\u2190'}</span>
												</button>
											{/if}
										{/each}
									</div>
								{/if}
								{#if sel.navigate}
									<button class="atlas-nav-btn" onclick={() => {
										if (sel.navigate.page === 'services') { leftSection = 'services'; }
										else if (sel.navigate.page === 'devices') { leftSection = 'devices'; }
										else if (sel.navigate.page === 'data') { leftSection = 'data'; }
										else if (sel.navigate.page === 'settings') { leftSection = 'settings'; }
										else if (sel.navigate.page === 'projects') { leftSection = 'projects'; }
										atlasSelected = null;
									}}>Go to {sel.navigate.page} &rarr;</button>
								{/if}
								{#if filePaths.length > 0}
									<div class="atlas-detail-section-title">Files</div>
									{#each filePaths as fp}
										<code class="atlas-detail-file">{fp}</code>
									{/each}
								{/if}
							</div>
						</div>
					{/if}
				{:else}
					<div class="term-empty">
						<div class="term-empty-icon">&#x1F5FA;</div>
						<div class="term-empty-title">Atlas</div>
						<div class="term-empty-sub">System architecture diagram</div>
					</div>
				{/if}
			</div>
		{/if}
		{#if pastedImages.length > 0}
			<div class="image-preview-bar">
				{#each pastedImages as img, idx}
					<div class="image-preview-item">
						<img src={img.dataUrl} alt="Pasted" class="image-preview-thumb" />
						{#if img.uploading}
							<span class="image-uploading">...</span>
						{/if}
						<button class="image-remove" onclick={() => removePastedImage(idx)}>&times;</button>
					</div>
				{/each}
			</div>
		{/if}
		{#if !approvalOptions || approvalOptions.length === 0}
			{@const _now = ptyStatusNow}
			{@const _pty = ptyStatus}
			{@const _state = !_pty ? 'no-pty' : _pty.thinking ? 'thinking' : 'ready'}
			{@const _inAgo = _pty?.lastInputTs ? Math.max(0, Math.round((_now - _pty.lastInputTs) / 1000)) : null}
			{@const _outAgo = _pty?.lastOutputTs ? Math.max(0, Math.round((_now - _pty.lastOutputTs) / 1000)) : null}
			{@const _upS = _pty?.createdAt ? Math.max(0, Math.round((_now - _pty.createdAt) / 1000)) : null}
			{@const _tool = _pty?.currentTool}
			{@const _toolElapsed = _tool?.startedAt ? Math.max(0, Math.round((_now - _tool.startedAt) / 1000)) : null}
			<div class="pty-status-bar pty-{_state}" title="Live PTY status from /api/v1/terminal/sessions">
				{#if _tool}
					<span class="status-spinner"></span>
					<span class="status-text">{_tool.isSubagent ? '🤖' : '🔧'} {_tool.tool}{_tool.summary ? ' · ' + _tool.summary : ''} · {_toolElapsed}s</span>
				{:else if _state === 'thinking'}
					<span class="status-spinner"></span>
					<span class="status-text">Claude is thinking…{pendingSendCount > 0 ? ` (${pendingSendCount} queued)` : ''}</span>
				{:else if _state === 'ready'}
					<span class="status-dot dot-green"></span>
					<span class="status-text">Ready</span>
				{:else}
					<span class="status-dot dot-red"></span>
					<span class="status-text">No PTY attached</span>
				{/if}
				{#if _pty}
					<span class="pty-meta">pid {_pty.pid}</span>
					{#if _upS != null}<span class="pty-meta">up {_upS < 60 ? `${_upS}s` : _upS < 3600 ? `${Math.floor(_upS/60)}m` : `${Math.floor(_upS/3600)}h${Math.floor((_upS%3600)/60)}m`}</span>{/if}
					{#if _inAgo != null && _pty.lastInputTs > 0}<span class="pty-meta">in {_inAgo}s ago</span>{/if}
					{#if _outAgo != null}<span class="pty-meta">out {_outAgo}s ago</span>{/if}
					<span class="pty-meta">{_pty.clients} client{_pty.clients === 1 ? '' : 's'}</span>
				{/if}
			</div>
		{/if}
		{#if approvalOptions && approvalOptions.length > 0}
			<div class="approval-bar">
				<span class="approval-label">Claude needs approval:</span>
				{#each approvalOptions as opt}
					<button class="approval-btn" onclick={() => sendApproval(opt.num)} title="Press {opt.num}">
						<span class="approval-num">{opt.num}</span>
						<span class="approval-text">{opt.label}</span>
					</button>
				{/each}
			</div>
		{/if}
		<div class="center-input-bar">
			<button class="mic-btn" class:listening={isListening} onclick={toggleVoiceInput} title="Voice Input"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg></button>
			<textarea
				bind:this={terminalInputEl}
				bind:value={terminalInputText}
				onkeydown={handleTerminalInputKey}
				oninput={autoGrowInput}
				onpaste={handleInputPaste}
				placeholder="Type a message..."
				rows="1"
				class="center-input"
			></textarea>
			<button class="center-send-btn" onclick={sendTerminalInput} disabled={!terminalInputText.trim()} title="Send"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg></button>
		</div>
	</div>

	<!-- RIGHT RESIZE HANDLE -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div class="resize-handle" onmousedown={(e) => onResizeStart('right', e)}></div>

	<!-- RIGHT PANEL -->
	<div class="right-panel" class:resizing={resizingPanel !== null} style="width: {rightPanelWidth}px">
		<div class="right-header">
			<select class="right-select" bind:value={rightSection} onchange={() => { rightMilestoneFilter = null; if (rightSection === 'usage') loadUsageData(); if (rightSection === 'tests') loadTestSuites(); if (rightSection === 'perf') startPerfPolling(); else stopPerfPolling(); }}>
				<option value="approvals">Approvals{approvalsData.length > 0 ? ` (${approvalsData.length})` : ''}</option>
				<option value="apps">Apps</option>
				<option value="bugs">Bugs</option>
				<option value="devices">Devices</option>
				<option value="instances">Instances</option>
				<option value="perf">Performance</option>
				<option value="project">Project</option>
				<option value="services">Services</option>
				<option value="setup">Setup Guide</option>
				<option value="tasks">Tasks</option>
				<option value="tests">Tests</option>
				<option value="transcript">Transcript</option>
				<option value="usage">Usage</option>
				<option value="users">Users</option>
				{#each sectionsData as s}
					<option value="custom-{s.id}">{s.name}</option>
				{/each}
			</select>
		</div>
		<div class="right-content">
			{#if rightSection === 'services'}
				{@const coreServices = servicesData.filter(s => s.category === 'PAN Core')}
				{@const deviceServices = servicesData.filter(s => s.category === 'Devices')}
				{#if coreServices.length > 0}
					<div class="svc-category">PAN Core</div>
					{#each coreServices as svc}
						<div class="svc-row">
							<span class="svc-dot" class:up={svc.status === 'up'} class:down={svc.status === 'down' || svc.status === 'offline'} class:unknown={svc.status === 'unknown'}></span>
							<div class="svc-info">
								<div class="svc-name">{svc.name}</div>
								<div class="svc-detail">{svc.detail}</div>
							</div>
						</div>
					{/each}
				{/if}
				{#if deviceServices.length > 0}
					<div class="svc-category">Devices</div>
					{#each deviceServices as svc}
						<div class="svc-row">
							<span class="svc-dot" class:up={svc.status === 'up'} class:down={svc.status === 'down'} class:unknown={svc.status === 'unknown'}></span>
							<div class="svc-info">
								<div class="svc-name">{svc.name}</div>
								<div class="svc-detail">{svc.detail}</div>
							</div>
						</div>
					{/each}
				{/if}
				{#if servicesData.length === 0}
					<div class="empty-state">Loading services...</div>
				{/if}
			{:else if rightSection === 'apps'}
				<div class="apps-grid">
					<button class="app-card" onclick={() => {
							const url = `${window.location.origin}/v2/atlas`;
							const win = window.open(url, '_blank', 'width=1400,height=900');
							if (!win) {
								fetch('/api/v1/ui-commands', {
									method: 'POST',
									headers: { 'Content-Type': 'application/json' },
									body: JSON.stringify({ type: 'open_window', url })
								});
							}
						}}>
							<div class="app-icon">&#x1F5FA;</div>
							<div class="app-name">Atlas</div>
							<div class="app-desc">System architecture</div>
						</button>
				</div>
			{:else if rightSection === 'instances'}
				<div class="instances-panel">
					<div class="svc-category">Environments</div>
					<div class="instance-row">
						<span class="svc-dot up"></span>
						<div class="svc-info">
							<div class="svc-name">Prod</div>
							<div class="svc-detail">{isDev ? 'Port 7777' : 'Current'}</div>
						</div>
						{#if isDev}
							<button class="instance-btn" onclick={() => { window.location.href = 'http://127.0.0.1:7777/v2/terminal'; }}>Switch</button>
						{/if}
					</div>
					<div class="instance-row">
						<span class="svc-dot unknown"></span>
						<div class="svc-info">
							<div class="svc-name">Test</div>
							<div class="svc-detail">Coming Soon</div>
						</div>
					</div>
					<div class="instance-row">
						<span class="svc-dot" class:up={isDev} class:unknown={!isDev}></span>
						<div class="svc-info">
							<div class="svc-name">Dev</div>
							<div class="svc-detail">{isDev ? 'Current' : 'Run: npm run dev'}</div>
						</div>
						{#if !isDev}
							<button class="instance-btn" onclick={async () => {
								const r = await fetch('/api/v1/dev/start', { method: 'POST' });
								const d = await r.json();
								const port = d.port || 7781;
								fetch('/api/v1/ui-commands', {
									method: 'POST',
									headers: { 'Content-Type': 'application/json' },
									body: JSON.stringify({ type: 'open_window', url: `http://localhost:${port}/v2/terminal-dev` })
								});
							}}>Open</button>
						{/if}
					</div>
					{#if isDev}
						<div class="instance-note">Dev sessions use isolated terminal IDs (dev-dash-*) so they don't interfere with Prod.</div>
					{/if}
				</div>
			{:else if rightSection === 'setup'}
				<div class="setup-guide">
					<div class="setup-title">How to Use PAN</div>
					<div class="setup-desc">Use the terminal to do what you want -- speak or type.</div>
					<div class="setup-items">
						<div><strong>Create a Project:</strong> "Create a new project called my-app"</div>
						<div><strong>Add a Task:</strong> "Add a task to set up the database"</div>
						<div><strong>Change Settings:</strong> "Change the AI model to gpt-4o"</div>
						<div><strong>Ask Anything:</strong> Just say it or type it</div>
					</div>
					<div class="setup-controls">
						<div class="setup-controls-title">Controls</div>
						<div><strong>Voice:</strong> Press your voice key to speak (set in Settings &gt; Controls)</div>
						<div><strong>Screenshot:</strong> Print Screen, then Ctrl+V to paste into chat</div>
						<div><strong>Direct Mode (bubble icon):</strong> Toggle input between input box and direct terminal</div>
					</div>
					<div class="setup-hint">Voice is significantly faster than typing. You don't need complete sentences.</div>
					<div class="setup-controls">
						<div class="setup-controls-title">Terminology</div>
						<div><strong>Sidebar:</strong> Left vertical navigation strip with tabs</div>
						<div><strong>Tab:</strong> Each nav item in the sidebar, switches the active app</div>
						<div><strong>App:</strong> What fills the main view (Terminal, Chat, etc.)</div>
						<div><strong>Main View:</strong> The large center content area</div>
						<div><strong>Panel:</strong> Left and right side panels with dropdown selectors</div>
						<div><strong>Widget:</strong> Content inside a panel (Tasks, Services, Transcript, etc.)</div>
						<div><strong>Topbar:</strong> Thin bar at top showing current app name</div>
						<div><strong>Instance:</strong> Environment (Prod, Dev, Test). Admin only.</div>
						<div><strong>Transcript:</strong> Conversation history (what was said)</div>
					</div>
				</div>
			{:else if rightSection === 'tasks'}
				{@const taskData = getFilteredTasks()}
				{#if rightMilestoneFilter}
					{@const m = taskData.milestones.find(x => x.id === rightMilestoneFilter)}
					<div class="filter-header">
						<strong>{m ? m.name : 'Tasks'}</strong>
						<button class="filter-clear" onclick={() => { rightMilestoneFilter = null; }}>&times; Clear</button>
					</div>
				{/if}
				{#each taskData.milestones as m}
					{#if taskData.byMilestone[m.id]?.length > 0}
						{#if !rightMilestoneFilter}
							<div class="task-group-header">{m.name}</div>
						{/if}
						{#each taskData.byMilestone[m.id] as t}
							<div class="task-row" onclick={() => cycleTask(t.id, t.status)}>
								<span class="task-icon" class:done={t.status === 'done'} class:in-progress={t.status === 'in_progress'}>
									{t.status === 'done' ? '\u2713' : t.status === 'in_progress' ? '\u25C6' : '\u25CB'}
								</span>
								<span class="task-title" class:done={t.status === 'done'}>{t.title}</span>
							</div>
						{/each}
					{/if}
				{/each}
				{#if taskData.noMilestone.length > 0 && !rightMilestoneFilter}
					<div class="task-group-header">Other</div>
					{#each taskData.noMilestone as t}
						<div class="task-row" onclick={() => cycleTask(t.id, t.status)}>
							<span class="task-icon" class:done={t.status === 'done'} class:in-progress={t.status === 'in_progress'}>
								{t.status === 'done' ? '\u2713' : t.status === 'in_progress' ? '\u25C6' : '\u25CB'}
							</span>
							<span class="task-title" class:done={t.status === 'done'}>{t.title}</span>
						</div>
					{/each}
				{/if}
				<div class="add-row">
					<input
						type="text"
						class="add-input"
						placeholder="Add a task..."
						onkeydown={(e) => { if (e.key === 'Enter') addTask(e.target); }}
					/>
				</div>
				<div class="panel-hint">Use Terminal to Add: Tasks, Milestones, Projects</div>
			{:else if rightSection === 'bugs'}
				{@const bugs = getBugs()}
				{#if bugs.length === 0}
					<div class="empty-state">No bugs tracked</div>
					<div class="empty-state small">Add tasks with "bug" or "fix" in the title, or set priority &gt; 0</div>
				{:else}
					{#each bugs as t}
						<div class="task-row" onclick={() => cycleTask(t.id, t.status)}>
							<span class="task-icon bug" class:done={t.status === 'done'}>
								{t.status === 'done' ? '\u2713' : '\u26A0'}
							</span>
							<span class="task-title" class:done={t.status === 'done'}>{t.title}</span>
						</div>
					{/each}
				{/if}
				<div class="add-row">
					<input
						type="text"
						class="add-input"
						placeholder="Report a bug..."
						onkeydown={(e) => { if (e.key === 'Enter') addBug(e.target); }}
					/>
				</div>
				<div class="panel-hint">Use Terminal to Report: Bugs, Issues, Errors</div>
			{:else if rightSection === 'perf'}
				<div class="perf-widget">
					<div class="perf-section-title">Terminal Stream</div>
					<div class="perf-metric">
						<span class="perf-label">WS Latency</span>
						<span class="perf-value" class:perf-warn={perfData.wsLatency > 50} class:perf-bad={perfData.wsLatency > 200}>{perfData.wsLatency}ms</span>
					</div>
					<div class="perf-metric">
						<span class="perf-label">DOM Update</span>
						<span class="perf-value" class:perf-warn={perfData.domTime > 5} class:perf-bad={perfData.domTime > 16}>{perfData.domTime}ms</span>
					</div>
					<div class="perf-metric">
						<span class="perf-label">Server Render</span>
						<span class="perf-value" class:perf-warn={perfData.serverRender > 5} class:perf-bad={perfData.serverRender > 15}>{perfData.serverRender}ms</span>
					</div>
					<div class="perf-metric">
						<span class="perf-label">Msg Size</span>
						<span class="perf-value">{(perfData.msgSize / 1024).toFixed(1)} KB</span>
					</div>
					<div class="perf-metric">
						<span class="perf-label">FPS / Lines</span>
						<span class="perf-value">{perfData.fps} / {perfData.linesChanged}</span>
					</div>

					<div class="perf-section-title" style="margin-top:12px">PAN Services</div>
					{#if perfServices.length === 0}
						<div class="perf-metric"><span class="perf-label" style="opacity:0.5">Scanning...</span></div>
					{:else}
						{#each perfServices as svc}
							<div class="perf-proc" class:perf-zombie={svc.status === 'down' || svc.status === 'error'}>
								<div class="perf-proc-header">
									<span class="perf-proc-name vital">{svc.name}</span>
									{#if svc.inProcess}
										<span class="perf-proc-tag" title="Runs inside the PAN server process">in-proc</span>
									{:else if svc.pid}
										<button class="perf-kill-btn" onclick={() => killProcess(svc.pid)} title="Kill {svc.name} (pid {svc.pid})">Kill</button>
									{:else}
										<span class="perf-proc-tag perf-bad" title="No matching OS process found">offline</span>
									{/if}
								</div>
								<div class="perf-proc-stats">
									{#if svc.pid}
										<span>CPU: {svc.cpuSec > 3600 ? (svc.cpuSec/3600).toFixed(1)+'h' : svc.cpuSec > 60 ? (svc.cpuSec/60).toFixed(1)+'m' : svc.cpuSec+'s'}</span>
										<span>{svc.memMB}MB</span>
										<span>{svc.uptimeHrs > 24 ? (svc.uptimeHrs/24).toFixed(1)+'d' : svc.uptimeHrs+'h'}</span>
									{:else if svc.inProcess}
										<span style="opacity:0.6">{svc.modelTierLabel || 'in-process job'}</span>
									{:else}
										<span class="perf-bad">not running</span>
									{/if}
								</div>
								{#if svc.lastError}
									<div class="perf-proc-stats perf-bad" style="font-size:9px;margin-top:2px">{String(svc.lastError).slice(0,80)}</div>
								{/if}
							</div>
						{/each}
					{/if}

					{#if perfOther.length > 0}
						<div class="perf-section-title" style="margin-top:12px">Other (>10% CPU)</div>
						{#each perfOther.slice(0, 5) as p}
							<div class="perf-proc">
								<div class="perf-proc-header">
									<span class="perf-proc-name" style="opacity:0.7">{p.exe}</span>
									<button class="perf-kill-btn" onclick={() => killProcess(p.pid)} title="Kill pid {p.pid}">Kill</button>
								</div>
								<div class="perf-proc-stats">
									<span>CPU: {p.cpuSec > 3600 ? (p.cpuSec/3600).toFixed(1)+'h' : p.cpuSec > 60 ? (p.cpuSec/60).toFixed(1)+'m' : p.cpuSec+'s'}</span>
									<span>{p.memMB}MB</span>
									<span>{p.uptimeHrs > 24 ? (p.uptimeHrs/24).toFixed(1)+'d' : p.uptimeHrs+'h'}</span>
								</div>
							</div>
						{/each}
					{/if}

					{#if perfServices.filter(s => s.status === 'down' || s.status === 'error').length > 0}
						<div class="perf-metric perf-status" style="margin-top:8px">
							<span class="perf-bad">{perfServices.filter(s => s.status === 'down' || s.status === 'error').length} SERVICE{perfServices.filter(s => s.status === 'down' || s.status === 'error').length > 1 ? 'S' : ''} DOWN</span>
						</div>
					{:else if perfData.wsLatency > 200 || perfData.domTime > 16}
						<div class="perf-metric perf-status" style="margin-top:8px">
							<span class="perf-bad">STREAM BOTTLENECK</span>
						</div>
					{:else if perfData.wsLatency > 50 || perfData.domTime > 5}
						<div class="perf-metric perf-status" style="margin-top:8px">
							<span class="perf-warn">Moderate latency</span>
						</div>
					{:else}
						<div class="perf-metric perf-status" style="margin-top:8px">
							<span class="perf-good">Running smooth</span>
						</div>
					{/if}
				</div>
			{:else if rightSection === 'usage'}
				{#if !usageData}
					<div class="empty-state">Loading usage...</div>
				{:else}
					{#if usageData.claude?.rateLimits}
						{@const rl = usageData.claude.rateLimits}
						<div class="usage-section">
							<div class="usage-heading">Claude Plan Limits</div>
							<div class="usage-row" style="opacity:0.6; font-size:11px;">
								<span class="usage-label">{rl.subscriptionType?.toUpperCase() || 'Plan'}</span>
								<span class="usage-val">{rl.rateLimitTier || ''}</span>
							</div>
							{#if rl.five_hour}
								<div class="usage-subhead">Session (5hr Window)</div>
								<div class="usage-bar-wrap">
									<div class="usage-bar" style="width:{Math.min(rl.five_hour.utilization, 100)}%; background:{
										rl.five_hour.utilization >= 80 ? '#f38ba8' : rl.five_hour.utilization >= 50 ? '#f9e2af' : '#a6e3a1'
									}"></div>
								</div>
								<div class="usage-row">
									<span class="usage-label" style="color:{rl.five_hour.utilization >= 80 ? '#f38ba8' : rl.five_hour.utilization >= 50 ? '#f9e2af' : '#a6e3a1'}">{Math.round(rl.five_hour.utilization)}% Used</span>
									<span class="usage-val">Resets in {formatResetTime(rl.five_hour.resets_at)}</span>
								</div>
							{/if}
							{#if rl.seven_day}
								<div class="usage-subhead">Weekly Limit</div>
								<div class="usage-bar-wrap">
									<div class="usage-bar" style="width:{Math.min(rl.seven_day.utilization, 100)}%; background:{
										rl.seven_day.utilization >= 80 ? '#f38ba8' : rl.seven_day.utilization >= 50 ? '#f9e2af' : '#a6e3a1'
									}"></div>
								</div>
								<div class="usage-row">
									<span class="usage-label" style="color:{rl.seven_day.utilization >= 80 ? '#f38ba8' : rl.seven_day.utilization >= 50 ? '#f9e2af' : '#a6e3a1'}">{Math.round(rl.seven_day.utilization)}% Used</span>
									<span class="usage-val">Resets in {formatResetTime(rl.seven_day.resets_at)}</span>
								</div>
							{/if}
							{#if rl.seven_day_opus}
								<div class="usage-subhead">Opus Weekly</div>
								<div class="usage-bar-wrap">
									<div class="usage-bar" style="width:{Math.min(rl.seven_day_opus.utilization, 100)}%; background:{
										rl.seven_day_opus.utilization >= 80 ? '#f38ba8' : rl.seven_day_opus.utilization >= 50 ? '#f9e2af' : '#a6e3a1'
									}"></div>
								</div>
								<div class="usage-row">
									<span class="usage-label">{Math.round(rl.seven_day_opus.utilization)}% Used</span>
									<span class="usage-val">Resets in {formatResetTime(rl.seven_day_opus.resets_at)}</span>
								</div>
							{/if}
							{#if rl.seven_day_sonnet}
								<div class="usage-subhead">Sonnet Weekly</div>
								<div class="usage-bar-wrap">
									<div class="usage-bar" style="width:{Math.min(rl.seven_day_sonnet.utilization, 100)}%; background:{
										rl.seven_day_sonnet.utilization >= 80 ? '#f38ba8' : rl.seven_day_sonnet.utilization >= 50 ? '#f9e2af' : '#a6e3a1'
									}"></div>
								</div>
								<div class="usage-row">
									<span class="usage-label">{Math.round(rl.seven_day_sonnet.utilization)}% Used</span>
									<span class="usage-val">Resets in {formatResetTime(rl.seven_day_sonnet.resets_at)}</span>
								</div>
							{/if}
							{#if rl.extra_usage}
								<div class="usage-subhead">Extra Usage</div>
								<div class="usage-bar-wrap">
									<div class="usage-bar" style="width:{Math.min(rl.extra_usage.utilization, 100)}%; background:#89b4fa"></div>
								</div>
								<div class="usage-row">
									<span class="usage-label">${rl.extra_usage.used_credits?.toFixed(0) || 0} / ${rl.extra_usage.monthly_limit || 0}</span>
									<span class="usage-val">{rl.extra_usage.utilization?.toFixed(1)}%</span>
								</div>
							{/if}
						</div>
					{/if}
					<div class="usage-section">
						<div class="usage-heading">Session Tokens</div>
						{#if usageData.claude}
							{@const c = usageData.claude}
							<div class="usage-row">
								<span class="usage-label">Model</span>
								<span class="usage-val">{c.model || 'unknown'}</span>
							</div>
							<div class="usage-row">
								<span class="usage-label">Active Sessions</span>
								<span class="usage-val">{c.session?.activeSessions || 0}</span>
							</div>
							<div class="usage-row">
								<span class="usage-label">Output</span>
								<span class="usage-val">{formatTokens(c.session?.output)}</span>
							</div>
							<div class="usage-row">
								<span class="usage-label">Input</span>
								<span class="usage-val">{formatTokens(c.session?.input)}</span>
							</div>
							<div class="usage-row">
								<span class="usage-label">Cache Read</span>
								<span class="usage-val">{formatTokens(c.session?.cache_read)}</span>
							</div>
							<div class="usage-row">
								<span class="usage-label">Messages</span>
								<span class="usage-val">{c.session?.messages || 0}</span>
							</div>
							<div class="usage-subhead">Today</div>
							<div class="usage-row">
								<span class="usage-label">Output</span>
								<span class="usage-val">{formatTokens(c.today?.output)}</span>
							</div>
							<div class="usage-row">
								<span class="usage-label">Messages</span>
								<span class="usage-val">{c.today?.messages || 0}</span>
							</div>
						{/if}
					</div>
					<div class="usage-section">
						<div class="usage-heading">PAN Stats</div>
						{#if usageData.stats}
							{@const s = usageData.stats}
							<div class="usage-row">
								<span class="usage-label">Total Events</span>
								<span class="usage-val">{s.total_events?.toLocaleString() || 0}</span>
							</div>
							<div class="usage-row">
								<span class="usage-label">Total Sessions</span>
								<span class="usage-val">{s.total_sessions?.toLocaleString() || 0}</span>
							</div>
							<div class="usage-row">
								<span class="usage-label">Memory Items</span>
								<span class="usage-val">{s.total_memory_items?.toLocaleString() || 0}</span>
							</div>
							<div class="usage-row">
								<span class="usage-label">DB Size</span>
								<span class="usage-val">{s.db_size || '--'}</span>
							</div>
						{/if}
					</div>
				{/if}
			{:else if rightSection === 'approvals'}
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
			{:else if rightSection === 'devices'}
				{@const deviceServices = servicesData.filter(s => s.category === 'Devices')}
				{#if deviceServices.length === 0}
					<div class="empty-state">No devices connected</div>
				{:else}
					{#each deviceServices as svc}
						<div class="svc-row">
							<span class="svc-dot" class:up={svc.status === 'up'} class:down={svc.status === 'down'} class:unknown={svc.status === 'unknown'}></span>
							<div class="svc-info">
								<div class="svc-name">{svc.name}</div>
								<div class="svc-detail">{svc.detail}</div>
							</div>
						</div>
					{/each}
				{/if}
			{:else if rightSection === 'transcript'}
				{#if chatBubbles.length === 0}
					<div class="empty-state">No conversation yet</div>
				{:else}
					<div class="chat-container">
						{#each chatBubbles as bubble}
							{#if bubble.type === 'user'}
								<div class="chat-bubble user">{bubble.text}</div>
							{:else if bubble.type === 'assistant'}
								<div class="chat-bubble assistant">{bubble.text}</div>
							{:else if bubble.type === 'tool'}
								<div class="chat-bubble tool">{bubble.text}</div>
							{/if}
						{/each}
					</div>
				{/if}
			{:else if rightSection === 'project'}
				{#if projectData}
					<div class="project-info">
						<div class="project-name">{projectData.name}</div>
						<div class="project-progress-row">
							<span class="project-pct">{projectData.percentage}%</span>
							<span class="project-count">{projectData.done_tasks}/{projectData.total_tasks}</span>
						</div>
						<div class="progress-bar">
							<div class="progress-fill {pctColor(projectData.percentage)}" style="width:{projectData.percentage}%"></div>
						</div>
						<div class="project-sessions">{projectData.session_count} sessions</div>
					</div>
					{#if projectData.milestones}
						{#each projectData.milestones as m}
							<div class="milestone" onclick={() => filterByMilestone(m.id)}>
								<div class="milestone-row">
									<span class="milestone-name">{m.name}</span>
									<span class="milestone-pct">{m.percentage}%</span>
								</div>
								<div class="progress-bar small">
									<div class="progress-fill {pctColor(m.percentage)}" style="width:{m.percentage}%"></div>
								</div>
							</div>
						{/each}
					{/if}
				{:else}
					<div class="empty-state">Select a project</div>
				{/if}
			{:else if rightSection === 'tests'}
				<div class="tests-panel">
					{#if testSuites.length === 0}
						<div class="empty-state">Loading test suites...</div>
					{:else}
						<select class="right-select" bind:value={selectedSuite} style="margin-bottom:8px">
							<option value="__all__">All Suites</option>
							{#each testSuites as suite}
								<option value={suite.id}>{suite.name} ({suite.tests.length} tests)</option>
							{/each}
						</select>
						{#if selectedSuite === '__all__'}
							<button class="test-run-btn" onclick={runAllTests} disabled={testsRunning}>
								{testsRunning ? 'Running...' : 'Run All Tests'}
							</button>
						{:else}
							{@const suite = testSuites.find(s => s.id === selectedSuite)}
							{#if suite}
								<div class="test-desc">{suite.description}</div>
								<button class="test-run-btn" onclick={runSuite} disabled={testsRunning}>
									{testsRunning ? 'Running...' : `Run ${suite.name}`}
								</button>
							{/if}
						{/if}
					{/if}
					{#each testResults as t}
						<div class="test-row">
							<span class="test-icon" class:pass={t.status === 'pass'} class:fail={t.status === 'fail'} class:running={t.status === 'running'} class:pending={t.status === 'pending'}>
								{t.status === 'pass' ? '\u2713' : t.status === 'fail' ? '\u2717' : t.status === 'running' ? '\u25CF' : '\u25CB'}
							</span>
							<div class="test-info">
								<div class="test-name">{t.name}</div>
								<div class="test-detail" class:fail={t.status === 'fail'}>{t.detail || t.description}</div>
							</div>
						</div>
					{/each}
					{#if testResults.length > 0 && !testsRunning}
						{@const passed = testResults.filter(t => t.status === 'pass').length}
						{@const failed = testResults.filter(t => t.status === 'fail').length}
						<div class="test-summary" class:all-pass={failed === 0}>
							{passed}/{testResults.length} passed{failed > 0 ? `, ${failed} failed` : ''}
						</div>
					{/if}
				</div>
			{:else if rightSection === 'users'}
				<div class="users-panel">
					{#if usersData.length === 0}
						<div class="empty-state">No users registered</div>
						<div class="empty-state small">Users are added when devices connect or through Settings &gt; Users</div>
					{:else}
						{@const groups = [...new Set(usersData.map(u => u.role || u.group || 'Default'))]}
						{#each groups as group}
							<div class="svc-category">{group}</div>
							{#each usersData.filter(u => (u.role || u.group || 'Default') === group) as user}
								<div class="svc-row">
									<span class="svc-dot" class:up={user.status === 'active' || user.status === 'online'} class:unknown={!user.status || user.status === 'offline'}></span>
									<div class="svc-info">
										<div class="svc-name">{user.name || user.email || 'Unknown'}</div>
										<div class="svc-detail">{user.role || 'User'}{user.last_seen ? ` — ${user.last_seen}` : ''}</div>
									</div>
								</div>
							{/each}
						{/each}
					{/if}
				</div>
			{:else if rightSection.startsWith('custom-')}
				{@const sectionId = parseInt(rightSection.replace('custom-', ''))}
				{@const section = getSectionById(sectionId)}
				{#if section}
					{#each section.items || [] as item}
						<div class="task-row" onclick={() => cycleSectionItem(item.id, item.status, sectionId)}>
							<span class="task-icon" class:done={item.status === 'done'}>
								{item.status === 'done' ? '\u2713' : '\u25CB'}
							</span>
							<span class="task-title" class:done={item.status === 'done'}>{item.content}</span>
						</div>
					{/each}
					{#if !section.items?.length}
						<div class="empty-state">No items yet</div>
					{/if}
					<div class="add-row">
						<input
							type="text"
							class="add-input"
							placeholder="Add item..."
							onkeydown={(e) => { if (e.key === 'Enter') addSectionItem(sectionId, e.target); }}
						/>
					</div>
					<button class="delete-section" onclick={() => deleteSection(sectionId)}>Delete This Section</button>
				{:else}
					<div class="empty-state">Section not found</div>
				{/if}
			{/if}
		</div>
	</div>
</div>

<style>
	/* ==================== Center Panel ==================== */
	.center-panel {
		flex: 1;
		min-height: 0;
		min-width: 0;
		display: flex;
		flex-direction: column;
	}

	.center-tabs {
		display: flex;
		background: #0e0e16;
		border-bottom: 1px solid #1e1e2e;
	}

	.center-tab {
		flex: 1;
		padding: 8px 16px;
		background: none;
		border: none;
		border-bottom: 2px solid transparent;
		color: #6c7086;
		font-size: 13px;
		font-weight: 500;
		cursor: pointer;
		text-transform: uppercase;
		letter-spacing: 0.5px;
		transition: all 0.15s;
	}

	.center-tab:hover { color: #cdd6f4; }
	.center-tab.active {
		color: #89b4fa;
		border-bottom-color: #89b4fa;
	}

	.center-chat {
		flex: 1;
		min-height: 0;
		min-width: 0;
		overflow-y: auto;
		overflow-x: hidden;
		padding: 12px 16px;
		display: flex;
		flex-direction: column;
		gap: 8px;
		background: #1e1e2e;
	}

	.cc-bubble {
		max-width: 85%;
		padding: 8px 12px;
		border-radius: 12px;
		font-size: 13px;
		line-height: 1.5;
		word-wrap: break-word;
		word-break: break-word;
		overflow-wrap: break-word;
		white-space: pre-wrap;
		overflow-x: auto;
		min-width: 0;
	}

	.cc-user {
		align-self: flex-end;
		background: #89b4fa;
		color: #0a0a0f;
		border-bottom-right-radius: 4px;
	}

	.cc-assistant {
		align-self: flex-start;
		background: #2a2a3a;
		color: #cdd6f4;
		border-bottom-left-radius: 4px;
	}

	.cc-tool {
		align-self: flex-start;
		background: #1a1a25;
		color: #6c7086;
		font-size: 11px;
		font-family: monospace;
		border-left: 2px solid #45475a;
	}

	.cc-thinking {
		color: #6c7086;
		font-style: italic;
	}

	.center-input-bar {
		display: flex;
		align-items: flex-end;
		gap: 8px;
		padding: 8px 12px;
		background: #12121a;
		border-top: 1px solid #1e1e2e;
	}

	.mic-btn {
		width: 36px;
		height: 36px;
		border-radius: 50%;
		border: 1px solid #1e1e2e;
		background: #1a1a25;
		color: #6c7086;
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
		transition: all 0.15s;
	}

	.mic-btn:hover { color: #89b4fa; border-color: #89b4fa; }
	.mic-btn.listening {
		color: #f38ba8;
		border-color: #f38ba8;
		background: rgba(243, 139, 168, 0.1);
		animation: micPulse 1.5s ease-in-out infinite;
	}

	@keyframes micPulse {
		0%, 100% { box-shadow: 0 0 0 0 rgba(243, 139, 168, 0.3); }
		50% { box-shadow: 0 0 0 6px rgba(243, 139, 168, 0); }
	}

	.direct-mode-btn {
		width: 32px;
		height: 32px;
		border-radius: 50%;
		border: 1px solid #1e1e2e;
		background: #1a1a25;
		color: #6c7086;
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
		transition: all 0.15s;
	}
	.direct-mode-btn:hover { color: #89b4fa; border-color: #89b4fa; }
	.direct-mode-btn.active {
		color: #a6e3a1;
		border-color: #a6e3a1;
		background: rgba(166, 227, 161, 0.1);
	}

	.center-input {
		flex: 1;
		min-height: 36px;
		max-height: 200px;
		padding: 8px 12px;
		background: #1a1a25;
		border: 1px solid #1e1e2e;
		border-radius: 8px;
		color: #cdd6f4;
		font-family: inherit;
		font-size: 13px;
		resize: none;
		outline: none;
		overflow-y: auto;
		line-height: 20px;
	}

	.image-preview-bar {
		display: flex;
		gap: 6px;
		padding: 6px 12px;
		background: #12121a;
		border-top: 1px solid #1e1e2e;
	}
	.image-preview-item {
		position: relative;
		width: 48px;
		height: 48px;
		border-radius: 6px;
		overflow: hidden;
		border: 1px solid #1e1e2e;
	}
	.image-preview-thumb {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}
	.image-remove {
		position: absolute;
		top: -2px;
		right: -2px;
		width: 16px;
		height: 16px;
		border-radius: 50%;
		border: none;
		background: #f38ba8;
		color: #1e1e2e;
		font-size: 10px;
		cursor: pointer;
		line-height: 1;
		padding: 0;
	}
	.image-uploading {
		position: absolute;
		bottom: 2px;
		left: 2px;
		font-size: 9px;
		color: #89b4fa;
	}

	.direct-bar {
		justify-content: flex-start;
		padding: 4px 12px;
	}
	.center-input:focus { border-color: #89b4fa; }
	.center-input::placeholder { color: #45475a; }

	.center-send-btn {
		width: 36px;
		height: 36px;
		border-radius: 50%;
		border: none;
		background: #89b4fa;
		color: #0a0a0f;
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
		transition: all 0.15s;
	}

	.center-send-btn:hover { background: #74a8fc; }
	.center-send-btn:disabled { background: #45475a; color: #6c7086; cursor: not-allowed; }

	.status-bar {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 5px 10px;
		background: #181825;
		border-top: 1px solid #313244;
		font-size: 12px;
		color: #cba6f7;
	}
	.status-spinner {
		display: inline-block;
		width: 10px;
		height: 10px;
		border: 2px solid #313244;
		border-top-color: #cba6f7;
		border-radius: 50%;
		animation: spin 0.8s linear infinite;
	}
	.status-text { font-style: italic; }
	@keyframes spin { to { transform: rotate(360deg); } }

	.pty-status-bar {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 4px 10px;
		background: #181825;
		border-top: 1px solid #313244;
		font-size: 11px;
		font-family: ui-monospace, Menlo, Consolas, monospace;
		color: #a6adc8;
		flex-wrap: wrap;
	}
	.pty-status-bar.pty-thinking { color: #cba6f7; }
	.pty-status-bar.pty-thinking .status-text { font-style: italic; }
	.pty-status-bar.pty-ready { color: #a6e3a1; }
	.pty-status-bar.pty-no-pty { color: #f38ba8; }
	.pty-status-bar .status-text { font-style: normal; font-weight: 600; }
	.pty-meta {
		color: #6c7086;
		padding-left: 8px;
		border-left: 1px solid #313244;
	}
	.pty-meta:first-of-type { border-left: none; padding-left: 0; }
	.status-dot {
		display: inline-block;
		width: 8px;
		height: 8px;
		border-radius: 50%;
	}
	.dot-green { background: #a6e3a1; box-shadow: 0 0 6px #a6e3a1; }
	.dot-red { background: #f38ba8; box-shadow: 0 0 6px #f38ba8; }

	.approval-bar {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 6px 10px;
		background: #181825;
		border-top: 1px solid #f9e2af;
		flex-wrap: wrap;
	}
	.approval-label {
		color: #f9e2af;
		font-size: 12px;
		font-weight: 600;
		margin-right: 4px;
	}
	.approval-btn {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 5px 10px;
		background: #313244;
		color: #cdd6f4;
		border: 1px solid #45475a;
		border-radius: 4px;
		cursor: pointer;
		font-size: 12px;
		font-family: inherit;
		transition: background 0.1s;
	}
	.approval-btn:hover { background: #45475a; border-color: #89b4fa; }
	.approval-num {
		display: inline-block;
		min-width: 16px;
		height: 16px;
		line-height: 16px;
		text-align: center;
		background: #89b4fa;
		color: #1e1e2e;
		border-radius: 3px;
		font-weight: bold;
		font-size: 11px;
	}
	.approval-text {
		max-width: 200px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	/* ==================== Layout ==================== */
	.toolbar {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 6px 12px;
		flex-wrap: wrap;
	}

	.project-select {
		background: #0a0a0f;
		color: #cdd6f4;
		border: 1px solid #1e1e2e;
		border-radius: 6px;
		padding: 6px 10px;
		font-size: 14px;
		outline: none;
	}
	.project-select:focus { border-color: #89b4fa; }

	.tab-history-select {
		background: #0a0a0f;
		color: #cdd6f4;
		border: 1px solid #1e1e2e;
		border-radius: 6px;
		padding: 6px 10px;
		font-size: 13px;
		outline: none;
		max-width: 200px;
		margin-left: 4px;
	}
	.tab-history-select:focus { border-color: #89b4fa; }

	.host-label {
		color: #6c7086;
		font-size: 12px;
	}

	.sessions-count {
		color: #6c7086;
		font-size: 12px;
	}

	/* ==================== Tab Bar ==================== */
	.tab-bar {
		display: flex;
		align-items: center;
		gap: 1px;
		background: #12121a;
		border-bottom: 1px solid #1e1e2e;
		padding: 0 8px;
		overflow-x: auto;
		scrollbar-width: none;
		min-height: 28px;
	}
	.tab-bar::-webkit-scrollbar { display: none; }

	.term-tab {
		display: flex;
		align-items: center;
		gap: 4px;
		padding: 4px 10px;
		background: transparent;
		border: none;
		border-bottom: 2px solid transparent;
		border-radius: 4px 4px 0 0;
		color: #6c7086;
		font-size: 12px;
		cursor: pointer;
		white-space: nowrap;
		user-select: none;
	}
	.term-tab:hover { color: #cdd6f4; }
	.term-tab.active {
		color: #cdd6f4;
		border-bottom-color: #89b4fa;
		background: #12121a;
	}

	.primary-dot {
		display: inline-block;
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: #89b4fa;
	}

	.tab-label {
		font-weight: 500;
	}
	.tab-project-hint {
		font-size: 10px;
		color: #585b70;
		margin-left: 2px;
	}
	.term-tab.active .tab-project-hint {
		color: #6c7086;
	}
	.tab-rename-input {
		background: #181825;
		border: 1px solid #89b4fa;
		border-radius: 3px;
		color: #cdd6f4;
		font-size: 12px;
		padding: 1px 4px;
		width: 80px;
		outline: none;
		font-family: inherit;
	}

	.tab-close {
		font-size: 14px;
		opacity: 0.5;
		line-height: 1;
		margin-left: 4px;
	}
	.tab-close:hover { opacity: 1; }

	.add-tab {
		padding: 4px 8px;
		background: transparent;
		border: none;
		color: #6c7086;
		font-size: 14px;
		cursor: pointer;
		opacity: 0.7;
		white-space: nowrap;
		user-select: none;
	}
	.add-tab:hover { opacity: 1; color: #cdd6f4; }

	/* ==================== Main Three-Column Layout ==================== */
	.terminal-layout {
		display: flex;
		gap: 0;
		flex: 1;
		min-height: 0;
		overflow: hidden;
		max-width: 100%;
	}

	/* ==================== Left Panel ==================== */
	.left-panel {
		display: flex;
		flex-direction: column;
		border: 1px solid #1e1e2e;
		border-radius: 6px 0 0 6px;
		flex-shrink: 0;
		overflow: hidden;
	}

	.resize-handle {
		width: 5px;
		cursor: col-resize;
		background: #1e1e2e;
		flex-shrink: 0;
		transition: background 0.15s;
	}
	.resize-handle:hover {
		background: #89b4fa;
	}
	.left-panel.resizing, .right-panel.resizing {
		transition: none;
	}



	.left-content {
		flex: 1;
		background: #12121a;
		overflow-y: auto;
		overflow-x: hidden;
		padding: 10px;
		font-size: 12px;
		min-width: 0;
	}

	/* ==================== Chat ==================== */
	.chat-container {
		display: flex;
		flex-direction: column;
		gap: 8px;
		min-width: 0;
	}

	.chat-turn { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
	.chat-speaker {
		font-size: 10px;
		font-weight: 700;
		letter-spacing: 0.3px;
		display: flex;
		align-items: baseline;
		gap: 6px;
	}
	.chat-speaker-user { color: #89b4fa; align-self: flex-end; }
	.chat-speaker-assistant { color: #fab387; align-self: flex-start; }
	.chat-model {
		color: #cba6f7;
		font-size: 9px;
		font-weight: 500;
		background: #1e1e2e;
		border: 1px solid #313244;
		border-radius: 3px;
		padding: 0 4px;
		font-family: ui-monospace, monospace;
	}

	.chat-bubble {
		word-break: break-word;
		overflow-wrap: break-word;
		white-space: pre-wrap;
		overflow-x: auto;
		min-width: 0;
		max-width: 100%;
	}

	.chat-bubble.user {
		background: rgba(137, 180, 250, 0.15);
		border: 1px solid rgba(137, 180, 250, 0.2);
		border-radius: 12px 12px 4px 12px;
		padding: 8px 10px;
		font-size: 12px;
		align-self: flex-end;
		max-width: 95%;
	}

	.session-dot {
		display: inline-block;
		width: 6px;
		height: 6px;
		border-radius: 50%;
		margin-right: 4px;
		vertical-align: middle;
	}

	.chat-bubble.assistant {
		background: #1a1a25;
		border-radius: 8px 8px 8px 2px;
		padding: 8px 10px;
		font-size: 11px;
		align-self: flex-start;
		max-width: 95%;
	}

	.chat-bubble.tool {
		background: transparent;
		border-left: 2px solid #1e1e2e;
		padding: 2px 8px;
		font-size: 10px;
		color: #6c7086;
		align-self: flex-start;
		max-width: 95%;
		font-family: monospace;
		word-break: break-all;
	}

	/* ==================== Project Info ==================== */
	.project-info {
		margin-bottom: 10px;
	}
	.project-name {
		font-weight: 600;
		font-size: 14px;
		margin-bottom: 4px;
	}
	.project-progress-row {
		display: flex;
		align-items: baseline;
		gap: 6px;
		margin-bottom: 4px;
	}
	.project-pct {
		font-size: 20px;
		font-weight: 700;
		color: #89b4fa;
	}
	.project-count {
		color: #6c7086;
		font-size: 10px;
	}
	.project-sessions {
		font-size: 10px;
		color: #6c7086;
		margin-top: 4px;
	}

	.milestone {
		margin-bottom: 8px;
		cursor: pointer;
	}
	.milestone:hover { opacity: 0.8; }
	.milestone-row {
		display: flex;
		align-items: center;
		gap: 4px;
		margin-bottom: 2px;
	}
	.milestone-name {
		flex: 1;
		font-size: 11px;
		font-weight: 500;
	}
	.milestone-pct {
		font-size: 10px;
		color: #6c7086;
	}

	.progress-bar {
		height: 5px;
		background: #1e1e2e;
		border-radius: 3px;
		overflow: hidden;
		margin-bottom: 6px;
	}
	.progress-bar.small { height: 3px; margin-bottom: 0; }

	.progress-fill {
		height: 100%;
		border-radius: 3px;
		transition: width 0.3s;
	}
	.progress-fill.green { background: #a6e3a1; }
	.progress-fill.yellow { background: #f9e2af; }
	.progress-fill.red { background: #f38ba8; }

	/* ==================== Terminal Container ==================== */
	.term-container {
		flex: 1;
		min-height: 0;
		background: #1e1e2e;
		border: 1px solid #1e1e2e;
		border-left: none;
		border-right: none;
		min-width: 0;
		position: relative;
		overflow: hidden;
	}

	/* Ambient glow */
	.term-container::before {
		content: '';
		position: absolute;
		inset: 0;
		background:
			radial-gradient(ellipse 80% 60% at 20% 80%, rgba(137,180,250,0.06), transparent 60%),
			radial-gradient(ellipse 60% 50% at 80% 20%, rgba(180,130,250,0.05), transparent 50%),
			radial-gradient(ellipse 70% 50% at 50% 50%, rgba(100,220,180,0.03), transparent 60%);
		pointer-events: none;
		z-index: 0;
		animation: terminalGlow 12s ease-in-out infinite alternate;
	}

	@keyframes terminalGlow {
		0% { opacity: 0.7; }
		50% { opacity: 1; }
		100% { opacity: 0.7; }
	}

	/* Perf widget */
	.perf-widget {
		padding: 8px;
	}
	.perf-metric {
		display: flex;
		justify-content: space-between;
		padding: 6px 8px;
		border-bottom: 1px solid #1e1e2e;
		font-size: 12px;
	}
	.perf-label { color: #a6adc8; }
	.perf-value { color: #a6e3a1; font-weight: bold; font-family: 'JetBrains Mono', monospace; }
	.perf-value.perf-warn { color: #f9e2af; }
	.perf-value.perf-bad { color: #f38ba8; }
	.perf-section-title {
		font-size: 11px;
		font-weight: bold;
		color: #89b4fa;
		padding: 4px 8px;
		text-transform: uppercase;
		letter-spacing: 0.5px;
	}
	.perf-proc {
		padding: 6px 8px;
		border-bottom: 1px solid #1e1e2e;
	}
	.perf-proc.perf-zombie {
		background: rgba(243, 139, 168, 0.1);
		border-left: 2px solid #f38ba8;
	}
	.perf-proc-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
	}
	.perf-proc-name {
		font-size: 12px;
		color: #cdd6f4;
	}
	.perf-proc-name.vital {
		color: #a6e3a1;
	}
	.perf-proc-name.vital::before {
		content: '\u25CF ';
		font-size: 8px;
	}
	.perf-proc-stats {
		display: flex;
		gap: 12px;
		font-size: 10px;
		color: #6c7086;
		margin-top: 2px;
		font-family: 'JetBrains Mono', monospace;
	}
	.perf-kill-btn {
		background: #f38ba8;
		color: #1e1e2e;
		border: none;
		border-radius: 3px;
		font-size: 10px;
		padding: 1px 6px;
		cursor: pointer;
		font-weight: bold;
	}
	.perf-kill-btn:hover { background: #eba0ac; }
	.perf-status { justify-content: center; margin-top: 8px; border: none; }
	.perf-good { color: #a6e3a1; }
	.perf-warn { color: #f9e2af; }
	.perf-bad { color: #f38ba8; font-weight: bold; }

	/* Pi watermark */
	.term-container::after {
		content: '\u03A0';
		position: absolute;
		bottom: 12px;
		right: 16px;
		font-size: 64px;
		font-weight: 700;
		color: rgba(137, 180, 250, 0.04);
		pointer-events: none;
		z-index: 0;
		user-select: none;
		line-height: 1;
	}

	/* Server-rendered terminal output */
	.term-container :global(.term-output) {
		position: relative;
		z-index: 1;
		background: #1e1e2e;
		max-width: 100%;
	}
	.term-container :global(.term-screen),
	.term-container :global(.term-scrollback) {
		overflow-x: hidden;
		max-width: 100%;
		white-space: pre-wrap;
		word-break: break-word;
		overflow-wrap: break-word;
	}
	.term-container :global(.t-line) {
		padding: 0;
		margin: 0;
		line-height: 1.4;
	}
	.term-container :global(.t-user) {
		margin-top: 6px;
	}
	.term-container :global(.t-out) {
		color: #cdd6f4;
		padding-left: 0;
	}
	.term-container :global(.t-assistant) {
		margin-top: 4px;
	}
	.term-container :global(.t-tool) {
		padding-left: 2em;  /* ~1 tab indent for visibility */
	}

	/* Turn grouping: each speaker run is a block with a left gutter bar,
	   a small header (name · time), and visible spacing between turns.
	   This is the readability pass — distinct visual chunks per speaker. */
	.term-container :global(.turn) {
		display: block;
		margin: 10px 0 12px 0;
		padding: 2px 0 2px 10px;
		border-left: 3px solid #313244;
	}
	.term-container :global(.turn + .turn) {
		border-top: 1px solid #1e1e2e;
		padding-top: 6px;
	}
	.term-container :global(.turn-user) { border-left-color: #89b4fa; }
	.term-container :global(.turn-assistant) { border-left-color: #fab387; }
	.term-container :global(.turn-tool) {
		border-left-color: #45475a;
		opacity: 0.62;  /* dim tool/system noise so it doesn't fight prompts */
	}
	.term-container :global(.turn-head) {
		display: flex;
		align-items: baseline;
		gap: 8px;
		font-size: 11px;
		margin-bottom: 2px;
		list-style: none;
		cursor: pointer;
	}
	.term-container :global(.turn-head::-webkit-details-marker) { display: none; }
	.term-container :global(.turn-name) {
		color: #cdd6f4;
		font-weight: 700;
		letter-spacing: 0.3px;
	}
	.term-container :global(.turn-user .turn-name) { color: #89b4fa; }
	.term-container :global(.turn-assistant .turn-name) { color: #fab387; }
	.term-container :global(.turn-time) { color: #585b70; font-size: 10px; }
	.term-container :global(.turn-model) {
		color: #cba6f7;
		font-size: 9.5px;
		background: #1e1e2e;
		border: 1px solid #313244;
		border-radius: 3px;
		padding: 0 5px;
		font-family: ui-monospace, monospace;
	}
	.term-container :global(.turn-collapsed[open]) { opacity: 1; }
	.term-container :global(.turn-collapsed:not([open]) .t-line) { display: none; }
	.term-container :global(.t-pending-echo) {
		opacity: 0.75;  /* dim until the transcript confirms it landed */
	}

	.term-empty {
		position: absolute;
		inset: 0;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		color: #45475a;
		z-index: 2;
	}
	.term-empty-icon {
		font-size: 48px;
		margin-bottom: 16px;
	}
	.term-empty-title {
		font-size: 16px;
		margin-bottom: 8px;
	}
	.term-empty-sub {
		font-size: 13px;
	}

	/* ==================== Panel Toggle ==================== */

	/* ==================== Right Panel ==================== */
	.right-panel {
		transition: width 0.2s ease, min-width 0.2s ease, padding 0.2s ease;
		background: #12121a;
		border: 1px solid #1e1e2e;
		border-radius: 0 6px 6px 0;
		overflow-y: auto;
		overflow-x: hidden;
		font-size: 12px;
		flex-shrink: 0;
		display: flex;
		flex-direction: column;
	}


	.right-header {
		display: flex;
		align-items: center;
		gap: 4px;
		padding: 6px 8px;
		border-bottom: 1px solid #1e1e2e;
		position: sticky;
		top: 0;
		background: #12121a;
		z-index: 1;
	}

	.right-select {
		flex: 1;
		background: #0a0a0f;
		color: #cdd6f4;
		border: 1px solid #1e1e2e;
		border-radius: 4px;
		padding: 5px 8px;
		font-size: 12px;
		font-weight: 500;
		outline: none;
	}
	.right-select:focus { border-color: #89b4fa; }

	.right-content {
		padding: 10px;
		flex: 1;
		overflow-y: auto;
		overflow-x: hidden;
		min-width: 0;
	}

	/* ==================== Services ==================== */
	.svc-category {
		font-size: 11px;
		font-weight: 600;
		color: #6c7086;
		text-transform: uppercase;
		letter-spacing: 0.5px;
		padding: 8px 0 4px;
	}
	.svc-category:first-child { padding-top: 0; }
	.svc-row {
		display: flex;
		align-items: flex-start;
		gap: 8px;
		padding: 6px 0;
	}
	.svc-dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		margin-top: 4px;
		flex-shrink: 0;
		background: #6c7086;
	}
	.svc-dot.up { background: #a6e3a1; }
	.svc-dot.down { background: #f38ba8; }
	.svc-dot.unknown { background: #6c7086; }
	.svc-name {
		font-size: 13px;
		font-weight: 500;
		color: #cdd6f4;
	}
	.svc-detail {
		font-size: 11px;
		color: #6c7086;
	}

	/* ==================== Tasks ==================== */
	.task-group-header {
		font-size: 11px;
		font-weight: 600;
		color: #6c7086;
		padding: 6px 0 3px;
		border-bottom: 1px solid #1e1e2e;
		text-transform: uppercase;
		letter-spacing: 0.5px;
	}

	.task-row {
		display: flex;
		align-items: flex-start;
		gap: 6px;
		padding: 3px 0;
		cursor: pointer;
	}
	.task-row:hover { opacity: 0.8; }

	.task-icon {
		flex-shrink: 0;
		width: 14px;
		text-align: center;
		color: #6c7086;
	}
	.task-icon.done { color: #a6e3a1; }
	.task-icon.in-progress { color: #f9e2af; }
	.task-icon.bug { color: #f38ba8; }
	.task-icon.bug.done { color: #a6e3a1; }

	.task-title {
		flex: 1;
	}
	.task-title.done {
		text-decoration: line-through;
		color: #6c7086;
	}

	.filter-header {
		padding: 4px 0 8px;
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: 12px;
	}

	.filter-clear {
		background: none;
		border: none;
		color: #6c7086;
		cursor: pointer;
		font-size: 11px;
	}
	.filter-clear:hover { color: #cdd6f4; }

	.add-row {
		margin-top: 8px;
		display: flex;
		gap: 4px;
	}

	.add-input {
		flex: 1;
		background: #0a0a0f;
		color: #cdd6f4;
		border: 1px solid #1e1e2e;
		border-radius: 4px;
		padding: 4px 6px;
		font-size: 11px;
		outline: none;
	}
	.add-input:focus { border-color: #89b4fa; }

	.panel-hint {
		margin-top: 8px;
		text-align: center;
		color: #45475a;
		font-size: 10px;
	}

	.usage-section { margin-bottom: 16px; }
	.usage-heading { color: #89b4fa; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 6px; padding-bottom: 4px; border-bottom: 1px solid #313244; }
	.usage-subhead { color: #a6adc8; font-size: 10px; font-weight: 600; margin-top: 8px; margin-bottom: 4px; }
	.usage-row { display: flex; justify-content: space-between; align-items: center; padding: 2px 0; font-size: 11px; }
	.usage-label { color: #a6adc8; }
	.usage-val { color: #cdd6f4; font-weight: 500; font-variant-numeric: tabular-nums; }
	.usage-hint { text-align: center; color: #45475a; font-size: 10px; margin-top: 8px; }
	.usage-bar-wrap { width: 100%; height: 6px; background: #1e1e2e; border-radius: 3px; overflow: hidden; margin: 4px 0 2px; }
	.usage-bar { height: 100%; border-radius: 3px; transition: width 0.3s ease; }

	.delete-section {
		display: block;
		margin: 12px auto 0;
		background: none;
		border: none;
		color: #f38ba8;
		cursor: pointer;
		font-size: 10px;
	}
	.delete-section:hover { text-decoration: underline; }

	/* ==================== Tests ==================== */
	.tests-panel { padding: 8px 12px; }
	.test-run-btn {
		width: 100%;
		padding: 8px;
		border: 1px solid #89b4fa;
		border-radius: 6px;
		background: rgba(137, 180, 250, 0.1);
		color: #89b4fa;
		font-size: 12px;
		font-weight: 600;
		cursor: pointer;
		margin-bottom: 10px;
	}
	.test-run-btn:hover { background: rgba(137, 180, 250, 0.2); }
	.test-run-btn:disabled { opacity: 0.5; cursor: default; }
	.test-desc { font-size: 11px; color: #6c7086; margin-bottom: 8px; }
	.test-icon.pending { color: #45475a; }
	.test-row {
		display: flex;
		align-items: flex-start;
		gap: 8px;
		padding: 6px 0;
		border-bottom: 1px solid #1e1e2e;
	}
	.test-icon { font-size: 14px; flex-shrink: 0; margin-top: 1px; }
	.test-icon.pass { color: #a6e3a1; }
	.test-icon.fail { color: #f38ba8; }
	.test-icon.running { color: #f9e2af; animation: micPulse 1s infinite; }
	.test-info { flex: 1; min-width: 0; }
	.test-name { font-size: 12px; color: #cdd6f4; }
	.test-detail { font-size: 10px; color: #6c7086; margin-top: 1px; }
	.test-detail.fail { color: #f38ba8; }
	.test-summary {
		margin-top: 8px;
		padding: 6px 8px;
		border-radius: 4px;
		font-size: 11px;
		font-weight: 600;
		background: rgba(243, 139, 168, 0.1);
		color: #f38ba8;
	}
	.test-summary.all-pass {
		background: rgba(166, 227, 161, 0.1);
		color: #a6e3a1;
	}

	/* ==================== Approvals ==================== */
	.approval-row {
		padding: 8px 12px;
		border-bottom: 1px solid #1e1e2e;
	}
	.approval-tool {
		font-size: 12px;
		font-weight: 600;
		color: #cdd6f4;
		margin-bottom: 2px;
	}
	.approval-desc {
		font-size: 11px;
		color: #6c7086;
		margin-bottom: 6px;
		word-break: break-word;
	}
	.approval-actions {
		display: flex;
		gap: 6px;
	}
	.approval-btn {
		padding: 3px 10px;
		border: none;
		border-radius: 4px;
		font-size: 11px;
		cursor: pointer;
	}
	.approval-btn.approve {
		background: #a6e3a1;
		color: #1e1e2e;
	}
	.approval-btn.deny {
		background: #f38ba8;
		color: #1e1e2e;
	}
	.approval-btn:hover {
		opacity: 0.8;
	}

	/* ==================== Setup Guide ==================== */
	.setup-guide {
		padding: 4px;
		font-size: 13px;
		color: #6c7086;
		line-height: 1.6;
	}
	.setup-title {
		font-weight: 700;
		font-size: 14px;
		color: #cdd6f4;
		margin-bottom: 10px;
	}
	.setup-desc { margin-bottom: 10px; }
	.setup-items {
		display: grid;
		gap: 8px;
	}
	.setup-items strong { color: #cdd6f4; }
	.setup-controls {
		margin-top: 14px;
		padding-top: 12px;
		border-top: 1px solid #1e1e2e;
	}
	.setup-controls-title {
		font-weight: 600;
		font-size: 12px;
		color: #cdd6f4;
		margin-bottom: 6px;
	}
	.setup-controls strong { color: #cdd6f4; }
	.setup-controls span { color: #6c7086; }
	.setup-hint {
		margin-top: 10px;
		font-size: 12px;
		color: #6c7086;
	}

	/* ==================== Empty States ==================== */
	.empty-state {
		color: #45475a;
		padding: 12px;
		text-align: center;
	}
	.empty-state.small {
		padding: 0 12px;
		font-size: 11px;
	}

	/* ==================== Atlas ==================== */
	.atlas-container {
		flex: 1;
		min-height: 0;
		position: relative;
		overflow: hidden;
		background: #0e0e16;
		user-select: none;
	}
	.atlas-toolbar {
		position: absolute;
		top: 8px;
		left: 8px;
		z-index: 10;
		display: flex;
		gap: 6px;
		align-items: center;
	}
	.atlas-btn {
		background: #1e1e2e;
		border: 1px solid #313244;
		color: #cdd6f4;
		padding: 4px 10px;
		border-radius: 4px;
		cursor: pointer;
		font-size: 12px;
	}
	.atlas-btn:hover { background: #313244; }
	.atlas-zoom {
		color: #6c7086;
		font-size: 11px;
		margin-left: 4px;
	}
	.atlas-stat {
		color: #585b70;
		font-size: 10px;
		margin-left: 8px;
		background: #1e1e2e;
		padding: 2px 6px;
		border-radius: 3px;
	}
	.atlas-svg {
		width: 100%;
		height: 100%;
	}
	.atlas-detail {
		position: absolute;
		bottom: 12px;
		left: 12px;
		background: #1e1e2e;
		border: 1px solid #313244;
		border-radius: 8px;
		padding: 12px 16px;
		min-width: 280px;
		max-width: 420px;
		max-height: 60%;
		overflow-y: auto;
		z-index: 10;
		box-shadow: 0 4px 16px rgba(0,0,0,0.4);
	}
	.atlas-detail-header {
		display: flex;
		align-items: center;
		gap: 8px;
		margin-bottom: 8px;
		padding-bottom: 8px;
		border-bottom: 1px solid #313244;
	}
	.atlas-detail-header strong {
		color: #cdd6f4;
		font-size: 14px;
	}
	.atlas-detail-dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		display: inline-block;
	}
	.atlas-detail-type {
		font-size: 10px;
		text-transform: uppercase;
		letter-spacing: 0.5px;
	}
	.atlas-detail-close {
		margin-left: auto;
		background: none;
		border: none;
		color: #6c7086;
		cursor: pointer;
		font-size: 16px;
	}
	.atlas-detail-close:hover { color: #cdd6f4; }
	.atlas-nav-btn {
		display: block;
		width: 100%;
		margin-top: 8px;
		padding: 6px 12px;
		background: #313244;
		border: 1px solid #45475a;
		color: #89b4fa;
		border-radius: 4px;
		cursor: pointer;
		font-size: 11px;
		text-align: center;
	}
	.atlas-nav-btn:hover { background: #45475a; color: #cdd6f4; }
	.atlas-detail-body {
		font-size: 11px;
		color: #a6adc8;
		line-height: 1.5;
	}
	.atlas-detail-status {
		display: flex;
		align-items: center;
		gap: 6px;
		font-weight: 600;
		margin-bottom: 4px;
	}
	.atlas-detail-status-dot {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		display: inline-block;
	}
	.atlas-detail-info {
		color: #89b4fa;
		font-size: 11px;
		margin-bottom: 6px;
	}
	.atlas-detail-desc {
		color: #bac2de;
		font-size: 11px;
		line-height: 1.6;
		margin-bottom: 8px;
	}
	.atlas-detail-section-title {
		font-size: 10px;
		text-transform: uppercase;
		letter-spacing: 0.5px;
		color: #6c7086;
		margin: 8px 0 4px;
		font-weight: 600;
	}
	.atlas-detail-connections {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
	.atlas-detail-conn {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 3px 6px;
		background: #181825;
		border: 1px solid transparent;
		border-radius: 4px;
		cursor: pointer;
		font-size: 11px;
		color: #a6adc8;
		text-align: left;
		width: 100%;
	}
	.atlas-detail-conn:hover {
		border-color: #45475a;
		background: #1e1e2e;
		color: #cdd6f4;
	}
	.atlas-detail-conn-dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		display: inline-block;
		flex-shrink: 0;
	}
	.atlas-detail-conn-name {
		flex: 1;
	}
	.atlas-detail-conn-label {
		color: #585b70;
		font-size: 10px;
		font-style: italic;
	}
	.atlas-detail-conn-dir {
		color: #585b70;
		font-size: 12px;
	}
	.atlas-detail-file {
		display: block;
		background: #181825;
		padding: 3px 6px;
		border-radius: 3px;
		font-family: 'Cascadia Code', 'JetBrains Mono', monospace;
		font-size: 10px;
		color: #a6e3a1;
		margin-bottom: 2px;
		word-break: break-all;
	}

	/* ==================== Apps Grid ==================== */
	.instances-panel { padding: 8px; }
	.instance-row {
		display: flex; align-items: center; gap: 8px;
		padding: 8px; border-radius: 6px; margin-bottom: 4px;
		background: #1e1e2e;
	}
	.instance-btn {
		margin-left: auto; padding: 4px 12px; border-radius: 4px;
		background: #313244; color: #cdd6f4; border: 1px solid #45475a;
		cursor: pointer; font-size: 12px;
	}
	.instance-btn:hover { background: #45475a; }
	.instance-note {
		padding: 8px; margin-top: 8px; font-size: 11px;
		color: #a6adc8; background: #181825; border-radius: 6px;
	}
	.apps-grid {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 8px;
		padding: 8px;
	}
	.app-card {
		background: #1e1e2e;
		border: 1px solid #313244;
		border-radius: 8px;
		padding: 12px 8px;
		text-align: center;
		cursor: pointer;
		transition: all 0.15s;
	}
	.app-card:hover {
		border-color: #89b4fa;
		background: #181825;
	}
	.app-icon {
		font-size: 24px;
		margin-bottom: 4px;
	}
	.app-name {
		color: #cdd6f4;
		font-size: 12px;
		font-weight: 600;
	}
	.app-desc {
		color: #6c7086;
		font-size: 10px;
		margin-top: 2px;
	}
</style>
