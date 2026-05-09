#!/usr/bin/env bash
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}[INFO]${NC} $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }

if [[ $EUID -ne 0 ]]; then
    echo -e "${RED}[ERROR]${NC} Run as root: sudo bash uninstall.sh"
    exit 1
fi

USER="${SUDO_USER:-$(whoami)}"

echo ""
echo "  Uninstalling Loci Terminal..."
echo ""

if systemctl is-active --quiet "ghostterm@${USER}" 2>/dev/null; then
    info "Stopping service..."
    systemctl stop "ghostterm@${USER}"
fi

if systemctl is-enabled --quiet "ghostterm@${USER}" 2>/dev/null; then
    info "Disabling service..."
    systemctl disable "ghostterm@${USER}"
fi

if [[ -f /etc/systemd/system/ghostterm@.service ]]; then
    info "Removing systemd unit..."
    rm -f /etc/systemd/system/ghostterm@.service
    systemctl daemon-reload
fi

if [[ -f /usr/local/bin/ghostterm ]]; then
    info "Removing binary..."
    rm -f /usr/local/bin/ghostterm
fi

echo ""
warn "Data directory /var/lib/ghostterm was NOT removed."
warn "To delete all data: sudo rm -rf /var/lib/ghostterm"
echo ""
info "Uninstall complete."
