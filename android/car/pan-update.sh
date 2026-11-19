#!/data/data/com.termux/files/usr/bin/sh
# pan-update.sh: keeps the ΠAN app on a car head unit at the hub's newest build, with no tap on
# the screen and almost no data.
#
# Why: the unit is online through a phone's hotspot. The app's own updater downloads the whole
# build (74 MB) and Android then asks on screen, with a scan, every time. This runs in Termux on
# the unit instead:
#   - it asks the hub which build is newest (a few hundred bytes);
#   - when the unit is behind, it fetches only what changed since the build it has
#     (/apk/latest?patch_from=<its build>, about 0.2 MB between two builds in a row), and makes
#     the new build from its own installed one with zstd;
#   - it checks the result against the hub's sha256 and installs it through the unit's own debug
#     port, which asks nothing on screen;
#   - it starts ΠAN again with the microphone on.
#
# Usage:
#   pan-update.sh           one check now. Last word printed: UP_TO_DATE, DONE, NO_PATCH,
#                           BIG_PATCH, NO_HUB, ADB_CLOSED, BAD_FILE or INSTALL_FAILED.
#   pan-update.sh big       the same, and it takes a patch of any size. By itself it takes one
#                           only up to 5 MB (the number in ~/.pan-update-limit, in bytes, if that
#                           file is there): a build that brings a large new file makes a large
#                           patch (the voice in 0.5.38: 130 MB), and that waits for someone to
#                           say so, on a good connection. Last word then: BIG_PATCH.
#   pan-update.sh full      as big, and when there is no patch it downloads the whole build
#                           (it picks up where it stopped). Never by itself: that is the whole
#                           app over someone's mobile data.
#   pan-update.sh loop      a check every two minutes, for as long as the unit is on.
#
# Needs: ~/.pan-hub holding the hub's address on the tailnet (one line), tailscaled running in
# Termux (it is reached through `tailscale nc`: in userspace mode nothing else in Termux can open
# a tailnet address), zstd, and adb to the unit's own port 7088.
export PATH=$PREFIX/bin:$PATH
HUB=$(head -n 1 "$HOME/.pan-hub" 2>/dev/null | tr -d ' \r')
PORT=7777
APP=dev.pan.app
T="tailscale --socket=$PREFIX/var/run/tailscaled.sock"
A="adb -s 127.0.0.1:7088"
W=$HOME/pan-update
LOG=$HOME/pan-update.log
mkdir -p "$W"
say() { echo "$(date '+%F %T') $*" >> "$LOG"; }

# fetch <path> <file> <seconds> [from byte]: one HTTP GET through tailscaled. 0 when it answered
# 200 (the body is in <file>) or 206 (the body is added to <file>).
fetch() {
  raw=$W/raw.$$; fifo=$W/in.$$
  rm -f "$raw" "$fifo"; mkfifo "$fifo" || return 1
  timeout "$3" $T nc "$HUB" "$PORT" < "$fifo" > "$raw" 2>/dev/null &
  nc=$!
  # The request goes in and the pipe stays open: nc stops as soon as its input ends.
  exec 9> "$fifo"
  if [ -n "$4" ]; then printf 'GET %s HTTP/1.0\r\nHost: hub\r\nRange: bytes=%s-\r\n\r\n' "$1" "$4" >&9
  else printf 'GET %s HTTP/1.0\r\nHost: hub\r\n\r\n' "$1" >&9; fi
  wait $nc
  exec 9>&-
  rm -f "$fifo"
  code=$(head -n 1 "$raw" 2>/dev/null | awk '{print $2}')
  lines=$(awk '/^\r?$/ { print NR; exit }' "$raw" 2>/dev/null)
  if [ -z "$lines" ] || { [ "$code" != 200 ] && [ "$code" != 206 ]; }; then rm -f "$raw"; return 1; fi
  skip=$(head -n "$lines" "$raw" | wc -c)
  if [ "$code" = 206 ]; then tail -c +$((skip + 1)) "$raw" >> "$2"; else tail -c +$((skip + 1)) "$raw" > "$2"; fi
  rm -f "$raw"
}

sha() { sha256sum "$1" 2>/dev/null | cut -d' ' -f1; }
bytes() { wc -c < "$1" 2>/dev/null || echo 0; }

