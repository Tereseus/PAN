<!--
  ContactsPanel.svelte — DM/contacts widget (left or right column).

  Three states (mutually exclusive in the template):
   1. Active DM thread → render the conversation + input bar
   2. Add-contact form open → render the modal inputs
   3. Contact list → search bar + Π pinned + favorites + all others

  All state and mutators live in `$lib/stores/chat.svelte.js`. The parent
  passes one callback — `switchCenterView` — so opening a DM can flip the
  center column to `'chat'`.

  Props:
    switchCenterView(view) — invoked by openChat() so the center view
                             follows the opened DM.
-->
<script>
	import { onMount } from 'svelte';
	import {
		chat,
		setChatMessagesEl,
		loadContacts,
		openChat,
		sendChatMessage,
		addContact,
		toggleFavorite,
	} from '$lib/stores/chat.svelte.js';
	import { openCompose } from '$lib/compose.js';

	let { switchCenterView = () => {} } = $props();

	/** DOM ref for the messages scroll container — registered with the store. */
	let messagesEl;
	$effect(() => { setChatMessagesEl(messagesEl); });

	onMount(() => { loadContacts(); });

	const filtered = $derived(
		chat.contacts.filter(c => !chat.searchQuery || c.display_name.toLowerCase().includes(chat.searchQuery.toLowerCase()))
	);
	const panContact = $derived(filtered.find(c => c.id === 'contact-pan-system') || null);
	const favorites = $derived(filtered.filter(c => c.favorited && c.id !== 'contact-pan-system'));
	const others = $derived(filtered.filter(c => !c.favorited && c.id !== 'contact-pan-system'));
</script>

