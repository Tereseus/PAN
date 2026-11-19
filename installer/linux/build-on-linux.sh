#!/usr/bin/env bash
# The Linux half of building PAN's bundle. It runs on a Linux computer, because PAN's
# compiled modules have to be built where they will run.
#
#     build-on-linux.sh <stage folder> <out file.tar.gz>
#
# <stage folder>/app already holds PAN from git, the launcher, the setup scripts and a
# pan-link built for Linux (build-bundle.py --linux puts them there). This adds:
#     app/node/bin/node              the pinned Node, checked against nodejs.org's SHA-256
#     app/service/node_modules       a clean `npm ci` with that Node
# and packs app/ into the out file. Runs at the lowest priority.
set -euo pipefail

NODE_VERSION="24.13.0"
NODE_SHA256="e798599612f4bb71333a3397ab0d095fd62214e115aea45aa858a145fc72d67e"   # node-v24.13.0-linux-x64.tar.xz

STAGE="$(cd "$1" && pwd)"
OUT="$2"
APP="$STAGE/app"
CACHE="${PAN_BUILD_CACHE:-$HOME/.cache/pan-build}"
[ -f "$APP/service/package-lock.json" ] || { echo "no app/service/package-lock.json in $STAGE" >&2; exit 2; }
[ "$(uname -m)" = "x86_64" ] || { echo "this builds the x64 bundle; this computer is $(uname -m)" >&2; exit 2; }
mkdir -p "$CACHE"

# Low priority, and on a few cores when the build machine asks for that (PAN_BUILD_CORES=12-15).
quiet() {
    if [ -n "${PAN_BUILD_CORES:-}" ] && command -v taskset >/dev/null; then
        nice -n 19 taskset -c "$PAN_BUILD_CORES" "$@"
    else
        nice -n 19 "$@"
    fi
}

# 1. Node, pinned.
tarball="$CACHE/node-v$NODE_VERSION-linux-x64.tar.xz"
if [ ! -f "$tarball" ] || [ "$(sha256sum "$tarball" | cut -d' ' -f1)" != "$NODE_SHA256" ]; then
    echo "node: downloading v$NODE_VERSION"
    curl -L --fail --retry 5 -sS -o "$tarball.part" "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-x64.tar.xz"
    [ "$(sha256sum "$tarball.part" | cut -d' ' -f1)" = "$NODE_SHA256" ] || { rm -f "$tarball.part"; echo "node does not match its published SHA-256" >&2; exit 3; }
    mv "$tarball.part" "$tarball"
fi
NODE_HOME="$CACHE/node-v$NODE_VERSION-linux-x64"
[ -x "$NODE_HOME/bin/node" ] || tar -xJf "$tarball" -C "$CACHE"
mkdir -p "$APP/node/bin"
cp "$NODE_HOME/bin/node" "$APP/node/bin/node"
cp "$NODE_HOME/LICENSE" "$APP/node/LICENSE"

# 2. node_modules, clean, from the lock file. Kept between builds while the lock file and
#    the Node version stay the same.
lock="$(sha256sum "$APP/service/package-lock.json" | cut -c1-16)"
modules="$CACHE/node_modules-v$NODE_VERSION-$lock"
if [ -d "$modules/express" ]; then
    echo "node_modules from the cache"
else
    echo "node_modules: npm ci (a few minutes)"
    rm -rf "$APP/service/node_modules" "$modules"
    ( cd "$APP/service" && PATH="$NODE_HOME/bin:$PATH" quiet "$NODE_HOME/bin/node" "$NODE_HOME/lib/node_modules/npm/bin/npm-cli.js" ci --omit=dev --no-audit --no-fund ) > "$STAGE/npm-ci.log" 2>&1 \
        || { tail -40 "$STAGE/npm-ci.log" >&2; echo "npm ci failed" >&2; exit 4; }
    [ -d "$APP/service/node_modules/express" ] || { echo "npm ci reported success but installed nothing" >&2; exit 4; }
    mv "$APP/service/node_modules" "$modules"
fi
rm -rf "$APP/service/node_modules"
cp -a "$modules" "$APP/service/node_modules"

# 3. The compiled modules must load in this Node, or the bundle is no use.
( cd "$APP/service" && "$APP/node/bin/node" -e '
  for (const m of ["better-sqlite3-multiple-ciphers", "node-pty", "sqlite-vec"]) { require(m); }
  console.log("compiled modules load");' )

chmod +x "$APP/node/bin/node" "$APP/pan-link/pan-link" "$APP"/setup/*.sh

# 4. One file.
mkdir -p "$(dirname "$OUT")"
quiet tar -C "$STAGE" -czf "$OUT" app
echo "files $(find "$APP" -type f | wc -l)"
echo "size $(stat -c %s "$OUT")"
echo "sha256 $(sha256sum "$OUT" | cut -d' ' -f1)"
# The oldest glibc this bundle runs on: the newest GLIBC symbol any of its programs asks for.
need="$( { objdump -T "$APP/node/bin/node" "$APP/pan-link/pan-link" 2>/dev/null || true; find "$APP/service/node_modules" -name '*.node' -exec objdump -T {} + 2>/dev/null || true; } | { grep -o 'GLIBC_[0-9][0-9.]*' || true; } | sed 's/GLIBC_//' | sort -Vu | tail -1 )"
echo "glibc ${need:-$(getconf GNU_LIBC_VERSION | awk '{print $2}')}"
