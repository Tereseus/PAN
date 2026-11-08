#!/bin/bash
# Builds app/libs/panvpn.aar (tsnet proxy) with gomobile. OUT=/some/file.aar builds elsewhere,
# so a new library can be checked before it replaces the working one.
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
export PATH="/c/Program Files/Android/Android Studio/jbr/bin:$PATH:/c/Program Files/Go/bin:$HOME/go/bin"
export ANDROID_HOME="$HOME/AppData/Local/Android/Sdk"
export ANDROID_NDK_HOME="$ANDROID_HOME/ndk/27.0.12077973"
# Go records local module folders in the library (the replace of dev.pan/link), even with
# -trimpath, and this machine's folders hold the user name, while the library is committed
# to a public repo. So build through a drive letter of its own (subst, removed again when
# the script ends): the library then says P:\pan-link instead.
for d in P Q R S T U V W; do
  if cmd //d //c "if exist $d:\ (exit 1) else (exit 0)" >/dev/null 2>&1; then
    cmd //d //c "subst $d: $(cygpath -w "$(cd "$HERE/../.." && pwd)")"
    trap "cmd //d //c \"subst $d: /d\" >/dev/null 2>&1" EXIT
    HERE="$d:/android/pan-vpn"
    break
  fi
done
# go's -overlay wants absolute paths, which differ per machine, so the mapping in overlay.json
# (repo-relative, public repo) is written out with this machine's paths at build time.
OVERLAY="$(mktemp -d)/overlay.json"
python -c "import json, sys; json.dump({'Replace': {sys.argv[1]: sys.argv[2]}}, open(sys.argv[3], 'w'))" \
  "$(cygpath -w "$(go env GOROOT)/src/net/interface_linux.go")" \
  "$(cygpath -w "$HERE/overlay/net/interface_linux.go")" "$(cygpath -w "$OVERLAY")"
export GOFLAGS="-overlay=$(cygpath -w "$OVERLAY")"
cd "$HERE"
# -trimpath keeps this machine's folders out of the source file names in the library.
gomobile bind -v -trimpath -target=android/arm64 -androidapi 26 -ldflags="-checklinkname=0" -o "${OUT:-../app/libs/panvpn.aar}" .