<div class="contacts-panel">
	<!-- DM Thread View -->
	{#if chat.activeThread}
		<div class="dm-thread">
			<div class="dm-header">
				<button class="dm-back" onclick={() => { chat.activeThread = null; chat.messages = []; switchCenterView('terminal'); }}>←</button>
				<span class="dm-contact-avatar" class:pan-avatar={chat.activeThread.contact?.id === 'contact-pan-system'}>
					{chat.activeThread.contact?.display_name?.charAt(0)?.toUpperCase() || '?'}
				</span>
				<span class="dm-contact-name">{chat.activeThread.contact?.display_name || 'Chat'}</span>
			</div>
			<div class="dm-messages" bind:this={messagesEl}>
				{#if chat.messages.length === 0}
					<div class="dm-empty">
						{#if chat.activeThread.contact?.id === 'contact-pan-system'}
							<div style="color:#a6adc8;text-align:center;padding:20px 12px;font-size:13px;">
								<div style="font-size:24px;margin-bottom:8px;">Π</div>
								Π is listening. Ask anything about what's going on, or wait for system reports.
							</div>
						{:else}
							No messages yet
						{/if}
					</div>
				{:else}
					{#each chat.messages as msg}
						{@const meta = (() => { try { return JSON.parse(msg.metadata || '{}'); } catch { return {}; } })()}
						{@const isSelf = msg.sender_id === 'self'}
						<div class="dm-msg-wrap" class:dm-msg-self={isSelf}>
							{#if !isSelf && meta.service}
								<div class="dm-service-tag">{meta.service}</div>
							{/if}
							<div class="dm-bubble" class:dm-bubble-self={isSelf} class:dm-bubble-pan={msg.sender_id === 'contact-pan-system'}>
								{#if msg.subject && msg.subject !== msg.body}
									<div class="dm-subject">{msg.subject}</div>
								{/if}
								<div class="dm-body">{msg.body}</div>
								<div class="dm-time">{new Date(msg.created_at).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}</div>
							</div>
						</div>
					{/each}
				{/if}
			</div>
			<div class="dm-input-bar">
				<input class="dm-input" type="text"
					placeholder={chat.activeThread.contact?.id === 'contact-pan-system' ? 'Ask Π anything…' : 'Message…'}
					bind:value={chat.inputText}
					onkeydown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChatMessage(); } }} />
				<button class="dm-send" onclick={sendChatMessage} disabled={!chat.inputText.trim()}>↑</button>
			</div>
		</div>

	<!-- Contacts List -->
	{:else}
		<!-- Search + Add -->
		<div class="contacts-toolbar">
			<input type="text" class="contacts-search" placeholder="Search contacts..." bind:value={chat.searchQuery} />
			<button class="contacts-add-btn" onclick={() => openCompose(null)} title="Compose message">&#9998;</button>
			<button class="contacts-add-btn" onclick={() => { chat.addContactOpen = true; }} title="Add contact">+</button>
		</div>

		<!-- Add Contact Modal -->
		{#if chat.addContactOpen}
			<div class="contact-add-form">
				<input type="text" placeholder="Name *" bind:value={chat.newContactName} class="contact-input" />
				<input type="text" placeholder="PAN Instance ID (pan_xxxx)" bind:value={chat.newContactPanId} class="contact-input" />
				<input type="text" placeholder="Phone" bind:value={chat.newContactPhone} class="contact-input" />
				<input type="text" placeholder="Email" bind:value={chat.newContactEmail} class="contact-input" />
				<div class="contact-add-actions">
					<button class="contact-btn-save" onclick={addContact}>Add</button>
					<button class="contact-btn-cancel" onclick={() => { chat.addContactOpen = false; }}>Cancel</button>
				</div>
			</div>
		{/if}

		<!-- Π system contact — always pinned at top -->
		{#if panContact}
			<div class="svc-category">Π</div>
			<div class="svc-row contact-row pan-contact-row" onclick={() => openChat(panContact, switchCenterView)} role="button" tabindex="0">
				<span class="contact-avatar pan-avatar">Π</span>
				<div class="svc-info">
					<div class="svc-name">
						Π
						{#if panContact.unread_count > 0}
							<span class="contact-badge">{panContact.unread_count}</span>
						{/if}
					</div>
					<div class="svc-detail">
						<span class="contact-status online"></span> System · always on
					</div>
				</div>
			</div>
		{/if}

		<!-- Favorites (excluding Π) -->
		{#if favorites.length > 0}
			<div class="svc-category">Favorites</div>
			{#each favorites as contact}
				<div class="svc-row contact-row" onclick={() => openChat(contact, switchCenterView)} role="button" tabindex="0">
					<span class="contact-avatar" style="background: {contact.avatar_url ? 'none' : '#585b70'}">
						{contact.display_name.charAt(0).toUpperCase()}
					</span>
					<div class="svc-info">
						<div class="svc-name">
							{contact.display_name}
							{#if contact.unread_count > 0}
								<span class="contact-badge">{contact.unread_count}</span>
							{/if}
						</div>
						<div class="svc-detail">
							{#if contact.pan_instance_id}
								<span class="contact-status" class:online={contact.status === 'online'} class:away={contact.status === 'away'}></span>
								{contact.status || 'offline'}
							{:else}
								{contact.phone || contact.email || 'No PAN ID'}
							{/if}
						</div>
					</div>
					<button class="contact-action-btn" onclick={(e) => { e.stopPropagation(); toggleFavorite(contact); }} title="Unfavorite">&#9733;</button>
				</div>
			{/each}
		{/if}

		<!-- All contacts (excluding Π) -->
		{#if others.length > 0}
			<div class="svc-category">Contacts</div>
			{#each others as contact}
				<div class="svc-row contact-row" onclick={() => openChat(contact, switchCenterView)} role="button" tabindex="0">
					<span class="contact-avatar" style="background: {contact.avatar_url ? 'none' : '#585b70'}">
						{contact.display_name.charAt(0).toUpperCase()}
					</span>
					<div class="svc-info">
						<div class="svc-name">
							{contact.display_name}
							{#if contact.unread_count > 0}
								<span class="contact-badge">{contact.unread_count}</span>
							{/if}
						</div>
						<div class="svc-detail">
							{#if contact.pan_instance_id}
								<span class="contact-status" class:online={contact.status === 'online'} class:away={contact.status === 'away'}></span>
								{contact.status || 'offline'}
							{:else}
								{contact.phone || contact.email || 'No PAN ID'}
							{/if}
						</div>
					</div>
					<button class="contact-action-btn" onclick={(e) => { e.stopPropagation(); toggleFavorite(contact); }} title="Favorite">&#9734;</button>
				</div>
			{/each}
		{/if}

		{#if filtered.length === 0 && !chat.addContactOpen}
			<div class="empty-state">{chat.searchQuery ? 'No matches' : 'No contacts yet — click + to add'}</div>
		{/if}
	{/if}
</div>
