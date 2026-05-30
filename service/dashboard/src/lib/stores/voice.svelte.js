// voice.svelte.js — voice settings + model lists. Used by the model dropdown
// in the center input bar, by UsagePanel (provider switches between Claude
// and Gemini endpoints), and by BenchmarksPanel (default model for runs).
//
// `voiceSettings` is a flat key/value bag loaded from /api/v1/voice/settings.
// Notable keys we read elsewhere:
//   terminal_ai_provider  — 'claude' | 'gemini' (drives UsagePanel branching)
//   terminal_ai_model     — the per-session default model
//   ai_model              — legacy fallback
//
// availableModels / localModels populate the model dropdown options.

import { api } from '$lib/api.js';

export const voice = $state({
	/** @type {Record<string, any>} */
	settings: {},
	/** @type {Array<{id:string, name?:string}>} */
	availableModels: [],
	/** @type {Array<{id:string, name?:string}>} */
	localModels: [],
});

export async function loadVoiceSettings() {
	try {
		const data = await api('/api/v1/voice/settings');
		voice.settings = data || {};
	} catch {}
}

export async function loadAvailableModels() {
	try {
		const data = await api('/api/v1/ai/models');
		voice.availableModels = data?.models || [];
	} catch {}
}

export async function loadLocalModels() {
	try {
		const data = await api('/api/v1/ai/models/local');
		voice.localModels = data?.models || [];
	} catch {}
}
