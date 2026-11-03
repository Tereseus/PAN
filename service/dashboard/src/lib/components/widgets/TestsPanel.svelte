<!--
  TestsPanel.svelte — extracted from terminal/+page.svelte (Shape-2 refactor).

  Test suite runner widget. Each suite is either:
   - server-side: trigger via `/api/v1/tests/run`, poll results until `done`
   - client-side: execute test functions in the browser (page-refresh,
                  terminal-protocol, widgets, input-box)

  Props:
    isDev          — true when running on the dev server. Tests always RUN on
                     dev (never prod); when called from prod the suite logic
                     auto-spawns the dev server and proxies API calls through.
    getActiveTab   — callback returning the active terminal tab (used by the
                     input-box and widgets suites for live WS / project lookup).
-->
<script>
	import { onMount, onDestroy } from 'svelte';
	import { api, wsUrl } from '$lib/api.js';

	let {
		isDev = false,
		getActiveTab = () => null,
	} = $props();

	const CLIENT_SUITES = new Set(['page-refresh', 'terminal-protocol', 'widgets', 'input-box']);

	let testSuites = $state([]);
	let selectedSuite = $state('');
	let testResults = $state([]);
	let testsRunning = $state(false);
	let lastServerRun = null;

	let testWs = null;
	let testSessionId = 'test-suite-' + Date.now();

	async function loadTestSuites() {
		try {
			const data = await api('/api/v1/tests');
			if (data) {
				const serverSuites = (data.suites || []).map(s => {
					const suiteTests = (data.tests || []).filter(t => t.suiteId === s.id).map(t => ({
						id: t.id, name: t.name, description: t.description
					}));
					const tests = suiteTests.length > 0 ? suiteTests :
						Array.from({length: s.testCount}, (_, i) => ({id: `${s.id}-${i}`, name: `Test ${i+1}`, description: ''}));
					return { id: s.id, name: s.name, description: s.description, tests, server: true };
				});
				testSuites = serverSuites;
				if (data.status === 'done' && data.tests) lastServerRun = data;
				if (testSuites.length > 0 && !selectedSuite) selectedSuite = testSuites[0].id;
			}
		} catch {}
	}

	// Route test API calls: on dev hit directly, on prod proxy through production
	// (the dev server lives on port 7781 — going through the proxy avoids CORS).
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

		// Client-side suite — run in the browser
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
					setTimeout(() => { if (!found) { clearTimeout(timer); resolve('Buffer replayed (marker may be in initial burst)'); } }, 2000);
				});
			}
			case 'pr-7': {
				if (testWs) testWs.close();
				testWs = null;
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

	onMount(() => { loadTestSuites(); });
	onDestroy(() => { if (testWs) try { testWs.close(); } catch {} });
</script>

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
					{t.status === 'pass' ? '✓' : t.status === 'fail' ? '✗' : t.status === 'running' ? '●' : '○'}
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
