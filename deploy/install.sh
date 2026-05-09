#!/usr/bin/env bash
set -euo pipefail

REPO="Younkyum/Loci-Terminal"
INSTALL_DIR="/usr/local/bin"
PORT="${GHOSTTERM_PORT:-8080}"
OS="$(uname -s)"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}[INFO]${NC} $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }

check_deps() {
    for cmd in tmux git; do
        if ! command -v "$cmd" &>/dev/null; then
            error "$cmd is required but not installed."
        fi
    done
    if ! command -v go &>/dev/null; then
        error "Go is required to build from source. Install Go 1.22+ first."
    fi
    if ! command -v node &>/dev/null; then
        error "Node.js is required to build from source. Install Node.js 20+ first."
    fi
    info "Dependencies OK (go, node, tmux, git)"
}

build_from_source() {
    info "Building from source..."

    local tmpdir
    tmpdir=$(mktemp -d)
    trap "rm -rf $tmpdir" EXIT

    info "Cloning repository..."
    git clone --depth 1 "https://github.com/${REPO}.git" "$tmpdir/loci-terminal"
    cd "$tmpdir/loci-terminal"

    info "Building frontend..."
    cd frontend && npm ci && npm run build && cd ..

    info "Building Go binary..."
    mkdir -p cmd/ghostterm/frontend
    cp -r frontend/dist cmd/ghostterm/frontend/dist
    CGO_ENABLED=0 go build -ldflags="-s -w" -o ghostterm ./cmd/ghostterm

    info "Installing binary to ${INSTALL_DIR}..."
    if [[ "$OS" == "Darwin" ]]; then
        sudo install -m 755 ghostterm "${INSTALL_DIR}/ghostterm"
    else
        install -m 755 ghostterm "${INSTALL_DIR}/ghostterm"
    fi
}

# ── Linux (systemd) ──────────────────────────────────────────────

setup_systemd() {
    local user="$1"
    local data_dir="/var/lib/ghostterm"
    local service_file="/etc/systemd/system/ghostterm@.service"

    info "Setting up systemd service for user: ${user}"

    mkdir -p "$data_dir"
    chown "$user:$user" "$data_dir"

    cat > "$service_file" << UNIT
[Unit]
Description=Loci Terminal - Web-based Multi-Terminal Server
After=network.target

[Service]
Type=simple
User=%i
ExecStart=/usr/local/bin/ghostterm --port ${PORT} --data-dir /var/lib/ghostterm
Restart=on-failure
RestartSec=5
Environment=LANG=en_US.UTF-8

[Install]
WantedBy=multi-user.target
UNIT

    systemctl daemon-reload
    systemctl enable "ghostterm@${user}"
    systemctl start "ghostterm@${user}"

    info "Service started: ghostterm@${user}"
}

# ── macOS (launchd) ──────────────────────────────────────────────

setup_launchd() {
    local user="$1"
    local data_dir="${HOME}/.local/share/ghostterm"
    local plist_dir="${HOME}/Library/LaunchAgents"
    local plist_file="${plist_dir}/com.loci-terminal.ghostterm.plist"
    local log_dir="${HOME}/Library/Logs/ghostterm"

    info "Setting up launchd service for user: ${user}"

    mkdir -p "$data_dir" "$plist_dir" "$log_dir"

    cat > "$plist_file" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.loci-terminal.ghostterm</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/ghostterm</string>
        <string>--port</string>
        <string>${PORT}</string>
        <string>--data-dir</string>
        <string>${data_dir}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${log_dir}/stdout.log</string>
    <key>StandardErrorPath</key>
    <string>${log_dir}/stderr.log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>LANG</key>
        <string>en_US.UTF-8</string>
    </dict>
</dict>
</plist>
PLIST

    launchctl unload "$plist_file" 2>/dev/null || true
    launchctl load -w "$plist_file"

    info "Service started via launchd"
    info "Logs: ${log_dir}/"
}

