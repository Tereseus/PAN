<script>
	import { onMount, tick } from 'svelte';

	const API_BASE = typeof window !== 'undefined' ? window.location.origin : '';

	// ─── View state ───
	let view = $state('mail'); // contacts | mail | calendar
	let loading = $state(true);

	// ─── Contacts state ───
	let contacts = $state([]);
	let contactSearch = $state('');
	let activeContact = $state(null);
	let chatMessages = $state([]);
	let chatInput = $state('');
	let chatThreadId = $state('');
	let messagesEl;

	// ─── Call mode (from ?call=1 URL param — opens via Call button on terminal page) ───
	// v1: indicator + auto-open Π thread. Voice loop (STT in / TTS out) wires in
	// once /api/v1/speak lands; current state surfaces the call to the user and writes
	// a chat_calls row for future telemetry.
	let callActive = $state(false);
	let callId = $state(null);            // chat_calls.id once we POST the call row (follow-up)
	let callStartedAt = $state(null);
	let callElapsed = $state(0);
	let callTimer = null;
	// Voice loop state — continuous VAD (no push-to-talk), behaves like a real phone call
	let micStream = null;                 // MediaStream from getUserMedia
	let micPermission = $state('unknown');// 'granted' | 'denied' | 'prompt' | 'unknown'
	let audioCtx = null;                  // Web Audio context for VAD
	let analyser = null;                  // AnalyserNode for RMS
	let vadRaf = 0;                       // requestAnimationFrame id for VAD loop
	let mediaRecorder = null;
	let micChunks = [];
	let isRecording = $state(false);      // VAD detected speech → recording an utterance
	let isThinking = $state(false);       // STT → router → TTS pipeline in flight
	let isSpeaking = $state(false);       // PAN is currently playing audio
	let voiceError = $state(null);
	let currentAudio = null;
	let voiceMime = 'audio/webm';
	// VAD tuning
	const VAD_SPEECH_RMS    = 0.012;      // threshold to count as speech (0..1)
	// VAD silence threshold — how long after speech goes quiet before we
	// decide the user is done talking and ship the utterance to STT.
	//
	// Sweet spot across languages: 1500ms.
	//   - English: end-of-thought pause is typically 700-1000ms but extended
	//     thinking pauses run 1200-1500ms ("hmm, well…").
	//   - Greek: "ee/eh" hesitation marker runs 1000-1400ms naturally; needs
	//     the headroom or every breath truncates the sentence.
	//   - German: verb-final structure means mid-clause pauses can hit
	//     1200-1800ms before the final verb lands. 1500ms keeps most intact.
	//   - Japanese: cultural turn-taking allows up to 1500ms before
	//     listener jumps in.
	//   - Romance languages (ES/IT/FR): enthusiastic mid-sentence pauses
	//     1000-1400ms.
	//
	// 900ms (old value) was too aggressive — the 2026-06-01 voice test
	// (turn 11) got cut off mid-sentence at "but many of…" because the
	// commander paused for breath before completing the thought, then PAN
	// got a fragment without a question in it and (correctly per the prompt
	// rule) classified it ambient.
	//
	// Industry comparison: Siri ~1200ms, Google Assistant ~1500ms, Alexa
	// ~1000ms+beamforming, OpenAI Realtime ~500ms+semantic-EOT layer.
	// Until we add semantic end-of-turn detection (does the sentence look
	// syntactically complete? if not, extend silence by 500ms), the flat
	// 1500ms is the right universal default.
	const VAD_SILENCE_MS    = 1500;       // silence after speech → end-of-utterance
	const VAD_MIN_SPEECH_MS = 300;        // ignore utterances shorter than this (clicks/coughs)
	const VAD_MAX_UTTER_MS  = 20000;      // safety cap on a single utterance — bumped from 15s
	const PARTIAL_HOLD_MS   = 2000;       // how long to wait for the rest of a sentence
	                                       // when looksIncomplete() flagged the previous
	                                       // utterance. If no follow-on arrives, flush
	                                       // the partial as-is so the user isn't ignored.

	// State for the semantic-EoT deferral. pendingPartial holds the transcript
	// fragment that looked mid-thought; the next handleTurn prepends it.
	let pendingPartial = $state(/** @type {string|null} */ (null));
	let partialDeferredAt = 0;
	let partialFlushTimer = null;
	function flushPartial() {
		if (!pendingPartial) return;
		// Synthesize a handleTurn-equivalent ship: send the partial alone to the
		// router. The micChunks are already empty (we returned them after STT),
		// so we POST directly. Mirror the success-path logic from handleTurn.
		const transcript = pendingPartial;
		pendingPartial = null;
		if (partialFlushTimer) { clearTimeout(partialFlushTimer); partialFlushTimer = null; }
		isThinking = true;
		fetch('/api/v1/chat', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ message: transcript, source: 'voice-call', thread_id: chatThreadId }),
		}).then(r => r.json()).then(routerJson => {
			const reply = (routerJson?.response || '').trim();
			if (reply) {
				const nowMs = Date.now();
				chatMessages = [
					...chatMessages,
					{ id: routerJson?.user_message_id || ('cmsg_local_u_' + nowMs), sender_id: 'self', body: transcript, body_type: 'text', created_at: nowMs },
					{ id: routerJson?.pan_message_id  || ('cmsg_local_p_' + (nowMs + 1)), sender_id: chatThreadId === 'thread-pan-system' ? 'contact-pan-system' : 'pan', body: reply, body_type: 'text', created_at: nowMs + 1, metadata: routerJson?.debug ? { debug: routerJson.debug } : null },
				];
			}
		}).catch(e => { console.warn('[call] partial flush failed:', e?.message); })
		  .finally(() => { isThinking = false; });
	}
	let lastSpeechAt = 0;
	let utterStartedAt = 0;

	// ─── Mail state ───
	let mailItems = $state([]);
	let mailFilter = $state('all'); // all | pan | email
	let mailPage = $state(0);
	let mailStatus = $state(null);
	let selectedMail = $state(null);

	// ─── Calendar state ───
	let calendarEvents = $state([]);
	let calMonth = $state(new Date().getMonth() + 1);
	let calYear = $state(new Date().getFullYear());
	let calSelectedDay = $state(null);

	const TAURI_PORT = 7790;
	const monthNames = ['', 'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

	onMount(() => {
		const params = new URLSearchParams(window.location.search);
		view = params.get('view') || 'mail';
		const initialThread = params.get('thread');
		const callMode = params.get('call') === '1';
		document.title = callMode ? 'Call Π' : view === 'contacts' ? 'Contacts' : view === 'mail' ? 'Mail' : 'Calendar';
		loadData();

		// Auto-open the Π system thread if launched from the terminal Call button.
		if (initialThread === 'thread-pan-system') {
			view = 'contacts';
			(async () => {
				try {
					// Make sure contacts list is populated so the sidebar highlights PAN.
					if (!contacts.length) {
						contacts = await api('/api/v1/chat/contacts');
					}
					const panContact = contacts.find(c => c.id === 'contact-pan-system')
						|| { id: 'contact-pan-system', display_name: 'Π', avatar_url: null };
					activeContact = panContact;
					chatThreadId = 'thread-pan-system';
					const msgs = await api(`/api/v1/chat/threads/${chatThreadId}/messages`);
					chatMessages = Array.isArray(msgs) ? msgs : [];
					await tick();
					if (messagesEl) messagesEl.scrollTop = messagesEl.scrollHeight;
					if (callMode) startCall();
				} catch (e) {
					console.error('Auto-open Π thread failed:', e);
				}
			})();
		}

		// ─── Live polling ───
		// Poll active thread for new messages every 3s; refresh contact list every 10s.
		let pollTick = 0;
		const pollInterval = setInterval(async () => {
			pollTick++;
			// Refresh active thread
			if (chatThreadId) {
				try {
					const msgs = await api(`/api/v1/chat/threads/${chatThreadId}/messages`);
					if (Array.isArray(msgs) && msgs.length !== chatMessages.length) {
						const atBottom = !messagesEl || messagesEl.scrollTop + messagesEl.clientHeight >= messagesEl.scrollHeight - 40;
						chatMessages = msgs;
						if (atBottom) {
							await tick();
							if (messagesEl) messagesEl.scrollTop = messagesEl.scrollHeight;
						}
					}
				} catch {}
			}
			// Refresh contact list + mail unread counts every 10s
			if (pollTick % (10000 / 3000) === 0) {
				try {
					if (view === 'contacts') {
						const fresh = await api('/api/v1/chat/contacts');
						contacts = fresh;
					} else if (view === 'mail') {
						await loadMail();
					}
				} catch {}
			}
		}, 3000);

		return () => clearInterval(pollInterval);
	});

	async function api(path, opts) {
		const res = await fetch(API_BASE + path, opts);
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		return res.json();
	}

	async function loadData() {
		loading = true;
		try {
			if (view === 'contacts') {
				contacts = await api('/api/v1/chat/contacts');
			} else if (view === 'mail') {
				await loadMail();
				try { mailStatus = await api('/api/v1/email/status'); } catch {}
			} else if (view === 'calendar') {
				calendarEvents = await api(`/api/v1/chat/calendar?month=${calMonth}&year=${calYear}`);
			}
		} catch (e) {
			console.error('Load failed:', e);
		}
		loading = false;
	}

	async function loadMail() {
		try {
			const data = await api(`/api/v1/chat/mail?limit=50&offset=${mailPage * 50}&filter=${mailFilter}`);
			mailItems = data.messages || [];
		} catch {
			mailItems = [];
		}
	}

	async function openChat(contact) {
		activeContact = contact;
		try {
			const res = await api('/api/v1/chat/threads/dm', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ contact_id: contact.id })
			});
			chatThreadId = res.thread_id;
			const msgs = await api(`/api/v1/chat/threads/${chatThreadId}/messages`);
			chatMessages = Array.isArray(msgs) ? msgs : [];
			await api(`/api/v1/chat/threads/${chatThreadId}/read`, { method: 'POST' });
			await tick();
			if (messagesEl) messagesEl.scrollTop = messagesEl.scrollHeight;
		} catch (e) {
			console.error('Open chat failed:', e);
		}
	}

	async function sendChat() {
		if (!chatInput.trim() || !chatThreadId) return;
		const body = chatInput.trim();
		chatInput = '';
		try {
			const res = await api(`/api/v1/chat/threads/${chatThreadId}/messages`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ body })
			});
			chatMessages = [...chatMessages, { id: res.id, sender_id: 'self', body, body_type: 'text', created_at: res.created_at }];
			await tick();
			if (messagesEl) messagesEl.scrollTop = messagesEl.scrollHeight;

			// Π persona reply
			if (chatThreadId === 'thread-pan-system') {
				try {
					const reply = await api('/api/v1/chat/pan-reply', {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({ message: body })
					});
					if (reply?.reply) {
						chatMessages = [...chatMessages, {
							id: reply.reply.id,
							sender_id: 'contact-pan-system',
							body: reply.reply.body,
							body_type: 'text',
							created_at: reply.reply.created_at
						}];
						await tick();
						if (messagesEl) messagesEl.scrollTop = messagesEl.scrollHeight;
					}
				} catch (e) {
					console.error('Π reply failed:', e);
				}
			}
		} catch (e) {
			console.error('Send failed:', e);
		}
	}

	// Ship a structured log entry to the server so call failures are visible
	// in /api/v1/logs (otherwise console-only and impossible to debug remotely).
	function shipLog(level, message, meta) {
		try {
			fetch('/api/v1/logs', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					device_id: 'comms-popout',
					device_type: 'browser',
					level,
					source: 'voice-call',
					message,
					meta: meta || {},
				}),
				keepalive: true,
			}).catch(() => {});
		} catch {}
	}

	// ─── Voice call — continuous VAD (NOT push-to-talk) ──────────────────────
	// You speak, PAN listens (silence detection ends each turn), PAN replies,
	// then PAN listens again. Just like a phone call. No buttons.
	//
	// Per-turn pipeline:
	//   1. VAD loop watches mic RMS. Speech detected → start MediaRecorder.
	//   2. After 900ms of silence → stop recorder → upload Opus blob.
	//   3. POST /api/v1/voice/transcribe-browser → whisper text.
	//   4. POST /api/v1/chat (text, source=voice-call) → router reply text.
	//   5. POST /api/v1/voice/speak → WAV → play in popout (mic paused while
	//      PAN talks, so PAN doesn't transcribe its own voice).
	//   6. Resume VAD.

	// Try to acquire mic. Called both from startCall() AND from the explicit
	// "Enable microphone" button (which is always a real user gesture so the
	// browser will pop the permission prompt even in awkward WebView contexts).
	async function enableMic() {
		voiceError = null;
		try {
			micStream = await navigator.mediaDevices.getUserMedia({
				audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 }
			});
			micPermission = 'granted';
			const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/ogg'];
			voiceMime = candidates.find(m => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m)) || 'audio/webm';
			// Spin up AudioContext for VAD
			audioCtx = new (window.AudioContext || window.webkitAudioContext)();
			const src = audioCtx.createMediaStreamSource(micStream);
			analyser = audioCtx.createAnalyser();
			analyser.fftSize = 1024;
			src.connect(analyser);
			// If we're inside an active call already, kick off the listen loop.
			if (callActive) runVAD();
			return true;
		} catch (e) {
			// Silently log — don't surface UI. Mic permission for the Tauri WebView is
			// a separate infra problem; the call still appears active visually.
			micPermission = 'denied';
			console.warn('[call] getUserMedia failed:', e?.name, e?.message);
			return false;
		}
	}

	// Voice-server-status heartbeat — runs while a call is active. The badge
	// state was getting stuck on "Voice server not running" after a transient
	// 503 (e.g. during a Carrier restart) because nothing ever re-checked the
	// server. Now we poll /api/v1/voice/status every 5s: if it returns ok, we
	// clear that specific error so the user can keep talking without
	// restarting the call. Errors from other paths (F5-TTS unavailable,
	// recorder failed) stay sticky on purpose — those need explicit user
	// action.
	let voiceStatusTimer = null;
	async function pollVoiceStatus() {
		try {
			const r = await fetch('/api/v1/voice/status').then(x => x.json()).catch(() => null);
			if (r?.ok && voiceError && /voice server not running/i.test(String(voiceError))) {
				voiceError = null;
			}
		} catch {}
	}

	async function startCall() {
		if (callActive) return;
		voiceError = null;
		callActive = true;
		callStartedAt = Date.now();
		callElapsed = 0;
		callTimer = setInterval(() => {
			callElapsed = Math.floor((Date.now() - callStartedAt) / 1000);
		}, 1000);
		// Kick the voice-status heartbeat so a transient 503 doesn't latch.
		if (voiceStatusTimer) clearInterval(voiceStatusTimer);
		pollVoiceStatus();
		voiceStatusTimer = setInterval(pollVoiceStatus, 5000);
		// Auto-acquire mic. This was triggered by the user clicking the Call
		// button (same user-gesture chain), so most browsers will allow getUserMedia.
		// If the WebView blocked it, the popout will show an explicit Enable button.
		await enableMic();
		// Best-effort: create a chat_calls row so call history is preserved.
		try {
			const r = await api(`/api/v1/chat/threads/${chatThreadId}/calls`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ type: 'voice', initiator: 'self' })
			});
			callId = r?.call_id || null;
		} catch (e) {
			console.warn('[call] chat_calls row creation skipped:', e?.message);
		}
	}

	async function endCall() {
		if (!callActive) return;
		callActive = false;
		// Stop VAD loop
		if (vadRaf) { cancelAnimationFrame(vadRaf); vadRaf = 0; }
		// Stop any in-flight recording cleanly
		if (mediaRecorder && mediaRecorder.state !== 'inactive') {
			try { mediaRecorder.stop(); } catch {}
		}
		mediaRecorder = null;
		micChunks = [];
		isRecording = false;
		isThinking = false;
		isSpeaking = false;
		// Tear down audio context
		if (audioCtx) { try { audioCtx.close(); } catch {} audioCtx = null; analyser = null; }
		// Release mic
		if (micStream) {
			try { micStream.getTracks().forEach(t => t.stop()); } catch {}
			micStream = null;
		}
		// Cancel any in-flight PAN reply audio
		if (currentAudio) {
			try { currentAudio.pause(); currentAudio.src = ''; } catch {}
			currentAudio = null;
		}
		if (callTimer) { clearInterval(callTimer); callTimer = null; }
		// Stop voice-status heartbeat too. If it's running when the user
		// hangs up we'd keep polling a server they no longer care about.
		if (voiceStatusTimer) { clearInterval(voiceStatusTimer); voiceStatusTimer = null; }
		const duration = callStartedAt ? Date.now() - callStartedAt : 0;
		try {
			if (callId) {
				await api(`/api/v1/chat/calls/${callId}/end`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ duration_ms: duration })
				});
			}
		} catch {}
		callId = null;
		callStartedAt = null;
	}

	// VAD loop — runs while callActive + mic available + not currently thinking/speaking.
	// When user speech is detected we start a MediaRecorder; when silence
	// follows for VAD_SILENCE_MS we stop it and ship the utterance.
	function runVAD() {
		if (!callActive || !analyser) return;
		const buf = new Float32Array(analyser.fftSize);
		const tick = () => {
			if (!callActive || !analyser) return;
			vadRaf = requestAnimationFrame(tick);
			// Don't listen while PAN is talking (avoid feedback)
			// or while we're processing a previous turn (back-pressure).
			if (isSpeaking || isThinking) return;

			analyser.getFloatTimeDomainData(buf);
			let sumSq = 0;
			for (let i = 0; i < buf.length; i++) sumSq += buf[i] * buf[i];
			const rms = Math.sqrt(sumSq / buf.length);

			const now = Date.now();
			const speaking = rms > VAD_SPEECH_RMS;

			if (speaking) lastSpeechAt = now;

			if (!isRecording && speaking) {
				// Start a new utterance
				try {
					mediaRecorder = new MediaRecorder(micStream, { mimeType: voiceMime });
					micChunks = [];
					mediaRecorder.ondataavailable = (ev) => { if (ev.data && ev.data.size > 0) micChunks.push(ev.data); };
					mediaRecorder.onstop = () => { void handleTurn(); };
					mediaRecorder.start(250);
					isRecording = true;
					utterStartedAt = now;
				} catch (e) {
					voiceError = 'Recorder failed: ' + (e?.message || e);
				}
			} else if (isRecording) {
				const utterMs    = now - utterStartedAt;
				const silenceMs  = now - lastSpeechAt;
				const hitSilence = silenceMs >= VAD_SILENCE_MS && utterMs >= VAD_MIN_SPEECH_MS;
				const hitMax     = utterMs >= VAD_MAX_UTTER_MS;
				if (hitSilence || hitMax) {
					try { mediaRecorder.stop(); } catch {}
					isRecording = false;
				}
			}
		};
		vadRaf = requestAnimationFrame(tick);
	}

	// Language-agnostic semantic end-of-turn detection.
	//
	// Whisper inserts terminal punctuation (. ! ? 。 ?) correctly across all
	// 99 languages it supports, so checking the punctuation at transcript
	// tail is a free signal. Function-word length (conjunctions, prepositions,
	// articles) clusters at 1-3 chars across nearly every language family —
	// Indo-European ("and", "y", "ή", "und", "и"), Sinitic ("和", "但"),
	// Japonic ("が", "から"), Slavic ("и", "но"), Afro-Asiatic ("و", "و"),
	// Dravidian ("మరియు" is longer but the language uses verb-final particles
	// that hit the heuristic differently — accept the false negative there).
	//
	// We don't hardcode any word lists — those don't generalize. Just two
	// universal cues: terminal punctuation, and short trailing word with no
	// terminal mark. Erring on the side of "looks incomplete" is cheap (we
	// wait an extra second); erring on "looks complete" cuts the user off.
	function looksIncomplete(transcript) {
		if (!transcript) return false;
		const t = transcript.trim();
		// Final punctuation present → Whisper is confident this was a complete
		// sentence in whatever language it heard. Treat as complete.
		if (/[.!?。?！…]$/.test(t)) return false;
		// Continuation marks (comma, semicolon, Arabic comma, Chinese enumeration
		// comma, etc.) → user paused but signaled there's more coming.
		if (/[,;:،、；：]$/.test(t)) return true;
		// No ending punctuation. Last "word" heuristic — if it's a tiny token
		// (1-3 chars) with no leading uppercase/initial-cap (proper-name guard
		// for languages with capitalization), it's likely a conjunction or
		// preposition the user hasn't completed past yet. Many CJK languages
		// have NO whitespace tokenization at all, so .split fails gracefully
		// and returns the whole string as one "word" — in that case fall back
		// to the length-of-whole-thing check (very short utterance → assume
		// incomplete, give it more time).
		const lastWord = t.split(/\s+/).pop() || '';
		if (lastWord && lastWord.length <= 3 && lastWord === lastWord.toLowerCase()) {
			return true;
		}
		// CJK / no-space fallback: if the whole transcript is < 6 chars and
		// has no terminal punct, it's almost certainly mid-thought.
		if (t.length < 6 && !/\s/.test(t)) return true;
		return false;
	}

	async function handleTurn() {
		if (!micChunks.length) { return; }
		isThinking = true;
		const blob = new Blob(micChunks, { type: voiceMime });
		micChunks = [];
		// Clear the "Voice server not running" badge at the start of each turn
		// so a single transient 503 from earlier doesn't latch forever. If THIS
		// turn fails the same way, the catch will set it again. Errors from
		// other paths (F5-TTS, recorder, network) still latch — they need
		// explicit user attention.
		if (voiceError && /voice server not running/i.test(String(voiceError))) {
			voiceError = null;
		}
		try {
			// 1. STT
			const sttRes = await fetch('/api/v1/voice/transcribe-browser', {
				method: 'POST',
				headers: { 'Content-Type': blob.type || 'audio/webm' },
				body: blob,
			});
			const stt = await sttRes.json();
			if (!sttRes.ok) throw new Error(stt.error || 'STT failed');
			let transcript = (stt.text || '').trim();
			if (!transcript) { isThinking = false; return; } // silence / noise — keep listening

			// Semantic EoT check — if the transcript looks like the user paused
			// mid-thought (no terminal punctuation + trailing function-word, OR
			// trailing comma/semicolon), DON'T ship to router yet. Instead,
			// stash the partial and let VAD listen for ~2s more. The next
			// utterance (if any) will be prepended with this partial so the
			// router sees the joined thought as one turn.
			//
			// Skip the deferral if we ALREADY deferred on the previous turn
			// (don't loop forever) — at that point we've waited 2s, treat the
			// joined text as the final thing whether complete-looking or not.
			if (looksIncomplete(transcript) && !pendingPartial) {
				pendingPartial = transcript;
				partialDeferredAt = Date.now();
				// Auto-flush after PARTIAL_HOLD_MS in case the user is just
				// genuinely done and there's no follow-on utterance. Without
				// this, an incomplete-looking final word would hang forever.
				if (partialFlushTimer) clearTimeout(partialFlushTimer);
				partialFlushTimer = setTimeout(() => flushPartial(), PARTIAL_HOLD_MS);
				isThinking = false;
				return;
			}
			// If we DO have a pending partial, prepend it. Two pauses joined
			// into one logical turn for the router.
			if (pendingPartial) {
				transcript = pendingPartial + ' ' + transcript;
				pendingPartial = null;
				if (partialFlushTimer) { clearTimeout(partialFlushTimer); partialFlushTimer = null; }
			}

			// 2. Router
			const routerRes = await fetch('/api/v1/chat', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ message: transcript, source: 'voice-call', thread_id: chatThreadId }),
			});
			const routerJson = await routerRes.json();
			const reply = (routerJson?.response || '').trim();
			if (!reply) throw new Error('empty router reply');

			// Append both turns to the visible chat immediately. Server has
			// already persisted them (via /api/v1/chat thread_id branch), so
			// the 3-second poll will reconcile — but appending locally avoids
			// the visible delay so the user sees the conversation form in
			// real time as they talk.
			const nowMs = Date.now();
			chatMessages = [
				...chatMessages,
				{
					id: routerJson?.user_message_id || ('cmsg_local_u_' + nowMs),
					sender_id: 'self',
					body: transcript,
					body_type: 'text',
					created_at: nowMs,
				},
				{
					id: routerJson?.pan_message_id || ('cmsg_local_p_' + (nowMs + 1)),
					sender_id: chatThreadId === 'thread-pan-system' ? 'contact-pan-system' : 'pan',
					body: reply,
					body_type: 'text',
					created_at: nowMs + 1,
					// Attach the router's debug trace (intent, model, latency,
					// intuition snapshot, recent mind, reasoning) so the bubble
					// can render a 🧠 disclosure right under the reply. Already
					// persisted server-side in chat_messages.metadata.debug, so
					// poll-refresh keeps showing it.
					metadata: routerJson?.debug ? { debug: routerJson.debug } : null,
				},
			];
			await tick();
			if (messagesEl) messagesEl.scrollTop = messagesEl.scrollHeight;

			// 3. TTS — try F5-TTS first; on any failure (no reference WAV uploaded,
			// worker offline, etc.) fall back to the browser's built-in
			// SpeechSynthesis so PAN can still talk back instead of silently
			// dropping the reply. Mark isSpeaking so VAD pauses either way.
			let ttsPlayed = false;
			try {
				const ttsRes = await fetch('/api/v1/voice/speak', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ text: reply, voice: 'arnold' }),
				});
				if (ttsRes.ok) {
					const audioBlob = await ttsRes.blob();
					const url = URL.createObjectURL(audioBlob);
					if (currentAudio) { try { currentAudio.pause(); } catch {} }
					currentAudio = new Audio(url);
					isSpeaking = true;
					currentAudio.onended = () => {
						try { URL.revokeObjectURL(url); } catch {}
						isSpeaking = false;
					};
					await currentAudio.play().catch(() => { isSpeaking = false; });
					ttsPlayed = true;
				} else {
					// Capture server error so the call banner can show it
					let detail = `HTTP ${ttsRes.status}`;
					try { const j = await ttsRes.json(); if (j?.error) detail = j.error; } catch {}
					voiceError = `F5-TTS: ${detail} — using browser voice`;
					console.warn('[call] F5-TTS unavailable:', detail);
					shipLog('warn', 'F5-TTS unavailable, falling back to browser voice', { detail });
				}
			} catch (e) {
				voiceError = `F5-TTS network error — using browser voice`;
				console.warn('[call] F5-TTS fetch failed:', e?.message);
			}
			if (!ttsPlayed) {
				// Browser SpeechSynthesis fallback. Works in any WebView with
				// audio enabled; no server reference WAV required.
				try {
					if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
						const u = new SpeechSynthesisUtterance(reply);
						u.rate = 1.0;
						u.pitch = 1.0;
						isSpeaking = true;
						u.onend = () => { isSpeaking = false; };
						u.onerror = () => { isSpeaking = false; };
						window.speechSynthesis.cancel();
						window.speechSynthesis.speak(u);
						// Fallback worked — clear the F5-TTS error so the banner
						// stops showing red. We are intentionally not speaking
						// Arnold; that's not a failure.
						voiceError = null;
					} else {
						voiceError = 'No TTS available in this window';
					}
				} catch (e) {
					voiceError = 'Browser TTS failed: ' + (e?.message || e);
					console.warn('[call] browser TTS failed:', e);
				}
			}
		} catch (e) {
			voiceError = e?.message || 'Voice turn failed';
			console.error('[call] turn failed:', e);
			shipLog('error', 'voice turn failed', { msg: e?.message || String(e) });
		} finally {
			isThinking = false;
		}
	}

	function formatCallElapsed(s) {
		const m = Math.floor(s / 60);
		const sec = s % 60;
		return `${m}:${sec.toString().padStart(2, '0')}`;
	}

	async function openCompose(contact = null, subject = '', email = '') {
		const params = new URLSearchParams();
		if (contact) {
			params.set('contact', contact.id);
			params.set('name', contact.display_name);
			if (contact.email) params.set('email', contact.email);
		} else if (email) {
			params.set('email', email);
		}
		if (subject) params.set('subject', subject);

		const composeUrl = `${API_BASE}/v2/compose?${params.toString()}`;
		try {
			await fetch(`http://127.0.0.1:${TAURI_PORT}/open`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ url: composeUrl, title: 'Compose', width: 640, height: 520 })
			});
		} catch {
			window.open(composeUrl, '_blank', 'width=640,height=520');
		}
	}

	async function syncMail() {
		loading = true;
		try {
			await api('/api/v1/email/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ folder: 'INBOX' }) });
			await loadMail();
		} catch (e) { console.error('Sync failed:', e); }
		loading = false;
	}

	// Pull the `debug` blob out of a chat message, regardless of whether
	// metadata is stored as an object (local append) or a JSON string (DB poll).
	// Returns null when there's no debug trace — so non-PAN/legacy bubbles
	// don't render an empty 🧠 disclosure.
	function extractDebug(msg) {
		try {
			const meta = msg?.metadata;
			if (!meta) return null;
			const m = typeof meta === 'string' ? JSON.parse(meta) : meta;
			return m && m.debug ? m.debug : null;
		} catch { return null; }
	}

	function formatDate(ts) {
		if (!ts) return '';
		// SQLite datetime('now') returns "2026-04-22 21:13:10" (UTC, no timezone suffix).
		// V8/Chromium parses space-separated datetimes as LOCAL time — append 'Z' to force UTC.
		const normalized = typeof ts === 'string' ? ts.replace(' ', 'T').replace(/Z?$/, 'Z') : ts;
		const d = new Date(normalized);
		const now = new Date();
		if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
		return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
	}

	function filteredContacts() {
		if (!contactSearch) return contacts;
		const q = contactSearch.toLowerCase();
		return contacts.filter(c => c.display_name.toLowerCase().includes(q) || (c.email && c.email.toLowerCase().includes(q)));
	}

	// Calendar helpers
	function daysInMonth(y, m) { return new Date(y, m, 0).getDate(); }
	function firstDayOfWeek(y, m) { return new Date(y, m - 1, 1).getDay(); }
	function eventsOnDay(day) {
		const dayStart = new Date(calYear, calMonth - 1, day).getTime();
		const dayEnd = dayStart + 86400000;
		return calendarEvents.filter(e => e.starts_at >= dayStart && e.starts_at < dayEnd);
	}
	function isToday(day) {
		const now = new Date();
		return day === now.getDate() && calMonth === now.getMonth() + 1 && calYear === now.getFullYear();
	}
</script>

<div class="comms-app">
	<!-- Header -->
	<div class="app-header">
		<span class="app-logo">{'\u03A0\u0391\u039D'}</span>
		<div class="tab-bar">
			<button class="tab" class:active={view === 'contacts'} onclick={() => { view = 'contacts'; document.title = 'Contacts'; loadData(); }}>Contacts</button>
			<button class="tab" class:active={view === 'mail'} onclick={() => { view = 'mail'; document.title = 'Mail'; loadData(); }}>Mail</button>
			<button class="tab" class:active={view === 'calendar'} onclick={() => { view = 'calendar'; document.title = 'Calendar'; loadData(); }}>Calendar</button>
		</div>
	</div>

	<!-- CONTACTS VIEW -->
	{#if view === 'contacts'}
		<div class="split-view">
			<div class="list-pane">
				<div class="toolbar">
					<input type="text" class="search-input" placeholder="Search contacts..." bind:value={contactSearch} />
					<button class="tool-btn" onclick={() => openCompose()} title="Compose">{'\uD83D\uDCDD'}</button>
				</div>
				{#each filteredContacts() as contact}
					<div class="list-row" class:active={activeContact?.id === contact.id} onclick={() => openChat(contact)} role="button" tabindex="0">
						<span class="avatar">{contact.display_name.charAt(0).toUpperCase()}</span>
						<div class="row-info">
							<div class="row-name">
								{contact.display_name}
								{#if contact.unread_count > 0}<span class="badge">{contact.unread_count}</span>{/if}
							</div>
							<div class="row-sub">{contact.email || contact.phone || contact.pan_instance_id || ''}</div>
						</div>
						{#if contact.favorited}<span class="fav">&#9733;</span>{/if}
					</div>
				{/each}
				{#if contacts.length === 0 && !loading}
					<div class="empty">No contacts yet</div>
				{/if}
			</div>

			<div class="detail-pane">
				{#if activeContact}
					<div class="detail-header">
						<span class="avatar lg">{activeContact.display_name.charAt(0).toUpperCase()}</span>
						<div>
							<div class="detail-name">{activeContact.display_name}</div>
							<div class="detail-sub">{activeContact.email || activeContact.pan_instance_id || ''}</div>
						</div>
						{#if !callActive}
							<button class="tool-btn call-tool-btn" onclick={startCall} title="Start voice call">{'\uD83D\uDCDE'}</button>
						{/if}
						<button class="tool-btn compose-btn" onclick={() => openCompose(activeContact)} title="Compose to this contact">{'\uD83D\uDCDD'}</button>
					</div>
					{#if callActive}
						<div class="call-banner">
							<span class="call-dot" class:thinking={isThinking} class:recording={isRecording} class:speaking={isSpeaking}></span>
							<span class="call-label">
								{#if isSpeaking}Π speaking… {formatCallElapsed(callElapsed)}
								{:else if isThinking}Thinking… {formatCallElapsed(callElapsed)}
								{:else if isRecording}Listening… {formatCallElapsed(callElapsed)}
								{:else}Live call · {formatCallElapsed(callElapsed)}{/if}
							</span>
							{#if voiceError}
								<span class="call-err" title={voiceError}>⚠ {voiceError}</span>
							{/if}
							<button class="end-call-btn" onclick={endCall} title="End call">End</button>
						</div>
					{/if}
					<div class="chat-messages" bind:this={messagesEl}>
						{#each chatMessages as msg}
							{#if msg.body_type === 'pan_intuition_trace'}
								<!-- Collapsible intuition trace: PAN's reasoning shown inline,
								     same idea as Claude tool-call rendering. Click to expand. -->
								<details class="intuition-trace">
									<summary>{'\uD83E\uDDE0'} PAN intuition · {formatDate(msg.created_at)}</summary>
									<pre class="intuition-body">{msg.body}</pre>
								</details>
							{:else}
								<div class="chat-bubble" class:self={msg.sender_id === 'self'}>
									<div class="bubble-text">{msg.body}</div>
									<div class="bubble-time">{formatDate(msg.created_at)}</div>
								</div>
								{#if msg.sender_id !== 'self'}
									{@const dbg = extractDebug(msg)}
									{#if dbg}
										<details class="why-trace">
											<summary>
												{'\uD83E\uDDE0'}
												<span class="why-chip">{dbg.intent || '?'}</span>
												<span class="why-chip">{dbg.model || '?'}</span>
												<span class="why-chip">{dbg.total_latency_ms != null ? (dbg.total_latency_ms + 'ms') : '?'}</span>
												{#if dbg.why}<span class="why-summary">— {dbg.why}</span>{/if}
											</summary>
											<div class="why-body">
												{#if dbg.why}
													<div class="why-section"><div class="why-h">Reasoning</div><div class="why-p">{dbg.why}</div></div>
												{/if}
												{#if dbg.situation}
													<div class="why-section">
														<div class="why-h">Intuition snapshot</div>
														<pre class="why-pre">{JSON.stringify(dbg.situation, null, 2)}</pre>
													</div>
												{/if}
												{#if dbg.mind}
													<div class="why-section">
														<div class="why-h">PAN's-Mind</div>
														<p class="why-p why-mind-synth">{dbg.mind}</p>
													</div>
												{/if}
												{#if dbg.conversation}
													<div class="why-section">
														<div class="why-h">Conversational state</div>
														<div class="why-cs">
															{#if dbg.conversation.topic}<div><b>topic</b> {dbg.conversation.topic}</div>{/if}
															{#if dbg.conversation.phase}<div><b>phase</b> {dbg.conversation.phase}</div>{/if}
															{#if dbg.conversation.pending_question}<div><b>pending Q</b> {dbg.conversation.pending_question}</div>{/if}
															{#if dbg.conversation.user_pattern}<div><b>user pattern</b> {dbg.conversation.user_pattern}</div>{/if}
															{#if dbg.conversation.likely_turn_complete != null}<div><b>turn complete</b> {String(dbg.conversation.likely_turn_complete)}</div>{/if}
															{#if dbg.conversation.summary}<div class="why-cs-wide"><b>summary</b> {dbg.conversation.summary}</div>{/if}
															{#if dbg.conversation.distilled_at}<div class="why-cs-meta">distilled {formatDate(dbg.conversation.distilled_at)}{dbg.conversation.latency_ms != null ? ` · ${dbg.conversation.latency_ms}ms` : ''}</div>{/if}
														</div>
													</div>
												{/if}
												{#if dbg.skill_matched}
													<div class="why-section">
														<div class="why-h">Skill matched</div>
														<pre class="why-pre">{JSON.stringify(dbg.skill_matched, null, 2)}</pre>
													</div>
												{/if}
												<div class="why-section">
													<div class="why-h">Timings</div>
													<div class="why-p">
														ai: {dbg.ai_latency_ms ?? '?'}ms · total: {dbg.total_latency_ms ?? '?'}ms · source: {dbg.source || '?'} · recall: {dbg.recall_hit ? 'hit' : 'miss'}
													</div>
												</div>
												{#if dbg.raw_response}
													<div class="why-section">
														<div class="why-h">Raw model output</div>
														<pre class="why-pre">{dbg.raw_response}</pre>
													</div>
												{/if}
												{#if dbg.error}
													<div class="why-section why-err">
														<div class="why-h">Error</div>
														<div class="why-p">{dbg.error}</div>
													</div>
												{/if}
											</div>
										</details>
									{/if}
								{/if}
							{/if}
						{/each}
						{#if chatMessages.length === 0}
							<div class="empty">No messages yet</div>
						{/if}
					</div>
					<div class="chat-input-bar">
						<textarea
							class="chat-input"
							placeholder="Type a message..."
							bind:value={chatInput}
							rows="1"
							onkeydown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); } }}
						></textarea>
						<button class="send-btn" onclick={sendChat} disabled={!chatInput.trim()}>Send</button>
					</div>
				{:else}
					<div class="empty-detail">Select a contact to start chatting</div>
				{/if}
			</div>
		</div>

	<!-- MAIL VIEW -->
	{:else if view === 'mail'}
		<div class="split-view">
			<div class="list-pane mail-list-pane">
				<div class="toolbar">
					<div class="filter-tabs">
						<button class="filter-tab" class:active={mailFilter === 'all'} onclick={() => { mailFilter = 'all'; loadMail(); }}>All</button>
						<button class="filter-tab" class:active={mailFilter === 'pan'} onclick={() => { mailFilter = 'pan'; loadMail(); }}>PAN</button>
						<button class="filter-tab" class:active={mailFilter === 'email'} onclick={() => { mailFilter = 'email'; loadMail(); }}>Email</button>
					</div>
					<button class="tool-btn" onclick={syncMail} title="Sync" disabled={loading}>&#x21BB;</button>
					<button class="tool-btn" onclick={() => openCompose()} title="Compose">{'\uD83D\uDCDD'}</button>
				</div>
				{#each mailItems as item}
					<div class="list-row mail-row" class:unread={!item.read} class:active={selectedMail?.id === item.id} onclick={() => { selectedMail = item; }} role="button" tabindex="0">
						<span class="type-icon" class:pan={item.channel === 'pan'} class:email={item.channel === 'email'}>
							{item.channel === 'pan' ? '\u25C6' : '\u2709'}
						</span>
						<div class="row-info">
							<div class="row-name">{item.direction === 'sent' ? `To: ${item.to}` : item.from}</div>
							{#if item.subject}<div class="row-subject">{item.subject}</div>{/if}
							<div class="row-sub">{item.preview || ''}</div>
						</div>
						<span class="row-date">{formatDate(item.date)}</span>
					</div>
				{/each}
				{#if mailItems.length === 0 && !loading}
					<div class="empty">No messages</div>
				{/if}
			</div>

			<div class="detail-pane">
				{#if selectedMail}
					<div class="detail-header">
						<div>
							<div class="detail-name">{selectedMail.direction === 'sent' ? `To: ${selectedMail.to}` : selectedMail.from}</div>
							{#if selectedMail.subject}<div class="detail-subject">{selectedMail.subject}</div>{/if}
							<div class="detail-sub">{formatDate(selectedMail.date)} &middot; via {selectedMail.channel === 'pan' ? 'PAN' : 'Email'}</div>
						</div>
						<button class="tool-btn" onclick={() => openCompose(null, selectedMail.subject ? 'Re: ' + selectedMail.subject : '', selectedMail.from_address || selectedMail.from || '')} title="Reply">&#x21A9;</button>
					</div>
					<div class="detail-body">
						<p>{selectedMail.preview || '(no content)'}</p>
					</div>
				{:else}
					<div class="empty-detail">Select a message to read</div>
				{/if}
			</div>
		</div>

	<!-- CALENDAR VIEW -->
	{:else if view === 'calendar'}
		<div class="calendar-view">
			<div class="toolbar cal-toolbar">
				<button class="tool-btn" onclick={() => { calMonth--; if (calMonth < 1) { calMonth = 12; calYear--; } calSelectedDay = null; loadData(); }}>&larr;</button>
				<span class="cal-title">{monthNames[calMonth]} {calYear}</span>
				<button class="tool-btn" onclick={() => { calMonth++; if (calMonth > 12) { calMonth = 1; calYear++; } calSelectedDay = null; loadData(); }}>&rarr;</button>
			</div>
			<div class="cal-grid-wrap">
				<div class="cal-grid">
					<span class="cal-dow">Sun</span><span class="cal-dow">Mon</span><span class="cal-dow">Tue</span><span class="cal-dow">Wed</span><span class="cal-dow">Thu</span><span class="cal-dow">Fri</span><span class="cal-dow">Sat</span>
					{#each Array(firstDayOfWeek(calYear, calMonth)) as _}
						<span class="cal-blank"></span>
					{/each}
					{#each Array(daysInMonth(calYear, calMonth)) as _, i}
						{@const day = i + 1}
						{@const hasEvents = eventsOnDay(day).length > 0}
						<button
							class="cal-day"
							class:today={isToday(day)}
							class:has-events={hasEvents}
							class:selected={calSelectedDay === day}
							onclick={() => { calSelectedDay = day; }}
						>
							<span class="cal-day-num">{day}</span>
							{#if hasEvents}
								<span class="cal-dot"></span>
							{/if}
						</button>
					{/each}
				</div>
			</div>
			{#if calSelectedDay}
				<div class="cal-day-detail">
					<div class="cal-day-title">{monthNames[calMonth]} {calSelectedDay}, {calYear}</div>
					{#each eventsOnDay(calSelectedDay) as ev}
						<div class="event-row">
							<div class="event-color" style="background: {ev.color || '#89b4fa'}"></div>
							<div class="event-info">
								<div class="event-title">{ev.title}</div>
								<div class="event-time">{formatDate(ev.starts_at)}{ev.ends_at ? ' - ' + formatDate(ev.ends_at) : ''}</div>
								{#if ev.description}<div class="event-desc">{ev.description}</div>{/if}
							</div>
						</div>
					{/each}
					{#if eventsOnDay(calSelectedDay).length === 0}
						<div class="empty sm">No events this day</div>
					{/if}
				</div>
			{:else}
				<div class="cal-upcoming">
					{#if calendarEvents.length > 0}
						<div class="cal-day-title">Events this month</div>
						{#each calendarEvents as ev}
							<div class="event-row">
								<div class="event-color" style="background: {ev.color || '#89b4fa'}"></div>
								<div class="event-info">
									<div class="event-title">{ev.title}</div>
									<div class="event-time">{formatDate(ev.starts_at)}</div>
								</div>
							</div>
						{/each}
					{:else if !loading}
						<div class="empty sm">No events this month</div>
					{/if}
				</div>
			{/if}
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

	.comms-app {
		display: flex;
		flex-direction: column;
		height: 100vh;
	}

	/* ─── Header ─── */
	.app-header {
		display: flex;
		align-items: center;
		gap: 16px;
		padding: 0 16px;
		background: #181825;
		border-bottom: 1px solid #1e1e2e;
		flex-shrink: 0;
	}
	.app-logo {
		font-size: 18px;
		font-weight: 800;
		color: #89b4fa;
		letter-spacing: 2px;
	}

	/* ─── Tab bar ─── */
	.tab-bar {
		display: flex;
		gap: 0;
	}
	.tab {
		padding: 12px 24px;
		background: none;
		border: none;
		color: #6c7086;
		font-size: 13px;
		font-weight: 500;
		cursor: pointer;
		border-bottom: 2px solid transparent;
	}
	.tab:hover { color: #cdd6f4; }
	.tab.active { color: #89b4fa; border-bottom-color: #89b4fa; }

	/* ─── Split view ─── */
	.split-view {
		flex: 1;
		display: flex;
		min-height: 0;
	}
	.list-pane {
		width: 320px;
		border-right: 1px solid #1e1e2e;
		display: flex;
		flex-direction: column;
		overflow-y: auto;
	}
	.mail-list-pane { width: 380px; }
	.detail-pane {
		flex: 1;
		display: flex;
		flex-direction: column;
		min-width: 0;
	}

	/* ─── Toolbar ─── */
	.toolbar {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 8px 12px;
		border-bottom: 1px solid #1e1e2e;
		flex-shrink: 0;
	}
	.search-input {
		flex: 1;
		background: #1e1e2e;
		border: 1px solid #313244;
		border-radius: 6px;
		color: #cdd6f4;
		padding: 6px 10px;
		font-size: 12px;
		outline: none;
	}
	.search-input:focus { border-color: #89b4fa; }
	.tool-btn {
		background: #1e1e2e;
		border: 1px solid #313244;
		color: #6c7086;
		padding: 4px 10px;
		border-radius: 6px;
		cursor: pointer;
		font-size: 14px;
	}
	.tool-btn:hover { color: #cdd6f4; border-color: #45475a; }

	/* ─── Filter tabs ─── */
	.filter-tabs { display: flex; gap: 2px; flex: 1; }
	.filter-tab {
		background: none; border: 1px solid transparent; color: #6c7086;
		padding: 4px 12px; border-radius: 4px; font-size: 11px; cursor: pointer;
	}
	.filter-tab:hover { color: #cdd6f4; }
	.filter-tab.active { background: #313244; color: #89b4fa; border-color: #45475a; }

	/* ─── List rows ─── */
	.list-row {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 10px 12px;
		cursor: pointer;
		border-bottom: 1px solid #181825;
		transition: background 0.1s;
	}
	.list-row:hover { background: #1e1e2e; }
	.list-row.active { background: #313244; }
	.list-row.unread { border-left: 3px solid #89b4fa; }
	.avatar {
		width: 32px; height: 32px; border-radius: 50%; background: #585b70;
		display: flex; align-items: center; justify-content: center;
		font-size: 14px; font-weight: 600; flex-shrink: 0;
	}
	.avatar.lg { width: 40px; height: 40px; font-size: 18px; }
	.row-info { flex: 1; min-width: 0; }
	.row-name {
		font-size: 13px; font-weight: 500; color: #cdd6f4;
		white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
	}
	.row-subject {
		font-size: 12px; color: #a6adc8;
		white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
	}
	.row-sub {
		font-size: 11px; color: #6c7086;
		white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
	}
	.row-date { font-size: 10px; color: #6c7086; flex-shrink: 0; }
	.badge {
		background: #f38ba8; color: #11111b; font-size: 10px; font-weight: 700;
		padding: 1px 5px; border-radius: 8px; margin-left: 4px;
	}
	.fav { color: #f9e2af; font-size: 12px; }
	.type-icon { font-size: 14px; color: #6c7086; flex-shrink: 0; }
	.type-icon.pan { color: #a6e3a1; }
	.type-icon.email { color: #89b4fa; }
	.list-row.unread .row-name { font-weight: 700; }

	/* ─── Detail pane ─── */
	.detail-header {
		display: flex; align-items: center; gap: 12px;
		padding: 12px 16px; border-bottom: 1px solid #1e1e2e;
		flex-shrink: 0;
	}
	.detail-name { font-size: 15px; font-weight: 600; }
	.detail-subject { font-size: 13px; color: #a6adc8; margin-top: 2px; }
	.detail-sub { font-size: 11px; color: #6c7086; margin-top: 2px; }
	.compose-btn { margin-left: auto; }
	.detail-body { flex: 1; padding: 16px; overflow-y: auto; font-size: 13px; line-height: 1.6; color: #bac2de; }
	.empty-detail {
		flex: 1; display: flex; align-items: center; justify-content: center;
		color: #6c7086; font-size: 14px;
	}
	.empty { padding: 24px; text-align: center; color: #6c7086; font-size: 13px; }
	.empty.sm { padding: 16px; font-size: 12px; }

	/* ─── Chat messages ─── */
	.chat-messages {
		flex: 1; overflow-y: auto; padding: 12px 16px;
		display: flex; flex-direction: column; gap: 6px;
	}
	.chat-bubble {
		max-width: 70%; padding: 8px 12px; border-radius: 12px; word-break: break-word;
		align-self: flex-start; background: #313244;
	}
	.chat-bubble.self {
		align-self: flex-end; background: #45475a;
		border-bottom-right-radius: 4px;
	}
	.chat-bubble:not(.self) { border-bottom-left-radius: 4px; }
	.bubble-text { font-size: 13px; line-height: 1.4; }
	.bubble-time { font-size: 10px; color: #6c7086; margin-top: 2px; text-align: right; }

	.chat-input-bar {
		display: flex; gap: 8px; padding: 10px 16px; border-top: 1px solid #1e1e2e; flex-shrink: 0;
	}
	.chat-input {
		flex: 1; background: #1e1e2e; border: 1px solid #313244; border-radius: 8px;
		color: #cdd6f4; padding: 8px 12px; font-size: 13px; font-family: inherit; outline: none; resize: none;
	}
	.chat-input:focus { border-color: #89b4fa; }
	.send-btn {
		background: #89b4fa; color: #11111b; border: none; padding: 8px 16px;
		border-radius: 8px; font-size: 13px; font-weight: 600; cursor: pointer;
	}
	.send-btn:hover:not(:disabled) { background: #74c7ec; }
	.send-btn:disabled { opacity: 0.4; cursor: not-allowed; }

	/* ─── Call banner (visible while ?call=1 voice session is active) ─── */
	.call-banner {
		display: flex; align-items: center; gap: 10px;
		padding: 8px 16px; background: rgba(166, 227, 161, 0.08);
		border-top: 1px solid rgba(166, 227, 161, 0.25);
		border-bottom: 1px solid rgba(166, 227, 161, 0.25);
		font-size: 12px; color: #a6e3a1; flex-shrink: 0;
	}
	.call-dot {
		width: 8px; height: 8px; border-radius: 50%;
		background: #a6e3a1;
		animation: callPulse 1.4s ease-in-out infinite;
	}
	@keyframes callPulse {
		0%, 100% { box-shadow: 0 0 0 0 rgba(166, 227, 161, 0.5); }
		50% { box-shadow: 0 0 0 6px rgba(166, 227, 161, 0); }
	}
	.call-label { flex: 1; font-weight: 500; letter-spacing: 0.3px; }
	.call-err {
		margin-left: auto; color: #f38ba8; font-size: 11px;
		max-width: 280px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
	}
	.end-call-btn {
		background: #f38ba8; color: #11111b; border: none;
		padding: 4px 12px; border-radius: 6px;
		font-size: 11px; font-weight: 600; cursor: pointer;
	}
	.end-call-btn:hover { background: #eba0ac; }
	.call-tool-btn { /* phone icon in detail header — same shape as compose-btn */ }
	/* Call dot color reflects state: green idle, yellow listening, blue thinking, lavender speaking */
	.call-dot.recording { background: #f9e2af; }
	.call-dot.thinking  { background: #89b4fa; animation-duration: 0.7s; }
	.call-dot.speaking  { background: #cba6f7; animation-duration: 0.5s; }

	/* ─── Intuition trace: collapsible reasoning shown inline in the thread ─── */
	.intuition-trace {
		align-self: stretch;
		background: rgba(137, 180, 250, 0.05);
		border: 1px dashed rgba(137, 180, 250, 0.3);
		border-radius: 8px;
		padding: 6px 10px;
		font-size: 11px;
		color: #89b4fa;
	}
	.intuition-trace summary {
		cursor: pointer;
		user-select: none;
		font-weight: 500;
		letter-spacing: 0.2px;
	}
	.intuition-trace summary:hover { color: #b4befe; }
	.intuition-body {
		margin: 8px 0 0; padding: 8px 10px;
		background: rgba(0, 0, 0, 0.25);
		border-radius: 6px;
		font-family: 'Consolas', 'Monaco', monospace;
		font-size: 11px; color: #cdd6f4;
		white-space: pre-wrap; word-break: break-word;
		max-height: 240px; overflow-y: auto;
	}

	/* ─── 🧠 PAN reasoning trace under each reply (per-message debug) ─── */
	.why-trace {
		align-self: flex-start;
		max-width: 92%;
		margin: -2px 0 6px 6px;
		background: rgba(180, 190, 254, 0.04);
		border-left: 2px solid rgba(180, 190, 254, 0.35);
		border-radius: 0 6px 6px 0;
		padding: 4px 8px;
		font-size: 11px;
		color: #a6adc8;
	}
	.why-trace summary {
		cursor: pointer; user-select: none;
		display: flex; flex-wrap: wrap; align-items: center; gap: 6px;
		list-style: none;
	}
	.why-trace summary::-webkit-details-marker { display: none; }
	.why-trace summary::before {
		content: '▸';
		display: inline-block; width: 10px;
		font-size: 9px; color: #6c7086;
		transition: transform .15s;
	}
	.why-trace[open] summary::before { transform: rotate(90deg); }
	.why-chip {
		background: rgba(180, 190, 254, 0.12);
		color: #b4befe;
		padding: 1px 6px; border-radius: 4px;
		font-family: 'Consolas', 'Monaco', monospace;
		font-size: 10px;
	}
	.why-summary {
		flex: 1 1 100%;
		color: #bac2de; font-style: italic;
		margin-top: 2px;
	}
	.why-body { margin-top: 6px; display: flex; flex-direction: column; gap: 6px; }
	.why-section { background: rgba(0,0,0,0.22); border-radius: 4px; padding: 5px 8px; }
	.why-h {
		font-size: 10px; text-transform: uppercase; letter-spacing: .5px;
		color: #89b4fa; margin-bottom: 3px; font-weight: 600;
	}
	.why-p { color: #cdd6f4; line-height: 1.4; }
	.why-pre {
		margin: 0; font-family: 'Consolas', 'Monaco', monospace;
		font-size: 10px; color: #cdd6f4;
		white-space: pre-wrap; word-break: break-word;
		max-height: 200px; overflow-y: auto;
	}
	.why-mind-synth { color: #cdd6f4; font-style: italic; line-height: 1.4; margin: 0; }
	/* Per-message conversational-state mini-grid (dbg.conversation) */
	.why-cs { display: grid; grid-template-columns: 1fr 1fr; gap: 2px 16px; font-size: 11px; color: #cdd6f4; }
	.why-cs b { color: #89b4fa; font-weight: 500; margin-right: 4px; }
	.why-cs-wide { grid-column: 1 / -1; }
	.why-cs-meta { grid-column: 1 / -1; color: #6c7086; font-size: 10px; margin-top: 2px; }
	.why-src { color: #f9e2af; font-family: 'Consolas', monospace; font-size: 10px; margin-right: 4px; }
	.why-err { border-left: 2px solid #f38ba8; padding-left: 6px; }
	.why-err .why-h { color: #f38ba8; }

	/* ─── Calendar ─── */
	.calendar-view { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
	.cal-toolbar { justify-content: center; }
	.cal-title { font-size: 16px; font-weight: 600; min-width: 200px; text-align: center; }
	.cal-grid-wrap { padding: 8px 16px; flex-shrink: 0; }
	.cal-grid {
		display: grid;
		grid-template-columns: repeat(7, 1fr);
		gap: 2px;
		max-width: 500px;
		margin: 0 auto;
	}
	.cal-dow {
		text-align: center; font-size: 11px; color: #6c7086; font-weight: 600;
		padding: 4px 0;
	}
	.cal-blank { }
	.cal-day {
		aspect-ratio: 1;
		display: flex; flex-direction: column; align-items: center; justify-content: center;
		background: none; border: 1px solid transparent; border-radius: 8px;
		color: #cdd6f4; cursor: pointer; font-size: 13px; position: relative;
		gap: 2px;
	}
	.cal-day:hover { background: #1e1e2e; border-color: #313244; }
	.cal-day.today { border-color: #89b4fa; color: #89b4fa; font-weight: 700; }
	.cal-day.selected { background: #313244; border-color: #89b4fa; }
	.cal-day.has-events .cal-day-num { color: #a6e3a1; }
	.cal-day-num { font-size: 13px; }
	.cal-dot { width: 4px; height: 4px; border-radius: 50%; background: #a6e3a1; }
	.cal-day-detail, .cal-upcoming {
		flex: 1; overflow-y: auto; padding: 8px 16px; border-top: 1px solid #1e1e2e;
	}
	.cal-day-title { font-size: 13px; font-weight: 600; color: #a6adc8; margin-bottom: 8px; padding: 4px 0; }
	.event-row { display: flex; gap: 10px; padding: 8px 8px; border-bottom: 1px solid #181825; }
	.event-color { width: 4px; border-radius: 2px; flex-shrink: 0; }
	.event-info { flex: 1; }
	.event-title { font-size: 13px; font-weight: 500; }
	.event-time { font-size: 11px; color: #6c7086; margin-top: 2px; }
	.event-desc { font-size: 12px; color: #a6adc8; margin-top: 4px; }
</style>
