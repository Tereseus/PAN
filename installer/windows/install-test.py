"""The install test: remove PAN, check nothing is left, install it, check it, pair a device,
break it, update it, remove it. On this computer, or on another one over ssh.

    python installer/windows/install-test.py                      here, in a side folder on spare ports
    python installer/windows/install-test.py --target user@host   on a spare computer, the real way

Here it never touches a real PAN: it installs into %LOCALAPPDATA%\\PAN-InstallTest on spare
ports, in test mode (pan-setup.ps1 -Dev), and adds no firewall rule. On a target it installs
where a person's PAN goes, with the real ports and the firewall rule, so the target must be
a computer kept for this. It refuses to wipe a PAN it did not install itself.

Build the bundle first: python installer/windows/build-bundle.py
"""
import argparse, base64, json, os, socket, subprocess, sys, tempfile, time

sys.stdout.reconfigure(encoding="utf-8")
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
SCRIPTS = ["pan-setup.ps1", "pan-uninstall.ps1", "test-helper.ps1"]
SPARE = {"Port": 27877, "CarrierPort": 27860, "CraftPortBase": 27800, "LinkPort": 42720, "LinkAdmin": "127.0.0.1:27792"}
REAL = {"Port": 7777, "CarrierPort": 17760, "CraftPortBase": 17700, "LinkPort": 41720, "LinkAdmin": "127.0.0.1:7792"}
MARKER = ".install-test"

results = []


def check(name, ok, detail=""):
    results.append((name, bool(ok), detail))
    print(("  PASS  " if ok else "  FAIL  ") + name + (f"   [{detail}]" if detail and not ok else ""))
    return bool(ok)


def stage(text):
    print(f"\n{text}")


