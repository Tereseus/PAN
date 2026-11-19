#!/usr/bin/env bash
# PAN Setup for Linux.
#
# Puts PAN on this computer, for this user, and starts it:
#   1. checks the computer
#   2. downloads the current PAN (one file, checked against its SHA-256)
#   3. unpacks it into <install folder>/app/<version>
#   4. starts PAN now and at every start of the computer (a systemd user unit), hidden
#   5. opens the page with the code the phone scans
#
# Nothing is installed system wide, nothing runs as root, and PAN listens on this
# computer's own address only. The one thing that can need root is a firewall rule for PAN
# Link's UDP port, which is how the person's phone gets in; Setup asks before it does that.
#
# Run again to update: the new version goes beside the old one and the old one is removed
# only after the new one answers.
#
#   --source DIR|URL   a folder or an http(s) address holding release-linux.json and the file
#   --install-dir DIR  default ~/.local/share/pan
#   --quiet            no questions, no browser, no sudo (for tests)
#   --dev              test mode: PAN skips the parts that act on the whole computer (its
#                      steward, the orphan reaper, the device heartbeat). For an install test
#                      on a computer that already runs other things.
#   --no-autostart --no-firewall --no-start
#   --port N --carrier-port N --craft-port-base N --link-port N --link-admin HOST:PORT
#
#   --voice            also install what PAN talks with: Ollama (its own package, into the
#                      install folder, unless an Ollama already answers here) and the models
#                      in service/model-set.json. Several GB. Then one real voice turn.
#   --translator       also install the computer's own translator: a Python of its own inside
#                      the install folder and the translation models from Hugging Face.
#   --all              --voice and --translator
#   --own-models DIR|URL  where PAN's own two models are, as .gguf files. Without it they
#                      are skipped and the stock ones stand in.
#   --model-set light|full  instead of choosing by this computer's memory
set -uo pipefail

SOURCE="https://github.com/Tereseus/PAN/releases/latest/download"
INSTALL_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/pan"
DEFAULT_DIR="$INSTALL_DIR"
PORT=7777; CARRIER_PORT=17760; CRAFT_PORT_BASE=17700; LINK_PORT=41720; LINK_ADMIN="127.0.0.1:7792"
QUIET=0; NO_AUTOSTART=0; NO_FIREWALL=0; NO_START=0; DEV=0; START_TIMEOUT=240
VOICE=0; TRANSLATOR=0; OWN_MODELS=""; MODEL_SET=""

while [ $# -gt 0 ]; do
    case "$1" in
        --source) SOURCE="$2"; shift 2 ;;
        --install-dir) INSTALL_DIR="$2"; shift 2 ;;
        --port) PORT="$2"; shift 2 ;;
        --carrier-port) CARRIER_PORT="$2"; shift 2 ;;
        --craft-port-base) CRAFT_PORT_BASE="$2"; shift 2 ;;
        --link-port) LINK_PORT="$2"; shift 2 ;;
        --link-admin) LINK_ADMIN="$2"; shift 2 ;;
        --start-timeout) START_TIMEOUT="$2"; shift 2 ;;
        --quiet) QUIET=1; shift ;;
        --no-autostart) NO_AUTOSTART=1; shift ;;
        --no-firewall) NO_FIREWALL=1; shift ;;
        --no-start) NO_START=1; shift ;;
        --dev) DEV=1; shift ;;
        --voice) VOICE=1; shift ;;
        --translator) TRANSLATOR=1; shift ;;
        --all) VOICE=1; TRANSLATOR=1; shift ;;
        --own-models) OWN_MODELS="$2"; shift 2 ;;
        --model-set) MODEL_SET="$2"; shift 2 ;;
        -h|--help) sed -n '2,37p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "PAN Setup: unknown option $1" >&2; exit 2 ;;
    esac
done

