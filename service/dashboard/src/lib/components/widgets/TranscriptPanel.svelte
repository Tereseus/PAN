<!--
  TranscriptPanel.svelte — chat bubble view shown in the LEFT sidebar when
  `leftSection === 'transcript'`. Renders the same `chatBubbles` array that
  the parent owns (it's also the source for the center column chat view), so
  this is a pure presentation component.

  Bubble shape:
    { type: 'user',      text, speaker, multiSession?, accentColor? }
    { type: 'assistant', text, speaker, model?, multiSession?, accentColor? }
    { type: 'tool',      text }
    { type: 'stats',     tokens: { input, output, cost, total_input, total_output, total_cost, cache_read } }
-->
<script>
	// 2026-05-28: migrated to read `chat.bubbles` from store. No props.
	import { renderMarkdown } from '$lib/markdown.js';
	import { chat } from '$lib/stores/chat.svelte.js';
	const chatBubbles = $derived(chat.bubbles);
</script>

{#if chatBubbles.length === 0}
	<div class="empty-state">No conversation yet</div>
{:else}
	<div class="chat-container">
		{#each chatBubbles as bubble}
			{#if bubble.type === 'user'}
				<div class="chat-turn">
					<div class="chat-speaker chat-speaker-user">{bubble.speaker || 'You'}</div>
					<div class="chat-bubble user">
						{#if bubble.multiSession}
							<span class="session-dot" style="background:{bubble.accentColor}"></span>
						{/if}
						{@html renderMarkdown(bubble.text)}
					</div>
				</div>
			{:else if bubble.type === 'assistant'}
				<div class="chat-turn">
					<div class="chat-speaker chat-speaker-assistant">
						{bubble.speaker || 'Claude'}
						{#if bubble.model}<span class="chat-model">{bubble.model}</span>{/if}
					</div>
					<div class="chat-bubble assistant" style={bubble.multiSession ? `border-left:2px solid ${bubble.accentColor}` : ''}>
						{@html renderMarkdown(bubble.text)}
					</div>
				</div>
			{:else if bubble.type === 'tool'}
				<div class="chat-bubble tool">{bubble.text}</div>
			{:else if bubble.type === 'stats' && bubble.tokens}
				<div class="chat-stats-bar">
					<span>↑{(bubble.tokens.input / 1000).toFixed(1)}K ↓{(bubble.tokens.output / 1000).toFixed(1)}K{bubble.tokens.cache_read ? ` 📦${(bubble.tokens.cache_read / 1000).toFixed(1)}K` : ''} ${bubble.tokens.cost != null ? `$${bubble.tokens.cost.toFixed(4)}` : ''}</span>
					<span class="chat-stats-total">session: ↑{(bubble.tokens.total_input / 1000).toFixed(1)}K ↓{(bubble.tokens.total_output / 1000).toFixed(1)}K {bubble.tokens.total_cost != null ? `$${bubble.tokens.total_cost.toFixed(4)}` : ''}</span>
				</div>
			{/if}
		{/each}
	</div>
{/if}
