<script>
	import { onMount, tick } from 'svelte';
	import { api, wsUrl } from '$lib/api.js';
	import { getActiveProject, setActiveProject, sortProjects, getTerminalInput, setTerminalInput } from '$lib/stores.svelte.js';

	// --- State ---
	let projects = $state([]);
	let tabs = $state([]);
	let activeTabId = $state(null);
	let leftSection = $state('transcript'); // same widget options as right panel
	let centerView = $state('terminal'); // 'terminal' | 'chat'
	let rightSection = $state('services'); // alphabetized panel widgets
	// Terminal input bar — persisted across tab switches
	let terminalInputText = $state(getTerminalInput());
	let terminalInputEl;

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
				tabIndex: i
			}));
			localStorage.setItem('pan-terminal-sessions', JSON.stringify(state));
			localStorage.setItem('pan-terminal-active', activeTabId || '');

			// Save to DB for persistence across restarts
			api('/dashboard/api/open-tabs', {
				method: 'POST',
				body: JSON.stringify({ tabs: state.map(t => ({
					session_id: t.sessionId,
					tab_name: t.tabName || '',
					project_id: t.projectId,
					cwd: t.cwd,
					tab_index: t.tabIndex
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
			return tabs.map(t => ({
				sessionId: t.session_id,
				tabName: t.tab_name || '',
				project: t.project_name || 'Shell',
				cwd: t.project_path || t.cwd || 'C:\\Users\\tzuri\\Desktop',
				projectId: t.project_id
			}));
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
	let voiceSettings = $state({});
	let isListening = $state(false);
	let recognition = null;
	let pastedImages = $state([]); // { dataUrl, path } — preview before send

	// Perf widget
	let perfData = $state({ wsLatency: 0, domTime: 0, linesChanged: 0, serverRender: 0, serverTotal: 0, msgSize: 0, fps: 0 });
	let perfProcesses = $state([]);
	let perfProcessTimer = null;
	let perfFrames = 0;
	let perfLastFpsTime = Date.now();

	async function loadPerfProcesses() {
		try {
			const data = await api('/dashboard/api/processes');
			if (data?.processes) perfProcesses = data.processes;
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

		const sessionId = sessionPrefix + (projectName || 'shell').toLowerCase().replace(/[^a-z0-9]/g, '-');

		// Check if tab already exists
		const existing = tabs.find(t => t.sessionId === sessionId);
		if (existing) {
			switchToTab(existing.id);
			return;
		}

		await createTab(sessionId, projectName, cwd, projectId, false, null);
	}

	function newTerminalTab() {
		const active = getActiveTab();
		const projectName = active?.project || 'Shell';
		const projectId = active?.projectId || null;
		const cwd = active?.cwd || 'C:\\Users\\tzuri\\Desktop';
		const sessionId = sessionPrefix + (projectName || 'shell').toLowerCase().replace(/[^a-z0-9]/g, '-') + '-' + Date.now();
		createTab(sessionId, projectName, cwd, projectId, false, null);
	}

	async function createTab(sessionId, projectName, cwd, projectId, isReconnect, tabName) {
		const tabId = 'tab-' + (++tabCounter);

		// Server-side rendered terminal — just a scrollable div that displays pre-rendered HTML lines
		const tabContainer = document.createElement('div');
		tabContainer.id = 'term-' + tabId;
		tabContainer.className = 'term-output';
		tabContainer.style.cssText = 'position:absolute;top:0;left:0;right:0;bottom:0;display:none;overflow-y:auto;overflow-x:hidden;font-family:"JetBrains Mono","Cascadia Code",Consolas,monospace;font-size:14px;line-height:1.5;color:#cdd6f4;background:#1e1e2e;';

		// Scrollback div (history above visible screen)
		const scrollbackDiv = document.createElement('div');
		scrollbackDiv.className = 'term-scrollback';
		scrollbackDiv.style.cssText = 'padding:8px 12px;white-space:pre;';
		tabContainer.appendChild(scrollbackDiv);

		// Screen div (current visible terminal screen) — uses per-line divs for efficient diffing
		const screenDiv = document.createElement('div');
		screenDiv.className = 'term-screen';
		screenDiv.style.cssText = 'padding:0 12px;white-space:pre;min-height:100%;';
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
			claudeSessionIds: [],
			userScrolledUp: false,
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

		// Connect WebSocket — server sends pre-rendered HTML via ScreenBuffer
		{
			const wsUrlStr = wsUrl(`/ws/terminal?session=${encodeURIComponent(sessionId)}&project=${encodeURIComponent(projectName)}&cwd=${encodeURIComponent(cwd)}&cols=120&rows=30`);

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
			}

			function stopPing() {
				if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
			}

			function handleMessage(event) {
				try {
					const tRecv = performance.now();
					const msg = JSON.parse(event.data);
					switch (msg.type) {
						case 'screen': {
							// Server sends pre-rendered HTML lines — diff per-line to avoid DOM thrashing
							if (msg.scrollback && msg.scrollback.length > 0) {
								scrollbackDiv.innerHTML = msg.scrollback.join('\n');
							}

							const lines = msg.lines;
							// Ensure correct number of line divs
							while (screenDiv.children.length < lines.length) {
								const div = document.createElement('div');
								screenDiv.appendChild(div);
							}
							while (screenDiv.children.length > lines.length) {
								screenDiv.removeChild(screenDiv.lastChild);
							}
							// Only update lines that changed
							let linesChanged = 0;
							for (let li = 0; li < lines.length; li++) {
								if (lines[li] !== prevLines[li]) {
									screenDiv.children[li].innerHTML = lines[li];
									linesChanged++;
								}
							}
							prevLines = lines.slice();

							// Perf metrics
							const tDom = performance.now();
							const wsLatency = msg._ts ? (Date.now() - msg._ts) : -1;
							const domTime = +(tDom - tRecv).toFixed(1);
							const serverPerf = msg._perf || {};
							updatePerfOverlay({
								wsLatency,
								domTime,
								linesChanged,
								serverRender: serverPerf.render || 0,
								serverSerialize: serverPerf.serialize || 0,
								serverTotal: serverPerf.total || 0,
								msgSize: serverPerf.msgSize || event.data.length,
							});

							// Auto-scroll to bottom unless user scrolled up
							if (!tabData.userScrolledUp) {
								tabContainer.scrollTop = tabContainer.scrollHeight;
							}

							// Detect if buffer has content (for auto-launch logic)
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
						case 'exit':
							screenDiv.innerHTML += '\n<span style="color:#585b70">[Session ended]</span>';
							break;
						case 'error':
							screenDiv.innerHTML += '\n<span style="color:#f38ba8">[Error: ' + msg.message + ']</span>';
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
							break;
						}
						case 'permission_prompt':
							break;
						case 'server_restarting':
							serverRestarting = true;
							reconnectAttempts = 0;
							screenDiv.innerHTML += '\n<span style="color:#f9e2af">[Server restarting \u2014 will reconnect automatically...]</span>';
							break;
					}
				} catch {}
			}

			function reconnect() {
				if (reconnectTimer) return;
				reconnectAttempts++;
				const delay = Math.min(reconnectAttempts * 1000, 5000);
				const label = serverRestarting ? 'Server restarting' : 'Reconnecting';
				screenDiv.innerHTML += `\n<span style="color:#f9e2af">[${label}... attempt ${reconnectAttempts}]</span>`;

				reconnectTimer = setTimeout(() => {
					reconnectTimer = null;
					if (tabData.ws && tabData.ws.readyState <= 1) return;

					const newWs = new WebSocket(wsUrlStr);
					newWs.onopen = () => {
						reconnectAttempts = 0;
						serverRestarting = false;
						tabData.ws = newWs;
						screenDiv.innerHTML += '\n<span style="color:#a6e3a1">[Reconnected]</span>';
						startPing();
					};
					newWs.onmessage = handleMessage;
					newWs.onclose = () => {
						stopPing();
						if (tabData._closing) return;
						if (reconnectAttempts < 30) reconnect();
						else screenDiv.innerHTML += '\n<span style="color:#f38ba8">[Connection lost \u2014 refresh page to retry]</span>';
					};
					newWs.onerror = () => {};
				}, delay);
			}

			ws.onopen = () => {
				startPing();

				// Auto-launch Claude for project tabs
				if (projectName && projectName !== 'Shell') {
					setTimeout(async () => {
						if (ws.readyState === 1 && !tabData.claudeStarted && !hasExistingBuffer) {
							tabData.claudeStarted = true;
							let briefingReady = false;
							try {
								const briefingData = await fetch('/api/v1/context-briefing?project_path=' + encodeURIComponent(cwd)).then(r => r.json());
								if (briefingData.briefing) {
									ws.send(JSON.stringify({ type: 'input', data: "cat > .pan-briefing.md << 'PANBRIEFEOF'\n" + briefingData.briefing + "\nPANBRIEFEOF\n" }));
									briefingReady = true;
									await new Promise(r => setTimeout(r, 500));
								}
							} catch {}

							if (briefingReady) {
								ws.send(JSON.stringify({ type: 'input', data: 'printf "\\033[1;96m\u03A0\u0391\u039D remembers..\\033[0m\\n" && claude --permission-mode auto "\u03A0\u0391\u039D remembers..."\n' }));
							} else {
								ws.send(JSON.stringify({ type: 'input', data: 'claude --permission-mode auto\n' }));
							}
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

			let sessionIds = [];
			if (realSessionId) {
				sessionIds = [realSessionId];
			} else {
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
				const data = await api('/dashboard/api/transcript?session_id=' + encodeURIComponent(sid) + '&limit=300');
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

			for (const msg of allMessages) {
				const accentColor = multiSession ? (sessionColors[msg._sessionIdx] || 'var(--accent)') : 'var(--accent)';
				if (msg.role === 'user') {
					if (msg.text && /^\u03A0\u0391\u039D remembers/i.test(msg.text.trim())) continue;
					newBubbles.push({
						type: 'user',
						text: msg.text || '',
						accentColor,
						multiSession,
					});
				} else if (msg.type === 'text') {
					newBubbles.push({
						type: 'assistant',
						text: msg.text || '',
						accentColor,
						multiSession,
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
				const data = await api('/dashboard/api/transcript?session_id=' + encodeURIComponent(sid) + '&limit=200');
				if (data?.messages) all.push(...data.messages);
			}));
			all.sort((a, b) => (a.ts || '').localeCompare(b.ts || ''));
			centerChatMessages = all;
			await tick();
			if (centerChatEl) centerChatEl.scrollTop = centerChatEl.scrollHeight;
		} catch (err) {
			console.error('[Center Chat] load error:', err);
		}
	}

	function sendTerminalInput() {
		let text = terminalInputText.trim();
		const imgPaths = pastedImages.filter(img => img.path).map(img => img.path.replace(/\\\\/g, '/').replace(/\\/g, '/'));
		if (imgPaths.length) text = (text ? text + ' ' : '') + imgPaths.join(' ');
		// Allow empty Enter — Claude Code needs it for approvals/confirmations
		terminalInputText = '';
		setTerminalInput('');
		pastedImages = [];
		// Reset textarea height
		if (terminalInputEl) terminalInputEl.style.height = 'auto';

		// Send to the terminal session via WebSocket (empty = just \r for approvals)
		const active = getActiveTab();
		if (active?.ws?.readyState === 1) {
			active.ws.send(JSON.stringify({ type: 'input', data: (text ? text + '\r' : '\r') }));
		}
	}

	function handleTerminalInputKey(e) {
		const active = getActiveTab();
		const ws = active?.ws?.readyState === 1 ? active.ws : null;

		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			sendTerminalInput();
			return;
		}
		// Escape → Ctrl+C to interrupt Claude
		if (e.key === 'Escape') {
			e.preventDefault();
			e.stopPropagation();
			if (ws) ws.send(JSON.stringify({ type: 'input', data: '\x03' }));
			return;
		}
		// Number keys 1-3 when input is empty → navigate Claude Code approval prompt
		// The prompt is a TUI select list: arrow-down to move, Enter to confirm
		// Check both the DOM value and the Svelte state to cover all timing cases
		if (/^[1-3]$/.test(e.key) && (e.target.value.length === 0 || !e.target.value.trim())) {
			e.preventDefault();
			e.stopImmediatePropagation();
			// Clear any residual value
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
		const el = e.target;
		el.style.height = 'auto';
		const lineHeight = 20;
		const maxLines = 5;
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

	function toggleVoiceInput() {
		if (isListening) {
			stopVoiceStreaming();
		} else {
			startVoiceStreaming();
		}
	}

	async function startVoiceStreaming() {
		try {
			// Get mic stream
			voiceStream = await navigator.mediaDevices.getUserMedia({
				audio: { sampleRate: 16000, channelCount: 1, echoCancellation: true, noiseSuppression: true }
			});
			isListening = true;

			// Connect WebSocket to Whisper streaming server
			const wsPort = 7783; // Whisper WS port = HTTP port + 1
			voiceWs = new WebSocket(`ws://127.0.0.1:${wsPort}`);
			voiceWs.binaryType = 'arraybuffer';

			voiceWs.onmessage = (e) => {
				try {
					const msg = JSON.parse(e.data);
					if (msg.text !== undefined) {
						terminalInputText = msg.text;
					}
					if (msg.action === 'send' && msg.type === 'final') {
						// "over" trigger — auto-send
						setTimeout(() => sendTerminalInput(), 100);
						stopVoiceStreaming();
					}
				} catch {}
			};

			voiceWs.onclose = () => {
				if (isListening) stopVoiceStreaming();
			};

			voiceWs.onerror = (err) => {
				console.error('[Voice] WS error:', err);
				// Fall back to batch mode
				stopVoiceStreaming();
				startBatchRecording();
			};

			// Wait for WS to open, then start streaming audio
			voiceWs.onopen = () => {
				voiceWs.send(JSON.stringify({ type: 'config', sample_rate: 16000 }));
				startAudioStreaming(voiceStream);
			};
		} catch (err) {
			console.error('[Voice] Mic access failed:', err);
			isListening = false;
		}
	}

	function startAudioStreaming(stream) {
		// Use AudioWorklet or ScriptProcessor to get raw PCM
		voiceContext = new AudioContext({ sampleRate: 16000 });
		const source = voiceContext.createMediaStreamSource(stream);

		// ScriptProcessor for broad compatibility (AudioWorklet needs separate file)
		voiceProcessor = voiceContext.createScriptProcessor(4096, 1, 1);
		voiceProcessor.onaudioprocess = (e) => {
			if (!voiceWs || voiceWs.readyState !== 1) return;
			const float32 = e.inputBuffer.getChannelData(0);
			// Convert float32 to int16 PCM
			const int16 = new Int16Array(float32.length);
			for (let i = 0; i < float32.length; i++) {
				int16[i] = Math.max(-32768, Math.min(32767, Math.round(float32[i] * 32767)));
			}
			voiceWs.send(int16.buffer);
		};

		source.connect(voiceProcessor);
		voiceProcessor.connect(voiceContext.destination);
	}

	function stopVoiceStreaming() {
		isListening = false;
		if (voiceWs && voiceWs.readyState === 1) {
			voiceWs.send(JSON.stringify({ type: 'stop' }));
			// Wait briefly for final transcription before closing
			setTimeout(() => { try { voiceWs.close(); } catch {} }, 1000);
		}
		if (voiceProcessor) { try { voiceProcessor.disconnect(); } catch {} voiceProcessor = null; }
		if (voiceContext) { try { voiceContext.close(); } catch {} voiceContext = null; }
		if (voiceStream) { voiceStream.getTracks().forEach(t => t.stop()); voiceStream = null; }
	}

	// Batch fallback if WebSocket streaming isn't available
	let mediaRecorder = null;
	let audioChunks = [];

	function startBatchRecording() {
		navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
			mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
			audioChunks = [];
			isListening = true;
			mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) audioChunks.push(e.data); };
			mediaRecorder.onstop = async () => {
				stream.getTracks().forEach(t => t.stop());
				isListening = false;
				if (audioChunks.length === 0) return;
				const blob = new Blob(audioChunks, { type: 'audio/webm' });
				try {
					const resp = await fetch('/api/v1/whisper/transcribe', {
						method: 'POST', headers: { 'Content-Type': 'audio/webm' }, body: blob,
					});
					if (resp.ok) {
						const data = await resp.json();
						if (data.text) terminalInputText = (terminalInputText ? terminalInputText + ' ' : '') + data.text.trim();
						if (data.action === 'send') setTimeout(() => sendTerminalInput(), 100);
					}
				} catch (err) { console.error('[Voice] Batch transcribe failed:', err); }
			};
			mediaRecorder.start();
		}).catch(() => { isListening = false; });
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
	async function loadAtlasData() {
		atlasLoading = true;
		try {
			const [svcResp, jobsResp, statsResp, projResp] = await Promise.all([
				api('/dashboard/api/services'),
				api('/dashboard/api/jobs'),
				api('/dashboard/api/stats'),
				api('/dashboard/api/projects'),
			]);
			atlasData = buildAtlasGraph(svcResp, jobsResp, statsResp, projResp);
		} catch (e) {
			console.error('Atlas load failed:', e);
		}
		atlasLoading = false;
	}

	function buildAtlasGraph(svcResp, jobsResp, statsResp, projResp) {
		const nodes = [];
		const edges = [];
		const nodeMap = {};
		const zones = [];

		function addNode(id, label, type, status, detail, group, x, y, description) {
			const n = { id, label, type, status: status || 'unknown', detail: detail || '', group, x, y, description: description || '' };
			nodes.push(n);
			nodeMap[id] = n;
			return n;
		}

		function addZone(id, label, x, y, w, h, color) {
			zones.push({ id, label, x, y, w, h, color });
		}

		// ==================== ZONES ====================
		// Layout: 1500x1000 viewBox — generous spacing, readable labels
		//
		//  ┌── Intelligence ─────────┐  ┌──── Core ────┐  ┌── Services ──────────┐
		//  │ Claude Code             │  │              │  │ Dashboard   Steward  │
		//  │ Task Router             │  │  PAN Server  │  │ Whisper     Tauri    │
		//  │ WASM Fast   Token Cache │  │              │  │                      │
		//  └─────────────────────────┘  └──────────────┘  └──────────────────────┘
		//  ┌── Memory ─────────────────────────────────┐  ┌── Processing ────────┐
		//  │ SQLite DB    Memory Hub    Embeddings     │  │ Classifier   Dream   │
		//  │ Episodic   Semantic   Procedural          │  │ Consolidation  Evol  │
		//  │ inject-ctx  hooks.js   Knowledge Graph    │  │ Event Workers        │
		//  └───────────────────────────────────────────┘  └──────────────────────┘
		//  ┌── Devices ──────────┐  ┌── Projects ────────┐
		//  │ Phone    Desktop    │  │ PAN   WoE   Bot   │
		//  └─────────────────────┘  └────────────────────┘

		addZone('z-intel', 'Intelligence', 20, 20, 500, 290, '#89b4fa');
		addZone('z-core', 'Core', 540, 20, 260, 290, '#f5c2e7');
		addZone('z-services', 'Services', 820, 20, 460, 290, '#a6e3a1');
		addZone('z-memory', 'Memory', 20, 340, 780, 320, '#cba6f7');
		addZone('z-processing', 'Processing', 820, 340, 460, 320, '#f9e2af');
		addZone('z-devices', 'Devices', 20, 690, 380, 200, '#fab387');
		addZone('z-projects', 'Projects', 420, 690, 380, 200, '#94e2d5');

		// Derive statuses from services data
		const services = svcResp?.services || [];
		const svcByName = Object.fromEntries(services.map(s => [s.name, s]));
		const dreamUp = svcByName['Dream']?.status === 'up';
		const stewardUp = svcByName['Steward']?.status === 'up';
		const whisperUp = svcByName['Whisper']?.status === 'up';
		const ollamaUp = false;

		// Edge color constants per zone
		const EC = {
			intel: '#89b4fa', core: '#f5c2e7', svc: '#a6e3a1',
			mem: '#cba6f7', proc: '#f9e2af', dev: '#fab387', proj: '#94e2d5'
		};

		// ==================== CORE ====================
		addNode('pan-server', 'PAN Server', 'core', 'up', 'Port 7777 — Node.js/Express', 'core', 670, 170, 'The central PAN server (Node.js/Express). Runs on port 7777 as a Windows service. Handles all API requests, serves the dashboard, manages WebSocket connections for terminals, and coordinates all background services. File: service/src/server.js');

		// ==================== INTELLIGENCE ====================
		addNode('claude', 'Claude Code', 'ai', 'up', 'CLI sessions via hooks', 'intel', 160, 100, 'Claude Code CLI sessions. PAN communicates via hooks (SessionStart, SessionEnd, UserPromptSubmit). inject-context.cjs runs as a command hook to inject memory into CLAUDE.md before each session. File: service/inject-context.cjs, service/src/routes/hooks.js');
		addNode('task-router', 'Task Router', 'ai', 'down', 'Q-Learning \u2014 route to cheapest model', 'intel', 380, 100, 'Learned task router (planned). Uses Q-Learning to route requests to the cheapest capable handler: WASM fast-path for deterministic ops, Haiku for simple tasks, Opus for complex reasoning. Improves routing accuracy over time based on outcome feedback. Inspired by ruflo MoE router.');
		addNode('wasm-fast', 'WASM Fast Path', 'ai', 'down', 'Deterministic ops \u2014 zero LLM cost', 'intel', 160, 220, 'WebAssembly fast-path for deterministic operations (planned). Handles regex commands, time/date, sensor reads, dashboard queries without any LLM call. <1ms response. Extends Claude subscription by skipping LLM for simple tasks. Inspired by ruflo Agent Booster.');
		addNode('token-cache', 'Token Cache', 'ai', 'down', 'Cache + dedup \u2014 30-50% savings', 'intel', 380, 220, 'Token optimization layer (planned). Caches repeated query patterns, deduplicates context, batches similar requests. Target: 30-50% token reduction. Combines pattern retrieval, result caching at 95% hit rate, and optimal batching. Inspired by ruflo Token Optimizer.');
		edges.push({ from: 'pan-server', to: 'task-router', label: 'routes', color: EC.core });
		edges.push({ from: 'task-router', to: 'claude', label: 'complex', color: EC.intel });
		edges.push({ from: 'task-router', to: 'wasm-fast', label: 'simple', color: EC.intel });
		edges.push({ from: 'task-router', to: 'token-cache', label: 'cached?', color: EC.intel });
		edges.push({ from: 'token-cache', to: 'claude', label: 'miss', color: EC.intel });

		// ==================== SERVICES ====================
		addNode('dashboard', 'Dashboard', 'ui', 'up', 'Svelte v2 @ /v2/', 'services', 940, 100, 'Svelte v2 dashboard served at /v2/. The Tauri app loads this. Contains Terminal, Chat, Atlas, and all panel widgets. Source: service/dashboard/src/routes/');
		addNode('steward', 'Steward', 'service', stewardUp ? 'up' : 'down', 'Health monitor every 30s', 'services', 1160, 100, 'Health monitor (watchdog.ps1). Checks every 30s: PAN server, Whisper, AHK Voice. Restarts services if down. Cleans Tailscale ghost devices. File: service/src/watchdog.ps1');
		addNode('whisper', 'Whisper', 'service', whisperUp ? 'up' : 'warn', 'Port 7782 \u2014 voice transcription', 'services', 940, 220, 'Whisper voice transcription server on port 7782. Converts WebM audio to WAV then transcribes. Handles voice-to-text for dashboard and phone input. File: service/src/whisper-server.py');
		addNode('tauri', 'Tauri Shell', 'ui', 'up', 'Port 7790 \u2014 desktop app', 'services', 1160, 220, 'Tauri desktop shell running on port 7790 with PAN \u03A0 icon. Lightweight native window (~5MB) replacing Electron. Handles window management and IPC.');

		// Dynamic services from API (ones not already placed)
		const placedServices = new Set(['PAN Server', 'Steward', 'Whisper', 'Dashboard']);
		const extraServices = services.filter(s => s.category === 'PAN Core' && !placedServices.has(s.name));
		extraServices.forEach((s, i) => {
			const x = 940 + (i % 2) * 220;
			const y = 220 + Math.floor(i / 2) * 70;
			if (y < 310) {
				addNode(`svc-${s.name}`, s.name, 'service', s.status === 'up' ? 'up' : s.status === 'offline' ? 'down' : 'unknown', s.detail, 'services', x, y, s.detail || s.name);
				edges.push({ from: 'pan-server', to: `svc-${s.name}`, label: '', color: EC.svc });
			}
		});

		edges.push({ from: 'pan-server', to: 'dashboard', label: 'serves', color: EC.svc });
		edges.push({ from: 'steward', to: 'pan-server', label: 'monitors', color: EC.svc });
		edges.push({ from: 'pan-server', to: 'whisper', label: 'transcribe', color: EC.svc });
		edges.push({ from: 'pan-server', to: 'tauri', label: 'IPC', color: EC.svc });

		// ==================== MEMORY ====================
		addNode('database', 'SQLite DB', 'data', 'up', statsResp ? `${statsResp.total_events || 0} events, ${statsResp.total_sessions || 0} sessions` : 'Encrypted SQLCipher', 'memory', 120, 420, 'SQLite database encrypted with SQLCipher (AES-256-CBC). Tables: events, sessions, projects, memory_items, episodic_memories, semantic_facts, procedural_memories, devices, settings. FTS5 search index on events. File: service/src/db.js, service/src/schema.sql');
		addNode('memory-hub', 'Memory Hub', 'memory', 'up', 'Vector stores + context builder', 'memory', 370, 420, 'Unified memory system with three vector stores (episodic, semantic, procedural). Context builder assembles memories for injection into Claude sessions with a token budget. File: service/src/memory/index.js, service/src/memory/context-builder.js');
		addNode('embeddings', 'Local Embeddings', 'memory', ollamaUp ? 'up' : 'warn', ollamaUp ? 'ONNX MiniLM (384D)' : 'Keyword fallback (no ONNX yet)', 'memory', 640, 420, 'Vector embedding layer (migration planned). Target: ONNX Runtime with MiniLM model for local embeddings \u2014 75x faster than API, zero token cost, 384 dimensions. Currently falls back to keyword hash vectors. Inspired by ruflo. File: service/src/memory/embeddings.js');
		addNode('mem-episodic', 'Episodic', 'memory', 'up', 'Events, outcomes, importance', 'memory', 160, 540, 'Stores what happened \u2014 events, outcomes, importance scores (0-1). Hybrid recall scoring: vector similarity + recency + importance. Updated by consolidation after dream cycles. File: service/src/memory/episodic.js');
		addNode('mem-semantic', 'Semantic', 'memory', 'up', 'Subject/predicate/object triples', 'memory', 400, 540, 'Knowledge graph of subject/predicate/object triples. Auto-detects contradictions \u2014 when a new fact conflicts (>0.85 cosine similarity), old fact is superseded with version tracking. File: service/src/memory/semantic.js');
		addNode('mem-procedural', 'Procedural', 'memory', 'up', 'Workflows, success/failure rates', 'memory', 640, 540, 'Learned multi-step workflows with success/failure tracking. Recall weighted 60% vector similarity + 40% success rate. Steps stored as JSON arrays. File: service/src/memory/procedural.js');
		addNode('knowledge-graph', 'Knowledge Graph', 'memory', 'down', 'PageRank \u2014 surface key insights', 'memory', 400, 620, 'Knowledge graph with PageRank analysis (planned). Connects conversations \u2192 projects \u2192 decisions \u2192 outcomes. Uses community detection to surface influential insights and trace decision chains. Builds on semantic memory triples. Inspired by ruflo Knowledge Graph.');
		addNode('inject-local', 'inject-context', 'process', 'up', 'Hook \u2192 CLAUDE.md (before read)', 'memory', 160, 620, 'Path A \u2014 command hook that runs BEFORE Claude reads CLAUDE.md. Reads .pan-state.md + Claude auto-memory files. Injects between PAN-CONTEXT markers. File: service/inject-context.cjs');
		addNode('inject-server', 'hooks.js', 'process', 'up', 'HTTP hook \u2192 CLAUDE.md (after read)', 'memory', 640, 620, 'Path B \u2014 HTTP hook that runs AFTER Claude reads CLAUDE.md (invisible to current session). Richer data: vector memory + tasks + conversation history. File: service/src/routes/hooks.js');

		edges.push({ from: 'pan-server', to: 'database', label: 'read/write', color: EC.core });
		edges.push({ from: 'database', to: 'memory-hub', label: 'feeds', color: EC.mem });
		edges.push({ from: 'pan-server', to: 'memory-hub', label: 'manages', color: EC.core });
		edges.push({ from: 'memory-hub', to: 'mem-episodic', label: '', color: EC.mem });
		edges.push({ from: 'memory-hub', to: 'mem-semantic', label: '', color: EC.mem });
		edges.push({ from: 'memory-hub', to: 'mem-procedural', label: '', color: EC.mem });
		edges.push({ from: 'mem-episodic', to: 'embeddings', label: 'vector', color: EC.mem });
		edges.push({ from: 'mem-semantic', to: 'embeddings', label: 'vector', color: EC.mem });
		edges.push({ from: 'mem-procedural', to: 'embeddings', label: 'vector', color: EC.mem });
		edges.push({ from: 'mem-semantic', to: 'knowledge-graph', label: 'triples', color: EC.mem });
		edges.push({ from: 'knowledge-graph', to: 'embeddings', label: 'vector', color: EC.mem });
		edges.push({ from: 'memory-hub', to: 'inject-local', label: '', color: EC.mem });
		edges.push({ from: 'memory-hub', to: 'inject-server', label: '', color: EC.mem });
		edges.push({ from: 'inject-local', to: 'claude', label: 'CLAUDE.md', color: EC.intel });
		edges.push({ from: 'inject-server', to: 'claude', label: 'CLAUDE.md', color: EC.intel });

		// ==================== PROCESSING ====================
		addNode('classifier', 'Classifier', 'process', 'up', 'Every 5min: count events', 'processing', 940, 420, 'Runs every 5 minutes. Marks events as processed. When 10+ events accumulate since last dream, triggers an early dream cycle. File: service/src/classifier.js');
		addNode('dream-cycle', 'Dream Cycle', 'process', dreamUp ? 'up' : 'idle', 'Every 6h: rewrite .pan-state.md', 'processing', 1160, 420, 'Runs every 6 hours. Reads all events since last dream, sends to Claude Haiku to rewrite .pan-state.md. Also triggers consolidation. File: service/src/dream.js');
		addNode('consolidation', 'Consolidation', 'process', 'idle', 'Extract memories from events', 'processing', 940, 530, 'Extracts memories from raw events. Two modes: (1) Heuristic \u2014 regex patterns. (2) LLM \u2014 Haiku structured extraction. Feeds all three memory stores. File: service/src/memory/consolidation.js');
		addNode('evolution', 'Evolution', 'process', 'down', 'NOT WIRED \u2014 6-step optimization', 'processing', 1160, 530, 'NOT WIRED \u2014 6-step config optimization pipeline: Observe, Critique, Generate Deltas, Validate, Apply, Consolidate. Built but never connected. File: service/src/evolution/engine.js');
		addNode('event-workers', 'Event Workers', 'process', 'down', 'Auto-dispatch on triggers', 'processing', 1050, 620, 'Event-driven background workers (planned). Auto-dispatch on triggers: index new conversations on arrival, tag photos on sync, update project state on git commits, re-embed on memory changes. Replaces polling with reactive processing. Inspired by ruflo background workers.');

		edges.push({ from: 'database', to: 'classifier', label: 'events', color: EC.proc });
		edges.push({ from: 'classifier', to: 'dream-cycle', label: '10+ events', color: EC.proc });
		edges.push({ from: 'dream-cycle', to: 'consolidation', label: 'triggers', color: EC.proc });
		edges.push({ from: 'consolidation', to: 'mem-episodic', label: 'writes', color: EC.proc });
		edges.push({ from: 'consolidation', to: 'mem-semantic', label: 'writes', color: EC.proc });
		edges.push({ from: 'consolidation', to: 'mem-procedural', label: 'writes', color: EC.proc });
		edges.push({ from: 'dream-cycle', to: 'evolution', label: 'triggers', color: EC.proc });
		edges.push({ from: 'database', to: 'event-workers', label: 'triggers', color: EC.proc });
		edges.push({ from: 'event-workers', to: 'memory-hub', label: 'updates', color: EC.proc });
		edges.push({ from: 'event-workers', to: 'embeddings', label: 're-embed', color: EC.proc });

		// ==================== DEVICES ====================
		const devices = services.filter(s => s.category === 'Devices');
		devices.forEach((d, i) => {
			const x = 120 + i * 200;
			const y = 800;
			addNode(`dev-${d.name}`, d.name, 'device', d.status === 'up' ? 'up' : 'down', d.detail, 'devices', x, y, d.detail || d.name);
			edges.push({ from: 'pan-server', to: `dev-${d.name}`, label: '', color: EC.dev });
		});
		if (!devices.find(d => d.name === 'Phone')) {
			addNode('dev-phone', 'Phone', 'device', 'unknown', 'Android \u2014 voice + sensors', 'devices', 120, 800, 'Android phone app. Always-listening voice assistant with Google STT, on-device commands, routes complex queries to PAN server via Tailscale.');
			edges.push({ from: 'pan-server', to: 'dev-phone', label: '', color: EC.dev });
		}
		if (!devices.find(d => d.name === 'Desktop')) {
			addNode('dev-desktop', 'Desktop', 'device', 'up', 'Windows \u2014 primary workstation', 'devices', 300, 800, 'Primary Windows workstation. Runs PAN server, Claude Code sessions, Tauri dashboard.');
			edges.push({ from: 'pan-server', to: 'dev-desktop', label: '', color: EC.dev });
		}

		// ==================== PROJECTS ====================
		const projs = projResp || [];
		projs.forEach((p, i) => {
			const x = 520 + (i % 3) * 120;
			const y = 760 + Math.floor(i / 3) * 70;
			addNode(`proj-${p.id}`, p.name, 'project', 'up', p.path || '', 'projects', x, y, `Project: ${p.name}. Path: ${p.path || 'unknown'}`);
			edges.push({ from: 'database', to: `proj-${p.id}`, label: '', color: EC.proj });
		});

		// ==================== JOBS ====================
		const jobs = jobsResp?.jobs || [];
		const runningJobs = jobs.filter(j => j.status === 'running' || j.status === 'ready' || j.status === 'training');
		runningJobs.forEach((j, i) => {
			const x = 940 + (i % 2) * 220;
			const y = 620 + Math.floor(i / 2) * 60;
			const status = j.status === 'running' ? 'up' : j.status === 'training' ? 'warn' : 'idle';
			addNode(`job-${j.name}`, j.name, 'job', status, j.description, 'processing', x, y, j.description || j.name);
			edges.push({ from: 'pan-server', to: `job-${j.name}`, label: '', color: EC.proc });
		});

		return { nodes, edges, nodeMap, zones, stats: statsResp };
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
			const resp = await fetch('/api/v1/tests');
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

		// Poll for UI commands (window opens, etc.) — this runs in the renderer,
		// so window.open creates real Electron windows from the interactive session
		setInterval(async () => {
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

				if (sessions.length > 0) {
					// Keep only the newest session per project
					const byProject = new Map();
					for (const s of sessions) {
						if (!s.id.startsWith(sessionPrefix) && !s.id.startsWith('mob-')) continue;
						const key = s.project || s.cwd || s.id;
						const existing = byProject.get(key);
						if (!existing || (s.createdAt || 0) > (existing.createdAt || 0)) {
							byProject.set(key, s);
						}
					}
					for (const s of byProject.values()) {
						const matchedProject = projects.find(p => p.name === s.project);
						const pid = matchedProject ? matchedProject.id : null;
						const savedTab = dbTabMap.get(s.id);
						await createTab(s.id, s.project || 'Shell', s.cwd || 'C:\\Users\\tzuri\\Desktop', pid, true, savedTab?.tabName || null);
						reconnected = true;
					}
				}

				// If no live sessions, try restoring from DB-saved tabs (creates new PTY sessions)
				if (!reconnected && dbTabs.length > 0) {
					for (const dt of dbTabs) {
						const matchedProject = projects.find(p => p.name === dt.project);
						const pid = matchedProject ? matchedProject.id : dt.projectId;
						await createTab(dt.sessionId, dt.project || 'Shell', dt.cwd || 'C:\\Users\\tzuri\\Desktop', pid, false, dt.tabName || null);
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
					await createTab(s.sessionId, s.project || 'Shell', s.cwd || 'C:\\Users\\tzuri\\Desktop', s.projectId, false, s.tabName || null);
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

		// Global resize handler — server-side rendered terminal doesn't need client resize
		const handleResize = () => {};
		window.addEventListener('resize', handleResize);

		// Global key handler — Escape and number keys reach the terminal even without textarea focus
		function handleGlobalKeydown(e) {
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
			// Number keys 1-3 when input is empty — navigate Claude Code approval prompt
			if (/^[1-3]$/.test(e.key) && !terminalInputEl?.value?.trim()) {
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
			window.removeEventListener('beforeunload', handleBeforeUnload);
			if (chatRefreshInterval) clearInterval(chatRefreshInterval);
			clearInterval(svcInterval);
			clearInterval(approvalInterval);
			for (const tab of tabs) {
				tab._closing = true;
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
				<option value="project">Project</option>
				<option value="services">Services</option>
				<option value="setup">Setup Guide</option>
				<option value="tasks">Tasks</option>
				<option value="perf">Performance</option>
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
								<div class="chat-bubble user">
									{#if bubble.multiSession}
										<span class="session-dot" style="background:{bubble.accentColor}"></span>
									{/if}
									{bubble.text}
								</div>
							{:else if bubble.type === 'assistant'}
								<div class="chat-bubble assistant" style={bubble.multiSession ? `border-left:2px solid ${bubble.accentColor}` : ''}>
									{bubble.text}
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

					<div class="perf-section-title" style="margin-top:12px">PAN Processes</div>
					{#if perfProcesses.length === 0}
						<div class="perf-metric"><span class="perf-label" style="opacity:0.5">Scanning...</span></div>
					{:else}
						{#each perfProcesses as proc}
							<div class="perf-proc" class:perf-zombie={proc.isZombie}>
								<div class="perf-proc-header">
									<span class="perf-proc-name" class:vital={proc.vital}>{proc.name}</span>
									{#if !proc.vital && proc.isZombie}
										<button class="perf-kill-btn" onclick={() => killProcess(proc.pid)} title="Kill zombie">Kill</button>
									{/if}
								</div>
								<div class="perf-proc-stats">
									<span>CPU: {proc.cpuSec > 3600 ? (proc.cpuSec/3600).toFixed(1)+'h' : proc.cpuSec > 60 ? (proc.cpuSec/60).toFixed(1)+'m' : proc.cpuSec+'s'}</span>
									<span>{proc.memMB}MB</span>
									<span>{proc.uptimeHrs > 24 ? (proc.uptimeHrs/24).toFixed(1)+'d' : proc.uptimeHrs+'h'}</span>
								</div>
							</div>
						{/each}
					{/if}

					{#if perfProcesses.filter(p => p.isZombie).length > 0}
						<div class="perf-metric perf-status" style="margin-top:8px">
							<span class="perf-bad">{perfProcesses.filter(p => p.isZombie).length} ZOMBIE{perfProcesses.filter(p => p.isZombie).length > 1 ? 'S' : ''} DETECTED</span>
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
					<button class="app-card" onclick={() => switchCenterView('atlas')}>
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
			<div class="center-chat" bind:this={centerChatEl}>
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
					<svg bind:this={atlasSvgEl} class="atlas-svg" viewBox="0 0 1500 1000" preserveAspectRatio="xMidYMid meet">
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
									onclick={() => { atlasSelected = atlasSelected === node.id ? null : node.id; }}
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
				<option value="project">Project</option>
				<option value="services">Services</option>
				<option value="setup">Setup Guide</option>
				<option value="tasks">Tasks</option>
				<option value="perf">Performance</option>
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
					<button class="app-card" onclick={() => switchCenterView('atlas')}>
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

					<div class="perf-section-title" style="margin-top:12px">PAN Processes</div>
					{#if perfProcesses.length === 0}
						<div class="perf-metric"><span class="perf-label" style="opacity:0.5">Scanning...</span></div>
					{:else}
						{#each perfProcesses as proc}
							<div class="perf-proc" class:perf-zombie={proc.isZombie}>
								<div class="perf-proc-header">
									<span class="perf-proc-name" class:vital={proc.vital}>{proc.name}</span>
									{#if !proc.vital && proc.isZombie}
										<button class="perf-kill-btn" onclick={() => killProcess(proc.pid)} title="Kill zombie">Kill</button>
									{/if}
								</div>
								<div class="perf-proc-stats">
									<span>CPU: {proc.cpuSec > 3600 ? (proc.cpuSec/3600).toFixed(1)+'h' : proc.cpuSec > 60 ? (proc.cpuSec/60).toFixed(1)+'m' : proc.cpuSec+'s'}</span>
									<span>{proc.memMB}MB</span>
									<span>{proc.uptimeHrs > 24 ? (proc.uptimeHrs/24).toFixed(1)+'d' : proc.uptimeHrs+'h'}</span>
								</div>
							</div>
						{/each}
					{/if}

					{#if perfProcesses.filter(p => p.isZombie).length > 0}
						<div class="perf-metric perf-status" style="margin-top:8px">
							<span class="perf-bad">{perfProcesses.filter(p => p.isZombie).length} ZOMBIE{perfProcesses.filter(p => p.isZombie).length > 1 ? 'S' : ''} DETECTED</span>
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
		overflow-y: auto;
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
		white-space: pre-wrap;
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
		align-items: center;
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
		max-height: 100px;
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
		padding: 10px;
		font-size: 12px;
	}

	/* ==================== Chat ==================== */
	.chat-container {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.chat-bubble {
		word-break: break-word;
		white-space: pre-wrap;
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
