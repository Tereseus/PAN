// Shared state across pages — survives tab switches within the SPA

/** @type {{ project: any | null, sidebarCollapsed: boolean, chatMessages: Map, chatInput: string, chatImages: Array, starredProjects: Set }} */
const state = $state({
	project: null,
	sidebarCollapsed: false,
	chatMessages: new Map(), // keyed by project id
	chatInput: '',
	chatImages: [], // pasted images survive tab switches
	starredProjects: new Set(JSON.parse(localStorage.getItem('pan_starred_projects') || '[]')),
});

export function getActiveProject() {
	return state.project;
}

export function setActiveProject(p) {
	state.project = p;
}

export function isSidebarCollapsed() {
	return state.sidebarCollapsed;
}

export function toggleSidebar() {
	state.sidebarCollapsed = !state.sidebarCollapsed;
}

export function setSidebarCollapsed(v) {
	state.sidebarCollapsed = v;
}

export function getChatMessages(projectId) {
	return state.chatMessages.get(projectId) || [];
}

export function setChatMessages(projectId, msgs) {
	state.chatMessages.set(projectId, msgs);
}

export function getChatInput() {
	return state.chatInput;
}

export function setChatInput(v) {
	state.chatInput = v;
}

export function getChatImages() {
	return state.chatImages;
}

export function setChatImages(imgs) {
	state.chatImages = imgs;
}

export function isStarred(projectId) {
	return state.starredProjects.has(projectId);
}

export function toggleStar(projectId) {
	if (state.starredProjects.has(projectId)) {
		state.starredProjects.delete(projectId);
	} else {
		state.starredProjects.add(projectId);
	}
	localStorage.setItem('pan_starred_projects', JSON.stringify([...state.starredProjects]));
}

// Get custom order from localStorage
function getCustomOrder() {
	try { return JSON.parse(localStorage.getItem('pan_project_order') || '[]'); } catch { return []; }
}

// Sort projects: custom order first, then starred, then alphabetical
export function sortProjects(projects) {
	const order = getCustomOrder();
	return [...projects].sort((a, b) => {
		const aIdx = order.indexOf(a.id);
		const bIdx = order.indexOf(b.id);
		// If both have custom order, use that
		if (aIdx !== -1 && bIdx !== -1) return aIdx - bIdx;
		// Custom-ordered items come first
		if (aIdx !== -1) return -1;
		if (bIdx !== -1) return 1;
		// Then starred
		const aStarred = state.starredProjects.has(a.id);
		const bStarred = state.starredProjects.has(b.id);
		if (aStarred && !bStarred) return -1;
		if (!aStarred && bStarred) return 1;
		return (a.name || '').localeCompare(b.name || '');
	});
}

export function saveProjectOrder(projectIds) {
	localStorage.setItem('pan_project_order', JSON.stringify(projectIds));
}

// Terminal input state (survives tab switches)
const terminalState = $state({ input: '' });

export function getTerminalInput() {
	return terminalState.input;
}

export function setTerminalInput(v) {
	terminalState.input = v;
}

// PAN deployment mode — populated by /health on boot. Used to hide
// user-session-only features (terminal tabs, AHK config, etc.) when the
// dashboard is connected to a server running in service/Session 0 mode.
const modeState = $state({ mode: 'unknown' });

export function getPanMode() {
	return modeState.mode;
}

export function setPanMode(m) {
	modeState.mode = m;
}

export function isUserMode() {
	return modeState.mode === 'user';
}

export function isServiceMode() {
	return modeState.mode === 'service';
}

// Fetch /health on first call and cache the mode. Idempotent.
let _modeFetched = false;
export async function fetchPanMode() {
	if (_modeFetched) return modeState.mode;
	_modeFetched = true;
	try {
		const r = await fetch('/health');
		if (r.ok) {
			const j = await r.json();
			if (j.mode) modeState.mode = j.mode;
		}
	} catch {}
	return modeState.mode;
}
