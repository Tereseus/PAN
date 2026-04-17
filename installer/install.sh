#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────
# PAN Installer — Linux / macOS
# One command: curl -sSL https://pan.dev/install | bash
# Zero prerequisites. Downloads and installs everything.
# ──────────────────────────────────────────────────────────────────────────

set -euo pipefail

# ─── Constants ───────────────────────────────────────────────────────────
NODE_VERSION="22.16.0"
PAN_PORT=7777
SERVICE_NAME="pan"

# ─── Paths ───────────────────────────────────────────────────────────────
INSTALL_DIR="${PAN_INSTALL_DIR:-$HOME/.local/share/pan}"
DATA_DIR="$INSTALL_DIR/data"
NODE_DIR="$INSTALL_DIR/node"
SERVER_DIR="$INSTALL_DIR/service"
LOG_FILE="$INSTALL_DIR/install.log"

# ─── Detect platform ────────────────────────────────────────────────────
OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"

case "$ARCH" in
    x86_64)  NODE_ARCH="x64" ;;
    aarch64) NODE_ARCH="arm64" ;;
    arm64)   NODE_ARCH="arm64" ;;
    *)       echo "  ERROR: Unsupported architecture: $ARCH"; exit 1 ;;
esac

case "$OS" in
    linux)  NODE_PLATFORM="linux" ;;
    darwin) NODE_PLATFORM="darwin" ;;
    *)      echo "  ERROR: Unsupported OS: $OS"; exit 1 ;;
esac

NODE_URL="https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-${NODE_PLATFORM}-${NODE_ARCH}.tar.xz"

# ─── Helpers ─────────────────────────────────────────────────────────────
log() {
    local ts
    ts="$(date '+%Y-%m-%d %H:%M:%S')"
    echo -e "  \033[36m[$ts]\033[0m $1"
    echo "[$ts] $1" >> "$LOG_FILE" 2>/dev/null || true
}

fail() {
    echo -e "\n  \033[31mERROR: $1\033[0m\n"
    exit 1
}

ensure_dir() {
    [ -d "$1" ] || mkdir -p "$1"
}

has() {
    command -v "$1" &>/dev/null
}

# ─── Banner ──────────────────────────────────────────────────────────────
echo ""
echo -e "  \033[35m╔══════════════════════════════════════╗\033[0m"
echo -e "  \033[35m║        PAN — Personal AI Network     ║\033[0m"
echo -e "  \033[35m║           Installing...               ║\033[0m"
echo -e "  \033[35m╚══════════════════════════════════════╝\033[0m"
echo ""

ensure_dir "$INSTALL_DIR"
ensure_dir "$DATA_DIR"

# ─── Step 1: Portable Node.js ───────────────────────────────────────────
log "Step 1/6: Setting up Node.js runtime..."

if [ -x "$NODE_DIR/bin/node" ]; then
    NODE_VER="$("$NODE_DIR/bin/node" --version 2>/dev/null || echo unknown)"
    log "Node.js already installed: $NODE_VER"
else
    ensure_dir "$NODE_DIR"
    TMP_TAR="$(mktemp /tmp/node-XXXXXX.tar.xz)"

    log "Downloading Node.js v${NODE_VERSION} for ${NODE_PLATFORM}-${NODE_ARCH}..."
    if has curl; then
        curl -sSL "$NODE_URL" -o "$TMP_TAR"
    elif has wget; then
        wget -qO "$TMP_TAR" "$NODE_URL"
    else
        fail "Neither curl nor wget found. Install one and retry."
    fi

    log "Extracting Node.js..."
    tar -xJf "$TMP_TAR" -C "$NODE_DIR" --strip-components=1
    rm -f "$TMP_TAR"

    NODE_VER="$("$NODE_DIR/bin/node" --version)"
    log "Node.js $NODE_VER installed to $NODE_DIR"
fi

export PATH="$NODE_DIR/bin:$PATH"

# ─── Step 2: PAN Server ─────────────────────────────────────────────────
log "Step 2/6: Installing PAN server..."

# LOCAL DEV MODE: Copy from the repo this installer lives in.
# Production: download release tarball from releases.pan.dev
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
REPO_SERVICE="$REPO_ROOT/service"

if [ -d "$REPO_SERVICE" ]; then
    log "Copying server from local repo: $REPO_SERVICE"

    if has rsync; then
        rsync -a --delete \
            --exclude node_modules \
            --exclude .git \
            --exclude target \
            --exclude tmp \
            --exclude '*.log' \
            --exclude '*.bak' \
            "$REPO_SERVICE/" "$SERVER_DIR/"
    else
        # Fallback: cp (less efficient but works everywhere)
        rm -rf "$SERVER_DIR"
        cp -r "$REPO_SERVICE" "$SERVER_DIR"
        rm -rf "$SERVER_DIR/node_modules" "$SERVER_DIR/.git" "$SERVER_DIR/target" "$SERVER_DIR/tmp"
    fi
    log "Server files copied."