mkdir -p "$INSTALL_DIR" || { echo "PAN Setup stopped: cannot make $INSTALL_DIR" >&2; exit 1; }
INSTALL_DIR="$(cd "$INSTALL_DIR" && pwd -P)"
DEFAULT_DIR="$(mkdir -p "$DEFAULT_DIR" 2>/dev/null; cd "$DEFAULT_DIR" 2>/dev/null && pwd -P)"
# Two installs side by side (a test beside the real one) must not share names.
if [ "$INSTALL_DIR" = "$DEFAULT_DIR" ]; then TAG="pan"; else TAG="pan-$(printf '%s' "$INSTALL_DIR" | cksum | cut -d' ' -f1 | tail -c 6)"; fi
DATA_DIR="$INSTALL_DIR/data"
APP_ROOT="$INSTALL_DIR/app"
LOG="$INSTALL_DIR/setup.log"
RESULT="$INSTALL_DIR/setup-result.json"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT="$TAG.service"
STEP="start"; VERSION=""; WARNINGS=""; NODE=""

say() { printf '%s\n' "$1"; printf '%s %s\n' "$(date +%FT%T)" "$1" >> "$LOG" 2>/dev/null || true; }
step() { STEP="$1"; say ""; say "> $2"; }
warn() { WARNINGS="$WARNINGS$1"$'\n'; say "  ! $1"; }
save_result() {  # $1 = true|false, $2 = error text
    local n="$NODE"; [ -x "$n" ] || n="$(command -v node || true)"
    if [ -n "$n" ]; then
        OK="$1" ERR="${2:-}" STEP="$STEP" VERSION="$VERSION" INSTALL_DIR="$INSTALL_DIR" WARNINGS="$WARNINGS" UNIT="${UNIT_USED:-}" \
        LISTEN="${LISTEN:-}" AUTOSTART="${AUTOSTART:-false}" FIREWALL="${FIREWALL_RULE:-}" PAIR="http://127.0.0.1:$PORT/pair/" RESULT="$RESULT" \
        "$n" -e 'const e=process.env;require("fs").writeFileSync(e.RESULT,JSON.stringify({ok:e.OK==="true",step:e.STEP,version:e.VERSION||null,
          installDir:e.INSTALL_DIR,error:e.ERR||undefined,warnings:e.WARNINGS.split("\n").filter(Boolean),listen:e.LISTEN.split(" ").filter(Boolean),
          autostart:e.AUTOSTART==="true",unit:e.UNIT||null,firewallRule:e.FIREWALL||null,pairUrl:e.PAIR},null,2))' 2>/dev/null || true
    fi
}
stop_setup() { say ""; say "PAN Setup stopped: $1"; save_result false "$1"; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }
user_systemd() { have systemctl && systemctl --user show-environment >/dev/null 2>&1; }
listening() { ss -ltnH "sport = :$1" 2>/dev/null | awk '{print $4}' | sed 's/:[0-9]*$//' | sort -u | tr '\n' ' '; }
health() {
    # Ready means all of PAN, not just its front door: the front door answers /health a few
    # seconds before the part behind it (the Craft) can serve anything.
    "$NODE" -e '
      const p = process.argv[1];
      (async () => {
        const h = await (await fetch(`http://127.0.0.1:${p}/health`, { signal: AbortSignal.timeout(4000) })).json();
        if (!(h.craftHealthy === true || h.status === "running")) process.exit(1);
        const me = await fetch(`http://127.0.0.1:${p}/api/v1/auth/me`, { signal: AbortSignal.timeout(6000) });
        process.exit(me.status === 200 ? 0 : 1);
      })().catch(() => process.exit(1));' "$PORT" >/dev/null 2>&1
}
mine() {
    # Everything running out of this install folder: the launcher, PAN, pan-link and what they started.
    local p exe
    for p in /proc/[0-9]*; do
        [ "${p#/proc/}" = "$$" ] && continue
        exe="$(readlink "$p/exe" 2>/dev/null)" || continue
        case "$exe" in "$INSTALL_DIR"/*) echo "${p#/proc/}" ;; esac
    done
}
stop_tree() {
    if user_systemd; then systemctl --user stop "$UNIT" >/dev/null 2>&1 || true; fi
    local round pids
    for round in 1 2 3 4; do
        pids="$(mine)"; [ -z "$pids" ] && return 0
        if [ "$round" -lt 3 ]; then kill -TERM $pids 2>/dev/null || true; else kill -KILL $pids 2>/dev/null || true; fi
        sleep 2
    done
}
field() { sed -n 's/.*"'"$1"'"[[:space:]]*:[[:space:]]*"\{0,1\}\([^",}]*\)"\{0,1\}.*/\1/p' "$2" | head -1; }
fetch_to() {  # url, file
    if have curl; then
        if [ "$QUIET" = 1 ]; then curl -L --fail --retry 5 --retry-delay 3 -C - -sS -o "$2" "$1"; else curl -L --fail --retry 5 --retry-delay 3 -C - -o "$2" "$1"; fi
    else
        wget -c -q -O "$2" "$1"
    fi
}

say "PAN Setup"
say "  into $INSTALL_DIR"

# ---- 1. the computer -------------------------------------------------------------------
step "check" "Checking this computer"
[ "$(uname -s)" = "Linux" ] || stop_setup "This is PAN Setup for Linux."
[ "$(uname -m)" = "x86_64" ] || stop_setup "PAN needs a 64 bit Intel or AMD computer for now (this one is $(uname -m))."
[ "$(id -u)" != "0" ] || stop_setup "Run PAN Setup as yourself, not as root: PAN belongs to one person."
have tar || stop_setup "This computer has no tar."
have sha256sum || stop_setup "This computer has no sha256sum."
have curl || have wget || stop_setup "This computer has neither curl nor wget, so nothing can be downloaded."
RAM_GB=$(awk '/MemTotal/ {printf "%d", $2/1048576 + 0.5}' /proc/meminfo)
FREE_GB=$(df -Pk "$INSTALL_DIR" | awk 'NR==2 {printf "%d", $4/1048576}')
GLIBC="$(getconf GNU_LIBC_VERSION 2>/dev/null | awk '{print $2}')"
say "  Linux $(uname -r), ${RAM_GB} GB memory, ${FREE_GB} GB free, glibc ${GLIBC:-unknown}"
[ "$RAM_GB" -ge 4 ] || stop_setup "PAN needs at least 4 GB of memory."
[ "$FREE_GB" -ge 3 ] || stop_setup "PAN needs at least 3 GB of free disk space."
[ -n "$GLIBC" ] || stop_setup "This Linux does not use glibc (Alpine and the like), which PAN's bundle needs."
OLD_VERSION=""
if [ -f "$INSTALL_DIR/install.json" ]; then
    OLD_VERSION="$(field version "$INSTALL_DIR/install.json")"
    say "  PAN $OLD_VERSION is installed here already. Updating."
elif [ -n "$(listening "$PORT")" ]; then
    stop_setup "Something else on this computer already uses port $PORT. Close it, or it may be another copy of PAN."
fi

# ---- 2. the download -------------------------------------------------------------------
step "download" "Getting the current PAN"
DL="$INSTALL_DIR/download"; mkdir -p "$DL"
REL="$DL/release-linux.json"
case "$SOURCE" in
    http://*|https://*) WEB=1; rm -f "$REL"; fetch_to "${SOURCE%/}/release-linux.json" "$REL" || stop_setup "Could not reach the download page. Check the internet connection." ;;
    *) WEB=0; [ -f "$SOURCE/release-linux.json" ] || stop_setup "No release-linux.json in $SOURCE"; cp "$SOURCE/release-linux.json" "$REL" ;;
