<script>
	import { onMount } from 'svelte';

	const API = typeof window !== 'undefined' ? window.location.origin : '';

	let contactName = $state('');
	let contactId = $state('');
	let threadId = $state('');
	let callId = $state('');
	let callRole = $state('initiator'); // 'initiator' or 'responder'
	let callStatus = $state('connecting'); // connecting, ringing, active, ended
	let callDuration = $state(0);
	let cameraOn = $state(false);
	let micOn = $state(true);
	let screenSharing = $state(false);
	let durationTimer = null;
	let pollTimer = null;
	let lastSignalId = 0;
	let errorMsg = $state('');

	// WebRTC state
	/** @type {RTCPeerConnection|null} */
	let pc = null;
	/** @type {MediaStream|null} */
	let localStream = null;
	/** @type {MediaStream|null} */
	let remoteStream = $state(null);
	/** @type {MediaStream|null} */
	let screenStream = null;
	let localVideoEl;
	let remoteVideoEl;
	let remoteAudioEl;

	// ICE candidates queued before remote description set
	let pendingCandidates = [];
	let remoteDescSet = false;

	const ICE_SERVERS = [
		{ urls: 'stun:stun.l.google.com:19302' },
		{ urls: 'stun:stun1.l.google.com:19302' },
		{ urls: 'stun:stun2.l.google.com:19302' }
	];

	onMount(() => {
		const params = new URLSearchParams(window.location.search);
		contactName = params.get('name') || 'Unknown';
		contactId = params.get('contact') || '';
		threadId = params.get('thread') || '';
		callId = params.get('callId') || '';
		callRole = params.get('role') || 'initiator';
		document.title = `Call - ${contactName}`;

		if (callRole === 'initiator') {
			initiateCall();
		} else {
			// Responder: callId already exists, start answering
			answerCall();
		}

		return () => {
			cleanup();
		};
	});

	function cleanup() {
		if (durationTimer) clearInterval(durationTimer);
		if (pollTimer) clearInterval(pollTimer);
		if (localStream) localStream.getTracks().forEach(t => t.stop());
		if (screenStream) screenStream.getTracks().forEach(t => t.stop());
		if (pc) pc.close();
	}

	function createPeerConnection() {
		pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

		pc.onicecandidate = (event) => {
			if (event.candidate) {
				sendSignal('ice-candidate', event.candidate.toJSON());
			}
		};

		pc.ontrack = (event) => {
			if (!remoteStream) {
				remoteStream = new MediaStream();
			}
			remoteStream.addTrack(event.track);
			// Bind to audio/video elements after stream updates
			requestAnimationFrame(() => {
				if (remoteAudioEl && remoteStream) remoteAudioEl.srcObject = remoteStream;
				if (remoteVideoEl && remoteStream) remoteVideoEl.srcObject = remoteStream;
			});
		};

		pc.oniceconnectionstatechange = () => {
			if (!pc) return;
			const state = pc.iceConnectionState;
			if (state === 'connected' || state === 'completed') {
				if (callStatus !== 'active') {
					callStatus = 'active';
					durationTimer = setInterval(() => { callDuration++; }, 1000);
				}
			} else if (state === 'disconnected' || state === 'failed') {
				endCall();
			}
		};

		return pc;
	}

	async function getLocalMedia() {
		try {
			localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
			localStream.getTracks().forEach(track => {
				pc.addTrack(track, localStream);
			});
		} catch (err) {
			console.error('Failed to get media:', err);
			errorMsg = 'Microphone access denied';
		}
	}

	async function initiateCall() {
		callStatus = 'ringing';
		try {
			// Create call on server if we don't have an ID yet
			if (!callId) {
				const res = await fetch(`${API}/api/v1/chat/calls/start`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ thread_id: threadId, type: cameraOn ? 'video' : 'voice' })
				});
				if (!res.ok) throw new Error('Failed to create call');
				const data = await res.json();
				callId = data.call_id;
			}

			createPeerConnection();
			await getLocalMedia();

			// Create and send offer
			const offer = await pc.createOffer();
			await pc.setLocalDescription(offer);

			await sendSignal('offer', pc.localDescription.toJSON());

			// Start polling for answer + ICE candidates
			startPolling();

		} catch (e) {
			console.error('Call initiation failed:', e);
			errorMsg = e.message;
			callStatus = 'ended';
		}
	}

	async function answerCall() {
		callStatus = 'connecting';
		try {
			createPeerConnection();
			await getLocalMedia();

			// Poll for the offer first
			await waitForOffer();

			startPolling();

		} catch (e) {
			console.error('Call answer failed:', e);
			errorMsg = e.message;
			callStatus = 'ended';
		}
	}

	async function waitForOffer() {
		// Poll until we get the offer
		for (let i = 0; i < 60; i++) { // 30 seconds max
			const signals = await fetchSignals();
			const offer = signals.find(s => s.signal_type === 'offer');
			if (offer) {
				await handleOffer(offer.signal_data);
				// Process any ICE candidates that came with the offer batch
				for (const s of signals) {
					if (s.signal_type === 'ice-candidate') {
						await handleIceCandidate(s.signal_data);
					}
				}
				return;
			}
			await sleep(500);
		}
		throw new Error('Timed out waiting for offer');
	}

	async function handleOffer(offerData) {
		const desc = new RTCSessionDescription(offerData);
		await pc.setRemoteDescription(desc);
		remoteDescSet = true;

		// Flush pending candidates
		for (const c of pendingCandidates) {
			await pc.addIceCandidate(new RTCIceCandidate(c));
		}
		pendingCandidates = [];

		// Create and send answer
		const answer = await pc.createAnswer();
		await pc.setLocalDescription(answer);
		await sendSignal('answer', pc.localDescription.toJSON());

		// Mark call as answered on server
		await fetch(`${API}/api/v1/chat/calls/${callId}/answer`, { method: 'POST' });
		callStatus = 'ringing'; // will switch to active on ICE connected
	}

	async function handleAnswer(answerData) {
		if (!pc || pc.signalingState !== 'have-local-offer') return;
		const desc = new RTCSessionDescription(answerData);
		await pc.setRemoteDescription(desc);
		remoteDescSet = true;

		// Flush pending candidates
		for (const c of pendingCandidates) {
			await pc.addIceCandidate(new RTCIceCandidate(c));
		}
		pendingCandidates = [];
	}

	async function handleIceCandidate(candidateData) {
		if (!candidateData || !candidateData.candidate) return;
		if (!remoteDescSet) {
			pendingCandidates.push(candidateData);
			return;
		}
		try {
			await pc.addIceCandidate(new RTCIceCandidate(candidateData));
		} catch (err) {
			console.warn('Failed to add ICE candidate:', err);
		}
	}

	async function sendSignal(signalType, signalData) {
		try {
			await fetch(`${API}/api/v1/chat/calls/${callId}/signal`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					signal_type: signalType,
					signal_data: signalData,
					sender: callRole
				})
			});
		} catch (err) {
			console.error('Failed to send signal:', err);
		}
	}

	async function fetchSignals() {
		try {
			const res = await fetch(
				`${API}/api/v1/chat/calls/${callId}/signals?role=${callRole}&since_id=${lastSignalId}`
			);
			if (!res.ok) return [];
			const signals = await res.json();
			if (signals.length > 0) {
				lastSignalId = signals[signals.length - 1].id;
			}
			return signals;
		} catch {
			return [];
		}
	}

	function startPolling() {
		pollTimer = setInterval(async () => {
			if (callStatus === 'ended') {
				clearInterval(pollTimer);
				return;
			}

			const signals = await fetchSignals();
			for (const s of signals) {
				if (s.signal_type === 'offer' && callRole === 'responder') {
					// Already handled in waitForOffer, but handle late offers
					await handleOffer(s.signal_data);
				} else if (s.signal_type === 'answer' && callRole === 'initiator') {
					await handleAnswer(s.signal_data);
				} else if (s.signal_type === 'ice-candidate') {
					await handleIceCandidate(s.signal_data);
				}
			}

			// Also check call status (other party may have ended)
			try {
				const res = await fetch(`${API}/api/v1/chat/calls/${callId}`);
				if (res.ok) {
					const call = await res.json();
					if (call.status === 'ended') {
						endCall();
					}
				}
			} catch {}
		}, 1000);
	}

	async function endCall() {
		if (callStatus === 'ended') return;
		if (durationTimer) clearInterval(durationTimer);
		if (pollTimer) clearInterval(pollTimer);
		callStatus = 'ended';

		if (localStream) localStream.getTracks().forEach(t => t.stop());
		if (screenStream) screenStream.getTracks().forEach(t => t.stop());
		if (pc) { pc.close(); pc = null; }

		if (callId) {
			try {
				await fetch(`${API}/api/v1/chat/calls/${callId}/end`, { method: 'POST' });
			} catch {}
		}

		setTimeout(() => window.close(), 2000);
	}

	async function toggleMic() {
		micOn = !micOn;
		if (localStream) {
			localStream.getAudioTracks().forEach(t => { t.enabled = micOn; });
		}
	}

	async function toggleCamera() {
		if (!cameraOn) {
			// Turn camera on
			try {
				const videoStream = await navigator.mediaDevices.getUserMedia({ video: true });
				const videoTrack = videoStream.getVideoTracks()[0];
				if (pc) {
					const senders = pc.getSenders();
					const videoSender = senders.find(s => s.track && s.track.kind === 'video');
					if (videoSender) {
						await videoSender.replaceTrack(videoTrack);
					} else {
						pc.addTrack(videoTrack, localStream || videoStream);
					}
				}
				if (localStream) {
					localStream.addTrack(videoTrack);
				} else {
					localStream = videoStream;
				}
				cameraOn = true;
				requestAnimationFrame(() => {
					if (localVideoEl) localVideoEl.srcObject = localStream;
				});
			} catch (err) {
				console.error('Camera access denied:', err);
				errorMsg = 'Camera access denied';
			}
		} else {
			// Turn camera off
			if (localStream) {
				localStream.getVideoTracks().forEach(t => {
					t.stop();
					localStream.removeTrack(t);
				});
			}
			cameraOn = false;
		}
	}

	async function toggleScreen() {
		if (!screenSharing) {
			try {
				screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
				const screenTrack = screenStream.getVideoTracks()[0];

				// Replace or add screen track
				if (pc) {
					const senders = pc.getSenders();
					const videoSender = senders.find(s => s.track && s.track.kind === 'video');
					if (videoSender) {
						await videoSender.replaceTrack(screenTrack);
					} else {
						pc.addTrack(screenTrack, screenStream);
					}
				}

				screenTrack.onended = () => {
					screenSharing = false;
					// Restore camera if it was on
					if (cameraOn && localStream) {
						const camTrack = localStream.getVideoTracks()[0];
						if (camTrack && pc) {
							const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
							if (sender) sender.replaceTrack(camTrack);
						}
					}
				};

				screenSharing = true;
			} catch (err) {
				console.error('Screen share failed:', err);
			}
		} else {
			if (screenStream) {
				screenStream.getTracks().forEach(t => t.stop());
				screenStream = null;
			}
			screenSharing = false;

			// Restore camera track if on
			if (cameraOn && localStream) {
				const camTrack = localStream.getVideoTracks()[0];
				if (camTrack && pc) {
					const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
					if (sender) sender.replaceTrack(camTrack);
				}
			}
		}
	}

	function formatDuration(s) {
		const m = Math.floor(s / 60);
		const sec = s % 60;
		return `${m}:${sec.toString().padStart(2, '0')}`;
	}

	function sleep(ms) {
		return new Promise(r => setTimeout(r, ms));
	}
