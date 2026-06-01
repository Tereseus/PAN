// usage.svelte.js — Claude / Gemini token + rate-limit usage shown in the
// right-column Usage widget. Polled every 30s while the widget is open.
//
// The widget's own `sessionCost` view is computed inside UsagePanel.svelte
// from the foundation store's per-tab message Map (the parent doesn't need
// to derive it).

import { api } from '$lib/api.js';
import { voice } from '$lib/stores/voice.svelte.js';
import { perf } from '$lib/stores/perf.svelte.js';

export const usage = $state({
	/** @type {{claude?:object, gemini?:object, stats?:object, llmRouting?:object}|null} */
	data: null,
});

let _refreshTimer = null;

export async function loadUsageData() {
	try {
		const provider = (voice.settings?.terminal_ai_provider || '').toLowerCase();
		const isGemini = provider === 'gemini';
		// llmRouting is a separate fetch — it answers "where do PAN's internal
		// LLM calls go" (router/scout/intuition-classifier/etc → Cerebras vs
		// Ollama). Different question from claude-usage which is just the
		// user's CLI subscription. Both shown side-by-side in UsagePanel.
		const [u, stats, llmRouting] = await Promise.all([
			api(isGemini ? '/api/v1/gemini-usage' : '/api/v1/claude-usage'),
			api('/dashboard/api/stats'),
			api('/api/v1/usage/llm-routing').catch(() => null),
		]);
		usage.data = isGemini
			? { gemini: u, stats, llmRouting }
			: { claude: u, stats, llmRouting };
		perf.loadTimings.usageWidget ||= Math.round(performance.now()); // best-effort, see perf store
	} catch (e) {
		console.error('Failed to load usage data:', e);
	}
}

/** Start a 30s poll; safe to call repeatedly. */
export function startUsagePolling() {
	if (_refreshTimer) return;
	loadUsageData();
	_refreshTimer = setInterval(loadUsageData, 30_000);
}

export function stopUsagePolling() {
	if (_refreshTimer) { clearInterval(_refreshTimer); _refreshTimer = null; }
}

// ────────────────────────────────────────────────────────────────────────────
//  Format helpers — used by the panel template
// ────────────────────────────────────────────────────────────────────────────

export function formatTokens(n) {
	if (!n) return '0';
	if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
	if (n >= 1000)    return (n / 1000).toFixed(1)    + 'K';
	return String(n);
}

export function formatResetTime(isoStr) {
	if (!isoStr) return '';
	const reset = new Date(isoStr);
	const now   = new Date();
	const diff  = reset - now;
	if (diff <= 0) return 'now';
	const h = Math.floor(diff / 3600000);
	const m = Math.floor((diff % 3600000) / 60000);
	if (h > 0) return `${h}h ${m}m`;
	return `${m}m`;
}
