"""
PAN's door for xiaozhi voice boards.

xiaozhi (github.com/78/xiaozhi-esp32, MIT) is voice firmware for cheap ESP32 boards with a screen,
a mic and a speaker (Waveshare and about 70 others). A board first asks an "OTA" address where its
server is, then sends the owner's speech there as Opus over a WebSocket and plays whatever audio
comes back. By default that server is the project's own cloud. This program is that server, on the
hub, so the voice stays in the house and the board talks to PAN:

  board --Opus 16 kHz--> this door --text + audio--> PAN /api/v1/query/stream
  board <--Opus 24 kHz-- this door <--reply text---- PAN

It does for a board what the phone does for itself. The phone's streaming recogniser (the same
70M zipformer) decides when the line ended and gives a first draft; PAN hears the audio again with
Parakeet on the hub and sends back what it really heard (the 'heard' event). Replies are spoken
with the phone's own voice settings (Supertonic 3, speaker 9, speed 1.20, 4 steps), so a board
sounds like PAN.

Reaching it: the door listens on this computer only (127.0.0.1). The plan is that boards come in
over PAN Link as limited devices, like phones and PCs, so nothing is public and no port is added;
that needs WireGuard in the board's firmware and is not built. Until then only this computer can
reach the door (tests). --public-url is for tests behind a relay.

Pairing: a board PAN doesn't know gets a six digit code on its screen and nothing else. The owner
approves the code on the owner port (POST 127.0.0.1:7789/xiaozhi/admin/approve), which only this
computer can reach and which is never behind a relay; only then does the board get its own
token, and every WebSocket must carry it. Removing a board kills its token. A stranger on the
internet can ask for codes (a few per address per ten minutes) but can't approve one.

Levels: an "owner" board is one more microphone into the owner's one conversation, like the
phone and the pendant. A "guest" board (the default, for a board in a child's room) keeps its own
short talk in this program and goes through PAN's no-trace path (the bench flag), so it neither
reads nor writes the owner's memory.

Wire format from docs/websocket.md, docs/ota.md and docs/mcp-protocol.md in xiaozhi-esp32, read on
2026-11-13. The OTA reply asks for protocol version 1: raw Opus frames, JSON in text frames.

Run: python xiaozhi-server.py [--port 7788] [--admin-port 7789] [--pan http://127.0.0.1:7777]
                              [--public-url https://<hub>.<tailnet>.ts.net]
"""
import argparse
import asyncio
import base64
import ctypes
import ctypes.util
import hmac
import json
import os
import re
import secrets
import struct
import sys
import time
import uuid
from collections import deque
from pathlib import Path

import numpy as np
from aiohttp import ClientSession, ClientTimeout, WSMsgType, web

try:
    import sherpa_onnx
except ImportError:          # the door still pairs boards; it just can't hear or speak
    sherpa_onnx = None


def log(*parts):
    print('[xiaozhi]', *parts, flush=True)


def pan_local():
    """The folder that holds PAN's data, models and venvs (%LOCALAPPDATA%/PAN on Windows)."""
    if os.name == 'nt':
        return Path(os.environ.get('LOCALAPPDATA', Path.home() / 'AppData' / 'Local')) / 'PAN'
    return Path(os.environ.get('PAN_LOCAL', Path.home() / '.local' / 'share' / 'pan'))


# ---------------------------------------------------------------------------------------------
# Opus, straight from libopus. No Python package: on Linux the system's libopus.so.0, on Windows
# an opus.dll beside this file, in the venv, or named by --opus-lib / PAN_OPUS_LIB.
# ---------------------------------------------------------------------------------------------
class Opus:
    APPLICATION_AUDIO = 2049

    def __init__(self, path=None):
        names = [path or os.environ.get('PAN_OPUS_LIB')]
        names.append(ctypes.util.find_library('opus'))
        here = Path(__file__).resolve().parent
        names += [str(here / 'opus.dll'), str(Path(sys.prefix) / 'opus.dll'), 'libopus.so.0', 'libopus-0.dll', 'opus.dll']
        self.lib = None
        for name in [n for n in names if n]:
            try:
                self.lib = ctypes.CDLL(name)
                break
            except OSError:
                continue
        if self.lib is None:
            raise OSError('libopus not found (Linux: libopus0; Windows: put opus.dll beside xiaozhi-server.py)')
        L = self.lib
        L.opus_decoder_create.argtypes = [ctypes.c_int32, ctypes.c_int, ctypes.POINTER(ctypes.c_int)]
        L.opus_decoder_create.restype = ctypes.c_void_p
        L.opus_decode.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int32,
                                  ctypes.POINTER(ctypes.c_int16), ctypes.c_int, ctypes.c_int]
        L.opus_decode.restype = ctypes.c_int
        L.opus_decoder_destroy.argtypes = [ctypes.c_void_p]
        L.opus_encoder_create.argtypes = [ctypes.c_int32, ctypes.c_int, ctypes.c_int, ctypes.POINTER(ctypes.c_int)]
        L.opus_encoder_create.restype = ctypes.c_void_p
        L.opus_encode.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_int16), ctypes.c_int,
                                  ctypes.POINTER(ctypes.c_ubyte), ctypes.c_int32]
        L.opus_encode.restype = ctypes.c_int32
        L.opus_encoder_destroy.argtypes = [ctypes.c_void_p]

    def decoder(self, rate):
        return _Decoder(self.lib, rate)

    def encoder(self, rate):
        return _Encoder(self.lib, rate)


