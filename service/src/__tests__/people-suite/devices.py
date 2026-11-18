"""The people suite on a real device and a LIVE hub. Deliberate, not part of run.py.

A paired test device is handed to a test person, lines are sent on it with the app's test
intents (debug builds), what came back is read from the device's log, then the device is taken
back and the person removed, whatever happened in between.

    python devices.py --hub http://<hub>:7777 --adb <adb serial> --link-device <pan-link id> [--role child]

Run it from a machine the hub treats as the owner. The device's microphone is switched off for
the test (in a room that is not quiet, what the microphone hears is joined onto the test lines)
and left off; nothing is spoken aloud; the device's own conversation is set aside and restored.
"""
import argparse
import json
import subprocess
import sys
import time
import urllib.error
import urllib.request

SVC = "dev.pan.app/.service.PanForegroundService"


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser()
    ap.add_argument("--hub", required=True)
    ap.add_argument("--adb", required=True, help="the device's adb serial")
    ap.add_argument("--link-device", required=True, help="the device's PAN Link id (GET /api/v1/link/devices)")
    ap.add_argument("--role", default="child", choices=["child", "guest", "user", "manager", "admin"])
    ap.add_argument("--adb-path", default="adb")
    a = ap.parse_args()

    def call(method, path, body=None):
        req = urllib.request.Request(a.hub.rstrip("/") + path, data=json.dumps(body).encode() if body is not None else None,
                                     headers={"Content-Type": "application/json"}, method=method)
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return r.status, json.loads(r.read().decode() or "{}")
        except urllib.error.HTTPError as e:
            raw = e.read().decode("utf-8", "replace")
            try:
                return e.code, json.loads(raw)
            except ValueError:
                return e.code, raw[:200]

    def sh(cmd, t=40):
        r = subprocess.run([a.adb_path, "-s", a.adb, "shell", cmd], capture_output=True, timeout=t)
        return (r.stdout + r.stderr).decode("utf-8", "replace").strip()

    def act(action, extra=""):
        return sh("am startservice -n %s -a %s %s" % (SVC, action, extra))

    def rules():
        s, d = call("GET", "/api/v1/link/devices")
        return next((len(x.get("allow") or []) for x in d if x.get("id") == a.link_device), None) if isinstance(d, list) else None

    name = "Suite Person %d" % int(time.time())
    lines = [("Tell the garden thread the test says hello.", 8, "quiet"), ("What is the garden thread doing?", 8, "quiet"),
             ("Hey PAN, what is my name?", 14, "name"), ("Hey PAN, what am I working on right now?", 14, "answer"),
             ("Can you mute yourself for a bit?", 6, "mute")]
    bad, uid, out = 0, None, ""
    try:
        s, u = call("POST", "/api/v1/auth/users", {"display_name": name, "role": a.role})
        uid = (u.get("user") or {}).get("id") if isinstance(u, dict) else None
        if s != 200 or not uid:
            print("could not add the test person:", s, u)
            return 2
        s, j = call("PUT", "/api/v1/link/devices/%s/person" % a.link_device, {"user_id": uid})
        print("device handed to %s (%s): %s, PAN Link rules on it: %s" % (name, a.role, s, rules()))
        if s != 200:
            return 2
        sh("am force-stop dev.pan.app")
        sh("am start-foreground-service -n " + SVC)
        time.sleep(14)
        sh("logcat -c")
        act("TOGGLE_MIC", "--ez on false")
        time.sleep(2)
        act("TEST_LIVE")
        for text, wait, _ in lines:
            act("TEST_RESET")
            time.sleep(1)
            act("TEST_SAY", "--es text '%s'" % text.replace("'", ""))
            time.sleep(wait)
        out = sh("logcat -d -v time -s PANEVT PanService", 60)
    finally:
        act("TEST_AUDIO_END")
        time.sleep(1)
        act("TOGGLE_MIC", "--ez on false")
        if uid:
            s, _ = call("PUT", "/api/v1/link/devices/%s/person" % a.link_device, {"user_id": None})
            print("device taken back: %s, PAN Link rules on it: %s" % (s, rules()))
            s, _ = call("DELETE", "/api/v1/auth/users/%s" % uid)
            print("test person removed:", s)

    # What came back for each line, in order: the reply_done events, and the hub's mute.
    replies = []
    for line in out.splitlines():
        if '"ev":"reply_done"' in line:
            try:
                replies.append(json.loads(line[line.index("{"):]))
            except ValueError:
                pass
    muted = "the hub heard the command" in out
    for i, (text, _, want) in enumerate(lines):
        r = replies[i] if i < len(replies) else {}
        said = str(r.get("text", ""))
        ok = {"quiet": r.get("intent") == "ambient" and not said,
              "name": "Suite Person" in said,
              "answer": bool(said) and "ran into a problem" not in said,
              "mute": muted}[want]
        bad += 0 if ok else 1
        print("%s %-46s -> %s %s" % ("ok  " if ok else "FAIL", text, r.get("intent"), json.dumps(said[:90], ensure_ascii=False)))
    print("FAILED %d" % bad if bad else "ALL OK")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