class Box:
    """The computer under test: this one, or one reached over ssh."""

    def __init__(self, target, install_dir, ports):
        self.target, self.ports = target, ports
        if target:
            self.host = target.split("@")[-1]
            temp = self._ssh("echo %TEMP%").strip().splitlines()[-1].strip()
            if "%" in temp or not temp:
                temp = self._ssh('powershell -NoProfile -Command "$env:TEMP"').strip().splitlines()[-1].strip()
            self.work = temp.rstrip("\\") + "\\pan-install-test"
            local = self._ssh('powershell -NoProfile -Command "$env:LOCALAPPDATA"').strip().splitlines()[-1].strip()
        else:
            self.host = "127.0.0.1"
            self.work = HERE
            local = os.environ["LOCALAPPDATA"]
        self.install_dir = install_dir or (local + ("\\PAN" if target else "\\PAN-InstallTest"))

    def _run_ssh(self, command, timeout):
        """ssh, tried again when the connection itself fails (255): a computer on Wi-Fi drops some."""
        for attempt in range(5):
            p = subprocess.run(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=25", self.target, command],
                               capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout)
            if p.returncode != 255:
                return p
            time.sleep(3)
        return p

    def _ssh(self, command, timeout=120):
        return self._run_ssh(command, timeout).stdout

    def put(self, source_dir, release):
        """Copy the scripts, and the bundle when the source is a folder, to the target."""
        if not self.target:
            return source_dir
        self._ssh(f'if not exist "{self.work}" mkdir "{self.work}"')
        dest = f"{self.target}:{self.work.replace(chr(92), '/')}/"
        files = [os.path.join(HERE, s) for s in SCRIPTS]
        if source_dir and not source_dir.startswith("http"):
            have = self._ssh(f'powershell -NoProfile -Command "(Get-FileHash \'{self.work}\\{release["file"]}\' -Algorithm SHA256).Hash"').strip().lower()
            files.append(os.path.join(source_dir, "release.json"))
            if release["sha256"].lower() not in have:
                print(f"  copying the bundle to the target ({release['size'] >> 20} MB)")
                files.append(os.path.join(source_dir, release["file"]))
        for attempt in range(5):
            if subprocess.run(["scp", "-q", "-o", "BatchMode=yes", "-o", "ConnectTimeout=25"] + files + [dest], timeout=3600).returncode == 0:
                break
            time.sleep(3)
        else:
            sys.exit("could not copy the files to the target")
        return source_dir if source_dir.startswith("http") else self.work

    def ps(self, script, args, timeout=600):
        """Run one of the scripts on the box. Returns (exit code, output)."""
        path = self.work + "\\" + script
        flat = []
        for a in args:
            a = str(a)
            flat.append(a if a.startswith("-") and " " not in a else '"' + a + '"')
        if self.target:
            command = f'powershell -NoProfile -ExecutionPolicy Bypass -File "{path}" ' + " ".join(flat)
            p = self._run_ssh(command, timeout)
        else:
            p = subprocess.run(["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path] + [str(a) for a in args],
                               capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout)
        return p.returncode, (p.stdout or "") + (p.stderr or "")

    def port_args(self):
        out = []
        for k, v in self.ports.items():
            out += ["-" + k, v]
        return out

    def helper(self, action, extra=(), timeout=180):
        rc, out = self.ps("test-helper.ps1", ["-Action", action, "-InstallDir", self.install_dir] + self.port_args() + list(extra), timeout)
        for line in reversed(out.strip().splitlines()):
            line = line.strip()
            if line.startswith("{"):
                try:
                    return json.loads(line)
                except ValueError:
                    pass
        raise RuntimeError(f"test-helper {action} gave no JSON (exit {rc}): {out[-600:]}")

    def probe(self):
        return self.helper("probe")

    def http(self, method, path, body=None):
        extra = ["-Method", method, "-Url", f"http://127.0.0.1:{self.ports['Port']}{path}"]
        if body is not None:
            extra += ["-BodyB64", base64.b64encode(json.dumps(body).encode()).decode()]
        r = self.helper("http", extra)
        try:
            r["json"] = json.loads(r.get("body") or "null")
        except ValueError:
            r["json"] = None
        return r

    def wait_health(self, want, seconds):
        end = time.time() + seconds
        started = time.time()
        while time.time() < end:
            h = self.http("GET", "/health")
            up = h.get("status") == 200
            if want and up:
                # all of PAN, not just its front door (see Health in pan-setup.ps1)
                j = h.get("json") or {}
                up = (j.get("craftHealthy") is True or j.get("status") == "running") and self.http("GET", "/api/v1/auth/me").get("status") == 200
            if up == want:
                return round(time.time() - started)
            time.sleep(3)
        return None

    def setup(self, source, flags):
        return self.ps("pan-setup.ps1", ["-Source", source, "-InstallDir", self.install_dir, "-Quiet"] + self.port_args() + flags, 1200)

    def uninstall(self, remove_data):
        return self.ps("pan-uninstall.ps1", ["-InstallDir", self.install_dir, "-Quiet"] + (["-RemoveData"] if remove_data else []), 300)

    def data_path(self, name):
        return self.install_dir + "\\data\\" + name

    def marker(self, write=False):
        """The file that says this test made the install, so it may wipe it."""
        path = self.data_path(MARKER)
        if write:
            cmd = f"Set-Content -Path '{path}' -Value 'made by install-test.py'"
        else:
            cmd = f"Test-Path '{path}'"
        if self.target:
            return "True" in self._ssh(f'powershell -NoProfile -Command "{cmd}"')
        p = subprocess.run(["powershell.exe", "-NoProfile", "-Command", cmd], capture_output=True, text=True)
        return "True" in p.stdout


def closed_from_here(host, port):
    try:
        with socket.create_connection((host, port), timeout=4):
            return False
    except OSError:
        return True


def only_local(addresses):
    if isinstance(addresses, str):
        addresses = [addresses]  # PowerShell writes a list of one as the one thing
    return len(addresses) > 0 and all(a in ("127.0.0.1", "::1") for a in addresses)


def gone(box, p, label):
    check(f"{label}: nothing of PAN is running", len(p["processes"]) == 0, [x["name"] for x in p["processes"]])
    check(f"{label}: PAN does not answer", not p["health"])
    check(f"{label}: no start at sign in", p["run"] is None, p["run"])
    check(f"{label}: not in the Apps list", p["uninstallEntry"] is None)
    check(f"{label}: program files are gone", p["appVersions"] == [] and p["config"] is None, p["appVersions"])


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--target", help="user@host of the computer to test on (default: this one)")
    ap.add_argument("--source", default=os.path.join(ROOT, "installer", "dist"), help="folder or address with release.json and the zip")
    ap.add_argument("--install-dir")
    ap.add_argument("--keep", action="store_true", help="leave PAN installed at the end (for the phone step)")
    ap.add_argument("--wipe-existing", action="store_true", help="remove a PAN on the target that this test did not install. Deletes its data.")
    ap.add_argument("--spare-ports", action="store_true", help="use spare ports on a target too")
    ap.add_argument("--voice", action="store_true", help="also install Ollama and the models (several GB) and check PAN talks. Target only.")
    ap.add_argument("--own-models", default="", help="folder ON THE TARGET, or an address, holding PAN's own models as .gguf files")
    args = ap.parse_args()

    remote = bool(args.target)
    ports = SPARE if (not remote or args.spare_ports) else REAL
    web = args.source.startswith("http")
    if web:
        import urllib.request
        release = json.load(urllib.request.urlopen(args.source.rstrip("/") + "/release.json", timeout=30))
    else:
        release = json.load(open(os.path.join(args.source, "release.json"), encoding="utf-8"))
    version = release["version"]
    print(f"PAN {version} on {args.target or 'this computer'}")

    box = Box(args.target, args.install_dir, ports)
    flags = [] if remote else ["-Dev", "-NoFirewall"]
    real_here = os.environ.get("LOCALAPPDATA", "") + "\\PAN"
    if not remote and os.path.normcase(box.install_dir) == os.path.normcase(real_here):
        sys.exit("refusing to test in the real PAN folder on this computer")

    stage("0. Reach the computer")
    source = box.put(args.source, release)
    p = box.probe()
    print(f"  {p['computer']}, administrator: {p['admin']}, install folder {box.install_dir}")
    expect_firewall = remote and p["admin"]

    # Nothing is removed, not even on the way out, until the folder is known to be this
    # test's own (or the person said to wipe what is there).
    may_remove = False
    try:
        stage("1. Start clean")
        if p["config"] is not None or p["dataExists"]:
            if not box.marker() and not args.wipe_existing:
                sys.exit(f"  {box.install_dir} holds a PAN this test did not install. Not touching it (--wipe-existing to remove it and its data).")
        may_remove = True
        if p["config"] is not None or p["dataExists"]:
            rc, out = box.uninstall(remove_data=True)
            if p["config"] is None and p["dataExists"]:
                # data left by an uninstall that kept it: nothing to uninstall, remove the folder
                box.ps("test-helper.ps1", ["-Action", "stop-all", "-InstallDir", box.install_dir])
            p = box.probe()
        gone(box, p, "before")
        check("before: PAN's port is free", p["listen"]["pan"] == [], p["listen"]["pan"])

        stage("2. Install")
        t = time.time()
        rc, out = box.setup(source, flags)
        took = round(time.time() - t)
        check(f"PAN Setup finished ({took} s)", rc == 0 and "PAN is installed." in out, out[-700:])
        warnings = [l.strip() for l in out.splitlines() if l.strip().startswith("! ")]
        check("PAN Setup had no warnings", not warnings, warnings)
        if rc != 0:
            raise RuntimeError("install failed, stopping here")
        box.marker(write=True)

        stage("3. What is on the computer now")
        check("all of PAN is ready when Setup says so", box.wait_health(True, 5) is not None)
        p = box.probe()
        check("PAN answers", p["health"])
        check("PAN listens on this computer only", only_local(p["listen"]["pan"]), p["listen"]["pan"])
        if "-Dev" not in flags:
            check("the inner ports listen on this computer only",
                  only_local(p["listen"]["carrier"]) and p["listen"]["craft"] and all(only_local(a) for a in p["listen"]["craft"].values()),
                  {"carrier": p["listen"]["carrier"], "craft": p["listen"]["craft"]})
        check("PAN Link's admin port is on this computer only", only_local(p["listen"]["linkAdmin"]), p["listen"]["linkAdmin"])
        check("PAN Link listens for devices", p["linkUdp"] and p["linkJson"])
        check("starts at sign in", bool(p["run"]) and "--headless" in p["run"], p["run"])
        check("in the Apps list with its version", (p["uninstallEntry"] or {}).get("version") == version, p["uninstallEntry"])
        check("only this version is installed", p["appVersions"] == [version], p["appVersions"])
        check("its database exists", p["dbExists"])
        names = sorted({x["name"].lower() for x in p["processes"]})
        check("the launcher, PAN and PAN Link are running", "node.exe" in names and "pan-link.exe" in names, names)
        if expect_firewall:
            check("the firewall lets PAN Link in", p["firewallRule"])
        elif not remote:
            check("no firewall rule was added on this computer", not p["firewallRule"])
        if remote:
            for label, port in (("PAN", ports["Port"]), ("the Carrier", ports["CarrierPort"]), ("PAN Link's admin", int(ports["LinkAdmin"].split(":")[-1]))):
                check(f"{label} port is closed from another computer", closed_from_here(box.host, port), port)

        stage("4. A fresh PAN")
        users = (box.http("GET", "/api/v1/auth/users").get("json") or {}).get("users") or []
        check("one person, the owner", len(users) == 1 and users[0].get("role") == "owner", users)
        cap = (box.http("GET", "/api/v1/capture").get("json") or {}).get("features") or []
        check("camera, screen and app watching are off", len(cap) == 3 and not any(f["enabled"] or f["running"] for f in cap),
              [(f["name"], f["enabled"], f["running"]) for f in cap])

        stage("5. Pair a device")
        code = (box.http("POST", "/api/v1/link/pair", {"name": "install test"}).get("json") or {}).get("uri") or ""
        check("PAN gives a pairing code", code.startswith("pan://pair?"), code[:30])
        r = box.helper("pair", ["-CodeB64", base64.b64encode(code.encode()).decode()])
        me = json.loads(r.get("me") or "{}")
        check("a device pairs with it", r.get("paired"), r.get("output"))
        check("PAN knows the device by name, through the link", (me.get("link_device") or {}).get("name") == "install test device", me.get("link_device"))
        if remote:
            pair_from_here(box, ports)
        devices = box.http("GET", "/api/v1/link/devices").get("json") or []
        check("the device is listed", any(d.get("name") == "install test device" for d in devices), [d.get("name") for d in devices])

        if args.voice:
            voice_stage(box, source, flags, args)

        stage("6. PAN crashes")
        killed = box.helper("kill-pan").get("killed")
        down = box.wait_health(False, 20)
        back = box.wait_health(True, 150)
        check(f"it comes back by itself ({back} s)", bool(killed) and back is not None, {"killed": killed, "down": down})

        stage("7. Sign out, sign in")
        box.helper("stop-all")
        p = box.probe()
        check("signed out: nothing is running", len(p["processes"]) == 0 and not p["health"] and p["listen"]["ollama"] == [] and p["listen"]["reader"] == [],
              {"processes": [x["name"] for x in p["processes"]], "ollama": p["listen"]["ollama"], "reader": p["listen"]["reader"]})
        r = box.helper("run-autostart")
        back = box.wait_health(True, 180)
        check(f"signed in: PAN is back ({back} s)", r.get("ok") and back is not None, r)
        if args.voice:
            v = talk(box)
            check(f"signed in: the model runner is back and PAN still talks (first word {v.get('firstMs', 0) / 1000:.1f} s)", v.get("ok"), v)

        stage("8. Run PAN Setup again (an update)")
        rc, out = box.setup(source, flags)
        check("PAN Setup finished again", rc == 0 and "PAN is installed." in out, out[-700:])
        p = box.probe()
        check("still one version, still answering", p["appVersions"] == [version] and p["health"], p["appVersions"])
        devices = box.http("GET", "/api/v1/link/devices").get("json") or []
        check("the paired device is still there", any(d.get("name") == "install test device" for d in devices), [d.get("name") for d in devices])

        if args.keep:
            print("\nLeft installed (--keep).")
            return finish()

        stage("9. Remove PAN, keep its memory")
        rc, out = box.uninstall(remove_data=False)
        check("uninstall finished", rc == 0, out[-500:])
        p = box.probe()
        gone(box, p, "removed")
        check("removed: its memory was kept", p["dataExists"] and p["dbExists"])

        stage("10. Install over the kept memory")
        rc, out = box.setup(source, flags)
        check("PAN Setup finished", rc == 0 and "PAN is installed." in out, out[-700:])
        devices = box.http("GET", "/api/v1/link/devices").get("json") or []
        check("it remembers the paired device", any(d.get("name") == "install test device" for d in devices), [d.get("name") for d in devices])
        users = (box.http("GET", "/api/v1/auth/users").get("json") or {}).get("users") or []
        check("still one person, the owner", len(users) == 1, len(users))
    finally:
        if may_remove and not args.keep:
            stage("11. Remove everything")
            rc, out = box.uninstall(remove_data=True)
            p = box.probe()
            check("uninstall finished", rc == 0, out[-500:])
            gone(box, p, "wiped")
            check("wiped: the folder is gone", not p["installDirExists"])
            check("wiped: PAN's ports are free", p["listen"]["pan"] == [] and not p["linkUdp"], p["listen"])
            if args.voice and voice_state.get("ollama_was_here") is False:
                check("wiped: Ollama and the models are gone", not p["ollamaExe"] and not p["ollamaStore"] and p["listen"]["ollama"] == [] and p["listen"]["reader"] == [],
                      {"exe": p["ollamaExe"], "store": p["ollamaStore"], "listen": p["listen"]})
            if expect_firewall:
                check("wiped: the firewall rule is gone", not p["firewallRule"])
    finish()


voice_state = {}


def talk(box):
    """One voice turn. The first after a start loads the model, so it gets a few tries."""
    v = {}
    for attempt in range(4):
        v = box.helper("voice", timeout=300)
        if v.get("ok"):
            break
        time.sleep(15)
    return v


def voice_stage(box, source, flags, args):
    stage("5b. Voice: Ollama, the models, one real turn")
    before = box.probe()
    voice_state["ollama_was_here"] = bool(before["ollamaExe"])
    extra = ["-Voice"] + (["-OwnModels", args.own_models] if args.own_models else [])
    t = time.time()
    rc, out = box.ps("pan-setup.ps1", ["-Source", source, "-InstallDir", box.install_dir, "-Quiet"] + box.port_args() + flags + extra, 3 * 3600)
    took = round((time.time() - t) / 60, 1)
    check(f"PAN Setup with voice finished ({took} min)", rc == 0 and "PAN is installed." in out, out[-900:])
    for line in out.splitlines():
        if "PAN said:" in line or line.strip().startswith("! ") or "models," in line:
            print("      " + line.strip())
    state = box.http("GET", "/api/v1/setup/models").get("json") or {}
    wanted = [m["name"] for m in state.get("wanted", [])]
    have = [h.lower() for h in state.get("have", [])]
    got = [n for n in wanted if n.lower() in have]
    check(f"the models are here ({len(got)} of {len(wanted)})", len(got) == len(wanted) or not args.own_models, [n for n in wanted if n not in got])
    check("PAN has a talking model", state.get("voice") is True, state.get("missing"))
    p = box.probe()
    check("Ollama and the voice reader listen on this computer only", only_local(p["listen"]["ollama"]) and only_local(p["listen"]["reader"]),
          {"ollama": p["listen"]["ollama"], "reader": p["listen"]["reader"]})
    v = talk(box)
    check(f"PAN answers a spoken line (first word {v.get('firstMs', 0) / 1000:.1f} s)", v.get("ok"), v)
    if v.get("ok"):
        print(f"      said: {v.get('said')!r}  PAN: {v.get('reply')!r}  model: {v.get('model')}")
        v2 = box.helper("voice", timeout=300)
        check(f"the second line is quick (first word {v2.get('firstMs', 0) / 1000:.1f} s)", v2.get("ok") and v2.get("firstMs", 99999) < 5000, v2)
    if box.target:
        for label, port in (("Ollama", 11434), ("the voice reader", 7786)):
            check(f"{label} port is closed from another computer", closed_from_here(box.host, port), port)


def pair_from_here(box, ports):
    """Pair this computer with the PAN on the target, over the network, as a phone would."""
    link = os.path.join(ROOT, "pan-link", "pan-link.exe")
    if not os.path.exists(link):
        return check("pan-link.exe is here to pair from this computer", False, link)
    code = (box.http("POST", "/api/v1/link/pair", {"name": "install test, other computer"}).get("json") or {}).get("uri") or ""
    folder = tempfile.mkdtemp(prefix="pan-install-test-")
    p = subprocess.run([link, "pair", "--code", code, "--data", folder, "--name", "install test, other computer"],
                       capture_output=True, text=True, timeout=60)
    if not check("another computer pairs with it over the network", p.returncode == 0, (p.stdout + p.stderr)[-300:]):
        return
    client = subprocess.Popen([link, "client", "--data", folder, "--listen", "127.0.0.1:27780"],
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, creationflags=subprocess.CREATE_NO_WINDOW)
    try:
        import urllib.request
        me = {}
        for _ in range(8):
            time.sleep(2)
            try:
                me = json.load(urllib.request.urlopen("http://127.0.0.1:27780/api/v1/auth/me", timeout=5))
                break
            except Exception:
                pass
        check("PAN answers that computer through the link", (me.get("link_device") or {}).get("name") == "install test, other computer", me.get("link_device"))
    finally:
        client.kill()


def finish():
    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)} of {len(results)} checks passed")
    for name, _ok, detail in failed:
        print(f"  FAILED: {name}   {detail}")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
