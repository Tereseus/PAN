<!--
  PtyStatusBar.svelte — the thin status pill under the center column.
  Shows "Ready" / "Claude is thinking" / current tool / PTY metadata
  (pid, uptime, last-input-ago, last-output-ago, client count).

  Only renders when there's NO approval prompt active. The parent's
  approval bar takes over that slot when 1/2/3 options are detected.

  Reads everything from `terminal` store. No props.
-->
<script>
	import { terminal } from '$lib/stores/terminal.svelte.js';

	const _now      = $derived(terminal.ptyStatusNow);
	const _pty      = $derived(terminal.ptyStatus);
	const _state    = $derived(
		!_pty ? 'no-pty'
		: (!terminal.claudeReady || _pty.thinking || terminal.pipeSending) ? 'thinking'
		: 'ready'
	);
	const _inAgo       = $derived(_pty?.lastInputTs  ? Math.max(0, Math.round((_now - _pty.lastInputTs)  / 1000)) : null);
	const _outAgo      = $derived(_pty?.lastOutputTs ? Math.max(0, Math.round((_now - _pty.lastOutputTs) / 1000)) : null);
	const _upS         = $derived(_pty?.createdAt    ? Math.max(0, Math.round((_now - _pty.createdAt)    / 1000)) : null);
	const _tool        = $derived(_pty?.currentTool);
	const _toolElapsed = $derived(_tool?.startedAt   ? Math.max(0, Math.round((_now - _tool.startedAt)   / 1000)) : null);
</script>

<div class="pty-status-bar pty-{_state}" title="Live PTY status from /api/v1/terminal/sessions">
	{#if _tool}
		<span class="status-spinner"></span>
		<span class="status-text">{_tool.isSubagent ? '🤖' : '🔧'} {_tool.tool}{_tool.summary ? ' · ' + _tool.summary : ''} · {_toolElapsed}s</span>
	{:else if _state === 'thinking'}
		<span class="status-spinner"></span>
		<span class="status-text">Claude is thinking…{terminal.pendingSendCount > 0 ? ` (${terminal.pendingSendCount} queued)` : ''}</span>
	{:else if _state === 'no-claude'}
		<span class="status-dot dot-yellow"></span>
		<span class="status-text">Claude not running — bash only</span>
	{:else if _state === 'ready'}
		<span class="status-dot dot-green"></span>
		<span class="status-text">Ready</span>
	{:else}
		<span class="status-dot dot-red"></span>
		<span class="status-text">No PTY Attached</span>
	{/if}
	{#if _pty}
		<span class="pty-meta">pid {_pty.pid}</span>
		{#if _upS != null}<span class="pty-meta">up {_upS < 60 ? `${_upS}s` : _upS < 3600 ? `${Math.floor(_upS/60)}m` : `${Math.floor(_upS/3600)}h${Math.floor((_upS%3600)/60)}m`}</span>{/if}
		{#if _inAgo != null && _pty.lastInputTs > 0}<span class="pty-meta">in {_inAgo}s ago</span>{/if}
		{#if _outAgo != null}<span class="pty-meta">out {_outAgo}s ago</span>{/if}
		<span class="pty-meta">{_pty.clients} client{_pty.clients === 1 ? '' : 's'}</span>
	{/if}
</div>
