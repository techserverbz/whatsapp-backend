#!/usr/bin/env bash
# =============================================================================
# Restore the packed WhatsApp state onto the Oracle VM. Run on the VM AFTER
# oracle-native-setup.sh has cloned the app to ~/whatsapp-backend:
#     bash ~/whatsapp-backend/deploy/restore-state.sh ~/wpp-state.tgz
#
# Extracts tokens/, data/, wa-sessions/ into the app dir, strips host-specific
# Chromium lock files and the PGlite postmaster.pid, and fixes ownership so the
# service user can read/write everything.
# =============================================================================
set -euo pipefail

APP_DIR="${APP_DIR:-$HOME/whatsapp-backend}"
TARBALL="${1:-$HOME/wpp-state.tgz}"
SERVICE="wpp-backend"

[ -f "$TARBALL" ]  || { echo "[x] tarball not found: $TARBALL"; exit 1; }
[ -d "$APP_DIR" ]  || { echo "[x] app dir not found: $APP_DIR (run oracle-native-setup.sh first)"; exit 1; }

echo "==> Stopping $SERVICE so nothing holds the profile/DB open"
sudo systemctl stop "$SERVICE" 2>/dev/null || true

echo "==> Extracting $(du -h "$TARBALL" | cut -f1) into $APP_DIR"
# The archive contains tokens/ data/ wa-sessions/ at its top level.
tar xzf "$TARBALL" -C "$APP_DIR"

echo "==> Removing stale Chromium single-instance locks (host-specific)"
find "$APP_DIR/tokens" "$APP_DIR/wa-sessions" -type f \
  \( -name 'Singleton*' -o -name 'SingletonLock' -o -name 'SingletonCookie' \
     -o -name 'lockfile' -o -name '.org.chromium.*' \) \
  -exec rm -f {} + 2>/dev/null || true

echo "==> Dropping regenerable Chromium caches (if any survived the pack)"
find "$APP_DIR/tokens" "$APP_DIR/wa-sessions" -type d \
  \( -name 'Cache' -o -name 'Code Cache' -o -name 'GPUCache' -o -name 'ShaderCache' \) \
  -exec rm -rf {} + 2>/dev/null || true

echo "==> Clearing PGlite postmaster.pid (stale PID from the old host)"
rm -f "$APP_DIR/data/attribution/postmaster.pid" 2>/dev/null || true

echo "==> Fixing ownership to $(id -un):$(id -gn)"
chown -R "$(id -u):$(id -g)" \
  "$APP_DIR/tokens" "$APP_DIR/data" "$APP_DIR/wa-sessions" 2>/dev/null || true

cat <<NEXT

==> Restore complete. Now:
    sudo systemctl start $SERVICE
    journalctl -u $SERVICE -f

  Watch for the engine to auto-resume as CONNECTED (WPP_AUTO_START=true).
  If it shows a QR / logged-out instead, the Chromium login profile didn't
  survive the OS move — scan the QR ONCE from an admin phone. Your messages,
  attribution DB and registries are already migrated regardless.
NEXT
