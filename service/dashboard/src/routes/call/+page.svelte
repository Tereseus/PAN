<script>
	import { onMount } from 'svelte';

	let contactName = $state('');
	let contactId = $state('');
	let threadId = $state('');
	let callId = $state('');
	let callStatus = $state('connecting'); // connecting, ringing, active, ended
	let callDuration = $state(0);
	let cameraOn = $state(false);
	let micOn = $state(true);
	let screenSharing = $state(false);
	let durationTimer = null;

	onMount(() => {
		const params = new URLSearchParams(window.location.search);
		contactName = params.get('name') || 'Unknown';
		contactId = params.get('contact') || '';
		threadId = params.get('thread') || '';
		document.title = `Call — ${contactName}`;

		// Start the call
		startCall();

		return () => {
			if (durationTimer) clearInterval(durationTimer);
		};
	});

	async function startCall() {
		callStatus = 'ringing';
		try {
			const res = await fetch('/api/v1/chat/calls/start', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ thread_id: threadId, type: cameraOn ? 'video' : 'voice' })
			});
			if (res.ok) {
				const data = await res.json();
				callId = data.call_id;
				// Simulate answer after 2s (real: WebRTC signaling)
				setTimeout(() => {
					callStatus = 'active';
					durationTimer = setInterval(() => { callDuration++; }, 1000);
				}, 2000);
			}
		} catch (e) {
			console.error('Call failed:', e);
			callStatus = 'ended';
		}
	}

	async function endCall() {
		if (durationTimer) clearInterval(durationTimer);
		callStatus = 'ended';
		if (callId) {
			try {
				await fetch(`/api/v1/chat/calls/${callId}/end`, { method: 'POST' });
			} catch {}
		}
		setTimeout(() => window.close(), 1500);
	}

	function toggleCamera() { cameraOn = !cameraOn; }
	function toggleMic() { micOn = !micOn; }
	function toggleScreen() { screenSharing = !screenSharing; }

	function formatDuration(s) {
		const m = Math.floor(s / 60);
		const sec = s % 60;
		return `${m}:${sec.toString().padStart(2, '0')}`;
	}
</script>

<div class="call-window">
	<div class="call-main">
		{#if cameraOn || screenSharing}
			<div class="call-video-area">
				<div class="call-video-placeholder">
					{#if screenSharing}
						🖥 Screen Sharing
					{:else}
						📷 Camera On
					{/if}
				</div>
			</div>
		{:else}
			<div class="call-avatar-area">
				<div class="call-avatar">{contactName.charAt(0).toUpperCase()}</div>
				<div class="call-name">{contactName}</div>
				<div class="call-status">
					{#if callStatus === 'connecting'}Connecting...
					{:else if callStatus === 'ringing'}Ringing...
					{:else if callStatus === 'active'}{formatDuration(callDuration)}
					{:else if callStatus === 'ended'}Call Ended
					{/if}
				</div>
			</div>
		{/if}
	</div>

	<div class="call-controls">
		<button class="call-btn" class:active={micOn} onclick={toggleMic} title={micOn ? 'Mute' : 'Unmute'}>
			{micOn ? '🎙' : '🔇'}
		</button>
		<button class="call-btn" class:active={cameraOn} onclick={toggleCamera} title={cameraOn ? 'Camera Off' : 'Camera On'}>
			{cameraOn ? '📷' : '📷'}
		</button>
		<button class="call-btn" class:active={screenSharing} onclick={toggleScreen} title={screenSharing ? 'Stop Sharing' : 'Share Screen'}>
			🖥
		</button>
		<button class="call-btn end" onclick={endCall} title="End Call">
			📞
		</button>
	</div>
</div>

<style>
	:global(body) {
		font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
		background: #11111b;
		color: #cdd6f4;
		margin: 0;
		overflow: hidden;
	}

	.call-window {
		display: flex;
		flex-direction: column;
		height: 100vh;
	}

	.call-main {
		flex: 1;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.call-avatar-area {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 16px;
	}

	.call-avatar {
		width: 120px;
		height: 120px;
		border-radius: 50%;
		background: #313244;
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: 48px;
		font-weight: 700;
		color: #89b4fa;
	}

	.call-name {
		font-size: 24px;
		font-weight: 600;
	}

	.call-status {
		font-size: 16px;
		color: #6c7086;
	}

	.call-video-area {
		width: 100%;
		height: 100%;
		display: flex;
		align-items: center;
		justify-content: center;
		background: #181825;
	}

	.call-video-placeholder {
		font-size: 24px;
		color: #585b70;
	}

	.call-controls {
		display: flex;
		justify-content: center;
		gap: 16px;
		padding: 24px;
		background: #181825;
		border-top: 1px solid #1e1e2e;
		flex-shrink: 0;
	}

	.call-btn {
		width: 56px;
		height: 56px;
		border-radius: 50%;
		border: none;
		background: #313244;
		color: #cdd6f4;
		font-size: 22px;
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: center;
		transition: all 0.15s;
	}

	.call-btn:hover { background: #45475a; }
	.call-btn.active { background: #89b4fa; color: #11111b; }
	.call-btn.end { background: #f38ba8; }
	.call-btn.end:hover { background: #eba0ac; }
</style>