esac
VERSION="$(field version "$REL")"; FILE="$(field file "$REL")"; SHA="$(field sha256 "$REL")"; SIZE="$(field size "$REL")"; NEEDS_GLIBC="$(field glibc "$REL")"
[ -n "$VERSION" ] && [ -n "$FILE" ] && [ -n "$SHA" ] || stop_setup "The release list is not readable."
printf '%s' "$VERSION" | grep -Eq '^[0-9A-Za-z._-]{1,40}$' || stop_setup "The release list names a version that is not allowed."
printf '%s' "$FILE" | grep -Eq '^[0-9A-Za-z._-]{1,80}\.tar\.gz$' || stop_setup "The release list names a file that is not allowed."
say "  PAN $VERSION, $(( ${SIZE:-0} / 1048576 )) MB"
if [ -n "$NEEDS_GLIBC" ] && [ "$(printf '%s\n%s\n' "$NEEDS_GLIBC" "$GLIBC" | sort -V | head -1)" != "$NEEDS_GLIBC" ]; then
    stop_setup "This Linux is too old for this PAN (it has glibc $GLIBC, PAN was built for $NEEDS_GLIBC or newer)."
fi
PKG="$DL/$FILE"
# This very version is here and whole already (Setup run again to add voice, say): nothing to fetch.
HAVE_IT=0
if [ "$OLD_VERSION" = "$VERSION" ] && [ -x "$APP_ROOT/$VERSION/node/bin/node" ] && [ -f "$APP_ROOT/$VERSION/VERSION.json" ]; then HAVE_IT=1; fi
if [ "$HAVE_IT" = 1 ]; then
    say "  This version is already here."