</script>

<div class="call-window">
	<div class="call-main">
		{#if cameraOn || screenSharing || (remoteStream && remoteStream.getVideoTracks().length > 0)}
			<div class="call-video-area">
				<!-- Remote video (large) -->
				{#if remoteStream}
					<!-- svelte-ignore a11y_media_has_caption -->
					<video
						bind:this={remoteVideoEl}
						autoplay
						playsinline
						class="remote-video"
					></video>
				{/if}

				<!-- Local video (picture-in-picture) -->
				{#if cameraOn || screenSharing}
					<!-- svelte-ignore a11y_media_has_caption -->
					<video
						bind:this={localVideoEl}
						autoplay
						playsinline
						muted
						class="local-video"
					></video>
				{/if}

				{#if !remoteStream || remoteStream.getVideoTracks().length === 0}
					<div class="video-overlay">
						<div class="call-avatar">{contactName.charAt(0).toUpperCase()}</div>
						<div class="call-name">{contactName}</div>
					</div>
				{/if}
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
				{#if errorMsg}
					<div class="call-error">{errorMsg}</div>
				{/if}
			</div>
		{/if}

		<!-- Hidden audio element for remote audio -->
		{#if remoteStream}
			<audio
				bind:this={remoteAudioEl}
				autoplay
				style="display:none"
			></audio>
		{/if}
	</div>

	<div class="call-controls">
		<button class="call-btn" class:active={micOn} onclick={toggleMic} title={micOn ? 'Mute' : 'Unmute'}>
			<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
				{#if micOn}
					<path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
					<path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
					<line x1="12" y1="19" x2="12" y2="23"/>
					<line x1="8" y1="23" x2="16" y2="23"/>
				{:else}
					<line x1="1" y1="1" x2="23" y2="23"/>
					<path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"/>
					<path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2c0 .76-.13 1.49-.35 2.17"/>
					<line x1="12" y1="19" x2="12" y2="23"/>
					<line x1="8" y1="23" x2="16" y2="23"/>
				{/if}
			</svg>
		</button>
		<button class="call-btn" class:active={cameraOn} onclick={toggleCamera} title={cameraOn ? 'Camera Off' : 'Camera On'}>
			<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
				{#if cameraOn}
					<polygon points="23 7 16 12 23 17 23 7"/>
					<rect x="1" y="5" width="15" height="14" rx="2" ry="2"/>
				{:else}
					<line x1="1" y1="1" x2="23" y2="23"/>
					<path d="M21 21H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h3m3-3h6l2 3h4a2 2 0 0 1 2 2v9.34m-7.72-2.06a4 4 0 1 1-5.56-5.56"/>
				{/if}
			</svg>
		</button>
		<button class="call-btn" class:active={screenSharing} onclick={toggleScreen} title={screenSharing ? 'Stop Sharing' : 'Share Screen'}>
			<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
				<rect x="2" y="3" width="20" height="14" rx="2" ry="2"/>
				<line x1="8" y1="21" x2="16" y2="21"/>
				<line x1="12" y1="17" x2="12" y2="21"/>
			</svg>
		</button>
		<button class="call-btn end" onclick={endCall} title="End Call">
			<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
				<path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91"/>
				<line x1="23" y1="1" x2="1" y2="23"/>
			</svg>
		</button>
	</div>

	{#if callStatus === 'active'}
		<div class="call-duration-bar">
			{formatDuration(callDuration)}
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

	.call-window {
		display: flex;
		flex-direction: column;
		height: 100vh;
		position: relative;
	}

	.call-main {
		flex: 1;
		display: flex;
		align-items: center;
		justify-content: center;
		position: relative;
		overflow: hidden;
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

	.call-error {
		font-size: 14px;
		color: #f38ba8;
		margin-top: 8px;
	}

	.call-video-area {
		width: 100%;
		height: 100%;
		position: relative;
		background: #181825;
	}

	.remote-video {
		width: 100%;
		height: 100%;
		object-fit: contain;
		background: #181825;
	}

	.local-video {
		position: absolute;
		bottom: 16px;
		right: 16px;
		width: 200px;
		height: 150px;
		border-radius: 12px;
		border: 2px solid #313244;
		object-fit: cover;
		background: #1e1e2e;
		z-index: 10;
	}

	.video-overlay {
		position: absolute;
		top: 50%;
		left: 50%;
		transform: translate(-50%, -50%);
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 12px;
	}

	.call-controls {
		display: flex;
		justify-content: center;
		gap: 16px;
		padding: 24px;
		background: #181825;
		border-top: 1px solid #1e1e2e;
		flex-shrink: 0;
		z-index: 20;
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

	.call-duration-bar {
		position: absolute;
		top: 16px;
		left: 50%;
		transform: translateX(-50%);
		background: rgba(17, 17, 27, 0.7);
		backdrop-filter: blur(8px);
		padding: 6px 16px;
		border-radius: 20px;
		font-size: 14px;
		font-weight: 600;
		color: #a6e3a1;
		z-index: 20;
		font-variant-numeric: tabular-nums;
	}

	@media (max-width: 600px) {
		.local-video {
			width: 120px;
			height: 90px;
			bottom: 8px;
			right: 8px;
		}

		.call-btn {
			width: 48px;
			height: 48px;
		}

		.call-controls {
			gap: 12px;
			padding: 16px;
		}
	}
</style>
