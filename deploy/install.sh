#!/usr/bin/env bash
set -euo pipefail

REPO="Younkyum/Loci-Terminal"
INSTALL_DIR="/usr/local/bin"
DATA_DIR="/var/lib/ghostterm"
SERVICE_FILE="/etc/systemd/system/ghostterm@.service"
PORT="${GHOSTTERM_PORT:-8080}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}[INFO]${NC} $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }

check_deps() {
    for cmd in tmux git curl; do
        if ! command -v "$cmd" &>/dev/null; then
            error "$cmd is required but not installed. Install it first."
        fi
    done
    info "Dependencies OK (tmux, git, curl)"
}

check_root() {
    if [[ $EUID -ne 0 ]]; then
        error "Run this script as root: sudo bash install.sh"
    fi
}

detect_arch() {
    local arch
    arch=$(uname -m)
    case "$arch" in
        x86_64)  echo "amd64" ;;
        aarch64) echo "arm64" ;;
        arm64)   echo "arm64" ;;
        *)       error "Unsupported architecture: $arch" ;;
    esac
}

build_from_source() {
    info "Building from source..."

    if ! command -v go &>/dev/null; then
        error "Go is required to build from source. Install Go 1.22+ first."
    fi
    if ! command -v node &>/dev/null; then
        error "Node.js is required to build from source. Install Node.js 20+ first."
    fi

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
    install -m 755 ghostterm "${INSTALL_DIR}/ghostterm"
}

setup_systemd() {
    local user="$1"

    info "Setting up systemd service for user: ${user}"

    mkdir -p "$DATA_DIR"
    chown "$user:$user" "$DATA_DIR"

    cat > "$SERVICE_FILE" << 'UNIT'
[Unit]
Description=GhostTerm - Web-based Multi-Terminal Server
After=network.target

[Service]
Type=simple
User=%i
ExecStart=/usr/local/bin/ghostterm --port 8080 --data-dir /var/lib/ghostterm
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT

    systemctl daemon-reload
    systemctl enable "ghostterm@${user}"
    systemctl start "ghostterm@${user}"

    info "Service started: ghostterm@${user}"
    info "Check status: systemctl status ghostterm@${user}"
}

print_usage() {
    echo ""
    echo "Usage:"
    echo "  sudo bash install.sh [OPTIONS]"
    echo ""
    echo "Options:"
    echo "  --user USER    System user to run as (default: current SUDO_USER)"
    echo "  --port PORT    Server port (default: 8080)"
    echo "  --docker       Install Docker mode only (skip systemd)"
    echo "  --help         Show this help"
    echo ""
}

main() {
    local user="${SUDO_USER:-$(whoami)}"
    local docker_only=false

    while [[ $# -gt 0 ]]; do
        case "$1" in
            --user)  user="$2"; shift 2 ;;
            --port)  PORT="$2"; shift 2 ;;
            --docker) docker_only=true; shift ;;
            --help)  print_usage; exit 0 ;;
            *)       error "Unknown option: $1" ;;
        esac
    done

    echo ""
    echo "  ╔═══════════════════════════════════╗"
    echo "  ║     Loci Terminal Installer       ║"
    echo "  ╚═══════════════════════════════════╝"
    echo ""

    if $docker_only; then
        info "Docker mode: use 'docker compose up -d' in the repo directory."
        exit 0
    fi

    check_root
    check_deps

    info "Target user: ${user}"
    info "Port: ${PORT}"

    build_from_source

    # Update port in service if non-default
    if [[ "$PORT" != "8080" ]]; then
        sed -i "s/--port 8080/--port ${PORT}/" "$SERVICE_FILE" 2>/dev/null || true
    fi

    setup_systemd "$user"

    echo ""
    info "========================================="
    info " Installation complete!"
    info " Open http://localhost:${PORT}"
    info ""
    info " Commands:"
    info "   systemctl status ghostterm@${user}"
    info "   systemctl restart ghostterm@${user}"
    info "   journalctl -u ghostterm@${user} -f"
    info "========================================="
}

main "$@"
