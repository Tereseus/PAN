"""The people suite: every test of who a device belongs to and what that person may do.

    python service/src/__tests__/people-suite/run.py            everything below
    python service/src/__tests__/people-suite/run.py --unit     the unit files only (no hub, about 20 s)
    python service/src/__tests__/people-suite/run.py --hub      the dev hub part only (about 3 min)
    python service/src/__tests__/people-suite/run.py -v         every check, not only the failures

Parts:
  unit   people.test.js, person-voice.test.js, pan-link-routes.test.js, pan-link-auth.test.js,
         notes-sender.test.js, thread-people.test.js, person-messages.test.js, met-people.test.js, people-groups.test.js  (plain node, fresh database in a temp folder each)
  link   pan-link's own tests of its allow list (go test, when Go is installed)
  hub    hub_suite.py: a dev hub on its own port and database, a stand-in for pan-link's admin,
         every route in the source sent from a person's device

Real devices are a separate, deliberate step: devices.py (it uses a live hub).
Exit code 0 only when nothing failed. The last run is kept in last-run.json beside this file.
"""
import json
import os
import re
import shutil
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
TESTS = os.path.normpath(os.path.join(HERE, ".."))
SERVICE = os.path.normpath(os.path.join(HERE, "..", "..", ".."))
REPO = os.path.normpath(os.path.join(SERVICE, ".."))
UNIT = ["people.test.js", "person-voice.test.js", "pan-link-routes.test.js", "pan-link-auth.test.js", "notes-sender.test.js", "thread-people.test.js", "person-messages.test.js", "met-people.test.js", "people-groups.test.js"]


def unit():
    rows = []
    for name in UNIT:
        t0 = time.time()
        r = subprocess.run(["node", os.path.join(TESTS, name)], cwd=SERVICE, capture_output=True, timeout=600)
        out = (r.stdout + r.stderr).decode("utf-8", "replace")
        m = re.search(r"(\d+) passed, (\d+) failed", out)
        passed, failed = (int(m.group(1)), int(m.group(2))) if m else (0, 1)
        fails = [line.strip() for line in out.splitlines() if line.strip().startswith("✗")]
        if not m:
            fails.append("no result line; exit code %s" % r.returncode)
        rows.append({"part": "unit", "name": name, "passed": passed, "failed": failed, "seconds": round(time.time() - t0, 1), "fails": fails})
    return rows


def link():
    folder = os.path.join(REPO, "pan-link")
    if not shutil.which("go") or not os.path.isdir(folder):
        return [{"part": "link", "name": "pan-link allow list (go test)", "passed": 0, "failed": 0, "skipped": "Go is not installed here", "fails": []}]
    t0 = time.time()
    # GOFLAGS is set here on purpose: a machine-wide GOFLAGS left over from another build (an
    # -overlay file that no longer exists) fails every go command, and an empty value does not override it.
    r = subprocess.run(["go", "test", "-run", "Allow|Pair|Admin", "-v", "."], cwd=folder, capture_output=True, timeout=900,
                       env=dict(os.environ, GOFLAGS="-count=1"))
    out = (r.stdout + r.stderr).decode("utf-8", "replace")
    passed = len(re.findall(r"^--- PASS", out, re.M))
    fails = re.findall(r"^--- FAIL: (\S+)", out, re.M)
    if r.returncode != 0 and not fails:
        fails = ["go test exit code %s: %s" % (r.returncode, out.strip()[-300:])]
    return [{"part": "link", "name": "pan-link allow list (go test)", "passed": passed, "failed": len(fails), "seconds": round(time.time() - t0, 1), "fails": fails}]


def hub():
    sys.path.insert(0, HERE)
    import hub_suite
    t0 = time.time()
    out = hub_suite.main()
    if isinstance(out, int):
        return [{"part": "hub", "name": "the dev hub", "passed": 0, "failed": 1, "fails": ["the dev hub could not be used (see above)"]}]
    rows = []
    for group in dict.fromkeys(r["group"] for r in out):
        mine = [r for r in out if r["group"] == group]
        rows.append({"part": "hub", "name": group, "passed": len([r for r in mine if r["ok"]]),
                     "failed": len([r for r in mine if not r["ok"] and not r["skip"]]),
                     "skipped": len([r for r in mine if r["skip"]]) or None,
                     "fails": ["%s -> %s" % (r["name"], r["got"]) for r in mine if not r["ok"] and not r["skip"]]})
    rows[-1]["seconds"] = round(time.time() - t0, 1)
    return rows


def main(argv):
    sys.stdout.reconfigure(encoding="utf-8")
    if "-v" in argv:
        os.environ["PAN_PEOPLE_SUITE_VERBOSE"] = "1"
    only = [a for a in argv if a in ("--unit", "--hub", "--link")]
    rows = []
    if not only or "--unit" in only:
        rows += unit()
    if not only or "--link" in only:
        rows += link()
    if not only or "--hub" in only:
        rows += hub()
    print()
    print("%-5s %-34s %7s %7s" % ("part", "what", "passed", "failed"))
    for r in rows:
        note = "  (%s)" % r["skipped"] if isinstance(r.get("skipped"), str) else ("  (%d skipped: no model here)" % r["skipped"] if r.get("skipped") else "")
        print("%-5s %-34s %7d %7d%s" % (r["part"], r["name"][:34], r["passed"], r["failed"], note))
        for f in r["fails"]:
            print("        FAILED: %s" % f[:400])
    passed, failed = sum(r["passed"] for r in rows), sum(r["failed"] for r in rows)
    print("\n%d checks passed, %d failed" % (passed, failed))
    with open(os.path.join(HERE, "last-run.json"), "w", encoding="utf-8") as f:
        json.dump({"at": time.strftime("%Y-%m-%d %H:%M:%S"), "passed": passed, "failed": failed, "rows": rows}, f, indent=1)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