else
    # Production path: download release
    # PAN_RELEASE_URL="https://releases.pan.dev/stable/pan-server-latest.tar.gz"
    # log "Downloading PAN server..."
    # curl -sSL "$PAN_RELEASE_URL" | tar -xzf - -C "$INSTALL_DIR"
    fail "Cannot find PAN server source. Expected at: $REPO_SERVICE"
fi

# ─── Step 3: Install Node dependencies ──────────────────────────────────
log "Step 3/6: Installing dependencies (this may take 2-3 minutes)..."

cd "$SERVER_DIR"

# Check for build tools (needed for native modules like better-sqlite3)
if ! has gcc && ! has cc; then
    log "WARNING: No C compiler found. Installing build-essential..."
    if has apt-get; then
        sudo apt-get update -qq && sudo apt-get install -y -qq build-essential python3 2>/dev/null || \
            log "WARNING: Could not install build tools — native modules may fail."
    elif has dnf; then
        sudo dnf install -y gcc gcc-c++ make python3 2>/dev/null || true
    elif has pacman; then
        sudo pacman -S --noconfirm base-devel python 2>/dev/null || true
    fi
fi

"$NODE_DIR/bin/npm" install --production --no-optional 2>&1 | tail -5
log "Dependencies installed."

# Build dashboard if source exists
if [ -f "$SERVER_DIR/dashboard/package.json" ]; then
    log "Building dashboard..."
    cd "$SERVER_DIR/dashboard"
    "$NODE_DIR/bin/npm" install 2>/dev/null || true
    "$NODE_DIR/bin/npm" run build 2>/dev/null || log "Dashboard build failed (non-fatal)"
    log "Dashboard built."
fi

# ─── Step 4: Data directory + encryption keys ───────────────────────────
log "Step 4/6: Setting up data directory..."

ensure_dir "$DATA_DIR"
ensure_dir "$DATA_DIR/backups"
ensure_dir "$DATA_DIR/recordings"
ensure_dir "$DATA_DIR/terminal-logs"
ensure_dir "$DATA_DIR/transcripts"

# Generate encryption key if not exists
KEY_FILE="$DATA_DIR/pan.key"
if [ ! -f "$KEY_FILE" ]; then
    if has openssl; then
        openssl rand -hex 32 > "$KEY_FILE"
    elif [ -r /dev/urandom ]; then
        head -c 32 /dev/urandom | xxd -p -c 64 > "$KEY_FILE" 2>/dev/null || \
            od -An -tx1 -N32 /dev/urandom | tr -d ' \n' > "$KEY_FILE"
    elif has python3; then
        python3 -c "import secrets; print(secrets.token_hex(32))" > "$KEY_FILE"
    else
        fail "Cannot generate encryption key — no openssl, /dev/urandom, or python3"
    fi
    chmod 600 "$KEY_FILE"
    log "Database encryption key generated."
else
    log "Encryption key already exists."
fi

# Generate audit key
AUDIT_KEY="$DATA_DIR/audit.key"
if [ ! -f "$AUDIT_KEY" ]; then
    if has openssl; then
        openssl rand -hex 32 > "$AUDIT_KEY"
    else
        head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' > "$AUDIT_KEY"
    fi
    chmod 600 "$AUDIT_KEY"
    log "Audit key generated."
fi

# ─── Step 5: System service + launcher ───────────────────────────────────
log "Step 5/6: Setting up PAN service..."

# Create launcher script
cat > "$INSTALL_DIR/pan" << LAUNCHER
#!/usr/bin/env bash
# PAN Launcher
export PATH="$NODE_DIR/bin:\$PATH"
export PAN_SERVICE=1

# Check if already running
if curl -s "http://127.0.0.1:$PAN_PORT/health" >/dev/null 2>&1; then
    echo "PAN is already running on port $PAN_PORT."
    echo "Dashboard: http://127.0.0.1:$PAN_PORT"
    exit 0
fi

cd "$SERVER_DIR"
exec "$NODE_DIR/bin/node" pan.js start
LAUNCHER
chmod +x "$INSTALL_DIR/pan"

# Symlink to user's bin
if [ -w /usr/local/bin ]; then
    ln -sf "$INSTALL_DIR/pan" /usr/local/bin/pan
    log "Created /usr/local/bin/pan symlink."
else
    ensure_dir "$HOME/.local/bin"
    ln -sf "$INSTALL_DIR/pan" "$HOME/.local/bin/pan"
    log "Created ~/.local/bin/pan symlink."
    # Ensure ~/.local/bin is in PATH
    if ! echo "$PATH" | grep -q "$HOME/.local/bin"; then
        for rc in "$HOME/.bashrc" "$HOME/.zshrc" "$HOME/.profile"; do
            if [ -f "$rc" ]; then
                echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$rc"
                break
            fi
        done
    fi
fi

# ─── Systemd service (Linux) ────────────────────────────────────────────
if [ "$OS" = "linux" ] && has systemctl; then
    SYSTEMD_USER_DIR="$HOME/.config/systemd/user"
    ensure_dir "$SYSTEMD_USER_DIR"

    cat > "$SYSTEMD_USER_DIR/pan.service" << UNIT
