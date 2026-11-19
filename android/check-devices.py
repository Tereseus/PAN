"""Installs the built app on devices over adb and checks each one starts on its voice.

    python android/check-devices.py SERIAL [SERIAL ...] [--adb PATH] [--ssh user@host] [--no-install] [--open]

For each device: installs app/build/outputs/apk/debug/app-debug.apk, starts ΠAN's service, and
reads the line the app logs at every start about its voice (tts/VoiceChoice.kt). The device
passes when that line says its voice is ready, or that the Android voice was chosen in Settings.
Anything else fails: a download still running, a voice that would not load, a setting that had
to be moved, or no line at all. The car unit spoke in the wrong voice for two days because
nothing looked (2026-11-19).

--ssh runs adb on another computer (a phone plugged in there); the app file is copied over first.
--open also brings the app's screen up. Never use it on a phone someone is holding.
Exit code 1 when any device fails.
"""
import argparse, os, re, subprocess, sys, time

sys.stdout.reconfigure(encoding="utf-8")
HERE = os.path.dirname(os.path.abspath(__file__))
APK = os.path.join(HERE, "app", "build", "outputs", "apk", "debug", "app-debug.apk")
SERVICE = "dev.pan.app/.service.PanForegroundService"
FINE = [re.compile(r"Voice: \S+ ready$"), re.compile(r"Voice: the Android voice, chosen in Settings$")]


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("serials", nargs="+")
    ap.add_argument("--adb", default="adb")
    ap.add_argument("--ssh", help="run adb on this computer instead")
    ap.add_argument("--no-install", action="store_true")
    ap.add_argument("--open", action="store_true")
    a = ap.parse_args()

    def run(cmd, timeout=180):
        if a.ssh:
            cmd = ["ssh", "-o", "ConnectTimeout=10", a.ssh, " ".join(f"'{c}'" if (" " in c or "*" in c) else c for c in cmd)]
        r = subprocess.run(cmd, capture_output=True, timeout=timeout, env={**os.environ, "MSYS_NO_PATHCONV": "1"})
        return (r.stdout + r.stderr).decode("utf-8", "replace")

    apk = APK
    if a.ssh and not a.no_install:
        apk = "/tmp/pan-check.apk"
        subprocess.run(["scp", "-q", APK, f"{a.ssh}:{apk}"], check=True)

    bad = 0
    for s in a.serials:
        adb = [a.adb, "-s", s]
        if not a.no_install:
            out = run(adb + ["install", "-r", apk]).strip().splitlines()
            if not out or "Success" not in out[-1]:
                print(f"FAIL {s}: install: {out[-1] if out else 'no answer'}")
                bad += 1
                continue
        else:
            run(adb + ["shell", "am", "force-stop", "dev.pan.app"])
        run(adb + ["logcat", "-c"])
        if a.open:
            run(adb + ["shell", "am", "start", "-n", "dev.pan.app/.MainActivity", "-f", "0x10008000"])
        run(adb + ["shell", "am", "start-foreground-service", "-n", SERVICE])
        line = None
        for _ in range(8):
            time.sleep(2)
            hits = [l.split("PanService: ", 1)[1].strip() for l in run(adb + ["logcat", "-d", "-s", "PanService:I"]).splitlines() if "PanService: Voice: " in l]
            if hits:
                line = hits[-1]
                # A setting being moved logs first and "could not be loaded" may follow: give it a moment more.
                time.sleep(2)
                hits = [l.split("PanService: ", 1)[1].strip() for l in run(adb + ["logcat", "-d", "-s", "PanService:I"]).splitlines() if "PanService: Voice: " in l]
                line = hits[-1]
                break
        version = re.search(r"versionName=(\S+)", run(adb + ["shell", "dumpsys", "package", "dev.pan.app"]))
        ok = line is not None and any(p.search(line) for p in FINE)
        print(f"{'ok  ' if ok else 'FAIL'} {s}: {version.group(1) if version else '?'}: {line or 'the app said nothing about its voice'}")
        bad += 0 if ok else 1
    if a.ssh and not a.no_install:
        run(["rm", "-f", apk])
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