elif [ ! -f "$PKG" ] || [ "$(sha256sum "$PKG" | cut -d' ' -f1)" != "$SHA" ]; then
    if [ "$WEB" = 1 ]; then
        fetch_to "${SOURCE%/}/$FILE" "$PKG" || stop_setup "The download did not finish. Run PAN Setup again to carry on."
    else
        cp "$SOURCE/$FILE" "$PKG" || stop_setup "Could not copy $FILE from $SOURCE"
    fi
    if [ "$(sha256sum "$PKG" | cut -d' ' -f1)" != "$SHA" ]; then
        rm -f "$PKG"; stop_setup "The download does not match what was published, so it was thrown away. Run PAN Setup again."
    fi
fi
[ "$HAVE_IT" = 1 ] || say "  Downloaded and checked."

# ---- 3. unpack -------------------------------------------------------------------------
step "unpack" "Unpacking"
TARGET="$APP_ROOT/$VERSION"
NODE="$TARGET/node/bin/node"
if [ -n "$OLD_VERSION" ] || [ -d "$TARGET" ]; then say "  Stopping the PAN that is running."; stop_tree; fi
if [ ! -x "$NODE" ] || [ ! -f "$TARGET/VERSION.json" ]; then
    TMP="$APP_ROOT/.$VERSION.new"
    rm -rf "$TMP" "$TARGET"; mkdir -p "$TMP"
    tar -xzf "$PKG" -C "$TMP" || stop_setup "Unpacking failed."
    [ -x "$TMP/app/node/bin/node" ] || stop_setup "The download is missing parts."
    mv "$TMP/app" "$TARGET"; rm -rf "$TMP"
fi
LAUNCHER="$TARGET/launcher/pan-launcher.cjs"
for must in "$NODE" "$LAUNCHER" "$TARGET/service/pan.js" "$TARGET/pan-link/pan-link"; do
    [ -e "$must" ] || stop_setup "Missing after unpacking: $must"
done
"$NODE" -e 'process.exit(0)' 2>/dev/null || stop_setup "PAN's own Node does not run on this computer."
say "  PAN is in $TARGET"

# ---- 4. settings for the launcher ------------------------------------------------------
step "configure" "Setting it up"
mkdir -p "$DATA_DIR"
cp "$TARGET/setup/pan-uninstall.sh" "$INSTALL_DIR/uninstall.sh" && chmod +x "$INSTALL_DIR/uninstall.sh"

# The firewall: one opening, PAN Link's UDP port. PAN's own ports stay on this computer.
FIREWALL_RULE=""
if [ "$NO_FIREWALL" = 1 ]; then
    say "  Firewall skipped (asked to)."
