"""The people suite, hub part: a dev hub on its own port and database, with a stand-in for
pan-link's admin API, driven the way paired devices would drive it.

What it proves (docs/PEOPLE-PLAN.md):
  owner     the owner's own devices behave as before
  pairing   a code made for a person binds the device that uses it; handing over and taking back
  wall      every route in the hub's source is closed to a person's device unless it is on the list
  talk      a person's turn: own name, nothing of the owner's, silence about the owner's threads
  notes     a note for the phone carries its sender; a person cannot send or read notes
  admin     only the owner adds, renames and removes people

Nothing here touches a live hub. Usage: python run.py --hub   (or python hub_suite.py)
"""
import json
import os
import re
import secrets
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from routes import hub_routes

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.normpath(os.path.join(HERE, "..", ".."))
SERVICE = os.path.normpath(os.path.join(SRC, ".."))
PORT = int(os.environ.get("PAN_PEOPLE_SUITE_PORT", "7781"))
ADMIN_PORT = PORT + 10011
DEV = "http://127.0.0.1:%d" % PORT
DATA = os.path.join(os.environ.get("LOCALAPPDATA") or os.path.expanduser("~/.local/share"), "PAN", "data-dev")
OWNER_NAME = "Zebulon Quasarsmith"          # planted as the owner's name; must never reach a person
ROLES = ["child", "guest", "user", "manager", "admin"]

results = []


def check(group, name, ok, got=None, skip=False):
    skip = bool(skip) and not ok
    results.append({"group": group, "name": name, "ok": bool(ok), "skip": bool(skip), "got": None if ok or skip else repr(got)[:300]})
    mark = "SKIP " if skip else ("ok   " if ok else "FAIL ")
    if not ok or skip or os.environ.get("PAN_PEOPLE_SUITE_VERBOSE"):
        print("%s[%s] %s%s" % (mark, group, name, "" if ok or skip else "  -> %s" % (repr(got)[:300],)))


