#!/usr/bin/env bash
# Removes PAN from this computer, for this user.
#
#   pan-uninstall.sh [--install-dir DIR] [--remove-data] [--quiet]
#
# Stops PAN, takes away its start with the computer, its menu entry and its program files.
# Your memory and settings (the data folder) are kept unless you say otherwise. PAN Setup
# copies this file to <install folder>/uninstall.sh.
set -uo pipefail

INSTALL_DIR=""
REMOVE_DATA=0; QUIET=0
while [ $# -gt 0 ]; do
    case "$1" in
        --install-dir) INSTALL_DIR="$2"; shift 2 ;;
        --remove-data) REMOVE_DATA=1; shift ;;
        --quiet) QUIET=1; shift ;;
        *) echo "PAN uninstall: unknown option $1" >&2; exit 2 ;;
    esac
done
# Beside install.json when run as <install folder>/uninstall.sh.
[ -n "$INSTALL_DIR" ] || INSTALL_DIR="$(cd "$(dirname "$0")" && pwd -P)"
INSTALL_DIR="$(cd "$INSTALL_DIR" 2>/dev/null && pwd -P)" || { echo "PAN is not installed there."; exit 0; }
CONFIG="$INSTALL_DIR/install.json"
# Only a folder PAN Setup made is ever emptied.
[ -f "$CONFIG" ] || { echo "No install.json in $INSTALL_DIR: this is not a PAN that PAN Setup installed, nothing was touched." >&2; exit 1; }

say() { printf '%s\n' "$1"; }
field() { sed -n 's/.*"'"$1"'"[[:space:]]*:[[:space:]]*"\{0,1\}\([^",}]*\)"\{0,1\}.*/\1/p' "$CONFIG" | head -1; }
TAG="$(field tag)"; UNIT="$(field unit)"; DATA_DIR="$(field dataDir)"; FIREWALL="$(field firewallRule)"; LINK_PORT="$(field linkPort)"
[ -n "$TAG" ] || TAG="pan"
[ -n "$UNIT" ] || UNIT="$TAG.service"
[ -n "$DATA_DIR" ] || DATA_DIR="$INSTALL_DIR/data"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
LEFT=""

say "Removing PAN from $INSTALL_DIR"

# 1. Stop it, and take it out of the computer's start.
if command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
    systemctl --user disable --now "$UNIT" >/dev/null 2>&1 || true
fi
rm -f "$UNIT_DIR/$UNIT"
command -v systemctl >/dev/null 2>&1 && systemctl --user daemon-reload >/dev/null 2>&1
mine() {
    local p exe
    for p in /proc/[0-9]*; do
        [ "${p#/proc/}" = "$$" ] && continue
        exe="$(readlink "$p/exe" 2>/dev/null)" || continue
        case "$exe" in "$INSTALL_DIR"/*) echo "${p#/proc/}" ;; esac
    done
}
for round in 1 2 3 4 5; do
    pids="$(mine)"; [ -z "$pids" ] && break
    if [ "$round" -lt 3 ]; then kill -TERM $pids 2>/dev/null || true; else kill -KILL $pids 2>/dev/null || true; fi
    sleep 2
done
[ -z "$(mine)" ] || LEFT="$LEFT  some of PAN's programs are still running"$'\n'
say "  PAN is stopped."

# 1b. Models PAN Setup added to an Ollama that was here before PAN: taken out again, and that
#     Ollama is left alone. (An Ollama PAN Setup installed lives in this folder with its
#     models, and goes with the files below.)
NODE="$INSTALL_DIR/app/$(field version)/node/bin/node"
if [ -x "$NODE" ]; then
    added="$("$NODE" -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));if(!c.ollamaInstalledBySetup&&c.ollama)console.log([c.ollama,...(c.modelsAdded||[])].join("\n"))' "$CONFIG" 2>/dev/null)"
    if [ -n "$added" ]; then
        own="$(printf '%s\n' "$added" | head -1)"; n=0
        while IFS= read -r model; do
            [ -n "$model" ] && "$own" rm "$model" >/dev/null 2>&1 && n=$((n + 1))
        done <<< "$(printf '%s\n' "$added" | tail -n +2)"
        say "  Removed $n models from your Ollama."
    fi
fi

# 1c. An Ollama that PAN Setup installed keeps a key of its own in ~/.ollama. It goes too,
#     unless that folder holds model files, which would mean somebody else's Ollama used it.
if grep -q '"ollamaInstalledBySetup": *true' "$CONFIG" && [ -d "$HOME/.ollama" ] && [ -z "$(find "$HOME/.ollama/models" -type f 2>/dev/null | head -1)" ]; then
    rm -rf "$HOME/.ollama"
fi

# 2. The menu entry.
[ "$TAG" = "pan" ] && rm -f "${XDG_DATA_HOME:-$HOME/.local/share}/applications/pan.desktop"

# 3. The firewall opening, if PAN Setup made one.
if [ -n "$FIREWALL" ] && [ "$FIREWALL" != "null" ]; then
    if [ "$QUIET" = 1 ] || [ ! -t 0 ]; then
        LEFT="$LEFT  the firewall opening for PAN Link (remove it with: sudo ufw delete allow $LINK_PORT/udp)"$'\n'
    else
        say "  Removing PAN Link's firewall opening. It will ask for your password."
        sudo ufw delete allow "$LINK_PORT/udp" >/dev/null || LEFT="$LEFT  the firewall opening for PAN Link (sudo ufw delete allow $LINK_PORT/udp)"$'\n'
    fi
fi

# 4. The data: only when asked.
DROP_DATA="$REMOVE_DATA"
if [ "$DROP_DATA" != 1 ] && [ "$QUIET" != 1 ] && [ -t 0 ] && [ -d "$DATA_DIR" ]; then
    printf "Also delete PAN's memory and settings on this computer? This cannot be undone. Type YES to delete: "; read -r answer
    [ "$answer" = "YES" ] && DROP_DATA=1
fi

# 5. The files.
cd /
for item in "$INSTALL_DIR"/* "$INSTALL_DIR"/.[!.]*; do
    [ -e "$item" ] || continue
    if [ "$item" = "$DATA_DIR" ] && [ "$DROP_DATA" != 1 ]; then continue; fi
    rm -rf "$item" 2>/dev/null || LEFT="$LEFT  $item"$'\n'
done
case "$DATA_DIR" in
    "$INSTALL_DIR"/*) ;;
    *) [ "$DROP_DATA" = 1 ] && [ -d "$DATA_DIR" ] && rm -rf "$DATA_DIR" ;;
esac
rmdir "$INSTALL_DIR" 2>/dev/null || true

if [ "$DROP_DATA" != 1 ] && [ -d "$DATA_DIR" ]; then say "  Your memory and settings were kept in $DATA_DIR"; fi
if [ -n "$LEFT" ]; then
    say "PAN is removed, except for:"; printf '%s' "$LEFT"
    exit 3
fi
say "PAN is removed."
exit 0
