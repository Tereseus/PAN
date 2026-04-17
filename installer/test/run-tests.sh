#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
# PAN Installer Test Runner
# Builds and runs Docker containers for each target platform.
# Verifies the installer works from zero on each.
#
# Usage:
#   ./run-tests.sh              # Run all tests
#   ./run-tests.sh ubuntu       # Run just Ubuntu
#   ./run-tests.sh alpine       # Run just Alpine
# ═══════════════════════════════════════════════════════════════════════════
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PAN_ROOT="$(dirname "$(dirname "$SCRIPT_DIR")")"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BOLD='\033[1m'; NC='\033[0m'

TARGETS="${1:-ubuntu alpine}"
PASSED=0
FAILED=0
RESULTS=()

for target in $TARGETS; do
    DOCKERFILE="$SCRIPT_DIR/Dockerfile.$target"
    if [ ! -f "$DOCKERFILE" ]; then
        echo -e "${YELLOW}⚠ No Dockerfile for '$target' — skipping${NC}"
        continue
    fi

    IMAGE="pan-test-$target"
    echo ""
    echo -e "${BOLD}═══════════════════════════════════════════════════════════${NC}"
    echo -e "${BOLD}  Testing: $target${NC}"
    echo -e "${BOLD}═══════════════════════════════════════════════════════════${NC}"

    # Build
    echo -e "${YELLOW}Building image...${NC}"
    if docker build -f "$DOCKERFILE" -t "$IMAGE" "$PAN_ROOT" 2>&1; then
        echo -e "${GREEN}  ✓ Build passed${NC}"
    else
        echo -e "${RED}  ✗ Build FAILED${NC}"
        FAILED=$((FAILED + 1))
        RESULTS+=("$target: ✗ BUILD FAILED")
        continue
    fi

    # Run health check
    echo -e "${YELLOW}Running health check...${NC}"
    if docker run --rm "$IMAGE" 2>&1; then
        echo -e "${GREEN}  ✓ Health check passed${NC}"
        PASSED=$((PASSED + 1))
        RESULTS+=("$target: ✓ PASSED")
    else
        echo -e "${RED}  ✗ Health check FAILED${NC}"
        FAILED=$((FAILED + 1))
        RESULTS+=("$target: ✗ HEALTH CHECK FAILED")
    fi
done

# Summary
echo ""
echo -e "${BOLD}═══════════════════════════════════════════════════════════${NC}"
echo -e "${BOLD}  Test Summary${NC}"
echo -e "${BOLD}═══════════════════════════════════════════════════════════${NC}"
for r in "${RESULTS[@]}"; do
    echo "  $r"
done
echo ""
echo "  Passed: $PASSED  Failed: $FAILED"
echo ""

if [ "$FAILED" -gt 0 ]; then
    echo -e "${RED}${BOLD}  SOME TESTS FAILED${NC}"
    exit 1
else
    echo -e "${GREEN}${BOLD}  ALL TESTS PASSED${NC}"
    exit 0
fi