class LinkAdmin:
    """Plays pan-link's admin API: pairing codes, the device list, a device's allow rules."""

    def __init__(self, secret):
        self.secret = secret
        self.devices = []
        self.up = True
        self.next_ip = 20
        self.pairs = []
        self.allow_calls = []
        suite = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def _send(self, code, obj):
                b = json.dumps(obj).encode()
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(b)))
                self.end_headers()
                self.wfile.write(b)

            def _handle(self):
                if not suite.up:
                    self.connection.close()
                    return
                if self.headers.get("x-pan-link-secret") != suite.secret:
                    return self._send(403, {"error": "forbidden"})
                n = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(n) or b"{}") if n else {}
                if self.command == "POST" and self.path == "/admin/pair":
                    ip = "10.77.0.%d" % suite.next_ip
                    suite.next_ip += 1
                    suite.pairs.append({"ip": ip, "allow": body.get("allow"), "name": body.get("name")})
                    return self._send(200, {"uri": "pan://pair?v=1&a=" + ip, "expires": "2033-05-18T03:33:19Z", "device_ip": ip})
                if self.command == "GET" and self.path == "/admin/devices":
                    return self._send(200, suite.devices)
                parts = self.path.strip("/").split("/")
                if len(parts) >= 3 and parts[:2] == ["admin", "devices"]:
                    dev = next((d for d in suite.devices if d["id"] == parts[2]), None)
                    if not dev:
                        return self._send(404, {"error": "no such device"})
                    if self.command == "PUT" and parts[3:] == ["allow"]:
                        dev["allow"] = body.get("allow") or []
                        suite.allow_calls.append((parts[2], dev["allow"]))
                        suite.save()
                        return self._send(200, dev)
                    if self.command == "DELETE" and len(parts) == 3:
                        suite.devices.remove(dev)
                        suite.save()
                        return self._send(200, {"ok": True})
                self._send(404, {"error": "not found"})

            do_GET = do_POST = do_PUT = do_DELETE = _handle

        self.server = ThreadingHTTPServer(("127.0.0.1", ADMIN_PORT), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def add(self, device_id, name, ip):
        allow = next((p.get("allow") for p in reversed(self.pairs) if p.get("ip") == ip), None)
        self.devices.append({"id": device_id, "name": name, "tunnel_ip": ip, "allow": allow or []})
        self.save()

    def save(self, restore=False):
        """link.json's device list, as pan-link writes it: the hub reads who is limited from it."""
        path = os.path.join(DATA, "link.json")
        try:
            state = json.load(open(path, encoding="utf-8"))
        except (OSError, ValueError):
            return
        if not hasattr(self, "found"):
            self.found = state.get("devices") or []
        state["devices"] = self.found if restore else self.found + self.devices
        json.dump(state, open(path, "w", encoding="utf-8"))


def link_secret():
    """The dev hub's link secret. A dev database that never had PAN Link gets one of its own."""
    os.makedirs(DATA, exist_ok=True)
    path = os.path.join(DATA, "link.json")
    try:
        state = json.load(open(path, encoding="utf-8"))
        if isinstance(state.get("secret"), str) and len(state["secret"]) >= 32:
            return state["secret"]
    except (OSError, ValueError):
        pass
    state = {"secret": secrets.token_hex(32), "devices": []}
    json.dump(state, open(path, "w", encoding="utf-8"))
    return state["secret"]


SECRET = None


def call(method, path, body=None, device=None, headers=None, secret=None, timeout=30):
    h = {"Content-Type": "application/json", "Connection": "close"}
    if device:
        h["x-pan-link-secret"] = secret or SECRET
        h["x-pan-device"] = device
        h["x-pan-device-name"] = "suite"
    h.update(headers or {})
    data = json.dumps(body).encode() if body is not None else (b"{}" if method in ("POST", "PUT", "PATCH", "DELETE") else None)
    req = urllib.request.Request(DEV + path, data=data, headers=h, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read(200_000).decode("utf-8", "replace")
            try:
                return r.status, json.loads(raw)
            except ValueError:
                return r.status, raw[:200]
    except urllib.error.HTTPError as e:
        raw = e.read(20_000).decode("utf-8", "replace")
        try:
            return e.code, json.loads(raw)
        except ValueError:
            return e.code, raw[:200]
    except Exception as e:                      # a path the client itself will not send, a reset
        return 0, "%s: %s" % (type(e).__name__, e)


def turn(text, device, extra=None, headers=None, timeout=120):
    """One spoken line through /query/stream. -> (status, the done result, what was said)."""
    h = {"Content-Type": "application/json", "Connection": "close", "x-pan-link-secret": SECRET, "x-pan-device": device, "x-pan-device-name": "suite"}
    h.update(headers or {})
    body = {"text": text, "context": "", "since_pan_ms": 999999}
    body.update(extra or {})
    req = urllib.request.Request(DEV + "/api/v1/query/stream", data=json.dumps(body).encode(), headers=h, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, None, ""
    except Exception as e:
        return 0, None, str(e)
    events = [json.loads(line[6:]) for line in raw.splitlines() if line.startswith("data: ")]
    done = next((e.get("result") for e in events if e.get("type") == "done"), None)
    return 200, done, "".join(e.get("text", "") for e in events if e.get("type") == "chunk")


def no_model(reply):
    return "ran into a problem" in str(reply or "")


def device_id(n):
    return "d%012x" % (0xA000 + n)


def main():
    global SECRET
    SECRET = link_secret()
    try:
        urllib.request.urlopen(DEV + "/health", timeout=2)
        print("Port %d already answers: stop that dev hub first, or set PAN_PEOPLE_SUITE_PORT." % PORT)
        return 2
    except Exception:
        pass
    admin = LinkAdmin(SECRET)
    OWNER = device_id(1)
    admin.add(OWNER, "owner phone", "10.77.0.2")
    env = dict(os.environ, PAN_LINK_ADMIN="http://127.0.0.1:%d" % ADMIN_PORT)
    log = open(os.path.join(HERE, "hub-suite.log"), "w", encoding="utf-8")
    proc = subprocess.Popen(["node", "dev-server.js", str(PORT)], cwd=SERVICE, env=env, stdout=log, stderr=log)
    people = {}       # role -> {"id": user id, "name": ..., "device": link device id}
    restore_name = None
    try:
        for _ in range(90):
            if call("GET", "/health")[0] == 200:
                break
            time.sleep(1)
        else:
            print("The dev hub did not start. See %s" % log.name)
            return 2

        # ── owner ────────────────────────────────────────────────────────────────
        s, me = call("GET", "/api/v1/auth/me", device=OWNER)
        check("owner", "the owner's device is the owner, and is not told it is a person's", s == 200 and (me.get("user") or me).get("role") == "owner" and (me.get("user") or me).get("person") is False, (s, me))
        s, st = call("GET", "/api/v1/settings", device=OWNER)
        check("owner", "the owner's device reads the settings", s == 200, s)
        restore_name = st.get("display_name") if isinstance(st, dict) else None
        s, _ = call("PUT", "/api/v1/settings", {"display_name": OWNER_NAME}, device=OWNER)
        check("owner", "the owner's device changes a setting", s == 200, s)
        s, done, said = turn("Hey PAN, how many legs does a spider have?", OWNER, extra={"bench": True}, headers={"x-device-id": "suite-owner-phone"})
        reply = (done or {}).get("response", "")
        check("owner", "the owner's device talks to PAN", s == 200 and bool(reply), (s, done), skip=no_model(reply))

        # ── pairing ──────────────────────────────────────────────────────────────
        stamp = int(time.time())
        for i, role in enumerate(ROLES):
            name = "Suite %s %d" % (role.capitalize(), stamp)
            s, u = call("POST", "/api/v1/auth/users", {"display_name": name, "role": role}, device=OWNER)
            uid = (u.get("user") or {}).get("id") if isinstance(u, dict) else None
            check("pairing", "the owner adds a %s" % role, s == 200 and isinstance(uid, int), (s, u))
            s, j = call("POST", "/api/v1/link/pair", {"name": "%s device" % role, "for_user": uid}, device=OWNER)
            pair = admin.pairs[-1] if admin.pairs else {}
            check("pairing", "a code for the %s is made limited from the start" % role,
                  s == 200 and isinstance(pair.get("allow"), list) and len(pair["allow"]) > 0 and all(r.split(" ")[1] == "/api/v1/threads/jobs/*" for r in pair["allow"] if "*" in r), (s, j, pair))
            dev = device_id(10 + i)
            admin.add(dev, "%s device" % role, pair.get("ip"))
            people[role] = {"id": uid, "name": name, "device": dev}
            s, me = call("GET", "/api/v1/auth/me", device=dev)
            who = (me.get("user") or me) if isinstance(me, dict) else {}
            check("pairing", "the %s's device arrives as that person, and is told so" % role, s == 200 and who.get("id") == uid and who.get("role") == role and who.get("person") is True, (s, me))
        s, j = call("POST", "/api/v1/link/pair", {"name": "ghost", "for_user": 987654}, device=OWNER)
        check("pairing", "a code for someone who does not exist is refused", s == 400, (s, j))
        s, j = call("POST", "/api/v1/link/pair", {"name": "his own second phone", "for_user": 1}, device=OWNER)
        check("pairing", "a code for the owner himself is not limited", s == 200 and admin.pairs[-1].get("allow") is None, (s, admin.pairs[-1]))
        own2 = device_id(30)
        admin.add(own2, "his own second phone", admin.pairs[-1]["ip"])
        s, me = call("GET", "/api/v1/auth/me", device=own2)
        check("pairing", "the owner's second device is the owner", s == 200 and (me.get("user") or me).get("role") == "owner", (s, me))
        s, _ = call("GET", "/api/v1/auth/me", device=people["child"]["device"], secret="x" * 64)
        check("pairing", "a wrong link secret is refused", s == 403, s)
        s, j = call("GET", "/api/v1/link/people", device=OWNER)
        bound = {d.get("link_device_id"): d.get("user_id") for d in (j.get("devices") or [])} if isinstance(j, dict) else {}
        check("pairing", "the owner sees whose every device is", all(bound.get(p["device"]) == p["id"] for p in people.values()), bound)

        # a code is waiting and pan-link cannot be asked: an unknown device is not taken for the owner
        s, j = call("POST", "/api/v1/link/pair", {"name": "late", "for_user": people["child"]["id"]}, device=OWNER)
        late_ip = admin.pairs[-1]["ip"]
        late = device_id(40)
        admin.up = False
        time.sleep(6)
        s, j = call("GET", "/api/v1/settings", device=late)
        check("pairing", "code waiting and pan-link silent: an unknown device gets 503, never the owner's reach", s == 503, (s, j))
        s, j = call("GET", "/", device=late)
        check("pairing", "the same for a page, not only /api", s == 503, (s, str(j)[:80]))
        admin.up = True
        admin.add(late, "late", late_ip)
        s, j = call("GET", "/api/v1/settings", device=late)
        check("pairing", "pan-link back: that device is the child's and closed", s == 403, (s, j))

        # a removed person: the device is nobody's, and stays closed
        s, u = call("POST", "/api/v1/auth/users", {"display_name": "Suite Gone %d" % stamp, "role": "user"}, device=OWNER)
        gone_id = (u.get("user") or {}).get("id")
        call("POST", "/api/v1/link/pair", {"name": "gone device", "for_user": gone_id}, device=OWNER)
        gone = device_id(41)
        admin.add(gone, "gone device", admin.pairs[-1]["ip"])
        call("GET", "/api/v1/auth/me", device=gone)
        s, _ = call("DELETE", "/api/v1/auth/users/%s" % gone_id, device=OWNER)
        time.sleep(1)                           # at once, not after people.js's half minute of remembering
        s, me = call("GET", "/api/v1/auth/me", device=gone)
        s2, j2 = call("GET", "/api/v1/settings", device=gone)
        check("pairing", "a removed person's device is nobody's and still closed", s2 == 403 and not (s == 200 and (me.get("user") or me).get("role") == "owner"), (s, me, s2))

        # ── the wall ─────────────────────────────────────────────────────────────
        kid = people["child"]["device"]
        s, me = call("GET", "/api/v1/auth/me", device=kid)
        s2, _ = call("GET", "/api/v1/settings", device=kid)
        safe = s == 200 and (me.get("user") or me).get("role") == "child" and s2 == 403
        check("wall", "the sweep's device is a child and the wall is up (or the sweep does not run)", safe, (s, me, s2))
        routes = hub_routes(SRC)
        check("wall", "the source lists the hub's routes (%d found)" % len(routes), len(routes) > 400, len(routes))
        s, j = call("GET", "/api/v1/link/people", device=OWNER)
        allow = set()
        try:
            src = open(os.path.join(SRC, "people.js"), encoding="utf-8").read()
            block = src[src.index("export const PERSON_ALLOW"):]
            block = block[:block.index("]);")]
            allow = set(re.findall(r"'([A-Z]+) (/[^']*)'", block))
        except (OSError, ValueError):
            pass
        check("wall", "the list of what a person may reach is read from people.js (%d paths)" % len(allow), 5 <= len(allow) <= 20, allow)
        if safe:
            open_wrongly, closed_wrongly = [], []
            for n, (method, path) in enumerate(routes):
                devices = [kid] + ([people[ROLES[1 + (n // 4) % 4]]["device"]] if n % 4 == 0 else [])
                for dev in devices:
                    listed = any(m == method and (path == r or (r.endswith("/*") and path.startswith(r[:-1]))) for m, r in allow)
                    if listed:
                        if path == "/api/v1/query/stream":
                            continue                    # talking has its own checks below
                        s, j = call(method, path, device=dev, timeout=20)
                        # Open means the wall let it through. A route can still say no for its own
                        # reason (a relay host this device does not hold): the computers group checks those.
                        if s == 0 or (s == 403 and isinstance(j, dict) and j.get("error") == "not open to this person"):
                            closed_wrongly.append((method, path, s))
                    else:
                        s, j = call(method, path, device=dev, timeout=20)
                        if not (s == 403 and isinstance(j, dict) and j.get("error") == "not open to this person"):
                            open_wrongly.append((method, path, s, str(j)[:60]))
            check("wall", "every route not on the list answers a person 'not open to this person' (%d routes)" % len(routes), not open_wrongly, open_wrongly[:12])
            check("wall", "every route on the list is open to a person", not closed_wrongly, closed_wrongly)
            shapes = ["/", "/mobile/", "/mobile/index.html", "/v2/terminal", "/dashboard", "/dashboard/api/mem", "/dashboard/api/events", "/pan-models.html",
                      "/health/", "/health/../api/v1/settings", "/health/..%2fapi/v1/settings", "/health%2f..%2fapi%2fv1%2fsettings", "//api/v1/settings",
                      "/api/v1//settings", "/API/V1/SETTINGS", "/api/v1/settings/", "/api/v1/settings?x=/health", "/api/v1/auth/me/../users",
                      "/api/v1/auth/me/..%2fusers", "/api/v1/logs/../settings", "/apk/latest/../../api/v1/settings", "/api/v1/query/stream/../settings",
                      "/api/v1/query", "/api/v1/query/stream/extra", "/api/v1/vision/../recall", "/api/v1/settings%00", "/api/v1/settings;x=1",
                      "/.env", "/link.json", "/api/v1/link/pair", "/api/v1/link/devices", "/api/v1/hub-address", "/ws/terminal", "/ws/client"]
            wrong = []
            for path in shapes:
                for method in ("GET", "POST"):
                    s, j = call(method, path, device=kid, timeout=20)
                    if s != 403 and not (s == 0):
                        wrong.append((method, path, s, str(j)[:60]))
            check("wall", "pages, odd spellings and paths dressed as allowed ones are closed too (%d tries)" % (len(shapes) * 2), not wrong, wrong[:12])
            s, j = call("GET", "/api/v1/settings", device=kid, headers={"X-HTTP-Method-Override": "GET", "X-Forwarded-For": "127.0.0.1", "X-Real-IP": "100.64.0.1", "X-PAN-Scope": "main", "X-Device-Name": "owner phone"})
            check("wall", "headers that claim to be local, the tailnet or the owner's phone change nothing", s == 403, (s, j))
            s, j = call("GET", "/api/v1/settings", device=OWNER)
            check("wall", "the owner's device is still not walled", s == 200, s)
            s, j = call("GET", "/", device=OWNER)
            check("wall", "the owner's device still gets pages", s == 200, s)

        # ── talk ─────────────────────────────────────────────────────────────────
        call("POST", "/api/v1/threads/report", {"host": "people-suite", "threads": [
            {"session_id": "suite-garden", "title": "Garden", "cwd": "C:/x", "last_activity": int(time.time() * 1000)},
            {"session_id": "suite-taxes", "title": "Taxes", "cwd": "C:/y", "last_activity": int(time.time() * 1000) - 1000}]}, device=OWNER)
        token = "zxqv%d" % stamp
        for role in ROLES:
            p = people[role]
            dev = p["device"]
            s, done, said = turn("Can you mute yourself for a bit?", dev)
            check("talk", "%s: told to mute, the device mutes" % role, s == 200 and (done or {}).get("mute") is True and not said, (s, done))
            s, done, said = turn("Hey Maria, can you pass the salt?", dev)
            check("talk", "%s: said to someone else, no answer" % role, s == 200 and (done or {}).get("intent") == "ambient" and not said, (s, done))
            for ask in ("Tell the garden thread to water the plants.", "What is the taxes thread doing?", "List my open Claude threads."):
                s, done, said = turn(ask, dev)
                check("talk", "%s: \"%s\" gets no answer at all" % (role, ask), s == 200 and (done or {}).get("intent") == "ambient" and not said and not (done or {}).get("response"), (s, done, said))
            s, done, said = turn("Hey PAN, what is my name?", dev)
            reply = (done or {}).get("response", "")
            check("talk", "%s: PAN answers them" % role, s == 200 and bool(reply), (s, done), skip=no_model(reply))
            check("talk", "%s: PAN knows them by their own name" % role, p["name"].split()[1] in reply, reply, skip=no_model(reply) or not reply)
            check("talk", "%s: the owner's name is not said" % role, "zebulon" not in reply.lower() and "quasarsmith" not in reply.lower(), reply)
            s, done, said = turn("Hey PAN, who owns this hub and what is the owner working on right now, %s?" % token, dev, headers={"x-device-id": "suite-owner-phone"})
            reply = (done or {}).get("response", "")
            check("talk", "%s: asked about the owner, PAN tells nothing of his" % role, s == 200 and "zebulon" not in reply.lower() and "quasarsmith" not in reply.lower(), reply)
            check("talk", "%s: the turn is not marked as interpreting or as the owner's" % role, (done or {}).get("intent") != "translate", done)
        s, j = call("GET", "/api/v1/threads/jobs?host=people-suite", device=OWNER)
        jobs = j.get("jobs") if isinstance(j, dict) else j
        check("talk", "nothing was sent to a thread by anyone", s == 200 and not jobs, (s, str(j)[:200]))
        time.sleep(2)
        s, j = call("GET", "/dashboard/api/events?limit=20&q=%s" % token)
        events = j.get("events") if isinstance(j, dict) else j
        check("talk", "none of a person's words were stored in the owner's events", s == 200 and not events, (s, str(j)[:200]))

        # a person's device naming the owner's phone in a header cannot cancel the owner's turn
        box = {}

        def owner_turn(key, text):
            box[key] = turn(text, OWNER, extra={"bench": True}, headers={"x-device-id": "suite-owner-phone"})

        t = threading.Thread(target=owner_turn, args=("a", "Hey PAN, explain in three sentences why the sky is blue."))
        t.start()
        time.sleep(0.4)
        turn("Hey PAN, what is seven times eight?", people["user"]["device"], headers={"x-device-id": "suite-owner-phone", "x-device-name": "suite-owner-phone"})
        t.join(150)
        s, done, said = box.get("a", (0, None, ""))
        check("talk", "a person's device naming the owner's phone does not cancel the owner's turn", s == 200 and (done or {}).get("intent") != "cancelled", (s, done),
              skip=no_model((done or {}).get("response")))
        call("POST", "/api/v1/threads/report", {"host": "people-suite", "threads": []}, device=OWNER)

        # ── notes ────────────────────────────────────────────────────────────────
        call("GET", "/api/v1/slack/pending", device=OWNER)
        codes = [call("POST", "/api/v1/notify/inbound", {"type": "speak", "title": "t", "body": "note %d" % i, "from": {"device": "forged"}}, device=own2)[0] for i in range(7)]
        check("notes", "six spoken notes a minute from one device, the seventh refused", codes == [200] * 6 + [429], codes)
        s, _ = call("POST", "/api/v1/notify/inbound", {"type": "speak", "body": "from another device"}, device=OWNER)
        check("notes", "another device is not held back by that", s == 200, s)
        s, _ = call("POST", "/api/v1/notify/inbound", {"type": "info", "body": "not spoken"}, device=own2)
        check("notes", "a note that is not spoken is not counted", s == 200, s)
        s, j = call("GET", "/api/v1/slack/pending", device=OWNER)
        notes = [n for n in ((j or {}).get("notifications", []) if isinstance(j, dict) else []) if str(n.get("body", "")).startswith("note ")]
        check("notes", "each note carries the device that really sent it, whatever the note claims", len(notes) == 6 and all((n.get("from") or {}).get("device") == own2 for n in notes), [n.get("from") for n in notes])
        # Whose device gets a note. Each device asks first, so the hub has seen all of them.
        PHONE = {"x-device-id": "suite-owner-phone"}
        TABLET = {"x-device-id": "suite-owner-tablet"}

        def bodies(got):
            return sorted(str(n.get("body", "")) for n in ((got or {}).get("notifications", []) if isinstance(got, dict) else []))

        def pending(device, headers=None):
            s_, j_ = call("GET", "/api/v1/slack/pending", device=device, headers=headers)
            return s_, bodies(j_)
        for role in ROLES:
            s, j = call("POST", "/api/v1/notify/inbound", {"type": "speak", "body": "hi"}, device=people[role]["device"])
            check("notes", "%s: cannot send a note" % role, s == 403, s)
        pending(OWNER, PHONE)
        pending(own2, TABLET)
        child, user = people["child"], people["user"]
        s, j = call("POST", "/api/v1/notify/inbound", {"type": "info", "title": "t", "body": "for the child", "to_user": child["id"]}, device=OWNER)
        check("notes", "the owner sends a note to a person", s == 200, (s, j))
        call("POST", "/api/v1/notify/inbound", {"type": "info", "title": "t", "body": "for the owner"}, device=OWNER)
        got = {role: pending(people[role]["device"], PHONE) for role in ROLES}
        wrong = {r: g for r, g in got.items() if g != (200, ["for the child"] if r == "child" else [])}
        check("notes", "a person's device gets that person's notes and nobody else's, whatever name it sends", not wrong, wrong)
        s, mine = pending(OWNER, PHONE)
        check("notes", "the owner's note is still his, and the child's did not come to him", s == 200 and mine == ["for the owner"], (s, mine))
        s, j = call("POST", "/api/v1/notify/inbound", {"type": "info", "body": "x", "to_user": 987654}, device=OWNER)
        check("notes", "a note for somebody who is not there is refused", s == 400, (s, j))
        s, j = call("PUT", "/api/v1/link/devices/%s/limited" % own2, {"limited": True}, device=OWNER)
        s2, j2 = call("POST", "/api/v1/notify/inbound", {"type": "info", "body": "sneak", "to_user": child["id"]}, device=own2)
        s3, _ = call("POST", "/api/v1/notify/inbound", {"type": "info", "body": "plain"}, device=own2)
        check("notes", "a device limited to sending notes cannot say who a note is for", s == 200 and s2 == 403 and s3 == 200, (s, s2, s3))
        call("PUT", "/api/v1/link/devices/%s/limited" % own2, {"limited": False}, device=OWNER)
        pending(OWNER, PHONE)
        # His notes go to one device of his: the one pinned, else the one he last talked on.
        call("PUT", "/api/v1/settings", {"notes_device": "suite-owner-tablet"}, device=OWNER)
        time.sleep(11)  # the pin is read every ten seconds
        pending(OWNER, PHONE)
        pending(own2, TABLET)
        call("POST", "/api/v1/notify/inbound", {"type": "info", "body": "pinned"}, device=OWNER)
        s, a = pending(OWNER, PHONE)
        s2, b = pending(own2, TABLET)
        check("notes", "his notes go to the device he pinned, not to whichever asks first", a == [] and b == ["pinned"], (a, b))
        call("PUT", "/api/v1/settings", {"notes_device": ""}, device=OWNER)
        time.sleep(11)
        for role in ROLES:
            call("GET", "/api/v1/slack/pending", device=people[role]["device"])
        s, j = call("POST", "/api/v1/chat/incoming", {"from_instance_id": "stranger", "body": "hello"}, device=OWNER)
        check("notes", "the old door for another hub's messages is gone", s == 404, (s, j))

        # ── computers: a person's computer is that person's client ───────────────
        ms = lambda: int(time.time() * 1000)
        pcs = {}
        for n, (first, role) in enumerate((("Zora", "user"), ("Quill", "child"))):
            s, u = call("POST", "/api/v1/auth/users", {"display_name": "%s Suite %d" % (first, stamp), "role": role}, device=OWNER)
            uid = (u.get("user") or {}).get("id")
            call("POST", "/api/v1/link/pair", {"name": "%s computer" % first, "for_user": uid}, device=OWNER)
            dev = device_id(60 + n)
            admin.add(dev, "%s computer" % first, admin.pairs[-1]["ip"])
            call("GET", "/api/v1/auth/me", device=dev)
            pcs[first] = {"id": uid, "device": dev, "host": "suite-%s-pc" % first.lower(), "name": first}
            people["pc-" + first] = {"id": uid, "name": first, "device": dev}
        zora, quill = pcs["Zora"], pcs["Quill"]
        call("POST", "/api/v1/threads/report", {"host": "people-suite", "threads": [
            {"session_id": "suite-garden", "title": "Garden", "cwd": "C:/x", "last_activity": ms()},
            {"session_id": "suite-notes", "title": "Notes", "cwd": "C:/x", "last_activity": ms()}]}, device=OWNER)
        s, j = call("POST", "/api/v1/threads/report", {"host": zora["host"], "threads": [
            {"session_id": "zora-homework", "title": "Homework", "cwd": "C:/z", "last_activity": ms()},
            {"session_id": "zora-notes", "title": "Notes", "cwd": "C:/z", "last_activity": ms()}]}, device=zora["device"])
        check("computers", "an adult's computer reports its own threads", s == 200 and j.get("count") == 2, (s, j))
        s, j = call("POST", "/api/v1/threads/report", {"host": quill["host"], "threads": [
            {"session_id": "quill-drawing", "title": "Drawing", "cwd": "C:/q", "last_activity": ms()}]}, device=quill["device"])
        check("computers", "a child's computer reports its own threads", s == 200, (s, j))
        planted = {"session_id": "planted", "title": "Planted", "cwd": "C:/p", "last_activity": ms()}
        tries = {"another person's computer": call("POST", "/api/v1/threads/report", {"host": zora["host"], "threads": [planted]}, device=quill["device"])[0],
                 "the owner's computer": call("POST", "/api/v1/threads/report", {"host": "people-suite", "threads": [planted]}, device=zora["device"])[0],
                 "a person's computer, from the owner's second device": call("POST", "/api/v1/threads/report", {"host": zora["host"], "threads": [planted]}, device=own2)[0]}
        s, reg = call("GET", "/api/v1/threads", device=OWNER)
        listed = reg.get("threads", []) if isinstance(reg, dict) else []
        check("computers", "nobody reports threads under a name another computer holds", all(v == 403 for v in tries.values()) and not any(t.get("title") == "Planted" for t in listed), (tries, [t.get("title") for t in listed]))
        hw = next((t for t in listed if t.get("session_id") == "zora-homework"), {})
        check("computers", "the owner sees a person's threads, marked as that person's", hw.get("theirs") == 1 and str(hw.get("owner_name", "")).startswith("Zora"), hw)
        seen = {"the registry": call("GET", "/api/v1/threads", device=zora["device"])[0],
                "a name looked up": call("GET", "/api/v1/threads/match?name=garden", device=zora["device"])[0],
                "a job asked for over the API": call("POST", "/api/v1/threads/ask", {"target": "garden", "text": "hi"}, device=zora["device"])[0],
                "jobs with no host named": call("GET", "/api/v1/threads/jobs", device=zora["device"])[0],
                "the owner's jobs": call("GET", "/api/v1/threads/jobs?host=people-suite", device=zora["device"])[0],
                "another person's jobs": call("GET", "/api/v1/threads/jobs?host=%s" % quill["host"], device=zora["device"])[0],
                "the owner's next job": call("GET", "/api/v1/threads/jobs/next?host=people-suite&wait=1000", device=zora["device"])[0],
                "another person's next job": call("GET", "/api/v1/threads/jobs/next?host=%s&wait=1000" % zora["host"], device=quill["device"])[0]}
        check("computers", "a person's computer sees no registry, no other host's jobs and cannot ask over the API", all(v == 403 for v in seen.values()), seen)
        s, j = call("GET", "/api/v1/threads/jobs?host=%s" % zora["host"], device=zora["device"])
        check("computers", "it sees the jobs of its own host", s == 200 and isinstance(j.get("jobs"), list), (s, j))

        # The owner asks a person's thread: only that person's computer can take the job and answer it.
        s, j = call("POST", "/api/v1/threads/ask", {"session_id": "zora-homework", "text": "How far along is it?"}, device=OWNER)
        job_id = (j.get("job") or {}).get("id") if isinstance(j, dict) else None
        check("computers", "the owner sends a job to a person's thread", s == 200 and bool(job_id), (s, j))
        other = {"read": call("GET", "/api/v1/threads/jobs/%s" % job_id, device=quill["device"])[0],
                 "answer": call("POST", "/api/v1/threads/jobs/%s/reply" % job_id, {"text": "forged"}, device=quill["device"])[0],
                 "fail": call("POST", "/api/v1/threads/jobs/%s/fail" % job_id, {"error": "forged"}, device=quill["device"])[0],
                 "mark delivered": call("POST", "/api/v1/threads/jobs/%s/delivered" % job_id, {}, device=quill["device"])[0]}
        check("computers", "another person's computer cannot read, answer or fail that job", all(v == 404 for v in other.values()), other)
        s, got = call("GET", "/api/v1/threads/jobs/next?host=%s&wait=2000" % zora["host"], device=zora["device"])
        msg = (got.get("job") or {}).get("message", "") if isinstance(got, dict) else ""
        check("computers", "the person's own computer takes it, and is told the owner is asking", s == 200 and (got.get("job") or {}).get("id") == job_id and "The owner of this" in msg, (s, msg[:200]))
        s, j = call("POST", "/api/v1/threads/jobs/%s/reply" % job_id, {"text": "Two tasks are left."}, device=zora["device"])
        check("computers", "and answers it", s == 200 and j.get("ok") is True, (s, j))
        s, j = call("GET", "/api/v1/threads/jobs/%s" % job_id, device=OWNER)
        check("computers", "the answer is the one its own computer gave", (j.get("job") or {}).get("reply") == "Two tasks are left.", j)
        call("GET", "/api/v1/slack/pending", device=OWNER, headers={"x-device-id": "suite-owner-phone"})

        # By voice. The adult asks her own thread; her computer answers while the turn is open.
        def answer(host, device, text, box):
            s_, got_ = call("GET", "/api/v1/threads/jobs/next?host=%s&wait=20000" % host, device=device, timeout=40)
            job_ = (got_.get("job") or {}) if isinstance(got_, dict) else {}
            box["job"] = job_
            if job_.get("id"):
                call("POST", "/api/v1/threads/jobs/%s/reply" % job_["id"], {"text": text}, device=device)
        box = {}
        t = threading.Thread(target=answer, args=(zora["host"], zora["device"], "The essay is half done.", box))
        t.start()
        time.sleep(0.5)
        s, done, said = turn("Tell the homework thread to say how far the essay is.", zora["device"])
        t.join(60)
        check("computers", "an adult talks to a thread on her own computer by voice", s == 200 and (done or {}).get("intent") == "thread" and "half done" in str((done or {}).get("response")), (s, done))
        check("computers", "that job says she asked, and went to her own computer", box.get("job", {}).get("asked_by") == zora["id"] and box.get("job", {}).get("host") == zora["host"] and "Your user is talking to you" in box.get("job", {}).get("message", ""), box.get("job"))
        s, done, said = turn("List my open Claude threads.", zora["device"])
        reply = str((done or {}).get("response", ""))
        check("computers", "her list is her own threads and none of the owner's", "Homework" in reply and "Notes" in reply and "Garden" not in reply and "Drawing" not in reply, reply)

        def queued(host):
            s_, j_ = call("GET", "/api/v1/threads/jobs?host=%s" % host, device=OWNER)
            return len(j_.get("jobs", [])) if isinstance(j_, dict) else -1
        before = (queued("people-suite"), queued(quill["host"]))
        s, done, said = turn("Tell the notes thread to add milk.", zora["device"], extra={"bench": True})
        parse = (done or {}).get("thread_parse") or {}
        check("computers", "\"the notes thread\" from her is her own Notes, never the owner's", parse.get("title") == "Notes" and "thread relay parsed send" in str((done or {}).get("response")), done)
        r1 = turn("Tell the garden thread to water the plants.", zora["device"])
        r2 = turn("Tell the zebra crossing thread to water the plants.", zora["device"])
        r3 = turn("Tell the drawing thread hello.", zora["device"])
        same = [str((r[1] or {}).get("response", "")).replace("garden", "X").replace("zebra crossing", "X").replace("drawing", "X") for r in (r1, r2, r3)]
        check("computers", "the owner's thread, another person's and one nobody has get her the same answer", len(set(same)) == 1 and "couldn't find" in same[0], same)
        check("computers", "and nothing was queued on the owner's computer or the other person's", (queued("people-suite"), queued(quill["host"])) == before, (before, queued("people-suite"), queued(quill["host"])))
        # A child has a computer too, but may not use threads by voice: no answer, nothing queued.
        kq = queued(quill["host"])
        for ask in ("What is the drawing thread doing?", "List my open Claude threads.", "Tell the garden thread hello."):
            s, done, said = turn(ask, quill["device"])
            check("computers", "the child: \"%s\" gets no answer" % ask, s == 200 and (done or {}).get("intent") == "ambient" and not said, (s, done, said))
        check("computers", "and nothing was queued for the child", queued(quill["host"]) == kq and queued("people-suite") == before[0], (kq, queued(quill["host"])))
        # The owner, by voice (a bench turn: parsed, nothing sent).
        s, done, said = turn("What is Zora's homework thread doing?", OWNER, extra={"bench": True}, headers={"x-device-id": "suite-owner-phone"})
        check("computers", "the owner asks about a person's thread by her name", ((done or {}).get("thread_parse") or {}).get("title") == "Homework", done)
        s, done, said = turn("Tell the notes thread to add milk.", OWNER, extra={"bench": True}, headers={"x-device-id": "suite-owner-phone"})
        check("computers", "the owner's \"notes thread\" is his own Notes", "thread relay parsed send" in str((done or {}).get("response")) and ((done or {}).get("thread_parse") or {}).get("title") == "Notes", done)
        s, j = call("GET", "/api/v1/threads/match?name=notes", device=OWNER)
        check("computers", "and it is the one on his own computer", (j.get("thread") or {}).get("host") == "people-suite", j)
        # ── messages between people on this ΠAN ──────────────────────────────────
        boss = OWNER_NAME.split()[0]
        for dev_ in (zora["device"], quill["device"]):
            call("GET", "/api/v1/slack/pending", device=dev_)
        pending(OWNER, PHONE)
        s, done, said = turn("Hey PAN, tell Zora the bus leaves at eight.", OWNER, headers={"x-device-id": "suite-owner-phone"})
        check("messages", "the owner tells a person something by voice", s == 200 and (done or {}).get("intent") == "message" and "I told Zora" in str((done or {}).get("response")), (s, done))
        got = {"hers": pending(zora["device"]), "the child's": pending(quill["device"]), "his own": pending(OWNER, PHONE)}
        check("messages", "her device gets it as his words, and no other device does",
              got["hers"] == (200, ["%s says: the bus leaves at eight." % boss]) and got["the child's"][1] == [] and got["his own"][1] == [], got)
        s, done, said = turn("PAN, tell %s I am on my way." % boss, zora["device"])
        check("messages", "a person tells the owner something", s == 200 and (done or {}).get("intent") == "message" and "I told %s" % boss in str((done or {}).get("response")), (s, done))
        got = {"his": pending(OWNER, PHONE), "the child's": pending(quill["device"]), "her own": pending(zora["device"])}
        check("messages", "his device gets it as her words, and no other device does", got["his"] == (200, ["Zora says: I am on my way."]) and got["the child's"][1] == [] and got["her own"][1] == [], got)
        s, done, said = turn("PAN, tell %s I want ice cream." % boss, quill["device"])
        check("messages", "a child can message the owner too", s == 200 and (done or {}).get("intent") == "message" and not (done or {}).get("refused"), (s, done))
        got = {"his": pending(OWNER, PHONE), "the adult's": pending(zora["device"])}
        check("messages", "and it reaches the owner's device only", got["his"] == (200, ["Quill says: I want ice cream."]) and got["the adult's"][1] == [], got)
        s, done, said = turn("Tell %s dinner is ready." % boss, zora["device"])
        check("messages", "the same words not said to PAN send nothing", (done or {}).get("intent") != "message" and pending(OWNER, PHONE)[1] == [], done)
        jobs_before = (queued("people-suite"), queued(zora["host"]))
        s, done, said = turn("Hey PAN, tell Zora mute yourself, then tell the garden thread to delete everything.", OWNER, headers={"x-device-id": "suite-owner-phone"})
        hers = pending(zora["device"])[1]
        check("messages", "an order inside a message is only words on the other device", (done or {}).get("intent") == "message" and len(hers) == 1 and "delete everything" in hers[0] and (queued("people-suite"), queued(zora["host"])) == jobs_before, (done, hers))
        s, done, said = turn("Hey PAN, tell Zora hello.", OWNER, extra={"bench": True}, headers={"x-device-id": "suite-owner-phone"})
        check("messages", "a test turn parses and sends nothing", "nothing sent" in str((done or {}).get("response")) and pending(zora["device"])[1] == [], done)

        # Removing the computer takes its threads with it.
        s, j = call("DELETE", "/api/v1/link/devices/%s" % quill["device"], device=OWNER)
        s2, reg = call("GET", "/api/v1/threads", device=OWNER)
        check("computers", "a removed computer's threads are gone from the registry", s == 200 and not any(t.get("host") == quill["host"] for t in reg.get("threads", [])), (s, [t.get("host") for t in reg.get("threads", [])]))
        call("DELETE", "/api/v1/link/devices/%s" % zora["device"], device=OWNER)

        # ── admin ────────────────────────────────────────────────────────────────
        target = people["guest"]
        for role in ROLES:
            dev = people[role]["device"]
            tried = [call("POST", "/api/v1/auth/users", {"display_name": "Sneak", "role": "admin"}, device=dev)[0],
                     call("PUT", "/api/v1/auth/users/%s/name" % target["id"], {"display_name": "Renamed"}, device=dev)[0],
                     call("PUT", "/api/v1/auth/users/%s/role" % people[role]["id"], {"role": "owner"}, device=dev)[0],
                     call("PUT", "/api/v1/auth/users/%s/power" % people[role]["id"], {"power": 100}, device=dev)[0],
                     call("DELETE", "/api/v1/auth/users/%s" % target["id"], device=dev)[0],
                     call("POST", "/api/v1/link/pair", {"name": "mine"}, device=dev)[0],
                     call("PUT", "/api/v1/link/devices/%s/person" % dev, {"user_id": None}, device=dev)[0],
                     call("PUT", "/api/v1/settings", {"people_limits": "{}"}, device=dev)[0]]
            check("admin", "%s: cannot add, rename, promote or remove people, pair a device, free their own device or change the limits" % role, tried == [403] * 8, tried)
        s, j = call("PUT", "/api/v1/auth/users/%s/name" % target["id"], {"display_name": "Suite Renamed %d" % stamp}, device=OWNER)
        check("admin", "the owner renames a person", s == 200 and (j.get("user") or {}).get("display_name", "").startswith("Suite Renamed"), (s, j))
        s, j = call("PUT", "/api/v1/auth/users/%s/name" % target["id"], {"display_name": "   "}, device=OWNER)
        check("admin", "an empty name is refused", s == 400, (s, j))
        s, j = call("PUT", "/api/v1/auth/users/987654/name", {"display_name": "Nobody"}, device=OWNER)
        check("admin", "renaming someone who does not exist is refused", s == 404, (s, j))
        s, j = call("DELETE", "/api/v1/auth/users/1", device=OWNER)
        check("admin", "the owner cannot be removed", s == 400, (s, j))

        # handing a device over and taking it back
        dev = people["user"]["device"]
        s, j = call("PUT", "/api/v1/link/devices/%s/person" % dev, {"user_id": None}, device=OWNER)
        check("admin", "taking a device back lifts pan-link's limit", s == 200 and admin.allow_calls and admin.allow_calls[-1] == (dev, []), (s, admin.allow_calls[-1:]))
        time.sleep(1)
        s, _ = call("GET", "/api/v1/settings", device=dev)
        check("admin", "taken back: it is the owner's again", s == 200, s)
        s, j = call("PUT", "/api/v1/link/devices/%s/person" % dev, {"user_id": people["child"]["id"]}, device=OWNER)
        check("admin", "handing it to the child sets pan-link's limit first", s == 200 and admin.allow_calls[-1][0] == dev and len(admin.allow_calls[-1][1]) > 0, (s, admin.allow_calls[-1:]))
        time.sleep(1)
        s, me = call("GET", "/api/v1/auth/me", device=dev)
        s2, _ = call("GET", "/api/v1/settings", device=dev)
        check("admin", "handed over: it is the child's and closed", s == 200 and (me.get("user") or me).get("role") == "child" and s2 == 403, (s, me, s2))
        s, j = call("PUT", "/api/v1/link/devices/d00000000ffff/person", {"user_id": people["child"]["id"]}, device=OWNER)
        check("admin", "a device pan-link does not know cannot be handed over", s == 404, (s, j))
        s, j = call("DELETE", "/api/v1/link/devices/%s" % dev, device=OWNER)
        s2, j2 = call("GET", "/api/v1/link/people", device=OWNER)
        still = [d for d in (j2.get("devices") or []) if d.get("link_device_id") == dev] if isinstance(j2, dict) else ["?"]
        check("admin", "removing a device removes whose it was", s == 200 and not still, (s, still))
    finally:
        # leave the dev database as it was found
        try:
            for dev in [d["id"] for d in admin.devices if d["id"] != OWNER]:
                call("PUT", "/api/v1/link/devices/%s/person" % dev, {"user_id": None}, device=OWNER)
            for p in people.values():
                if p.get("id"):
                    call("DELETE", "/api/v1/auth/users/%s" % p["id"], device=OWNER)
            call("POST", "/api/v1/threads/report", {"host": "people-suite", "threads": []}, device=OWNER)
            call("PUT", "/api/v1/settings", {"display_name": restore_name or "", "notes_device": ""}, device=OWNER)
            call("GET", "/api/v1/slack/pending", device=OWNER)
            admin.save(restore=True)
        except Exception as e:
            print("cleanup:", e)
        proc.terminate()
        try:
            proc.wait(10)
        except Exception:
            proc.kill()
        admin.server.shutdown()
        log.close()
    return results


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    out = main()
    if isinstance(out, int):
        sys.exit(out)
    bad = [r for r in out if not r["ok"] and not r["skip"]]
    print("%d checks, %d failed, %d skipped" % (len(out), len(bad), len([r for r in out if r["skip"]])))
    sys.exit(1 if bad else 0)