[Unit]
Description=PAN — Personal AI Network
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=$INSTALL_DIR/pan
Restart=always
RestartSec=5
Environment=PATH=$NODE_DIR/bin:/usr/local/bin:/usr/bin:/bin
Environment=HOME=$HOME
Environment=XDG_DATA_HOME=${XDG_DATA_HOME:-$HOME/.local/share}
WorkingDirectory=$SERVER_DIR

[Install]
WantedBy=default.target
UNIT

    systemctl --user daemon-reload 2>/dev/null || true
    systemctl --user enable pan.service 2>/dev/null || true
    systemctl --user start pan.service 2>/dev/null || true
    log "Systemd user service installed and started."

    # Enable lingering so PAN runs even when not logged in
    if has loginctl; then
        loginctl enable-linger "$(whoami)" 2>/dev/null || true
    fi
fi

# ─── launchd plist (macOS) ───────────────────────────────────────────────
if [ "$OS" = "darwin" ]; then
    PLIST_DIR="$HOME/Library/LaunchAgents"
    ensure_dir "$PLIST_DIR"

    cat > "$PLIST_DIR/dev.pan.server.plist" << 'PLIST_END'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>dev.pan.server</string>
    <key>ProgramArguments</key><array><string>INSTALL_DIR_PLACEHOLDER/pan</string></array>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>StandardOutPath</key><string>DATA_DIR_PLACEHOLDER/pan-stdout.log</string>
    <key>StandardErrorPath</key><string>DATA_DIR_PLACEHOLDER/pan-stderr.log</string>
    <key>WorkingDirectory</key><string>SERVER_DIR_PLACEHOLDER</string>
</dict>
</plist>
PLIST_END

    # Replace placeholders (heredoc with single quotes prevents expansion)
    sed -i.bak "s|INSTALL_DIR_PLACEHOLDER|$INSTALL_DIR|g; s|DATA_DIR_PLACEHOLDER|$DATA_DIR|g; s|SERVER_DIR_PLACEHOLDER|$SERVER_DIR|g" \
        "$PLIST_DIR/dev.pan.server.plist"
    rm -f "$PLIST_DIR/dev.pan.server.plist.bak"

    launchctl load "$PLIST_DIR/dev.pan.server.plist" 2>/dev/null || true
    log "launchd service installed and started."
fi

# ─── Desktop shortcut (Linux XDG) ───────────────────────────────────────
if [ "$OS" = "linux" ]; then
    APPS_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
    ensure_dir "$APPS_DIR"

    cat > "$APPS_DIR/pan.desktop" << DESKTOP
[Desktop Entry]
Version=1.0
Type=Application
Name=PAN
Comment=Personal AI Network
Exec=$INSTALL_DIR/pan
Icon=$SERVER_DIR/tauri/src-tauri/icons/icon.png
Terminal=false
Categories=Utility;
StartupNotify=true
DESKTOP

    if [ -d "$HOME/Desktop" ]; then
        cp "$APPS_DIR/pan.desktop" "$HOME/Desktop/pan.desktop"
        chmod +x "$HOME/Desktop/pan.desktop" 2>/dev/null || true
    fi
    log "Desktop shortcut created."
fi

# ─── Step 6: Verify ─────────────────────────────────────────────────────
log "Step 6/6: Verifying PAN is running..."

READY=false
for i in $(seq 1 30); do
    if curl -s "http://127.0.0.1:$PAN_PORT/health" >/dev/null 2>&1; then
        READY=true
        break
    fi
    [ $((i % 5)) -eq 0 ] && [ "$i" -gt 0 ] && log "Waiting for PAN to start... ($i/30)"
    sleep 1
done

if $READY; then
    log "PAN is running!"

    # Open browser
    if has xdg-open; then
        xdg-open "http://127.0.0.1:$PAN_PORT/setup" 2>/dev/null &
    elif has open; then
        open "http://127.0.0.1:$PAN_PORT/setup" 2>/dev/null &
    fi

    echo ""
    echo -e "  \033[32m╔══════════════════════════════════════╗\033[0m"
    echo -e "  \033[32m║       PAN installed successfully!    ║\033[0m"
    echo -e "  \033[32m║                                      ║\033[0m"
    echo -e "  \033[32m║  Dashboard: http://127.0.0.1:$PAN_PORT  ║\033[0m"
    echo -e "  \033[32m║  PAN starts automatically on boot.   ║\033[0m"
    echo -e "  \033[32m╚══════════════════════════════════════╝\033[0m"
    echo ""
    echo "  Run 'pan' from any terminal to check status."
    echo "  Config: $DATA_DIR"
    echo "  Logs:   $LOG_FILE"
    echo ""
else
    echo ""
    echo -e "  \033[33mPAN installed but server didn't respond in 30s.\033[0m"
    echo -e "  \033[33mTry running: $INSTALL_DIR/pan\033[0m"
    echo -e "  \033[33mLogs: $LOG_FILE\033[0m"
    echo ""
fi
