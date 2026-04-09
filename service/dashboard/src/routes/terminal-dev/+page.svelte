<script>
	import { onMount, tick } from 'svelte';
	import { api, wsUrl } from '$lib/api.js';
	import { getActiveProject, setActiveProject, sortProjects, getTerminalInput, setTerminalInput } from '$lib/stores.svelte.js';

	// --- State ---
	let projects = $state([]);
	let tabs = $state([]);
	let activeTabId = $state(null);
	let leftTab = $state('transcript'); // any widget: 'transcript' | 'project' | 'services' | 'tasks' | 'bugs' | 'setup' | 'instances' | 'apps'
	let rightSection = $state('tests'); // default to tests on dev
	// viewMode removed — terminal output IS the chat now
	let rightPanelCollapsed = $state(false);
	let leftPanelCollapsed = $state(false);
	let leftPanelWidth = $state(260);
	let rightPanelWidth = $state(280);
	let rightMilestoneFilter = $state(null);
	let hostLabel = $state('');
	let sessionsCount = $state(0);

	// Project/task data for sidebar
	let projectData = $state(null);
	let tasksData = $state(null);
	let sectionsData = $state([]);
	let chatBubbles = $state([]);
	let chatCurrentProject = $state('');

	// Services state
	let servicesData = $state({ services: [], issues: [] });

	// Approvals state
	let pendingApprovals = $state([]);
	let approvalHistory = $state([]);
	let tabFlashing = $state(false);
	let flashInterval = null;

	// Alerts state — system notifications, errors, warnings
	let alerts = $state([]);

	// Tests state
	let testSuites = $state([]);
	let selectedSuite = $state(null);
	let testResults = $state([]);
	let testGroup = $state('PAN Core');
	let testsRunning = $state(false);
	let testPollTimer = null;

	// Terminal container refs
	let termContainerEl;
	let chatSidebarEl;
	let chatViewEl;

	// Terminal input bar — persisted across tab switches
	let terminalInputText = $state(getTerminalInput());
	let terminalInputEl;
	let pastedImages = $state([]); // {dataUrl, path} — images waiting to be sent
	let uploadingImages = $state(0); // count of images still uploading
	// directMode removed — all input goes through the input bar
	let voiceRecording = $state(false); // voice-to-text active
	let pendingSend = $state(false); // queued send waiting for image upload or text paste
	let pasteInProgress = $state(false); // clipboard read in progress

	// Intervals
	let chatRefreshInterval = null;
	let termInitialized = false;

	// Performance guards
	let loadingChatHistory = false;
	let lastChatSessionKey = '';

	// Tab counter
	let tabCounter = 0;

	// ==================== Panel Resize ====================
	let resizing = $state(null); // 'left' | 'right' | null
	let resizeStartX = 0;
	let resizeStartWidth = 0;

	function startResize(side, e) {
		e.preventDefault();
		resizing = side;
		resizeStartX = e.clientX;
		resizeStartWidth = side === 'left' ? leftPanelWidth : rightPanelWidth;
		document.body.style.cursor = 'col-resize';
		document.body.style.userSelect = 'none';
		window.addEventListener('mousemove', onResizeMove);
		window.addEventListener('mouseup', onResizeEnd);
	}

	function onResizeMove(e) {
		if (!resizing) return;
		const dx = e.clientX - resizeStartX;
		if (resizing === 'left') {
			leftPanelWidth = Math.max(120, Math.min(500, resizeStartWidth + dx));
		} else {
			rightPanelWidth = Math.max(120, Math.min(500, resizeStartWidth - dx));
		}
	}

	function onResizeEnd() {
		resizing = null;
		document.body.style.cursor = '';
		document.body.style.userSelect = '';
		window.removeEventListener('mousemove', onResizeMove);
		window.removeEventListener('mouseup', onResizeEnd);
	}

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

		const sessionId = 'dev-dash-' + (projectName || 'shell').toLowerCase().replace(/[^a-z0-9]/g, '-');

		// Check if tab already exists
		const existing = tabs.find(t => t.sessionId === sessionId);
		if (existing) {
			switchToTab(existing.id);
			return;
		}

		await createTab(sessionId, projectName, cwd, projectId, false);
	}

	function newTerminalTab() {
		const active = getActiveTab();
		const baseProject = active?.project || 'Shell';
		const projectId = active?.projectId || null;
		const cwd = active?.cwd || 'C:\\Users\\tzuri\\Desktop';
		// Count existing tabs with the same base project name to generate numbered name
		const baseName = baseProject.replace(/-\d+$/, ''); // strip existing number suffix
		const sameProjectTabs = tabs.filter(t => t.project === baseName || t.project.match(new RegExp('^' + baseName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(-\\d+)?$')));
		const tabNum = sameProjectTabs.length + 1;
		const projectName = tabNum > 1 ? `${baseName}-${tabNum}` : baseName;
		const sessionId = 'dev-dash-' + projectName.toLowerCase().replace(/[^a-z0-9]/g, '-') + '-' + Date.now();
		createTab(sessionId, projectName, cwd, projectId, false);
	}

	// ==================== ANSI Parser ====================
	// Converts raw terminal output (with ANSI escape codes) to styled HTML spans
	// No ansiToHtml needed — server renders terminal output to HTML via @xterm/headless

	async function createTab(sessionId, projectName, cwd, projectId, isReconnect) {
		const tabId = 'tab-' + (++tabCounter);

		// Server-side rendered terminal — just a scrollable div that displays pre-rendered HTML lines
		const tabContainer = document.createElement('div');
		tabContainer.id = 'term-' + tabId;
		tabContainer.className = 'term-output';
		tabContainer.style.cssText = 'position:absolute;top:0;left:0;right:0;bottom:44px;display:none;overflow-y:auto;overflow-x:hidden;font-family:"JetBrains Mono","Cascadia Code",Consolas,monospace;font-size:14px;line-height:1.5;color:#cdd6f4;';

		// Scrollback div (history above visible screen)
		const scrollbackDiv = document.createElement('div');
		scrollbackDiv.className = 'term-scrollback';
		scrollbackDiv.style.cssText = 'padding:8px 12px;white-space:pre;';
		tabContainer.appendChild(scrollbackDiv);

		// Screen div (current visible terminal screen — fixed height grid)
		const screenDiv = document.createElement('div');
		screenDiv.className = 'term-screen';
		screenDiv.style.cssText = 'padding:0 12px;white-space:pre;min-height:100%;';
		tabContainer.appendChild(screenDiv);

		termContainerEl.appendChild(tabContainer);

		const tabData = {
			id: tabId,
			sessionId,
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
			logLines: [],       // Append-only log from server (immune to corruption)
			logPosition: 0,     // Last known log sequence number
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

		// Connect WebSocket — uses server-side rendered terminal endpoint
		{
			const wsUrlStr = wsUrl(`/ws/terminal-dev?session=${encodeURIComponent(sessionId)}&project=${encodeURIComponent(projectName)}&cwd=${encodeURIComponent(cwd)}&cols=120&rows=30`);

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
					const msg = JSON.parse(event.data);
					switch (msg.type) {
						case 'screen-v2': {
							// Append-only log system — append new log lines, render viewport separately
							if (msg.logLines && msg.logLines.length > 0) {
								tabData.logLines.push(...msg.logLines);
								// Cap client-side log
								if (tabData.logLines.length > 5000) {
									tabData.logLines = tabData.logLines.slice(-5000);
									scrollbackDiv.innerHTML = tabData.logLines.join('\n');
								} else {
									// Incremental append — much faster than full innerHTML replace
									scrollbackDiv.insertAdjacentHTML('beforeend',
										(tabData.logLines.length > msg.logLines.length ? '\n' : '') + msg.logLines.join('\n'));
								}
							}

							// Live viewport — may be TUI/alt screen, self-corrects on corruption
							screenDiv.innerHTML = msg.lines.join('\n');
							if (msg.altScreen) {
								screenDiv.classList.add('alt-screen');
							} else {
								screenDiv.classList.remove('alt-screen');
							}

							// Auto-scroll to bottom unless user scrolled up
							if (!tabData.userScrolledUp) {
								tabContainer.scrollTop = tabContainer.scrollHeight;
							}

							if (!hasExistingBuffer && msg.lines.some(l => l.trim().length > 0)) {
								hasExistingBuffer = true;
							}
							break;
						}
						case 'screen': {
							// Legacy v1 fallback
							if (msg.scrollback && msg.scrollback.length > 0) {
								scrollbackDiv.innerHTML = msg.scrollback.join('\n');
							}
							screenDiv.innerHTML = msg.lines.join('\n');

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
						case 'exit':
							screenDiv.innerHTML += '\n<span style="color:#585b70">[Session ended]</span>';
							break;
						case 'error':
							screenDiv.innerHTML += '\n<span style="color:#f38ba8">[Error: ' + msg.message + ']</span>';
							addAlert('error', 'Terminal Error', msg.message, tabData.project);
							break;
						case 'chat_update': {
							lastChatSessionKey = '';
							const updateSid = msg.session_id || '';
							if (updateSid && !updateSid.startsWith('system-') && !updateSid.startsWith('phone-') && !updateSid.startsWith('router-') && !updateSid.startsWith('dev-dash-') && !updateSid.startsWith('mob-')) {
								const ownerTab = tabs.find(t => t.claudeSessionIds.includes(updateSid));
								if (!ownerTab) {
									const activeTab = getActiveTab();
									if (activeTab) {
										activeTab.claudeSessionIds = [...new Set([...activeTab.claudeSessionIds, updateSid])];
										tabs = [...tabs];
									}
								}
							}
							if (leftTab === 'transcript') {
								setTimeout(loadChatHistory, 500);
							}
							break;
						}
						case 'permission_prompt':
							loadApprovals();
							break;
						case 'server_restarting':
							serverRestarting = true;
							reconnectAttempts = 0;
							screenDiv.innerHTML += '\n<span style="color:#f9e2af">[Server restarting — will reconnect automatically...]</span>';
							break;
					}
				} catch {}
			}

			function reconnect() {
				if (reconnectTimer) return;
				reconnectAttempts++;
				const delay = Math.min(reconnectAttempts * 1000, 5000);

				reconnectTimer = setTimeout(() => {
					reconnectTimer = null;
					if (tabData.ws && tabData.ws.readyState <= 1) return;

					const newWs = new WebSocket(wsUrlStr);
					newWs.onopen = () => {
						reconnectAttempts = 0;
						serverRestarting = false;
						tabData.ws = newWs;
						tabData.claudeStarted = false; // Reset — Claude needs to relaunch after reconnect
						startPing();
						newWs.send(JSON.stringify({ type: 'sync', logPosition: 0 }));

						// Relaunch Claude after reconnect (server restart = fresh PTY)
						if (projectName && projectName !== 'Shell') {
							setTimeout(async () => {
								if (newWs.readyState !== 1 || tabData.claudeStarted) return;
								tabData.claudeStarted = true;
								try {
									await api('/api/v1/inject-context', {
										method: 'POST',
										headers: { 'Content-Type': 'application/json' },
										body: JSON.stringify({ cwd })
									});
									await new Promise(r => setTimeout(r, 300));
								} catch {}
								newWs.send(JSON.stringify({ type: 'input', data: 'claude --permission-mode auto "\u03A0\u0391\u039D remembers..."\n' }));
							}, 2000);
						}
					};
					newWs.onmessage = handleMessage;
					newWs.onclose = () => {
						stopPing();
						if (tabData._closing) return;
						if (reconnectAttempts < 30) reconnect();
					};
					newWs.onerror = () => {};
				}, delay);
			}

			ws.onopen = () => {
				if (terminalInputEl) terminalInputEl.focus();
				startPing();

				// Auto-launch Claude (PAN) for project tabs — ALWAYS in dev
				if (projectName && projectName !== 'Shell') {
					setTimeout(async () => {
						if (ws.readyState !== 1) return;

						// Check if Claude is actually running (❯ prompt visible = Claude active)
						// Wait for screen to populate first
						await new Promise(r => setTimeout(r, 500));
						const screenText = tabData.screenDiv ? tabData.screenDiv.textContent : '';
						const lastLine = screenText.trim().split('\n').pop() || '';

						// If Claude's prompt (❯) is the last thing on screen, Claude is already running
						if (lastLine.includes('❯')) {
							tabData.claudeStarted = true;
							return;
						}

						// Claude is NOT running — launch it
						tabData.claudeStarted = true;

						// Inject context into CLAUDE.md first
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
							ws.send(JSON.stringify({ type: 'input', data: 'claude --permission-mode auto "\u03A0\u0391\u039D remembers..."\n' }));
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

		if (terminalInputEl) terminalInputEl.focus();

		// Reload sidebar and transcript for the new tab
		loadTerminalSidebar(tab.projectId, tab.project);
		lastChatSessionKey = '';
		if (leftTab === 'transcript') {
			loadChatHistory();
		}
	}

	function closeTab(tabId) {
		const tab = tabs.find(t => t.id === tabId);
		if (!tab) return;

		// Kill server-side PTY
		try { fetch(`/api/v1/terminal/sessions/${encodeURIComponent(tab.sessionId)}`, { method: 'DELETE' }); } catch {}

		tab._closing = true;
		if (tab.ws) tab.ws.close();
		if (tab.container) tab.container.remove();

		tabs = tabs.filter(t => t.id !== tabId);
		sessionsCount = tabs.length;

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

	function switchLeftTab(tab) {
		leftTab = tab;
		if (tab === 'chat') {
			loadChatHistory();
			if (chatRefreshInterval) clearInterval(chatRefreshInterval);
			chatRefreshInterval = setInterval(loadChatHistory, 10000);
		} else {
			if (chatRefreshInterval) { clearInterval(chatRefreshInterval); chatRefreshInterval = null; }
		}
	}

	function escapeHtml(str) {
		if (!str) return '';
		return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
	}

	function renderChatText(text) {
		let html = escapeHtml(text);
		const imgStyle = 'max-width:100%;max-height:150px;border-radius:4px;margin:4px 0;display:block;cursor:pointer';
		// Render clipboard image references as inline images (click to open full size)
		html = html.replace(/\[Image:?\s*source:?\s*[^\]]*pan-clipboard[/\\](clipboard_\d+\.\w+)[^\]]*\]/gi,
			(_, filename) => `<img src="/clipboard/${filename}" style="${imgStyle}" onclick="window.open('/clipboard/${filename}','_blank')" />`);
		// Also match raw paths like C:/WINDOWS/TEMP/pan-clipboard/clipboard_123.png
		html = html.replace(/(C:[/\\](?:WINDOWS[/\\]TEMP|Users[^\s]*)[/\\]pan-clipboard[/\\](clipboard_\d+\.\w+))/gi,
			(_, _full, filename) => `<img src="/clipboard/${filename}" style="${imgStyle}" onclick="window.open('/clipboard/${filename}','_blank')" />`);
		return html;
	}

	async function loadServices() {
		try {
			const data = await api('/dashboard/api/services');
			servicesData = data;
		} catch {}
	}

	async function loadApprovals() {
		try {
			const data = await api('/api/v1/terminal/permissions');
			const perms = data.permissions || [];
			const hadNone = pendingApprovals.length === 0;
			pendingApprovals = perms;

			// Start tab flashing if new approvals appeared
			if (perms.length > 0 && hadNone) {
				startTabFlash();
			} else if (perms.length === 0) {
				stopTabFlash();
			}
		} catch {}
	}

	async function respondApproval(id, response) {
		try {
			await api('/api/v1/terminal/permissions/respond', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ perm_id: id, response }),
			});
			// Move to history
			const approved = pendingApprovals.find(p => p.id === id);
			if (approved) {
				approvalHistory = [{ ...approved, response, resolved_at: new Date().toISOString() }, ...approvalHistory].slice(0, 50);
			}
			pendingApprovals = pendingApprovals.filter(p => p.id !== id);
			if (pendingApprovals.length === 0) stopTabFlash();
		} catch (err) {
			console.error('[PAN] Approval response failed:', err);
		}
	}

	// ==================== Voice (Whisper via browser mic) ====================

	let mediaRecorder = null;
	let audioChunks = [];

	async function toggleVoice() {
		if (voiceRecording) {
			// Stop recording — send to Whisper
			voiceRecording = false;
			if (mediaRecorder && mediaRecorder.state === 'recording') {
				mediaRecorder.stop();
			}
		} else {
			// Start recording from browser mic
			try {
				const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
				audioChunks = [];
				mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });

				mediaRecorder.ondataavailable = (e) => {
					if (e.data.size > 0) audioChunks.push(e.data);
				};

				mediaRecorder.onstop = async () => {
					// Stop all mic tracks
					stream.getTracks().forEach(t => t.stop());

					if (audioChunks.length === 0) return;

					const blob = new Blob(audioChunks, { type: 'audio/webm' });

					try {
						// Convert webm to wav using AudioContext
						const arrayBuffer = await blob.arrayBuffer();
						const audioCtx = new AudioContext({ sampleRate: 16000 });
						const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
						const pcmData = audioBuffer.getChannelData(0);

						// Build WAV file
						const wavBuffer = new ArrayBuffer(44 + pcmData.length * 2);
						const view = new DataView(wavBuffer);
						const writeStr = (offset, str) => { for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i)); };
						writeStr(0, 'RIFF');
						view.setUint32(4, 36 + pcmData.length * 2, true);
						writeStr(8, 'WAVE');
						writeStr(12, 'fmt ');
						view.setUint32(16, 16, true);
						view.setUint16(20, 1, true); // PCM
						view.setUint16(22, 1, true); // mono
						view.setUint32(24, 16000, true); // sample rate
						view.setUint32(28, 32000, true); // byte rate
						view.setUint16(32, 2, true); // block align
						view.setUint16(34, 16, true); // bits per sample
						writeStr(36, 'data');
						view.setUint32(40, pcmData.length * 2, true);
						for (let i = 0; i < pcmData.length; i++) {
							const s = Math.max(-1, Math.min(1, pcmData[i]));
							view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
						}
						audioCtx.close();

						// Send WAV to Whisper endpoint
						const res = await fetch('/api/v1/whisper', {
							method: 'POST',
							headers: { 'Content-Type': 'application/octet-stream' },
							body: new Uint8Array(wavBuffer),
						});
						const data = await res.json();

						if (data.ok && data.text) {
							terminalInputText = (terminalInputText ? terminalInputText + ' ' : '') + data.text;
							if (terminalInputEl) {
								terminalInputEl.focus();
								terminalInputEl.style.height = 'auto';
								terminalInputEl.style.height = Math.min(terminalInputEl.scrollHeight, 118) + 'px';
							}
						}
					} catch (err) {
						console.error('[Voice] Whisper error:', err);
					}
				};

				mediaRecorder.start();
				voiceRecording = true;
				if (terminalInputEl) terminalInputEl.focus();
			} catch (err) {
				console.error('[Voice] Mic access error:', err);
			}
		}
	}

	// ==================== Alerts ====================

	function addAlert(type, title, message, source = '') {
		const alert = {
			id: Date.now() + Math.random(),
			type, // 'error' | 'warning' | 'info' | 'success'
			title,
			message,
			source,
			timestamp: new Date().toISOString(),
			read: false,
		};
		alerts = [alert, ...alerts].slice(0, 100);
	}

	function dismissAlert(id) {
		alerts = alerts.filter(a => a.id !== id);
	}

	function clearAlerts() {
		alerts = [];
	}

	function startTabFlash() {
		if (flashInterval) return;
		tabFlashing = true;
		flashInterval = setInterval(() => {
			tabFlashing = !tabFlashing || true; // keep state true, CSS animation handles the flash
		}, 800);
	}

	function stopTabFlash() {
		if (flashInterval) {
			clearInterval(flashInterval);
			flashInterval = null;
		}
		tabFlashing = false;
	}

	async function loadChatHistory() {
		const active = getActiveTab();
		if (!active) {
			chatBubbles = [];
			return;
		}
		if (loadingChatHistory) return; // concurrency guard
		loadingChatHistory = true;

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
			} else if (active.claudeSessionIds && active.claudeSessionIds.length > 0) {
				// Use the tab's tracked Claude sessions
				sessionIds = [...active.claudeSessionIds];
			} else {
				// No tracked sessions yet — fall back to most recent global sessions
				try {
					const probe = await api('/dashboard/api/events?limit=50');
					if (probe && probe.events) {
						const seen = new Set();
						for (const evt of probe.events) {
							const sid = evt.session_id || '';
							if (sid && !seen.has(sid) && !sid.startsWith('system-') && !sid.startsWith('phone-') && !sid.startsWith('router-') && !sid.startsWith('dev-dash-') && !sid.startsWith('mob-')) {
								seen.add(sid);
								sessionIds.push(sid);
								if (sessionIds.length >= 3) break;
							}
						}
					}
				} catch {}
			}

			if (sessionIds.length === 0) {
				chatBubbles = [];
				return;
			}

			// Skip expensive transcript re-fetch if sessions haven't changed
			const sessionKey = sessionIds.join(',');
			if (sessionKey === lastChatSessionKey && chatBubbles.length > 0) {
				return;
			}

			const allMessages = [];
			await Promise.all(sessionIds.map(async (sid, idx) => {
				try {
					const data = await api('/dashboard/api/transcript?session_id=' + encodeURIComponent(sid) + '&limit=300');
					if (data && data.messages) {
						for (const msg of data.messages) {
							msg._sessionIdx = idx;
							allMessages.push(msg);
						}
					}
				} catch {}
			}));

			allMessages.sort((a, b) => (a.ts || '').localeCompare(b.ts || ''));

			if (allMessages.length === 0) {
				chatBubbles = [];
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

			// Only update if content actually changed (prevents scroll reset on every refresh)
			const newKey = newBubbles.map(b => b.type + ':' + (b.text || '').slice(0, 80)).join('|');
			const oldKey = chatBubbles.map(b => b.type + ':' + (b.text || '').slice(0, 80)).join('|');
			if (newKey === oldKey) return; // no change — don't touch DOM or scroll

			// Only auto-scroll if user was already at bottom (don't yank while reading)
			const wasAtBottom = !chatSidebarEl || (chatSidebarEl.scrollHeight - chatSidebarEl.scrollTop - chatSidebarEl.clientHeight < 40);
			const savedScroll = chatSidebarEl?.scrollTop;

			chatBubbles = newBubbles;
			lastChatSessionKey = sessionKey;

			await tick();
			if (wasAtBottom && chatSidebarEl) {
				chatSidebarEl.scrollTop = chatSidebarEl.scrollHeight;
			} else if (chatSidebarEl && savedScroll !== undefined) {
				// Restore scroll position after DOM re-render
				chatSidebarEl.scrollTop = savedScroll;
			}
			// Always scroll chat view to bottom
			if (chatViewEl) {
				chatViewEl.scrollTop = chatViewEl.scrollHeight;
			}
		} catch (err) {
			console.error('[PAN Chat] loadChatHistory error:', err);
		} finally {
			loadingChatHistory = false;
		}
	}

	// tick imported from Svelte

	// ==================== Right Panel ====================

	async function loadTerminalSidebar(projectId, projectName) {
		const active = getActiveTab();
		if (!projectId) {
			if (leftTab === 'transcript') loadChatHistory();
			return;
		}

		try {
			const [progress, tasks, sections] = await Promise.all([
				api('/dashboard/api/progress'),
				api(`/dashboard/api/projects/${projectId}/tasks`),
				api(`/dashboard/api/projects/${projectId}/sections`),
			]);

			const proj = progress?.projects?.find(p => p.id === projectId);
			projectData = proj || null;
			tasksData = tasks || null;
			sectionsData = sections || [];
		} catch (e) {
			console.error('Failed to load sidebar data:', e);
		}

		if (leftTab === 'transcript') loadChatHistory();
	}

	function pctColor(pct) {
		if (pct >= 80) return 'green';
		if (pct >= 40) return 'yellow';
		return 'red';
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

	// ==================== Terminal Input Bar ====================

	function sendTerminalInput() {
		const tab = getActiveTab();
		if (!tab?.ws || tab.ws.readyState !== 1) return;
		if (uploadingImages > 0 || pasteInProgress) { pendingSend = true; return; } // queue

		// Build full input: typed text + image paths already in terminal, just \r to confirm
		const typed = terminalInputText.trim();
		if (typed) {
			tab.ws.send(JSON.stringify({ type: 'input', data: typed + '\r' }));
		} else {
			tab.ws.send(JSON.stringify({ type: 'input', data: '\r' }));
		}

		// Clean up
		terminalInputText = '';
		setTerminalInput('');
		pastedImages = [];
		if (terminalInputEl) {
			terminalInputEl.value = '';
			terminalInputEl.style.height = 'auto';
		}
	}

	function handleTerminalKeydown(e) {
		const tab = getActiveTab();
		if (!tab?.ws || tab.ws.readyState !== 1) return;

		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			e.stopPropagation();
			sendTerminalInput();
		} else if (e.key === 'Backspace' && !terminalInputText) {
			// Empty textarea — forward backspace to terminal
			e.preventDefault();
			tab.ws.send(JSON.stringify({ type: 'input', data: '\x7f' }));
		} else if (e.key === 'Tab') {
			e.preventDefault();
			tab.ws.send(JSON.stringify({ type: 'input', data: '\t' }));
		} else if (e.key === 'ArrowUp' && !terminalInputText) {
			e.preventDefault();
			tab.ws.send(JSON.stringify({ type: 'input', data: '\x1b[A' }));
		} else if (e.key === 'ArrowDown' && !terminalInputText) {
			e.preventDefault();
			tab.ws.send(JSON.stringify({ type: 'input', data: '\x1b[B' }));
		} else if (e.ctrlKey && e.key.length === 1) {
			// Let browser handle Ctrl+C/V/A/X/Z natively in the input
			if ('cvaxz'.includes(e.key.toLowerCase())) return;
			e.preventDefault();
			const code = e.key.charCodeAt(0) - 96;
			if (code > 0 && code < 27) {
				tab.ws.send(JSON.stringify({ type: 'input', data: String.fromCharCode(code) }));
			}
		}
	}

	function handleTerminalInputEvent(e) {
		// Auto-resize textarea
		if (terminalInputEl) {
			terminalInputEl.style.height = 'auto';
			terminalInputEl.style.height = Math.min(terminalInputEl.scrollHeight, 118) + 'px';
		}
		// Persist input across tab switches
		setTerminalInput(terminalInputText);
	}

	// Handle paste in the input bar (text and images)
	function handleTerminalPaste(e) {
		const items = e.clipboardData?.items;
		if (!items) return;
		const tab = getActiveTab();

		for (const item of items) {
			if (item.type.startsWith('image/')) {
				e.preventDefault();
				const file = item.getAsFile();
				if (!file) continue;
				const reader = new FileReader();
				reader.onload = async () => {
					const base64 = reader.result.split(',')[1];
					try {
						const resp = await fetch('/api/v1/clipboard-image', {
							method: 'POST',
							headers: { 'Content-Type': 'application/json' },
							body: JSON.stringify({ data: base64, mimeType: item.type })
						});
						const result = await resp.json();
						if (result.ok && tab?.ws && tab.ws.readyState === 1) {
							const unixPath = result.path.replace(/\\\\/g, '/').replace(/\\/g, '/');
							tab.ws.send(JSON.stringify({ type: 'input', data: unixPath + ' ' }));
						}
					} catch (err) {
						console.error('[PAN] Image paste failed:', err);
					}
				};
				reader.readAsDataURL(file);
				return;
			}
		}
		// Text paste — insert into input bar
		// (browser default will handle it since focus is on textarea)
	}

	// ==================== Init ====================

	async function loadTestSuites() {
		try {
			const data = await api('/api/v1/tests');
			const serverSuites = (data.suites || []).map(s => {
				const suiteTests = (data.tests || []).filter(t => t.suiteId === s.id).map(t => ({
					id: t.id, name: t.name, description: t.description
				}));
				const tests = suiteTests.length > 0 ? suiteTests :
					Array.from({length: s.testCount}, (_, i) => ({id: `${s.id}-${i}`, name: `Test ${i+1}`, description: ''}));
				return { id: s.id, name: s.name, description: s.description, tests, group: s.group || 'PAN Core', runInAll: s.runInAll !== false };
			});
			testSuites = serverSuites;
			if (testSuites.length > 0 && !selectedSuite) selectedSuite = testSuites[0].id;
			// If tests are running or just finished, show results
			if (data.status === 'running' || data.status === 'done') {
				const allTests = data.tests || [];
				if (allTests.length > 0) {
					testResults = allTests.map(t => ({
						id: t.id, name: t.name, status: t.status === 'passed' ? 'pass' : t.status === 'failed' ? 'fail' : t.status,
						detail: t.result || t.error || '', description: t.description || ''
					}));
					if (data.status === 'running') {
						testsRunning = true;
						rightSection = 'tests';
					} else {
						testsRunning = false;
					}
				}
			}
		} catch {}
	}

	function startTestPolling() {
		if (testPollTimer) return;
		testPollTimer = setInterval(async () => {
			await loadTestSuites();
		}, 2000);
	}

	async function runSuite(suiteId) {
		const id = suiteId || selectedSuite;
		const suite = testSuites.find(s => s.id === id);
		if (!suite) return;
		testsRunning = true;
		testResults = suite.tests.map(t => ({ ...t, status: 'pending', detail: '' }));
		try {
			await api('/api/v1/tests/run', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ suite: id })
			});
		} catch {}
		startTestPolling();
	}

	async function runAllTests() {
		testsRunning = true;
		testResults = testSuites.flatMap(s => s.tests.map(t => ({ ...t, status: 'pending', detail: '' })));
		try {
			await api('/api/v1/tests/run', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ suite: 'all' })
			});
		} catch {}
		startTestPolling();
	}

	async function cancelTests() {
		try {
			await api('/api/v1/tests/cancel', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: '{}'
			});
		} catch {}
		testsRunning = false;
	}

	onMount(() => {
		loadTerminalProjects();
		loadTestSuites();
		startTestPolling();

		// Start chat refresh — poll every 3 seconds for real-time transcript updates
		chatRefreshInterval = setInterval(() => {
			if (leftTab === 'transcript' || rightSection === 'transcript') {
				lastChatSessionKey = ''; // always invalidate so new messages show
				loadChatHistory();
			}
		}, 3000);

		// Services polling
		loadServices();
		const servicesInterval = setInterval(loadServices, 15000);

		// Approvals polling — check every 3 seconds for pending permissions
		loadApprovals();
		const approvalsInterval = setInterval(loadApprovals, 3000);

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
			try {
				const sessData = await api('/api/v1/terminal/sessions').catch(() => ({ sessions: [] }));
				const sessions = sessData.sessions || [];
				if (sessions.length > 0) {
					for (const s of sessions) {
						if (!s.id.startsWith('dev-dash-') && !s.id.startsWith('mob-')) continue;
						const matchedProject = projects.find(p => p.name === s.project);
						const pid = matchedProject ? matchedProject.id : null;
						await createTab(s.id, s.project || 'Shell', s.cwd || 'C:\\Users\\tzuri\\Desktop', pid, true);
						reconnected = true;
					}
				}
			} catch (e) {
				console.error('[Terminal] Session reconnect failed:', e);
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
		}, 300);

		// Alt+V focuses the input bar, Ctrl+V pastes via Clipboard API
		const handleKeyDown = async (e) => {
			// Escape: send Ctrl+C to terminal (stop running command)
			if (e.key === 'Escape') {
				e.preventDefault();
				const tab = getActiveTab();
				if (tab?.ws && tab.ws.readyState === 1) {
					tab.ws.send(JSON.stringify({ type: 'input', data: '\x03' }));
				}
				return;
			}
			if (e.altKey && e.key === 'v') {
				e.preventDefault();
				terminalInputEl?.focus();
				return;
			}
			// Intercept Ctrl+V globally — handle images always, text only when not in textarea
			if (e.ctrlKey && (e.key === 'v' || e.key === 'V')) {
				const inTextarea = document.activeElement === terminalInputEl;
				e.preventDefault();
				e.stopPropagation();
				try {
					const items = await navigator.clipboard.read();
					let foundImage = false;
					for (const item of items) {
						const imageType = item.types.find(t => t.startsWith('image/'));
						if (imageType) {
							foundImage = true;
							const blob = await item.getType(imageType);
							const dataUrl = URL.createObjectURL(blob);
							// Upload image, send path to terminal immediately, show preview
							uploadingImages++;
							pastedImages = [...pastedImages, { dataUrl, path: null }]; // preview while uploading
							const previewIdx = pastedImages.length - 1;
							const reader = new FileReader();
							reader.onload = async () => {
								const base64 = reader.result.split(',')[1];
								try {
									const resp = await fetch('/api/v1/clipboard-image', {
										method: 'POST',
										headers: { 'Content-Type': 'application/json' },
										body: JSON.stringify({ data: base64, mimeType: imageType })
									});
									const result = await resp.json();
									if (result.ok) {
										const unixPath = result.path.replace(/\\\\/g, '/').replace(/\\/g, '/');
										// Send path to terminal immediately (no \r — user confirms with Enter)
										const t = getActiveTab();
										if (t?.ws && t.ws.readyState === 1) {
											t.ws.send(JSON.stringify({ type: 'input', data: unixPath + ' ' }));
										}
										// Update preview with path
										pastedImages = pastedImages.map((img, i) => i === previewIdx ? { ...img, path: unixPath } : img);
									}
								} catch (err) {
									console.error('[PAN] Image paste failed:', err);
								} finally {
									uploadingImages = Math.max(0, uploadingImages - 1);
									if (uploadingImages === 0 && pendingSend) { pendingSend = false; sendTerminalInput(); }
								}
							};
							reader.readAsDataURL(blob);
							if (terminalInputEl) terminalInputEl.focus();
							return;
						}
					}
					// No image — paste text into textarea
					if (!foundImage) {
						const text = await navigator.clipboard.readText();
						if (text) {
							const start = terminalInputEl?.selectionStart || 0;
							const end = terminalInputEl?.selectionEnd || 0;
							terminalInputText = terminalInputText.substring(0, start) + text + terminalInputText.substring(end);
							await tick();
							if (terminalInputEl) {
								terminalInputEl.selectionStart = terminalInputEl.selectionEnd = start + text.length;
								terminalInputEl.focus();
							}
						}
					}
				} catch (err) {
					// Fallback: try text only
					try {
						const text = await navigator.clipboard.readText();
						if (text) {
							terminalInputText += text;
							if (terminalInputEl) terminalInputEl.focus();
						}
					} catch {}
				}
			}
		};
		window.addEventListener('keydown', handleKeyDown, true); // capture phase

		// Global paste handler — catches image paste regardless of focus

		// Global resize handler — no-op now (output div auto-resizes)
		const handleResize = () => {};
		window.addEventListener('resize', handleResize);

		return () => {
			window.removeEventListener('keydown', handleKeyDown, true);
			window.removeEventListener('resize', handleResize);
			if (chatRefreshInterval) clearInterval(chatRefreshInterval);
			clearInterval(servicesInterval);
			clearInterval(approvalsInterval);
			stopTabFlash();
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
			createTab('dev-dash-shell-' + Date.now(), 'Shell', 'C:\\Users\\tzuri\\Desktop', null, false);
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

{#snippet panelContent(currentTab)}
	{#if currentTab === 'transcript'}
		{#if tabs.length === 0}
			<div class="empty-state">
				<div style="opacity:0.7;margin-bottom:4px">Starting terminal...</div>
				<div style="font-size:11px;opacity:0.5">Waiting for Claude session</div>
			</div>
		{:else if chatBubbles.length === 0}
			<div class="empty-state">No conversation yet</div>
		{:else}
			<div class="chat-container">
				{#each chatBubbles as bubble}
					{#if bubble.type === 'user'}
						<div class="chat-bubble user">
							{#if bubble.multiSession}
								<span class="session-dot" style="background:{bubble.accentColor}"></span>
							{/if}
							{@html renderChatText(bubble.text)}
						</div>
					{:else if bubble.type === 'assistant'}
						<div class="chat-bubble assistant" style={bubble.multiSession ? `border-left:2px solid ${bubble.accentColor}` : ''}>
							{@html renderChatText(bubble.text)}
						</div>
					{:else if bubble.type === 'tool'}
						<div class="chat-bubble tool">{bubble.text}</div>
					{/if}
				{/each}
			</div>
		{/if}
	{:else if currentTab === 'project'}
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
	{:else if currentTab === 'services'}
		{@const grouped = Object.groupBy(servicesData.services || [], s => s.category || 'Other')}
		{#each Object.entries(grouped) as [category, categoryServices]}
			<div class="task-group-header">{category}</div>
			{#each categoryServices as svc}
				<div class="service-row">
					<span class="service-dot" class:up={svc.status === 'up'} class:degraded={svc.status === 'degraded'} class:down={svc.status === 'down'} class:offline={svc.status === 'offline'} class:unknown={svc.status === 'unknown'}></span>
					<div class="service-info">
						<span class="service-name">{svc.name}</span>
						<span class="service-detail">{svc.detail || ''}</span>
					</div>
				</div>
			{/each}
		{/each}
		{#if servicesData.issues?.length}
			<div class="task-group-header">Recent Issues</div>
			{#each servicesData.issues as issue}
				<div class="service-issue">
					<span class="issue-time">{issue.ts?.split(' ')[1] || ''}</span>
					<span class="issue-msg">{issue.message}</span>
				</div>
			{/each}
		{/if}
		{#if !servicesData.services?.length}
			<div class="empty-state">Loading services...</div>
		{/if}
	{:else if currentTab === 'approvals'}
		{#if pendingApprovals.length > 0}
			<div class="task-group-header">Pending</div>
			{#each pendingApprovals as perm}
				<div class="approval-card pending">
					<div class="approval-prompt">{perm.prompt}</div>
					<div class="approval-meta">{perm.project ? perm.project.split('/').pop().split('\\').pop() : ''} &middot; {new Date(perm.timestamp).toLocaleTimeString()}</div>
					<div class="approval-actions">
						<button class="approval-btn allow" onclick={() => respondApproval(perm.id, 'allow')}>Allow</button>
						<button class="approval-btn deny" onclick={() => respondApproval(perm.id, 'deny')}>Deny</button>
					</div>
				</div>
			{/each}
		{/if}
		{#if approvalHistory.length > 0}
			<div class="task-group-header">History</div>
			{#each approvalHistory as perm}
				<div class="approval-card resolved {perm.response}">
					<div class="approval-prompt">{perm.prompt}</div>
					<div class="approval-meta">
						<span class="approval-badge {perm.response}">{perm.response === 'allow' ? 'Allowed' : 'Denied'}</span>
						&middot; {new Date(perm.resolved_at).toLocaleTimeString()}
					</div>
				</div>
			{/each}
		{/if}
		{#if pendingApprovals.length === 0 && approvalHistory.length === 0}
			<div class="empty-state">No approvals</div>
		{/if}
	{:else if currentTab === 'alerts'}
		{#if alerts.length > 0}
			<div class="task-group-header" style="display:flex;justify-content:space-between;align-items:center">
				<span>Alerts</span>
				<button class="clear-alerts-btn" onclick={clearAlerts}>Clear All</button>
			</div>
			{#each alerts as alert}
				<div class="alert-card {alert.type}" class:unread={!alert.read}>
					<div class="alert-header">
						<span class="alert-type-icon">
							{alert.type === 'error' ? '!' : alert.type === 'warning' ? '!' : alert.type === 'success' ? '\u2713' : 'i'}
						</span>
						<span class="alert-title">{alert.title}</span>
						<button class="alert-dismiss" onclick={() => dismissAlert(alert.id)}>&times;</button>
					</div>
					{#if alert.message}
						<div class="alert-message">{alert.message}</div>
					{/if}
					<div class="alert-meta">
						{#if alert.source}<span>{alert.source}</span> &middot; {/if}
						{new Date(alert.timestamp).toLocaleTimeString()}
					</div>
				</div>
			{/each}
		{:else}
			<div class="empty-state">No alerts</div>
		{/if}
	{:else if currentTab === 'tasks'}
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
			<input type="text" class="add-input" placeholder="Add a task..." onkeydown={(e) => { if (e.key === 'Enter') addTask(e.target); }} />
		</div>
		<div class="panel-hint">Use Terminal to Add: Tasks, Milestones, Projects</div>
	{:else if currentTab === 'bugs'}
		{@const bugs = getBugs()}
		{#if bugs.length === 0}
			<div class="empty-state">No bugs tracked</div>
			<div class="empty-state small">Add tasks with "bug" or "fix" in the title, or set priority &gt; 0</div>
		{:else}
			{#each bugs as t}
				<div class="task-row" onclick={() => cycleTask(t.id, t.status)}>
					<span class="task-icon bug" class:done={t.status === 'done'}>{t.status === 'done' ? '\u2713' : '\u26A0'}</span>
					<span class="task-title" class:done={t.status === 'done'}>{t.title}</span>
				</div>
			{/each}
		{/if}
		<div class="add-row">
			<input type="text" class="add-input" placeholder="Report a bug..." onkeydown={(e) => { if (e.key === 'Enter') addBug(e.target); }} />
		</div>
		<div class="panel-hint">Use Terminal to Report: Bugs, Issues, Errors</div>
	{:else if currentTab === 'setup'}
		<div class="setup-guide">
			<div class="setup-title">How to Use ΠΑΝ</div>
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
			</div>
			<div class="setup-controls">
				<div class="setup-controls-title">Terminology</div>
				<div><strong>Instance:</strong> Environment (Prod, Dev, Test). Admin-only.</div>
				<div><strong>Sidebar:</strong> Left vertical navigation strip.</div>
				<div><strong>Tab:</strong> Each nav item in the Sidebar — switches the active App.</div>
				<div><strong>App:</strong> What fills the Main View (Terminal, Chat, ATC map). Can open in a new window.</div>
				<div><strong>Main View:</strong> Center content area that displays the active App.</div>
				<div><strong>Panel:</strong> Collapsible side panes (left/right of Main View). ACLs applied here.</div>
				<div><strong>Widget:</strong> What loads inside a Panel (Transcript, Tasks, Services, Setup). Stays in panels only.</div>
				<div><strong>Topbar:</strong> Top bar — shows active App name + instance label for Dev/Test.</div>
			</div>
			<div class="setup-hint">Voice is significantly faster than typing. You don't need complete sentences.</div>
		</div>
	{:else if currentTab === 'instances'}
		<div class="widget-list">
			<div class="widget-list-title">Instances</div>
			<div class="widget-list-desc">Switch between environments. Admin-only.</div>
			<button class="widget-item" onclick={() => window.open('/v2/terminal', '_blank', 'width=1400,height=900')}>
				<span class="widget-icon">🟢</span>
				<span class="widget-label">Prod</span>
				<span class="widget-meta">Opens in new window</span>
			</button>
			<button class="widget-item active-instance">
				<span class="widget-icon">🟡</span>
				<span class="widget-label">Dev</span>
				<span class="widget-meta">Current</span>
			</button>
			<button class="widget-item disabled">
				<span class="widget-icon">🔵</span>
				<span class="widget-label">Test</span>
				<span class="widget-meta">Coming soon</span>
			</button>
		</div>
	{:else if currentTab === 'apps'}
		<div class="widget-list">
			<div class="widget-list-title">Apps</div>
			<div class="widget-list-desc">Apps not in the Sidebar. Opens in new window.</div>
			<a class="widget-item disabled">
				<span class="widget-icon">🗺</span>
				<span class="widget-label">Air Traffic Control</span>
				<span class="widget-meta">Coming soon</span>
			</a>
		</div>
	{:else if currentTab.startsWith('custom-')}
		{@const sectionId = parseInt(currentTab.replace('custom-', ''))}
		{@const section = getSectionById(sectionId)}
		{#if section}
			{#each section.items || [] as item}
				<div class="task-row" onclick={() => cycleSectionItem(item.id, item.status, sectionId)}>
					<span class="task-icon" class:done={item.status === 'done'}>{item.status === 'done' ? '\u2713' : '\u25CB'}</span>
					<span class="task-title" class:done={item.status === 'done'}>{item.content}</span>
				</div>
			{/each}
			{#if !section.items?.length}
				<div class="empty-state">No items yet</div>
			{/if}
			<div class="add-row">
				<input type="text" class="add-input" placeholder="Add item..." onkeydown={(e) => { if (e.key === 'Enter') addSectionItem(sectionId, e.target); }} />
			</div>
			<button class="delete-section" onclick={() => deleteSection(sectionId)}>Delete This Section</button>
		{:else}
			<div class="empty-state">Section not found</div>
		{/if}
	{:else if currentTab === 'tests'}
		<div class="tests-panel" style="padding:8px">
			{#if testSuites.length === 0}
				<div class="empty-state">Loading test suites...</div>
			{:else}
				<!-- App group dropdown -->
				{@const groups = [...new Set(testSuites.map(s => s.group || 'PAN Core'))]}
				<select bind:value={testGroup} style="width:100%;margin-bottom:8px;padding:5px 8px;background:#1a1a25;border:1px solid #1e1e2e;border-radius:6px;color:#cdd6f4;font-size:12px">
					{#each groups as g}
						<option value={g}>{g}</option>
					{/each}
				</select>

				<!-- Run All / Cancel buttons -->
				<div style="display:flex;gap:6px;margin-bottom:10px">
					<button onclick={runAllTests} disabled={testsRunning} style="flex:1;padding:6px;background:#1e1e2e;color:#89b4fa;border:1px solid #89b4fa;border-radius:6px;cursor:pointer;font-size:12px">
						{testsRunning ? 'Running...' : 'Run All'}
					</button>
					{#if testsRunning}
						<button onclick={cancelTests} style="padding:6px 12px;background:#2e1a1a;color:#f38ba8;border:1px solid #f38ba8;border-radius:6px;cursor:pointer;font-size:12px">
							Cancel
						</button>
					{/if}
				</div>

				<!-- Suites filtered by selected group -->
				{#each testSuites.filter(s => (s.group || 'PAN Core') === testGroup) as suite, si}
					<div style="margin-bottom:8px">
						<div style="display:flex;align-items:center;gap:6px;padding:4px 0;border-bottom:1px solid #1e1e2e">
							<span style="font-size:11px;color:#585b70;min-width:18px">{si + 1}.</span>
							<span style="font-size:12px;font-weight:500;color:#cdd6f4;flex:1">{suite.name}{#if !suite.runInAll} <span style="font-size:9px;color:#585b70">(manual)</span>{/if}</span>
							<button onclick={() => runSuite(suite.id)} disabled={testsRunning} style="padding:2px 8px;background:transparent;color:#89b4fa;border:1px solid #313244;border-radius:4px;cursor:pointer;font-size:10px">
								Run
							</button>
						</div>
						<!-- Tests within this suite -->
						{#each testResults.filter(t => {
							const suiteTests = suite.tests.map(st => st.id);
							return suiteTests.includes(t.id);
						}) as t}
							<div style="display:flex;gap:6px;align-items:flex-start;padding:3px 0 3px 24px">
								<span style="font-size:12px;min-width:14px;text-align:center;color:{t.status === 'pass' ? '#a6e3a1' : t.status === 'fail' ? '#f38ba8' : t.status === 'running' ? '#f9e2af' : t.status === 'cancelled' ? '#fab387' : '#6c7086'}">
									{t.status === 'pass' ? '\u2713' : t.status === 'fail' ? '\u2717' : t.status === 'running' ? '\u25CF' : t.status === 'cancelled' ? '\u25A0' : '\u25CB'}
								</span>
								<div style="flex:1;min-width:0">
									<div style="font-size:11px;color:#bac2de">{t.name}</div>
									{#if t.detail}
										<div style="font-size:9px;color:{t.status === 'fail' ? '#f38ba8' : '#585b70'};word-break:break-word">{t.detail}</div>
									{/if}
								</div>
							</div>
						{/each}
					</div>
				{/each}

				<!-- Summary -->
				{#if testResults.length > 0 && !testsRunning}
					{@const passed = testResults.filter(t => t.status === 'pass').length}
					{@const failed = testResults.filter(t => t.status === 'fail').length}
					{@const cancelled = testResults.filter(t => t.status === 'cancelled').length}
					<div style="margin-top:8px;padding:6px;border-radius:4px;text-align:center;font-size:12px;background:{failed === 0 && cancelled === 0 ? '#1a2e1a' : '#2e1a1a'};color:{failed === 0 && cancelled === 0 ? '#a6e3a1' : '#f38ba8'}">
						{passed}/{testResults.length} passed{failed > 0 ? `, ${failed} failed` : ''}{cancelled > 0 ? `, ${cancelled} cancelled` : ''}
					</div>
				{/if}
			{/if}
		</div>
	{/if}
{/snippet}

<!-- TAB BAR -->
{#if tabs.length > 0}
	<div class="tab-bar">
		{#each tabs as tab (tab.id)}
			<button
				class="term-tab"
				class:active={activeTabId === tab.id}
				class:approval-flash={tabFlashing && pendingApprovals.length > 0}
				onclick={() => switchToTab(tab.id)}
			>
				{#if tab.id === tabs.find(t => t.project === tab.project)?.id && tab.project !== 'Shell'}
					<span class="primary-dot"></span>
				{/if}
				{#if tab.host}{tab.host}/{/if}{tab.project || 'Shell'}
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
	<div class="left-panel" class:collapsed={leftPanelCollapsed} style="width:{leftPanelCollapsed ? 0 : leftPanelWidth}px">
		{#if !leftPanelCollapsed}
		<div class="right-header">
			<select class="right-select" bind:value={leftTab} onchange={() => { if (leftTab === 'transcript') { loadChatHistory(); } }}>
				<option value="alerts">Alerts{alerts.length > 0 ? ` (${alerts.length})` : ''}</option>
				<option value="approvals">Approvals{pendingApprovals.length > 0 ? ` (${pendingApprovals.length})` : ''}</option>
				<option value="apps">Apps</option>
				<option value="bugs">Bugs</option>
				<option value="instances">Instances</option>
				<option value="project">Project</option>
				<option value="services">Services</option>
				<option value="setup">Setup Guide</option>
				<option value="tasks">Tasks</option>
				<option value="tests">Tests</option>
				<option value="transcript">Transcript</option>
				{#each sectionsData as s}
					<option value="custom-{s.id}">{s.name}</option>
				{/each}
			</select>
		</div>
		<div class="left-content" bind:this={chatSidebarEl}>
			{@render panelContent(leftTab)}
		</div>
		{/if}
	</div>

	<!-- LEFT PANEL RESIZE HANDLE -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div class="panel-resize-handle left-handle"
		onmousedown={(e) => startResize('left', e)}
		ondblclick={() => { leftPanelCollapsed = !leftPanelCollapsed; 0; }}
		title="Drag to resize, double-click to collapse"
	></div>

	<!-- CENTER: Terminal + Input Bar -->
	<div class="term-wrapper">
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div class="term-container" bind:this={termContainerEl} onclick={(e) => {
			// Don't steal focus if user is selecting text
			const sel = window.getSelection();
			if (sel && sel.toString().length > 0) return;
			if (terminalInputEl) terminalInputEl.focus();
		}}>
			{#if tabs.length === 0}
				<div class="term-empty">
					<div class="term-empty-icon">&loz;</div>
					<div class="term-empty-title">ΠΑΝ Terminal</div>
					<div class="term-empty-sub">Select a project to start</div>
				</div>
			{/if}
		</div>

		<!-- Input bar: overlays bottom of terminal -->
		<div class="term-input-bar">
			{#if pastedImages.length || uploadingImages > 0}
				<div class="term-image-previews">
					{#each pastedImages as img, i}
						<div class="term-image-preview">
							<img src={img.dataUrl} alt="pasted" />
							<button class="term-image-remove" onclick={() => { pastedImages = pastedImages.filter((_, j) => j !== i); }}>&times;</button>
						</div>
					{/each}
					{#if uploadingImages > 0}
						<div class="term-image-uploading">Uploading...</div>
					{/if}
				</div>
			{/if}
			<div class="term-input-row">
				<button class="voice-toggle-btn" class:recording={voiceRecording} onclick={toggleVoice} title="Voice Input (hold to speak)">
					<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
						<path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path>
						<path d="M19 10v2a7 7 0 0 1-14 0v-2"></path>
						<line x1="12" y1="19" x2="12" y2="23"></line>
						<line x1="8" y1="23" x2="16" y2="23"></line>
					</svg>
				</button>
				<textarea
					bind:this={terminalInputEl}
					bind:value={terminalInputText}
					onkeydown={handleTerminalKeydown}
					oninput={handleTerminalInputEvent}
					class="term-input-textarea"
					placeholder="Speak or type here..."
					rows="1"
				></textarea>
				<button class="term-input-send" onclick={sendTerminalInput} title="Send (Enter)" disabled={uploadingImages > 0}>&#x27A4;</button>
			</div>
		</div>
	</div>

	<!-- RIGHT PANEL RESIZE HANDLE -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div class="panel-resize-handle right-handle"
		onmousedown={(e) => startResize('right', e)}
		ondblclick={() => { rightPanelCollapsed = !rightPanelCollapsed; 0; }}
		title="Drag to resize, double-click to collapse"
	></div>
	<div class="right-panel" class:collapsed={rightPanelCollapsed} style="width:{rightPanelCollapsed ? 0 : rightPanelWidth}px">
		<div class="right-header">
			<select class="right-select" bind:value={rightSection} onchange={() => { rightMilestoneFilter = null; if (rightSection === 'transcript') loadChatHistory(); }}>
				<option value="alerts">Alerts{alerts.length > 0 ? ` (${alerts.length})` : ''}</option>
				<option value="approvals">Approvals{pendingApprovals.length > 0 ? ` (${pendingApprovals.length})` : ''}</option>
				<option value="apps">Apps</option>
				<option value="bugs">Bugs</option>
				<option value="instances">Instances</option>
				<option value="project">Project</option>
				<option value="services">Services</option>
				<option value="setup">Setup Guide</option>
				<option value="tasks">Tasks</option>
				<option value="tests">Tests</option>
				<option value="transcript">Transcript</option>
				{#each sectionsData as s}
					<option value="custom-{s.id}">{s.name}</option>
				{/each}
			</select>
		</div>
		<div class="right-content">
			{@render panelContent(rightSection)}
		</div>
	</div>
</div>

<style>
	/* Alt screen indicator — subtle left border when TUI is active */
	:global(.alt-screen) {
		border-left: 2px solid #89b4fa33;
	}

	/* Lock page — never allow horizontal scroll from voice-to-text */
	:global(html), :global(body) {
		overflow-x: hidden !important;
		max-width: 100vw !important;
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
	.term-tab.approval-flash {
		animation: tab-approval-flash 0.8s ease-in-out infinite;
	}
	@keyframes tab-approval-flash {
		0%, 100% { background: transparent; border-bottom-color: transparent; }
		50% { background: rgba(243, 139, 168, 0.25); border-bottom-color: #f38ba8; color: #f38ba8; }
	}

	.primary-dot {
		display: inline-block;
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: #89b4fa;
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

	.left-panel.collapsed {
		width: 0;
		min-width: 0;
		border: none;
		overflow: hidden;
	}

	.left-tabs {
		display: flex;
		border-bottom: 1px solid #1e1e2e;
		background: #12121a;
	}

	.left-tab {
		flex: 1;
		padding: 6px;
		border: none;
		background: none;
		color: #6c7086;
		cursor: pointer;
		font-size: 11px;
		border-bottom: 2px solid transparent;
		transition: all 0.15s;
	}
	.left-tab:hover { color: #cdd6f4; }
	.left-tab.active {
		color: #cdd6f4;
		font-weight: 600;
		border-bottom-color: #89b4fa;
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

	/* ==================== Terminal Wrapper (terminal + input bar) ==================== */
	.term-wrapper {
		flex: 1;
		display: flex;
		flex-direction: column;
		min-width: 0;
		overflow: hidden;
		position: relative;
	}

	/* ==================== View Mode Toggle ==================== */
	/* View mode and chat view removed — terminal output IS the chat */

	/* ==================== Voice Toggle ==================== */
	.voice-toggle-btn {
		background: none;
		border: 1px solid #313244;
		color: #6c7086;
		cursor: pointer;
		padding: 0;
		width: 32px;
		height: 32px;
		border-radius: 6px;
		display: flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
		transition: all 0.15s;
	}
	.voice-toggle-btn:hover { color: #cdd6f4; border-color: #45475a; }
	.voice-toggle-btn.recording {
		color: #f38ba8;
		border-color: #f38ba8;
		background: rgba(243, 139, 168, 0.1);
		animation: voice-pulse 1.5s ease-in-out infinite;
	}
	@keyframes voice-pulse {
		0%, 100% { box-shadow: 0 0 0 0 rgba(243, 139, 168, 0.3); }
		50% { box-shadow: 0 0 0 4px rgba(243, 139, 168, 0); }
	}

	/* ==================== Terminal Container ==================== */
	.term-container {
		flex: 1;
		background: #1e1e2e;
		border: 1px solid #1e1e2e;
		border-left: none;
		border-right: none;
		min-width: 0;
		position: relative;
		overflow: hidden;
		padding-bottom: 44px; /* space for overlaying input bar */
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

	/* Output div styling */
	.term-container :global(.term-output) {
		position: relative;
		z-index: 1;
		scrollbar-width: thin;
		scrollbar-color: #45475a #1e1e2e;
	}
	.term-container :global(.term-output)::-webkit-scrollbar {
		width: 8px;
	}
	.term-container :global(.term-output)::-webkit-scrollbar-track {
		background: #1e1e2e;
	}
	.term-container :global(.term-output)::-webkit-scrollbar-thumb {
		background: #45475a;
		border-radius: 4px;
	}
	.term-container :global(.term-output)::-webkit-scrollbar-thumb:hover {
		background: #585b70;
	}
	/* Text selection in output */
	.term-container :global(.term-output::selection) {
		background: #45475a;
	}

	/* ==================== Terminal Input Bar (overlays bottom of terminal) ==================== */
	.term-input-bar {
		position: absolute;
		bottom: 0;
		left: 0;
		right: 0;
		display: flex;
		flex-direction: column;
		gap: 4px;
		background: rgba(18, 18, 26, 0.95);
		backdrop-filter: blur(8px);
		border-top: 1px solid #313244;
		padding: 6px 10px;
		z-index: 15;
	}

	.term-input-row {
		display: flex;
		align-items: flex-end;
		gap: 6px;
	}

	.term-image-previews {
		display: flex;
		gap: 6px;
		flex-wrap: wrap;
		padding: 2px 0;
	}

	.term-image-preview {
		position: relative;
		width: 56px;
		height: 56px;
		border-radius: 6px;
		overflow: hidden;
		border: 1px solid #313244;
		flex-shrink: 0;
	}

	.term-image-preview img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	.term-image-remove {
		position: absolute;
		top: 1px;
		right: 1px;
		width: 16px;
		height: 16px;
		background: rgba(0, 0, 0, 0.7);
		color: #fff;
		border: none;
		border-radius: 50%;
		font-size: 11px;
		line-height: 1;
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.term-input-textarea {
		flex: 1;
		background: #1a1a28;
		border: 1px solid #313244;
		border-radius: 8px;
		outline: none;
		color: #cdd6f4;
		font-family: 'JetBrains Mono', 'Cascadia Code', Consolas, monospace;
		font-size: 14px;
		line-height: 1.4;
		padding: 6px 10px;
		resize: none;
		min-height: 28px;
		max-height: 118px; /* ~6 lines at 14px * 1.4 line-height */
		overflow-y: auto;
		word-wrap: break-word;
		overflow-wrap: break-word;
		white-space: pre-wrap;
	}
	.term-input-textarea:focus {
		border-color: #89b4fa;
	}

	.term-input-textarea::placeholder {
		color: #585b70;
	}

	.term-input-send {
		background: #89b4fa;
		color: #1e1e2e;
		border: none;
		border-radius: 6px;
		width: 32px;
		height: 32px;
		font-size: 16px;
		cursor: pointer;
		flex-shrink: 0;
		display: flex;
		align-items: center;
		justify-content: center;
	}
	.term-input-send:hover { background: #b4d0fb; }
	.term-input-send:disabled { opacity: 0.4; cursor: not-allowed; }

	.hidden-bar {
		display: none !important;
	}
	.term-image-uploading {
		color: #f9e2af;
		font-size: 11px;
		display: flex;
		align-items: center;
		padding: 4px 8px;
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

	/* ==================== Panel Resize Handle ==================== */
	.panel-resize-handle {
		position: relative;
		z-index: 2;
		width: 6px;
		min-width: 6px;
		background: #1e1e2e;
		cursor: col-resize;
		flex-shrink: 0;
		transition: background 0.15s;
	}
	.panel-resize-handle:hover {
		background: #89b4fa;
	}
	.panel-resize-handle::after {
		content: '⋮';
		position: absolute;
		top: 50%;
		left: 50%;
		transform: translate(-50%, -50%);
		color: #45475a;
		font-size: 10px;
		pointer-events: none;
	}
	.panel-resize-handle:hover::after {
		color: #cdd6f4;
	}

	/* ==================== Right Panel ==================== */
	.right-panel {
		flex-shrink: 0;
		background: #12121a;
		border: 1px solid #1e1e2e;
		border-radius: 0 6px 6px 0;
		overflow-y: auto;
		font-size: 12px;
		flex-shrink: 0;
		display: flex;
		flex-direction: column;
	}

	.right-panel.collapsed {
		width: 0;
		min-width: 0;
		overflow: hidden;
		border: none;
		padding: 0;
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

	/* Services */
	.service-row {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 5px 0;
	}
	.service-dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		flex-shrink: 0;
		background: #6c7086;
	}
	.service-dot.up { background: #a6e3a1; box-shadow: 0 0 4px #a6e3a1; }
	.service-dot.degraded { background: #f9e2af; box-shadow: 0 0 4px #f9e2af; }
	.service-dot.down { background: #f38ba8; box-shadow: 0 0 4px #f38ba8; }
	.service-dot.offline { background: #45475a; }
	.service-dot.unknown { background: #6c7086; }
	.service-info { display: flex; flex-direction: column; min-width: 0; }
	.service-name { font-size: 12px; color: #cdd6f4; }
	.service-detail { font-size: 10px; color: #6c7086; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
	.service-issue {
		display: flex;
		gap: 6px;
		padding: 2px 0;
		font-size: 10px;
		color: #f9e2af;
	}
	.issue-time { color: #6c7086; flex-shrink: 0; }
	.issue-msg { color: #f9e2af; }

	/* Approvals */
	.approval-card {
		padding: 8px;
		margin: 4px 0;
		border-radius: 6px;
		background: #1e1e2e;
		border-left: 3px solid #6c7086;
	}
	.approval-card.pending { border-left-color: #f9e2af; background: #1e1e2e; }
	.approval-card.resolved { opacity: 0.6; }
	.approval-card.resolved.allow { border-left-color: #a6e3a1; }
	.approval-card.resolved.deny { border-left-color: #f38ba8; }
	.approval-prompt { font-size: 12px; color: #cdd6f4; word-break: break-word; margin-bottom: 4px; }
	.approval-meta { font-size: 10px; color: #6c7086; margin-bottom: 6px; }
	.approval-actions { display: flex; gap: 6px; }
	.approval-btn {
		padding: 3px 12px;
		border: none;
		border-radius: 4px;
		font-size: 11px;
		cursor: pointer;
		font-weight: 500;
	}
	.approval-btn.allow { background: #a6e3a1; color: #1e1e2e; }
	.approval-btn.allow:hover { background: #94e2d5; }
	.approval-btn.deny { background: #f38ba8; color: #1e1e2e; }
	.approval-btn.deny:hover { background: #eba0ac; }
	.approval-badge { font-size: 10px; padding: 1px 6px; border-radius: 3px; }
	.approval-badge.allow { background: #a6e3a133; color: #a6e3a1; }
	.approval-badge.deny { background: #f38ba833; color: #f38ba8; }

	/* Alerts */
	.alert-card {
		padding: 8px 10px;
		margin: 4px 0;
		border-left: 3px solid #6c7086;
		background: #181825;
		border-radius: 4px;
		font-size: 12px;
	}
	.alert-card.error { border-left-color: #f38ba8; }
	.alert-card.warning { border-left-color: #f9e2af; }
	.alert-card.info { border-left-color: #89b4fa; }
	.alert-card.success { border-left-color: #a6e3a1; }
	.alert-card.unread { background: #1e1e2e; }
	.alert-header {
		display: flex;
		align-items: center;
		gap: 6px;
		margin-bottom: 2px;
	}
	.alert-type-icon {
		width: 16px;
		height: 16px;
		border-radius: 50%;
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: 10px;
		font-weight: bold;
		flex-shrink: 0;
	}
	.alert-card.error .alert-type-icon { background: #f38ba833; color: #f38ba8; }
	.alert-card.warning .alert-type-icon { background: #f9e2af33; color: #f9e2af; }
	.alert-card.info .alert-type-icon { background: #89b4fa33; color: #89b4fa; }
	.alert-card.success .alert-type-icon { background: #a6e3a133; color: #a6e3a1; }
	.alert-title { font-weight: 600; color: #cdd6f4; flex: 1; }
	.alert-dismiss {
		background: none;
		border: none;
		color: #6c7086;
		cursor: pointer;
		font-size: 14px;
		padding: 0 2px;
	}
	.alert-dismiss:hover { color: #f38ba8; }
	.alert-message { color: #a6adc8; margin: 2px 0 4px 22px; line-height: 1.4; }
	.alert-meta { color: #585b70; font-size: 10px; margin-left: 22px; }
	.clear-alerts-btn {
		background: none;
		border: 1px solid #45475a;
		color: #6c7086;
		font-size: 10px;
		padding: 2px 8px;
		border-radius: 3px;
		cursor: pointer;
	}
	.clear-alerts-btn:hover { color: #cdd6f4; border-color: #6c7086; }

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

	/* ==================== Widget List (Instances, Apps) ==================== */
	.widget-list {
		padding: 8px;
		font-size: 13px;
	}
	.widget-list-title {
		font-weight: 600;
		color: #cdd6f4;
		margin-bottom: 4px;
		font-size: 14px;
	}
	.widget-list-desc {
		color: #6c7086;
		font-size: 12px;
		margin-bottom: 12px;
	}
	.widget-item {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 10px 12px;
		border-radius: 6px;
		border: none;
		background: none;
		color: #cdd6f4;
		text-decoration: none;
		font-family: inherit;
		font-size: inherit;
		width: 100%;
		text-align: left;
		transition: background 0.15s;
		cursor: pointer;
	}
	.widget-item:hover:not(.disabled) {
		background: rgba(137, 180, 250, 0.1);
	}
	.widget-item.disabled {
		opacity: 0.4;
		cursor: default;
		pointer-events: none;
	}
	.widget-item.active-instance {
		background: rgba(137, 180, 250, 0.1);
		border-left: 3px solid #89b4fa;
		cursor: default;
	}
	.widget-icon {
		font-size: 16px;
		width: 22px;
		text-align: center;
		flex-shrink: 0;
	}
	.widget-label {
		font-weight: 500;
		flex: 1;
	}
	.widget-meta {
		font-size: 11px;
		color: #6c7086;
	}
	.widget-popout {
		background: none;
		border: 1px solid #313244;
		border-radius: 4px;
		color: #6c7086;
		cursor: pointer;
		font-size: 12px;
		padding: 2px 6px;
		transition: all 0.15s;
	}
	.widget-popout:hover {
		color: #89b4fa;
		border-color: #89b4fa;
	}
</style>
