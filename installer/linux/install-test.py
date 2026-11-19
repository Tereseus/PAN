"""The install test for Linux: remove PAN, check nothing is left, install it, check it, pair a
device, crash it, restart it, update it, uninstall it, and check nothing is left again.

    python installer/linux/install-test.py --target user@host [--real] [--keep]
    python installer/linux/install-test.py --target pan@127.0.0.1 --real \
        --ssh-opt=-J --ssh-opt=user@windows-host --ssh-opt=-p --ssh-opt=2222 --check-host windows-host

The second form is a Linux inside WSL on a Windows computer: ssh goes through the Windows
computer, and "from another computer" is checked against the Windows computer's address.

The bundle comes from the target's own ~/pan-build/<version>/ (build-bundle.py --linux leaves
it there with its release-linux.json).

By default this is a TEST MODE install: a side folder (~/pan-install-test), spare ports, and
PAN told to skip the parts that act on the whole computer (its steward, its orphan reaper).
That is the only safe way on a computer somebody works on. --real does it the way a person
would (default folder, default ports, all of PAN): only for a clean test computer.

Every check prints PASS or FAIL. Exit code 0 only when all pass.
"""
import argparse, base64, json, os, socket, subprocess, sys, time

sys.stdout.reconfigure(encoding="utf-8")
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
MARK = "made by install-test.py"
results = []


def check(name, ok, detail=""):
    results.append((name, bool(ok), detail))
    print(("  PASS  " if ok else "  FAIL  ") + name + (f"   [{detail}]" if detail and not ok else ""))
    return bool(ok)


def stage(text):
    print(f"\n{text}")


class Box:
    def __init__(self, target, real, ssh_opts=(), check_host=None):
        self.target = target
        self.host = check_host or target.split("@")[-1]
        self.ssh = ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", *ssh_opts]
        self.real = real
        self.work = "pan-install-test-work"
        if real:
            self.dir, self.port, self.admin, self.link_port = "$HOME/.local/share/pan", 7777, "127.0.0.1:7792", 41720
            self.flags = ["--quiet", "--no-firewall"]
        else:
            self.dir, self.port, self.admin, self.link_port = "$HOME/pan-install-test", 27877, "127.0.0.1:27792", 42720
            self.flags = ["--quiet", "--no-firewall", "--dev", "--port", "27877", "--carrier-port", "27860",
                          "--craft-port-base", "27800", "--link-port", "42720", "--link-admin", self.admin]

    def sh(self, command, timeout=300):
        for attempt in range(3):
            p = subprocess.run([*self.ssh, self.target, command],
                               capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout)
            if p.returncode != 255:
                break
            time.sleep(4)
        return p.returncode, (p.stdout + p.stderr).strip()

    def put(self, repo_path):
        """A file as committed (so its line ends are Linux ones), into the work folder."""
        data = subprocess.run(["git", "show", f"HEAD:{repo_path}"], cwd=ROOT, capture_output=True, check=True).stdout
        if b"\r\n" in data:
            sys.exit(f"{repo_path} is committed with Windows line ends")
        name = os.path.basename(repo_path)
        p = subprocess.run([*self.ssh, self.target, f"mkdir -p {self.work} && cat > {self.work}/{name} && chmod +x {self.work}/{name}"],
                           input=data, capture_output=True, timeout=60)
        if p.returncode != 0:
            sys.exit(f"could not send {name}: {p.stderr.decode(errors='replace')}")

    def helper(self, action, *more, timeout=120):
        rc, out = self.sh(f'bash {self.work}/test-helper.sh {action} "{self.dir}" {self.port} {self.admin} {self.link_port} ' + " ".join(more), timeout)
        line = out.splitlines()[-1] if out else ""
        try:
            return json.loads(line)
        except ValueError:
            raise RuntimeError(f"test-helper {action} gave no JSON (exit {rc}): {out[-500:]}")

    def http(self, method, path, body=None):
        b64 = base64.b64encode(json.dumps(body).encode()).decode() if body is not None else ""
        return self.helper("http", method, f"'{path}'", b64)

    def setup(self, source):
        return self.sh(f'bash {self.work}/pan-setup.sh --source "{source}" --install-dir "{self.dir}" ' + " ".join(self.flags), 900)

    def uninstall(self, remove_data):
        return self.sh(f'bash "{self.dir}/uninstall.sh" --quiet' + (" --remove-data" if remove_data else ""), 300)

    def wait_health(self, want, seconds):
        t = time.time()
        while time.time() - t < seconds:
            if self.helper("probe")["health"] == want:
                return round(time.time() - t)
            time.sleep(3)
        return None