elif grep -qs '^ENABLED=yes' /etc/ufw/ufw.conf; then
    if [ "$QUIET" = 1 ] || [ ! -t 0 ]; then
        warn "This computer's firewall is on. For a phone to reach PAN from outside this computer, let PAN Link in: sudo ufw allow $LINK_PORT/udp"
    else
        say "  This computer's firewall is on. PAN Link needs one opening (UDP $LINK_PORT) for your phone."
        printf "  Add it now? It will ask for your password. [y/N] "; read -r answer
        if [ "$answer" = "y" ] || [ "$answer" = "Y" ]; then
            if sudo ufw allow "$LINK_PORT/udp" comment "PAN Link" >/dev/null; then FIREWALL_RULE="ufw $LINK_PORT/udp"; say "  Done."; else warn "The firewall was not changed."; fi
        else
            warn "Not added. Later: sudo ufw allow $LINK_PORT/udp"
        fi
    fi
fi

AUTOSTART=false; UNIT_USED=""
VERSION="$VERSION" INSTALL_DIR="$INSTALL_DIR" DATA_DIR="$DATA_DIR" PORT="$PORT" CARRIER_PORT="$CARRIER_PORT" CRAFT_PORT_BASE="$CRAFT_PORT_BASE" \
LINK_PORT="$LINK_PORT" LINK_ADMIN="$LINK_ADMIN" TAG="$TAG" DEV="$DEV" FIREWALL="$FIREWALL_RULE" UNIT="$UNIT" \
"$NODE" -e 'const e=process.env,fs=require("fs"),f=e.INSTALL_DIR+"/install.json";let old={};try{old=JSON.parse(fs.readFileSync(f,"utf8"))}catch{}
  fs.writeFileSync(f,JSON.stringify({version:e.VERSION,installDir:e.INSTALL_DIR,dataDir:e.DATA_DIR,port:+e.PORT,carrierPort:+e.CARRIER_PORT,
    craftPortBase:+e.CRAFT_PORT_BASE,linkPort:+e.LINK_PORT,linkAdmin:e.LINK_ADMIN,tag:e.TAG,unit:e.UNIT,installed:new Date().toISOString(),
    firewallRule:e.FIREWALL||old.firewallRule||null,autostart:false,dev:e.DEV==="1",
    ollama:old.ollama||null,ollamaInstalledBySetup:!!old.ollamaInstalledBySetup,ollamaModels:old.ollamaModels||undefined,modelsAdded:old.modelsAdded||[]},null,2))' \
    || stop_setup "Could not write install.json"

# Start with the computer, as this user (PAN needs this user's own Claude sign in).
if user_systemd; then
    mkdir -p "$UNIT_DIR"
    cat > "$UNIT_DIR/$UNIT" <<EOF
[Unit]
Description=PAN ($INSTALL_DIR)
After=network-online.target

[Service]
ExecStart="$NODE" "$LAUNCHER" "$INSTALL_DIR"
Environment="PATH=$PATH"
Restart=on-failure
RestartSec=5
TimeoutStopSec=20

[Install]
WantedBy=default.target
EOF
    systemctl --user daemon-reload
    UNIT_USED="$UNIT"
    if [ "$NO_AUTOSTART" = 1 ]; then
        systemctl --user disable "$UNIT" >/dev/null 2>&1 || true
    else
        systemctl --user enable "$UNIT" >/dev/null 2>&1 && AUTOSTART=true
        if [ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null)" = "yes" ]; then
            say "  PAN starts with this computer."
        else
            say "  PAN starts when you sign in. To have it start with the computer itself, before"
            say "  anyone signs in, run once: loginctl enable-linger $USER"
        fi
    fi
else
    warn "This Linux has no systemd for users, so PAN will not start by itself after a restart. Start it with: $INSTALL_DIR/start.sh"
