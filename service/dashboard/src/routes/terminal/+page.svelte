<script>
	import { onMount, tick } from 'svelte';
	import { api, wsUrl } from '$lib/api.js';
	import { getActiveProject, setActiveProject, sortProjects, getTerminalInput, setTerminalInput } from '$lib/stores.svelte.js';
	// Terminal-page shared state — single source of truth across panels.
	// See $lib/stores-terminal.svelte.js + docs/DASHBOARD-REFACTOR-MAP.md.
	import {
		setPushed, getPushed,
		pushEcho, getEchoes, setEchoes,
		pushBtw, getBtws,
		clearTabStore,
	} from '$lib/stores/terminal.svelte.js';
	// Extracted panel components (Shape-2 refactor). Each owns its own state +
	// lifecycle. The parent passes the cross-cutting context it needs (orgData,
	// etc.) as props. See docs/DASHBOARD-REFACTOR-MAP.md.
	import IntuitionPanel from '$lib/components/widgets/IntuitionPanel.svelte';
	import ImpersonatePanel from '$lib/components/modals/ImpersonatePanel.svelte';
	import ServicesPanel from '$lib/components/widgets/ServicesPanel.svelte';
	import ApprovalsPanel from '$lib/components/widgets/ApprovalsPanel.svelte';
	import AlertsPanel from '$lib/components/widgets/AlertsPanel.svelte';
	import UsersPanel from '$lib/components/widgets/UsersPanel.svelte';
	import TeamsPanel from '$lib/components/widgets/TeamsPanel.svelte';
	import LibraryPanel from '$lib/components/widgets/LibraryPanel.svelte';
	import ProjectPanel from '$lib/components/widgets/ProjectPanel.svelte';
	import LifeboatPanel from '$lib/components/widgets/LifeboatPanel.svelte';
	import SetupPanel from '$lib/components/widgets/SetupPanel.svelte';
	import TasksPanel from '$lib/components/widgets/TasksPanel.svelte';
	import BugsPanel from '$lib/components/widgets/BugsPanel.svelte';
	import BenchmarksPanel from '$lib/components/widgets/BenchmarksPanel.svelte';
	import PipelinePanel from '$lib/components/widgets/PipelinePanel.svelte';
	import InstancesPanel from '$lib/components/widgets/InstancesPanel.svelte';
	import AppsPanel from '$lib/components/widgets/AppsPanel.svelte';
	import TestsPanel from '$lib/components/widgets/TestsPanel.svelte';
	import DevicesPanel from '$lib/components/widgets/DevicesPanel.svelte';
	import TranscriptPanel from '$lib/components/widgets/TranscriptPanel.svelte';
	import ContactsPanel from '$lib/components/widgets/ContactsPanel.svelte';
	import MailPanel from '$lib/components/widgets/MailPanel.svelte';
	import AtlasPanel from '$lib/components/widgets/AtlasPanel.svelte';
	import PerfPanel from '$lib/components/widgets/PerfPanel.svelte';
	import PtyStatusBar from '$lib/components/widgets/PtyStatusBar.svelte';
	import ApprovalBar from '$lib/components/widgets/ApprovalBar.svelte';
	import CenterChatView from '$lib/components/widgets/CenterChatView.svelte';
	import ImagePreviewBar from '$lib/components/widgets/ImagePreviewBar.svelte';
	import UsagePanel from '$lib/components/widgets/UsagePanel.svelte';
	import LiveCallPanel from '$lib/components/widgets/LiveCallPanel.svelte';
	import { terminal as terminalStore } from '$lib/stores/terminal.svelte.js';
	import { usage as usageStore, loadUsageData as storeLoadUsageData } from '$lib/stores/usage.svelte.js';
	// 2026-05-28: perf store. Parent keeps the trigger sites
	// (`_markLoad('mounted')`, `_trackWsMsg(type)`, etc.) but they are now
	// thin wrappers around the store's exported functions so the perf panel
	// sees every observation in real time.
	import {
		perf as perfStore,
		markLoad      as _markLoad,
		markSend      as _markSend,
		markSendPhase as _markSendPhase,
		trackWidget   as _trackWidget,
		trackWsMsg    as _trackWsMsg,
		loadPerfTrace,
		loadPerfProcesses,
		startPerfPolling,
		stopPerfPolling,
		postPerfEvent,
	} from '$lib/stores/perf.svelte.js';
	// Aliases so the existing template ({@const _wEntries = Object.entries(_widgetHealth)})
	// and existing reactive reads keep working without rewriting every call site.
	const _loadTimings   = perfStore.loadTimings;
	const _sendTimings   = perfStore.sendTimings;
	const _widgetHealth  = perfStore.widgetHealth;
	const _wsMsgCounts   = perfStore.wsMsgCounts;
	// Atlas store — `switchCenterView` now lazily triggers loadAtlasData()
	// inside AtlasPanel's onMount; parent no longer needs to drive it.
	import { loadAtlasData } from '$lib/stores/atlas.svelte.js';
	import { renderMarkdown } from '$lib/markdown.js';
	import { openCompose, openExpandedView, openPanCall } from '$lib/compose.js';
	import { mail as mailStore } from '$lib/stores/mail.svelte.js';
	import {
		loadContacts as storeLoadContacts,
		loadChatMessages as storeLoadChatMessages,
		endCall as storeEndCall,
	} from '$lib/stores/chat.svelte.js';

	// 2026-05-28: domain stores. Widgets now import directly from these
	// instead of receiving props from this page. We keep the parent's local
	// `$state` declarations as the canonical write sites (fetch handlers,
	// WS pushes, etc.) and mirror them into the stores via the $effect
	// block lower in this script. The widgets always see whatever the parent
	// last wrote. See docs/DASHBOARD-WIDGETS.md "Centralized state".
	import { services as servicesStore } from '$lib/stores/services.svelte.js';
	import { org as orgStore } from '$lib/stores/org.svelte.js';
	import { voice as voiceStore } from '$lib/stores/voice.svelte.js';
	import { project as projectStore } from '$lib/stores/project.svelte.js';
	import { devices as devicesStore } from '$lib/stores/devices.svelte.js';
	import { chat as chatStore } from '$lib/stores/chat.svelte.js';

	// Load Timer + STAGE_LABELS migrated to $lib/stores/perf.svelte.js

	// Send Timer + _markSend/_markSendPhase migrated to $lib/stores/perf.svelte.js
	// — but the send-path's local helper state (in-flight guards, queue, log,
	// pipeSending flag) stays here because it's used by sendTerminalInput and
	// templated into the send button. Restored 2026-05-28 after a too-greedy
	// regex deleted them with the perf state.
	const _sendInFlight = new Set();
	// Timestamp of last successful send — PTY screen detection must not override
	// claudeReady=false within 2s of a send (prevents race where echo hasn't
	// appeared yet and ❯ is still visible).
	let _lastSendTime = 0;
	// Reactive flag — true while the pipe POST is in-flight. Drives the
	// send-button spinner. (Also mirrored into terminalStore.pipeSending lower
	// in this script for widgets that read from the store.)
	let pipeSending = $state(false);

	// Message send log — every attempted send is saved to localStorage so
	// nothing is silently lost. Retrievable from the browser console via
	// `JSON.parse(localStorage.getItem('pan_send_log'))`.
	function _logSendAttempt(sessionId, text, status) {
		try {
			const key = 'pan_send_log';
			const log = JSON.parse(localStorage.getItem(key) || '[]');
			log.push({ ts: new Date().toISOString(), sessionId, text: text.slice(0, 500), status });
			if (log.length > 200) log.splice(0, log.length - 200);
			localStorage.setItem(key, JSON.stringify(log));
		} catch {}
	}

	// Per-session queue for messages that arrived when claudeReady=false.
	// Flushed by _flushQueue() as soon as claudeReady becomes true.
	const _pendingQueue = new Map();

	function _queueMessage(sessionId, text) {
		if (!_pendingQueue.has(sessionId)) _pendingQueue.set(sessionId, []);
		_pendingQueue.get(sessionId).push(text);
		_logSendAttempt(sessionId, text, 'queued');
		console.warn('[PAN Terminal] claudeReady=false — message queued, will send when ready:', text.slice(0, 80));
	}

	async function _flushQueue(sessionId) {
		const queue = _pendingQueue.get(sessionId);
		if (!queue?.length) return;
		_pendingQueue.delete(sessionId);
		for (const text of queue) {
			console.log('[PAN Terminal] Flushing queued message:', text.slice(0, 80));
			await sendTerminalInput(text);
		}
	}

	// _widgetHealth / _wsMsgCounts / _wsTotalMsgs / _wsLastMsgTs +
	// _trackWidget / _trackWsMsg migrated to $lib/stores/perf.svelte.js

	// LOAD_STAGE_ORDER + _fmtMs migrated to $lib/stores/perf.svelte.js

	// --- Session Cost (derived from active tab's turn_stats in transcript) ---
	let sessionCost = $derived.by(() => {
		const active = tabs.find(t => t.id === activeTabId);
		const msgs = getPushed(active?.id);
		// Find the LAST turn_stats message — it has cumulative totals
		for (let i = msgs.length - 1; i >= 0; i--) {
			const m = msgs[i];
			if (m.type === 'turn_stats' && m.tokens) {
				return {
					cost: m.tokens.total_cost ?? null,
					input: m.tokens.total_input || 0,
					output: m.tokens.total_output || 0,
					cacheRead: m.tokens.total_cache_read || 0,
					cacheCreate: m.tokens.total_cache_create || 0,
				};
			}
		}
		return null;
	});

	// --- State ---
	let projects = $state([]);
	let tabs = $state([]);
	let activeTabId = $state(null);
	let allProjectTabs = $state([]); // All tabs (open + closed) for current project dropdown
	let restoringTabs = $state(true); // True until auto-connect finishes — blocks manual project selection

	// Derived: the project dropdown value reflecting the active tab's project
	let selectedProjectValue = $derived.by(() => {
		const activeTab = tabs.find(t => t.id === activeTabId);
		if (!activeTab || !activeTab.project) return '';
		const proj = projects.find(p => p.name === activeTab.project);
		return proj ? String(proj.id || proj.path) : '';
	});
	// Force-sync the <select> DOM after projects load — Svelte may set
	// the value before the {#each} options exist in the DOM, so the
	// browser silently ignores it. This effect retries after a tick.
	$effect(() => {
		const val = selectedProjectValue;
		const _projects = projects; // subscribe to projects changes
		if (typeof window === 'undefined' || !val) return;
		tick().then(() => {
			const sel = document.querySelector('.project-select');
			if (sel && sel.value !== val) sel.value = val;
		});
	});
	let leftSection = $state(typeof window !== 'undefined' && localStorage.getItem('pan_left_section') || 'transcript');
	let centerView = $state('terminal'); // 'terminal' | 'chat'
	let rightSection = $state(typeof window !== 'undefined' && localStorage.getItem('pan_right_section') || 'services');
	// Persist panel selections on change
	$effect(() => { if (typeof window !== 'undefined') localStorage.setItem('pan_left_section', leftSection); });
	$effect(() => { if (typeof window !== 'undefined') localStorage.setItem('pan_right_section', rightSection); });

	// ── Permission matrix ────────────────────────────────────────────────────
	// Fetched once on load. Controls which panel options are visible in dropdowns.
	let permsMatrix = $state(/** @type {{power:number, realPower:number, isImpersonating:boolean, widgets:Record<string,{visible:boolean}>}} */ (null));

	// ── Impersonation ─────────────────────────────────────────────────────────
	// Modal moved to $lib/components/ImpersonatePanel.svelte (Shape-2 refactor
	// 2026-05-27). The component owns all modal state, lazy-loads
	// users/orgs/roles on open, and calls back via onApplied to refresh perms.
	// Parent only owns: the open/close trigger, the toolbar banner, the Exit
	// button (which still calls stopImpersonation here), and impersonationLabel
	// for rendering the banner text.
	let impersonateModalOpen = $state(false);

	async function reloadPermsMatrix() {
		try {
			const r = await api('/api/v1/permissions/matrix');
			permsMatrix = r;
		} catch { permsMatrix = { power: 100, realPower: 100, isImpersonating: false, widgets: {} }; }
	}

	async function stopImpersonation() {
		await api('/api/v1/impersonate', { method: 'DELETE' });
		await reloadPermsMatrix();
	}

	// Derive banner label from rich impersonation object
	function impersonationLabel(imp) {
		if (!imp) return '';
		if (imp.type === 'user') return `👤 ${imp.label} (lvl ${imp.power})`;
		if (imp.type === 'group') return `🏢 ${imp.label} (lvl ${imp.power})`;
		return `👁 ${imp.label} (lvl ${imp.power})`;
	}

	// Map panel option values → widget permission keys (absent = always visible)
	const PANEL_WIDGET_MAP = {
		devices:    'devices',
		instances:  'instances',
		tests:      'tests',
		users:      'users',
		project:    'projects',
		tasks:      'projects',
		// additional gated panels
		transcript: 'transcript',
		contacts:   'contacts',
		library:    'library',
		mail:       'mail',
		teams:      'teams',
		approvals:  'approvals',
		bugs:       'bugs',
		setup:      'setup',
		benchmarks: 'benchmarks',
		pipeline:   'pipeline',
		intuition:  'intuition',
		perf:       'perf',
		usage:      'usage',
		services:   'services',
		lifeboat:   'lifeboat',
	};

	/** Returns true if the panel option should be visible for the current user. */
	function widgetVisible(optionValue) {
		if (!permsMatrix) return true; // not yet loaded — show everything
		const key = PANEL_WIDGET_MAP[optionValue];
		if (!key) return true; // no gating rule → always show
		return permsMatrix.widgets[key]?.visible !== false;
	}

	// If a hidden panel is currently selected, fall back to a safe default.
	$effect(() => {
		if (!permsMatrix) return;
		if (!widgetVisible(leftSection))  leftSection  = 'transcript';
		if (!widgetVisible(rightSection)) rightSection = 'services';
	});
	
	// Sync LLM name with provider if not manually customized
	$effect(() => {
		if (typeof window !== 'undefined' && voiceSettings.terminal_ai_provider) {
			const provider = voiceSettings.terminal_ai_provider.toLowerCase();
			const currentLlmName = localStorage.getItem('pan_llm_name');
			if (provider === 'gemini' && (!currentLlmName || currentLlmName.toLowerCase() === 'claude')) {
				localStorage.setItem('pan_llm_name', 'Gemini');
				// Trigger re-render of existing transcripts
				window.dispatchEvent(new CustomEvent('pan-terminal-settings-changed'));
			} else if (provider === 'claude' && (!currentLlmName || currentLlmName.toLowerCase() === 'gemini')) {
				localStorage.setItem('pan_llm_name', 'Claude');
				window.dispatchEvent(new CustomEvent('pan-terminal-settings-changed'));
			}
		}
	});

	// Terminal input bar — persisted across tab switches
	let terminalInputText = $state(getTerminalInput());
	let terminalInputEl;
	// Approval prompt detection — populated when Claude shows a 1/2/3 style menu
	let approvalOptions = $state(null); // null | [{ num: 1, label: 'Yes' }, ...]
	// Claude ready state — false while processing, true when waiting for user input
	let claudeReady = $state(false); // Start false — must detect Claude actually running
	// Number of messages sent but not yet confirmed in the JSONL transcript
	let pendingSendCount = $state(0);

	// Live PTY status from /api/v1/terminal/sessions, polled every 2s.
	// This is the source of truth for "is the PTY alive / is Claude thinking"
	// — replaces the lying local claudeReady flag that desyncs across refreshes.
	// Shape: { pid, thinking, lastInputTs, lastOutputTs, clients, createdAt } | null
	let ptyStatus = $state(null);
	let ptyStatusNow = $state(Date.now()); // ticks every 1s for live duration display

	// Users migrated to $lib/components/UsersPanel.svelte

	// Teams migrated to $lib/components/TeamsPanel.svelte

	// PAN Clients (connected secondary machines)
	let panClientDevices = $state([]);
	let panClientInviteCmd = $state('');
	let panClientInviteName = $state('');
	let panClientPollTimer = null;
	let allDevicesPollTimer = null;
	let allDevices = $state([]);

	// Webcam force capture + Voice enrollment — moved to IntuitionPanel.svelte
	// (Shape-2 refactor 2026-05-27). The Identity card embeds both controls,
	// so the state + handlers travel with the component.
	let deviceRenameId = $state(null);
	let deviceRenameName = $state('');
	let deviceDeleteConfirmId = $state(null);
	// deviceFilter + deviceExpandedIds migrated to $lib/components/widgets/DevicesPanel.svelte

	// Alerts state migrated to $lib/components/AlertsPanel.svelte
	// (Shape-2 refactor 2026-05-27). Parent only keeps `alertOpenCount`
	// as a bindable prop so the panel-selector dropdown can show "(N)".
	let alertOpenCount = $state(0);
	let approvalsCount = $state(0);

	// Tests
	// Test state migrated to $lib/components/widgets/TestsPanel.svelte
	// usageData migrated to $lib/stores/usage.svelte.js
	let rightMilestoneFilter = $state(null);

	// Panel resize state
	let leftPanelWidth = $state(340);
	let rightPanelWidth = $state(260);
	let resizingPanel = $state(null); // 'left' | 'right' | null
	let resizeStartX = $state(0);
	let resizeStartWidth = $state(0);
	let hostLabel = $state('');
	let sessionsCount = $state(0);
	let orgData = $state(null); // { org_name, user_nickname, role, orgs }

	// Project/task data for sidebar
	let projectData = $state(null);
	let tasksData = $state(null);
	let sectionsData = $state([]);
	let servicesData = $state([]);
	// ─── Intuition state — MOVED TO IntuitionPanel.svelte ────────────────────
	// All intuition state (intuitionMembers, intuitionSnapsByCommander,
	// intuitionOrgSnap, intuitionIndSnap, selectedIntuitionUser, intuitionLoaded,
	// intuitionSnapshotsLoaded, intuitionStatus) now lives inside the component.
	// Parent only owns `orgData` which is passed in as a prop.
	// See $lib/components/IntuitionPanel.svelte + docs/DASHBOARD-REFACTOR-MAP.md.

	// Retrying loader for the org context. orgData is shared with multiple
	// widgets (Intuition, life-needs, pan-mind), so it stays in the parent
	// and gets passed down as a prop. Retries with exponential backoff up to
	// ~2 minutes. The $effect inside IntuitionPanel watches the orgData prop
	// and refreshes as soon as org_id lands. Also re-invoked from the WS
	// `carrier_ready` handler so a post-restart reconnect re-validates org
	// context immediately.
	// REGRESSION TEST: kill Carrier mid-page-load. orgData should populate
	// within ~10s of Carrier coming back, intuition card renders automatically.
	let _orgLoaderInFlight = false;
	async function loadOrgContextWithRetry() {
		if (_orgLoaderInFlight) return;
		_orgLoaderInFlight = true;
		try {
			const delays = [0, 500, 1000, 2000, 4000, 8000, 15000, 30000, 60000];
			for (let i = 0; i < delays.length; i++) {
				if (delays[i] > 0) await new Promise(res => setTimeout(res, delays[i]));
				try {
					const r = await api('/api/v1/org/current');
					if (r && r.org_id) {
						orgData = r;
						return;
					}
				} catch (e) {
					// Fall through to next retry.
				}
			}
			console.warn('[orgData] failed to load org context after retries — intuition widget will remain blank until next reconnect');
		} finally {
			_orgLoaderInFlight = false;
		}
	}

	// Intuition + PAN-Mind + Motives + Voice enrollment + force-cam-capture:
	// all migrated to $lib/components/IntuitionPanel.svelte (Shape-2 refactor
	// 2026-05-27). The component owns its own state, polling, and WS event
	// subscription via window CustomEvent("pan:intuition-update").

	// Generic widget-state resolver for the L1 dashboard self-heal substrate
	// (task #504). Each panel emits data-widget-state on its container so the
	// browser-telemetry L2 / steward L3 / vision-verifier L4 layers can detect
	// rendered-but-empty/stale states without guessing. Sections whose state
	// lives inside an extracted component return 'ok' here — the child sets
	// its own data-widget-state attribute on its root.
	function widgetStateOf(section) {
		if (!section) return 'empty';
		switch (section) {
			case 'intuition': return 'ok'; // IntuitionPanel emits its own state
			case 'services': return (Array.isArray(servicesData) && servicesData.length > 0) ? 'ok' : 'loading';
			case 'devices': {
				const have = (Array.isArray(panClientDevices) && panClientDevices.length > 0)
					|| (Array.isArray(allDevices) && allDevices.length > 0);
				return have ? 'ok' : 'loading';
			}
			case 'alerts': return 'ok';     // AlertsPanel manages own state
			case 'approvals': return 'ok';  // ApprovalsPanel manages own state
			case 'tests': return 'ok';  // TestsPanel manages own state
			case 'library': return 'ok';  // LibraryPanel manages own state
			case 'usage': return 'ok';  // UsagePanel manages own state
			case 'transcript': return 'ok';
			case 'tasks':
			case 'bugs': return 'ok';
			case 'project': return projectData ? 'ok' : 'loading';
			case 'lifeboat': return lifeboatData ? 'ok' : 'loading';
			case 'users': return 'ok';  // UsersPanel manages own state
			case 'teams': return 'ok';  // TeamsPanel manages own state
			case 'contacts': return 'ok';  // ContactsPanel manages own state
			case 'benchmarks': return 'ok';  // BenchmarksPanel manages own state
			case 'pipeline': return 'ok';  // PipelinePanel manages own state
			case 'mail': return 'ok';  // MailPanel manages own state
			case 'perf':
			case 'apps':
			case 'instances':
			case 'setup':
			case 'calendar': return 'ok';
			default: return 'ok';
		}
	}

	// approvalsData migrated to $lib/components/ApprovalsPanel.svelte. Parent
	// only keeps `approvalsCount` (declared above) for the dropdown badge.

	// Benchmarks
	// Benchmarks state + functions migrated to $lib/components/BenchmarksPanel.svelte

	// Beta Pipeline state + functions migrated to $lib/components/PipelinePanel.svelte

	// Chat/Contacts state migrated to $lib/stores/chat.svelte.js

	// Mail state migrated to $lib/stores/mail.svelte.js

	// Compose (openCompose, openExpandedView) migrated to $lib/compose.js

	// loadContacts / loadChatThreads / openChat / loadChatMessages /
	// sendChatMessage / addContact / deleteContact / toggleFavorite /
	// startCall / endCall / loadMail / loadMailStatus / syncMail /
	// openCompose / openExpandedView / formatMailDate — all migrated
	// to $lib/stores/chat.svelte.js, $lib/stores/mail.svelte.js, and
	// $lib/compose.js.

	function formatChatTime(ts) {
		if (!ts) return '';
		const d = new Date(ts);
		const now = new Date();
		const isToday = d.toDateString() === now.toDateString();
		if (isToday) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
		return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
	}

	// Lifeboat state
	// Lifeboat state migrated to $lib/components/LifeboatPanel.svelte

	// Apps state + functions migrated to $lib/components/AppsPanel.svelte

	// Atlas state
	// Atlas state migrated to $lib/stores/atlas.svelte.js
	let atlasSvgEl;
	// Atlas elapsed/timers migrated to $lib/stores/atlas.svelte.js
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
	const MIN_TERMINAL_WIDTH = 650; // ~75 chars at monospace — optimal reading width
	function onResizeMove(e) {
		if (!resizingPanel) return;
		const delta = e.clientX - resizeStartX;
		const totalWidth = window.innerWidth;
		// Estimate sidebar width (layout sidebar + its resize handle)
		const sidebarEst = document.querySelector('.sidebar')?.offsetWidth || 210;
		const chrome = sidebarEst + 20; // sidebar + resize handles + padding
		if (resizingPanel === 'left') {
			let proposed = Math.min(600, Math.max(160, resizeStartWidth + delta));
			// Don't let terminal go below minimum
			const available = totalWidth - chrome - proposed - rightPanelWidth;
			if (available < MIN_TERMINAL_WIDTH) proposed = totalWidth - chrome - rightPanelWidth - MIN_TERMINAL_WIDTH;
			leftPanelWidth = Math.max(160, proposed);
		} else {
			let proposed = Math.min(400, Math.max(160, resizeStartWidth - delta));
			const available = totalWidth - chrome - leftPanelWidth - proposed;
			if (available < MIN_TERMINAL_WIDTH) proposed = totalWidth - chrome - leftPanelWidth - MIN_TERMINAL_WIDTH;
			rightPanelWidth = Math.max(160, proposed);
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

	// Lightweight markdown → HTML for chat bubbles (bold, bullets, inline code, links)
	// renderMarkdown migrated to $lib/markdown.js — see import above

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
				claudeSessionIds: t.claudeSessionIds || [],
				model: t.model || null
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
					cwd: t.project_path || t.cwd || '%USERPROFILE%\\Desktop',
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
		const cwd = dbTab.project_path || dbTab.cwd || '%USERPROFILE%\\Desktop';
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
	let availableModels = $state([]);
	let localModels = $state([]);
	let isListening = $state(false);
	let recognition = null;
	let pastedImages = $state([]); // { dataUrl, path } — preview before send

	// Library widget migrated to $lib/components/LibraryPanel.svelte

	// Perf widget
	// Perf engine state + PERF_PHASE constants migrated to $lib/stores/perf.svelte.js

	// Perf loaders + pollers + killProcess migrated to $lib/stores/perf.svelte.js
	// — but `updatePerfOverlay` stays here because it's called from the WS
	// frame handler on every screen/screen-v2 message (hot path) and it
	// computes a rolling FPS that needs module-local state (_perfFrames,
	// _perfLastFpsTime). It just writes the result into the perf store.
	let _perfFrames = 0;
	let _perfLastFpsTime = Date.now();
	function updatePerfOverlay(data) {
		_perfFrames++;
		const now = Date.now();
		if (now - _perfLastFpsTime >= 1000) {
			data.fps = _perfFrames;
			_perfFrames = 0;
			_perfLastFpsTime = now;
		} else {
			data.fps = perfStore.data.fps;
		}
		perfStore.data = data;
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
			cwd = projectOrValue.path || projectOrValue.cwd || '%USERPROFILE%\\Desktop';
		} else {
			return;
		}

		// If a tab already exists for this project, switch to it.
		// Use the + button or newTerminalTab() to create additional tabs for the same project.
		const existing = tabs.find(t => t.project === projectName);
		if (existing) {
			switchToTab(existing.id);
			return;
		}

		// Before creating a new session, check if the server already has a live PTY
		// for this project. This prevents orphan duplication on hard refresh when the
		// DB/localStorage restore fails but the server-side PTY is still alive.
		try {
			const sessData = await api('/api/v1/terminal/sessions');
			const liveMatch = (sessData.sessions || []).find(s =>
				s.project === projectName && s.id.startsWith(sessionPrefix)
			);
			if (liveMatch) {
				console.log(`[PAN Terminal] Reusing live server session for ${projectName}: ${liveMatch.id}`);
				await createTab(liveMatch.id, projectName, cwd, projectId, true, null);
				if (projectId) loadAllProjectTabs(projectId);
				return;
			}
		} catch (e) {
			console.warn('[PAN Terminal] Could not check live sessions:', e.message);
		}

		const sessionId = sessionPrefix + (projectName || 'shell').toLowerCase().replace(/[^a-z0-9]/g, '-') + '-' + Date.now();
		await createTab(sessionId, projectName, cwd, projectId, false, null);
		if (projectId) loadAllProjectTabs(projectId);
	}

	function newTerminalTab() {
		const active = getActiveTab();
		const projectName = active?.project || 'Shell';
		const projectId = active?.projectId || null;
		const cwd = active?.cwd || '%USERPROFILE%\\Desktop';
		const sessionId = sessionPrefix + (projectName || 'shell').toLowerCase().replace(/[^a-z0-9]/g, '-') + '-' + Date.now();
		// force_new=true: skip server-side dedup guard so this tab gets its own PTY,
		// not a redirect to whatever existing session the project already has open.
		createTab(sessionId, projectName, cwd, projectId, false, null, undefined, true);
	}

	async function createTab(sessionId, projectName, cwd, projectId, isReconnect, tabName, savedClaudeSessionIds, forceNew = false) {
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
			// Per-tab model override — null means "use global default (voiceSettings.terminal_ai_model)".
			// Set when the user picks a model from the dropdown for this tab.
			model: null,
			claudeStarted: false,
			container: tabContainer,
			scrollbackDiv,
			screenDiv,
			host: '',
			_closing: false,
			claudeSessionIds: savedClaudeSessionIds || [],
			reconnectToken: sessionStorage.getItem('pan_reconnect_token:' + sessionId) || null,
			userScrolledUp: false,
			logLines: [],       // Append-only log from server (immune to corruption)
			draft: sessionStorage.getItem('pan_tab_draft:' + sessionId) || '',
			pastedImages: [],   // Per-tab image attachments
		};

		// Restore per-tab model override from saved state (survives page reload).
		// On reconnect we re-issue set-model to the server when the WS opens.
		try {
			const savedTabs = getSavedSessionState();
			const saved = savedTabs.find(s => s.sessionId === sessionId);
			if (saved?.model) tabData.model = saved.model;
		} catch {}

		// Track if user has scrolled up (don't auto-scroll if so)
		// Persist to sessionStorage so scroll position survives page refresh.
		// Store the handler reference on tabData so closeTab() can remove it and
		// release the closure — otherwise the tabData object can't be GC'd after close.
		tabData._scrollHandler = () => {
			const atBottom = tabContainer.scrollHeight - tabContainer.scrollTop - tabContainer.clientHeight < 40;
			tabData.userScrolledUp = !atBottom;
			try {
				sessionStorage.setItem('pan_scrolled_up:' + tabData.sessionId, tabData.userScrolledUp ? '1' : '0');
				if (tabData.userScrolledUp) {
					sessionStorage.setItem('pan_scroll_pos:' + tabData.sessionId, String(tabContainer.scrollTop));
				}
			} catch {}
		};
		tabContainer.addEventListener('scroll', tabData._scrollHandler);
		// Restore scroll state from sessionStorage (survives refresh)
		try {
			const wasUp = sessionStorage.getItem('pan_scrolled_up:' + sessionId);
			if (wasUp === '1') tabData.userScrolledUp = true;
		} catch {}

		// Show only this tab's container
		tabs.forEach(t => { if (t.container) t.container.style.display = 'none'; });
		tabContainer.style.display = 'block';

		tabs = [...tabs, tabData];
		activeTabId = tabId;
		sessionsCount = tabs.length;
		// Restore input draft for this tab
		terminalInputText = tabData.draft || '';
		setTerminalInput(terminalInputText);

		// Initial transcript render — fetch messages via HTTP if WebSocket push
		// hasn't arrived yet (common after page reload / hot swap).
		setTimeout(async () => {
			renderTranscriptToTerminal(tabData);
			// If still no messages after 100ms (WebSocket push didn't arrive),
			// fetch from HTTP endpoint as fallback
			if (!(getPushed(tabData.id).length > 0)) {
				try {
					const ctrl = new AbortController();
					setTimeout(() => ctrl.abort(), 2000);
					const r = await fetch(`/api/v1/terminal/messages/${encodeURIComponent(sessionId)}`, { signal: ctrl.signal });
					const d = await r.json();
					if (d.ok && d.messages?.length > 0) {
						setPushed(tabData.id, d.messages);
						renderTranscriptToTerminal(tabData);
					}
				} catch {}
			}
			// Restore scroll position after first render
			try {
				const savedPos = sessionStorage.getItem('pan_scroll_pos:' + tabData.sessionId);
				if (tabData.userScrolledUp && savedPos != null) {
					tabData.container.scrollTop = parseFloat(savedPos);
				}
			} catch {}
		}, 100);

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
			const csidsParam = tabData.claudeSessionIds.length > 0 ? '&claude_sessions=' + encodeURIComponent(JSON.stringify(tabData.claudeSessionIds)) : '';
			const tokenParam = tabData.reconnectToken ? '&token=' + encodeURIComponent(tabData.reconnectToken) : '';
			const forceNewParam = forceNew ? '&force_new=1' : '';
			const wsUrlStr = wsUrl(`/ws/terminal?session=${encodeURIComponent(sessionId)}&project=${encodeURIComponent(projectName)}&cwd=${encodeURIComponent(cwd)}&cols=${calcCols}&rows=${calcRows}${csidsParam}${tokenParam}${forceNewParam}`);

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
					// Any server message after wsOpen proves the PTY session is attached.
					_markLoad('ptyAttached');
					// Ensure ptyStatus is never null while WS is live — prevents "No PTY Attached" flash
					if (!ptyStatus && tabData?.sessionId) {
						ptyStatus = { id: tabData.sessionId, thinking: false, claudeRunning: true };
					}
					// Track all incoming WS message types for the perf panel
					if (msg.type && msg.type !== 'screen-v2' && msg.type !== 'screen') _trackWsMsg(msg.type);
					switch (msg.type) {
						case 'user_echo': {
							_markSendPhase('echo');
							// Immediate echo from server — user message appears instantly
							// without waiting for JSONL. Dedup handles overlap when JSONL arrives.
							pushEcho(tabData.id, {
								role: 'user', type: 'prompt',
								text: msg.text, ts: msg.ts,
								_echo: true,
							});
							renderTranscriptToTerminal(tabData);
							break;
						}
						case 'transcript_messages': {
							_markLoad('firstTranscript');
							if (_loadTimings.firstScreen) _markLoad('interactive');
							// If the last JSONL message is from the assistant AND arrived after our send,
							// mark that as the first-assistant milestone.
							if (_sendTimings.awaitingAssistant && Array.isArray(msg.messages) && msg.messages.length) {
								const last = msg.messages[msg.messages.length - 1];
								if (last && last.role === 'assistant') _markSendPhase('assistant');
							}
							// Server pushed parsed messages from the JSONL file watcher.
							// Replaces polling. We get the full deduped message list each
							// time any JSONL in the project's dir changes.
							// Use _messageVersion (integer from server) for dedup — avoids
							// Svelte proxy vs raw object stale-comparison bug (#444).
							if (msg.version !== undefined && tabData._lastMessageVersion === msg.version) break;
							if (msg.version !== undefined) tabData._lastMessageVersion = msg.version;
							const _serverMsgs = msg.messages || [];
							// When the session was reset (PAN crashed), _preservedHistory holds the
							// messages from before the crash. Merge them with new server messages so
							// the user doesn't lose their conversation history visually.
							let _newPushed;
							if (tabData._preservedHistory?.length && _serverMsgs.length > 0) {
								const _serverTexts = new Set(_serverMsgs.map(m => (m.text || '').slice(0, 120)));
								const _histMsgs = tabData._preservedHistory.filter(m => !_serverTexts.has((m.text || '').slice(0, 120)));
								_newPushed = _histMsgs.length > 0
									? [..._histMsgs, { role: 'system', type: 'session_reset_marker', text: 'Session reset — new conversation', source: 'client', ts: tabData._sessionLostAt || new Date().toISOString() }, ..._serverMsgs]
									: _serverMsgs;
							} else {
								_newPushed = _serverMsgs;
							}
							setPushed(tabData.id, _newPushed); // single source of truth
							tabData._lastTranscriptPush = Date.now();
							// Clear loading + session-lost indicators once real transcript data arrives
							if (tabData._claudeLoading && _serverMsgs.length) {
								tabData._claudeLoading = false;
							}
							if (tabData._sessionLost && _serverMsgs.length) {
								tabData._sessionLost = false;
							}
							// Clear echoes that now have matching JSONL entries
							const _existingEchoes = getEchoes(tabData.id);
							if (_existingEchoes.length) {
								const jsonlTexts = new Set(_serverMsgs
									.filter(m => m.role === 'user')
									.map(m => (m.text || '').replace(/\s+/g, ' ').trim()));
								setEchoes(tabData.id, _existingEchoes
									.filter(e => !jsonlTexts.has((e.text || '').replace(/\s+/g, ' ').trim())));
							}
							renderTranscriptToTerminal(tabData);
							// Update left panel bubbles synchronously — same messages array,
							// no async, no lock, no proxy. Mirrors how right panel renders.
							if (activeTabId === tabData.id) {
								const b = bubblesFromMessages(getPushed(tabData.id));
								if (b !== null) {
									const isFirstChatLoad = !chatServerLoaded;
									chatBubbles = b;
									chatServerLoaded = true;
									// Restore scroll position after first load (refresh / craft swap).
									// Must happen after Svelte flushes the DOM update, so use tick().
									if (isFirstChatLoad && chatSidebarEl) {
										tick().then(() => {
											if (!chatSidebarEl) return;
											try {
												const storedUp = sessionStorage.getItem('pan_transcript_scrolled_up');
												const storedPos = sessionStorage.getItem('pan_transcript_scroll_pos');
												if (storedUp === '1' && storedPos != null) {
													chatSidebarEl.scrollTop = parseFloat(storedPos);
												} else {
													chatSidebarEl.scrollTop = chatSidebarEl.scrollHeight;
												}
											} catch { chatSidebarEl.scrollTop = chatSidebarEl.scrollHeight; }
										});
									} else if (chatSidebarEl) {
										// Subsequent updates — stick to bottom only if already there
										const distFromBottom = chatSidebarEl.scrollHeight - chatSidebarEl.scrollTop - chatSidebarEl.clientHeight;
										if (distFromBottom < 60) {
											tick().then(() => { if (chatSidebarEl) chatSidebarEl.scrollTop = chatSidebarEl.scrollHeight; });
										}
									}
								}
							}
							break;
						}
						case 'screen-v2': {
							_markLoad('firstScreen');
							if (_loadTimings.firstTranscript || _loadTimings.transcriptWidget) _markLoad('interactive');
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
							// Don't flip claudeReady back to true within 2s of a send — the PTY echo
							// of our own message appears before Claude starts "Thinking...", so the ❯
							// prompt is briefly still visible and would defeat the duplicate-send guard.
							const msSinceSend = Date.now() - _lastSendTime;
							// Only apply PTY-screen ready detection when the screen has actual content.
							// Empty screens come from pipe/adapter sessions (no PTY) and must not
							// reset claudeReady — pipe sessions use state/pipe_ready events instead.
							const hasScreenContent = plainLines.some(l => l.trim().length > 0);
							if (hasScreenContent) {
								if (ptySaysReady && msSinceSend >= 2000) {
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
							_markLoad('firstScreen');
							if (_loadTimings.firstTranscript || _loadTimings.transcriptWidget) _markLoad('interactive');
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
						case 'session_redirect': {
							// Server told us a session for this project already exists — reconnect to it.
							// This happens when two windows race to create the same project session.
							const redirectId = msg.session_id;
							if (redirectId && redirectId !== sessionId) {
								console.warn(`[PAN Terminal] Dedup redirect: ${sessionId} → ${redirectId}`);
								ws.close();
								// Update this tab's session ID and reconnect
								tabData.sessionId = redirectId;
								const newWsUrl = wsUrl(`/ws/terminal?session=${encodeURIComponent(redirectId)}&project=${encodeURIComponent(projectName)}&cwd=${encodeURIComponent(cwd)}&cols=${calcCols}&rows=${calcRows}`);
								tabData.ws = new WebSocket(newWsUrl);
								tabData.ws.addEventListener('message', handleMessage);
								tabData.ws.addEventListener('close', handleClose);
							}
							break;
						}
						case 'info':
							tabData.host = msg.host || '';
							if (msg.claudeLaunched) tabData.claudeStarted = true;
							// Phase 3: Store reconnect token for seamless reconnection
							if (msg.reconnectToken) {
								tabData.reconnectToken = msg.reconnectToken;
								sessionStorage.setItem('pan_reconnect_token:' + sessionId, msg.reconnectToken);
							}
							if (msg.restoredFromToken) {
								console.log(`[PAN] Session restored from reconnect token: ${sessionId}`);
							}
							if (msg.tokenExpired) {
								console.warn(`[PAN] Reconnect token expired — session context may be incomplete`);
								tabData.systemMessages = [...(tabData.systemMessages || []),
									{ role: 'system', type: 'banner', text: 'Reconnect token expired — started fresh session', ts: new Date().toISOString() }
								];
							}
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
							tabData.ptyUptimeSec = uptimeSec;
							if (activeTabId === tabData.id) claudeReady = true;
							// Re-render so the PTY exit banner appears via renderTranscriptToTerminal
							// (don't append raw HTML — it gets wiped on next render cycle)
							renderTranscriptToTerminal(tabData);
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
									// Always assign to the tab that owns this WebSocket (tabData),
									// NOT getActiveTab() — that was stealing sessions from other tabs
									// whenever the user switched to a new tab while Claude was still running.
									tabData.claudeSessionIds = [...new Set([...tabData.claudeSessionIds, updateSid])];
									tabs = [...tabs];
									// Tell the backend about the new Claude session so it filters transcripts correctly
									if (tabData.ws && tabData.ws.readyState === 1) {
										tabData.ws.send(JSON.stringify({ type: 'set_claude_sessions', sessions: tabData.claudeSessionIds }));
									}
								}
							}
							if (leftSection === 'transcript' || rightSection === 'transcript') {
								loadChatHistory(tabData);
							}
							// Refresh main terminal view from transcript
							renderTranscriptToTerminal(tabData);
							break;
						}
						case 'permission_prompt':
							break;
						case 'pipeline_event':
							// Beta Pipeline state change from Carrier — update panel live
							if (msg.pipeline) {
								if (pipelineData) pipelineData = { ...pipelineData, pipeline: msg.pipeline };
								else pipelineData = { pipeline: msg.pipeline, beta: null, production: null, pending: 0 };
							}
							// Refresh full status on terminal events (beta healthy, promoted, etc.)
							if (['beta_healthy', 'promoted', 'aborted', 'benchmarks_passed', 'benchmarks_failed'].includes(msg.type)) {
								if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("pan:pipeline-update"));
							}
							break;
						case 'server_swap':
							// Carrier hot-swapped a new Craft.
							// Bug #457: Don't blindly reload — first check whether the dashboard
							// bundle actually changed. If the bundle is identical, the WS reconnect
							// + adapter (which lives on the Carrier, NOT the Craft) is enough to
							// restore everything. Reloading wipes tabs/scrollback/Π Remembers
							// for no benefit.
							if (!window._panSwapReloading) {
								window._panSwapReloading = true;
								(async () => {
									let bundleChanged = true; // fail-safe: if check fails, behave as before
									try {
										const r = await fetch('/api/dashboard/bundle-hash', { cache: 'no-store' });
										if (r.ok) {
											const { hash } = await r.json();
											const prior = window._panBundleHash;
											if (prior && hash && prior === hash) bundleChanged = false;
											console.log(`[PAN] Craft swapped — bundle hash ${prior} → ${hash} (changed=${bundleChanged})`);
										}
									} catch (e) {
										console.warn('[PAN] bundle-hash check failed, falling back to reload:', e?.message);
									}
									if (bundleChanged) {
										console.log('[PAN] Bundle changed — waiting for server ready then reloading...');
										waitForServerAndReload('⟳ Updating — reloading when ready…');
									} else {
										// Same bundle — no reload. WS reconnect + Carrier-side adapter
										// will restore state without touching the DOM.
										console.log('[PAN] Bundle unchanged — skipping reload (PTY/transcripts preserved)');
										window._panSwapReloading = false;
									}
								})();
							}
							break;
						case 'server_restarting':
							serverRestarting = true;
							reconnectAttempts = 0;
							// Phase 3: Capture latest token for reconnection
							if (msg.reconnectToken) {
								tabData.reconnectToken = msg.reconnectToken;
								sessionStorage.setItem('pan_reconnect_token:' + sessionId, msg.reconnectToken);
							}
							scrollbackDiv.innerHTML += '\n<span style="color:#f9e2af">[Server restarting \u2014 will reconnect automatically...]</span>';
							break;
						case 'swap_failed': {
							// Carrier hot-swap aborted (health_failed or gate_failed).
							// /api/carrier/swap ALWAYS returns {ok:true,"Swap initiated"} because
							// performSwap() is fire-and-forget — this WS message is the only way
							// the dashboard can tell the user prod is still on the OLD Craft.
							const phase = msg.phase || 'unknown';
							const reason = msg.reason || 'unknown';
							const detail = (msg.detail || '').toString().slice(0, 200);
							const tail = (msg.stderr_tail || '').toString().slice(-400);
							// Terminal scrollback is the primary surface — no top banner needed.
							// If stderr tail exists, include it inline in the scrollback so the user can read it without a popup.
							scrollbackDiv.innerHTML += `\n<span style="color:#f38ba8">[Craft swap aborted \u2014 ${phase}: ${reason}${detail ? ' (' + detail + ')' : ''} \u2014 prod still on ${msg.old_commit || 'old'} commit]</span>`;
							if (tail) {
								const escTail = tail.replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]));
								scrollbackDiv.innerHTML += `\n<span style="color:#6c7086;font-family:monospace;font-size:11px;white-space:pre-wrap">${escTail}</span>`;
							}
							break;
						}
						case 'carrier_ready': {
							// Carrier finished respawning after a user-requested restart and the
							// primary Craft is healthy. Clear the blue "restarting" banner and show
							// a one-shot green confirmation so the user knows it actually worked
							// instead of waiting on the 30s safety timer.
							const craftId = msg.craft_id ?? '?';
							const commit = (msg.craft_commit || '').slice(0, 7);
							const downtime = msg.downtime_ms ? (msg.downtime_ms / 1000).toFixed(1) + 's' : '?';
							scrollbackDiv.innerHTML += `\n<span style="color:#a6e3a1">[\u2713 PAN back online \u2014 Craft-${craftId} ${commit} after ${downtime}]</span>`;
							if (typeof window !== 'undefined') {
								// Clear the existing blue "restarting" banner if it's still up.
								if (window._panCarrierRestartBanner) {
									document.querySelectorAll('div').forEach(d => {
										if (d.textContent && d.textContent.startsWith('\u27f3 PAN restarting')) {
											try { d.remove(); } catch {}
										}
									});
									window._panCarrierRestartBanner = false;
								}
								const banner = document.createElement('div');
								banner.textContent = `\u2713 PAN back online \u2014 Craft-${craftId} ${commit} after ${downtime}`;
								banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;background:#1e1e2e;color:#a6e3a1;padding:8px 16px;text-align:center;font-family:inherit;font-weight:600;border-bottom:1px solid #a6e3a1;box-shadow:0 2px 8px rgba(0,0,0,0.4);transition:opacity 0.4s';
								document.body.appendChild(banner);
								setTimeout(() => { banner.style.opacity = '0'; setTimeout(() => { try { banner.remove(); } catch {} }, 500); }, 4500);
							}
							serverRestarting = false;
							// Re-validate org context. If the page's initial fetch ran during
							// the restart window and got a 502/connection-refused, orgData
							// would be null and every gated widget (intuition, life-needs,
							// pan-mind) would stay blank. The retry loader is idempotent
							// (guarded by _orgLoaderInFlight) so calling it here is safe even
							// when orgData is already populated — it'll no-op.
							if (!orgData?.org_id) {
								try { loadOrgContextWithRetry(); } catch (e) { /* defined at top-level */ }
							}
							break;
						}
						case 'pan_resumed': {
							// SessionStart hook fired with source='resume' — Claude resumed an
							// existing session (typically after carrier restart). The full Π
							// Remembers preamble is suppressed by the anti-repetition rule, so
							// render a one-line scrollback marker with the last topic instead.
							const lastTopic = (msg.last_topic || '').toString().trim();
							const topicText = lastTopic ? ` \u2014 last: "${lastTopic}"` : '';
							scrollbackDiv.innerHTML += `\n<span style="color:#94e2d5">[\u21bb \u03a0\u0391\u039d resumed${topicText}]</span>`;
							break;
						}
						case 'carrier_restarting': {
							// Carrier is about to process.exit(1); pan-loop will respawn it in ~2s.
							// Existing reconnect tokens (stored in sessionStorage per tab) will be
							// replayed by the WS reconnect loop below — same path as server_restarting.
							serverRestarting = true;
							reconnectAttempts = 0;
							const delayMs = msg.reconnect_in_ms || 2500;
							const reason = msg.reason === 'forced' ? ' (forced)' : '';
							scrollbackDiv.innerHTML += `\n<span style="color:#89b4fa">[PAN restarting${reason} \u2014 reconnecting in ~${Math.round(delayMs/1000)}s...]</span>`;
							// Show a one-shot global banner so the user doesn't have to find the right tab.
							if (typeof window !== 'undefined' && !window._panCarrierRestartBanner) {
								window._panCarrierRestartBanner = true;
								const banner = document.createElement('div');
								banner.textContent = `⟳ PAN restarting${reason} — reconnecting…`;
								banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;background:#1e1e2e;color:#89b4fa;padding:8px 16px;text-align:center;font-family:inherit;font-weight:600;border-bottom:1px solid #89b4fa;box-shadow:0 2px 8px rgba(0,0,0,0.4)';
								document.body.appendChild(banner);
								// Banner auto-removes once reconnect succeeds (see _panSwapReloading reset flow),
								// but also self-clear after 30s as a safety net.
								setTimeout(() => { try { banner.remove(); } catch {} window._panCarrierRestartBanner = false; }, 30_000);
							}
							break;
						}
						case 'widget_update': {
							// Server pushed a change notification — refetch the affected widget.
							// This is the PRIMARY update path — polling intervals are long fallbacks only.
							const w = msg.widget;
							_trackWidget(w, 'push'); // record WS push in perf panel
							if (w === 'alerts') {
								loadAlertCount();
								if (typeof window !== 'undefined') {
									window.dispatchEvent(new CustomEvent('pan:alerts-update'));
								}
							} else if (w === 'services') {
								api('/dashboard/api/services').then(r => { servicesData = r?.services || []; }).catch(() => {});
							} else if (w === 'approvals') {
								if (typeof window !== 'undefined') {
									window.dispatchEvent(new CustomEvent('pan:approvals-update'));
								}
							} else if (w === 'intuition') {
								// Intuition snapshot ready — notify the IntuitionPanel
								// component (it subscribes to this event in onMount).
								if (typeof window !== 'undefined') {
									window.dispatchEvent(new CustomEvent('pan:intuition-update'));
								}
							} else if (w === 'library') {
								if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('pan:library-update'));
							} else if (w === 'users') {
								if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('pan:users-update'));
							} else if (w === 'teams') {
								if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('pan:teams-update'));
							} else if (w === 'tests') {
								if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('pan:tests-update'));
							} else if (w === 'devices') {
								loadClientDevices();
								loadAllDevices();
							}
							break;
						}
						case 'state': {
							// Server state machine pushed new session state (Part 3 refactor).
							// Update tabData so UI can react — claudeReady derived from WORKING state.
							if (msg.state) {
								tabData._sessionState = msg.state;
								const working = msg.state === 'working' || msg.state === 'interrupted';
								tabData.claudeReady = !working;
								if (activeTabId === tabData.id) claudeReady = !working;
								console.log(`[PAN #447] state push: state=${msg.state} → claudeReady=${!working}`);
							}
							break;
						}
						case 'mode': {
							// Server mode machine pushed new session mode (Part 2 refactor).
							// Track mode so input dispatch can show correct UI hints.
							if (msg.mode) tabData._sessionMode = msg.mode;
							break;
						}
						case 'pipe_ready': {
							// Backend adapter finished (normal completion, error recovery, or watchdog
							// recovery from stuck-WORKING). Re-enable input immediately.
							// This fires from pipeSend.then(), pipeSend.catch(), and the 60/90s watchdog.
							console.log(`[PAN #447] pipe_ready received — setting claudeReady=true (tab=${tabData.id}, active=${activeTabId === tabData.id})`);
							tabData.claudeReady = true;
							if (activeTabId === tabData.id) claudeReady = true;
							// Flush any messages queued while claudeReady was false
							_flushQueue(tabData.id);
							break;
						}
						case 'sync_response': {
							// Response to our sync_request — apply authoritative server state.
							// Fired on reconnect so we don't rely on stale local state.
							console.log(`[PAN #447] sync_response received — state=${msg.state} mode=${msg.mode} msgs=${msg.messages?.length ?? 0}`);
							if (msg.state) {
								tabData._sessionState = msg.state;
								const working = msg.state === 'working' || msg.state === 'interrupted';
								tabData.claudeReady = !working;
								if (activeTabId === tabData.id) claudeReady = !working;
								console.log(`[PAN #447] sync_response applied: claudeReady=${!working} (state=${msg.state})`);
							}
							if (msg.mode) tabData._sessionMode = msg.mode;
							if (Array.isArray(msg.messages) && msg.messages.length > 0) {
								setPushed(tabData.id, msg.messages);
								tabData._sessionLost = false; // real messages arrived — session is live
								renderTranscriptToTerminal(tabData);
							} else if (msg.messages !== undefined && msg.messages.length === 0) {
								// Server has 0 messages but client has a cached conversation — PAN
								// crashed hard (no graceful server_restart signal) and restarted fresh.
								// The session lost its adapter. Set a flag so renderTranscriptToTerminal
								// appends a persistent recovery banner (direct innerHTML += gets wiped
								// by the next full re-render, so the flag survives it).
								const cachedMsgs = getPushed(tabData.id).filter(m => m.role !== 'system');
								if (cachedMsgs.length > 0 && !tabData._sessionLost) {
									tabData._sessionLost = true;
									tabData._sessionLostAt = new Date().toISOString();
									tabData._preservedHistory = cachedMsgs;
									renderTranscriptToTerminal(tabData);
									// Ensure input is enabled so user can send
									if (activeTabId === tabData.id) claudeReady = true;
									tabData.claudeReady = true;
								}
							}
							break;
						}
						case 'service_status': {
							// Service state machine update (Part 4 refactor).
							// Update servicesData in-place — no full refetch needed.
							if (msg.service_id && servicesData?.length) {
								servicesData = servicesData.map(s =>
									s.id === msg.service_id
										? { ...s, status: msg.state, lastError: msg.last_error ?? s.lastError }
										: s
								);
							}
							break;
						}
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

					// Phase 3: Include reconnect token if available
					const savedToken = tabData.reconnectToken || sessionStorage.getItem('pan_reconnect_token:' + sessionId);
					const tokenParam = savedToken ? '&token=' + encodeURIComponent(savedToken) : '';
					const newWs = new WebSocket(wsUrlStr + tokenParam);
					newWs.onopen = () => {
						const wasServerRestart = serverRestarting;
						reconnectAttempts = 0;
						serverRestarting = false;
						tabData.ws = newWs;
						prevLines = [];
						// Refresh all panels immediately on reconnect (after swap or restart)
						if (leftSection === 'intuition' || rightSection === 'intuition') {
							if (typeof window !== 'undefined') {
								window.dispatchEvent(new CustomEvent('pan:intuition-update'));
							}
						}
						api('/dashboard/api/services').then(r => { servicesData = r?.services || []; }).catch(() => {});
						// Clear the global "PAN restarting…" banner now that we're reconnected.
						if (typeof window !== 'undefined' && window._panCarrierRestartBanner) {
							document.querySelectorAll('div').forEach(d => { if (d.textContent && d.textContent.startsWith('⟳ PAN restarting')) d.remove(); });
							window._panCarrierRestartBanner = false;
						}
						// Reset PTY death state so the exit banner doesn't persist
						tabData.ptyDead = false;
						tabData.ptyExitCode = null;
						tabData.ptyUptimeSec = 0;
						tabData._lastRenderedHtml = '';
						// Reset Claude status immediately — don't inherit stale "Ready"
						// from the pre-restart session. Poll will correct once Claude
						// actually starts and ❯ prompt appears.
						tabData.claudeReady = false;
						tabData.claudeRunning = false;
						if (activeTabId === tabData.id) claudeReady = false;

						if (wasServerRestart) {
							// Add a prominent restart separator — keep all scrollback above
							scrollbackDiv.innerHTML += `<div style="margin:16px 0;padding:10px 16px;background:#1a3a2a;border:1px solid #a6e3a1;border-left:3px solid #a6e3a1;color:#a6e3a1;font-weight:600;text-align:center">` +
								`PAN Restarted — New Session` +
								`<div style="font-size:0.8em;font-weight:400;opacity:0.7;margin-top:4px">${new Date().toLocaleTimeString()}</div></div>` +
								`<hr style="border:none;border-top:1px solid #45475a;margin:8px 0">`;
						} else {
							scrollbackDiv.innerHTML += '\n<span style="color:#a6e3a1">[Reconnected]</span>';
						}
						startPing();

						// Ask server for current state snapshot (Part 5 refactor).
						// 'session' kind returns authoritative state/mode/messages so we don't
						// inherit stale claudeReady=false from pre-reconnect local state.
						try {
							newWs.send(JSON.stringify({ type: 'sync_request', kinds: ['services', 'tasks', 'session'] }));
						} catch {}

						// Only relaunch Claude on reconnect if the SERVER actually restarted
						// (which means a fresh PTY). For network-blip reconnects, the existing
						// PTY is still alive and Claude is still running — re-running the
						// trigger would type the printf on top of an active Claude session.
						if (wasServerRestart && projectName && projectName !== 'Shell') {
							const launchKey = 'pan_claude_launched:' + sessionId;
							sessionStorage.removeItem(launchKey); // server restart = invalidate guard
							tabData.claudeStarted = false;
							tabData._claudeLoading = true;
							renderTranscriptToTerminal(tabData);
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
								// Pipe mode: auto-launch Claude on reconnect
								try {
									const pipeData = await api('/api/v1/terminal/pipe', {
										method: 'POST',
										body: JSON.stringify({ session_id: sessionId, text: 'Π Remembers: summarize recent session context briefly.' }),
									});
									if (pipeData.ok) console.log('[PAN Terminal] Claude auto-launched on reconnect');
								} catch (e) {
									console.warn('[PAN Terminal] Pipe reconnect launch error:', e);
								}
								tabData._claudeLoading = false;
								renderTranscriptToTerminal(tabData);
							}, 2000);
						} else if (projectName && projectName !== 'Shell') {
							// FALLBACK: server_restarting message may have been lost (race
							// with socket close). Poll PTY status after 5s — if we have a
							// fresh PTY (uptime <10s) with no Claude running, launch it.
							setTimeout(async () => {
								const launchKey = 'pan_claude_launched:' + sessionId;
								if (newWs.readyState !== 1 || tabData.claudeStarted || sessionStorage.getItem(launchKey)) return;
								try {
									const r = await api('/api/v1/terminal/sessions');
									const list = r?.sessions || [];
									const match = list.find(s => s.id === sessionId);
									if (match && !match.claudeRunning && match.createdAt && (Date.now() - match.createdAt < 15000)) {
										console.log('[PAN] Fallback Claude launch: fresh PTY detected without Claude');
										sessionStorage.removeItem(launchKey);
										tabData.claudeStarted = true;
										tabData._claudeLoading = true;
										sessionStorage.setItem(launchKey, '1');
										try {
											await api('/api/v1/inject-context', {
												method: 'POST',
												headers: { 'Content-Type': 'application/json' },
												body: JSON.stringify({ cwd })
											});
											await new Promise(r => setTimeout(r, 300));
										} catch {}
										// Pipe mode: fallback auto-launch
										try {
											const pipeRes = await fetch('/api/v1/terminal/pipe', {
												method: 'POST',
												headers: { 'Content-Type': 'application/json' },
												body: JSON.stringify({ session_id: sessionId, text: 'Π Remembers: summarize recent session context briefly.' }),
											});
											const pipeData = await pipeRes.json();
											if (pipeData.ok) console.log('[PAN Terminal] Claude fallback auto-launched');
										} catch (e) {
											console.warn('[PAN Terminal] Pipe fallback launch error:', e);
										}
										tabData._claudeLoading = false;
										renderTranscriptToTerminal(tabData);
									}
								} catch {}
							}, 5000);
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
				_markLoad('wsOpen');
				startPing();

				// Explicitly request session state on connect — belt-and-suspenders with server's
				// automatic push (lines 1217-1222 in terminal.js). Ensures claudeReady is correctly
				// initialized even if the server's proactive push races with the WS handshake.
				try {
					ws.send(JSON.stringify({ type: 'sync_request', kinds: ['session'] }));
				} catch {}

				// Safety fallback: if claudeReady is still false 5s after connect and the server
				// hasn't said the session is actively working, force it to true. This handles
				// edge cases where the state message is dropped or arrives before the handler
				// is fully wired (e.g. after Tauri shell rebuild with fresh WebView2).
				setTimeout(() => {
					if (!tabData._wsOpen) return; // tab was closed
					const sessionState = tabData._sessionState;
					const isWorking = sessionState === 'working' || sessionState === 'interrupted';
					if (activeTabId === tabData.id && !claudeReady && !isWorking) {
						console.warn('[PAN] claudeReady safety timer fired — forcing ready (tab=%s sessionState=%s)', tabData.id, sessionState || 'unknown');
						tabData.claudeReady = true;
						claudeReady = true;
					} else if (tabData.claudeReady === false && !isWorking) {
						tabData.claudeReady = true; // fix non-active tabs too for when user switches
					}
				}, 5000);
				tabData._wsOpen = true;

				// Re-apply per-tab model override after reconnect. Server-side session may
				// have been recreated (Carrier restart) and lost the in-memory model field —
				// re-issue set-model so the SDK adapter gets the right model on next send.
				if (tabData.model) {
					api('/api/v1/terminal/set-model', {
						method: 'POST',
						body: JSON.stringify({ session_id: sessionId, model: tabData.model }),
					}).catch(() => {});
				}

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

						// Wait briefly for PTY to settle, then check if there are already
						// transcript messages — if so, Claude was mid-session and we skip
						// the greeting (but we still mark launched so it doesn't retry).
						// Previously this checked for '❯' prompt which fired on EVERY fresh
						// session before Claude had a chance to respond, eating the greeting.
						await new Promise(r => setTimeout(r, 500));
						const existingMsgs = getPushed(tabData.id).filter(m => m.role !== 'system');
						if (existingMsgs.length > 0) {
							tabData.claudeStarted = true;
							sessionStorage.setItem(launchKey, '1');
							return;
						}

						tabData.claudeStarted = true;
						tabData._claudeLoading = true;
						renderTranscriptToTerminal(tabData);
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

						// Pipe mode: auto-launch Claude via HTTP pipe endpoint.
						// SKIP if we have saved claudeSessionIds — the adapter will
						// resume from the latest one and the user's next real message
						// should be the first thing it sees, not our greeting.
						const hasResumeId = (tabData.claudeSessionIds || []).length > 0;
						if (hasResumeId) {
							console.log(`[PAN Terminal] Skipping auto-launch — will resume claude session ${tabData.claudeSessionIds[tabData.claudeSessionIds.length - 1]} on first user message`);
						} else {
							try {
								const launchText = briefingReady
									? 'Π Remembers: summarize recent session context briefly.'
									: 'Hello — new session starting.';
								const pipeData = await api('/api/v1/terminal/pipe', {
									method: 'POST',
									body: JSON.stringify({ session_id: sessionId, text: launchText }),
								});
								if (pipeData.ok) {
									console.log('[PAN Terminal] Claude auto-launched via pipe mode');
								} else {
									console.warn('[PAN Terminal] Pipe auto-launch failed:', pipeData.error);
								}
							} catch (pipeErr) {
								console.warn('[PAN Terminal] Pipe auto-launch error:', pipeErr);
							}
						}
						tabData._claudeLoading = false;
						renderTranscriptToTerminal(tabData);
					}, 1500);
				}
			};

			ws.onmessage = handleMessage;

			ws.onclose = () => {
				tabData._wsOpen = false;
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

		// Save current tab's input draft and images before switching
		const prevTab = getActiveTab();
		if (prevTab) {
			prevTab.draft = terminalInputText || '';
			prevTab.pastedImages = pastedImages || [];
			try { sessionStorage.setItem('pan_tab_draft:' + prevTab.sessionId, prevTab.draft); } catch {}
		}

		tabs.forEach(t => {
			if (t.container) t.container.style.display = t.id === tabId ? 'block' : 'none';
		});

		activeTabId = tabId;
		// Restore new tab's input draft and images
		terminalInputText = tab.draft || '';
		setTerminalInput(terminalInputText);
		pastedImages = tab.pastedImages || [];
		hostLabel = tab.host ? `${tab.host} \u2014 ${tab.project || 'shell'}` : '';
		// Sync thinking indicator to the tab we just switched to. Without this,
		// a top-level `claudeReady=false` from a prior send on a different tab
		// would leak across tabs and pin "Claude is thinking…" forever.
		claudeReady = tab.claudeReady !== false;

		// Scroll to bottom on tab switch (respect saved scroll state)
		setTimeout(() => {
			if (tab.container) {
				const savedPos = sessionStorage.getItem('pan_scroll_pos:' + tab.sessionId);
				if (tab.userScrolledUp && savedPos != null) {
					tab.container.scrollTop = parseFloat(savedPos);
				} else if (!tab.userScrolledUp) {
					tab.container.scrollTop = tab.container.scrollHeight;
				}
			}
		}, 50);
		// Reload sidebar — including transcript for the new active tab
		loadTerminalSidebar(tab.projectId, tab.project);
		if (leftSection === 'transcript') loadChatHistory();
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
		// Remove scroll listener before DOM removal to release the tabData closure for GC
		if (tab._scrollHandler && tab.container) {
			tab.container.removeEventListener('scroll', tab._scrollHandler);
			tab._scrollHandler = null;
		}
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
			chatRefreshInterval = setInterval(loadChatHistory, 5000);
		} else {
			if (chatRefreshInterval) { clearInterval(chatRefreshInterval); chatRefreshInterval = null; }
		}
		if (tab === 'devices') { loadClientDevices(); loadAllDevices(); }
		if (tab === 'intuition') { /* IntuitionPanel auto-loads voice speakers on mount */ }
	}

	function handleTranscriptScroll() {
		if (!chatSidebarEl) return;
		const atBottom = chatSidebarEl.scrollHeight - chatSidebarEl.scrollTop - chatSidebarEl.clientHeight < 30;
		try {
			sessionStorage.setItem('pan_transcript_scrolled_up', atBottom ? '0' : '1');
			if (!atBottom) sessionStorage.setItem('pan_transcript_scroll_pos', String(chatSidebarEl.scrollTop));
		} catch {}
	}

	function escapeHtml(str) {
		if (!str) return '';
		return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
	}


	// Seed default username/LLM name + terminal colors on first run.
	// All are overridable from Settings → Terminal. Names are first-cap.
	if (typeof localStorage !== 'undefined') {
		if (!localStorage.getItem('pan_username')) localStorage.setItem('pan_username', 'User');
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
			// Merge JSONL transcript messages with any pending echo messages
			const pushed = getPushed(tabData.id);
			const echoes = getEchoes(tabData.id);
			const btws = getBtws(tabData.id);
			const allMessages = [...pushed, ...echoes, ...btws].sort((a, b) => (a.ts || '').localeCompare(b.ts || ''));
			console.log('[PAN DIAG] RENDER ← tab.sessionId =', tabData.sessionId, '| messages =', allMessages.length, '| echoes =', echoes.length);
			// Don't short-circuit when there are no messages — the loading indicator
			// and PTY exit banner still need to render even on a brand-new empty tab.
			if (allMessages.length === 0 && !tabData._claudeLoading && !tabData.ptyDead) return;

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

			// Filter applied to msg.text when the message came from the PTY
			// transcript (type === 'input' / 'output'). Claude's JSONL path
			// (type === 'prompt' / 'text' / 'tool') is already clean and does
			// not need this. Single source of truth for "what TUI garbage
			// should never reach the rendered transcript/terminal."
			function isNoisyTerminalLine(line) {
				const t = line.trim();
				if (!t) return true;
				// TUI noise chars (spinners, box drawing, block chars)
				const TUI = /[✻✶✽✢●·▐▛▜▘▝█▀▄░▒▓─│┌┐└┘├┤┬┴┼═║╔╗╚╝╠╣╦╩╬…]/g;
				const meaningful = t.replace(TUI, '').replace(/\s+/g, '').trim();
				if (meaningful.length < 2) return true;
				// Repeated capitalized spinner words ("Cooking…", "CookingSmooshing", etc.)
				if (/^[A-Z][a-z]+[.\s…]*([A-Z][a-z]+[.\s…]*)*$/m.test(meaningful) && meaningful.length < 80) return true;
				// Spinner status with stats parenthetical: "Cooking… (5s · ↑ 25 tokens)"
				if (/^[A-Z][a-z]+[….]*\s*\(.*(tokens|interrupt|esc).*\)\s*$/i.test(t)) return true;
				// {thinking} / (thinking) tags, solo or repeated
				if (/^(?:[\{\(]?thinking[\}\)]?)+$/i.test(meaningful)) return true;
				{
					const noThink = meaningful.replace(/[\{\(]?thinking[\}\)]?/gi, '');
					if (/thinking/i.test(meaningful) && noThink.replace(/[^a-z0-9]/gi, '').length === 0) return true;
				}
				// Claude Code prompt marker
				if (/^❯/.test(t)) return true;
				// Horizontal rule / box drawing only
				if (/^[─═┄┈╌]+$/.test(t)) return true;
				// Claude Code banner rows (▐▛███▜▌ etc.)
				if (/^[▐▛▜▘▝█\s]*$/.test(t)) return true;
				if (/ClaudeCode\s*v[\d.]+/i.test(meaningful)) return true;
				if (/Opus.*context.*ClaudeMax/i.test(meaningful)) return true;
				// Status bar lines
				if (/^\??\s*for\s*shortcuts/i.test(meaningful)) return true;
				if (/^esc\s*to\s*interrupt/i.test(meaningful)) return true;
				if (/session\s*limit.*resets/i.test(meaningful)) return true;
				if (/Found\s*\d+\s*keybinding\s*error/i.test(meaningful)) return true;
				if (/\/doctor\s*for\s*details/i.test(meaningful)) return true;
				if (/\/upgrade\s*to\s*keep/i.test(meaningful)) return true;
				if (/running\s*stop\s*hook/i.test(meaningful)) return true;
				// Bash / MINGW prompt
				if (/^[a-z][\w-]*@\S+\s+MINGW\d+.*\$?\s*$/.test(t)) return true;
				// CLI launch echo
				if (/^claude\s+(--|\S)/.test(t)) return true;
				return false;
			}
			function cleanPtyOutput(text) {
				if (!text) return '';
				// Carriage-return semantics: anything before \r on the same line
				// is overwritten. Do this BEFORE splitting on \n so we don't
				// fragment spinner frames into many lines.
				const collapsed = text
					.replace(/\r\n/g, '\n')
					.replace(/[^\n]*\r(?=[^\n])/g, '')
					.replace(/\r/g, '');
				const lines = collapsed.split('\n').filter(l => !isNoisyTerminalLine(l));
				return lines.join('\n').trim();
			}

			function buildLineHtml(msg) {
				if (msg.role === 'user' && (msg.type === 'prompt' || msg.type === 'input')) {
					let raw = (msg.text || '').trim();
					// PTY-sourced input may carry leftover TUI noise; the JSONL
					// `prompt` path is already clean.
					if (msg.type === 'input') {
						raw = cleanPtyOutput(raw);
						if (!raw) return null;
					}
					// Strip Claude Code's "[Pasted text #N +M lines]" prefix that gets
					// added to long multi-line pasted prompts. The actual user text
					// follows immediately after the placeholder in the same string.
					raw = raw.replace(/^\[Pasted text #\d+ \+\d+ lines\]/, '').trimStart();
					// Skip short auto-generated Π remembers trigger prompts (not real user messages)
					if (/^\u03A0\u0391\u039D remembers/i.test(raw) && raw.length < 120) return null;
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
				} else if (msg.role === 'assistant' && (msg.type === 'text' || msg.type === 'output')) {
					let assistantText = msg.text || '';
					// PTY-sourced assistant output carries Claude Code TUI noise
					// (spinners, {thinking}, banner, status bar). The JSONL `text`
					// path is already clean.
					if (msg.type === 'output') {
						assistantText = cleanPtyOutput(assistantText);
					}
					if (!assistantText.trim()) return null;
					return (
						`<div class="t-line t-assistant">` +
						`<span style="color:${llmColor};font-weight:bold;">${escapeHtml(llmName)}</span>` +
						`<span style="color:#89b4fa;">$ </span>` +
						`<span style="color:${llmTextColor};">${renderMarkdown(assistantText)}</span>` +
						`</div>`
					);
				} else if (msg.role === 'assistant' && msg.type === 'tool') {
					return (
						`<div class="t-line t-tool">` +
						`<span style="color:#6c7086;">\u2192 </span>` +
						`<span style="color:${toolColor};">${escapeHtml(msg.text || '')}</span>` +
						`</div>`
					);
				} else if (msg.role === 'user' && msg.type === 'btw') {
					return (
						`<div class="t-line" style="margin-left:20px;border-left:2px solid #89b4fa44;padding-left:8px;margin-top:2px;margin-bottom:2px;">` +
						`<span style="font-size:0.8em;color:#89b4fa;opacity:0.7;">btw → </span>` +
						`<span style="color:#89b4fa;">${escapeHtml(msg.text || '')}</span>` +
						`</div>`
					);
				} else if (msg.role === 'agent' && msg.type === 'agent_result') {
					// Sub-agent response — visually distinct from the leader's messages.
					// Indented, purple ₡ prefix, muted label showing what the agent was.
					const label = msg.agentDescription ? escapeHtml(msg.agentDescription.substring(0, 50)) : 'subagent';
					// Truncate very long agent responses — show first 400 chars
					const full = msg.text || '';
					const truncated = full.length > 400 ? full.substring(0, 400) + '…' : full;
					return (
						`<div class="t-line t-agent-result" style="margin-left:20px;border-left:2px solid #45475a;padding-left:8px;">` +
						`<div style="font-size:0.8em;color:#6c7086;margin-bottom:2px;">₡ ${label}</div>` +
						`<span style="color:#cba6f7;">${renderMarkdown(truncated)}</span>` +
						`</div>`
					);
				} else if (msg.role === 'system' && msg.type === 'turn_stats') {
					// Per-turn token usage bar — compact, right-aligned
					const t = msg.tokens || {};
					const inK = t.input ? (t.input / 1000).toFixed(1) : '0';
					const outK = t.output ? (t.output / 1000).toFixed(1) : '0';
					const cacheK = t.cache_read ? (t.cache_read / 1000).toFixed(1) : null;
					const cost = t.cost != null ? `$${t.cost.toFixed(4)}` : '';
					const totInK = t.total_input ? (t.total_input / 1000).toFixed(1) : '0';
					const totOutK = t.total_output ? (t.total_output / 1000).toFixed(1) : '0';
					const totCost = t.total_cost != null ? `$${t.total_cost.toFixed(4)}` : '';
					return (
						`<div style="margin:2px 0;padding:3px 10px;font-size:0.78em;color:#6c7086;display:flex;justify-content:space-between;border-top:1px solid #1e1e2e;">` +
						`<span>↑${inK}K ↓${outK}K` + (cacheK ? ` 📦${cacheK}K` : '') + ` ${cost}</span>` +
						`<span style="opacity:0.6">session: ↑${totInK}K ↓${totOutK}K ${totCost}</span>` +
						`</div>`
					);
				} else if (msg.role === 'system' && msg.type === 'session_reset_marker') {
					return (
						`<div style="margin:16px 0;display:flex;align-items:center;gap:8px;color:#585b70;font-size:0.78em;padding:0 4px;">` +
						`<div style="flex:1;height:1px;background:#313244;"></div>` +
						`<span style="white-space:nowrap;padding:0 6px;">↻ Session reset — Claude started fresh here</span>` +
						`<div style="flex:1;height:1px;background:#313244;"></div>` +
						`</div>`
					);
				} else if (msg.role === 'system') {
					const isError = msg.type === 'pty_exit' || msg.type === 'banner' || msg.type === 'interrupt';
					const isRestart = msg.type === 'server_restart';
					const bg = isRestart ? '#1a2332' : '#3c1f24';
					const border = isRestart ? '#89b4fa' : '#f38ba8';
					const color = isRestart ? '#89b4fa' : '#f38ba8';
					const icon = isRestart ? '↻' : '⚠';
					const ts = msg.ts ? new Date(msg.ts).toLocaleTimeString() : '';
					return (
						`<div style="margin:8px 0;padding:8px 12px;background:${bg};border-left:3px solid ${border};color:${color};font-weight:600">` +
						`${icon} ${escapeHtml(msg.text || '')}` +
						(ts ? `<span style="float:right;font-weight:400;opacity:0.6;font-size:0.85em">${ts}</span>` : '') +
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
				// Tool messages carry a per-session _seq counter (set by appendMessage
				// in terminal.js) so each invocation — even same file read N times —
				// produces a unique sig. Non-tool messages keep role|type|text so the
				// echo/JSONL dedup pair still collapses correctly.
				const sig = (m.role || '') + '|' + (m.type || '') + '|' + normalize(cleanText)
					+ (m._seq != null ? '|' + m._seq : '');
				if (sig.length > 10 && seenSig.has(sig)) continue;
				seenSig.add(sig);

				const lineHtml = buildLineHtml(m);
				if (!lineHtml) continue;

				let kind = null;
				if (m.role === 'user' && (m.type === 'prompt' || m.type === 'input')) kind = 'user';
				else if (m.role === 'user' && m.type === 'btw') kind = 'btw';
				else if (m.role === 'assistant' && (m.type === 'text' || m.type === 'output')) kind = 'assistant';
				else if (m.role === 'assistant' && m.type === 'tool') kind = 'tool';
				else if (m.role === 'agent' && m.type === 'agent_result') kind = 'agent';
				else if (m.role === 'system') kind = 'system';
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
					const m = shortModel(turn.items.find(i => i.model)?.model);
					if (m) { modelLabel = m; lastShownModel = m; }
				}
				else if (turn.kind === 'btw') { headLabel = ''; cls = 'turn turn-btw'; }
				else if (turn.kind === 'agent') { headLabel = ''; cls = 'turn turn-agent'; }
				else if (turn.kind === 'system') { headLabel = ''; cls = 'turn turn-system'; }
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
			// Loading indicator — shows while Claude is starting up after restart
			if (tabData._claudeLoading) {
				parts.push(
					`<div style="margin:8px 0;padding:8px 12px;background:#1a2332;border-left:3px solid #89b4fa;color:#89b4fa;font-weight:600">` +
					`↻ Claude is loading... transcript will update when ready</div>`
				);
			}
			// Session-lost banner — shown when PAN crashed (no graceful restart signal)
			// and the server restarted with an empty session while the client has a
			// cached conversation. Stays visible until a new message arrives from the server.
			if (tabData._sessionLost) {
				parts.push(
					`<div style="margin:16px 0;padding:12px 16px;background:#2a1a1a;border:1px solid #f38ba8;border-left:4px solid #f38ba8;color:#f38ba8;font-weight:600;text-align:center">` +
					`⚠ PAN restarted — session was reset` +
					`<div style="font-size:0.82em;font-weight:400;color:#cdd6f4;margin-top:5px">` +
					`Conversation above is cached locally. Send a message to resume with Claude.` +
					`</div></div>`
				);
			}
			// Append PTY exit banner if the PTY died — rendered here so it
			// survives the full innerHTML replacement instead of being wiped.
			if (tabData.ptyDead) {
				const code = tabData.ptyExitCode ?? '?';
				const up = tabData.ptyUptimeSec ?? 0;
				parts.push(
					`<div style="margin:8px 0;padding:8px 12px;background:#3c1f24;border-left:3px solid #f38ba8;color:#f38ba8;font-weight:600">` +
					`⚠ Claude PTY exited (code ${code}, uptime ${up}s)</div>`
				);
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
	let chatLoadDirty = false; // true if an update arrived while load was in progress
	let chatLoadDebounceTimer = null;

	// ─── ARCHITECTURAL FIX FOR NIGHTMARE BUG #444 (2026-05-26) ───────────────
	// SINGLE SOURCE OF TRUTH for all per-tab message storage.
	//
	// Storage is ONE Map keyed by tabId, exposed through helper functions
	// imported from $lib/stores-terminal.svelte.js. The tab object NEVER
	// holds messages directly. This eliminates the Svelte-proxy-vs-raw-object
	// split that caused #444.
	//
	// If you find yourself writing `tabData._pushedMessages = X` or
	// `tabData._echoMessages.push(X)` — STOP. Use setPushed / pushEcho instead.
	// See docs/NIGHTMARE_BUGS.md #444 for the full story.
	//
	// 2026-05-27: lifted out of +page.svelte into the module-level store as
	// part of the Shape-2 component refactor. Extracted components on the
	// terminal page (IntuitionPanel, TerminalPanel, TranscriptPanel, …) all
	// hit the same backing Map by importing these helpers — no duplication,
	// no drift. See docs/DASHBOARD-REFACTOR-MAP.md.
	// ─────────────────────────────────────────────────────────────────────────

	// Synchronous bubble builder — used by both the real-time WS path and loadChatHistory.
	// Keeps both paths in sync without any async/lock/proxy indirection.
	function bubblesFromMessages(messages) {
		if (!messages || messages.length === 0) return null; // null = don't clear existing
		const firstCap = s => s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
		const username = firstCap((localStorage.getItem('pan_username') || 'User').replace(/[^a-zA-Z0-9_-]/g, ''));
		const llmName = firstCap((localStorage.getItem('pan_llm_name') || 'Claude').replace(/[^a-zA-Z0-9_-]/g, ''));
		const shortModel = (id) => { if (!id) return ''; return String(id).replace(/^claude-/i, '').replace(/-\d{8}$/, ''); };
		const bubbles = [];
		for (const msg of messages) {
			if (msg.role === 'user') {
				if (msg.text && /^\u03A0\u0391\u039D remembers/i.test(msg.text.trim()) && msg.text.trim().length < 120) continue;
				bubbles.push({ type: 'user', text: msg.text || '', speaker: username });
			} else if (msg.type === 'text' || msg.type === 'output') {
				const m = shortModel(msg.model);
				bubbles.push({ type: 'assistant', text: msg.text || '', speaker: llmName, model: m });
			} else if (msg.type === 'tool') {
				bubbles.push({ type: 'tool', text: msg.text || '' });
			} else if (msg.type === 'turn_stats' && msg.tokens) {
				bubbles.push({ type: 'stats', tokens: msg.tokens });
			}
		}
		return bubbles;
	}

	function debouncedLoadChatHistory(delayMs = 300) {
		if (chatLoadDebounceTimer) clearTimeout(chatLoadDebounceTimer);
		chatLoadDebounceTimer = setTimeout(() => {
			chatLoadDebounceTimer = null;
			loadChatHistory();
		}, delayMs);
	}

	// tabOverride: pass the tabData closure object directly from WS handlers to avoid
	// any Svelte proxy indirection between the plain object and getActiveTab()'s proxy.
	// Also ensures we're reading from the exact object that was just mutated.
	async function loadChatHistory(tabOverride) {
		if (chatLoadInProgress) { chatLoadDirty = true; return; } // queue re-run
		chatLoadInProgress = true;
		chatLoadDirty = false;
		// If tabOverride is provided AND it's not the active tab, skip (stale tab update)
		if (tabOverride && tabOverride.id !== activeTabId) {
			chatLoadInProgress = false;
			return;
		}
		const active = tabOverride || getActiveTab();
		if (!active) {
			if (chatServerLoaded) chatBubbles = [];
			chatLoadInProgress = false;
			return;
		}

		try {
			// Single source of truth: _messageStore via helpers. No proxy, no cache
			// drift, no stale HTTP override. Falls through to HTTP only if the store
			// is empty for this tab (fresh page load before first WS push).
			const pushed = getPushed(active?.id);
			const echoes = getEchoes(active?.id);
			let allMessages;
			if (pushed.length > 0) {
				allMessages = echoes.length
					? [...pushed, ...echoes].sort((a, b) => (a.ts || '').localeCompare(b.ts || ''))
					: [...pushed];
			} else {
				// Fallback: fetch from HTTP API when no pushed messages available
				const sessionId = active.sessionId || '';
				const isDashboardSession = /^(dash|mob)-/.test(sessionId);
				const realSessionId = isDashboardSession ? '' : sessionId;
				const chatKey = realSessionId || active.cwd || '';

				if (chatCurrentProject !== chatKey) {
					chatCurrentProject = chatKey;
				}

				let sessionIds = [];
				if (active.claudeSessionIds && active.claudeSessionIds.length > 0) {
					sessionIds = [...active.claudeSessionIds];
				} else if (realSessionId) {
					sessionIds = [realSessionId];
				}
				// REMOVED 2026-05-30 — events-table fallback (auto-discover Claude sessions
				// by substring-matching project_path on data column). Two bugs lived here:
				//
				//   1. data LIKE '%<path>%' is a leading-wildcard scan over the entire
				//      1.6 GB events table — sync better-sqlite3, ~8 s every fire. The
				//      chat-refresh interval polls loadChatHistory every 5 s, so the
				//      dashboard pinned Craft's loop ~50 % of the time and produced the
				//      "8-second loop-block every 15 s" pattern observed in carrier logs.
				//
				//   2. The substring filter matches ANY event whose data field happens to
				//      contain the project name (paths in tool output, mentions in chat,
				//      cwd of sibling projects). That's how WoE Game Design transcripts
				//      ended up showing in the PAN tab — a session_id picked up here
				//      gets fanned out to /api/transcript and the JSONL it points at is
				//      from a different project entirely. See TRANSCRIPT_SYSTEM.md.
				//
				// Correct behavior is to show empty when there's no live Claude session
				// for the tab — the next chat_update WS event populates claudeSessionIds
				// and a real transcript loads. Old/closed sessions need explicit
				// reattach, not lossy auto-discovery.

				if (sessionIds.length === 0) {
					// Don't clear existing chatBubbles — keep showing last known state.
					// Empty sessions just means the Claude session hasn't started yet,
					// not that there's nothing to show. Clearing causes a blank flash.
					chatLoadInProgress = false;
					if (chatLoadDirty) setTimeout(loadChatHistory, 100);
					return;
				}

				allMessages = [];
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
			}

			if (allMessages.length === 0) {
				// Don't clear existing data — keep showing last known state.
				// An empty result here likely means a transient/empty push,
				// not an actual "no conversation" state.
				return;
			}

			const sessionColors = ['var(--accent)', '#a6e3a1', '#f9e2af', '#f38ba8', '#cba6f7'];
			const seenSessionIdxs = new Set(allMessages.map(m => m._sessionIdx || 0));
			const multiSession = seenSessionIdxs.size > 1;
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
					if (msg.text && /^\u03A0\u0391\u039D remembers/i.test(msg.text.trim()) && msg.text.trim().length < 120) continue;
					newBubbles.push({
						type: 'user',
						text: msg.text || '',
						accentColor,
						multiSession,
						speaker: _username,
					});
				} else if (msg.type === 'text' || msg.type === 'output') {
					const modelShort = _shortModel(msg.model);
					const modelTag = modelShort || '';
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
				} else if (msg.type === 'turn_stats' && msg.tokens) {
					newBubbles.push({
						type: 'stats',
						tokens: msg.tokens,
					});
				}
			}

			// Smart scroll — only auto-scroll if user is already at the bottom.
			// On first load after refresh, check sessionStorage for saved position.
			let wasAtBottom = chatSidebarEl ? (chatSidebarEl.scrollHeight - chatSidebarEl.scrollTop - chatSidebarEl.clientHeight < 30) : true;
			let savedPos = chatSidebarEl?.scrollTop || 0;
			const isFirstLoad = !chatServerLoaded;
			if (isFirstLoad) {
				try {
					const storedUp = sessionStorage.getItem('pan_transcript_scrolled_up');
					const storedPos = sessionStorage.getItem('pan_transcript_scroll_pos');
					if (storedUp === '1' && storedPos != null) {
						wasAtBottom = false;
						savedPos = parseFloat(storedPos);
					}
				} catch {}
			}

			chatBubbles = newBubbles;
			chatServerLoaded = true;
			if (newBubbles.length > 0) _markLoad('transcriptWidget');
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
			// If an update arrived while we were loading, run again
			if (chatLoadDirty) {
				chatLoadDirty = false;
				loadChatHistory();
			}
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
		if (!plainLines || plainLines.length === 0) return false; // empty screen = NOT ready
		// Look at the bottom 12 lines
		const start = Math.max(0, plainLines.length - 12);
		let sawClaudePrompt = false;
		let sawSpinner = false;
		let sawBashOnly = false;
		for (let i = start; i < plainLines.length; i++) {
			const line = plainLines[i];
			if (!line) continue;
			// Claude's input prompt uses the ❯ character (U+276F) specifically —
			// do NOT match generic ">" which is just a bash prompt. Claude is not running
			// if we only see bash's $ or > prompt.
			if (/\u276F/.test(line)) sawClaudePrompt = true;
			// Detect bare bash prompt (Claude not running)
			if (/^\s*(\$|bash-\d|>)\s*$/.test(line.trim())) sawBashOnly = true;
			// Spinner / status indicators while busy
			if (/(\u2728|esc to interrupt|tokens|↓|↑\s*\d|Thinking|Pondering|Cogitating|Ruminating|Considering|Reasoning)/i.test(line)) {
				sawSpinner = true;
			}
		}
		if (sawSpinner) return false;
		// Only ready if we see Claude's actual ❯ prompt, not a bash prompt
		return sawClaudePrompt;
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
		// Take the LONGEST value — Tauri/voice input can cause partial reads
		// where explicit (e.target.value) only has part of the text
		let text = explicit;
		if (domValue.length > text.length) text = domValue;
		if (stateValue.length > text.length) text = stateValue;
		// Send the actual absolute file path so Claude can use the Read tool to view the image.
		const imgPaths = pastedImages.filter(img => img.path).map(img => img.path);
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

		// Drop duplicate sends — guards against Enter+click race, rapid double-tap,
		// and spamming while Claude is still processing the previous message.
		if (_sendInFlight.has(active.sessionId)) {
			_logSendAttempt(active.sessionId, text, 'dropped-inflight');
			console.warn('[PAN Terminal] sendTerminalInput: already in-flight for session', active.sessionId, '— dropping duplicate');
			return;
		}
		if (!claudeReady) {
			_queueMessage(active.sessionId, text);
			return;
		}
		_logSendAttempt(active.sessionId, text, 'sending');

		// ── Slash command interception ──────────────────────────────────────────
		if (text.startsWith('/')) {
			const spaceIdx = text.indexOf(' ');
			const cmd = (spaceIdx === -1 ? text : text.slice(0, spaceIdx)).toLowerCase();
			const arg = spaceIdx === -1 ? '' : text.slice(spaceIdx + 1).trim();

			if (cmd === '/model') {
				// Switch model mid-session — no restart needed
				if (!arg) {
					// Show current model or available options hint
					if (active.scrollbackDiv) {
						active.scrollbackDiv.innerHTML += `<div style="margin:4px 0;padding:4px 10px;color:#6c7086;font-size:0.85em">Usage: /model &lt;name&gt; — e.g. /model haiku · /model sonnet · /model opus</div>`;
						active.scrollbackDiv.scrollTop = active.scrollbackDiv.scrollHeight;
					}
					terminalInputText = ''; setTerminalInput('');
					return;
				}
				try {
					const r = await api('/api/v1/terminal/set-model', {
						method: 'POST',
						body: JSON.stringify({ session_id: active.sessionId, model: arg }),
					});
					if (active.scrollbackDiv) {
						const ok = r?.ok;
						const msg = ok ? `⇄ Model switched to <strong>${escapeHtml(arg)}</strong>` : `⚠ Model switch failed`;
						const color = ok ? '#a6e3a1' : '#f38ba8';
						active.scrollbackDiv.innerHTML += `<div style="margin:4px 0;padding:4px 10px;color:${color};font-size:0.85em">${msg}</div>`;
						active.scrollbackDiv.scrollTop = active.scrollbackDiv.scrollHeight;
					}
				} catch { /* silent */ }
				terminalInputText = ''; setTerminalInput('');
				return;
			}

			if (cmd === '/btw') {
				// Send an aside to Claude even if it's currently working.
				// Stored in _btwMessages so it survives full re-renders.
				// Also appended directly to DOM for IMMEDIATE visual feedback —
				// no full re-render (which would read stale proxy._pushedMessages
				// and wipe all existing transcript content).
				if (!arg) { terminalInputText = ''; setTerminalInput(''); return; }
				pushBtw(active.id, { role: 'user', type: 'btw', text: arg, ts: new Date().toISOString() });
				if (active.scrollbackDiv) {
					active.scrollbackDiv.innerHTML +=
						`<div class="t-line" style="margin-left:20px;border-left:2px solid #89b4fa44;padding-left:8px;margin-top:2px;margin-bottom:2px;">` +
						`<span style="font-size:0.8em;color:#89b4fa;opacity:0.7;">btw \u2192 </span>` +
						`<span style="color:#89b4fa;">${escapeHtml(arg)}</span></div>`;
					active.scrollbackDiv.scrollTop = active.scrollbackDiv.scrollHeight;
				}
				// Send to Claude as-is (it'll see it inline in the conversation)
				await api('/api/v1/terminal/pipe', {
					method: 'POST',
					body: JSON.stringify({ session_id: active.sessionId, text: arg }),
				});
				terminalInputText = ''; setTerminalInput('');
				return;
			}

			// Unknown slash command — let it through to Claude (Claude Code handles /help etc.)
		}
		// ── End slash command interception ──────────────────────────────────────

		// PIPE MODE: send message via HTTP POST. Server spawns claude -p
		// as a child_process — clean JSON stream, no PTY, no TUI.
		console.log('[PAN DIAG] SEND → session_id =', active.sessionId, '| text =', JSON.stringify(text.substring(0, 60)));

		if (!text) return;
		_markSend(text);

		// Optimistic clear — wipe the input immediately so the user sees instant feedback.
		// If the HTTP send fails, we restore the text so they can retry.
		const savedText = text;
		const savedImages = [...pastedImages];
		terminalInputText = '';
		setTerminalInput('');
		if (active) {
			active.draft = '';
			active.pastedImages = [];
			try { sessionStorage.setItem('pan_tab_draft:' + active.sessionId, ''); } catch {}
		}
		pastedImages = [];
		if (terminalInputEl) terminalInputEl.style.height = 'auto';

		// Mark Claude as busy immediately (don't wait for server ACK).
		if (active) {
			active.claudeReady = false;
			active._htmlAtSend = active._lastRenderedHtml || '';
			active._stablePolls = 0;
		}
		claudeReady = false;
		_lastSendTime = Date.now(); // freeze PTY ready-detection for 2s to prevent duplicate-send race

		// Optimistic echo — user's message appears immediately in the scrollback
		// without waiting for the server's 100ms-delayed transcript_messages broadcast.
		// The transcript_messages handler removes this echo once the real JSONL entry arrives.
		// Always snap to bottom on send so the user sees the echo + incoming response.
		if (active) {
			active.userScrolledUp = false;
			if (active.container) active.container.scrollTop = active.container.scrollHeight;
			pushEcho(active.id, {
				role: 'user', type: 'prompt',
				text: savedText,
				ts: new Date().toISOString(),
				_echo: true,
			});
			renderTranscriptToTerminal(active);
		}

		setTimeout(() => {
			if (active && active.claudeReady === false) {
				active.claudeReady = true;
				active._htmlAtSend = null;
				if (activeTabId === active.id) claudeReady = true;
			}
		}, 60000);

		_sendInFlight.add(active.sessionId);
		pipeSending = true;
		const _pipeAbort = new AbortController();
		const _pipeTimeout = setTimeout(() => _pipeAbort.abort(), 30000);
		try {
			const data = await api('/api/v1/terminal/pipe', {
				method: 'POST',
				body: JSON.stringify({ session_id: active.sessionId, text }),
				signal: _pipeAbort.signal,
			});
			if (!data.ok) throw new Error(data.error || 'pipe send failed');
			_markSendPhase('ack');
			console.log('[PAN Terminal] Pipe send OK');
		} catch (err) {
			const timedOut = err?.name === 'AbortError';
			console.error('[PAN Terminal] pipe send failed' + (timedOut ? ' (timeout 8s)' : '') + ':', err);
			// Restore text so user can retry
			terminalInputText = savedText;
			setTerminalInput(savedText);
			pastedImages = savedImages;
			if (terminalInputEl) {
				terminalInputEl.style.outline = '2px solid #f38ba8';
				setTimeout(() => { if (terminalInputEl) terminalInputEl.style.outline = ''; }, 1500);
			}
			// Restore busy state
			if (active) { active.claudeReady = true; active._htmlAtSend = null; }
			claudeReady = true;
		} finally {
			clearTimeout(_pipeTimeout);
			_sendInFlight.delete(active.sessionId);
			pipeSending = false;
		}
	}

	function handleTerminalInputKey(e) {
		// Let Win+H pass through to Windows for voice typing
		if (e.key === 'h' && e.metaKey) return;

		const active = getActiveTab();
		const ws = active?.ws?.readyState === 1 ? active.ws : null;

		// Enter (no Shift) = send. Shift+Enter = newline (default textarea behavior).
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			// Always send on Enter — server/PTY queues if Claude is mid-response.
			// Keep only the in-flight HTTP guard so we don't double-fire the same POST.
			if (pipeSending) return;
			// Delay 50ms to let Svelte state and DOM value fully sync before reading
			const el = e.target;
			setTimeout(() => {
				const val = el?.value || terminalInputText || '';
				sendTerminalInput(val);
			}, 50);
			return;
		}
		// Escape → interrupt Claude (sends Ctrl+C + logs system message).
		// 2026-05-28: bug #430 fix — also locally reset the in-flight UI state.
		// Previously we only sent the interrupt over WS and waited for the
		// server to confirm via a state push, which sometimes never arrived
		// (PTY mid-stream, dropped frame, etc). The input stayed disabled with
		// "Claude is thinking…" until the user refreshed. Now Escape optimistically
		// flips us back to IDLE: claudeReady = true, pipeSending = false,
		// pendingSendCount = 0, _sendTimings.awaitingAssistant = false. If the
		// server actually keeps streaming, the next state push from the server
		// will reconcile correctly — but at minimum the user can type again.
		if (e.key === 'Escape') {
			e.preventDefault();
			e.stopPropagation();
			if (ws) {
				ws.send(JSON.stringify({ type: 'interrupt' }));
			} else {
				// WS not open — try interrupt via HTTP as fallback
				const sid = active?.sessionId;
				if (sid) api('/api/v1/terminal/interrupt', { method: 'POST', body: JSON.stringify({ session_id: sid }) }).catch(() => {});
			}
			// Optimistic local reset so the user isn't stuck even if the server
			// state push never lands.
			claudeReady = true;
			pipeSending = false;
			pendingSendCount = 0;
			if (_sendTimings) _sendTimings.awaitingAssistant = false;
			return;
		}
		// Number keys 1-3 when input is empty AND there's a pending approval prompt
		// The prompt is a TUI select list: arrow-down to move, Enter to confirm
		if (/^[1-3]$/.test(e.key) && (e.target.value.length === 0 || !e.target.value.trim()) && approvalsCount > 0) {
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
		const imgPaths = pastedImages.filter(img => img.path).map(img => img.path);
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
		// Escape → interrupt Claude from center chat too.
		// 2026-05-28: bug #430 fix — same optimistic local IDLE reset as the
		// main terminal input handler. See L3482 comment for the full reasoning.
		if (e.key === 'Escape') {
			e.preventDefault();
			const active = getActiveTab();
			if (active?.ws?.readyState === 1) {
				active.ws.send(JSON.stringify({ type: 'interrupt' }));
			}
			centerChatLoading = false;
			claudeReady = true;
			pipeSending = false;
			pendingSendCount = 0;
			if (_sendTimings) _sendTimings.awaitingAssistant = false;
			return;
		}
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
		// Resize-only. Do NOT write terminalInputText = el.value here — bind:value
		// already syncs DOM → state on 'input' events, and writing here from the same
		// event causes Svelte to push the state back to the DOM mid-keystroke, which
		// clobbers the cursor and drops typed characters. The Win+H / IME sync that
		// this branch used to do is moved to a non-input event path (see bug #816).
		el.style.height = 'auto';
		const lineHeight = 20;
		const maxLines = 10;
		const maxHeight = lineHeight * maxLines;
		el.style.height = Math.min(el.scrollHeight, maxHeight) + 'px';
		// Persist draft for active tab
		const tab = getActiveTab();
		if (tab) {
			tab.draft = terminalInputText || '';
			try { sessionStorage.setItem('pan_tab_draft:' + tab.sessionId, tab.draft); } catch {}
		}
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

	async function loadAvailableModels() {
		try {
			const data = await api('/api/v1/ai/models');
			availableModels = data?.models || [];
			localModels = data?.local || [];
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

	// Atlas: loadAtlasData / buildAtlasGraph / atlasNodeColor /
	// atlasStatusDot / handleAtlasWheel + Down/Move/Up / atlasResetView
	// all migrated to $lib/stores/atlas.svelte.js + $lib/components/widgets/AtlasPanel.svelte

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

	// loadUsageData migrated to $lib/stores/usage.svelte.js (UsagePanel mounts/unmounts the polling)

	// formatTokens migrated to usage store
	function pctColor(pct) {
		if (pct < 50) return 'green';
		if (pct < 80) return 'yellow';
		return 'red';
	}

	// formatResetTime migrated to usage store

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

	// loadAlerts/loadAlertCount/loadAlertTypes/updateAlertStatus all migrated to
	// $lib/components/AlertsPanel.svelte. Parent only keeps a small adapter
	// that bumps the openCount via WS pushes.
	async function loadAlertCount() {
		try {
			const resp = await api('/dashboard/api/alerts/count');
			alertOpenCount = resp?.count || 0;
		} catch {}
	}

	// Lifeboat functions migrated to LifeboatPanel.svelte

	function formatUptime(seconds) {
		if (!seconds && seconds !== 0) return '--';
		if (seconds < 60) return `${Math.floor(seconds)}s`;
		if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`;
		const h = Math.floor(seconds / 3600);
		const m = Math.floor((seconds % 3600) / 60);
		return `${h}h ${m}m`;
	}

	// loadApprovals / respondToApproval migrated to
	// $lib/components/ApprovalsPanel.svelte.

	// ==================== Users ====================
	// loadUsers / openChildView / addUserSubmit migrated to UsersPanel.svelte

	// ==================== PAN Clients ====================
	let deviceMetrics = $state({}); // device_id → latest metric snapshot

	async function loadAllDevices() {
		try {
			const d = await api('/dashboard/api/devices');
			allDevices = Array.isArray(d) ? d : (d.devices || []);
		} catch {}
		// Fetch live resource metrics alongside device list
		try {
			const m = await api('/api/v1/client/metrics');
			const map = {};
			for (const row of (m.metrics || [])) map[row.device_id] = row;
			deviceMetrics = map;
		} catch {}
	}
	function startAllDevicesPolling() {
		loadAllDevices();
		if (allDevicesPollTimer) clearInterval(allDevicesPollTimer);
		// 30s fallback — widget_update: 'devices' WS push handles real-time changes
		allDevicesPollTimer = setInterval(loadAllDevices, 30_000);
	}
	function stopAllDevicesPolling() {
		if (allDevicesPollTimer) { clearInterval(allDevicesPollTimer); allDevicesPollTimer = null; }
	}

	// Voice enrollment functions migrated to $lib/components/IntuitionPanel.svelte
	// (Shape-2 refactor 2026-05-27). The Identity section there embeds the
	// enroll/record/delete-speaker UI; the component manages its own state.

	async function renameDevicePanel(id) {
		if (!deviceRenameName.trim()) return;
		try {
			await api(`/api/v1/devices/${id}/rename`, { method: 'PATCH', body: JSON.stringify({ name: deviceRenameName.trim() }) });
			deviceRenameId = null;
			deviceRenameName = '';
			await loadAllDevices();
		} catch {}
	}

	async function removeDevicePanel(id) {
		try {
			await api(`/api/v1/devices/${id}`, { method: 'DELETE' });
			deviceDeleteConfirmId = null;
			await loadAllDevices();
			await loadClientDevices();
		} catch {}
	}

	async function loadClientDevices() {
		try {
			const resp = await fetch('/api/v1/client/devices');
			if (resp.ok) {
				const d = await resp.json();
				panClientDevices = d.devices || [];
				// WS widget_update:'devices' is the primary real-time path.
				// Poll at 8s when pending approvals (urgent), 30s otherwise (fallback only).
				const hasPending = panClientDevices.some(dev => dev.trusted === false);
				const targetInterval = hasPending ? 8000 : 30_000;
				if (!panClientPollTimer) {
					panClientPollTimer = setInterval(loadClientDevices, targetInterval);
				}
			}
		} catch {}
	}

	async function approveClient(deviceId) {
		await fetch(`/api/v1/client/${encodeURIComponent(deviceId)}/approve`, { method: 'POST' });
		await loadClientDevices();
		await loadAllDevices();
	}

	async function denyClient(deviceId) {
		await fetch(`/api/v1/client/${encodeURIComponent(deviceId)}/deny`, { method: 'POST' });
		await loadClientDevices();
		await loadAllDevices();
	}

	async function generateClientInvite() {
		const name = panClientInviteName.trim() || 'new-device';
		try {
			const resp = await fetch(`/api/v1/client/invite?name=${encodeURIComponent(name)}`);
			if (resp.ok) {
				const d = await resp.json();
				const isWin = navigator.userAgent.includes('Win');
				panClientInviteCmd = isWin ? d.install.windows : d.install.linux;
			}
		} catch {}
	}

	// Teams functions migrated to TeamsPanel.svelte

	// Test runner state + functions migrated to $lib/components/widgets/TestsPanel.svelte

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

	// ==================== Swap / Health Polling ====================

	/**
	 * Silently poll /health every 500ms until the server is ready, then reload.
	 * No overlay — the existing Π loading screen in app.html covers the load.
	 */
	function waitForServerAndReload() {
		if (window._panSwapPolling) return;
		window._panSwapPolling = true;
		const base = `${window.location.protocol}//${window.location.hostname}:${window.location.port || (window.location.protocol === 'https:' ? '443' : '80')}`;
		const pageUrl = `${base}${window.location.pathname}`;
		// Poll /dashboard/api/status — a Craft-proxied API endpoint (not a static file).
		// Static files are served by Carrier and always return 200 even mid-swap.
		// Only /dashboard/api/status returning 200 proves the new Craft is actually live.
		const craftStatusUrl = `${base}/dashboard/api/status`;
		let consecutiveOk = 0;
		// Wait 1.5s before starting to poll — give Craft time to bind and initialize
		// before we hammer it, so we don't get a false 200 from a half-ready Craft.
		setTimeout(() => {
			const poll = setInterval(async () => {
				try {
					const r = await fetch(craftStatusUrl, { cache: 'no-store' });
					if (r.ok) {
						consecutiveOk++;
						// Two consecutive 200s on the Craft API → it's truly ready
						if (consecutiveOk >= 2) {
							clearInterval(poll);
							window._panSwapPolling = false;
							// Mark swap reload so onMount skips clearing pan_claude_launched:
							// guards — Claude is already running, clearing them causes a fresh
							// re-launch and a new adapter session UUID.
							sessionStorage.setItem('pan_swap_in_progress', '1');
							window.location.href = pageUrl + '?t=' + Date.now();
						}
					} else { consecutiveOk = 0; }
				} catch { consecutiveOk = 0; }
			}, 600);
			// Safety: clear stale polling flag after 30s so the next swap is never blocked
			setTimeout(() => { clearInterval(poll); window._panSwapPolling = false; }, 30_000);
		}, 1500);
	}

	// ==================== Domain store mirroring ====================
	// Every $effect below re-runs whenever its read state changes, copying
	// the parent's local var into the matching domain store. Widgets read
	// from the stores and stay in sync without prop drilling.
	// Keep this block in one place so the contract is visible at a glance.
	$effect(() => { servicesStore.list      = servicesData; });
	$effect(() => { orgStore.data           = orgData; });
	$effect(() => { orgStore.permsMatrix    = permsMatrix; });
	$effect(() => { voiceStore.settings     = voiceSettings; });
	$effect(() => { voiceStore.availableModels = availableModels; });
	$effect(() => { voiceStore.localModels  = localModels; });
	$effect(() => { projectStore.data       = projectData; });
	$effect(() => { projectStore.tasks      = tasksData; });
	$effect(() => { projectStore.sections   = sectionsData; });
	$effect(() => { projectStore.milestoneFilter = rightMilestoneFilter; });
	$effect(() => { devicesStore.all        = allDevices; });
	$effect(() => { devicesStore.panClients = panClientDevices; });
	$effect(() => { devicesStore.metrics    = deviceMetrics; });
	$effect(() => { chatStore.bubbles       = chatBubbles; });
	// Center column terminal-store mirrors (2026-05-28) so PtyStatusBar /
	// ApprovalBar / CenterChatView / ImagePreviewBar widgets see parent state.
	$effect(() => { terminalStore.claudeReady        = claudeReady; });
	$effect(() => { terminalStore.ptyStatus          = ptyStatus; });
	$effect(() => { terminalStore.ptyStatusNow       = ptyStatusNow; });
	$effect(() => { terminalStore.pendingSendCount   = pendingSendCount; });
	$effect(() => { terminalStore.pipeSending        = pipeSending; });
	$effect(() => { terminalStore.approvalOptions    = approvalOptions; });
	$effect(() => { terminalStore.centerChatMessages = centerChatMessages; });
	$effect(() => { terminalStore.centerChatLoading  = centerChatLoading; });
	$effect(() => { terminalStore.pastedImages       = pastedImages; });

	// ==================== Init ====================

	onMount(() => {
		_markLoad('mounted');

		// ─── Desktop dashboard telemetry (task #505, L2 of dashboard self-heal) ───
		// Browser errors → /api/v1/logs (mirrors what phone's LogShipper does).
		// Widget health → /api/v1/dashboard/health every 30s, scanning every
		// [data-widget] element for its state. Server uses this to detect
		// "rendered but empty" / "stale" widgets and file bugs in L3.
		(function startDashboardTelemetry() {
			if (window._panTelemetryStarted) return;
			window._panTelemetryStarted = true;
			const DEVICE_ID = 'desktop-dashboard';
			function shipLog(level, message, meta) {
				try {
					fetch('/api/v1/logs', {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({
							device_id: DEVICE_ID,
							device_type: 'browser',
							level: level || 'error',
							source: 'window',
							message: String(message || '').slice(0, 4000),
							meta: meta || {}
						})
					}).catch(() => {});
				} catch (e) { /* never let telemetry crash the app */ }
			}
			window.addEventListener('error', (e) => {
				shipLog('error', e?.message || 'window.error', {
					filename: e?.filename, lineno: e?.lineno, colno: e?.colno,
					stack: e?.error?.stack ? String(e.error.stack).slice(0, 2000) : null,
					ua: navigator.userAgent
				});
			});
			window.addEventListener('unhandledrejection', (e) => {
				const reason = e?.reason;
				shipLog('error', 'unhandledrejection: ' + (reason?.message || String(reason)).slice(0, 200), {
					stack: reason?.stack ? String(reason.stack).slice(0, 2000) : null,
					ua: navigator.userAgent
				});
			});

			// Widget health scan — every 30s, walk every [data-widget] in the DOM
			// and POST a snapshot. State machine lives entirely in the markup;
			// this code just reads it.
			function scanWidgets() {
				try {
					const els = document.querySelectorAll('[data-widget]');
					const widgets = [];
					els.forEach((el) => {
						const w = el.getAttribute('data-widget');
						if (!w) return;
						const state = el.getAttribute('data-widget-state') || 'unknown';
						const side = el.getAttribute('data-widget-side') || null;
						const rendered_at = parseInt(el.getAttribute('data-widget-rendered-at') || '0', 10) || 0;
						const data_source_at = parseInt(el.getAttribute('data-widget-data-source-at') || '0', 10) || 0;
						// has_data is true if we have actual non-empty content
						const has_data = state === 'ok' || state === 'stale';
						widgets.push({ widget: w, side, state, rendered_at, data_source_at, has_data });
					});
					if (widgets.length === 0) return;
					fetch('/api/v1/dashboard/health', {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({ device_id: DEVICE_ID, page: 'terminal', widgets })
					}).catch(() => {});
				} catch (e) { /* telemetry must never throw */ }
			}
			// First scan after 5s (give widgets time to render), then every 30s.
			setTimeout(scanWidgets, 5000);
			setInterval(scanWidgets, 30000);
			// Also scan whenever a panel is switched, so state changes propagate
			// quickly without waiting for the next 30s tick.
			window._panRescanWidgets = scanWidgets;
		})();

		// Bug #457: capture the dashboard bundle hash at mount so the server_swap
		// handler can decide whether the swap actually requires a page reload.
		// If the bundle is unchanged, we skip the reload entirely.
		fetch('/api/dashboard/bundle-hash', { cache: 'no-store' })
			.then(r => r.ok ? r.json() : null)
			.then(j => { if (j?.hash) window._panBundleHash = j.hash; })
			.catch(() => {});

		// Wrapped app services migrated to $lib/components/widgets/AppsPanel.svelte —
		// it fetches /api/v1/wrap/services itself when the user drills into a device.
		// Parent no longer needs to preload.
		// Clear auto-launch guards on page load so Claude greets on refresh.
		// Exception: swap-triggered reloads preserve the guards so Claude isn't
		// re-launched into a fresh session — the existing process is still live.
		const isSwapReload = sessionStorage.getItem('pan_swap_in_progress') === '1';
		sessionStorage.removeItem('pan_swap_in_progress');
		if (!isSwapReload) {
			for (let i = sessionStorage.length - 1; i >= 0; i--) {
				const key = sessionStorage.key(i);
				if (key?.startsWith('pan_claude_launched:')) sessionStorage.removeItem(key);
			}
		}

		// Check URL params — apps open in new windows with ?view=atlas etc.
		const urlParams = new URLSearchParams(window.location.search);
		const viewParam = urlParams.get('view');
		if (viewParam === 'atlas') {
			switchCenterView('atlas');
		}

		restoreChatFromStorage(); // Instantly restore chat from before refresh
		loadTerminalProjects();
		loadVoiceSettings();
		loadAvailableModels();

		// Load initial panel data based on what's selected
		if (leftSection === 'usage' || rightSection === 'usage') storeLoadUsageData();
		if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('pan:tests-update'));
		// Intuition: IntuitionPanel component handles its own initial load via onMount.
		if (leftSection === 'devices' || rightSection === 'devices') { startAllDevicesPolling(); loadClientDevices(); }
		// BenchmarksPanel polls itself when mounted

		// Load permission matrix (gates which panel options are visible)
		reloadPermsMatrix();

		// Load org context — retries with backoff. See loadOrgContextWithRetry
		// definition at top-level for the full rationale + regression-test note.
		loadOrgContextWithRetry();

		// Load services + users + lifeboat immediately. Approvals + Alerts are
		// self-loading inside their own components.
		api('/dashboard/api/services').then(r => { servicesData = r?.services || []; }).catch(() => {});
		// UsersPanel auto-loads on mount
		loadAlertCount();
		// LifeboatPanel auto-loads on mount

		// --- Polling intervals (visibility-aware: pause when tab is hidden) ---
		let _pageVisible = true;
		const visCb = () => {
			const wasHidden = !_pageVisible;
			_pageVisible = !document.hidden;
			// Bug #768: when the tab wakes from a long background sleep, the WS may be
			// silently dead (OS kept socket nominally "open" through suspend, server
			// already dropped us). The 15s transcript heartbeat and 8s PTY status poll
			// won't fire for up to their interval, so any replies that landed while we
			// were hidden stay invisible. Force an immediate sync on every visible
			// transition. Cheap (one HTTP + one WS frame per tab) and idempotent.
			if (_pageVisible && wasHidden) {
				try {
					const tab = getActiveTab();
					if (tab) {
						// Force the heartbeat to re-poll on its next tick (and now).
						tab._lastTranscriptPush = 0;
						if (tab.sessionId) {
							api(`/api/v1/terminal/messages/${encodeURIComponent(tab.sessionId)}`)
								.then(msgs => {
									if (!msgs) return;
									const serverVersion = msgs?._messageVersion;
									const arr = Array.isArray(msgs) ? msgs : msgs.messages;
									const hasNew = serverVersion !== undefined
										? serverVersion !== tab._lastMessageVersion
										: Array.isArray(arr) && arr.length > getPushed(tab.id).length;
									if (hasNew && Array.isArray(arr)) {
										if (serverVersion !== undefined) tab._lastMessageVersion = serverVersion;
										setPushed(tab.id, arr);
										renderTranscriptToTerminal(tab);
									}
								})
								.catch(() => {});
						}
					}
					// WS-level wakeup. If our socket is dead or closing, close it
					// explicitly so the existing reconnect logic kicks in. If it's
					// alive, fire a sync_request so we get the authoritative state
					// snapshot right now instead of waiting for the next push.
					const allTabs = (typeof tabs !== 'undefined' && Array.isArray(tabs)) ? tabs : [];
					for (const t of allTabs) {
						const sock = t.ws;
						if (!sock) continue;
						if (sock.readyState === 1) {
							try { sock.send(JSON.stringify({ type: 'sync_request', kinds: ['session'] })); } catch {}
						} else if (sock.readyState === 2 || sock.readyState === 3) {
							try { sock.close(); } catch {}
						}
					}
				} catch (e) {
					console.warn('[PAN #768] visibilitychange wakeup sync failed:', e?.message);
				}
			}
		};
		document.addEventListener('visibilitychange', visCb);

		// Start chat refresh
		chatRefreshInterval = setInterval(() => {
			if (_pageVisible && leftSection === 'transcript') loadChatHistory();
		}, 15000);

		// Emergency fallback polls — WS push (widget_update) is the primary real-time path.
		// These fire rarely and only exist to recover from missed WS events (reconnect gap, etc.).
		const svcInterval = setInterval(() => {
			if (!_pageVisible) return;
			_trackWidget('services', 'poll');
			api('/dashboard/api/services').then(r => { servicesData = r?.services || []; }).catch(() => {});
		}, 180_000); // 3 min — WS push handles real-time
		const approvalInterval = setInterval(() => { if (_pageVisible) { _trackWidget('approvals', 'poll'); if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('pan:approvals-update')); } }, 120_000); // 2 min fallback — kicks ApprovalsPanel
		// LifeboatPanel polls itself every 30s
		const alertCountInterval = setInterval(() => { if (_pageVisible) { _trackWidget('alerts', 'poll'); loadAlertCount(); } }, 120_000); // 2 min fallback

		// Transcript heartbeat — fallback poll every 15s.
		// The primary path is adapter → WS push (real-time). But if a push is missed
		// (WS blip, missed event, session reconnect), this catches it.
		const transcriptHeartbeat = setInterval(async () => {
			if (!_pageVisible) return;
			const tab = getActiveTab();
			if (!tab?.sessionId) return;
			const now = Date.now();
			const lastPush = tab._lastTranscriptPush || 0;
			// Only poll if we haven't received a push in the last 15s
			if (now - lastPush < 15000) return;
			try {
				const msgs = await api(`/api/v1/terminal/messages/${encodeURIComponent(tab.sessionId)}`);
				// Use _messageVersion integer for dedup — avoids Svelte proxy stale-comparison bug (#444).
				// Falls back to length comparison if server doesn't send version (legacy sessions).
				const serverVersion = msgs?._messageVersion;
				const hasNew = serverVersion !== undefined
					? serverVersion !== tab._lastMessageVersion
					: Array.isArray(msgs) && msgs.length > getPushed(tab.id).length;
				if (hasNew && Array.isArray(msgs)) {
					if (serverVersion !== undefined) tab._lastMessageVersion = serverVersion;
					setPushed(tab.id, msgs);
					renderTranscriptToTerminal(tab);
				}
			} catch {}
		}, 15000);

		// PTY status fallback poll — 8s. The screen-v2 WS frames already update claudeReady
		// in real-time (see handleMessage 'screen-v2' case). This poll just syncs ptyStatus
		// for the info display and catches edge cases (session reconnect, tab switch).
		const ptyStatusInterval = setInterval(async () => {
			if (!_pageVisible) return;
			try {
				const tab = getActiveTab();
				if (!tab?.sessionId) { ptyStatus = null; return; }
				const r = await api('/api/v1/terminal/sessions');
				const list = r?.sessions || [];
				const match = list.find(s => s.id === tab.sessionId);
				ptyStatus = match || null;
				if (match) {
					const realReady = !match.thinking;
					if (claudeReady !== realReady) claudeReady = realReady;
					if (tab.claudeReady !== realReady) tab.claudeReady = realReady;
				}
			} catch {}
		}, 8000);
		// 2s ticker for "Xs ago" labels
		const ptyTicker = setInterval(() => { ptyStatusNow = Date.now(); }, 2000);

		// Poll for UI commands (window opens, etc.)
		const uiCmdInterval = setInterval(async () => {
			if (!_pageVisible) return;
			try {
				const cmds = await api('/api/v1/ui-commands');
				if (!Array.isArray(cmds)) return;
				for (const cmd of cmds) {
					if (cmd.type === 'open_window' && cmd.url) {
						window.open(cmd.url, '_blank');
					}
				}
			} catch {}
		}, 3000);

		// Auto-connect: wait for projects to load, then start terminal
		let saveStateInterval = null; // tracked so cleanup can clear it (prevents stacking on hot-swap)
		setTimeout(async () => {
			// Make sure projects are loaded
			await loadTerminalProjects();
			if (projects.length === 0) {
				// Retry once after delay
				await new Promise(r => setTimeout(r, 1000));
				await loadTerminalProjects();
			}

			let reconnected = false;

			// SWR-style fast restore (2026-05-30): paint cached tabs from
			// localStorage IMMEDIATELY so the UI is never blank while the
			// DB + sessions network calls below are in flight. The original
			// flow awaited Promise.all before painting anything, which meant
			// every navigation away from /terminal and back showed an empty
			// "Select Project..." screen for as long as Craft took to answer
			// /dashboard/api/open-tabs. With Craft sometimes briefly
			// unresponsive (residual sporadic blocks), that "as long as"
			// could be 4-10 seconds — long enough to feel broken.
			//
			// We pre-create tabs from localStorage with isReconnect=false (no
			// WS reconnect yet — that happens after the DB confirms the live
			// PTY state). The DB-driven loop below skips any sessionId that
			// was already created from cache, then upgrades cache-only tabs to
			// live ones by reconnecting their WS once we know a live session
			// exists for them.
			// Gate SWR on DOM-ready: createTab does termContainerEl.appendChild(),
			// which throws "Cannot read properties of null" if Svelte's bind:this
			// hasn't wired termContainerEl yet (race on fast re-mount from panel nav).
			// Wait up to 2s for it to bind, otherwise skip SWR and let the DB loop
			// drive the restore once termContainerEl is ready.
			try {
				const swrStart = Date.now();
				while (!termContainerEl && Date.now() - swrStart < 2000) {
					await new Promise(r => setTimeout(r, 50));
				}
				if (termContainerEl) {
					const cachedSessions = getSavedSessionState();
					for (const s of cachedSessions) {
						if (!s.sessionId) continue;
						if (tabs.some(t => t.sessionId === s.sessionId)) continue;
						await createTab(s.sessionId, s.project || 'Shell', s.cwd || '%USERPROFILE%\\Desktop', s.projectId, false, s.tabName || null, s.claudeSessionIds);
					}
				}
			} catch (e) {
				console.warn('[Terminal] localStorage fast-restore failed:', e?.message);
			}

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

				const dbSessionIds = new Set(dbTabs.map(t => t.sessionId));
				const dashSessions = sessions.filter(s =>
					s.id.startsWith(sessionPrefix) || s.id.startsWith('mob-')
				);
				const liveSessionMap = new Map(dashSessions.map(s => [s.id, s]));

				// ── UNIFIED RESTORE ───────────────────────────────────────────────
				// A DB-saved tab is the source of truth for "this tab exists". A
				// live server session is just the optional PTY backing it. We must
				// ALWAYS materialize every DB tab, regardless of whether its PTY
				// is currently alive — otherwise tabs vanish on refresh when their
				// server-side session was killed (and the user has no UI to bring
				// them back without digging into the closed-tabs list).
				//
				// For each DB tab:
				//   • live session exists → reconnect (isReconnect=true)
				//   • no live session    → recreate (isReconnect=false). The WS
				//     handshake will spawn a fresh PTY under the same sessionId.
				//     The saved claudeSessionIds let the adapter resume the prior
				//     claude conversation on the first pipeSend.
				if (dbTabs.length > 0) {
					const sorted = [...dbTabs].sort((a, b) => (a.tabIndex || 0) - (b.tabIndex || 0));
					for (const dt of sorted) {
						const live = liveSessionMap.get(dt.sessionId);
						const project = live?.project || dt.project || 'Shell';
						const cwd = live?.cwd || dt.cwd || '%USERPROFILE%\\Desktop';
						const matchedProject = projects.find(p => p.name === project);
						const pid = matchedProject ? matchedProject.id : dt.projectId;
						// If the SWR pre-paint above already materialized this tab from
						// localStorage, reconcile DB-authoritative fields onto the
						// existing object (project name / cwd / claudeSessionIds may
						// have been updated server-side since the last save). Don't
						// blow away the existing tab — it already has a live WS, the
						// scrollback DOM is mounted, etc.
						const existing = tabs.find(t => t.sessionId === dt.sessionId);
						if (existing) {
							existing.project = project;
							existing.cwd = cwd;
							existing.projectId = pid;
							if (dt.tabName) existing.tabName = dt.tabName;
							if (Array.isArray(dt.claudeSessionIds) && dt.claudeSessionIds.length) {
								existing.claudeSessionIds = [...new Set([...(existing.claudeSessionIds || []), ...dt.claudeSessionIds])];
							}
							reconnected = true;
							continue;
						}
						await createTab(dt.sessionId, project, cwd, pid, !!live, dt.tabName || null, dt.claudeSessionIds);
						reconnected = true;
					}
				}

				// Adopt any live sessions that the DB doesn't know about. Happens
				// when the DB save raced a hard refresh, or sessions were created
				// out-of-band (mobile, API). Without this, those tabs would be
				// either killed as orphans below OR linger forever invisible.
				//
				// Seed adoptedIds with BOTH dbTabs AND any sessions we already
				// materialized from the SWR cache above — otherwise we'd
				// re-createTab() a session that's already a tab, which is what
				// produced the "Cannot read properties of null (reading
				// 'appendChild')" error from the duplicate createTab call.
				const adoptedIds = new Set([
					...dbTabs.map(t => t.sessionId),
					...tabs.map(t => t.sessionId),
				]);
				for (const s of dashSessions) {
					if (adoptedIds.has(s.id)) continue;
					const matchedProject = projects.find(p => p.name === s.project);
					const pid = matchedProject ? matchedProject.id : null;
					console.log(`[PAN Terminal] Adopting unknown live session ${s.id} (no DB row)`);
					await createTab(s.id, s.project || 'Shell', s.cwd || '%USERPROFILE%\\Desktop', pid, true, null, null);
					adoptedIds.add(s.id);
					reconnected = true;
				}

				// Kill server-side orphans — live sessions older than 30s with no
				// clients AND not adopted by any tab. The 30s grace prevents
				// killing sessions that briefly drop to 0 clients during refresh.
				// Re-check tabs at kill time to be race-safe.
				const now = Date.now();
				for (const s of dashSessions) {
					const age = now - (s.createdAt || 0);
					if ((s.clients || 0) > 0) continue;
					if (age < 30000) continue;
					if (tabs.some(t => t.sessionId === s.id)) continue; // adopted
					console.log(`[PAN Terminal] Killing orphan session ${s.id} (no tab, no clients, age ${Math.round(age/1000)}s)`);
					fetch(`/api/v1/terminal/sessions/${encodeURIComponent(s.id)}`, { method: 'DELETE' }).catch(() => {});
				}

				// Kill duplicate live sessions for the same project — keep the
				// one a tab adopted, kill the rest. Prevents zombie PTYs eating
				// resources after a buggy reopen flow created two sessions.
				const byProject = new Map();
				for (const s of dashSessions) {
					if (!s.project) continue;
					if (!byProject.has(s.project)) byProject.set(s.project, []);
					byProject.get(s.project).push(s);
				}
				for (const [, group] of byProject) {
					if (group.length <= 1) continue;
					group.sort((a, b) => {
						const aAdopted = tabs.some(t => t.sessionId === a.id) ? 1 : 0;
						const bAdopted = tabs.some(t => t.sessionId === b.id) ? 1 : 0;
						return (bAdopted - aAdopted) ||
						       ((b.clients || 0) - (a.clients || 0)) ||
						       ((b.createdAt || 0) - (a.createdAt || 0));
					});
					for (const dup of group.slice(1)) {
						if ((dup.clients || 0) === 0 && !tabs.some(t => t.sessionId === dup.id)) {
							console.log(`[PAN Terminal] Killing duplicate session ${dup.id} for project ${dup.project}`);
							fetch(`/api/v1/terminal/sessions/${encodeURIComponent(dup.id)}`, { method: 'DELETE' }).catch(() => {});
						}
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
					await createTab(s.sessionId, s.project || 'Shell', s.cwd || '%USERPROFILE%\\Desktop', s.projectId, false, s.tabName || null, s.claudeSessionIds);
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

			// Restore complete — allow manual project selection
			restoringTabs = false;

			// Save session state periodically
			saveStateInterval = setInterval(saveSessionState, 5000);
		}, 300);

		// Save state on page unload (backup — Svelte cleanup may not fire on full refresh)
		const handleBeforeUnload = () => {
			saveSessionState();
			saveChatToStorage();
			// Save active tab's input draft so it survives refresh
			const tab = getActiveTab();
			if (tab) {
				tab.draft = terminalInputText || '';
				try { sessionStorage.setItem('pan_tab_draft:' + tab.sessionId, tab.draft); } catch {}
			}
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

			// F5 — force page reload (Tauri doesn't pass F5 through natively in prod builds)
			if (e.key === 'F5') {
				e.preventDefault();
				location.reload();
				return;
			}

			// Escape is ALWAYS handled — even if focused elsewhere or WS is wobbly
			if (e.key === 'Escape') {
				e.preventDefault();
				e.stopPropagation();
				const active = getActiveTab();
				if (active?.ws) {
					try { active.ws.send(JSON.stringify({ type: 'interrupt' })); } catch {}
				}
				// Also try via HTTP fallback in case WS is dead
				fetch(`/api/v1/terminal/interrupt?session=${active?.sessionId || ''}`, { method: 'POST' }).catch(() => {});
				console.log('[PAN] Escape pressed — interrupt sent');
				return;
			}

			// Skip if user is typing in a non-terminal input (e.g. rename, search, voice enroll)
			const tag = e.target?.tagName;
			if ((tag === 'INPUT' || tag === 'TEXTAREA') && e.target !== terminalInputEl) return;

			// Enter — send terminal input even if the textarea has lost focus.
			// If focus IS on the terminal textarea, handleTerminalInputKey already handled it —
			// skip here to avoid a double-send.
			if (e.key === 'Enter' && !e.shiftKey) {
				e.preventDefault();
				if (e.target === terminalInputEl) return; // handled by onkeydown on the textarea
				if (terminalInputEl) terminalInputEl.focus();
				sendTerminalInput(terminalInputEl?.value || terminalInputText || '');
				return;
			}

			// Printable character typed while focus is NOT in the input box →
			// steal focus back to the terminal input and append the character.
			// Mirrors real terminal emulator behaviour: you can never "lose" your typing.
			const isPrintable = e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey;
			if (isPrintable && document.activeElement !== terminalInputEl) {
				e.preventDefault();
				if (terminalInputEl) {
					terminalInputEl.focus();
					// Append character at cursor position
					const start = terminalInputEl.selectionStart ?? terminalInputEl.value.length;
					const end   = terminalInputEl.selectionEnd   ?? terminalInputEl.value.length;
					const cur   = terminalInputEl.value;
					terminalInputEl.value = cur.slice(0, start) + e.key + cur.slice(end);
					terminalInputText = terminalInputEl.value;
					terminalInputEl.selectionStart = terminalInputEl.selectionEnd = start + 1;
				}
				return;
			}

			const active = getActiveTab();
			if (!active?.ws || active.ws.readyState !== 1) return;
			// Number keys 1-3 when input is empty AND there's a pending approval
			if (/^[1-3]$/.test(e.key) && !terminalInputEl?.value?.trim() && approvalsCount > 0) {
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

		// Terminal settings change — wipe cached renders so colors/fonts apply immediately.
		// Registered here (not at module eval time) so cleanup can remove them and prevent
		// listener stacking across hot-swaps and page reloads.
		const handleTermSettingsChanged = () => {
			for (const t of tabs) {
				if (t.scrollbackDiv) t.scrollbackDiv.innerHTML = '';
				t._renderedMsgCount = 0;
				renderTranscriptToTerminal(t);
			}
		};
		// AI settings change in Settings page. Previously this cleared every launch
		// guard so Π Remembers would re-fire on next WS reconnect — but that also
		// caused a fresh launch printf into ALREADY-RUNNING tabs, which the user
		// experienced as "changing a model restarts the chat in other tabs."
		//
		// New behavior: do nothing for tabs that already started Claude. If the user
		// wants the new provider/model applied to a running session, they can close
		// the tab and reopen it (or use the per-tab dropdown, which only affects
		// the active tab).
		const handleStorageChange = (e) => {
			if (e.key === 'pan_ai_changed') {
				console.log('[PAN Terminal] AI settings changed in Settings page — running tabs unaffected. New tabs will pick up the new defaults.');
			}
		};
		window.addEventListener('pan-terminal-settings-changed', handleTermSettingsChanged);
		window.addEventListener('storage', handleStorageChange);

		// Load data for initially selected panels (otherwise they show "loading" forever)
		if (leftSection === 'usage' || rightSection === 'usage') storeLoadUsageData();
		// LibraryPanel auto-loads on mount
		if (leftSection === 'perf') startPerfPolling();
		if (rightSection === 'perf') startPerfPolling();

		return () => {
			saveSessionState(); // Persist session IDs before page unloads
			saveChatToStorage(); // Persist chat before page unloads
			document.removeEventListener('visibilitychange', visCb);
			window.removeEventListener('keydown', handleGlobalKeydown);
			window.removeEventListener('pan-terminal-settings-changed', handleTermSettingsChanged);
			window.removeEventListener('storage', handleStorageChange);
			window.removeEventListener('resize', handleResize);
			if (termResizeObserver) termResizeObserver.disconnect();
			window.removeEventListener('beforeunload', handleBeforeUnload);
			if (saveStateInterval) { clearInterval(saveStateInterval); saveStateInterval = null; }
			if (chatRefreshInterval) clearInterval(chatRefreshInterval);
			// atlasAnimTimer moved to AtlasPanel.svelte (handles its own cleanup on destroy)
			clearInterval(svcInterval);
			clearInterval(approvalInterval);
			// lifeboatInterval moved to LifeboatPanel.svelte (handles its own cleanup on destroy)
			clearInterval(alertCountInterval);
			clearInterval(ptyStatusInterval);
			clearInterval(transcriptHeartbeat);
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

<!-- ==================== Perf panel snippet (shared by left + right sidebar) ====================
     Renders the full "Perf" widget body:
       1. Readiness summary (system / interactive / swap-safe + critical path)
       2. View toggle (List / Gantt)
       3. Stages grouped by phase (or Gantt bars on a shared timeline)
       4. Last message timings (client-side mirror of hot.* events)
       5. Page load trace (client-side only, per-page)
       6. Speed / Resources / Bottlenecks / Heavy processes (existing steward data)
     Backed by GET /api/v1/perf/trace (carrier) — single source of truth. -->
<!-- {#snippet perfPanelContents()} migrated to <PerfPanel /> component 2026-05-28 -->

<!-- {#snippet intuitionPanelContents()} migrated to <IntuitionPanel /> component
     2026-05-27. See $lib/components/IntuitionPanel.svelte. -->

<!-- TOOLBAR -->
<div class="toolbar">
	<select class="project-select" value={selectedProjectValue} onchange={(e) => {
		const val = e.target.value;
		if (restoringTabs) {
			// Restore in progress — reset dropdown to current value to prevent duplicate creation
			e.target.value = selectedProjectValue;
			return;
		}
		if (val === '__shell__') {
			createTab('dash-shell-' + Date.now(), 'Shell', '%USERPROFILE%\\Desktop', null, false);
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
	{#if permsMatrix?.isImpersonating}
		<div class="impersonate-banner">
			<span><strong>{impersonationLabel(permsMatrix.impersonation)}</strong></span>
			<button class="impersonate-stop" onclick={stopImpersonation} title="Exit impersonation">✕ Exit</button>
		</div>
	{:else if permsMatrix?.realPower >= 100}
		<button class="impersonate-btn" onclick={() => impersonateModalOpen = true} title="Impersonate a user, power level, or group">👁 Impersonate…</button>
	{/if}
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
			<select class="right-select" bind:value={leftSection} onchange={() => {
				// Extracted panels (Intuition/Benchmarks/Pipeline/Library/Alerts/Approvals/Users/Teams/Usage/Lifeboat) self-load on mount.
				if (leftSection === 'usage') storeLoadUsageData();
				// TestsPanel auto-loads on mount
				if (leftSection === 'contacts') storeLoadContacts();
				// MailPanel + ContactsPanel auto-load on mount
				if (leftSection === 'devices' || leftSection === 'apps') { startAllDevicesPolling(); if (leftSection === 'devices') loadClientDevices(); } else { stopAllDevicesPolling(); }
				if (leftSection === 'perf') startPerfPolling(); else stopPerfPolling();
			}}>
				<option value="alerts">Alerts{alertOpenCount > 0 ? ` (${alertOpenCount})` : ''}</option>
				{#if widgetVisible('approvals')}<option value="approvals">Approvals{approvalsCount > 0 ? ` (${approvalsCount})` : ''}</option>{/if}
				<option value="apps">Apps</option>
				{#if widgetVisible('benchmarks')}<option value="benchmarks">Benchmarks</option>{/if}
				{#if widgetVisible('pipeline')}<option value="pipeline">Beta Pipeline</option>{/if}
				{#if widgetVisible('bugs')}<option value="bugs">Bugs</option>{/if}
				{#if widgetVisible('contacts')}<option value="contacts">Contacts{chatStore.unreadTotal > 0 ? ` (${chatStore.unreadTotal})` : ''}</option>{/if}
				{#if widgetVisible('devices')}<option value="devices">Devices</option>{/if}
				{#if widgetVisible('instances')}<option value="instances">Instances</option>{/if}
				{#if widgetVisible('intuition')}<option value="intuition">Intuition</option>{/if}
				{#if widgetVisible('lifeboat')}<option value="lifeboat">Lifeboat</option>{/if}
				{#if widgetVisible('library')}<option value="library">Library</option>{/if}
					<option value="live-call">Live Call</option>
				{#if widgetVisible('mail')}<option value="mail">Mail</option>{/if}
				{#if widgetVisible('perf')}<option value="perf">Performance</option>{/if}
				{#if widgetVisible('project')}<option value="project">Project</option>{/if}
				{#if widgetVisible('services')}<option value="services">Services</option>{/if}
				{#if widgetVisible('setup')}<option value="setup">Setup Guide</option>{/if}
				{#if widgetVisible('tasks')}<option value="tasks">Tasks</option>{/if}
				{#if widgetVisible('teams')}<option value="teams">Teams</option>{/if}
				{#if widgetVisible('tests')}<option value="tests">Tests</option>{/if}
				{#if widgetVisible('transcript')}<option value="transcript">Transcript</option>{/if}
				{#if widgetVisible('usage')}<option value="usage">Usage</option>{/if}
				{#if widgetVisible('users')}<option value="users">Users</option>{/if}
				{#each sectionsData as s}
					<option value="custom-{s.id}">{s.name}</option>
				{/each}
			</select>
			{#if leftSection === 'contacts' || leftSection === 'mail' || leftSection === 'calendar'}
				<button class="expand-btn" onclick={() => openExpandedView(leftSection)} title="Open in window">&#x2197;</button>
			{/if}
		</div>
		<div class="left-content"
			bind:this={chatSidebarEl}
			onscroll={handleTranscriptScroll}
			data-widget={leftSection}
			data-widget-side="left"
			data-widget-state={widgetStateOf(leftSection)}
			data-widget-rendered-at={Date.now()}>
			{#if leftSection === 'transcript'}
				<TranscriptPanel />
			{:else if leftSection === 'project'}
				<ProjectPanel />
			{:else if leftSection === 'approvals'}
				<ApprovalsPanel bind:count={approvalsCount} />
			{:else if leftSection === 'devices'}
				<DevicesPanel />
			{:else if leftSection === 'services'}
				<ServicesPanel />
			{:else if leftSection === 'tasks'}
				<TasksPanel onCycle={cycleTask} />
			{:else if leftSection === 'bugs'}
				<BugsPanel onCycle={cycleTask} />
			{:else if leftSection === 'perf'}
				<div class="perf-widget">
					<PerfPanel />
				</div>
			{:else if leftSection === 'library'}
				<LibraryPanel />
			{:else if leftSection === 'usage'}
				<div class="empty-state">Select Usage from the right panel</div>
			{:else if leftSection === 'setup'}
				<SetupPanel />
			{:else if leftSection === 'apps'}
				<AppsPanel />
			{:else if leftSection === 'instances'}
				<InstancesPanel {isDev} />
			{:else if leftSection === 'intuition'}
				<div class="intuition-panel"
					data-widget="intuition"
					data-widget-rendered-at={Date.now()}>
					<IntuitionPanel />
				</div>
			{:else if leftSection === 'lifeboat'}
				<LifeboatPanel />
			{:else if leftSection === 'tests'}
				<TestsPanel {isDev} {getActiveTab} />
			{:else if leftSection === 'users'}
				<UsersPanel />
			{:else if leftSection === 'teams'}
				<TeamsPanel />
			{:else if leftSection === 'contacts'}
				<ContactsPanel switchCenterView={switchCenterView} />
			{:else if leftSection === 'alerts'}
				<AlertsPanel bind:openCount={alertOpenCount} />
			{:else if leftSection === 'benchmarks'}
				<BenchmarksPanel />
			{:else if leftSection === 'pipeline'}
				<PipelinePanel />
			{:else if leftSection === 'mail'}
				<MailPanel />
			{:else if leftSection === 'live-call'}
				<LiveCallPanel />
			{/if}
		</div>
	</div>

	<!-- LEFT RESIZE HANDLE -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div class="resize-handle" onmousedown={(e) => onResizeStart('left', e)}></div>

	<!-- CENTER: Terminal -->
	<div class="center-panel">
		<div class="center-tabs">
			<button class="center-tab" class:active={centerView === 'terminal'} onclick={() => switchCenterView('terminal')}>{isDev ? 'Terminal - Dev' : 'Terminal'}</button>
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
			<CenterChatView bind:scrollElBind={centerChatEl} />
		{/if}
		{#if centerView === 'atlas'}
			<AtlasPanel />
  {/if}
		<!-- Messages panel removed -->
		<!-- Call Overlay -->
		{#if chatStore.callActive}
			<div class="call-overlay">
				<div class="call-card">
					<div class="call-avatar">{chatStore.activeThread?.contact?.display_name?.charAt(0) || '?'}</div>
					<div class="call-name">{chatStore.activeThread?.contact?.display_name || 'Unknown'}</div>
					<div class="call-status">{chatStore.callActive.type === 'video' ? 'Video' : 'Voice'} call — {chatStore.callActive.status}</div>
					<div class="call-actions">
						<button class="call-end-btn" onclick={storeEndCall}>
							<svg width="24" height="24" viewBox="0 0 24 24" fill="white"><path d="M12 9c-1.6 0-3.15.25-4.6.72v3.1c0 .39-.23.74-.56.9-.98.49-1.87 1.12-2.66 1.85-.18.18-.43.28-.7.28-.28 0-.53-.11-.71-.29L.29 13.08a.956.956 0 01-.29-.7c0-.28.11-.53.29-.71C3.34 8.78 7.46 7 12 7s8.66 1.78 11.71 4.67c.18.18.29.43.29.71 0 .28-.11.53-.29.71l-2.48 2.48c-.18.18-.43.29-.71.29-.27 0-.52-.11-.7-.28a11.27 11.27 0 00-2.67-1.85.996.996 0 01-.56-.9v-3.1C15.15 9.25 13.6 9 12 9z"/></svg>
						</button>
					</div>
				</div>
			</div>
		{/if}

		<!-- ── Impersonate Modal ──────────────────────────────────────────────── -->
		<ImpersonatePanel bind:open={impersonateModalOpen} onApplied={reloadPermsMatrix} />

		<ImagePreviewBar onRemove={removePastedImage} />
		{#if !approvalOptions || approvalOptions.length === 0}
			<PtyStatusBar />
		{/if}
		<ApprovalBar onApprove={sendApproval} />
		<div class="center-input-bar">
			<button class="mic-btn" class:listening={isListening} onclick={toggleVoiceInput} title="Voice Input"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg></button>
			<button class="call-btn" onclick={openPanCall} title="Call Π"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg></button>
			<select
				class="model-pill-select"
				title="Switch model — applies to THIS tab only. Other tabs keep their own model."
				value={getActiveTab()?.model || voiceSettings.terminal_ai_model || ''}
				onchange={async (e) => {
					const model = e.target.value;
					const active = getActiveTab();
					const sid = active?.sessionId;
					if (!sid) return;
					try {
						// Per-tab only: switch model on the running session, persist on the
						// tab object. Do NOT write to global settings, do NOT clear launch
						// guards, do NOT broadcast pan_ai_changed — those side-effects were
						// the cause of model switches restarting chats in other tabs.
						const r = await api('/api/v1/terminal/set-model', { method: 'POST', body: JSON.stringify({ session_id: sid, model }) });
						if (r?.ok) {
							active.model = model;
							// 2026-05-28: bug #757 fix — Svelte 5 proxies don't re-fire on
							// `tabs = tabs` self-assignment. Spread to force a new array
							// reference so the dropdown's `value={...}` re-evaluates.
							tabs = [...tabs];
							saveSessionState();
						} else {
							console.warn('[PAN] set-model failed for session', sid, r);
						}
					} catch (err) {
						console.warn('[PAN] set-model error', err);
					}
				}}
			>
				{#if availableModels.length > 0}
					{#each availableModels as m}
						<option value={m.id}>{m.id.replace(/^claude-/, '').replace(/-\d{8}$/, '')}</option>
					{/each}
				{:else}
					<option value="claude-sonnet-4-6">sonnet-4-6</option>
					<option value="claude-opus-4-7-20250415">opus-4-7</option>
					<option value="claude-opus-4-6">opus-4-6</option>
					<option value="claude-haiku-4-5-20251001">haiku-4-5</option>
				{/if}
				{#if localModels.length > 0}
					<optgroup label="Local">
						{#each localModels as m}
							<option value={m.id}>{m.name}</option>
						{/each}
					</optgroup>
				{/if}
			</select>
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
			<button class="center-send-btn" onclick={sendTerminalInput} disabled={pipeSending || (!terminalInputText.trim() && pastedImages.length === 0)} title={pipeSending ? 'Sending…' : !claudeReady ? 'Queued (Claude busy)' : 'Send'}>
				{#if pipeSending}
					<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="pipe-spin"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>
				{:else}
					<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
				{/if}
			</button>
		</div>
	</div>

	<!-- RIGHT RESIZE HANDLE -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div class="resize-handle" onmousedown={(e) => onResizeStart('right', e)}></div>

	<!-- RIGHT PANEL -->
	<div class="right-panel" class:resizing={resizingPanel !== null} style="width: {rightPanelWidth}px">
		<div class="right-header">
			<select class="right-select" bind:value={rightSection} onchange={() => {
				rightMilestoneFilter = null;
				// Extracted panels self-load on mount via onMount + WS event subscriptions.
				if (rightSection === 'usage') storeLoadUsageData();
				// TestsPanel auto-loads on mount
				if (rightSection === 'contacts') storeLoadContacts();
				// MailPanel + ContactsPanel auto-load on mount
				if (rightSection === 'devices' || rightSection === 'apps') { startAllDevicesPolling(); if (rightSection === 'devices') loadClientDevices(); } else { stopAllDevicesPolling(); }
				if (rightSection === 'perf') startPerfPolling(); else stopPerfPolling();
			}}>
				<option value="alerts">Alerts{alertOpenCount > 0 ? ` (${alertOpenCount})` : ''}</option>
				{#if widgetVisible('approvals')}<option value="approvals">Approvals{approvalsCount > 0 ? ` (${approvalsCount})` : ''}</option>{/if}
				<option value="apps">Apps</option>
				{#if widgetVisible('benchmarks')}<option value="benchmarks">Benchmarks</option>{/if}
				{#if widgetVisible('pipeline')}<option value="pipeline">Beta Pipeline</option>{/if}
				{#if widgetVisible('bugs')}<option value="bugs">Bugs</option>{/if}
				{#if widgetVisible('contacts')}<option value="contacts">Contacts{chatStore.unreadTotal > 0 ? ` (${chatStore.unreadTotal})` : ''}</option>{/if}
				{#if widgetVisible('devices')}<option value="devices">Devices</option>{/if}
				{#if widgetVisible('instances')}<option value="instances">Instances</option>{/if}
				{#if widgetVisible('intuition')}<option value="intuition">Intuition</option>{/if}
				{#if widgetVisible('lifeboat')}<option value="lifeboat">Lifeboat</option>{/if}
				{#if widgetVisible('library')}<option value="library">Library</option>{/if}
					<option value="live-call">Live Call</option>
				{#if widgetVisible('mail')}<option value="mail">Mail</option>{/if}
				{#if widgetVisible('perf')}<option value="perf">Performance</option>{/if}
				{#if widgetVisible('project')}<option value="project">Project</option>{/if}
				{#if widgetVisible('services')}<option value="services">Services</option>{/if}
				{#if widgetVisible('setup')}<option value="setup">Setup Guide</option>{/if}
				{#if widgetVisible('tasks')}<option value="tasks">Tasks</option>{/if}
				{#if widgetVisible('teams')}<option value="teams">Teams</option>{/if}
				{#if widgetVisible('tests')}<option value="tests">Tests</option>{/if}
				{#if widgetVisible('transcript')}<option value="transcript">Transcript</option>{/if}
				{#if widgetVisible('usage')}<option value="usage">Usage</option>{/if}
				{#if widgetVisible('users')}<option value="users">Users</option>{/if}
				{#each sectionsData as s}
					<option value="custom-{s.id}">{s.name}</option>
				{/each}
			</select>
			{#if alertOpenCount > 0 && rightSection !== 'alerts'}
				<button class="alert-indicator" onclick={() => { rightSection = 'alerts'; if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('pan:alerts-update')); }} title="{alertOpenCount} open alert(s)">
					{alertOpenCount}
				</button>
			{/if}
		</div>
		<div class="right-content"
			data-widget={rightSection}
			data-widget-side="right"
			data-widget-state={widgetStateOf(rightSection)}
			data-widget-rendered-at={Date.now()}>
			{#if rightSection === 'alerts'}
				<AlertsPanel bind:openCount={alertOpenCount} />
			{:else if rightSection === 'services'}
				<ServicesPanel />
			{:else if rightSection === 'apps'}
				<AppsPanel />
			{:else if rightSection === 'instances'}
				<InstancesPanel {isDev} />
			{:else if rightSection === 'intuition'}
				<div class="intuition-panel"
					data-widget="intuition"
					data-widget-rendered-at={Date.now()}>
					<IntuitionPanel />
				</div>
			{:else if rightSection === 'lifeboat'}
				<LifeboatPanel />
			{:else if rightSection === 'setup'}
				<SetupPanel />
			{:else if rightSection === 'tasks'}
				<TasksPanel onCycle={cycleTask} />
			{:else if rightSection === 'bugs'}
				<BugsPanel onCycle={cycleTask} />
			{:else if rightSection === 'perf'}
				<div class="perf-widget">
					<PerfPanel />
				</div>
			{:else if rightSection === 'usage'}
				<UsagePanel />
			{:else if rightSection === 'live-call'}
				<LiveCallPanel />
			{:else if rightSection === 'approvals'}
				<ApprovalsPanel bind:count={approvalsCount} />
			{:else if rightSection === 'devices'}
				<DevicesPanel />
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
				<ProjectPanel />
			{:else if rightSection === 'tests'}
				<TestsPanel {isDev} {getActiveTab} />
			{:else if rightSection === 'library'}
				<LibraryPanel />
			{:else if rightSection === 'users'}
				<UsersPanel />
			{:else if rightSection === 'teams'}
				<TeamsPanel />
			{:else if rightSection === 'contacts'}
				<ContactsPanel switchCenterView={switchCenterView} />
			{:else if rightSection === 'mail'}
				<MailPanel />
			{:else if rightSection === 'benchmarks'}
				<BenchmarksPanel />
			{:else if rightSection === 'pipeline'}
				<PipelinePanel />
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

<!-- Compose opens in Tauri window via openCompose() -->

<style>
	/* ==================== Center Panel ==================== */
	.center-panel {
		flex: 1;
		min-height: 0;
		min-width: 0;             /* panels enforce min terminal width via resize logic */
		display: flex;
		flex-direction: column;
		position: relative;
	}

	/* ── Π crossbar: solid blue bar, overshooting past legs ── */
	.center-panel::before {
		content: '';
		position: absolute;
		top: 0;
		left: -18px;
		right: -18px;
		height: 2px;
		background: #89b4fa;
		z-index: 10;
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
		border-bottom-color: transparent;  /* crossbar is now on top, not bottom */
		text-shadow: 0 0 12px rgba(137, 180, 250, 0.3);
	}

	:global(.center-chat) {
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

	:global(.cc-bubble) {
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

	:global(.cc-user) {
		align-self: flex-end;
		background: #89b4fa;
		color: #0a0a0f;
		border-bottom-right-radius: 4px;
	}

	:global(.cc-assistant) {
		align-self: flex-start;
		background: #2a2a3a;
		color: #cdd6f4;
		border-bottom-left-radius: 4px;
	}

	:global(.cc-tool) {
		align-self: flex-start;
		background: #1a1a25;
		color: #6c7086;
		font-size: 11px;
		font-family: monospace;
		border-left: 2px solid #45475a;
	}

	:global(.cc-thinking) {
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

	/* Call Π button — same shape as mic, green-accent hover (live call). */
	.call-btn {
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
	.call-btn:hover { color: #a6e3a1; border-color: #a6e3a1; }

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

	:global(.image-preview-bar) {
		display: flex;
		gap: 6px;
		padding: 6px 12px;
		background: #12121a;
		border-top: 1px solid #1e1e2e;
	}
	:global(.image-preview-item) {
		position: relative;
		width: 48px;
		height: 48px;
		border-radius: 6px;
		overflow: hidden;
		border: 1px solid #1e1e2e;
	}
	:global(.image-preview-thumb) {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}
	:global(.image-remove) {
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
	:global(.image-uploading) {
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
	@keyframes pipe-spin { to { transform: rotate(360deg); } }
	.pipe-spin { animation: pipe-spin 0.8s linear infinite; }

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
	:global(.status-spinner) {
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

	:global(.pty-status-bar) {
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
	.pty-status-bar.pty-no-claude { color: #f9e2af; }
	.pty-status-bar.pty-no-pty { color: #f38ba8; }
	.pty-status-bar .status-text { font-style: normal; font-weight: 600; }
	:global(.pty-meta) {
		color: #6c7086;
		padding-left: 8px;
		border-left: 1px solid #313244;
	}
	.pty-meta:first-of-type { border-left: none; padding-left: 0; }
	:global(.status-dot) {
		display: inline-block;
		width: 8px;
		height: 8px;
		border-radius: 50%;
	}
	.dot-green { background: #a6e3a1; box-shadow: 0 0 6px #a6e3a1; }
	.dot-yellow { background: #f9e2af; box-shadow: 0 0 6px #f9e2af; }
	.dot-red { background: #f38ba8; box-shadow: 0 0 6px #f38ba8; }

	:global(.approval-bar) {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 6px 10px;
		background: #181825;
		border-top: 1px solid #f9e2af;
		flex-wrap: wrap;
	}
	:global(.approval-label) {
		color: #f9e2af;
		font-size: 12px;
		font-weight: 600;
		margin-right: 4px;
	}
	:global(.approval-btn) {
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
	:global(.approval-num) {
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
	:global(.approval-text) {
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

	:global(.project-select) {
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

	/* ── Impersonation toolbar controls ───────────────────────────────── */
	.impersonate-btn {
		background: #1e1e2e;
		border: 1px solid #45475a;
		border-radius: 5px;
		color: #cdd6f4;
		font-size: 11px;
		padding: 3px 10px;
		cursor: pointer;
		margin-right: 4px;
		white-space: nowrap;
	}
	.impersonate-btn:hover { border-color: #f9e2af; color: #f9e2af; }

	.impersonate-banner {
		display: flex;
		align-items: center;
		gap: 8px;
		background: rgba(249,226,175,0.12);
		border: 1px solid rgba(249,226,175,0.4);
		border-radius: 5px;
		padding: 3px 10px;
		font-size: 11px;
		color: #f9e2af;
		margin-right: 6px;
	}
	.impersonate-stop {
		background: rgba(243,139,168,0.15);
		border: 1px solid rgba(243,139,168,0.4);
		border-radius: 4px;
		color: #f38ba8;
		font-size: 10px;
		padding: 1px 6px;
		cursor: pointer;
	}
	.impersonate-stop:hover { background: rgba(243,139,168,0.3); }

	/* ── Impersonate Modal ─────────────────────────────────────────────── */
	/* .imp-* styles migrated to $lib/components/ImpersonatePanel.svelte */
	.imp-apply:hover:not(:disabled) { background: rgba(137,180,250,0.25); }
	.imp-apply:disabled { opacity: .45; cursor: not-allowed; }

	.org-badge {
		display: inline-flex;
		align-items: center;
		gap: 0;
		background: #1e1e2e;
		border: 1px solid #313244;
		border-radius: 6px;
		padding: 3px 8px;
		font-size: 12px;
		margin-right: 8px;
	}
	.org-user { color: #a6e3a1; font-weight: 500; }
	.org-at { color: #6c7086; margin: 0 1px; }
	.org-name { color: #89b4fa; font-weight: 500; }

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
		width: 4px;
		cursor: col-resize;
		background: linear-gradient(to bottom,
			#89b4fa 0%,
			#89b4fa 50%,
			rgba(137, 180, 250, 0.3) 80%,
			rgba(137, 180, 250, 0.05) 100%
		);
		flex-shrink: 0;
		transition: all 0.15s;
		position: relative;
		margin-top: -3px;
		z-index: 11;
	}
	.resize-handle:hover {
		background: linear-gradient(to bottom,
			#89b4fa 0%,
			#89b4fa 60%,
			rgba(137, 180, 250, 0.4) 85%,
			rgba(137, 180, 250, 0.1) 100%
		);
		box-shadow: 0 0 8px rgba(137, 180, 250, 0.2);
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
		scrollbar-width: thin;
		scrollbar-color: rgba(166,227,161,0.3) transparent;
	}
	.left-content::-webkit-scrollbar { width: 6px; }
	.left-content::-webkit-scrollbar-track { background: transparent; }
	.left-content::-webkit-scrollbar-thumb { background: rgba(166,227,161,0.3); border-radius: 3px; }
	.left-content::-webkit-scrollbar-thumb:hover { background: rgba(166,227,161,0.5); }

	/* ==================== Chat ==================== */
	.chat-container {
		display: flex;
		flex-direction: column;
		gap: 8px;
		min-width: 0;
	}

	.chat-turn { display: flex; flex-direction: column; gap: 4px; min-width: 0; margin-bottom: 6px; }
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

	.model-pill-select {
		background: #1e1e2e;
		border: 1px solid #313244;
		border-radius: 4px;
		color: #cba6f7;
		font-size: 10px;
		font-family: ui-monospace, monospace;
		padding: 2px 4px;
		cursor: pointer;
		outline: none;
		flex-shrink: 0;
		max-width: 85px;
		text-align: center;
		height: 36px;
	}
	.model-pill-select:hover { border-color: #cba6f7; }

	.chat-bubble {
		word-break: break-word;
		overflow-wrap: break-word;
		white-space: normal;
		overflow-x: auto;
		min-width: 0;
		line-height: 1.4;
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

	.chat-stats-bar {
		display: flex;
		justify-content: space-between;
		padding: 2px 8px;
		font-size: 9px;
		color: #585b70;
		font-family: monospace;
		border-top: 1px solid #1e1e2e;
		margin: 1px 0 4px;
	}
	.chat-stats-total { opacity: 0.6; }

	/* ==================== Markdown in chat bubbles ==================== */
	/* Bug #484 root cause: ALL .md-* selectors target elements injected via
	   {@html} from the markdown renderer (parseMarkdown). Svelte's CSS scoping
	   can't see those elements in the template, so it STRIPS every md-* rule
	   from the compiled bundle as "unused" — leaving tables, bullets, code
	   blocks, headings unstyled. Verified: `grep md-table public/v2/_app/.../*.css`
	   returns zero hits. Fix: wrap the whole markdown CSS block in :global so
	   the rules survive scoping and actually reach the rendered HTML. */
	/* Use `.chat-bubble :global(...)` pattern so .chat-bubble stays SCOPED
	   (transcript view doesn't get smashed) while .md-* survives scoping
	   (it targets {@html}-injected elements Svelte can't see in template). */
	.chat-bubble :global(strong) { font-weight: 700; color: #cdd6f4; }
	.chat-bubble :global(em) { font-style: italic; color: #bac2de; }
	.chat-bubble :global(.md-bullet) { padding-left: 14px; position: relative; margin: 2px 0; }
	.chat-bubble :global(.md-bullet::before) { content: '•'; position: absolute; left: 2px; color: #6c7086; }
	.chat-bubble :global(.md-numbered::before) { content: counter(md-list) '.'; counter-increment: md-list; }
	.chat-bubble :global(.md-code) { background: rgba(137,180,250,0.12); padding: 1px 4px; border-radius: 3px; font-family: monospace; font-size: 0.9em; }
	.chat-bubble :global(.md-codeblock) { background: #11111b; padding: 6px 8px; border-radius: 4px; font-family: monospace; font-size: 0.85em; overflow-x: auto; margin: 4px 0; white-space: pre; }
	.chat-bubble :global(.md-codeblock code) { background: none; padding: 0; }
	.chat-bubble :global(.md-h1) { font-size: 1.2em; font-weight: 700; margin: 6px 0 4px; color: #cdd6f4; }
	.chat-bubble :global(.md-h2) { font-size: 1.1em; font-weight: 600; margin: 4px 0 2px; color: #cdd6f4; }
	.chat-bubble :global(.md-h3) { font-size: 1.0em; font-weight: 600; margin: 4px 0 2px; color: #bac2de; }
	/* Tables — visible borders + clear header row so it actually LOOKS like a table.
	   Default cells nowrap (preserves atomic tokens like paths/IDs); last column
	   wraps as prose. Wrapper div scrolls horizontally when content is wider than bubble. */
	.chat-bubble :global(.md-table-wrap) {
		display: block;
		overflow-x: auto;
		max-width: 100%;
		margin: 8px 0;
		border: 1px solid #45475a;
		border-radius: 4px;
		background: #181825;
		-webkit-overflow-scrolling: touch;
	}
	.chat-bubble :global(.md-table) {
		border-collapse: collapse;
		font-size: 0.9em;
		width: auto;
		min-width: 100%;
		table-layout: auto;
		background: transparent;
	}
	.chat-bubble :global(.md-table th),
	.chat-bubble :global(.md-table td) {
		border: 1px solid #45475a;
		padding: 6px 10px;
		text-align: left;
		vertical-align: top;
		word-break: keep-all;
		overflow-wrap: normal;
		white-space: nowrap;
		color: #cdd6f4;
	}
	.chat-bubble :global(.md-table th:last-child),
	.chat-bubble :global(.md-table td:last-child) {
		white-space: normal;
		word-break: normal;
		overflow-wrap: anywhere;
		max-width: 60ch;
		min-width: 20ch;
	}
	.chat-bubble :global(.md-table th) {
		background: #313244;
		font-weight: 700;
		color: #cdd6f4;
		border-bottom: 2px solid #585b70;
	}
	.chat-bubble :global(.md-table td) { color: #bac2de; }
	.chat-bubble :global(.md-table tbody tr:nth-child(odd) td),
	.chat-bubble :global(.md-table tr:nth-child(even) td) { background: #1e1e2e; }
	.chat-bubble :global(.md-table tr:nth-child(odd) td) { background: #11111b; }

	/* SAME ruleset for the center TERMINAL panel (.term-scrollback). That div is
	   built via document.createElement (not in the Svelte template), so the whole
	   selector must be :global() to survive scoping. Its inline styles include
	   `word-break:break-word; white-space:pre-wrap` which would inherit down to
	   td cells — these rules override at the cell level. */
	:global(.term-scrollback .md-table-wrap) {
		display: block;
		overflow-x: auto;
		max-width: 100%;
		margin: 8px 0;
		border: 1px solid #45475a;
		border-radius: 4px;
		background: #181825;
		-webkit-overflow-scrolling: touch;
		white-space: normal;
	}
	:global(.term-scrollback .md-table) {
		border-collapse: collapse;
		font-size: 0.9em;
		width: auto;
		min-width: 100%;
		table-layout: auto;
		background: transparent;
		white-space: normal;
	}
	:global(.term-scrollback .md-table th),
	:global(.term-scrollback .md-table td) {
		border: 1px solid #45475a;
		padding: 6px 10px;
		text-align: left;
		vertical-align: top;
		word-break: keep-all;
		overflow-wrap: normal;
		white-space: nowrap;
		color: #cdd6f4;
	}
	:global(.term-scrollback .md-table th:last-child),
	:global(.term-scrollback .md-table td:last-child) {
		white-space: normal;
		word-break: normal;
		overflow-wrap: anywhere;
		max-width: 60ch;
		min-width: 20ch;
	}
	:global(.term-scrollback .md-table th) {
		background: #313244;
		font-weight: 700;
		color: #cdd6f4;
		border-bottom: 2px solid #585b70;
	}
	:global(.term-scrollback .md-table td) { color: #bac2de; }
	:global(.term-scrollback .md-table tr:nth-child(even) td) { background: #1e1e2e; }
	:global(.term-scrollback .md-table tr:nth-child(odd) td) { background: #11111b; }

	/* ==================== Project Info ==================== */
	:global(.project-info) {
		margin-bottom: 10px;
	}
	:global(.project-name) {
		font-weight: 600;
		font-size: 14px;
		margin-bottom: 4px;
	}
	:global(.project-progress-row) {
		display: flex;
		align-items: baseline;
		gap: 6px;
		margin-bottom: 4px;
	}
	:global(.project-pct) {
		font-size: 20px;
		font-weight: 700;
		color: #89b4fa;
	}
	:global(.project-count) {
		color: #6c7086;
		font-size: 10px;
	}
	:global(.project-sessions) {
		font-size: 10px;
		color: #6c7086;
		margin-top: 4px;
	}

	:global(.milestone) {
		margin-bottom: 8px;
		cursor: pointer;
	}
	.milestone:hover { opacity: 0.8; }
	:global(.milestone-row) {
		display: flex;
		align-items: center;
		gap: 4px;
		margin-bottom: 2px;
	}
	:global(.milestone-name) {
		flex: 1;
		font-size: 11px;
		font-weight: 500;
	}
	:global(.milestone-pct) {
		font-size: 10px;
		color: #6c7086;
	}

	:global(.progress-bar) {
		height: 5px;
		background: #1e1e2e;
		border-radius: 3px;
		overflow: hidden;
		margin-bottom: 6px;
	}
	.progress-bar.small { height: 3px; margin-bottom: 0; }

	:global(.progress-fill) {
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

	/* Library widget */
	.library-panel { display: flex; flex-direction: column; height: 100%; padding: 8px; gap: 8px; }
	.library-toolbar { display: flex; gap: 6px; }
	.library-search { flex: 1; background: #181b22; border: 1px solid #2a2f3a; color: #cdd6f4; padding: 4px 8px; border-radius: 3px; font-size: 12px; }
	.library-filter { background: #181b22; border: 1px solid #2a2f3a; color: #cdd6f4; padding: 4px; border-radius: 3px; font-size: 12px; }
	.library-refresh { background: #181b22; border: 1px solid #2a2f3a; color: #cdd6f4; padding: 4px 8px; border-radius: 3px; cursor: pointer; }
	.library-list { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 4px; }
	.library-row { padding: 6px 8px; background: #14171d; border: 1px solid #232831; border-radius: 3px; cursor: pointer; }
	.library-row:hover { background: #1c2029; border-color: #3a4150; }
	.library-row-head { display: flex; align-items: center; gap: 6px; }
	.library-type { font-size: 9px; padding: 1px 5px; border-radius: 2px; text-transform: uppercase; font-weight: 600; }
	.library-type-doc { background: #1e3a5f; color: #89b4fa; }
	.library-type-memory { background: #3a2a4d; color: #cba6f7; }
	.library-type-pan { background: #2d4a2d; color: #a6e3a1; }
	.library-title { font-size: 12px; color: #cdd6f4; }
	.library-snippet { font-size: 11px; color: #6c7086; margin-top: 3px; padding-left: 2px; }

	/* Perf widget */
	:global(.perf-widget) {
		padding: 8px;
	}
	:global(.perf-overall) {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 10px 12px;
		border-radius: 6px;
		margin-bottom: 10px;
		font-weight: bold;
		font-size: 14px;
	}
	.perf-overall-good { background: rgba(166, 227, 161, 0.15); color: #a6e3a1; }
	.perf-overall-warn { background: rgba(249, 226, 175, 0.15); color: #f9e2af; }
	.perf-overall-bad { background: rgba(243, 139, 168, 0.15); color: #f38ba8; }
	.perf-overall-icon { font-size: 16px; font-weight: 900; }
	.perf-overall-text { font-size: 13px; }
	:global(.perf-bar-track) {
		height: 4px;
		background: #1e1e2e;
		border-radius: 2px;
		margin: 2px 8px 6px;
		overflow: hidden;
	}
	:global(.perf-bar-fill) {
		height: 100%;
		background: #a6e3a1;
		border-radius: 2px;
		transition: width 0.3s;
	}
	.perf-bar-fill.perf-warn { background: #f9e2af; }
	.perf-bar-fill.perf-bad { background: #f38ba8; }
	:global(.perf-metric) {
		display: flex;
		justify-content: space-between;
		padding: 6px 8px;
		border-bottom: 1px solid #1e1e2e;
		font-size: 12px;
	}
	.perf-label { color: #a6adc8; }
	.perf-label[title] { cursor: help; border-bottom: 1px dotted rgba(166, 173, 200, 0.25); }
	.perf-value { color: #a6e3a1; font-weight: bold; font-family: 'JetBrains Mono', monospace; }
	.perf-value.perf-warn { color: #f9e2af; }
	.perf-value.perf-bad { color: #f38ba8; }
	:global(.perf-metric.perf-stage-final) {
		background: rgba(203, 166, 247, 0.08);
		border-top: 1px solid rgba(203, 166, 247, 0.25);
		border-bottom: 1px solid rgba(203, 166, 247, 0.25);
		margin-top: 2px;
	}
	.perf-metric.perf-stage-final .perf-label { color: #cba6f7; font-weight: 600; }
	.perf-metric.perf-stage-final .perf-value { color: #cba6f7; }

	/* Readiness summary (system/interactive/swap_safe/probes) */
	:global(.perf-ready-grid) {
		display: grid;
		grid-template-columns: repeat(4, 1fr);
		gap: 4px;
		padding: 4px 8px 2px 8px;
	}
	:global(.perf-ready-cell) {
		text-align: center;
		padding: 6px 4px;
		border-radius: 6px;
		background: rgba(255, 255, 255, 0.02);
		border: 1px solid rgba(255, 255, 255, 0.05);
	}
	:global(.perf-ready-cell.perf-ready-good) {
		background: rgba(166, 227, 161, 0.1);
		border-color: rgba(166, 227, 161, 0.3);
	}
	:global(.perf-ready-cell.perf-ready-bad) {
		background: rgba(249, 226, 175, 0.08);
		border-color: rgba(249, 226, 175, 0.25);
	}
	:global(.perf-ready-val) {
		font-size: 13px;
		font-weight: 700;
		font-family: 'JetBrains Mono', monospace;
		color: #cdd6f4;
		letter-spacing: 0.5px;
	}
	.perf-ready-cell.perf-ready-good .perf-ready-val { color: #a6e3a1; }
	.perf-ready-cell.perf-ready-bad .perf-ready-val { color: #f9e2af; }
	:global(.perf-ready-lbl) {
		font-size: 9px;
		color: #a6adc8;
		text-transform: uppercase;
		letter-spacing: 0.4px;
		margin-top: 2px;
		cursor: help;
	}

	/* View toggle (List / Gantt) */
	:global(.perf-view-toggle) {
		display: flex;
		gap: 4px;
		padding: 6px 8px 0 8px;
	}
	:global(.perf-view-btn) {
		flex: 1;
		background: rgba(255, 255, 255, 0.03);
		border: 1px solid rgba(255, 255, 255, 0.08);
		color: #a6adc8;
		padding: 4px 8px;
		font-size: 11px;
		font-family: inherit;
		cursor: pointer;
		border-radius: 4px;
		transition: all 0.15s;
	}
	.perf-view-btn:hover { background: rgba(255, 255, 255, 0.06); color: #cdd6f4; }
	:global(.perf-view-btn.perf-view-active) {
		background: rgba(137, 180, 250, 0.15);
		border-color: rgba(137, 180, 250, 0.4);
		color: #89b4fa;
	}

	/* Stage rows in list view */
	:global(.perf-stage-row) {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 4px 8px;
		border-bottom: 1px solid #1e1e2e;
		font-size: 11px;
	}
	:global(.perf-stage-dot) {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: #6c7086;
		flex-shrink: 0;
	}
	.perf-stage-row.perf-stage-ready .perf-stage-dot { background: #a6e3a1; box-shadow: 0 0 4px rgba(166, 227, 161, 0.5); }
	.perf-stage-row.perf-stage-failed .perf-stage-dot { background: #f38ba8; box-shadow: 0 0 4px rgba(243, 139, 168, 0.6); }
	.perf-stage-row.perf-stage-running .perf-stage-dot { background: #f9e2af; animation: perfPulse 1s infinite; }
	.perf-stage-row.perf-stage-pending .perf-stage-dot { background: #45475a; }
	@keyframes perfPulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
	:global(.perf-stage-name) {
		flex: 1;
		color: #cdd6f4;
		cursor: help;
		border-bottom: 1px dotted rgba(205, 214, 244, 0.15);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.perf-stage-row.perf-stage-pending .perf-stage-name { opacity: 0.5; }
	:global(.perf-stage-val) {
		font-family: 'JetBrains Mono', monospace;
		color: #a6e3a1;
		font-size: 10px;
		font-weight: bold;
		min-width: 40px;
		text-align: right;
	}
	.perf-stage-val.perf-warn { color: #f9e2af; }
	.perf-stage-val.perf-bad { color: #f38ba8; }
	.perf-stage-row.perf-stage-failed .perf-stage-val { color: #f38ba8; }
	.perf-stage-row.perf-stage-pending .perf-stage-val { color: #6c7086; }
	:global(.perf-reprobe-btn) {
		background: transparent;
		border: none;
		color: #6c7086;
		cursor: pointer;
		font-size: 12px;
		padding: 0 2px;
		line-height: 1;
	}
	.perf-reprobe-btn:hover { color: #89b4fa; }
	:global(.perf-stage-err) {
		font-size: 10px;
		color: #f38ba8;
		padding: 2px 8px 4px 20px;
		opacity: 0.85;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		cursor: help;
	}

	/* Gantt view */
	:global(.perf-gantt) {
		padding: 4px 8px;
		display: flex;
		flex-direction: column;
		gap: 3px;
	}
	:global(.perf-gantt-row) {
		display: grid;
		grid-template-columns: 110px 1fr 44px;
		align-items: center;
		gap: 6px;
		font-size: 10px;
	}
	:global(.perf-gantt-name) {
		color: #cdd6f4;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	:global(.perf-gantt-track) {
		position: relative;
		height: 10px;
		background: rgba(255, 255, 255, 0.03);
		border-radius: 2px;
		overflow: hidden;
	}
	:global(.perf-gantt-bar) {
		position: absolute;
		top: 0;
		bottom: 0;
		border-radius: 2px;
		min-width: 2px;
	}
	.perf-gantt-bar.perf-gantt-ready { background: linear-gradient(90deg, rgba(166, 227, 161, 0.6), rgba(166, 227, 161, 0.9)); }
	.perf-gantt-bar.perf-gantt-failed { background: linear-gradient(90deg, rgba(243, 139, 168, 0.6), rgba(243, 139, 168, 0.9)); }
	:global(.perf-gantt-bar.perf-gantt-running) {
		background: repeating-linear-gradient(90deg, rgba(249, 226, 175, 0.3), rgba(249, 226, 175, 0.6) 10px, rgba(249, 226, 175, 0.3) 20px);
		animation: perfSlide 1s linear infinite;
	}
	.perf-gantt-bar.perf-gantt-pending { background: rgba(69, 71, 90, 0.5); }
	@keyframes perfSlide {
		0% { background-position: 0 0; }
		100% { background-position: 20px 0; }
	}
	:global(.perf-gantt-ms) {
		font-family: 'JetBrains Mono', monospace;
		color: #a6adc8;
		font-size: 9px;
		text-align: right;
	}
	:global(.perf-gantt-legend) {
		display: flex;
		justify-content: space-between;
		padding: 4px 8px 8px 8px;
		font-size: 9px;
		color: #6c7086;
	}
	.perf-gantt-legend span { display: flex; align-items: center; gap: 3px; }
	:global(.perf-gantt-swatch) {
		display: inline-block;
		width: 10px;
		height: 8px;
		border-radius: 2px;
	}
	.perf-gantt-swatch.perf-gantt-ready { background: rgba(166, 227, 161, 0.7); }
	.perf-gantt-swatch.perf-gantt-failed { background: rgba(243, 139, 168, 0.7); }
	.perf-gantt-swatch.perf-gantt-running { background: rgba(249, 226, 175, 0.5); }
	.perf-gantt-swatch.perf-gantt-pending { background: rgba(69, 71, 90, 0.6); }
	:global(.perf-section-title) {
		font-size: 11px;
		font-weight: bold;
		color: #89b4fa;
		padding: 4px 8px;
		text-transform: uppercase;
		letter-spacing: 0.5px;
	}
	:global(.perf-proc) {
		padding: 6px 8px;
		border-bottom: 1px solid #1e1e2e;
	}
	:global(.perf-proc.perf-zombie) {
		background: rgba(243, 139, 168, 0.1);
		border-left: 2px solid #f38ba8;
	}
	:global(.perf-proc-header) {
		display: flex;
		justify-content: space-between;
		align-items: center;
	}
	:global(.perf-proc-name) {
		font-size: 12px;
		color: #cdd6f4;
	}
	:global(.perf-proc-name.vital) {
		color: #a6e3a1;
	}
	:global(.perf-proc-name.vital::before) {
		content: '\u25CF ';
		font-size: 8px;
	}
	:global(.perf-proc-stats) {
		display: flex;
		gap: 12px;
		font-size: 10px;
		color: #6c7086;
		margin-top: 2px;
		font-family: 'JetBrains Mono', monospace;
	}
	:global(.perf-kill-btn) {
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
		padding: 0 12px;
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
		line-height: 1.55;       /* Bumped from 1.4 — easier line tracking */
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
		margin: 14px 0 16px 0;  /* More breathing room between turns */
		padding: 4px 0 4px 12px;
		border-left: 3px solid #313244;
	}
	.term-container :global(.turn + .turn) {
		border-top: 1px solid rgba(69, 71, 90, 0.4);
		padding-top: 10px;
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
	.term-container :global(.turn-time) { color: #45475a; font-size: 10px; opacity: 0.7; }
	.term-container :global(.turn-model) {
		color: #9080b0;
		font-size: 9px;
		background: rgba(30, 30, 46, 0.6);
		border: 1px solid #2a2a3a;
		border-radius: 3px;
		padding: 0 5px;
		font-family: ui-monospace, monospace;
		opacity: 0.6;
	}
	.term-container :global(.turn-collapsed[open]) { opacity: 1; }
	.term-container :global(.turn-collapsed:not([open]) .t-line) { display: none; }
	.term-container :global(.t-pending-echo) {
		opacity: 0.75;  /* dim until the transcript confirms it landed */
	}

	:global(.term-empty) {
		position: absolute;
		inset: 0;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		color: #45475a;
		z-index: 2;
	}
	:global(.term-empty-icon) {
		font-size: 48px;
		margin-bottom: 16px;
	}
	:global(.term-empty-title) {
		font-size: 16px;
		margin-bottom: 8px;
	}
	:global(.term-empty-sub) {
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
		scrollbar-width: thin;
		scrollbar-color: rgba(166,227,161,0.3) transparent;
	}
	.right-content::-webkit-scrollbar { width: 6px; }
	.right-content::-webkit-scrollbar-track { background: transparent; }
	.right-content::-webkit-scrollbar-thumb { background: rgba(166,227,161,0.3); border-radius: 3px; }
	.right-content::-webkit-scrollbar-thumb:hover { background: rgba(166,227,161,0.5); }

	/* ==================== Services ==================== */
	:global(.svc-category) {
		font-size: 11px;
		font-weight: 600;
		color: #6c7086;
		text-transform: uppercase;
		letter-spacing: 0.5px;
		padding: 8px 0 4px;
	}
	.svc-category:first-child { padding-top: 0; }
	:global(.svc-row) {
		display: flex;
		align-items: flex-start;
		gap: 8px;
		padding: 6px 0;
	}
	.svc-row.clickable { cursor: pointer; border-radius: 4px; padding: 6px 4px; margin: 0 -4px; }
	.svc-row.clickable:hover { background: rgba(137,180,250,0.08); }
	.svc-row.selected { background: rgba(137,180,250,0.12); }
	.svc-action-btn { margin-left: auto; background: none; border: none; cursor: pointer; padding: 2px 6px; font-size: 12px; border-radius: 4px; color: rgba(205,214,244,0.4); transition: color 0.15s, background 0.15s; }
	.svc-action-btn:hover { background: rgba(205,214,244,0.08); color: rgba(205,214,244,0.8); }
	.svc-action-btn.danger:hover { background: rgba(243,139,168,0.15); color: #f38ba8; }
	:global(.team-dot-widget) {
		width: 10px;
		height: 10px;
		border-radius: 50%;
		margin-top: 3px;
		flex-shrink: 0;
	}
	:global(.svc-dot) {
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
	:global(.svc-name) {
		font-size: 13px;
		font-weight: 500;
		color: #cdd6f4;
	}
	:global(.svc-detail) {
		font-size: 11px;
		color: #6c7086;
	}
	:global(.svc-device-badge) {
		margin-left: 6px;
		font-size: 10px;
		font-weight: 400;
		color: #89b4fa;
		opacity: 0.7;
		letter-spacing: 0.02em;
	}

	/* ==================== Tasks ==================== */
	:global(.task-group-header) {
		font-size: 11px;
		font-weight: 600;
		color: #6c7086;
		padding: 6px 0 3px;
		border-bottom: 1px solid #1e1e2e;
		text-transform: uppercase;
		letter-spacing: 0.5px;
	}

	:global(.task-row) {
		display: flex;
		align-items: flex-start;
		gap: 6px;
		padding: 3px 0;
		cursor: pointer;
	}
	.task-row:hover { opacity: 0.8; }

	:global(.task-icon) {
		flex-shrink: 0;
		width: 14px;
		text-align: center;
		color: #6c7086;
	}
	.task-icon.done { color: #a6e3a1; }
	.task-icon.in-progress { color: #f9e2af; }
	.task-icon.bug { color: #f38ba8; }
	.task-icon.bug.done { color: #a6e3a1; }

	:global(.task-title) {
		flex: 1;
	}
	:global(.task-title.done) {
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
	:global(.test-run-btn) {
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
	:global(.test-row) {
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
	:global(.test-summary) {
		margin-top: 8px;
		padding: 6px 8px;
		border-radius: 4px;
		font-size: 11px;
		font-weight: 600;
		background: rgba(243, 139, 168, 0.1);
		color: #f38ba8;
	}
	:global(.test-summary.all-pass) {
		background: rgba(166, 227, 161, 0.1);
		color: #a6e3a1;
	}

	/* ==================== Approvals ==================== */
	:global(.approval-row) {
		padding: 8px 12px;
		border-bottom: 1px solid #1e1e2e;
	}
	:global(.approval-tool) {
		font-size: 12px;
		font-weight: 600;
		color: #cdd6f4;
		margin-bottom: 2px;
	}
	:global(.approval-desc) {
		font-size: 11px;
		color: #6c7086;
		margin-bottom: 6px;
		word-break: break-word;
	}
	:global(.approval-actions) {
		display: flex;
		gap: 6px;
	}
	:global(.approval-btn) {
		padding: 3px 10px;
		border: none;
		border-radius: 4px;
		font-size: 11px;
		cursor: pointer;
	}
	:global(.approval-btn.approve) {
		background: #a6e3a1;
		color: #1e1e2e;
	}
	:global(.approval-btn.deny) {
		background: #f38ba8;
		color: #1e1e2e;
	}
	:global(.approval-btn:hover) {
		opacity: 0.8;
	}

	/* ==================== Setup Guide ==================== */
	:global(.setup-guide) {
		padding: 4px;
		font-size: 13px;
		color: #6c7086;
		line-height: 1.6;
	}
	:global(.setup-title) {
		font-weight: 700;
		font-size: 14px;
		color: #cdd6f4;
		margin-bottom: 10px;
	}
	.setup-desc { margin-bottom: 10px; }
	:global(.setup-items) {
		display: grid;
		gap: 8px;
	}
	.setup-items strong { color: #cdd6f4; }
	:global(.setup-controls) {
		margin-top: 14px;
		padding-top: 12px;
		border-top: 1px solid #1e1e2e;
	}
	:global(.setup-controls-title) {
		font-weight: 600;
		font-size: 12px;
		color: #cdd6f4;
		margin-bottom: 6px;
	}
	.setup-controls strong { color: #cdd6f4; }
	.setup-controls span { color: #6c7086; }
	:global(.setup-hint) {
		margin-top: 10px;
		font-size: 12px;
		color: #6c7086;
	}

	/* ==================== Empty States ==================== */
	:global(.empty-state) {
		color: #45475a;
		padding: 12px;
		text-align: center;
	}
	:global(.empty-state.small) {
		padding: 0 12px;
		font-size: 11px;
	}

	/* ==================== Atlas ==================== */
	:global(.atlas-container) {
		flex: 1;
		min-height: 0;
		position: relative;
		overflow: hidden;
		background: #0e0e16;
		user-select: none;
	}
	:global(.atlas-toolbar) {
		position: absolute;
		top: 8px;
		left: 8px;
		z-index: 10;
		display: flex;
		gap: 6px;
		align-items: center;
	}
	:global(.atlas-btn) {
		background: #1e1e2e;
		border: 1px solid #313244;
		color: #cdd6f4;
		padding: 4px 10px;
		border-radius: 4px;
		cursor: pointer;
		font-size: 12px;
	}
	.atlas-btn:hover { background: #313244; }
	:global(.atlas-zoom) {
		color: #6c7086;
		font-size: 11px;
		margin-left: 4px;
	}
	.atlas-live { color: #a6e3a1; font-size: 10px; margin-left: auto; animation: atlasPulse 2s infinite; }
	@keyframes atlasPulse { 0%,100% { opacity: 1; } 50% { opacity: 0.3; } }
	:global(.atlas-stat) {
		color: #585b70;
		font-size: 10px;
		margin-left: 8px;
		background: #1e1e2e;
		padding: 2px 6px;
		border-radius: 3px;
	}
	:global(.atlas-svg) {
		width: 100%;
		height: 100%;
	}
	:global(.atlas-detail) {
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
	:global(.atlas-detail-header) {
		display: flex;
		align-items: center;
		gap: 8px;
		margin-bottom: 8px;
		padding-bottom: 8px;
		border-bottom: 1px solid #313244;
	}
	:global(.atlas-detail-header strong) {
		color: #cdd6f4;
		font-size: 14px;
	}
	:global(.atlas-detail-dot) {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		display: inline-block;
	}
	:global(.atlas-detail-type) {
		font-size: 10px;
		text-transform: uppercase;
		letter-spacing: 0.5px;
	}
	:global(.atlas-detail-close) {
		margin-left: auto;
		background: none;
		border: none;
		color: #6c7086;
		cursor: pointer;
		font-size: 16px;
	}
	.atlas-detail-close:hover { color: #cdd6f4; }
	:global(.atlas-nav-btn) {
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
	:global(.atlas-detail-body) {
		font-size: 11px;
		color: #a6adc8;
		line-height: 1.5;
	}
	:global(.atlas-detail-status) {
		display: flex;
		align-items: center;
		gap: 6px;
		font-weight: 600;
		margin-bottom: 4px;
	}
	:global(.atlas-detail-status-dot) {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		display: inline-block;
	}
	:global(.atlas-detail-info) {
		color: #89b4fa;
		font-size: 11px;
		margin-bottom: 6px;
	}
	:global(.atlas-detail-desc) {
		color: #bac2de;
		font-size: 11px;
		line-height: 1.6;
		margin-bottom: 8px;
	}
	:global(.atlas-detail-section-title) {
		font-size: 10px;
		text-transform: uppercase;
		letter-spacing: 0.5px;
		color: #6c7086;
		margin: 8px 0 4px;
		font-weight: 600;
	}
	:global(.atlas-detail-connections) {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
	:global(.atlas-detail-conn) {
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
	:global(.atlas-detail-conn:hover) {
		border-color: #45475a;
		background: #1e1e2e;
		color: #cdd6f4;
	}
	:global(.atlas-detail-conn-dot) {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		display: inline-block;
		flex-shrink: 0;
	}
	:global(.atlas-detail-conn-name) {
		flex: 1;
	}
	:global(.atlas-detail-conn-label) {
		color: #585b70;
		font-size: 10px;
		font-style: italic;
	}
	:global(.atlas-detail-conn-dir) {
		color: #585b70;
		font-size: 12px;
	}
	:global(.atlas-detail-file) {
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
	:global(.apps-drilldown) {
		padding: 0;
	}
	:global(.apps-back-btn) {
		display: flex;
		align-items: center;
		gap: 6px;
		width: 100%;
		padding: 8px 12px;
		border: none;
		border-bottom: 1px solid #313244;
		background: transparent;
		color: #89b4fa;
		cursor: pointer;
		font-size: 12px;
		text-align: left;
	}
	.apps-back-btn:hover { background: rgba(137, 180, 250, 0.08); }
	:global(.apps-cat-label) {
		font-size: 11px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: #6c7086;
		padding: 8px 12px 2px;
	}
	:global(.apps-wrap-msg) {
		grid-column: 1 / -1;
		font-size: 11px;
		color: #a6e3a1;
		padding: 4px 8px;
	}
	.instances-panel { padding: 8px; }
	:global(.instance-row) {
		display: flex; align-items: center; gap: 8px;
		padding: 8px; border-radius: 6px; margin-bottom: 4px;
		background: #1e1e2e;
	}
	:global(.instance-btn) {
		margin-left: auto; padding: 4px 12px; border-radius: 4px;
		background: #313244; color: #cdd6f4; border: 1px solid #45475a;
		cursor: pointer; font-size: 12px;
	}
	.instance-btn:hover { background: #45475a; }
	.instance-btn.restart { background: #45475a; margin-left: 4px; }
	.instance-btn.restart:hover { background: #585b70; }
	:global(.instance-note) {
		padding: 8px; margin-top: 8px; font-size: 11px;
		color: #a6adc8; background: #181825; border-radius: 6px;
	}

	/* ==================== Intuition (wrapper only — body moved to IntuitionPanel.svelte) ==================== */
	.intuition-panel { padding: 8px; }
	.svc-healthy { color: #a6e3a1; }
	.svc-down { color: #f38ba8; }

	/* ==================== Benchmarks ==================== */
	.benchmarks-panel { padding: 8px; }
	/* Summary header */
	:global(.bench-summary) {
		display: flex; justify-content: space-between; align-items: center;
		background: rgba(255,255,255,0.04);
		border: 1px solid #313244;
		border-radius: 6px;
		padding: 8px 12px;
		margin-bottom: 10px;
	}
	.bench-summary-score { display: flex; align-items: baseline; gap: 6px; }
	.bench-summary-num { font-size: 22px; font-weight: 700; color: #f38ba8; }
	.bench-summary-num.all-pass { color: #a6e3a1; }
	.bench-summary-label { font-size: 11px; color: #6c7086; }
	/* Suite cards */
	:global(.bench-suite) {
		background: rgba(255,255,255,0.04);
		border: 1px solid #313244;
		border-radius: 6px;
		padding: 7px 10px;
		margin-bottom: 8px;
	}
	.bench-suite.bench-not-run { opacity: 0.6; }
	:global(.bench-suite-header) {
		display: flex; justify-content: space-between; align-items: center;
		margin-bottom: 4px;
	}
	.bench-suite-name { font-size: 11px; font-weight: 700; color: #a6adc8; letter-spacing: 0.05em; }
	.bench-suite-right { display: flex; align-items: center; gap: 6px; }
	.bench-suite-status { font-size: 13px; font-weight: 700; }
	.bench-suite-status.pass { color: #a6e3a1; }
	.bench-suite-status.fail { color: #f38ba8; }
	.bench-suite-status.bench-unrun { color: #45475a; }
	:global(.bench-mini-run) {
		background: rgba(137,180,250,0.12);
		border: 1px solid rgba(137,180,250,0.3);
		border-radius: 4px;
		color: #89b4fa;
		padding: 1px 6px;
		font-size: 10px;
		cursor: pointer;
		line-height: 16px;
	}
	.bench-mini-run:disabled { opacity: 0.4; cursor: not-allowed; }
	.bench-mini-run:not(:disabled):hover { background: rgba(137,180,250,0.22); }
	/* Score row */
	:global(.bench-row) {
		display: flex; align-items: center; gap: 6px;
		padding: 2px 0; font-size: 11px;
	}
	.bench-composite-row { margin-bottom: 4px; }
	.bench-label { color: #6c7086; min-width: 40px; flex-shrink: 0; }
	.bench-bar-wrap { flex: 1; height: 5px; background: #1e1e2e; border-radius: 3px; overflow: hidden; }
	.bench-bar { height: 100%; border-radius: 3px; transition: width 0.4s ease; }
	.bench-bar.green { background: #a6e3a1; }
	.bench-bar.yellow { background: #f9e2af; }
	.bench-bar.red { background: #f38ba8; }
	.bench-val { color: #cdd6f4; min-width: 32px; text-align: right; flex-shrink: 0; font-size: 12px; font-weight: 600; }
	.bench-val.pass { color: #a6e3a1; }
	.bench-val.warn { color: #f9e2af; }
	.bench-val.fail { color: #f38ba8; }
	/* Metric chips */
	.bench-metrics { display: flex; flex-wrap: wrap; gap: 3px; margin-bottom: 3px; }
	:global(.bench-chip) {
		font-size: 10px; padding: 1px 5px; border-radius: 3px;
		background: rgba(255,255,255,0.06); color: #6c7086;
		border: 1px solid #313244;
	}
	.bench-chip.chip-ok { color: #a6e3a1; border-color: rgba(166,227,161,0.25); background: rgba(166,227,161,0.08); }
	.bench-chip.chip-warn { color: #f9e2af; border-color: rgba(249,226,175,0.25); background: rgba(249,226,175,0.08); }
	.bench-chip.chip-fail { color: #f38ba8; border-color: rgba(243,139,168,0.25); background: rgba(243,139,168,0.08); }
	.bench-not-run-label { font-size: 10px; color: #45475a; padding: 2px 0; }
	.bench-ran-at { font-size: 10px; color: #45475a; text-align: right; margin-top: 2px; }
	/* Run buttons */
	:global(.bench-run-btn) {
		background: rgba(137,180,250,0.15);
		border: 1px solid rgba(137,180,250,0.4);
		border-radius: 5px;
		color: #89b4fa;
		padding: 4px 12px;
		font-size: 12px;
		cursor: pointer;
	}
	.bench-run-btn.bench-run-all { padding: 5px 14px; font-size: 12px; }
	.bench-run-btn:disabled { opacity: 0.5; cursor: not-allowed; }
	.bench-run-btn:not(:disabled):hover { background: rgba(137,180,250,0.25); }
	/* AutoDev report section */
	:global(.bench-autodev-report) {
		background: rgba(249,226,175,0.06);
		border: 1px solid rgba(249,226,175,0.2);
		border-radius: 6px;
		padding: 8px 10px;
		margin-bottom: 10px;
	}
	.bench-report-title { font-size: 10px; font-weight: 700; color: #f9e2af; letter-spacing: 0.05em; margin-bottom: 6px; }
	:global(.bench-rec) {
		display: flex; align-items: flex-start; gap: 6px;
		padding: 3px 0; font-size: 10px;
	}
	:global(.bench-rec-badge) {
		font-size: 9px; font-weight: 700; padding: 1px 4px; border-radius: 3px;
		flex-shrink: 0; margin-top: 1px;
	}
	.bench-rec-badge.fix { background: rgba(166,227,161,0.2); color: #a6e3a1; border: 1px solid rgba(166,227,161,0.3); }
	.bench-rec-badge.research { background: rgba(137,180,250,0.15); color: #89b4fa; border: 1px solid rgba(137,180,250,0.3); }
	.bench-rec-text { color: #cdd6f4; flex: 1; line-height: 1.4; }
	.bench-rec-score { color: #45475a; flex-shrink: 0; font-size: 9px; margin-top: 1px; }
	:global(.bench-scout-topics) {
		margin-top: 6px; padding-top: 5px;
		border-top: 1px solid rgba(249,226,175,0.15);
		font-size: 10px; color: #6c7086; font-style: italic;
	}
	.bench-scout-more { color: #89b4fa; }

	/* ==================== Beta Pipeline ==================== */
	.pipeline-panel { padding: 8px; display: flex; flex-direction: column; gap: 6px; }
	:global(.pl-header) {
		display: flex; align-items: center; gap: 6px;
		padding: 8px; background: rgba(137,180,250,0.06);
		border: 1px solid rgba(137,180,250,0.12); border-radius: 6px;
	}
	.pl-status-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
	.pl-status-label { font-size: 12px; font-weight: 700; color: #cdd6f4; }
	.pl-source { font-size: 10px; color: #6c7086; }
	.pl-spacer { flex: 1; }
	.pl-error { font-size: 11px; color: #f38ba8; padding: 4px 8px; background: rgba(243,139,168,0.08); border-radius: 4px; }
	.pl-slot-label { font-size: 10px; font-weight: 700; color: #6c7086; text-transform: uppercase; letter-spacing: 0.8px; padding: 4px 0 2px; }
	:global(.pl-slot) {
		display: flex; align-items: center; gap: 6px;
		padding: 6px 8px; background: rgba(30,30,46,0.8);
		border: 1px solid rgba(69,71,90,0.4); border-radius: 4px;
		font-size: 12px;
	}
	.pl-slot.active { border-color: rgba(249,144,0,0.3); background: rgba(249,144,0,0.05); }
	.pl-slot-prod { border-color: rgba(94,205,107,0.3); background: rgba(94,205,107,0.05); }
	.pl-slot-id { font-family: monospace; color: #cdd6f4; font-weight: 600; }
	.pl-slot-port { font-family: monospace; color: #6c7086; font-size: 11px; }
	.pl-slot-health { font-size: 10px; color: #45475a; }
	.pl-slot-health.healthy { color: #a6e3a1; }
	.pl-slot-uptime { font-size: 10px; color: #6c7086; margin-left: auto; }
	.pl-slot-none { color: #45475a; font-size: 12px; }
	.pl-bench-title { font-size: 10px; font-weight: 700; color: #6c7086; text-transform: uppercase; letter-spacing: 0.8px; padding: 6px 0 2px; }
	:global(.pl-bench-row) {
		display: flex; align-items: center; gap: 6px;
		padding: 3px 8px; border-radius: 3px; font-size: 11px;
	}
	.pl-bench-row.pl-pass { background: rgba(94,205,107,0.07); }
	.pl-bench-row.pl-fail { background: rgba(243,139,168,0.07); }
	.pl-bench-suite { flex: 1; color: #a6adc8; font-family: monospace; }
	.pl-bench-result { font-size: 11px; font-weight: 700; }
	.pl-bench-row.pl-pass .pl-bench-result { color: #a6e3a1; }
	.pl-bench-row.pl-fail .pl-bench-result { color: #f38ba8; }
	.pl-bench-score { font-size: 10px; color: #6c7086; }
	.pl-elapsed { font-size: 10px; color: #45475a; text-align: right; margin-top: 4px; }
	/* Pipeline buttons */
	:global(.pl-btn) {
		padding: 4px 10px; border-radius: 4px; border: none; cursor: pointer;
		font-size: 11px; font-weight: 600; transition: opacity 0.15s;
	}
	.pl-btn:disabled { opacity: 0.5; cursor: default; }
	.pl-btn-run { background: #89b4fa; color: #1e1e2e; }
	.pl-btn-run:hover:not(:disabled) { opacity: 0.85; }
	.pl-btn-abort { background: rgba(243,139,168,0.15); color: #f38ba8; border: 1px solid rgba(243,139,168,0.3); }
	.pl-btn-abort:hover { background: rgba(243,139,168,0.25); }
	.pl-btn-promote { background: rgba(94,205,107,0.15); color: #a6e3a1; border: 1px solid rgba(94,205,107,0.3); font-size: 10px; padding: 3px 7px; margin-left: auto; }
	.pl-btn-promote:hover { background: rgba(94,205,107,0.25); }

	/* ==================== Lifeboat ==================== */
	:global(.lifeboat-panel) {
		padding: 8px;
	}
	:global(.lifeboat-countdown) {
		font-size: 12px;
		color: #fab387;
		font-weight: 600;
		padding: 6px 0 2px;
	}
	:global(.lifeboat-actions) {
		display: flex;
		gap: 6px;
		padding: 6px 0;
	}
	:global(.lifeboat-btn) {
		padding: 5px 14px;
		border-radius: 4px;
		border: 1px solid #45475a;
		cursor: pointer;
		font-size: 12px;
		font-weight: 500;
		color: #cdd6f4;
		background: #313244;
	}
	.lifeboat-btn:hover { background: #45475a; }
	.lifeboat-btn:disabled { opacity: 0.5; cursor: not-allowed; }
	:global(.lifeboat-btn.rollback) {
		background: #45475a;
		border-color: #f38ba8;
		color: #f38ba8;
	}
	.lifeboat-btn.rollback:hover { background: #585b70; }
	:global(.lifeboat-btn.confirm) {
		background: #313244;
		border-color: #a6e3a1;
		color: #a6e3a1;
	}
	.lifeboat-btn.confirm:hover { background: #45475a; }
	:global(.lifeboat-btn.swap) {
		background: #313244;
		border-color: #89b4fa;
		color: #89b4fa;
	}
	.lifeboat-btn.swap:hover { background: #45475a; }

	:global(.apps-grid) {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 8px;
		padding: 8px;
	}
	:global(.app-card) {
		background: #1e1e2e;
		border: 1px solid #313244;
		border-radius: 8px;
		padding: 12px 8px;
		text-align: center;
		cursor: pointer;
		transition: all 0.15s;
	}
	:global(.app-card:hover) {
		border-color: #89b4fa;
		background: #181825;
	}
	:global(.app-icon) {
		font-size: 24px;
		margin-bottom: 4px;
	}
	:global(.app-name) {
		color: #cdd6f4;
		font-size: 12px;
		font-weight: 600;
	}
	:global(.app-desc) {
		color: #6c7086;
		font-size: 10px;
		margin-top: 2px;
	}

	/* ==================== Alerts ==================== */
	:global(.alert-indicator) {
		min-width: 20px; height: 20px;
		border-radius: 10px;
		background: #f38ba8;
		color: #11111b;
		font-size: 11px; font-weight: 700;
		border: none; cursor: pointer;
		display: flex; align-items: center; justify-content: center;
		padding: 0 5px;
		flex-shrink: 0;
		transition: transform 0.15s ease;
	}
	.alert-indicator:hover { transform: scale(1.15); }
	:global(.alert-indicator.flash) {
		animation: alert-pulse 0.6s ease-in-out 3;
	}
	@keyframes alert-pulse {
		0%, 100% { background: #f38ba8; transform: scale(1); }
		50% { background: #fab387; transform: scale(1.25); }
	}

	.alerts-panel { display: flex; flex-direction: column; gap: 8px; }
	.alerts-filters { display: flex; gap: 4px; margin-bottom: 4px; }
	:global(.alert-filter-select) {
		flex: 1;
		background: #0a0a0f; color: #cdd6f4;
		border: 1px solid #1e1e2e; border-radius: 4px;
		padding: 3px 4px; font-size: 11px; outline: none;
	}
	.alert-filter-select:focus { border-color: #89b4fa; }

	:global(.alert-card) {
		background: #1a1a2e; border-radius: 6px;
		padding: 8px; border-left: 3px solid #6c7086;
	}
	.alert-card.critical { border-left-color: #f38ba8; }
	.alert-card.warning { border-left-color: #fab387; }
	.alert-card.info { border-left-color: #89b4fa; }

	.alert-header { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; }
	:global(.alert-severity-dot) {
		width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0;
	}
	.alert-severity-dot.critical { background: #f38ba8; }
	.alert-severity-dot.warning { background: #fab387; }
	.alert-severity-dot.info { background: #89b4fa; }

	:global(.alert-type-badge) {
		font-size: 10px; font-weight: 600; text-transform: uppercase;
		color: #a6adc8; letter-spacing: 0.5px;
	}
	.alert-time { font-size: 10px; color: #585b70; margin-left: auto; }

	.alert-title { font-size: 12px; color: #cdd6f4; font-weight: 500; margin-bottom: 4px; }

	.alert-detail { font-size: 11px; color: #a6adc8; margin-bottom: 4px; }
	.alert-detail-line { margin-bottom: 2px; }
	.alert-hint { color: #89b4fa; font-style: italic; margin-top: 2px; }
	.alert-resolution { font-size: 11px; color: #a6e3a1; margin-bottom: 4px; }

	.alert-stack summary { font-size: 10px; color: #6c7086; cursor: pointer; }
	:global(.alert-stack pre) {
		font-size: 10px; color: #6c7086; white-space: pre-wrap;
		max-height: 120px; overflow-y: auto; margin: 4px 0 0 0;
	}

	.alert-actions { display: flex; gap: 4px; margin-bottom: 4px; }
	:global(.alert-btn) {
		padding: 3px 8px; border-radius: 4px; border: none;
		font-size: 10px; font-weight: 600; cursor: pointer;
	}
	.alert-btn.ack { background: #313244; color: #cdd6f4; }
	.alert-btn.ack:hover { background: #45475a; }
	.alert-btn.resolve { background: #1e4620; color: #a6e3a1; }
	.alert-btn.resolve:hover { background: #2a6030; }
	.alert-btn.dismiss { background: #302020; color: #6c7086; }
	.alert-btn.dismiss:hover { background: #453030; }
	.alert-btn.reopen { background: #302820; color: #fab387; }
	.alert-btn.reopen:hover { background: #453820; }

	.alert-meta { font-size: 10px; color: #585b70; }

	/* ─── Contacts Panel ─── */
	.contacts-panel { padding: 0; }
	.contacts-toolbar { display: flex; gap: 4px; padding: 6px 8px; border-bottom: 1px solid #313244; }
	:global(.contacts-search) {
		flex: 1; background: #181825; border: 1px solid #313244; border-radius: 4px;
		color: #cdd6f4; padding: 4px 8px; font-size: 12px; outline: none;
	}
	.contacts-search:focus { border-color: #585b70; }
	:global(.contacts-add-btn) {
		background: #313244; border: none; color: #a6e3a1; font-size: 16px; width: 28px;
		border-radius: 4px; cursor: pointer; font-weight: bold;
	}
	.contacts-add-btn:hover { background: #45475a; }

	.contact-add-form { padding: 8px; border-bottom: 1px solid #313244; display: flex; flex-direction: column; gap: 4px; }
	:global(.contact-input) {
		background: #181825; border: 1px solid #313244; border-radius: 4px;
		color: #cdd6f4; padding: 5px 8px; font-size: 12px; outline: none;
	}
	.contact-input:focus { border-color: #585b70; }
	.contact-add-actions { display: flex; gap: 4px; margin-top: 2px; }
	.contact-btn-save { background: #1e4620; color: #a6e3a1; border: none; padding: 4px 12px; border-radius: 4px; cursor: pointer; font-size: 12px; }
	.contact-btn-save:hover { background: #2a6030; }
	.contact-btn-cancel { background: #313244; color: #6c7086; border: none; padding: 4px 12px; border-radius: 4px; cursor: pointer; font-size: 12px; }
	.contact-btn-cancel:hover { background: #45475a; }

	.contact-row { cursor: pointer; padding: 6px 8px !important; transition: background 0.15s; }
	.contact-row:hover { background: #313244; }
	:global(.contact-avatar) {
		width: 32px; height: 32px; border-radius: 50%; display: flex; align-items: center;
		justify-content: center; font-size: 14px; font-weight: bold; color: #cdd6f4; flex-shrink: 0;
	}
	:global(.contact-badge) {
		background: #f38ba8; color: #1e1e2e; font-size: 10px; padding: 1px 5px;
		border-radius: 8px; margin-left: 6px; font-weight: bold;
	}
	.contact-status { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: #585b70; margin-right: 4px; }
	.contact-status.online { background: #a6e3a1; }
	.contact-status.away { background: #f9e2af; }
	:global(.contact-action-btn) {
		background: none; border: none; color: #585b70; cursor: pointer; font-size: 14px; padding: 2px 4px;
	}
	.contact-action-btn:hover { color: #f9e2af; }

	/* ── Π contact special styling ── */
	.pan-contact-row { border-bottom: 1px solid #313244; margin-bottom: 4px; }
	.pan-avatar { background: linear-gradient(135deg, #cba6f7, #89b4fa) !important; color: #1e1e2e !important; font-weight: 900; font-size: 15px; }

	/* ── DM Thread View ── */
	.dm-thread { display: flex; flex-direction: column; height: 100%; }
	.dm-header { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-bottom: 1px solid #313244; background: #181825; flex-shrink: 0; }
	.dm-back { background: none; border: none; color: #a6adc8; font-size: 16px; cursor: pointer; padding: 2px 6px; }
	.dm-back:hover { color: #cdd6f4; }
	.dm-contact-avatar { width: 28px; height: 28px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 13px; font-weight: bold; color: #cdd6f4; background: #585b70; flex-shrink: 0; }
	.dm-contact-name { font-weight: 600; font-size: 13px; color: #cdd6f4; }
	.dm-messages { flex: 1; overflow-y: auto; padding: 10px 8px; display: flex; flex-direction: column; gap: 6px; }
	.dm-empty { color: #585b70; font-size: 12px; padding: 20px 8px; }
	.dm-msg-wrap { display: flex; flex-direction: column; }
	.dm-msg-self { align-items: flex-end; }
	.dm-service-tag { font-size: 10px; color: #89b4fa; margin-bottom: 2px; padding-left: 4px; }
	.dm-bubble { max-width: 88%; padding: 7px 10px; border-radius: 10px; background: #313244; color: #cdd6f4; font-size: 12px; line-height: 1.4; border-bottom-left-radius: 3px; white-space: pre-wrap; word-break: break-word; }
	.dm-bubble-self { background: #45475a; border-bottom-left-radius: 10px; border-bottom-right-radius: 3px; }
	.dm-bubble-pan { background: #1e1e2e; border: 1px solid #45475a; }
	.dm-subject { font-weight: 600; font-size: 12px; color: #cba6f7; margin-bottom: 4px; }
	.dm-body { font-size: 12px; }
	.dm-time { font-size: 10px; color: #585b70; margin-top: 3px; text-align: right; }
	.dm-input-bar { display: flex; gap: 6px; padding: 8px; border-top: 1px solid #313244; background: #181825; flex-shrink: 0; }
	.dm-input { flex: 1; background: #313244; border: 1px solid #45475a; color: #cdd6f4; border-radius: 16px; padding: 6px 12px; font-size: 12px; outline: none; }
	.dm-input:focus { border-color: #cba6f7; }
	.dm-send { background: #cba6f7; color: #1e1e2e; border: none; border-radius: 50%; width: 30px; height: 30px; font-size: 14px; cursor: pointer; font-weight: bold; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
	.dm-send:disabled { background: #45475a; color: #585b70; cursor: default; }

	/* ─── Messages Panel (Center) ─── */
	.messages-panel {
		display: flex; flex-direction: column; height: 100%; background: #1e1e2e;
	}
	.msg-header {
		display: flex; align-items: center; gap: 8px; padding: 8px 12px;
		border-bottom: 1px solid #313244; background: #181825; flex-shrink: 0;
	}
	.msg-back-btn { background: none; border: none; color: #cdd6f4; font-size: 18px; cursor: pointer; padding: 2px 6px; }
	.msg-back-btn:hover { color: #f5c2e7; }
	.msg-header-info { flex: 1; }
	.msg-header-name { font-weight: 600; color: #cdd6f4; font-size: 14px; }
	.msg-header-status { font-size: 11px; color: #585b70; margin-left: 8px; }
	.msg-header-status.online { color: #a6e3a1; }
	.msg-header-actions { display: flex; gap: 4px; }
	.msg-call-btn {
		background: #313244; border: none; color: #cdd6f4; padding: 6px 8px;
		border-radius: 6px; cursor: pointer; display: flex; align-items: center;
	}
	.msg-call-btn:hover { background: #45475a; color: #a6e3a1; }

	.msg-messages {
		flex: 1; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 6px;
	}
	.msg-empty { color: #585b70; text-align: center; padding: 40px 20px; font-size: 13px; }
	.msg-system { text-align: center; color: #585b70; font-size: 11px; padding: 4px 0; }

	.msg-bubble {
		max-width: 75%; padding: 8px 12px; border-radius: 12px; word-wrap: break-word;
	}
	.msg-self {
		align-self: flex-end; background: #45475a; color: #cdd6f4;
		border-bottom-right-radius: 4px;
	}
	.msg-other {
		align-self: flex-start; background: #313244; color: #cdd6f4;
		border-bottom-left-radius: 4px;
	}
	.msg-text { font-size: 13px; line-height: 1.4; }
	.msg-time { font-size: 10px; color: #585b70; margin-top: 2px; text-align: right; }

	.msg-input-bar {
		display: flex; gap: 6px; padding: 8px 12px; border-top: 1px solid #313244;
		background: #181825; flex-shrink: 0;
	}
	.msg-input {
		flex: 1; background: #313244; border: 1px solid #45475a; border-radius: 8px;
		color: #cdd6f4; padding: 8px 12px; font-size: 13px; outline: none;
	}
	.msg-input:focus { border-color: #585b70; }
	.msg-send-btn {
		background: #585b70; border: none; color: #cdd6f4; padding: 8px 12px;
		border-radius: 8px; cursor: pointer; display: flex; align-items: center;
	}
	.msg-send-btn:hover:not(:disabled) { background: #a6e3a1; color: #1e1e2e; }
	.msg-send-btn:disabled { opacity: 0.3; cursor: default; }

	/* Thread list */
	.msg-thread-list { padding: 0; overflow-y: auto; }
	.msg-thread-row {
		display: flex; align-items: center; gap: 10px; padding: 10px 12px;
		cursor: pointer; transition: background 0.15s; border-bottom: 1px solid #1e1e2e;
	}
	.msg-thread-row:hover { background: #313244; }
	.msg-thread-info { flex: 1; min-width: 0; }
	.msg-thread-name { font-size: 13px; font-weight: 500; color: #cdd6f4; display: flex; align-items: center; gap: 4px; }
	.msg-thread-preview { font-size: 11px; color: #585b70; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
	.msg-thread-time { font-size: 10px; color: #585b70; flex-shrink: 0; }

	/* ─── Call Overlay ─── */
	.call-overlay {
		position: fixed; top: 0; left: 0; right: 0; bottom: 0;
		background: rgba(0,0,0,0.85); z-index: 9999;
		display: flex; align-items: center; justify-content: center;
	}
	.call-card {
		text-align: center; padding: 40px 60px; background: #1e1e2e;
		border-radius: 16px; border: 1px solid #313244;
	}
	.call-avatar {
		width: 80px; height: 80px; border-radius: 50%; background: #585b70;
		display: flex; align-items: center; justify-content: center;
		font-size: 32px; font-weight: bold; color: #cdd6f4; margin: 0 auto 16px;
	}
	.call-name { font-size: 20px; font-weight: 600; color: #cdd6f4; margin-bottom: 8px; }
	.call-status { font-size: 14px; color: #585b70; margin-bottom: 24px; }
	.call-actions { display: flex; justify-content: center; }
	.call-end-btn {
		width: 56px; height: 56px; border-radius: 50%; background: #f38ba8;
		border: none; cursor: pointer; display: flex; align-items: center; justify-content: center;
		transition: transform 0.15s;
	}
	.call-end-btn:hover { transform: scale(1.1); background: #e06080; }

	/* ─── Mail Panel ─── */
	.mail-panel { display: flex; flex-direction: column; height: 100%; }
	.mail-list { flex: 1; overflow-y: auto; }
	:global(.mail-row) {
		padding: 8px 12px; cursor: pointer; border-bottom: 1px solid #1e1e2e;
		transition: background 0.15s;
	}
	.mail-row:hover { background: #313244; }
	.mail-row.unread { border-left: 3px solid #89b4fa; }
	:global(.mail-from) {
		font-size: 13px; font-weight: 500; color: #cdd6f4;
		white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
	}
	.mail-row.unread .mail-from { font-weight: 700; }
	:global(.mail-subject) {
		font-size: 12px; color: #a6adc8;
		white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
	}
	:global(.mail-preview) {
		font-size: 11px; color: #585b70;
		white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
	}
	:global(.mail-date) {
		font-size: 10px; color: #585b70; margin-top: 2px;
	}
	:global(.mail-pager) {
		display: flex; align-items: center; justify-content: center; gap: 8px;
		padding: 8px; border-top: 1px solid #313244;
	}

	/* ─── Expand button (open panel in Tauri window) ─── */
	.expand-btn {
		background: none; border: none; color: #585b70; cursor: pointer;
		font-size: 14px; padding: 2px 6px; margin-left: 4px;
	}
	.expand-btn:hover { color: #89b4fa; }

	/* ─── Mail row top line ─── */
	:global(.mail-row-top) {
		display: flex; align-items: center; gap: 6px;
	}
	:global(.mail-type-badge) {
		font-size: 11px; color: #585b70; flex-shrink: 0;
	}
	.mail-type-badge.pan { color: #a6e3a1; }
	.mail-type-badge.email { color: #89b4fa; }
</style>
