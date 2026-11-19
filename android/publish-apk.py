"""Publishes the app build in android/app/build/outputs/apk/debug to the hub, with small patches
from the builds before it.

    python android/publish-apk.py --hub user@host [--keep 6] [--car car]

What it does, in order:
  0. Runs the app's unit tests (gradlew :app:testDebugUnitTest) and stops if one fails. Among
     them is VoiceChoiceTest: which voice speaks, in every state the setting can be in. A build
     that could speak in the wrong voice without saying so is not published. --no-tests skips.
  1. Reads the new build's versionCode here and the published one's on the hub. The same code
     twice is refused: a patch is made from one exact file per code.
  2. On the hub, keeps the published pair beside itself as app-debug.v<code>.apk and
     output-metadata.v<code>.json (the way back).
  3. Makes a patch to the new build from each of the last --keep published builds:
     app-debug.p<old>-<new>.zst, the same bytes `zstd --patch-from=<old> <new>` writes. Two builds
     in a row differ by about 0.2 MB; the whole file is 74 MB. Each patch is opened again here
     and compared with the new build before it is sent.
  4. Copies the patches, the build and its metadata to the hub, removes the patches to older
     builds, and reads the hub's /api/v1/apk/version back.
  5. With --car: tells that head unit to update now (ssh <name> ~/pan-update.sh).

The hub serves a patch at /apk/latest?patch_from=<code> (server.js). The car unit uses them
(android/car/pan-update.sh). The phones still download the whole build.

Needs ssh and scp to the hub, and zstd as a library: Git for Windows ships libzstd.dll, which is
what this looks for first. Set ZSTD_DLL to point at another one.
"""
import argparse, ctypes, ctypes.util, hashlib, json, os, re, subprocess, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "app", "build", "outputs", "apk", "debug")
CACHE = os.path.join(os.environ.get("LOCALAPPDATA") or os.path.expanduser("~/.cache"), "PAN", "apk-cache")

# zstd's own numbers for these settings (zstd.h).
C_LEVEL, C_WINDOW_LOG, C_LDM, C_CHECKSUM = 100, 101, 160, 201
D_WINDOW_LOG_MAX = 100


def zstd():
    names = [os.environ.get("ZSTD_DLL"), r"C:\Program Files\Git\mingw64\bin\libzstd.dll", ctypes.util.find_library("zstd"), "libzstd.so.1"]
    for name in names:
        if not name:
            continue
        try:
            z = ctypes.CDLL(name)
        except OSError:
            continue
        P, S = ctypes.c_void_p, ctypes.c_size_t
        z.ZSTD_createCCtx.restype = P
        z.ZSTD_createDCtx.restype = P
        z.ZSTD_freeCCtx.argtypes = [P]
        z.ZSTD_freeDCtx.argtypes = [P]
        z.ZSTD_compressBound.restype, z.ZSTD_compressBound.argtypes = S, [S]
        z.ZSTD_isError.restype, z.ZSTD_isError.argtypes = ctypes.c_uint, [S]
        z.ZSTD_getErrorName.restype, z.ZSTD_getErrorName.argtypes = ctypes.c_char_p, [S]
        for f in (z.ZSTD_CCtx_setParameter, z.ZSTD_DCtx_setParameter):
            f.restype, f.argtypes = S, [P, ctypes.c_int, ctypes.c_int]
        for f in (z.ZSTD_CCtx_refPrefix, z.ZSTD_DCtx_refPrefix):
            f.restype, f.argtypes = S, [P, ctypes.c_char_p, S]
        z.ZSTD_compress2.restype, z.ZSTD_compress2.argtypes = S, [P, ctypes.c_char_p, S, ctypes.c_char_p, S]
        z.ZSTD_decompressDCtx.restype, z.ZSTD_decompressDCtx.argtypes = S, [P, ctypes.c_char_p, S, ctypes.c_char_p, S]
        return z
    sys.exit("no zstd library found: set ZSTD_DLL to a libzstd")


def check(z, r, what):
    if z.ZSTD_isError(r):
        sys.exit(f"zstd, {what}: {z.ZSTD_getErrorName(r).decode()}")
    return r


