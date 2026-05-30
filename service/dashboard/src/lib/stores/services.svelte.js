// services.svelte.js — system service status + carrier/lifeboat state.
// Used by ServicesPanel (read services list) and LifeboatPanel (carrier swap).

import { api } from '$lib/api.js';

export const services = $state({
	/** @type {Array<{name:string, category:string, status:string, detail:string, role?:string}>} */
	list: [],
	/** @type {{carrier:object, primaryCraft:object, previousCraft:object, shadowCraft:object, swapPending:boolean, rollbackAvailable:boolean}|null} */
	lifeboat: null,
});

export async function loadServices() {
	try {
		const r = await api('/dashboard/api/services');
		services.list = r?.services || [];
	} catch {}
}

export async function loadLifeboat() {
	try {
		const r = await fetch('/api/carrier/status');
		if (r.ok) services.lifeboat = await r.json();
	} catch {}
}
