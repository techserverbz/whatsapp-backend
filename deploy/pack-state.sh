#!/usr/bin/env bash
# =============================================================================
# Pack ALL WhatsApp-backend state on THIS Windows PC into one tarball to carry
# over to the Oracle VM. Run in **Git Bash**, from anywhere:
#     bash deploy/pack-state.sh
# Produces ~/wpp-state.tgz  (override: bash deploy/pack-state.sh /path/out.tgz)
#
# ⚠️  STOP THE BACKEND FIRST (Ctrl-C the `npm run dev`, and stop the NSSM
#     `wpp-backend` service if enabled). A live Chromium holds the WhatsApp
#     login open and half-written — packing it while running can corrupt the
#     copied profile. WhatsApp also allows only ONE active web session.
#
# What it captures (mirrors the app's on-disk state):
#   tokens/        wppconnect Chromium profile = the WhatsApp login (+ webjs/)
#   data/          messages/*.json, attribution/ (PGlite Postgres), *.json registries
#   C:\wa-sessions whatsapp-web.js LocalAuth Chromium profiles (session-webjs-*)
# Regenerable Chromium caches and host-specific lock files are excluded to keep
# the archive small and portable.
# =============================================================================
set -euo pipefail

# Resolve the repo root (this script lives in <repo>/deploy/).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/.." && pwd)"
OUT="${1:-$HOME/wpp-state.tgz}"
WA_SESSIONS="${WA_SESSIONS:-/c/wa-sessions}"   # Windows C:\wa-sessions in Git Bash

[ -d "$REPO/tokens" ] || { echo "[x] $REPO/tokens not found — is this the backend repo?"; exit 1; }
[ -d "$REPO/data" ]   || { echo "[x] $REPO/data not found."; exit 1; }

# Best-effort: warn if the backend still seems to be listening (port 5000).
if command -v netstat >/dev/null 2>&1 && netstat -ano 2>/dev/null | grep -qE '[:.]5000\s+.*LISTEN'; then
  echo "[!] Something is still LISTENING on :5000 — the backend may be running."
  echo "    Stop it first (Ctrl-C the npm run dev), then re-run. Continue anyway? [y/N]"
  read -r ans; [ "${ans:-n}" = y ] || exit 1
fi

EXCLUDES=(
  --exclude='*/Cache'            --exclude='*/Code Cache'
  --exclude='*/GPUCache'         --exclude='*/ShaderCache'
  --exclude='*/component_crx_cache' --exclude='*/extensions_crx_cache'
  --exclude='*/Singleton*'       --exclude='SingletonLock'
  --exclude='*/lockfile'         --exclude='postmaster.pid'
)

echo "==> Packing state -> $OUT"
if [ -d "$WA_SESSIONS" ]; then
  tar czf "$OUT" "${EXCLUDES[@]}" \
    -C "$REPO" tokens data \
    -C "$(dirname "$WA_SESSIONS")" "$(basename "$WA_SESSIONS")"
else
  echo "[!] $WA_SESSIONS not found — packing tokens/ + data/ only (no webjs LocalAuth profiles)."
  tar czf "$OUT" "${EXCLUDES[@]}" -C "$REPO" tokens data
fi

echo "==> Done: $(du -h "$OUT" | cut -f1)  ->  $OUT"
cat <<NEXT

Next:
  1) Copy to the VM (from Git Bash / PowerShell):
       scp "$OUT" ubuntu@<VM_PUBLIC_IP>:~/           # 'opc@' on Oracle Linux
  2) On the VM (after running oracle-native-setup.sh once):
       bash ~/whatsapp-backend/deploy/restore-state.sh ~/wpp-state.tgz
       sudo systemctl start wpp-backend
       journalctl -u wpp-backend -f
NEXT