def make_patch(z, old, new, level):
    """The bytes `zstd --patch-from=old new` writes: new, compressed with old as what came before it."""
    window = max(10, (max(len(old), len(new)) - 1).bit_length())
    c = z.ZSTD_createCCtx()
    try:
        for key, value in ((C_LEVEL, level), (C_WINDOW_LOG, window), (C_LDM, 1), (C_CHECKSUM, 1)):
            check(z, z.ZSTD_CCtx_setParameter(c, key, value), "a setting")
        check(z, z.ZSTD_CCtx_refPrefix(c, old, len(old)), "the old build")
        room = z.ZSTD_compressBound(len(new))
        buf = ctypes.create_string_buffer(room)
        n = check(z, z.ZSTD_compress2(c, buf, room, new, len(new)), "making the patch")
        return buf.raw[:n]
    finally:
        z.ZSTD_freeCCtx(c)


def apply_patch(z, old, patch, size):
    d = z.ZSTD_createDCtx()
    try:
        check(z, z.ZSTD_DCtx_setParameter(d, D_WINDOW_LOG_MAX, 31), "a setting")
        check(z, z.ZSTD_DCtx_refPrefix(d, old, len(old)), "the old build")
        buf = ctypes.create_string_buffer(size)
        n = check(z, z.ZSTD_decompressDCtx(d, buf, size, patch, len(patch)), "opening the patch")
        return buf.raw[:n]
    finally:
        z.ZSTD_freeDCtx(d)


def run(cmd, **kw):
    return subprocess.run(cmd, capture_output=True, text=True, **kw)


def hub(target, command):
    r = run(["ssh", "-o", "ConnectTimeout=10", target, command])
    return r.returncode, (r.stdout or "").replace("\r", "")


