// org.svelte.js — org context + permissions matrix. Cross-cuts every widget
// that gates on power level (Users/Add-member form, Intuition roster scope,
// Impersonate banner, panel-visibility dropdown filters).
//
// Lifted from terminal/+page.svelte during the Shape-2 refactor so widgets
// stop receiving these via prop drilling. The parent's `loadOrgContextWithRetry`
// + `reloadPermsMatrix` functions still populate the fields here; widgets
// just `import { org } from '$lib/stores/org.svelte.js'` and read.

import { api } from '$lib/api.js';

export const org = $state({
	/** @type {{org_id:string, org_name:string, user_display_name:string, orgs:Array}|null} */
	data: null,
	/** @type {{power:number, realPower:number, isImpersonating:boolean, widgets:Record<string,{visible:boolean}>}|null} */
	permsMatrix: null,
});

// Retrying org-context loader. Original lived inline at +page.svelte L519.
// Polling backoff is the recovery path for a Carrier restart that drops the
// initial fetch — we don't want one bad request to leave every org-gated
// widget blank forever.
let _orgLoaderInFlight = false;
export async function loadOrgContextWithRetry() {
	if (_orgLoaderInFlight) return;
	_orgLoaderInFlight = true;
	try {
		const delays = [0, 500, 1000, 2000, 4000, 8000, 15000, 30000, 60000];
		for (let i = 0; i < delays.length; i++) {
			if (delays[i] > 0) await new Promise(res => setTimeout(res, delays[i]));
			try {
				const r = await api('/api/v1/org/current');
				if (r && r.org_id) {
					org.data = r;
					return;
				}
			} catch (e) { /* retry */ }
		}
		console.warn('[org] failed to load org context after retries — widgets gated on org will remain blank');
	} finally {
		_orgLoaderInFlight = false;
	}
}

export async function reloadPermsMatrix() {
	try {
		const r = await api('/api/v1/permissions/matrix');
		org.permsMatrix = r;
	} catch {
		org.permsMatrix = { power: 100, realPower: 100, isImpersonating: false, widgets: {} };
	}
}

export async function stopImpersonation() {
	await api('/api/v1/impersonate', { method: 'DELETE' });
	await reloadPermsMatrix();
}

/** Banner label for the toolbar when impersonation is active. */
export function impersonationLabel(imp) {
	if (!imp) return '';
	if (imp.type === 'user')  return `👤 ${imp.label} (lvl ${imp.power})`;
	if (imp.type === 'group') return `🏢 ${imp.label} (lvl ${imp.power})`;
	return `👁 ${imp.label} (lvl ${imp.power})`;
}

/** Visibility check used by panel-selector dropdowns. */
export function widgetVisible(optionValue, panelWidgetMap) {
	if (!org.permsMatrix) return true; // not yet loaded → show everything
	const key = panelWidgetMap?.[optionValue];
	if (!key) return true;
	return org.permsMatrix.widgets[key]?.visible !== false;
}
