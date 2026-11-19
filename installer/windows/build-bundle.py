"""Build the PAN bundle that PAN Setup downloads: one zip and a release.json beside it.

    python installer/windows/build-bundle.py [--ref HEAD] [--out installer/dist]
    python installer/windows/build-bundle.py --linux user@host [--linux-cores 12-15]

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
import argparse, hashlib, io, json, os, shutil, stat, subprocess, sys, tarfile, time, zipfile

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


def remove_tree(path):
    """Delete a folder for real: read only files and long paths included. Stops if it can't."""
    if not os.path.exists(path):
        return
    long = chr(92) * 2 + "?" + chr(92) + os.path.abspath(path)

    def retry(func, target, _exc):
        os.chmod(target, stat.S_IWRITE)
        func(target)

    shutil.rmtree(long, onexc=retry)
    if os.path.exists(path):
        sys.exit(f"could not clear {path}")


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
    ap.add_argument("--linux", metavar="USER@HOST", help="build the Linux bundle instead, on this Linux computer over ssh")
    ap.add_argument("--linux-cores", default="", help="keep the Linux build on these cores, e.g. 12-15")
    args = ap.parse_args()

    commit = run(["git", "rev-parse", "--short=8", args.ref], cwd=ROOT)
    day = run(["git", "show", "-s", "--format=%cd", "--date=format:%Y.%m.%d", args.ref], cwd=ROOT)
    version = f"{day}-{commit}"
    out = os.path.abspath(args.out)
    if args.linux:
        os.makedirs(out, exist_ok=True)
        return build_linux(args, version, commit, out)
    stage = os.path.join(out, "stage")
    app = os.path.join(stage, "app")
    remove_tree(stage)
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
            elif m.name in ("installer/windows/pan-launcher.cjs", "installer/windows/launch-plan.cjs", "installer/windows/voice-check.cjs"):
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
                 "setup/pan-uninstall.ps1", "service/pan.js", "service/package-lock.json", "launcher/voice-check.cjs",
                 "service/model-set.json", "service/model-files/syrinx-lfm-r15.Modelfile"):
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
        # npm through node itself, not npm.cmd: a .cmd goes through cmd.exe, and a computer
        # with a cmd AutoRun set can swallow the command and still report success.
        npm_cli = os.path.join(os.path.dirname(node), "node_modules", "npm", "bin", "npm-cli.js")
        if not os.path.exists(npm_cli):
            sys.exit(f"npm is not beside node ({npm_cli})")
        run([node, npm_cli, "ci", "--omit=dev", "--no-audit", "--no-fund"], cwd=service)
        if not os.path.isdir(os.path.join(service, "node_modules", "express")):
            sys.exit("npm ci reported success but installed nothing")
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
    # GOENV off: a build machine's own Go settings (an -overlay left by another build)
    # must not leak into this one.
    env = dict(os.environ, CGO_ENABLED="0", GOOS="windows", GOARCH="amd64", GOENV="off", GOFLAGS="-mod=readonly")
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
        remove_tree(stage)
    print(json.dumps(release, indent=2))