def code_of(meta_text):
    return int((json.loads(meta_text).get("elements") or [{}])[0]["versionCode"])


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--hub", required=True, help="ssh target of the hub, user@host")
    ap.add_argument("--dir", default=r"C:\PAN\android\app\build\outputs\apk\debug", help="the folder on the hub the build is published in")
    ap.add_argument("--keep", type=int, default=6, help="patches from this many earlier builds")
    ap.add_argument("--level", type=int, default=9, help="zstd level for the patches (9: 0.2 MB in a fifth of a second; the higher levels come out bigger through the library)")
    ap.add_argument("--car", help="ssh name of a car unit to update right after")
    ap.add_argument("--no-tests", action="store_true", help="publish without running the app's unit tests")
    a = ap.parse_args()

    if not a.no_tests:
        env = dict(os.environ)
        jbr = r"C:\Program Files\Android\Android Studio\jbr"
        if not env.get("JAVA_HOME") and os.path.isdir(jbr):
            env["JAVA_HOME"] = jbr
        gradlew = os.path.join(HERE, "gradlew.bat" if os.name == "nt" else "gradlew")
        r = subprocess.run([gradlew, "-p", HERE, ":app:testDebugUnitTest", "-q"], capture_output=True, text=True, env=env)
        if r.returncode != 0:
            tail = os.linesep.join((r.stdout + r.stderr).strip().splitlines()[-25:])
            sys.exit("the app's unit tests failed, nothing published:" + os.linesep + tail)
        print("app unit tests: passed")

    apk, meta = os.path.join(OUT, "app-debug.apk"), os.path.join(OUT, "output-metadata.json")
    new_code = code_of(open(meta, encoding="utf-8").read())
    new = open(apk, "rb").read()
    new_sha = hashlib.sha256(new).hexdigest()
    D = a.dir.rstrip("\\")

    rc, text = hub(a.hub, f'type "{D}\\output-metadata.json"')
    old_code = code_of(text) if rc == 0 and text.strip() else 0
    if old_code == new_code:
        sys.exit(f"build {new_code} is already the published one: raise versionCode")
    if old_code:
        rc, _ = hub(a.hub, f'if not exist "{D}\\app-debug.v{old_code}.apk" (copy /y "{D}\\app-debug.apk" "{D}\\app-debug.v{old_code}.apk" && copy /y "{D}\\output-metadata.json" "{D}\\output-metadata.v{old_code}.json")')
        print(f"published now: {old_code}; kept as v{old_code}")

    # The builds a patch is made from: the newest --keep the hub still has.
    _, listing = hub(a.hub, f'dir /b "{D}\\app-debug.v*.apk"')
    have = sorted({int(m.group(1)) for m in re.finditer(r"app-debug\.v(\d+)\.apk", listing)} - {new_code}, reverse=True)[: max(0, a.keep)]
    os.makedirs(CACHE, exist_ok=True)
    z = zstd() if have else None
    patches = []
    for code in have:
        local = os.path.join(CACHE, f"app-debug.v{code}.apk")
        if not os.path.exists(local):
            r = run(["scp", "-q", f"{a.hub}:{D.replace(chr(92), '/')}/app-debug.v{code}.apk", local])
            if r.returncode != 0:
                print(f"  v{code}: could not be fetched, no patch from it")
                continue
        old = open(local, "rb").read()
        t = time.time()
        patch = make_patch(z, old, new, a.level)
        if hashlib.sha256(apply_patch(z, old, patch, len(new))).hexdigest() != new_sha:
            print(f"  v{code}: the patch did not give the new build back, left out")
            continue
        name = os.path.join(CACHE, f"app-debug.p{code}-{new_code}.zst")
        open(name, "wb").write(patch)
        patches.append(name)
        print(f"  patch from {code}: {len(patch):,} bytes ({time.time() - t:.0f} s)")
    # Builds this computer no longer needs.
    for f in os.listdir(CACHE):
        m = re.match(r"app-debug\.v(\d+)\.apk$", f)
        if (m and int(m.group(1)) not in have) or (f.endswith(".zst") and os.path.join(CACHE, f) not in patches):
            os.remove(os.path.join(CACHE, f))
    # The next publish patches from this build: keep it here so it is not fetched back.
    open(os.path.join(CACHE, f"app-debug.v{new_code}.apk"), "wb").write(new)

    dest = f"{a.hub}:{D.replace(chr(92), '/')}/"
    for f in patches:
        r = run(["scp", "-q", f, dest])
        if r.returncode != 0:
            sys.exit(f"could not copy {os.path.basename(f)} to the hub: {r.stderr.strip()}")
    # The build and its metadata go up beside the published pair and are put in place in one
    # step. Copied straight over it, the hub answered "busy" to every version check for the
    # minute and a half a 219 MB build takes (Nov 19), and could have served half a file.
    for f in (apk, meta):
        r = run(["scp", "-q", f, dest + os.path.basename(f) + ".new"])
        if r.returncode != 0:
            sys.exit(f"could not copy {os.path.basename(f)} to the hub: {r.stderr.strip()}")
    for tries in range(5):
        rc, out = hub(a.hub, f'(if exist "{D}\\app-debug.apk.new" move /y "{D}\\app-debug.apk.new" "{D}\\app-debug.apk") && (if exist "{D}\\output-metadata.json.new" move /y "{D}\\output-metadata.json.new" "{D}\\output-metadata.json")')
        if rc == 0:
            break
        time.sleep(3)    # a device is reading the old build this second
    else:
        sys.exit(f"the new build is on the hub as app-debug.apk.new and could not be put in place: {out.strip()[:200]}")
    hub(a.hub, f"powershell -NoProfile -Command \"Get-ChildItem '{D}\\app-debug.p*.zst' | Where-Object {{ $_.Name -notlike '*-{new_code}.zst' }} | Remove-Item\"")
    _, now = hub(a.hub, "curl -s http://127.0.0.1:7777/api/v1/apk/version")
    try:
        v = json.loads(now)
        good = v.get("versionCode") == new_code and v.get("sha256") == new_sha
        print(f"hub now serves {v.get('versionName')} ({v.get('versionCode')}), {v.get('apkSize'):,} bytes, patches from {v.get('patches')}: {'ok' if good else 'NOT what was sent'}")
        if not good:
            sys.exit(1)
    except ValueError:
        sys.exit(f"the hub did not answer with its version: {now[:200]}")

    if a.car:
        r = run(["ssh", "-o", "ConnectTimeout=10", a.car, "~/pan-update.sh"], timeout=600)
        print(f"car: {(r.stdout or '').strip().splitlines()[-1] if (r.stdout or '').strip() else 'not reachable'}")


if __name__ == "__main__":
    main()
