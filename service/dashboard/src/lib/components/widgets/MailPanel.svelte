<!--
  MailPanel.svelte — inbox view. Reads everything from the mail store.
  Clicking a row opens Compose pre-filled with the subject/from for reply.
-->
<script>
	import { onMount } from 'svelte';
	import { mail, loadMail, loadMailStatus, syncMail, formatMailDate } from '$lib/stores/mail.svelte.js';
	import { loadContacts } from '$lib/stores/chat.svelte.js';
	import { openCompose } from '$lib/compose.js';

	onMount(() => {
		loadMail();
		loadMailStatus();
		// Contacts are used to resolve the "From" column when the message has a
		// matching contact_id, so load them alongside the inbox.
		loadContacts();
	});
</script>

<div class="mail-panel">
	<div class="contacts-toolbar">
		<button class="contacts-add-btn" onclick={syncMail} title="Sync inbox" disabled={mail.loading}>&#x21BB;</button>
		<div style="flex:1; font-size: 12px; color: #a6adc8;">
			{#if mail.status?.connected}
				<span style="color: #a6e3a1;">&#x25CF;</span> {mail.status.user || 'Connected'}
			{:else if mail.status?.configured}
				<span style="color: #f38ba8;">&#x25CF;</span> Disconnected
			{:else}
				<span style="color: #585b70;">&#x25CF;</span> Not configured
			{/if}
		</div>
		<button class="contacts-add-btn" onclick={() => openCompose()} title="Compose">+</button>
	</div>

	{#if mail.loading && mail.messages.length === 0}
		<div class="empty-state">Loading...</div>
	{:else if mail.messages.length === 0}
		<div class="empty-state">
			{#if !mail.status?.configured}
				Email not configured — go to Settings
			{:else}
				No messages — click &#x21BB; to sync
			{/if}
		</div>
	{:else}
		<div class="mail-list">
			{#each mail.messages as msg}
				<div class="mail-row" class:unread={!msg.read}
					onclick={() => openCompose(null,
						msg.subject ? 'Re: ' + msg.subject : '',
						msg.direction === 'received' ? msg.from : '')}>
					<div class="mail-row-top">
						<span class="mail-type-badge" class:pan={msg.channel === 'pan'} class:email={msg.channel === 'email'}>
							{msg.channel === 'pan' ? '◆' : '✉'}
						</span>
						<span class="mail-from">{msg.direction === 'sent' ? `To: ${msg.to}` : msg.from}</span>
						<span class="mail-date">{formatMailDate(msg.date)}</span>
					</div>
					{#if msg.subject}<div class="mail-subject">{msg.subject}</div>{/if}
					<div class="mail-preview">{msg.preview || ''}</div>
				</div>
			{/each}
		</div>
		{#if mail.total > 50}
			<div class="mail-pager">
				{#if mail.page > 0}
					<button class="contact-btn-save" onclick={() => loadMail(mail.page - 1)}>&larr; Newer</button>
				{/if}
				<span style="color: #585b70; font-size: 11px;">{mail.page * 50 + 1}-{Math.min((mail.page + 1) * 50, mail.total)} of {mail.total}</span>
				{#if (mail.page + 1) * 50 < mail.total}
					<button class="contact-btn-save" onclick={() => loadMail(mail.page + 1)}>Older &rarr;</button>
				{/if}
			</div>
		{/if}
	{/if}
</div>