class _Decoder:
    MAX = 5760   # 120 ms at 48 kHz, the longest frame Opus has

    def __init__(self, lib, rate):
        err = ctypes.c_int()
        self.lib, self.h = lib, lib.opus_decoder_create(rate, 1, ctypes.byref(err))
        if err.value != 0 or not self.h:
            raise RuntimeError(f'opus_decoder_create failed ({err.value})')
        self.buf = (ctypes.c_int16 * self.MAX)()

    def decode(self, packet):
        """One Opus packet -> int16 samples (numpy)."""
        n = self.lib.opus_decode(self.h, packet, len(packet), self.buf, self.MAX, 0)
        if n < 0:
            raise RuntimeError(f'opus_decode failed ({n})')
        return np.ctypeslib.as_array(self.buf)[:n].copy()

    def close(self):
        if self.h:
            self.lib.opus_decoder_destroy(self.h)
            self.h = None


class _Encoder:
    def __init__(self, lib, rate):
        err = ctypes.c_int()
        self.lib = lib
        self.h = lib.opus_encoder_create(rate, 1, Opus.APPLICATION_AUDIO, ctypes.byref(err))
        if err.value != 0 or not self.h:
            raise RuntimeError(f'opus_encoder_create failed ({err.value})')
        self.out = (ctypes.c_ubyte * 4000)()

    def encode(self, pcm16):
        """Exactly one frame of int16 samples -> one Opus packet (bytes)."""
        pcm16 = np.ascontiguousarray(pcm16, dtype=np.int16)
        n = self.lib.opus_encode(self.h, pcm16.ctypes.data_as(ctypes.POINTER(ctypes.c_int16)),
                                 len(pcm16), self.out, len(self.out))
        if n < 0:
            raise RuntimeError(f'opus_encode failed ({n})')
        return bytes(self.out[:n])

    def close(self):
        if self.h:
            self.lib.opus_encoder_destroy(self.h)
            self.h = None


# ---------------------------------------------------------------------------------------------
# Ears and voice (sherpa-onnx). Both optional at start so a missing model is a clear log line,
# not a crash; /health says which are loaded.
# ---------------------------------------------------------------------------------------------
ASR_FILES = ('encoder-epoch-99-avg-1-chunk-16-left-128.int8.onnx',
             'decoder-epoch-99-avg-1-chunk-16-left-128.onnx',
             'joiner-epoch-99-avg-1-chunk-16-left-128.int8.onnx',
             'tokens.txt')
TTS_FILES = ('text_encoder.int8.onnx', 'duration_predictor.int8.onnx', 'vector_estimator.int8.onnx',
             'vocoder.int8.onnx', 'voice.bin', 'tts.json', 'unicode_indexer.bin')


def load_asr(d, threads, end_silence):
    if not sherpa_onnx:
        return None
    d = Path(d)
    if not all((d / f).exists() for f in ASR_FILES):
        log(f'no recogniser model in {d}')
        return None
    enc, dec, join, tok = (str(d / f) for f in ASR_FILES)
    # Rule 2 ends a line after `end_silence` s of quiet following words. The phone uses 0.35 s
    # behind its own voice detector; a board streams raw room sound, so this waits longer.
    return sherpa_onnx.OnlineRecognizer.from_transducer(
        tokens=tok, encoder=enc, decoder=dec, joiner=join, num_threads=threads, sample_rate=16000,
        feature_dim=80, decoding_method='greedy_search', enable_endpoint_detection=True,
        rule1_min_trailing_silence=6.0, rule2_min_trailing_silence=end_silence,
        rule3_min_utterance_length=20.0)


def load_tts(d, threads):
    if not sherpa_onnx:
        return None
    d = Path(d)
    if not all((d / f).exists() for f in TTS_FILES):
        log(f'no voice model in {d}')
        return None
    st = sherpa_onnx.OfflineTtsSupertonicModelConfig(
        text_encoder=str(d / 'text_encoder.int8.onnx'),
        duration_predictor=str(d / 'duration_predictor.int8.onnx'),
        vector_estimator=str(d / 'vector_estimator.int8.onnx'),
        vocoder=str(d / 'vocoder.int8.onnx'),
        voice_style=str(d / 'voice.bin'),
        tts_json=str(d / 'tts.json'),
        unicode_indexer=str(d / 'unicode_indexer.bin'))
    cfg = sherpa_onnx.OfflineTtsConfig(
        model=sherpa_onnx.OfflineTtsModelConfig(supertonic=st, num_threads=threads, debug=False, provider='cpu'),
        max_num_sentences=1)
    return sherpa_onnx.OfflineTts(cfg)


def asr_text(rec, stream):
    r = rec.get_result(stream)
    return (r if isinstance(r, str) else getattr(r, 'text', '')).strip()


