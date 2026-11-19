"""Build the PAN bundle that PAN Setup downloads: one zip and a release.json beside it.

    python installer/windows/build-bundle.py [--ref HEAD] [--out installer/dist]

What goes in comes from git (`git archive`), never from the working folder: the working
folder also holds the owner's own data (voice recordings, training files, backups), and
none of that may ever ship. A file that is not committed is not in the bundle.

    app/
      service/        PAN, from git, plus node_modules from a clean `npm ci`
      node/node.exe   the Node this bundle's modules were built for
      pan-link/       pan-link.exe, built here from pan-link/
      launcher/       pan-launcher.cjs, launch-plan.cjs
      setup/          pan-setup.ps1, pan-uninstall.ps1 (so an installed PAN can remove itself)
      VERSION.json

Runs at low priority, so it does not hog the computer it builds on.
"""
import argparse, hashlib, io, json, os, shutil, subprocess, sys, tarfile, time, zipfile

sys.stdout.reconfigure(encoding="utf-8")
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
LOW = getattr(subprocess, "BELOW_NORMAL_PRIORITY_CLASS", 0)

# Tracked folders under service/ that an installed PAN never runs.
LEAVE_OUT = ("service/tauri/", "service/dashboard/", "service/test-results/", "service/installer/")


def run(cmd, cwd=None, env=None, check=True):
    print("  $", " ".join(cmd) if isinstance(cmd, list) else cmd)
    p = subprocess.run(cmd, cwd=cwd, env=env, capture_output=True, text=True, encoding="utf-8",
                       errors="replace", creationflags=LOW, shell=isinstance(cmd, str))
    if check and p.returncode != 0:
        print(p.stdout[-3000:], p.stderr[-3000:])
        sys.exit(f"failed ({p.returncode}): {cmd}")
    return p.stdout.strip()


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ref", default="HEAD")
    ap.add_argument("--out", default=os.path.join(ROOT, "installer", "dist"))
    ap.add_argument("--keep-stage", action="store_true")
    args = ap.parse_args()

    commit = run(["git", "rev-parse", "--short=8", args.ref], cwd=ROOT)
    day = run(["git", "show", "-s", "--format=%cd", "--date=format:%Y.%m.%d", args.ref], cwd=ROOT)
    version = f"{day}-{commit}"
    out = os.path.abspath(args.out)
    stage = os.path.join(out, "stage")
    app = os.path.join(stage, "app")
    shutil.rmtree(stage, ignore_errors=True)
    os.makedirs(app)
    print(f"bundle {version}")

    # 1. PAN itself and the installer's own files, straight from git.
    print("files from git")
    raw = subprocess.run(["git", "archive", "--format=tar", args.ref, "service", "installer/windows"],
                         cwd=ROOT, capture_output=True, check=True).stdout
    count = 0
    with tarfile.open(fileobj=io.BytesIO(raw)) as tar:
        for m in tar.getmembers():
            if not m.isfile() or m.name.startswith(LEAVE_OUT):
                continue
            if m.name.startswith("service/"):
                dest = os.path.join(app, *m.name.split("/"))
            elif m.name in ("installer/windows/pan-launcher.cjs", "installer/windows/launch-plan.cjs"):
                dest = os.path.join(app, "launcher", os.path.basename(m.name))
            elif m.name in ("installer/windows/pan-setup.ps1", "installer/windows/pan-uninstall.ps1"):
                dest = os.path.join(app, "setup", os.path.basename(m.name))
            else:
                continue
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            with tar.extractfile(m) as src, open(dest, "wb") as dst:
                shutil.copyfileobj(src, dst)
            count += 1
    print(f"  {count} files")
    for must in ("launcher/pan-launcher.cjs", "launcher/launch-plan.cjs", "setup/pan-setup.ps1",
                 "setup/pan-uninstall.ps1", "service/pan.js", "service/package-lock.json"):
        if not os.path.exists(os.path.join(app, must)):
            sys.exit(f"{must} is not committed at {args.ref}: commit it first")

    # 2. node_modules, clean, from the lock file. Kept between builds while the lock file
    #    and the Node version stay the same.
    node = shutil.which("node")
    node_version = run([node, "--version"])
    lock = sha256(os.path.join(app, "service", "package-lock.json"))[:16]
    cache = os.path.join(out, "cache", f"node_modules-{node_version}-{lock}")
    service = os.path.join(app, "service")
    if os.path.isdir(cache):
        print("node_modules from the cache")
    else:
        print("node_modules: npm ci (a few minutes)")
        npm = shutil.which("npm.cmd") or shutil.which("npm")
        run([npm, "ci", "--omit=dev", "--no-audit", "--no-fund"], cwd=service)
        os.makedirs(os.path.dirname(cache), exist_ok=True)
        shutil.move(os.path.join(service, "node_modules"), cache)
    run(["robocopy", cache, os.path.join(service, "node_modules"), "/E", "/NFL", "/NDL", "/NJH", "/NJS",
         "/NC", "/NS", "/NP", "/MT:4"], check=False)
    if not os.path.isdir(os.path.join(service, "node_modules", "express")):
        sys.exit("node_modules did not arrive in the stage")

    # 3. The Node these modules were built for.
    os.makedirs(os.path.join(app, "node"))
    shutil.copy2(node, os.path.join(app, "node", "node.exe"))

    # 4. pan-link, built from source.
    print("pan-link")
    os.makedirs(os.path.join(app, "pan-link"))
    env = dict(os.environ, CGO_ENABLED="0", GOOS="windows", GOARCH="amd64")
    run(["go", "build", "-trimpath", "-ldflags", "-s -w", "-o", os.path.join(app, "pan-link", "pan-link.exe"),
         "./cmd/pan-link"], cwd=os.path.join(ROOT, "pan-link"), env=env)

    with open(os.path.join(app, "VERSION.json"), "w", encoding="utf-8") as f:
        json.dump({"version": version, "commit": commit, "node": node_version,
                   "built": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}, f, indent=2)

    # 5. One zip, and what PAN Setup needs to know about it.
    name = f"pan-hub-win-x64-{version}.zip"
    zip_path = os.path.join(out, name)
    print("zip")
    files = 0
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED, compresslevel=5) as z:
        for base, _dirs, names in os.walk(app):
            for n in names:
                full = os.path.join(base, n)
                z.write(full, os.path.relpath(full, stage).replace(os.sep, "/"))
                files += 1
    release = {"version": version, "commit": commit, "node": node_version, "file": name,
               "size": os.path.getsize(zip_path), "sha256": sha256(zip_path), "files": files}
    with open(os.path.join(out, "release.json"), "w", encoding="utf-8") as f:
        json.dump(release, f, indent=2)
    if not args.keep_stage:
        shutil.rmtree(stage, ignore_errors=True)
    print(json.dumps(release, indent=2))


if __name__ == "__main__":
    main()
