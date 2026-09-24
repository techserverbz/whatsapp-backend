#!/usr/bin/env bash
# =============================================================================
# Native (NO Docker) deploy of the WhatsApp backend on an Oracle Cloud Linux VM.
#
# What it does (idempotent — safe to re-run to update):
#   1. Detects package manager (apt/dnf) and CPU arch (arm64/x86_64)
#   2. Installs Node 20, Chromium + fonts, git
#   3. Clones/updates this repo, `npm ci` + `npm run build`
#   4. Writes ./.env from deploy/.env.oracle.example (fills the Chromium path)
#   5. Installs + enables a systemd service `wpp-backend` (24/7, boot-persistent)
#
# Run as a NORMAL sudo-capable user (NOT root), e.g. `ubuntu` or `opc`:
#   bash deploy/oracle-native-setup.sh
# or, before cloning:
#   curl -fsSL https://raw.githubusercontent.com/techserverbz/whatsapp-backend/main/deploy/oracle-native-setup.sh | bash
#
# Ingress (public HTTPS at wa-api.bhole.co) is a separate step — see
# deploy/DEPLOY_ORACLE_NATIVE.md.  This script only sets up the app + service.
# =============================================================================
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/techserverbz/whatsapp-backend.git}"
BRANCH="${BRANCH:-main}"
APP_DIR="${APP_DIR:-$HOME/whatsapp-backend}"
SERVICE="wpp-backend"
NODE_MAJOR=20
RUN_USER="$(id -un)"
RUN_UID="$(id -u)"

log()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m[!] %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m[x] %s\033[0m\n' "$*" >&2; exit 1; }

[ "$RUN_UID" -ne 0 ] || die "Run as a normal sudo-user (not root): Chromium and the service run as this user."
command -v sudo >/dev/null 2>&1 || die "sudo is required."

# ---- 1. Detect package manager + arch -------------------------------------
if   command -v apt-get >/dev/null 2>&1; then PKG=apt
elif command -v dnf     >/dev/null 2>&1; then PKG=dnf
else die "Unsupported distro (need apt or dnf). Use Ubuntu 22.04 or Oracle Linux 9."; fi
case "$(uname -m)" in
  aarch64|arm64) ARCH=arm64 ;;
  x86_64|amd64)  ARCH=amd64 ;;
  *) die "Unsupported arch $(uname -m)";;
esac
log "pkg=$PKG  arch=$ARCH  user=$RUN_USER  app_dir=$APP_DIR"

# ---- 2. Base packages ------------------------------------------------------
log "Installing base packages"
if [ "$PKG" = apt ]; then
  sudo apt-get update -y
  sudo apt-get install -y git curl ca-certificates gnupg
else
  sudo dnf install -y git curl ca-certificates gnupg2
fi

# ---- 3. Node 20 (NodeSource) ----------------------------------------------
need_node=1
if command -v node >/dev/null 2>&1; then
  cur="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  [ "$cur" -ge "$NODE_MAJOR" ] && need_node=0
fi
if [ "$need_node" = 1 ]; then
  log "Installing Node.js $NODE_MAJOR"
  if [ "$PKG" = apt ]; then
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | sudo -E bash -
    sudo apt-get install -y nodejs
  else
    curl -fsSL "https://rpm.nodesource.com/setup_${NODE_MAJOR}.x" | sudo -E bash -
    sudo dnf install -y nodejs
  fi
else
  log "Node $(node -v) already present"
fi

# ---- 4. Chromium + fonts ---------------------------------------------------
log "Installing Chromium + fonts"
if [ "$PKG" = apt ]; then
  # Ubuntu: chromium-browser is a snap wrapper; that is fine — we keep WhatsApp
  # profiles in NON-hidden dirs under $HOME so the snap 'home' interface allows
  # writes. procps provides pkill for session.ts's killStaleBrowser.
  sudo apt-get install -y chromium-browser fonts-liberation fonts-noto-color-emoji procps \
    || sudo apt-get install -y chromium fonts-liberation fonts-noto-color-emoji procps \
    || warn "chromium apt install had issues; will still try to locate a binary."
else
  # Oracle Linux: real RPM Chromium (no snap confinement). Needs EPEL.
  sudo dnf install -y "oracle-epel-release-el$(rpm -E %rhel)" 2>/dev/null \
    || sudo dnf install -y epel-release 2>/dev/null || true
  sudo dnf install -y chromium liberation-fonts google-noto-emoji-color-fonts procps-ng \
    || warn "chromium dnf install had issues; will still try to locate a binary."
fi

CHROME=""
for c in /usr/bin/chromium-browser /usr/bin/chromium /snap/bin/chromium /usr/lib/chromium/chromium; do
  [ -x "$c" ] && { CHROME="$c"; break; }
done
[ -n "$CHROME" ] || CHROME="$(command -v chromium || command -v chromium-browser || true)"
[ -n "$CHROME" ] || die "Chromium not found. Install a chromium package manually, then re-run (or set PUPPETEER_EXECUTABLE_PATH in .env)."
log "Chromium: $CHROME"
if "$CHROME" --version >/dev/null 2>&1; then
  log "Chromium reports: $("$CHROME" --version 2>/dev/null || echo '?')"