# ── Uninstall helpers ────────────────────────────────────────────

print_uninstall_info() {
    echo ""
    if [[ "$OS" == "Darwin" ]]; then
        info "To uninstall:"
        info "  launchctl unload ~/Library/LaunchAgents/com.loci-terminal.ghostterm.plist"
        info "  rm ~/Library/LaunchAgents/com.loci-terminal.ghostterm.plist"
        info "  sudo rm /usr/local/bin/ghostterm"
    else
        info "To uninstall: sudo bash deploy/uninstall.sh"
    fi
}

# ── macOS permissions check ───────────────────────────────────────

check_macos_permissions() {
    if [[ "$OS" != "Darwin" ]]; then return; fi

    local test_dir="${HOME}/Documents"
    if [[ -d "$test_dir" ]] && ! ls "$test_dir" &>/dev/null; then
        echo ""
        warn "========================================="
        warn " Full Disk Access required on macOS"
        warn "========================================="
        warn ""
        warn " Loci Terminal needs Full Disk Access to"
        warn " access ~/Documents, ~/Desktop, etc."
        warn ""
        warn " 1. System Settings will open automatically"
        warn " 2. Click '+' and add 'ghostterm'"
        warn "    (located at /usr/local/bin/ghostterm)"
        warn " 3. Restart the service"
        warn ""
        info "Opening System Settings..."
        open "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles" 2>/dev/null || true
    else
        info "File access permissions OK"
    fi
}

# ── Main ─────────────────────────────────────────────────────────

print_usage() {
    echo ""
    echo "Usage:"
    echo "  sudo bash install.sh [OPTIONS]       # Linux"
    echo "  bash install.sh [OPTIONS]             # macOS"
    echo ""
    echo "Options:"
    echo "  --user USER    System user to run as (default: current user)"
    echo "  --port PORT    Server port (default: 8080)"
    echo "  --help         Show this help"
    echo ""
}

main() {
    local user="${SUDO_USER:-$(whoami)}"

    while [[ $# -gt 0 ]]; do
        case "$1" in
            --user)  user="$2"; shift 2 ;;
            --port)  PORT="$2"; shift 2 ;;
            --help)  print_usage; exit 0 ;;
            *)       error "Unknown option: $1" ;;
        esac
    done

    echo ""
    echo "  ╔═══════════════════════════════════╗"
    echo "  ║     Loci Terminal Installer       ║"
    echo "  ╚═══════════════════════════════════╝"
    echo ""

    info "OS: ${OS}"
    info "User: ${user}"
    info "Port: ${PORT}"
    echo ""

    if [[ "$OS" == "Linux" && $EUID -ne 0 ]]; then
        error "On Linux, run as root: sudo bash install.sh"
    fi

    check_deps
    build_from_source

    case "$OS" in
        Linux)
            setup_systemd "$user"
            ;;
        Darwin)
            setup_launchd "$user"
            ;;
        *)
            warn "Unknown OS: ${OS}. Binary installed but no service configured."
            warn "Run manually: ghostterm --port ${PORT}"
            ;;
    esac

    echo ""
    info "========================================="
    info " Installation complete!"
    info " Open http://localhost:${PORT}"
    info "========================================="

    if [[ "$OS" == "Darwin" ]]; then
        check_macos_permissions
        echo ""
        info "Management:"
        info "  launchctl list | grep ghostterm     # check status"
        info "  launchctl stop com.loci-terminal.ghostterm   # stop"
        info "  launchctl start com.loci-terminal.ghostterm  # start"
        info "  tail -f ~/Library/Logs/ghostterm/stdout.log  # logs"
    else
        echo ""
        info "Management:"
        info "  systemctl status ghostterm@${user}"
        info "  systemctl restart ghostterm@${user}"
        info "  journalctl -u ghostterm@${user} -f"
    fi

    print_uninstall_info
}

main "$@"
