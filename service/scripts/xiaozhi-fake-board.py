"""
Pretends to be a xiaozhi board, to test PAN's door (service/src/xiaozhi-server.py) with no hardware.

It does what a real board does, in order: asks the OTA address for its server, gets a pairing code,
approves that code itself through the door's owner port (the owner's job on a real board; when the
door is on another computer it waits for someone to approve the code there), checks that the owner
calls don't answer through the board door, connects the WebSocket with its token, says hello,
answers the door's MCP questions with one fake
tool, speaks a line (made with the Supertonic voice, sent as 16 kHz Opus like a board's mic), and
records whatever comes back. The reply's sound is saved as a WAV.

  python xiaozhi-fake-board.py --say "what is the capital of peru" --tts-dir <supertonic3 folder>

Exit code 0 means the door heard the line and sent sound back.
"""
import argparse
import asyncio
import importlib.util
import json
import sys
import time
import wave
from pathlib import Path

import numpy as np
from aiohttp import ClientSession, WSMsgType

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('xz', HERE.parent / 'src' / 'xiaozhi-server.py')
xz = importlib.util.module_from_spec(spec)
spec.loader.exec_module(xz)


def say_line(text, tts_dir, sid):
    tts = xz.load_tts(tts_dir, 4)
    if tts is None:
        sys.exit('no voice model to make the test line')
    gc = xz.sherpa_onnx.GenerationConfig()
    gc.sid, gc.speed, gc.num_steps = sid, 1.0, 5
    audio = tts.generate(text, gc)
    x = xz.resample(np.asarray(audio.samples, dtype=np.float32), audio.sample_rate, 16000)
    return (np.clip(x, -1, 1) * 32767).astype(np.int16)