def closed_from_here(host, port):
    try:
        with socket.create_connection((host, port), timeout=4):
            return False
    except OSError:
        return True


def only_local(addresses):
    return len(addresses) > 0 and all(a in ("127.0.0.1", "[::1]") for a in addresses)


def gone(p, label, data_too):
    check(f"{label}: nothing of PAN is running", p["programs"] == 0, p["programs"])
    check(f"{label}: PAN does not answer", not p["health"])
    check(f"{label}: no start with the computer", not p["unitFile"] and not p["unitEnabled"] and not p["unitActive"], p)
    check(f"{label}: program files are gone", p["appVersions"] == [], p["appVersions"])
    check(f"{label}: PAN's ports are free", not p["listen"]["pan"] and not p["listen"]["linkAdmin"] and not p["listen"]["linkUdp"], p["listen"])
    if data_too:
        check(f"{label}: the folder is gone", not p["dirExists"])
    else:
        check(f"{label}: memory and settings were kept", p["dataExists"])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--target", required=True, help="user@host of the Linux computer under test")
    ap.add_argument("--real", action="store_true", help="default folder and ports, all of PAN. Only for a clean test computer.")
    ap.add_argument("--keep", action="store_true", help="leave PAN installed at the end")
    ap.add_argument("--ssh-opt", action="append", default=[], help="one more word for the ssh command line (repeat it)")
    ap.add_argument("--check-host", help="the address to try PAN's ports on from here, when it is not the ssh host")
    args = ap.parse_args()
    box = Box(args.target, args.real, args.ssh_opt, args.check_host)
    release = json.load(open(os.path.join(ROOT, "installer", "dist", "release-linux.json"), encoding="utf-8"))
    version = release["version"]
    source = f"$HOME/pan-build/{version}"
    print(f"PAN {version} on {args.target}, {'the real way' if args.real else 'test mode (side folder, spare ports)'}")
    for f in ("installer/linux/pan-setup.sh", "installer/linux/test-helper.sh"):
        box.put(f)
    rc, out = box.sh(f'test -f "{source}/{release["file"]}" && sha256sum "{source}/{release["file"]}" | cut -d" " -f1')
    if out.strip() != release["sha256"]:
        sys.exit(f"the bundle {release['file']} is not in {source} on the target (run build-bundle.py --linux first)")

    try:
        stage("0. A clean start")
        p = box.helper("probe")
        if p["installed"]:
            rc, out = box.sh(f'cat "{box.dir}/data/.install-test" 2>/dev/null')
            if MARK not in out:
                sys.exit(f"There is a PAN in {box.dir} that this test did not install. It was not touched.")
            box.uninstall(True)
            p = box.helper("probe")
        check("no PAN in the test folder", not p["installed"] and p["programs"] == 0, p)
        check("the ports are free", not p["listen"]["pan"] and not p["listen"]["linkAdmin"] and not p["listen"]["linkUdp"], p["listen"])

        stage("1. Install")
        t = time.time()
        rc, out = box.setup(source)
        check(f"PAN Setup finished ({round(time.time() - t)} s)", rc == 0 and "PAN is installed." in out, out[-700:])
        box.sh(f'echo "{MARK}" > "{box.dir}/data/.install-test"')
        rc, res = box.sh(f'cat "{box.dir}/setup-result.json"')
        try:
            res = json.loads(res)
        except ValueError:
            res = {}
        check("Setup's own report says it worked", res.get("ok") is True and res.get("version") == version, res)
        p = box.helper("probe")
        check("PAN answers", p["health"])
        check("PAN listens on this computer only", only_local(p["listen"]["pan"]), p["listen"]["pan"])
        check("the link's own control port is on this computer only", only_local(p["listen"]["linkAdmin"]), p["listen"]["linkAdmin"])
        check("PAN Link's port for phones is open", len(p["listen"]["linkUdp"]) > 0, p["listen"]["linkUdp"])
        check("it starts with the computer (a systemd unit, enabled and running)", p["unitFile"] and p["unitEnabled"] and p["unitActive"], p)
        check("one version on disk", p["appVersions"] == [version], p["appVersions"])
        check("PAN's port is closed from another computer", closed_from_here(box.host, box.port), box.port)
        check("the link's control port is closed from another computer", closed_from_here(box.host, int(box.admin.split(":")[1])), box.admin)

        stage("2. Pair a device")
        code = (box.http("POST", "/api/v1/link/pair", {"name": "install test"}).get("json") or {}).get("uri") or ""
        check("PAN gives a pairing code", code.startswith("pan://pair?"), code[:30])
        r = box.helper("pair", base64.b64encode(code.encode()).decode(), "127.0.0.1:27781")
        check("a device pairs with it", r.get("paired"), r.get("output"))
        me = ((r.get("me") or {}).get("json") or {})
        check("PAN knows the device by name, through the link", (me.get("link_device") or {}).get("name") == "install test device", me.get("link_device"))

        stage("3. PAN crashes")
        r = box.helper("kill-pan")
        check("PAN was killed", len(r.get("killed") or []) > 0, r)
        back = box.wait_health(True, 180)
        check(f"it is back by itself ({back} s)", back is not None)

        stage("4. The computer restarts (the unit is stopped and started)")
        r = box.helper("restart-unit")
        check("stopping it leaves nothing running", r.get("leftAfterStop") == 0, r)
        back = box.wait_health(True, 180)
        check(f"PAN is back ({back} s)", r.get("ok") and back is not None, r)
        devices = box.http("GET", "/api/v1/link/devices").get("json") or []
        check("the paired device is still there", any(d.get("name") == "install test device" for d in devices), [d.get("name") for d in devices])

        stage("5. Run PAN Setup again (an update)")
        rc, out = box.setup(source)
        check("PAN Setup finished again", rc == 0 and "PAN is installed." in out, out[-700:])
        p = box.helper("probe")
        check("still one version, still answering", p["appVersions"] == [version] and p["health"], p)

        if args.keep:
            print("\nLeft installed (--keep).")
            return
        stage("6. Uninstall, keeping memory and settings")
        rc, out = box.uninstall(False)
        check("uninstall finished", rc == 0 and "PAN is removed." in out, out[-500:])
        gone(box.helper("probe"), "removed", False)
        rc, out = box.setup(source)
        check("installing again works", rc == 0 and "PAN is installed." in out, out[-700:])
        devices = box.http("GET", "/api/v1/link/devices").get("json") or []
        check("it remembers the paired device", any(d.get("name") == "install test device" for d in devices), [d.get("name") for d in devices])
    finally:
        if not args.keep:
            stage("7. Remove everything")
            rc, out = box.sh(f'cat "{box.dir}/data/.install-test" 2>/dev/null')
            if MARK in out:
                rc, out = box.uninstall(True)
                check("uninstall finished", rc == 0 and "PAN is removed." in out, out[-500:])
                gone(box.helper("probe"), "wiped", True)
            else:
                print("  (nothing of this test's to remove)")
            box.sh(f"rm -rf {box.work}")
        failed = [r for r in results if not r[1]]
        print(f"\n{len(results) - len(failed)} of {len(results)} checks passed")
        for name, _ok, detail in failed:
            print(f"  FAILED: {name}   {detail}")
    sys.exit(1 if [r for r in results if not r[1]] else 0)


if __name__ == "__main__":
    main()