fi
printf '#!/bin/sh\n# Starts PAN by hand (PAN Setup wrote this).\nexec setsid nohup "%s" "%s" "%s" >/dev/null 2>&1 &\n' "$NODE" "$LAUNCHER" "$INSTALL_DIR" > "$INSTALL_DIR/start.sh"
chmod +x "$INSTALL_DIR/start.sh"
"$NODE" -e 'const fs=require("fs"),f=process.argv[1],c=JSON.parse(fs.readFileSync(f,"utf8"));c.autostart=process.argv[2]==="true";fs.writeFileSync(f,JSON.stringify(c,null,2))' "$INSTALL_DIR/install.json" "$AUTOSTART"

if [ "$TAG" = "pan" ]; then
    APPS="${XDG_DATA_HOME:-$HOME/.local/share}/applications"; mkdir -p "$APPS"
    printf '[Desktop Entry]\nType=Application\nName=PAN\nComment=Personal AI Network\nExec=xdg-open http://127.0.0.1:%s/\nTerminal=false\nCategories=Utility;\n' "$PORT" > "$APPS/pan.desktop"
fi

# ---- 5. start --------------------------------------------------------------------------
if [ "$NO_START" = 1 ]; then
    say ""; say "Installed. Not started (asked not to)."
else
    step "start" "Starting PAN (the first start takes a minute)"
    if [ -n "$UNIT_USED" ]; then systemctl --user restart "$UNIT" || stop_setup "systemd could not start PAN. See: journalctl --user -u $UNIT"; else "$INSTALL_DIR/start.sh"; fi
    deadline=$(( $(date +%s) + START_TIMEOUT )); up=0
    while [ "$(date +%s)" -lt "$deadline" ]; do
        if health; then up=1; break; fi
        sleep 3
    done
    [ "$up" = 1 ] || stop_setup "PAN did not answer within $START_TIMEOUT seconds. Its log is $DATA_DIR/hub.log"
    say "  PAN is running."

    step "verify" "Checking it"
    LISTEN="$(listening "$PORT")"
    open="$(printf '%s\n' $LISTEN | grep -v -e '^127\.0\.0\.1$' -e '^\[::1\]$' -e '^$' || true)"
    if [ -n "$open" ]; then
        stop_tree
        stop_setup "PAN was listening on the network ($open), which must never happen. It was stopped."
    fi
    if [ -n "$LISTEN" ]; then say "  PAN answers on this computer only."; else warn "Could not see which address PAN listens on (no ss on this computer)."; fi

    # The old versions go only now, after the new one answered.
    for d in "$APP_ROOT"/*; do
        [ -d "$d" ] && [ "$d" != "$TARGET" ] && rm -rf "$d"
    done

    # ---- 6. what PAN talks with, and the translator -------------------------------------
    if [ "$VOICE" = 1 ] || [ "$TRANSLATOR" = 1 ]; then
        STEP="models"
        extra=(--install-dir "$INSTALL_DIR")
        [ "$VOICE" = 1 ] && extra+=(--voice)
        [ "$TRANSLATOR" = 1 ] && extra+=(--translator)
        [ -n "$OWN_MODELS" ] && extra+=(--own-models "$OWN_MODELS")
        [ -n "$MODEL_SET" ] && extra+=(--model-set "$MODEL_SET")
        [ "$QUIET" = 1 ] && extra+=(--quiet)
        "$NODE" "$TARGET/setup/setup-models.cjs" "${extra[@]}" || { save_result false "the models did not install"; exit 1; }
    fi
fi
if [ "$NO_START" = 1 ] && { [ "$VOICE" = 1 ] || [ "$TRANSLATOR" = 1 ]; }; then
    warn "The models were not installed because PAN was not started."
fi

step "done" "Done"
rm -f "$PKG"
save_result true
say "PAN is installed."
if [ "$NO_START" != 1 ]; then
    say "  Pair your phone: http://127.0.0.1:$PORT/pair/"
    if [ "$QUIET" != 1 ] && [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ] && have xdg-open; then xdg-open "http://127.0.0.1:$PORT/pair/" >/dev/null 2>&1 & fi
fi
say "  Remove it any time: $INSTALL_DIR/uninstall.sh"
exit 0
