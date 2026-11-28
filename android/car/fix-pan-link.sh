#!/data/data/com.termux/files/usr/bin/bash
# The app part of the unit's Fix PAN button (task 1100, Nov 28). Fix PAN fixed Termux's own
# Tailscale and Rethink, never the app's link: on Nov 27 the app's Tailscale was dead after a
# sleep and only this, done by hand, brought it back within seconds. The existing
# ~/.shortcuts/Fix PAN runs it as its last line:
#   bash ~/fix-pan-link.sh
# It restarts the app and turns its listening back on, as pan-update.sh does after an install.
export ADB_LIBUSB=0
APP=dev.pan.app
A="adb -s 127.0.0.1:7088"
adb connect 127.0.0.1:7088 >/dev/null 2>&1
echo "Restarting the PAN app..."
$A shell am force-stop $APP
sleep 1
$A shell am start-foreground-service -n $APP/.service.PanForegroundService >/dev/null 2>&1
# The link and Tailscale come up first; listening goes back on after that, as by hand on Nov 27.
sleep 25
$A shell am start-foreground-service -n $APP/.service.PanForegroundService -a TOGGLE_MIC --ez on true >/dev/null 2>&1
echo "PAN restarted and listening."
