# Deploy the WhatsApp backend on Oracle Cloud — native, NO Docker

Runs the Node app directly on the VM under **systemd** (auto-restart + starts on
boot, so you never have to log in and start it by hand), with **Chromium
installed natively**. Public HTTPS comes from a **Cloudflare Tunnel** whose
`cloudflared` also runs as a native systemd service — so **no inbound ports** are
opened (you never touch Oracle's Security List / iptables) and you get free TLS
on `wa-api.bhole.co`.

```
Vercel FE (wapp.bhole.co) ─/api,/socket.io─▶ https://wa-api.bhole.co
                                                   │  Cloudflare edge (TLS/WAF)
                                                   ▼
                                cloudflared  (systemd, dials OUT)
                                                   │ localhost:8099
                                                   ▼
                                node dist/index.js (systemd, 24/7)
                                                   ▼
                                system Chromium → WhatsApp Web
```

The frontend `vercel.json` **already** rewrites `/api` and `/socket.io` to
`https://wa-api.bhole.co`, so once the tunnel is up there is **no FE change**.

---

## 1. Create the Oracle VM (one time)

Oracle Cloud → **Compute → Instances → Create**:

- **Shape:** `VM.Standard.A1.Flex` (Ampere/ARM, **Always Free**). Give it
  **2 OCPU / 12 GB RAM** (well within the free 4 OCPU / 24 GB) — Chromium likes RAM.
  Avoid the AMD `E2.1.Micro` (1 GB) — too small for an always-on Chromium.
- **Image:** **Ubuntu 22.04** (recommended) or **Oracle Linux 9**. The setup
  script auto-detects apt vs dnf and ARM vs x86.
- **Networking:** default VCN is fine. **You do NOT need to open any ingress
  ports** — the Cloudflare Tunnel dials outbound only.
- Add your SSH public key, create, note the public IP.

SSH in:  `ssh ubuntu@<public-ip>`   (user is `opc` on Oracle Linux)

> Chromium note: on **Ubuntu**, `chromium` is a snap — the script handles it
> (profiles are kept in non-hidden dirs and user-linger is enabled so it runs
> under systemd). On **Oracle Linux** it installs a plain RPM Chromium (no snap).
> If the app later can't launch Chromium, that's the one thing to check in
> `journalctl -u wpp-backend` — switching to Oracle Linux is the clean fallback.

---

## 2. Run the setup script

```bash
curl -fsSL https://raw.githubusercontent.com/techserverbz/whatsapp-backend/main/deploy/oracle-native-setup.sh | bash
```

It installs Node 20 + Chromium + git, clones the repo to `~/whatsapp-backend`,
builds it, and installs the `wpp-backend` systemd service (enabled on boot). It
stops before starting because secrets aren't set yet.

## 3. Fill the two secrets

```bash
nano ~/whatsapp-backend/.env      # set JWT_SECRET and DATABASE_URL (rest is prefilled)
```

Do **not** start the service yet if you plan to migrate data (next step) — start
after restoring, so a fresh empty session doesn't overwrite the migrated one.

## 4. Migrate ALL data from the Windows PC (recommended — keeps history + login)

This carries over your message archive, the PGlite attribution DB, all
registries, and (best-effort) the WhatsApp login itself, so ideally there is
**no QR re-scan**.

> WhatsApp allows **one** active web session. **Stop the old Windows backend
> first** (Ctrl-C `npm run dev`, and stop the NSSM `wpp-backend` service if
> enabled) — both so the account is free and so Chromium flushes a clean profile.

**On the Windows PC** (Git Bash), from the backend repo:
```bash
bash deploy/pack-state.sh                       # -> ~/wpp-state.tgz (~0.9 GB)
scp ~/wpp-state.tgz ubuntu@<VM_PUBLIC_IP>:~/    # 'opc@' on Oracle Linux
```

**On the VM:**
```bash
bash ~/whatsapp-backend/deploy/restore-state.sh ~/wpp-state.tgz
```

Content (messages, attribution DB, registries) always migrates cleanly. The
Chromium **login** profile is copied too but may be rejected across OSes — if so,
you re-scan the QR once (step 5); nothing else is lost.

*(Skip this whole step only if you're fine starting fresh with a QR re-scan.)*

## 5. Start

```bash
sudo systemctl start wpp-backend
journalctl -u wpp-backend -f      # watch startup
```

If you migrated, the engine should **auto-resume as CONNECTED**
(`WPP_AUTO_START=true`). If it shows a QR instead (headless → rendered as a
text/link in the log, also shown to admins in the UI), scan it once from an
**admin** phone (`WPP_ADMIN_EMAILS`). Either way the link then persists in
`~/whatsapp-backend/tokens` + `~/whatsapp-backend/wa-sessions` across every
restart and reboot.

Local health check:
```bash
curl -s http://127.0.0.1:8099/api/health
# {"ok":true,"service":"wpp-backend","state":"CONNECTED"}
```

---

## 6. Public HTTPS via Cloudflare Tunnel (native `cloudflared`)

**Requires `bhole.co` to be on Cloudflare** (Zero Trust). If it is not, use the
direct-IP alternative in §8 instead.

**6a. Create the tunnel (dashboard):** Cloudflare → **Zero Trust → Networks →
Tunnels → Create a tunnel → Cloudflared**, name it `whatsapp`, copy the
`eyJ...` **token**. In the tunnel's **Public Hostname** tab → **Add**:

- Subdomain `wa-api`, Domain `bhole.co`
- Type **HTTP**, URL `localhost:8099`

Confirm zone **Network → WebSockets = On** (default).

**6b. Install cloudflared as a service on the VM:**
```bash
ARCH=arm64; [ "$(uname -m)" = x86_64 ] && ARCH=amd64
curl -fsSL -o cloudflared "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-$ARCH"
sudo install -m 0755 cloudflared /usr/local/bin/cloudflared
sudo cloudflared service install <PASTE_YOUR_TUNNEL_TOKEN>   # creates + enables the systemd service
systemctl status cloudflared --no-pager
```

Verify end-to-end:
```bash
curl -s https://wa-api.bhole.co/api/health   # same JSON, now through Cloudflare
```

## 7. Frontend

Nothing to change — `whatsapp-frontend/vercel.json` already targets
`https://wa-api.bhole.co`. If the FE was last deployed pointing elsewhere, just
redeploy it (`git push` or `vercel --prod`). Test the live app at
`https://wapp.bhole.co`.

---

## 8. Alternative ingress (only if bhole.co is NOT on Cloudflare)

Point DNS `A  wa-api.bhole.co → <Oracle public IP>`, then open **443** in BOTH
the Oracle **Security List** (ingress 0.0.0.0/0 → TCP 443) **and** the instance
firewall, and run **Caddy** (native, auto Let's Encrypt TLS):

```bash
sudo apt-get install -y caddy   # or dnf
sudo tee /etc/caddy/Caddyfile >/dev/null <<'CADDY'
wa-api.bhole.co {
    reverse_proxy 127.0.0.1:8099
}
CADDY
sudo systemctl restart caddy
# Oracle Ubuntu images block inbound by default in iptables too:
sudo iptables -I INPUT 6 -p tcp --dport 443 -j ACCEPT
sudo netfilter-persistent save 2>/dev/null || true
```

The Cloudflare Tunnel (§4) is preferred — no open ports, less to maintain.

---

## Operations cheat-sheet

| Task | Command |
|---|---|
| Watch logs / QR | `journalctl -u wpp-backend -f` |
| Restart app | `sudo systemctl restart wpp-backend` |
| Stop app | `sudo systemctl stop wpp-backend` |
| Update to latest code | `bash ~/whatsapp-backend/deploy/oracle-native-setup.sh` (pulls, rebuilds, restarts) |
| App status | `systemctl status wpp-backend` |
| Tunnel status | `systemctl status cloudflared` |

Both services are `enabled`, so after any reboot the backend and the tunnel come
back on their own — **nothing to start by hand.**