def trim_quiet(x, rate):
    """Supertonic leaves ~0.3 s of quiet before a line and ~0.35 s after it; the phone cuts it
    at 40 dB under the loudest moment (PiperTtsEngine.trimQuiet). Same cut here."""
    win = rate // 100
    frames = len(x) // win if win else 0
    if frames == 0:
        return x
    level = (x[:frames * win].reshape(frames, win) ** 2).mean(axis=1)
    loud = np.nonzero(level > level.max() * 1e-4)[0]
    if len(loud) == 0:
        return x
    return x[max(0, loud[0] * win - rate // 50): min(len(x), (loud[-1] + 1) * win + rate * 8 // 100)]


def resample(x, src, dst):
    """Float audio from src Hz to dst Hz: a short low-pass, then linear steps. Plenty for speech."""
    if src == dst or len(x) == 0:
        return x
    if dst < src:
        fc = 0.45 * dst / src
        n = np.arange(63) - 31
        h = 2 * fc * np.sinc(2 * fc * n) * np.hamming(63)
        x = np.convolve(x, h / h.sum(), mode='same')
    out = int(len(x) * dst / src)
    return np.interp(np.linspace(0, len(x) - 1, out), np.arange(len(x)), x).astype(np.float32)


# ---------------------------------------------------------------------------------------------
# Boards PAN knows. One JSON file in the data folder, written whole each time.
# ---------------------------------------------------------------------------------------------
class Boards:
    PENDING_S = 600

    def __init__(self, folder):
        self.path = Path(folder) / 'boards.json'
        self.path.parent.mkdir(parents=True, exist_ok=True)
        try:
            self.data = json.loads(self.path.read_text(encoding='utf-8'))
        except (OSError, ValueError):
            self.data = {}
        self.data.setdefault('boards', {})
        self.data.setdefault('pending', {})

    def save(self):
        tmp = self.path.with_suffix('.tmp')
        tmp.write_text(json.dumps(self.data, indent=1), encoding='utf-8')
        os.replace(tmp, self.path)

    def get(self, device_id):
        return self.data['boards'].get(device_id)

    def ask(self, device_id, client_id):
        """A board PAN doesn't know: its code (the same one until it runs out)."""
        now = time.time()
        pend = self.data['pending']
        for k in [k for k, v in pend.items() if now - v['asked'] > self.PENDING_S]:
            del pend[k]
        p = pend.get(device_id)
        if p is None:
            if len(pend) >= 20:      # a flood of strangers: the oldest one goes
                del pend[min(pend, key=lambda k: pend[k]['asked'])]
            codes = {v['code'] for v in pend.values()}
            code = f'{secrets.randbelow(10 ** 6):06d}'
            while code in codes:
                code = f'{secrets.randbelow(10 ** 6):06d}'
            p = pend[device_id] = {'code': code, 'client_id': client_id, 'challenge': str(uuid.uuid4()), 'asked': now}
            self.save()
            log(f'new board {device_id} asks to pair, code {code}')
        return p

    def approve(self, code, name=None, level='guest'):
        for device_id, p in self.data['pending'].items():
            if p['code'] == code:
                del self.data['pending'][device_id]
                self.data['boards'][device_id] = {
                    'name': name or f'Board {device_id[-5:]}', 'level': 'owner' if level == 'owner' else 'guest',
                    'client_id': p['client_id'], 'token': secrets.token_hex(24), 'added': time.time(), 'seen': None,
                    'tools': []}
                self.save()
                log(f'board {device_id} approved as {self.data["boards"][device_id]["level"]}')
                return device_id
        return None

    def remove(self, device_id):
        gone = self.data['boards'].pop(device_id, None) is not None
        if gone:
            self.save()
        return gone

    def check_token(self, device_id, auth):
        b = self.get(device_id)
        if not b or not auth:
            return None
        token = auth[7:] if auth.lower().startswith('bearer ') else auth
        return b if hmac.compare_digest(token.strip(), b['token']) else None


def device_key(device_id):
    """The id PAN sees for a board: xiaozhi-<its MAC, hex only>."""
    return 'xiaozhi-' + re.sub(r'[^0-9a-f]', '', device_id.lower())[:16]


# ---------------------------------------------------------------------------------------------
# What PAN says, cut into lines the voice can speak.
# ---------------------------------------------------------------------------------------------
_MARKUP = re.compile(r'[*_#`>\[\]]|\(https?://[^)]*\)|https?://\S+')
_EMOJI = re.compile('[\U0001F000-\U0001FAFF☀-➿️]')
_END = re.compile(r'(?<=[.!?])\s+|\n+')


def speakable(text):
    text = text.replace('[AMBIENT]', '')
    return re.sub(r'\s+', ' ', _EMOJI.sub('', _MARKUP.sub('', text))).strip()


class Lines:
    """Feeds streamed text in, hands out whole sentences as they close."""
    def __init__(self):
        self.buf = ''

    def add(self, text):
        self.buf += text
        parts = _END.split(self.buf)
        self.buf = parts.pop()
        # A long clause with no full stop yet: break it at the last comma so the board isn't silent.
        if len(self.buf) > 160 and ', ' in self.buf:
            head, _, self.buf = self.buf.rpartition(', ')
            parts.append(head + ',')
        return [p for p in (speakable(x) for x in parts) if p]

    def rest(self):
        last, self.buf = speakable(self.buf), ''
        return [last] if last else []


# ---------------------------------------------------------------------------------------------
# One board's connection.
# ---------------------------------------------------------------------------------------------
FRAME_S = 0.06          # 60 ms frames both ways
OUT_RATE = 24000        # what we tell the board we send
LEAD_S = 0.36           # how far ahead of the board's playback we keep sending


class Session:
    def __init__(self, door, ws, device_id, board, version):
        self.door, self.ws, self.device_id, self.board = door, ws, device_id, board
        self.version = version
        self.session_id = uuid.uuid4().hex
        self.mode = 'auto'
        self.listening = False
        self.pcm = []                       # this line's 16 kHz int16 chunks
        self.stream = door.asr.create_stream() if door.asr else None
        self.dec = door.opus.decoder(16000)
        self.enc = door.opus.encoder(OUT_RATE)
        self.reply = None                   # the running reply task
        self.talk = deque(maxlen=12)        # a guest board's own short history
        self.play_until = 0.0
        self.send_lock = asyncio.Lock()
        self.asr_lock = asyncio.Lock()
        self.mcp_id = 0

    # -- sending ------------------------------------------------------------------------------
    async def send_json(self, obj):
        obj.setdefault('session_id', self.session_id)
        async with self.send_lock:
            if not self.ws.closed:
                await self.ws.send_str(json.dumps(obj, ensure_ascii=False))

    async def send_audio(self, packet):
        if self.version == 2:
            packet = struct.pack('>HHIII', 2, 0, 0, 0, len(packet)) + packet
        elif self.version == 3:
            packet = struct.pack('>BBH', 0, 0, len(packet)) + packet
        async with self.send_lock:
            if not self.ws.closed:
                await self.ws.send_bytes(packet)

    # -- receiving ----------------------------------------------------------------------------
    async def on_text(self, raw):
        try:
            msg = json.loads(raw)
        except ValueError:
            return
        kind = msg.get('type')
        if kind == 'hello':
            await self.on_hello(msg)
        elif kind == 'listen':
            await self.on_listen(msg)
        elif kind == 'abort':
            await self.stop_reply('abort')
        elif kind == 'mcp':
            await self.on_mcp(msg.get('payload') or {})

    async def on_hello(self, msg):
        if msg.get('version') in (2, 3):
            self.version = msg['version']
        await self.send_json({'type': 'hello', 'transport': 'websocket', 'session_id': self.session_id,
                              'audio_params': {'format': 'opus', 'sample_rate': OUT_RATE, 'channels': 1,
                                               'frame_duration': int(FRAME_S * 1000)}})
        # What the board can do (its MCP tools): asked once per connection, kept with the board.
        if (msg.get('features') or {}).get('mcp'):
            await self.mcp('initialize', {'protocolVersion': '2024-11-05', 'capabilities': {},
                                          'clientInfo': {'name': 'pan', 'version': '1'}})

    async def on_listen(self, msg):
        state = msg.get('state')
        if state == 'start':
            if self.reply and not self.reply.done():
                await self.stop_reply('listen start')
            self.mode = msg.get('mode') or self.mode
            self.listening = True
            self.pcm = []
            if self.stream is not None:
                self.door.asr.reset(self.stream)
            # Like the phone: tell PAN a line is coming, so its voice model reads the talk so far
            # while he is still speaking (api.js /voice/warm). Nobody waits on it.
            asyncio.create_task(self.warm())
        elif state == 'stop':
            if self.listening:
                self.listening = False
                await self.end_line()
        # 'detect' (the wake word) needs nothing: the board starts listening next.

    async def on_audio(self, data):
        if self.version == 2 and len(data) >= 16:
            v, kind, _, _, size = struct.unpack('>HHIII', data[:16])
            if kind != 0:
                return
            data = data[16:16 + size]
        elif self.version == 3 and len(data) >= 4:
            kind, _, size = struct.unpack('>BBH', data[:4])
            if kind != 0:
                return
            data = data[4:4 + size]
        if not self.listening or (self.reply and not self.reply.done()):
            return
        try:
            pcm = self.dec.decode(data)
        except RuntimeError:
            return
        self.pcm.append(pcm)
        if self.stream is None:
            return
        ended = await asyncio.to_thread(self.feed, pcm)
        if ended and self.mode in ('auto', 'realtime'):
            await self.end_line()

    def feed(self, pcm):
        rec, s = self.door.asr, self.stream
        s.accept_waveform(16000, pcm.astype(np.float32) / 32768.0)
        while rec.is_ready(s):
            rec.decode_stream(s)
        return rec.is_endpoint(s) and bool(asr_text(rec, s))

    def finish(self):
        """The line is over: push a little quiet through so the last word comes out, then read it."""
        rec, s = self.door.asr, self.stream
        s.accept_waveform(16000, np.zeros(9600, dtype=np.float32))
        while rec.is_ready(s):
            rec.decode_stream(s)
        text = asr_text(rec, s)
        rec.reset(s)
        return text

    async def end_line(self):
        pcm = np.concatenate(self.pcm) if self.pcm else np.zeros(0, dtype=np.int16)
        self.pcm = []
        draft = await asyncio.to_thread(self.finish) if self.stream is not None else ''
        loud = float(np.sqrt(np.mean((pcm.astype(np.float32) / 32768.0) ** 2))) if len(pcm) else 0.0
        if not draft and loud < 0.01:
            log(f'{self.device_id}: nothing said ({len(pcm) / 16000:.1f} s, level {loud:.3f})')
            return
        self.reply = asyncio.create_task(self.answer(draft, pcm))

    async def stop_reply(self, why):
        if self.reply and not self.reply.done():
            self.reply.cancel()
            try:
                await self.reply
            except (asyncio.CancelledError, Exception):
                pass
            log(f'{self.device_id}: reply stopped ({why})')
        self.play_until = 0.0
        await self.send_json({'type': 'tts', 'state': 'stop'})

    # -- one turn -----------------------------------------------------------------------------
    def pan_body(self):
        """What every call to PAN for this board carries. A guest board sends its own short talk
        (ten or more characters stops PAN from falling back to the owner's thread, api.js
        voiceHistory) and goes the bench way, so nothing it says is kept."""
        owner = self.board.get('level') == 'owner'
        body = {'bench': self.door.bench or not owner}
        if not owner:
            body['context'] = '\n'.join(self.talk) or '(A new talk on a guest voice board.)'
        return body

    def pan_headers(self):
        return {'x-device-id': device_key(self.device_id), 'x-device-name': self.board.get('name', '')}

    async def warm(self):
        try:
            async with self.door.http.post(f'{self.door.pan}/api/v1/voice/warm', json=self.pan_body(),
                                           headers=self.pan_headers()) as r:
                await r.read()
        except Exception:
            pass

    async def answer(self, draft, pcm):
        door, board = self.door, self.board
        owner = board.get('level') == 'owner'
        t0 = time.monotonic()
        body = dict(self.pan_body(), text=draft or '...', wearer=True)
        if len(pcm):
            body['audio'] = base64.b64encode(pcm.astype('<i2').tobytes()).decode()
        headers = self.pan_headers()
        lines, said, heard, result = Lines(), [], None, None
        stt_sent = started = False
        queue = asyncio.Queue()
        speaker = asyncio.create_task(self.speak(queue, t0))
        try:
            async with door.http.post(f'{door.pan}/api/v1/query/stream', json=body, headers=headers) as r:
                if r.status != 200:
                    raise RuntimeError(f'PAN answered {r.status}')
                async for raw in r.content:
                    line = raw.decode('utf-8', 'replace').strip()
                    if not line.startswith('data:'):
                        continue
                    try:
                        ev = json.loads(line[5:].strip())
                    except ValueError:
                        continue
                    kind = ev.get('type')
                    if kind == 'heard':
                        # PAN's own ear (Parakeet) is the better one: show its words on the board
                        # now, before the reply starts.
                        heard = ev.get('text') or heard
                        if not stt_sent and heard:
                            await self.send_json({'type': 'stt', 'text': heard})
                            stt_sent = True
                    elif kind == 'chunk':
                        if not stt_sent:
                            await self.send_json({'type': 'stt', 'text': heard or draft})
                            stt_sent = True
                        text = ev.get('text') or ''
                        said.append(text)
                        for s in lines.add(text):
                            if not started:
                                started = True
                                await self.send_json({'type': 'tts', 'state': 'start'})
                                await self.send_json({'type': 'llm', 'emotion': 'happy', 'text': '🙂'})
                            await queue.put(s)
                    elif kind == 'done':
                        result = ev.get('result') or {}
                        break
            if not stt_sent:
                await self.send_json({'type': 'stt', 'text': heard or draft})
            rest = lines.rest()
            if not said and result and result.get('intent') not in ('ambient', 'cancelled'):
                rest = Lines().add(str(result.get('response') or '') + '\n')
            if rest and not started:
                started = True
                await self.send_json({'type': 'tts', 'state': 'start'})
            for s in rest:
                await queue.put(s)
        except asyncio.CancelledError:
            speaker.cancel()
            raise
        except Exception as e:
            log(f'{self.device_id}: turn failed: {e}')
            if not started:
                started = True
                await self.send_json({'type': 'tts', 'state': 'start'})
            await queue.put('Sorry, I could not reach PAN.')
        await queue.put(None)
        await speaker
        reply = speakable(''.join(said)) if said else speakable(str((result or {}).get('response') or ''))
        heard_line = heard or draft
        log(f'{self.device_id}: heard {heard_line!r} -> {reply[:80]!r} ({time.monotonic() - t0:.2f} s)')
        if not owner:
            self.talk.append(f'You: {heard_line}')
            if reply:
                self.talk.append(f'PAN: {reply}')
        if started:
            # Let the board finish playing before it hears "stop" and goes back to listening.
            wait = self.play_until - asyncio.get_running_loop().time()
            if wait > 0:
                await asyncio.sleep(wait)
            await self.send_json({'type': 'tts', 'state': 'stop'})

    async def speak(self, queue, t0):
        """Sentences in, Opus out. A second task makes each sentence's sound while the one before
        it is still going out, so sentence two never waits for sentence one to finish playing."""
        door, loop = self.door, asyncio.get_running_loop()
        made = asyncio.Queue(maxsize=2)

        async def maker():
            while True:
                text = await queue.get()
                if text is None or door.tts is None:
                    await made.put(None if text is None else (text, np.zeros(0, dtype=np.int16)))
                    if text is None:
                        return
                    continue
                await made.put((text, await asyncio.to_thread(door.synth, text)))

        making = asyncio.create_task(maker())
        try:
            await self._send_made(made, loop, t0)
        finally:
            making.cancel()

    async def _send_made(self, made, loop, t0):
        first = True
        while True:
            item = await made.get()
            if item is None:
                return
            text, pcm = item
            await self.send_json({'type': 'tts', 'state': 'sentence_start', 'text': text})
            if len(pcm) == 0:
                continue
            step = int(OUT_RATE * FRAME_S)
            if len(pcm) % step:
                pcm = np.concatenate([pcm, np.zeros(step - len(pcm) % step, dtype=np.int16)])
            for i in range(0, len(pcm), step):
                packet = self.enc.encode(pcm[i:i + step])
                now = loop.time()
                if self.play_until < now:
                    self.play_until = now
                ahead = self.play_until - now
                if ahead > LEAD_S:
                    await asyncio.sleep(ahead - LEAD_S)
                await self.send_audio(packet)
                self.play_until += FRAME_S
                if first:
                    first = False
                    log(f'{self.device_id}: first sound {time.monotonic() - t0:.2f} s after the line ended')

    # -- MCP: the board's own tools ------------------------------------------------------------
    async def mcp(self, method, params):
        self.mcp_id += 1
        await self.send_json({'type': 'mcp', 'payload': {'jsonrpc': '2.0', 'id': self.mcp_id,
                                                         'method': method, 'params': params}})

    async def on_mcp(self, payload):
        result = payload.get('result')
        if not isinstance(result, dict):
            return
        if 'serverInfo' in result or 'protocolVersion' in result:
            await self.send_json({'type': 'mcp', 'payload': {'jsonrpc': '2.0', 'method': 'notifications/initialized'}})
            await self.mcp('tools/list', {})
        elif 'tools' in result:
            tools = [{'name': t.get('name'), 'description': (t.get('description') or '')[:200]}
                     for t in result.get('tools') or [] if t.get('name')]
            self.board['tools'] = tools
            self.door.boards.save()
            log(f'{self.device_id}: {len(tools)} tools: {", ".join(t["name"] for t in tools)[:200]}')
            if result.get('nextCursor'):
                await self.mcp('tools/list', {'cursor': result['nextCursor']})

    def close(self):
        if self.reply and not self.reply.done():
            self.reply.cancel()
        self.dec.close()
        self.enc.close()


# ---------------------------------------------------------------------------------------------
# The door itself: the OTA check-in, pairing and the WebSocket for boards, and on a second port
# that only this computer can reach, the owner's calls.
# ---------------------------------------------------------------------------------------------
LOOPBACK = ('127.0.0.1', '::1')
# A relay (Tailscale Funnel, Cloudflare, any reverse proxy) adds one of these to what it passes on.
RELAY_HEADERS = ('X-Forwarded-For', 'X-Forwarded-Host', 'X-Forwarded-Proto', 'Forwarded',
                 'Tailscale-Funnel-Request', 'CF-Connecting-IP')


@web.middleware
async def owner_only(request, handler):
    """The owner port answers this computer only. It listens on 127.0.0.1, and on top of that it
    refuses anything a relay passed on, in case a relay is ever pointed at it by mistake."""
    if request.remote not in LOOPBACK or any(h in request.headers for h in RELAY_HEADERS):
        raise web.HTTPForbidden()
    return await handler(request)


class Door:
    ASKS = 5        # new pairing codes one sender address may start per Boards.PENDING_S

    def __init__(self, args):
        self.pan = args.pan.rstrip('/')
        self.public = (args.public_url or '').rstrip('/') or None
        self.asks = {}
        self.bench = args.bench
        self.boards = Boards(args.data)
        self.opus = Opus(args.opus_lib)
        self.asr = load_asr(args.asr_dir, args.threads, args.end_silence)
        self.tts = load_tts(args.tts_dir, args.tts_threads)
        self.voice = {'sid': args.voice_sid, 'speed': args.voice_speed, 'steps': args.voice_steps}
        self.http = None
        self.sessions = {}
        log(f'ears {"on" if self.asr else "OFF"}, voice {"on" if self.tts else "OFF"}, '
            f'{len(self.boards.data["boards"])} boards, PAN at {self.pan}{" (bench: nothing kept)" if self.bench else ""}')

    def synth(self, text):
        """One sentence in PAN's voice -> int16 at OUT_RATE."""
        v = self.voice
        try:
            gc = sherpa_onnx.GenerationConfig()
            gc.sid, gc.speed, gc.num_steps = v['sid'], v['speed'], v['steps']
            audio = self.tts.generate(text, gc)
        except (AttributeError, TypeError):
            audio = self.tts.generate(text, sid=v['sid'], speed=v['speed'])
        x = trim_quiet(np.asarray(audio.samples, dtype=np.float32), audio.sample_rate)
        x = resample(x, audio.sample_rate, OUT_RATE)
        return (np.clip(x, -1, 1) * 32767).astype(np.int16)

    @staticmethod
    def source(request):
        """The address a request came from. Through a relay it arrives from 127.0.0.1 and the
        relay names the real sender in X-Forwarded-For."""
        if request.remote in LOOPBACK:
            fwd = request.headers.get('X-Forwarded-For', '').split(',')[0].strip()
            if fwd:
                return fwd
        return request.remote

    def may_ask(self, src):
        """At most ASKS new pairing codes per sender address, so a stranger flooding the public
        address can't push a real board's code out of the list. Senders the door can't tell apart
        (no relay header) aren't limited here; the list itself still holds 20 at most."""
        if src in LOOPBACK:
            return True
        now = time.time()
        recent = [t for t in self.asks.get(src, ()) if now - t < Boards.PENDING_S]
        ok = len(recent) < self.ASKS
        self.asks[src] = recent + [now] if ok else recent
        if len(self.asks) > 500:
            self.asks = {k: v for k, v in self.asks.items() if v and now - v[-1] < Boards.PENDING_S}
        return ok

    def ws_url(self, request):
        """Where the board opens its WebSocket: the public address when one is set, otherwise the
        address the board just used (through a relay, the one the relay was asked for), as ws/wss."""
        base = self.public or '{}://{}'.format(request.headers.get('X-Forwarded-Proto', request.scheme),
                                               request.headers.get('X-Forwarded-Host', request.host))
        return re.sub(r'^http', 'ws', base) + '/xiaozhi/v1/'

    async def ota(self, request):
        device_id = request.headers.get('Device-Id', '').strip().lower()
        client_id = request.headers.get('Client-Id', '').strip()
        try:
            body = await request.json()
        except Exception:
            body = {}
        if not device_id:
            device_id = str(body.get('mac_address') or '').lower()
        if not device_id:
            return web.json_response({'error': 'no Device-Id'}, status=400)
        offset = int((time.localtime().tm_gmtoff or 0) / 60)
        version = str(((body.get('application') or {}).get('version')) or '1.0.0')
        reply = {'server_time': {'timestamp': int(time.time() * 1000), 'timezone_offset': offset},
                 'firmware': {'version': version, 'url': ''}}
        board = self.boards.get(device_id)
        if board:
            board['seen'] = time.time()
            self.boards.save()
            reply['websocket'] = {'url': self.ws_url(request), 'token': board['token'], 'version': 1}
        else:
            if device_id not in self.boards.data['pending'] and not self.may_ask(self.source(request)):
                return web.json_response({'error': 'too many new boards from this address, try later'}, status=429)
            p = self.boards.ask(device_id, client_id)
            # The board shows `message` and says the code. Plain Latin: board fonts may lack Π.
            reply['activation'] = {'code': p['code'], 'message': f'PAN\n{p["code"]}',
                                   'challenge': p['challenge'], 'timeout_ms': Boards.PENDING_S * 1000}
        return web.json_response(reply)

    async def activate(self, request):
        device_id = request.headers.get('Device-Id', '').strip().lower()
        if device_id and self.boards.get(device_id):
            return web.json_response({'message': 'Device activated', 'device_id': abs(hash(device_id)) % 10 ** 6})
        return web.json_response({'message': 'Device activation timeout'}, status=202)

    async def websocket(self, request):
        device_id = request.headers.get('Device-Id', '').strip().lower()
        board = self.boards.check_token(device_id, request.headers.get('Authorization', ''))
        if not board:
            log(f'refused a WebSocket from {request.remote} ({device_id or "no id"})')
            return web.Response(status=401, text='unknown board')
        try:
            version = int(request.headers.get('Protocol-Version', '1'))
        except ValueError:
            version = 1
        ws = web.WebSocketResponse(heartbeat=30, max_msg_size=1 << 20)
        await ws.prepare(request)
        old = self.sessions.pop(device_id, None)
        if old:
            await old.ws.close()
        s = self.sessions[device_id] = Session(self, ws, device_id, board, version)
        log(f'{device_id} ({board["name"]}, {board["level"]}) connected from {request.remote}')
        try:
            async for msg in ws:
                if msg.type == WSMsgType.TEXT:
                    await s.on_text(msg.data)
                elif msg.type == WSMsgType.BINARY:
                    await s.on_audio(msg.data)
                elif msg.type == WSMsgType.ERROR:
                    break
        finally:
            s.close()
            if self.sessions.get(device_id) is s:
                del self.sessions[device_id]
            log(f'{device_id} disconnected')
        return ws

    # The owner's calls. Only owner_app() routes to these, and it listens on 127.0.0.1 alone.
    async def admin_boards(self, request):
        boards =[{'device_id': k, 'name': v['name'], 'level': v['level'], 'seen': v['seen'],
                   'online': k in self.sessions, 'tools': [t['name'] for t in v.get('tools', [])]}
                  for k, v in self.boards.data['boards'].items()]
        pending = [{'device_id': k, 'code': v['code'], 'asked': v['asked']} for k, v in self.boards.data['pending'].items()]
        return web.json_response({'boards': boards, 'pending': pending})

    async def admin_approve(self, request):
        b = await request.json()
        device_id = self.boards.approve(str(b.get('code', '')).strip(), b.get('name'), b.get('level', 'guest'))
        if not device_id:
            return web.json_response({'error': 'no board is asking with that code'}, status=404)
        return web.json_response({'ok': True, 'device_id': device_id})

    async def admin_remove(self, request):
        b = await request.json()
        device_id = str(b.get('device_id', '')).lower()
        gone = self.boards.remove(device_id)
        s = self.sessions.pop(device_id, None)
        if s:
            await s.ws.close()
        return web.json_response({'ok': gone})

    async def health(self, request):
        return web.json_response({'status': 'ok'})      # the internet can see this one; says nothing

    async def health_full(self, request):
        return web.json_response({'status': 'ok', 'ears': bool(self.asr), 'voice': bool(self.tts),
                                  'boards': len(self.boards.data['boards']), 'online': len(self.sessions),
                                  'public': self.public})

    async def fallback(self, request):
        # The board builds the activation address by adding "activate" to its OTA address, with or
        # without a slash between them.
        if request.method == 'POST' and request.path.rstrip('/').endswith('activate'):
            return await self.activate(request)
        if request.path.rstrip('/').endswith('/ota'):
            return await self.ota(request)
        raise web.HTTPNotFound()

    def app(self):
        app = web.Application(client_max_size=1 << 20)

        async def start(_):
            self.http = ClientSession(timeout=ClientTimeout(total=None, sock_connect=5, sock_read=60))

        async def stop(_):
            await self.http.close()
        app.on_startup.append(start)
        app.on_cleanup.append(stop)
        r = app.router
        r.add_get('/', self.health)
        r.add_get('/health', self.health)
        r.add_get('/xiaozhi/v1/', self.websocket)
        r.add_get('/xiaozhi/v1', self.websocket)
        r.add_get('/v1/', self.websocket)       # in case a relay drops the /xiaozhi it is mounted on
        r.add_get('/v1', self.websocket)
        r.add_route('*', '/{tail:.*}', self.fallback)
        return app

    def owner_app(self):
        """The owner's calls on their own port: list, approve, remove. Never behind a relay."""
        app = web.Application(client_max_size=1 << 16, middlewares=[owner_only])
        r = app.router
        r.add_get('/health', self.health_full)
        r.add_get('/xiaozhi/admin/boards', self.admin_boards)
        r.add_post('/xiaozhi/admin/approve', self.admin_approve)
        r.add_post('/xiaozhi/admin/remove', self.admin_remove)
        return app


async def serve(door, args):
    boards = web.AppRunner(door.app(), access_log=None)
    owner = web.AppRunner(door.owner_app(), access_log=None)
    await boards.setup()
    await owner.setup()
    await web.TCPSite(boards, args.host, args.port).start()
    await web.TCPSite(owner, '127.0.0.1', args.admin_port).start()      # never anything but loopback
    log(f'boards on {args.host}:{args.port}, owner calls on 127.0.0.1:{args.admin_port}'
        + (f', public address {door.public}' if door.public else ''))
    try:
        await asyncio.Event().wait()
    finally:
        await owner.cleanup()
        await boards.cleanup()


def main():
    local = pan_local()
    ap = argparse.ArgumentParser(description="PAN's door for xiaozhi voice boards")
    ap.add_argument('--port', type=int, default=7788)
    ap.add_argument('--host', default='127.0.0.1', help='this computer only')
    ap.add_argument('--admin-port', type=int, default=7789, help='owner calls; always 127.0.0.1')
    ap.add_argument('--public-url', default=None, help='the address boards use, e.g. https://<hub>.<tailnet>.ts.net')
    ap.add_argument('--pan', default='http://127.0.0.1:7777')
    ap.add_argument('--data', default=str(local / 'data' / 'xiaozhi'))
    ap.add_argument('--asr-dir', default=str(local / 'models' / 'sherpa-onnx-streaming-zipformer-en-2023-06-26'))
    ap.add_argument('--tts-dir', default=str(local / 'models' / 'sherpa-onnx-supertonic-3-tts-int8-2026-05-11'))
    ap.add_argument('--threads', type=int, default=2)
    ap.add_argument('--tts-threads', type=int, default=3)
    ap.add_argument('--end-silence', type=float, default=0.8, help='seconds of quiet that end a line in auto mode')
    ap.add_argument('--voice-sid', type=int, default=9)
    ap.add_argument('--voice-speed', type=float, default=1.20)
    ap.add_argument('--voice-steps', type=int, default=4)
    ap.add_argument('--opus-lib', default=None)
    ap.add_argument('--bench', action='store_true', help='tests: PAN keeps nothing from these turns')
    args = ap.parse_args()
    door = Door(args)
    try:
        asyncio.run(serve(door, args))
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
