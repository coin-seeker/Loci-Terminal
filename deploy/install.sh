#!/usr/bin/env bash
set -euo pipefail

REPO="${LOCITERM_REPO:-Younkyum/Loci-Terminal}"
INSTALL_DIR="/usr/local/bin"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
PORT="${LOCITERM_PORT:-8080}"
HOST="${LOCITERM_HOST:-127.0.0.1}"
DATA_DIR="${LOCITERM_DATA_DIR:-}"
OS="$(uname -s)"
BUILD_TMPDIR=""

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
        error "Go is required to build from source. Install Go matching go.mod (1.26+) first."
    fi
    if ! command -v node &>/dev/null; then
        error "Node.js is required to build from source. Install Node.js 20+ first."
    fi
    if ! command -v npm &>/dev/null; then
        error "npm is required to build the frontend. Install Node.js 20+ with npm first."
    fi
    info "Dependencies OK (go, node, npm, tmux, git)"
}

cleanup() {
    if [[ -n "$BUILD_TMPDIR" ]]; then
        rm -rf "$BUILD_TMPDIR"
    fi
}

is_repo_checkout() {
    [[ -f "${REPO_ROOT}/go.mod" && -d "${REPO_ROOT}/frontend" && -d "${REPO_ROOT}/cmd/lociterm" ]]
}

default_data_dir() {
    case "$OS" in
        Linux)  echo "/var/lib/lociterm" ;;
        Darwin) echo "${HOME}/.local/share/lociterm" ;;
        *)      echo "./data" ;;
    esac
}

build_from_source() {
    info "Building from source..."

    local src_dir
    if is_repo_checkout; then
        src_dir="$REPO_ROOT"
        info "Using local checkout: ${src_dir}"
    else
        BUILD_TMPDIR=$(mktemp -d)
        trap cleanup EXIT

        info "Cloning repository..."
        git clone --depth 1 "https://github.com/${REPO}.git" "$BUILD_TMPDIR/loci-terminal"
        src_dir="$BUILD_TMPDIR/loci-terminal"
    fi
    cd "$src_dir"

    info "Building frontend..."
    cd frontend && npm ci && npm run build && cd ..

    info "Building Go binary..."
    mkdir -p cmd/lociterm/frontend
    rm -rf cmd/lociterm/frontend/dist
    cp -r frontend/dist cmd/lociterm/frontend/dist
    CGO_ENABLED=0 go build -ldflags="-s -w" -o lociterm ./cmd/lociterm

    info "Installing binary to ${INSTALL_DIR}..."
    if [[ "$OS" == "Darwin" ]]; then
        sudo install -m 755 lociterm "${INSTALL_DIR}/lociterm"
    else
        install -m 755 lociterm "${INSTALL_DIR}/lociterm"
    fi
}

# ── Linux (systemd) ──────────────────────────────────────────────

setup_systemd() {
    local user="$1"
    local service_file="/etc/systemd/system/lociterm@.service"

    info "Setting up systemd service for user: ${user}"

    mkdir -p "$DATA_DIR"
    chown "$user:$user" "$DATA_DIR"

    cat > "$service_file" << UNIT
[Unit]
Description=Loci Terminal - Web-based Multi-Terminal Server
After=network.target

[Service]
Type=simple
User=%i
ExecStart=/usr/local/bin/lociterm --host ${HOST} --port ${PORT} --data-dir ${DATA_DIR}
Restart=on-failure
RestartSec=5
Environment=LANG=en_US.UTF-8

[Install]
WantedBy=multi-user.target
UNIT

    systemctl daemon-reload
    systemctl enable "lociterm@${user}"
    systemctl start "lociterm@${user}"

    info "Service started: lociterm@${user}"
}

# ── macOS (launchd) ──────────────────────────────────────────────

setup_launchd() {
    local user="$1"
    local plist_dir="${HOME}/Library/LaunchAgents"
    local plist_file="${plist_dir}/com.loci-terminal.lociterm.plist"
    local log_dir="${HOME}/Library/Logs/lociterm"

    info "Setting up launchd service for user: ${user}"

    mkdir -p "$DATA_DIR" "$plist_dir" "$log_dir"

    cat > "$plist_file" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.loci-terminal.lociterm</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/lociterm</string>
        <string>--host</string>
        <string>${HOST}</string>
        <string>--port</string>
        <string>${PORT}</string>
        <string>--data-dir</string>
        <string>${DATA_DIR}</string>
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
        info "  launchctl unload ~/Library/LaunchAgents/com.loci-terminal.lociterm.plist"
        info "  rm ~/Library/LaunchAgents/com.loci-terminal.lociterm.plist"
        info "  sudo rm /usr/local/bin/lociterm"
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
        warn " 2. Click '+' and add 'lociterm'"
        warn "    (located at /usr/local/bin/lociterm)"
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
    echo "  --host HOST    Server host (default: 127.0.0.1)"
    echo "  --port PORT    Server port (default: 8080)"
    echo "  --data-dir DIR SQLite database directory (default: OS-specific)"
    echo "  --help         Show this help"
    echo ""
}

main() {
    local user="${SUDO_USER:-$(whoami)}"

    while [[ $# -gt 0 ]]; do
        case "$1" in
            --user)  user="$2"; shift 2 ;;
            --host)  HOST="$2"; shift 2 ;;
            --port)  PORT="$2"; shift 2 ;;
            --data-dir) DATA_DIR="$2"; shift 2 ;;
            --help)  print_usage; exit 0 ;;
            *)       error "Unknown option: $1" ;;
        esac
    done

    if [[ -z "$DATA_DIR" ]]; then
        DATA_DIR="$(default_data_dir)"
    fi

    echo ""
    echo "  ╔═══════════════════════════════════╗"
    echo "  ║     Loci Terminal Installer       ║"
    echo "  ╚═══════════════════════════════════╝"
    echo ""

    info "OS: ${OS}"
    info "User: ${user}"
    info "Host: ${HOST}"
    info "Port: ${PORT}"
    info "Data dir: ${DATA_DIR}"
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
            warn "Run manually: lociterm --host ${HOST} --port ${PORT} --data-dir ${DATA_DIR}"
            ;;
    esac

    local display_host="${HOST}"
    if [[ "$display_host" == "0.0.0.0" || "$display_host" == "::" ]]; then
        display_host="localhost"
    fi

    echo ""
    info "========================================="
    info " Installation complete!"
    info " Open http://${display_host}:${PORT}"
    info "========================================="

    if [[ "$OS" == "Darwin" ]]; then
        check_macos_permissions
        echo ""
        info "Management:"
        info "  launchctl list | grep lociterm     # check status"
        info "  launchctl stop com.loci-terminal.lociterm   # stop"
        info "  launchctl start com.loci-terminal.lociterm  # start"
        info "  tail -f ~/Library/Logs/lociterm/stdout.log  # logs"
    else
        echo ""
        info "Management:"
        info "  systemctl status lociterm@${user}"
        info "  systemctl restart lociterm@${user}"
        info "  journalctl -u lociterm@${user} -f"
    fi

    print_uninstall_info
}

main "$@"
