// Barrel re-export for the per-domain stores. Lets a widget do:
//
//     import { org, voice, devices } from '$lib/stores';
//
// instead of three separate imports. If a widget only needs one store,
// import directly from the specific file — it's still cheaper for the
// bundler.
//
// Domain stores live under this folder:
//   terminal.svelte.js   — tabs, ws lifecycle, claudeReady, layout selectors, #444 message-store helpers (the foundation store)
//   org.svelte.js        — org context + permissions matrix
//   voice.svelte.js      — voice settings + model lists
//   project.svelte.js    — active project + tasks + sections + milestone filter
//   devices.svelte.js    — all devices + pan-client list + live resource metrics
//   chat.svelte.js       — chat bubbles + DM thread + contacts
//   services.svelte.js   — system services list + carrier/lifeboat state

export { terminal, getActiveTab, getPushed, setPushed, pushEcho, getEchoes, setEchoes, pushBtw, getBtws, clearTabStore, setLeftSection, setRightSection, widgetVisible } from './terminal.svelte.js';
export { org, loadOrgContextWithRetry, reloadPermsMatrix, stopImpersonation, impersonationLabel } from './org.svelte.js';
export { voice, loadVoiceSettings, loadAvailableModels, loadLocalModels } from './voice.svelte.js';
export { project, cycleTask, filterByMilestone } from './project.svelte.js';
export { devices, loadAllDevices, startAllDevicesPolling, stopAllDevicesPolling, loadClientDevices, approveClient, denyClient } from './devices.svelte.js';
export { chat, restoreBubblesFromStorage, persistBubbles } from './chat.svelte.js';
export { services, loadServices, loadLifeboat } from './services.svelte.js';
