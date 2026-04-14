<script>
	import { onMount } from 'svelte';

	let threadId = $state('');
	let contactName = $state('');
	let contactId = $state('');
	let body = $state('');
	let subject = $state('');
	let sending = $state(false);
	let sent = $state(false);

	onMount(() => {
		const params = new URLSearchParams(window.location.search);
		threadId = params.get('thread') || '';
		contactName = params.get('name') || 'Unknown';
		contactId = params.get('contact') || '';
		document.title = `Compose — ${contactName}`;
	});

	async function sendMessage() {
		if (!body.trim() || !threadId) return;
		sending = true;
		try {
			const fullBody = subject.trim() ? `**${subject.trim()}**\n\n${body.trim()}` : body.trim();
			await fetch(`/api/v1/chat/threads/${threadId}/messages`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ body: fullBody, body_type: 'rich' })
			});
			sent = true;
			setTimeout(() => window.close(), 1500);
		} catch (e) {
			console.error('Send failed:', e);
		} finally {
			sending = false;
		}
	}
</script>

<div class="compose-window">
	<div class="compose-header">
		<div class="compose-title">Compose Message</div>
		<div class="compose-to">To: <strong>{contactName}</strong></div>
	</div>

	{#if sent}
		<div class="compose-sent">Message sent</div>
	{:else}
		<div class="compose-form">
			<input
				type="text"
				class="compose-subject"
				placeholder="Subject (optional)"
				bind:value={subject}
			/>
			<textarea
				class="compose-body"
				placeholder="Write your message..."
				bind:value={body}
				rows="14"
			></textarea>
			<div class="compose-toolbar">
				<div class="compose-formatting">
					<button class="fmt-btn" title="Bold" onclick={() => { body += '**bold**'; }}>B</button>
					<button class="fmt-btn" title="Italic" onclick={() => { body += '_italic_'; }}><em>I</em></button>
					<button class="fmt-btn" title="Code" onclick={() => { body += '`code`'; }}>&lt;/&gt;</button>
					<button class="fmt-btn" title="Bullet list" onclick={() => { body += '\n- item'; }}>•</button>
				</div>
				<div class="compose-actions">
					<button class="compose-cancel" onclick={() => window.close()}>Cancel</button>
					<button class="compose-send" onclick={sendMessage} disabled={sending || !body.trim()}>
						{sending ? 'Sending...' : 'Send'}
					</button>
				</div>
			</div>
		</div>
	{/if}
</div>

<style>
	:global(body) {
		font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
		background: #11111b;
		color: #cdd6f4;
		margin: 0;
		overflow: hidden;
	}

	.compose-window {
		display: flex;
		flex-direction: column;
		height: 100vh;
		max-width: 100%;
	}

	.compose-header {
		padding: 16px 20px 12px;
		border-bottom: 1px solid #1e1e2e;
		flex-shrink: 0;
	}

	.compose-title {
		font-size: 16px;
		font-weight: 700;
		color: #cdd6f4;
		margin-bottom: 4px;
	}

	.compose-to {
		font-size: 13px;
		color: #6c7086;
	}

	.compose-to strong {
		color: #89b4fa;
	}

	.compose-sent {
		display: flex;
		align-items: center;
		justify-content: center;
		flex: 1;
		font-size: 18px;
		color: #a6e3a1;
		font-weight: 600;
	}

	.compose-form {
		display: flex;
		flex-direction: column;
		flex: 1;
		padding: 12px 20px 16px;
		gap: 10px;
		min-height: 0;
	}

	.compose-subject {
		background: #1e1e2e;
		border: 1px solid #313244;
		border-radius: 6px;
		color: #cdd6f4;
		padding: 10px 14px;
		font-size: 14px;
		font-weight: 600;
		outline: none;
	}

	.compose-subject:focus { border-color: #89b4fa; }

	.compose-body {
		flex: 1;
		background: #1e1e2e;
		border: 1px solid #313244;
		border-radius: 6px;
		color: #cdd6f4;
		padding: 12px 14px;
		font-size: 13px;
		font-family: inherit;
		line-height: 1.5;
		outline: none;
		resize: none;
		min-height: 0;
	}

	.compose-body:focus { border-color: #89b4fa; }

	.compose-toolbar {
		display: flex;
		justify-content: space-between;
		align-items: center;
		flex-shrink: 0;
	}

	.compose-formatting {
		display: flex;
		gap: 4px;
	}

	.fmt-btn {
		background: #1e1e2e;
		border: 1px solid #313244;
		color: #6c7086;
		width: 30px;
		height: 28px;
		border-radius: 4px;
		cursor: pointer;
		font-size: 12px;
		font-weight: 600;
	}

	.fmt-btn:hover { color: #89b4fa; border-color: #89b4fa; }

	.compose-actions {
		display: flex;
		gap: 8px;
	}

	.compose-cancel {
		background: none;
		border: 1px solid #313244;
		color: #6c7086;
		padding: 8px 16px;
		border-radius: 6px;
		font-size: 13px;
		cursor: pointer;
	}

	.compose-cancel:hover { color: #cdd6f4; border-color: #6c7086; }

	.compose-send {
		background: #89b4fa;
		color: #11111b;
		border: none;
		padding: 8px 24px;
		border-radius: 6px;
		font-size: 13px;
		font-weight: 600;
		cursor: pointer;
	}

	.compose-send:hover { background: #74c7ec; }
	.compose-send:disabled { opacity: 0.4; cursor: not-allowed; }
</style>
