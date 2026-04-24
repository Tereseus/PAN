#!/bin/bash
# PAN Metrics Agent — Linux
# Collects CPU, RAM, Disk and POSTs to PAN hub every 30s.
#
# Install as systemd service (run once):
#   sudo bash pan-metrics-agent.sh --install
#
# Or run manually:
#   bash pan-metrics-agent.sh

PAN_URL="http://100.x.x.x:7777"   # ← your PAN hub's Tailscale IP
DEVICE_ID="$(hostname)"
INTERVAL=30

if [[ "$1" == "--install" ]]; then
    SCRIPT_PATH="$(realpath "$0")"
    SERVICE_FILE="/etc/systemd/system/pan-metrics.service"
    cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=PAN Metrics Agent
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/bin/bash $SCRIPT_PATH
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF
    systemctl daemon-reload
    systemctl enable pan-metrics
    systemctl start pan-metrics
    echo "Installed and started pan-metrics systemd service."
    echo "Check status: systemctl status pan-metrics"
    exit 0
fi

echo "PAN Metrics Agent starting — reporting to $PAN_URL every ${INTERVAL}s as $DEVICE_ID"

# Baseline for CPU delta (uses /proc/stat)
read_cpu_total() {
    awk '/^cpu /{idle=$5+$6; total=0; for(i=2;i<=NF;i++) total+=$i; print total, idle}' /proc/stat
}
prev_cpu=$(read_cpu_total)

# Baseline for network delta
read_net() {
    awk '/^\s*(eth|ens|enp|wlan|wlp)[^:]+:/{gsub(/:/,"",$1); print $1,$2,$10}' /proc/net/dev 2>/dev/null | head -1
}
prev_net=$(read_net)

while true; do
    # ── CPU (delta between samples) ─────────────────────────────────────────
    cur_cpu=$(read_cpu_total)
    cpu_total_prev=$(echo $prev_cpu | awk '{print $1}')
    cpu_idle_prev=$(echo $prev_cpu | awk '{print $2}')
    cpu_total_cur=$(echo $cur_cpu | awk '{print $1}')
    cpu_idle_cur=$(echo $cur_cpu | awk '{print $2}')
    dtotal=$((cpu_total_cur - cpu_total_prev))
    didle=$((cpu_idle_cur - cpu_idle_prev))
    cpu_pct=0
    if [ $dtotal -gt 0 ]; then
        cpu_pct=$(echo "scale=1; (1 - $didle / $dtotal) * 100" | bc 2>/dev/null || echo 0)
    fi
    prev_cpu="$cur_cpu"

    # ── RAM ─────────────────────────────────────────────────────────────────
    ram_info=$(awk '/MemTotal|MemAvailable/{print $2}' /proc/meminfo)
    ram_total_kb=$(echo "$ram_info" | head -1)
    ram_avail_kb=$(echo "$ram_info" | tail -1)
    ram_used_kb=$((ram_total_kb - ram_avail_kb))
    ram_total_mb=$((ram_total_kb / 1024))
    ram_used_mb=$((ram_used_kb / 1024))
    ram_pct=$(echo "scale=1; $ram_used_kb * 100 / $ram_total_kb" | bc 2>/dev/null || echo 0)

    # ── Disk (root partition) ────────────────────────────────────────────────
    disk_info=$(df / 2>/dev/null | tail -1)
    disk_pct=$(echo "$disk_info" | awk '{gsub(/%/,"",$5); print $5}')
    disk_free_gb=$(echo "$disk_info" | awk '{printf "%.1f", $4/1024/1024}')

    # ── Network (delta kbps) ────────────────────────────────────────────────
    cur_net=$(read_net)
    net_up_kbps=null; net_down_kbps=null
    if [[ -n "$prev_net" && -n "$cur_net" ]]; then
        prev_rx=$(echo $prev_net | awk '{print $2}')
        prev_tx=$(echo $prev_net | awk '{print $3}')
        cur_rx=$(echo $cur_net | awk '{print $2}')
        cur_tx=$(echo $cur_net | awk '{print $3}')
        net_down_kbps=$(echo "scale=1; ($cur_rx - $prev_rx) / $INTERVAL / 128" | bc 2>/dev/null || echo 0)
        net_up_kbps=$(echo "scale=1; ($cur_tx - $prev_tx) / $INTERVAL / 128" | bc 2>/dev/null || echo 0)
        # Clamp negatives to 0
        net_down_kbps=$(echo "$net_down_kbps" | awk '{if($1<0)print 0; else print $1}')
        net_up_kbps=$(echo "$net_up_kbps" | awk '{if($1<0)print 0; else print $1}')
    fi
    prev_net="$cur_net"

    # ── POST ────────────────────────────────────────────────────────────────
    payload=$(cat <<JSON
{
  "device_id":     "$DEVICE_ID",
  "platform":      "linux",
  "cpu_pct":       $cpu_pct,
  "ram_pct":       $ram_pct,
  "ram_used_mb":   $ram_used_mb,
  "ram_total_mb":  $ram_total_mb,
  "disk_pct":      $disk_pct,
  "disk_free_gb":  $disk_free_gb,
  "net_up_kbps":   $net_up_kbps,
  "net_down_kbps": $net_down_kbps
}
JSON
)

    if curl -sf -X POST "$PAN_URL/api/v1/client/metrics" \
         -H "Content-Type: application/json" \
         -d "$payload" \
         --max-time 8 > /dev/null 2>&1; then
        echo "$(date '+%H:%M:%S') CPU:${cpu_pct}% RAM:${ram_pct}% (${ram_used_mb}/${ram_total_mb}MB) Disk:${disk_pct}% ✓"
    else
        echo "$(date '+%H:%M:%S') POST failed — will retry in ${INTERVAL}s"
    fi

    sleep $INTERVAL
done