def build_linux(args, version, commit, out):
    """The Linux bundle. PAN's compiled modules have to be built on Linux, so the files are
    put together here (from git, plus a pan-link cross-built here) and sent to a Linux
    computer, which adds Node and node_modules (installer/linux/build-on-linux.sh), packs
    them and sends the one file back. The file also stays on that computer, in
    ~/pan-build/<version>/, with its release-linux.json, so an install test can run there."""
    host = args.linux
    stage = os.path.join(out, "stage-linux")
    app = os.path.join(stage, "app")
    remove_tree(stage)
    os.makedirs(app)
    print(f"linux bundle {version} via {host}")
    # autocrlf off: a shell script with Windows line ends does not run.
    raw = subprocess.run(["git", "-c", "core.autocrlf=false", "-c", "core.eol=lf", "archive", "--format=tar", args.ref,
                          "service", "installer/windows", "installer/linux"], cwd=ROOT, capture_output=True, check=True).stdout
    launcher = ("installer/windows/pan-launcher.cjs", "installer/windows/launch-plan.cjs", "installer/windows/voice-check.cjs")
    setup = ("installer/linux/pan-setup.sh", "installer/linux/pan-uninstall.sh")
    count = 0
    with tarfile.open(fileobj=io.BytesIO(raw)) as tar:
        for m in tar.getmembers():
            if not m.isfile() or m.name.startswith(LEAVE_OUT):
                continue
            if m.name.startswith("service/"):
                dest = os.path.join(app, *m.name.split("/"))
            elif m.name in launcher:
                dest = os.path.join(app, "launcher", os.path.basename(m.name))
            elif m.name in setup:
                dest = os.path.join(app, "setup", os.path.basename(m.name))
            elif m.name == "installer/linux/build-on-linux.sh":
                dest = os.path.join(stage, "build-on-linux.sh")
            else:
                continue
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            with tar.extractfile(m) as src, open(dest, "wb") as dst:
                shutil.copyfileobj(src, dst)
            count += 1
    print(f"  {count} files")
    for must in ("app/launcher/pan-launcher.cjs", "app/setup/pan-setup.sh", "app/setup/pan-uninstall.sh", "build-on-linux.sh",
                 "app/service/pan.js", "app/service/package-lock.json"):
        if not os.path.exists(os.path.join(stage, must)):
            sys.exit(f"{must} is not committed at {args.ref}: commit it first")
    for name in ("app/setup/pan-setup.sh", "app/setup/pan-uninstall.sh", "build-on-linux.sh"):
        if b"\r\n" in open(os.path.join(stage, name), "rb").read():
            sys.exit(f"{name} has Windows line ends")

    print("pan-link for linux")
    os.makedirs(os.path.join(app, "pan-link"))
    env = dict(os.environ, CGO_ENABLED="0", GOOS="linux", GOARCH="amd64", GOENV="off", GOFLAGS="-mod=readonly")
    run(["go", "build", "-trimpath", "-ldflags", "-s -w", "-o", os.path.join(app, "pan-link", "pan-link"),
         "./cmd/pan-link"], cwd=os.path.join(ROOT, "pan-link"), env=env)
    with open(os.path.join(app, "VERSION.json"), "w", encoding="utf-8") as f:
        json.dump({"version": version, "commit": commit, "node": "v24.13.0", "platform": "linux-x64",
                   "built": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}, f, indent=2)

    print("send")
    send = os.path.join(out, "stage-linux.tar")
    with tarfile.open(send, "w") as tar:
        tar.add(stage, arcname="stage")
    remote = f"pan-build/{version}"
    name = f"pan-hub-linux-x64-{version}.tar.gz"
    run(["ssh", "-o", "BatchMode=yes", host, f"rm -rf pan-build && mkdir -p {remote}"])
    run(["scp", "-q", send, f"{host}:{remote}/stage.tar"])
    os.remove(send)
    cores = f"PAN_BUILD_CORES={args.linux_cores} " if args.linux_cores else ""
    print("build on linux")
    built = run(["ssh", "-o", "BatchMode=yes", "-o", "ServerAliveInterval=30", host,
                 f"cd {remote} && tar -xf stage.tar && rm stage.tar && {cores}bash stage/build-on-linux.sh stage $PWD/{name} && rm -rf stage"])
    print("  " + built.replace("\n", "\n  "))
    facts = dict(line.split(" ", 1) for line in built.splitlines() if line.split(" ", 1)[0] in ("files", "size", "sha256", "glibc"))
    if not facts.get("sha256"):
        sys.exit("the linux build did not report a file")
    release = {"version": version, "commit": commit, "node": "v24.13.0", "file": name, "size": int(facts["size"]),
               "sha256": facts["sha256"], "files": int(facts["files"]), "glibc": facts.get("glibc", "")}
    rel_path = os.path.join(out, "release-linux.json")
    with open(rel_path, "w", encoding="utf-8", newline="\n") as f:
        json.dump(release, f, indent=2)
    run(["scp", "-q", rel_path, f"{host}:{remote}/release-linux.json"])
    print("fetch")
    run(["scp", "-q", f"{host}:{remote}/{name}", os.path.join(out, name)])
    if sha256(os.path.join(out, name)) != release["sha256"]:
        sys.exit("the linux bundle changed on the way back")
    if not args.keep_stage:
        remove_tree(stage)
    print(json.dumps(release, indent=2))


if __name__ == "__main__":
    main()