once() {
  [ -n "$HUB" ] || { echo NO_HUB; return 3; }
  adb connect 127.0.0.1:7088 >/dev/null 2>&1
  have=$($A shell dumpsys package $APP 2>/dev/null | sed -n 's/.*versionCode=\([0-9]*\).*/\1/p' | head -n 1)
  [ -n "$have" ] || { echo ADB_CLOSED; return 4; }
  fetch /api/v1/apk/version "$W/version.json" 30 || { echo NO_HUB; return 3; }
  want=$(sed -n 's/.*"versionCode":\([0-9]*\).*/\1/p' "$W/version.json")
  sum=$(sed -n 's/.*"sha256":"\([0-9a-f]*\)".*/\1/p' "$W/version.json")
  size=$(sed -n 's/.*"apkSize":\([0-9]*\).*/\1/p' "$W/version.json")
  [ -n "$want" ] && [ -n "$sum" ] || { echo NO_HUB; return 3; }
  [ "$want" -gt "$have" ] || { echo "UP_TO_DATE $have"; return 0; }
  # How big the patch from this unit's build is, when the hub says. A big one is not fetched by itself.
  big=$(sed -n 's/.*"patch_bytes":{[^}]*"'"$have"'":\([0-9]*\).*/\1/p' "$W/version.json")
  limit=$(head -n 1 "$HOME/.pan-update-limit" 2>/dev/null | tr -cd '0-9'); limit=${limit:-5000000}
  if [ -n "$big" ] && [ "$big" -gt "$limit" ] && [ "$1" != big ] && [ "$1" != full ]; then
    [ "$(cat "$W/told" 2>/dev/null)" = "big$want" ] || say "the patch from $have to $want is $big bytes, over $limit; 'pan-update.sh big' takes it"
    echo "big$want" > "$W/told"
    echo "BIG_PATCH $have $want $big"; return 8
  fi

  new=$W/pan-$want.apk
  if [ "$(sha "$new")" != "$sum" ]; then
    rm -f "$W"/pan-*.apk
    # The small way: what changed since the build this unit has.
    base=$($A shell pm path $APP 2>/dev/null | tr -d '\r' | sed -n 's/^package://p' | grep 'base\.apk$' | head -n 1)
    if [ -n "$base" ] && $A exec-out cat "$base" > "$W/old.apk" 2>/dev/null && fetch "/apk/latest?patch_from=$have" "$W/patch.zst" 300; then
      say "patch from $have to $want: $(bytes "$W/patch.zst") bytes"
      zstd -d -q -f --long=30 --patch-from="$W/old.apk" "$W/patch.zst" -o "$new" 2>> "$LOG"
    fi
    rm -f "$W/old.apk" "$W/patch.zst"
  fi
  if [ "$(sha "$new")" != "$sum" ]; then
    rm -f "$new"
    if [ "$1" != full ]; then
      [ "$(cat "$W/told" 2>/dev/null)" = "$want" ] || say "no patch from $have to $want; 'pan-update.sh full' downloads all $size bytes"
      echo "$want" > "$W/told"
      echo "NO_PATCH $have $want"; return 6
    fi
    # The whole build, picking up where an earlier try stopped.
    part=$W/pan-$want.part
    ls "$W"/pan-*.part 2>/dev/null | grep -v "pan-$want.part" | xargs -r rm -f
    tries=0
    while [ "$(bytes "$part")" -lt "$size" ] && [ $tries -lt 40 ]; do
      at=$(bytes "$part")
      if [ "$at" -gt 0 ]; then fetch "/apk/latest?direct=1" "$part" 600 "$at"; else fetch "/apk/latest?direct=1" "$part" 600; fi
      tries=$((tries + 1))
      [ "$(bytes "$part")" -gt "$at" ] || sleep 5
    done
    say "whole build $want: $(bytes "$part") of $size bytes after $tries tries"
    [ "$(sha "$part")" = "$sum" ] && mv "$part" "$new"
  fi
  [ "$(sha "$new")" = "$sum" ] || { rm -f "$new"; say "build $want did not match the hub's sha256"; echo BAD_FILE; return 7; }

  # Was ΠAN the app on screen? Then it goes back on screen afterwards.
  front=$($A shell dumpsys activity activities 2>/dev/null | grep -m 1 -E 'topResumedActivity|mResumedActivity' | grep -c "$APP/")
  out=$($A push "$new" /data/local/tmp/pan.apk 2>&1 >/dev/null; $A shell "pm install -r -t /data/local/tmp/pan.apk; rm -f /data/local/tmp/pan.apk" 2>&1)
  case "$out" in
    *Success*) ;;
    *) say "install of $want failed: $out"; echo "INSTALL_FAILED $out"; return 5 ;;
  esac
  rm -f "$new" "$W/told"
  say "installed $want (was $have)"
  [ "$front" = 1 ] && $A shell am start -n $APP/.MainActivity >/dev/null 2>&1
  $A shell am start-foreground-service -n $APP/.service.PanForegroundService >/dev/null 2>&1
  # The service always starts muted. Once it is up, the microphone goes on: the car is used by voice.
  sleep 20
  $A shell am start-foreground-service -n $APP/.service.PanForegroundService -a TOGGLE_MIC --ez on true >/dev/null 2>&1
  say "started $want, microphone on"
  echo "DONE $want"
}

# One at a time: a loop's check and one asked for by hand do not install over each other.
locked() {
  if mkdir "$W/lock" 2>/dev/null; then echo $$ > "$W/lock/pid"; return 0; fi
  kill -0 "$(cat "$W/lock/pid" 2>/dev/null)" 2>/dev/null && return 1
  rm -rf "$W/lock"; mkdir "$W/lock" 2>/dev/null && echo $$ > "$W/lock/pid"
}

if [ "$1" = loop ]; then
  PIDF=$W/loop.pid
  if [ -f "$PIDF" ] && kill -0 "$(cat "$PIDF")" 2>/dev/null; then echo "ALREADY_LOOPING"; exit 0; fi
  echo $$ > "$PIDF"
  say "loop started"
  while :; do
    if locked; then once > "$W/last" 2>&1; rm -rf "$W/lock"; fi
    sleep 120
  done
fi

locked || { echo BUSY; exit 1; }
once "$1"; r=$?
rm -rf "$W/lock"
exit $r
