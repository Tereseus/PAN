<!--
  CenterChatView.svelte — the centre-column chat view shown when
  `terminal.centerView === 'chat'`. Pure presentation — message bubbles
  (user / assistant / tool) + "Thinking..." placeholder. The scroll
  container ref + onscroll handler stay with the parent because they
  persist scroll position to localStorage tied to other parent state.

  Props:
    scrollElBind — `bind:this` target so parent can write/read scrollTop.
-->
<script>
	import { terminal } from '$lib/stores/terminal.svelte.js';

	let { scrollElBind = $bindable(null) } = $props();
</script>

<div class="center-chat" bind:this={scrollElBind} onscroll={() => {
	if (scrollElBind) {
		terminal.centerChatUserScrolledUp = scrollElBind.scrollHeight - scrollElBind.scrollTop - scrollElBind.clientHeight > 50;
		try {
			const ratio = scrollElBind.scrollTop / Math.max(1, scrollElBind.scrollHeight - scrollElBind.clientHeight);
			localStorage.setItem('pan_chat_scroll_ratio', String(ratio));
			localStorage.setItem('pan_chat_scrolled_up', terminal.centerChatUserScrolledUp ? '1' : '0');
		} catch {}
	}
}}>
	{#if terminal.centerChatMessages.length === 0}
		<div class="term-empty">
			<div class="term-empty-title">Chat</div>
			<div class="term-empty-sub">Send a message to the terminal session</div>
		</div>
	{:else}
		{#each terminal.centerChatMessages as msg}
			{#if msg.role === 'user'}
				<div class="cc-bubble cc-user">{msg.text}</div>
			{:else if msg.type === 'text' || msg.type === 'output'}
				<div class="cc-bubble cc-assistant">{msg.text}</div>
			{:else if msg.type === 'tool'}
				<div class="cc-bubble cc-tool">{msg.text}</div>
			{/if}
		{/each}
		{#if terminal.centerChatLoading}
			<div class="cc-bubble cc-assistant cc-thinking">Thinking...</div>
		{/if}
	{/if}
</div>
