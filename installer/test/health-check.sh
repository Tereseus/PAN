#!/usr/bin/env bash
# PAN Installer Test — Health Check
# Starts PAN server in background, waits for health endpoint, reports pass/fail.
set -euo pipefail

export PATH="$HOME/.local/share/pan/node/bin:$HOME/.local/bin:$PATH"
export PAN_DATA_DIR="$HOME/.local/share/pan/data"

echo "=== Starting PAN server ==="
cd "$HOME/.local/share/pan/service"
node pan.js start &
PAN_PID=$!

echo "  PID: $PAN_PID"
echo "  Waiting for health endpoint..."

HEALTHY=false
for i in $(seq 1 30); do
    if curl -sf http://127.0.0.1:7777/health >/dev/null 2>&1; then
        HEALTHY=true
        break
    fi
    sleep 1
done

if [ "$HEALTHY" = true ]; then
    echo ""
    echo "  ╔══════════════════════════════════════╗"
    echo "  ║   ✓ PAN HEALTH CHECK PASSED          ║"
    echo "  ╚══════════════════════════════════════╝"
    echo ""

    # Grab some data
    echo "  Health response:"
    curl -s http://127.0.0.1:7777/health | head -c 500
    echo ""

    # Test API endpoints
    echo ""
    echo "  Testing API endpoints..."
    for endpoint in "/api/v1/intuition/current" "/api/v1/terminal/sessions" "/health"; do
        STATUS=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:7777$endpoint" 2>/dev/null || echo "000")
        if [ "$STATUS" = "200" ]; then
            echo "    ✓ $endpoint → $STATUS"
        else
            echo "    ✗ $endpoint → $STATUS"
        fi
    done

    echo ""
    echo "  Shutting down..."
    kill $PAN_PID 2>/dev/null || true
    wait $PAN_PID 2>/dev/null || true
    exit 0
else
    echo ""
    echo "  ╔══════════════════════════════════════╗"
    echo "  ║   ✗ PAN HEALTH CHECK FAILED          ║"
    echo "  ╚══════════════════════════════════════╝"
    echo ""
    echo "  Server did not respond within 30 seconds."
    echo "  Last log output:"
    # Check if there's any output
    kill $PAN_PID 2>/dev/null || true
    wait $PAN_PID 2>/dev/null || true
    exit 1
fi