async def run(a):
    opus = xz.Opus()
    line = say_line(a.say, a.tts_dir, a.speaker)
    enc, dec = opus.encoder(16000), opus.decoder(24000)
    headers = {'Device-Id': a.device_id, 'Client-Id': a.client_id, 'Activation-Version': '1',
               'Content-Type': 'application/json', 'User-Agent': 'fake-board/1.0'}
    ota_body = {'version': 2, 'mac_address': a.device_id, 'uuid': a.client_id,
                'application': {'name': 'xiaozhi', 'version': '1.9.0'}}
    base = a.ota.rstrip('/')
    root = base.rsplit('/xiaozhi/', 1)[0]
    report = {'line': a.say}
    async with ClientSession() as http:
        # The owner calls must not answer on the board door, the one the internet can reach.
        async with http.post(root + '/xiaozhi/admin/approve', json={'code': '000000'}) as r:
            body = await r.text()
        report['admin_via_door'] = 'closed' if r.status in (403, 404) and 'no board' not in body else f'OPEN ({r.status}), wrong'
        async with http.post(base + '/', json=ota_body, headers=headers) as r:
            first = await r.json()
        if 'activation' in first:
            code = first['activation']['code']
            report['pairing_code_shown'] = first['activation']['message']
            async with http.post(base + '/activate', json={}, headers=headers) as r:
                report['activate_before_ok'] = r.status
            try:
                async with http.post(a.admin + '/approve', json={'code': code, 'name': 'Fake board', 'level': a.level}) as r:
                    report['approve'] = r.status
            except Exception as e:
                report['approve'] = f'no owner port here ({type(e).__name__}), approved by hand'
                print(f'approve code {code} on the door\'s computer; waiting up to 3 minutes', file=sys.stderr, flush=True)
            for _ in range(60):          # a real board keeps asking like this until it is approved
                async with http.post(base + '/activate', json={}, headers=headers) as r:
                    pass
                if r.status == 200:
                    break
                await asyncio.sleep(3)
            report['activate_after_ok'] = r.status
            async with http.post(base + '/', json=ota_body, headers=headers) as r:
                first = await r.json()
        wsinfo = first.get('websocket')
        if not wsinfo:
            sys.exit(f'no websocket in the OTA reply: {first}')
        report['ws_url'] = wsinfo['url']
        # A wrong token must be refused before any audio flows.
        bad = dict(headers, Authorization='Bearer wrong', **{'Protocol-Version': '1'})
        try:
            async with http.ws_connect(wsinfo['url'], headers=bad) as ws:
                report['bad_token'] = 'ACCEPTED (wrong)'
                await ws.close()
        except Exception as e:
            report['bad_token'] = f'refused ({getattr(e, "status", e)})'
        good = dict(headers, Authorization=f'Bearer {wsinfo["token"]}', **{'Protocol-Version': '1'})
        async with http.ws_connect(wsinfo['url'], headers=good) as ws:
            await ws.send_str(json.dumps({'type': 'hello', 'version': 1, 'features': {'mcp': True},
                                          'transport': 'websocket',
                                          'audio_params': {'format': 'opus', 'sample_rate': 16000,
                                                           'channels': 1, 'frame_duration': 60}}))
            sid = None
            got = {'stt': None, 'sentences': [], 'frames': 0, 'mcp_asked': []}
            pcm_out = []
            done = asyncio.Event()
            t_end = None

            async def reader():
                nonlocal sid, t_end
                async for msg in ws:
                    if msg.type == WSMsgType.TEXT:
                        m = json.loads(msg.data)
                        kind = m.get('type')
                        if kind == 'hello':
                            sid = m.get('session_id')
                            got['server_hello'] = m.get('audio_params')
                        elif kind == 'mcp':
                            p = m.get('payload') or {}
                            got['mcp_asked'].append(p.get('method'))
                            if p.get('method') == 'initialize':
                                res = {'protocolVersion': '2024-11-05', 'capabilities': {'tools': {}},
                                       'serverInfo': {'name': 'fake-board', 'version': '1.9.0'}}
                            elif p.get('method') == 'tools/list':
                                res = {'tools': [{'name': 'self.audio_speaker.set_volume', 'description': 'Set the speaker volume',
                                                  'inputSchema': {'type': 'object', 'properties': {'volume': {'type': 'integer'}}}}]}
                            else:
                                continue
                            await ws.send_str(json.dumps({'session_id': sid, 'type': 'mcp',
                                                          'payload': {'jsonrpc': '2.0', 'id': p.get('id'), 'result': res}}))
                        elif kind == 'stt':
                            got['stt'] = m.get('text')
                            got.setdefault('ms_to_stt', round((time.monotonic() - t_end) * 1000) if t_end else None)
                        elif kind == 'tts' and m.get('state') == 'sentence_start':
                            got['sentences'].append(m.get('text'))
                        elif kind == 'tts' and m.get('state') == 'stop' and t_end:
                            got['ms_to_stop'] = round((time.monotonic() - t_end) * 1000)
                            done.set()
                            return
                    elif msg.type == WSMsgType.BINARY:
                        if got['frames'] == 0 and t_end:
                            got['ms_to_first_sound'] = round((time.monotonic() - t_end) * 1000)
                        got['frames'] += 1
                        pcm_out.append(dec.decode(msg.data))

            task = asyncio.create_task(reader())
            for _ in range(50):
                if sid:
                    break
                await asyncio.sleep(0.1)
            if not sid:
                sys.exit('no hello back from the door')
            await asyncio.sleep(0.5)          # let the MCP questions go by
            await ws.send_str(json.dumps({'session_id': sid, 'type': 'listen', 'state': 'start', 'mode': a.mode}))
            step = 960
            audio = line if a.mode == 'manual' else np.concatenate([line, np.zeros(16000 * 2, dtype=np.int16)])
            if len(audio) % step:
                audio = np.concatenate([audio, np.zeros(step - len(audio) % step, dtype=np.int16)])
            for i in range(0, len(audio), step):
                await ws.send_bytes(enc.encode(audio[i:i + step]))
                await asyncio.sleep(0.06 if a.realtime else 0.005)
            t_end = time.monotonic()
            if a.mode == 'manual':
                await ws.send_str(json.dumps({'session_id': sid, 'type': 'listen', 'state': 'stop'}))
            try:
                await asyncio.wait_for(done.wait(), timeout=90)
            except asyncio.TimeoutError:
                got['timeout'] = True
            task.cancel()
            await ws.close()
        report.update(got)
    if pcm_out:
        out = np.concatenate(pcm_out)
        with wave.open(a.out, 'wb') as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(24000)
            w.writeframes(out.tobytes())
        report['reply_seconds'] = round(len(out) / 24000, 2)
        report['saved'] = a.out
    print(json.dumps(report, indent=1, ensure_ascii=False))
    ok = report.get('stt') is not None and report.get('frames', 0) > 0 and report['admin_via_door'] == 'closed'
    return 0 if ok else 1


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--ota', default='http://127.0.0.1:7788/xiaozhi/ota/')
    ap.add_argument('--admin', default='http://127.0.0.1:7789/xiaozhi/admin',
                    help="the door's owner port; when it isn't on this computer, approve the code there by hand")
    ap.add_argument('--say', default='What is the capital of Peru?')
    ap.add_argument('--tts-dir', required=True)
    ap.add_argument('--speaker', type=int, default=3, help='a voice other than PAN\'s for the test line')
    ap.add_argument('--mode', choices=['manual', 'auto'], default='manual')
    ap.add_argument('--level', choices=['guest', 'owner'], default='guest')
    ap.add_argument('--device-id', default='02:00:00:00:00:01')
    ap.add_argument('--client-id', default='00000000-0000-4000-8000-000000000001')
    ap.add_argument('--realtime', action='store_true', help='send the line at speaking pace')
    ap.add_argument('--out', default='xiaozhi-reply.wav')
    sys.exit(asyncio.run(run(ap.parse_args())))


if __name__ == '__main__':
    main()
