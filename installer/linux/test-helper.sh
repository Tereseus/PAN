#!/usr/bin/env bash
# What install-test.py runs on the Linux computer under test. One action, one line of JSON.
#
#   test-helper.sh <action> <install dir> <port> <link admin host:port> <link udp port> [more]
#     probe                    what is there: files, unit, programs, ports, health
#     http METHOD PATH [B64]   one request to PAN on this computer
#     kill-pan                 kill PAN itself (not its launcher), as a crash would
#     restart-unit             stop and start the unit, as a restart of the computer would
#     pair CODE_B64 LISTEN     pair a stand-in device here and ask PAN, through the link, who it is
set -uo pipefail
ACTION="$1"; DIR="$2"; PORT="$3"; ADMIN="$4"; LINK_PORT="$5"; shift 5

CONFIG="$DIR/install.json"
field() { [ -f "$CONFIG" ] && sed -n 's/.*"'"$1"'"[[:space:]]*:[[:space:]]*"\{0,1\}\([^",}]*\)"\{0,1\}.*/\1/p' "$CONFIG" | head -1; }
VERSION="$(field version)"; UNIT="$(field unit)"
# With PAN gone there is no install.json to name the unit, so work the name out as PAN Setup does.
if [ -z "$UNIT" ]; then
    real="$(realpath -m "$DIR")"; default="$(realpath -m "${XDG_DATA_HOME:-$HOME/.local/share}/pan")"
    if [ "$real" = "$default" ]; then UNIT="pan.service"; else UNIT="pan-$(printf '%s' "$real" | cksum | cut -d' ' -f1 | tail -c 6).service"; fi
fi
NODE="$DIR/app/$VERSION/node/bin/node"
LINK="$DIR/app/$VERSION/pan-link/pan-link"
jlist() { local out="" x; for x in "$@"; do out="$out${out:+,}\"$x\""; done; printf '[%s]' "$out"; }
mine() {
    local p exe
    for p in /proc/[0-9]*; do
        exe="$(readlink "$p/exe" 2>/dev/null)" || continue
        case "$exe" in "$DIR"/*) echo "${p#/proc/}" ;; esac
    done
}
tcp() { ss -ltnH "sport = :$1" 2>/dev/null | awk '{print $4}' | sed 's/:[0-9]*$//' | sort -u; }
udp() { ss -lunH "sport = :$1" 2>/dev/null | awk '{print $4}' | sed 's/:[0-9]*$//' | sort -u; }
bool() { if "$@" >/dev/null 2>&1; then printf true; else printf false; fi; }
http() {  # METHOD URL [body b64]
    "$NODE" -e '
      const [method, url, b64] = process.argv.slice(1);
      (async () => {
        const opt = { method, signal: AbortSignal.timeout(20000), headers: {} };
        if (b64) { opt.body = Buffer.from(b64, "base64").toString("utf8"); opt.headers["content-type"] = "application/json"; }
        const r = await fetch(url, opt); const body = await r.text(); let json = null; try { json = JSON.parse(body); } catch {}
        console.log(JSON.stringify({ status: r.status, json, body: json ? undefined : body.slice(0, 400) }));
      })().catch((e) => console.log(JSON.stringify({ status: 0, error: String(e.message || e) })));' "$@"
}

case "$ACTION" in
    probe)
        health=false
        if [ -x "$NODE" ]; then
            h="$(http GET "http://127.0.0.1:$PORT/health")"; a="$(http GET "http://127.0.0.1:$PORT/api/v1/auth/me")"
            case "$h" in *'"status":200'*) case "$a" in *'"status":200'*) health=true ;; esac ;; esac
        fi
        versions=(); [ -d "$DIR/app" ] && for d in "$DIR"/app/*/; do [ -d "$d" ] && versions+=("$(basename "$d")"); done
        unit_file="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/${UNIT:-none.service}"
        printf '{"dirExists":%s,"installed":%s,"version":"%s","unit":"%s","unitFile":%s,"unitEnabled":%s,"unitActive":%s,"programs":%s,"appVersions":%s,"dataExists":%s,"menuEntry":%s,"health":%s,"listen":{"pan":%s,"linkAdmin":%s,"linkUdp":%s}}\n' \
            "$(bool test -d "$DIR")" "$(bool test -f "$CONFIG")" "$VERSION" "$UNIT" "$(bool test -f "$unit_file")" \
            "$( [ -n "$UNIT" ] && bool systemctl --user is-enabled "$UNIT" || printf false)" "$( [ -n "$UNIT" ] && bool systemctl --user is-active "$UNIT" || printf false)" \
            "$(mine | wc -l)" "$(jlist ${versions[@]+"${versions[@]}"})" "$(bool test -d "$DIR/data")" \
            "$(bool test -f "${XDG_DATA_HOME:-$HOME/.local/share}/applications/pan.desktop")" "$health" \
            "$(jlist $(tcp "$PORT"))" "$(jlist $(tcp "${ADMIN##*:}"))" "$(jlist $(udp "$LINK_PORT"))"
        ;;
    http)
        http "$1" "http://127.0.0.1:$PORT$2" "${3:-}"
        ;;
    kill-pan)
        killed=()
        for pid in $(mine); do
            if tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | grep -q 'service/pan\.js start'; then kill -KILL "$pid" 2>/dev/null && killed+=("$pid"); fi
        done
        printf '{"killed":%s}\n' "$(jlist ${killed[@]+"${killed[@]}"})"
        ;;
    restart-unit)
        systemctl --user stop "$UNIT"; sleep 2; left="$(mine | wc -l)"
        systemctl --user start "$UNIT"
        printf '{"ok":%s,"leftAfterStop":%s}\n' "$(bool systemctl --user is-active "$UNIT")" "$left"
        ;;
    pair)
        code="$(printf '%s' "$1" | base64 -d)"; listen="$2"
        client="$DIR/test-client"; rm -rf "$client"; mkdir -p "$client"
        out="$("$LINK" pair --code "$code" --data "$client" --name "install test device" 2>&1)"; rc=$?
        me='null'
        if [ "$rc" = 0 ]; then
            "$LINK" client --data "$client" --listen "$listen" >/dev/null 2>&1 &
            cpid=$!
            for i in 1 2 3 4 5 6 7 8 9 10; do
                sleep 2
                r="$(http GET "http://$listen/api/v1/auth/me")"
                case "$r" in *'"status":200'*) me="$r"; break ;; esac
            done
            kill "$cpid" 2>/dev/null
        fi
        printf '{"paired":%s,"output":%s,"me":%s}\n' "$( [ "$rc" = 0 ] && printf true || printf false)" \
            "$(printf '%s' "$out" | tail -c 300 | "$NODE" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.stringify(s)))')" "$me"
        ;;
    *) printf '{"error":"unknown action %s"}\n' "$ACTION"; exit 2 ;;
esac
