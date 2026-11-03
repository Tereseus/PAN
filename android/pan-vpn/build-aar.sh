#!/bin/bash
# Builds app/libs/panvpn.aar (tsnet proxy) with gomobile. OUT=/some/file.aar builds elsewhere,
# so a new library can be checked before it replaces the working one.
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
export PATH="/c/Program Files/Android/Android Studio/jbr/bin:$PATH:/c/Program Files/Go/bin:$HOME/go/bin"
export ANDROID_HOME="$HOME/AppData/Local/Android/Sdk"
export ANDROID_NDK_HOME="$ANDROID_HOME/ndk/27.0.12077973"
# go's -overlay wants absolute paths, which differ per machine, so the mapping in overlay.json
# (repo-relative, public repo) is written out with this machine's paths at build time.
OVERLAY="$(mktemp -d)/overlay.json"
python -c "import json, sys; json.dump({'Replace': {sys.argv[1]: sys.argv[2]}}, open(sys.argv[3], 'w'))" \
  "$(cygpath -w "$(go env GOROOT)/src/net/interface_linux.go")" \
  "$(cygpath -w "$HERE/overlay/net/interface_linux.go")" "$(cygpath -w "$OVERLAY")"
export GOFLAGS="-overlay=$(cygpath -w "$OVERLAY")"
cd "$HERE"
gomobile bind -v -target=android/arm64 -androidapi 26 -ldflags="-checklinkname=0" -o "${OUT:-../app/libs/panvpn.aar}" .