else
  warn "Could not run '$CHROME --version' (common with snap under sudo). It may still work for the app; check logs after start."
fi

# Keep /run/user/$UID alive so a snap-confined Chromium works under systemd.
sudo loginctl enable-linger "$RUN_USER" 2>/dev/null || true

# ---- 5. Clone / update repo ------------------------------------------------
if [ -d "$APP_DIR/.git" ]; then
  log "Updating repo at $APP_DIR"
  git -C "$APP_DIR" fetch origin "$BRANCH"
  git -C "$APP_DIR" checkout "$BRANCH"
  git -C "$APP_DIR" reset --hard "origin/$BRANCH"
else
  log "Cloning $REPO_URL -> $APP_DIR"
  git clone --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
fi
cd "$APP_DIR"

# ---- 6. Deps + build -------------------------------------------------------
export PUPPETEER_SKIP_DOWNLOAD=true   # do NOT let puppeteer download Chromium (no arm64 build anyway)
log "npm ci"
npm ci
log "npm run build (tsc -> dist)"
npm run build

# ---- 7. Persistent state dirs (non-hidden; survive redeploys) --------------
mkdir -p "$APP_DIR/wwp" "$APP_DIR/data" "$APP_DIR/wa-sessions"

# ---- 8. .env ---------------------------------------------------------------
ENV_NEEDS_SECRETS=0
if [ ! -f "$APP_DIR/.env" ]; then
  log "Creating .env from deploy/.env.oracle.example"
  cp "$APP_DIR/deploy/.env.oracle.example" "$APP_DIR/.env"
  ENV_NEEDS_SECRETS=1
else
  log ".env already exists — leaving your values in place"
  grep -q '__PASTE_' "$APP_DIR/.env" && ENV_NEEDS_SECRETS=1
fi
# Always wire the detected Chromium path.
if grep -q '^PUPPETEER_EXECUTABLE_PATH=' "$APP_DIR/.env"; then
  sed -i "s#^PUPPETEER_EXECUTABLE_PATH=.*#PUPPETEER_EXECUTABLE_PATH=$CHROME#" "$APP_DIR/.env"
else
  printf '\nPUPPETEER_EXECUTABLE_PATH=%s\n' "$CHROME" >> "$APP_DIR/.env"
fi

# ---- 9. systemd service ----------------------------------------------------
log "Installing systemd service: $SERVICE"
NODE_BIN="$(command -v node)"
sudo tee /etc/systemd/system/$SERVICE.service >/dev/null <<UNIT
[Unit]
Description=WhatsApp Backend (wpp-backend) - native, no Docker
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$RUN_USER
WorkingDirectory=$APP_DIR
Environment=NODE_ENV=production
Environment=XDG_RUNTIME_DIR=/run/user/$RUN_UID
# The app self-loads ./.env via dotenv, so no EnvironmentFile is needed.
ExecStart=$NODE_BIN $APP_DIR/dist/index.js
Restart=always
RestartSec=4
# index.ts closes Chromium cleanly on SIGTERM (~15s flush); give it headroom.
KillSignal=SIGTERM
TimeoutStopSec=30
KillMode=control-group
# Chromium legitimately uses a few hundred MB; this only guards a runaway leak.
MemoryMax=2G
StandardOutput=journal
StandardError=journal
SyslogIdentifier=$SERVICE

[Install]
WantedBy=multi-user.target
UNIT

sudo systemctl daemon-reload
sudo systemctl enable "$SERVICE"

# ---- 10. Start (only if secrets are filled) --------------------------------
if [ "$ENV_NEEDS_SECRETS" = 1 ]; then
  warn "Service enabled but NOT started — .env still has placeholder secrets."
  cat <<NEXT

  Finish with:
    1) nano $APP_DIR/.env         # set JWT_SECRET and DATABASE_URL
    2) sudo systemctl start $SERVICE
    3) journalctl -u $SERVICE -f  # first run prints a QR — scan it from an admin phone
    4) curl -s http://127.0.0.1:$(grep -E '^PORT=' "$APP_DIR/.env" | cut -d= -f2 || echo 8099)/api/health

  Then set up public HTTPS (Cloudflare Tunnel) — see deploy/DEPLOY_ORACLE_NATIVE.md
NEXT
else
  log "Restarting $SERVICE"
  sudo systemctl restart "$SERVICE"
  sleep 3
  sudo systemctl --no-pager --full status "$SERVICE" | head -n 14 || true
  PORT_VAL="$(grep -E '^PORT=' "$APP_DIR/.env" | cut -d= -f2 || echo 8099)"
  cat <<NEXT

  Watch logs / QR:  journalctl -u $SERVICE -f
  Local health:     curl -s http://127.0.0.1:${PORT_VAL}/api/health
  Public HTTPS:     set up the Cloudflare Tunnel — see deploy/DEPLOY_ORACLE_NATIVE.md
NEXT
fi
log "Done."
