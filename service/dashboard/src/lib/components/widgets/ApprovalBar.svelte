<!--
  ApprovalBar.svelte — the 1/2/3 (etc) buttons that appear when Claude
  shows a permission menu. The parent owns the detection logic (it scans
  the PTY scrollback and populates `terminal.approvalOptions`) and the
  `sendApproval(num)` action that fires the chosen option over WS; we just
  render the buttons and route clicks back via the `onApprove` prop.

  Only renders when `terminal.approvalOptions` is a non-empty array.
-->
<script>
	import { terminal } from '$lib/stores/terminal.svelte.js';

	let {
		/** @type {(num: number) => void} */
		onApprove = () => {},
	} = $props();
</script>

{#if terminal.approvalOptions && terminal.approvalOptions.length > 0}
	<div class="approval-bar">
		<span class="approval-label">Claude needs approval:</span>
		{#each terminal.approvalOptions as opt}
			<button class="approval-btn" onclick={() => onApprove(opt.num)} title="Press {opt.num}">
				<span class="approval-num">{opt.num}</span>
				<span class="approval-text">{opt.label}</span>
			</button>
		{/each}
	</div>
{/if}
