// Ensures the Tailscale Funnel exposes this backend on the public internet.
//
// Wired into `npm run dev` and `npm start` (see package.json) so the tunnel
// "spins up" automatically whenever the backend starts. It is idempotent —
// re-running just re-applies the same funnel config — and it NEVER blocks the
// server from starting: if Tailscale is missing or errors, it warns and exits 0.
import { spawnSync } from 'node:child_process';

const PORT = process.env.PORT ?? '8099';

// Resolve a working `tailscale` command. Prefer PATH; fall back to the default
// Windows install location so this keeps working even if PATH isn't set up.
const CANDIDATES = [
  'tailscale',
  'C:\\Program Files\\Tailscale\\tailscale.exe',
  'C:\\Program Files (x86)\\Tailscale\\tailscale.exe',
  '/usr/bin/tailscale',
  '/usr/local/bin/tailscale',
  '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
];

function run(bin, args) {
  return spawnSync(bin, args, { encoding: 'utf8', shell: true });
}

function resolveTailscale() {
  for (const bin of CANDIDATES) {
    const r = run(bin, ['version']);
    if (r.status === 0) return bin;
  }
  return null;
}

const bin = resolveTailscale();
if (!bin) {
  console.warn('[tunnel] Tailscale CLI not found — skipping funnel. The server will still start.');
  process.exit(0);
}

// (Re)apply funnel -> http://127.0.0.1:PORT in the background. Returns immediately.
const res = run(bin, ['funnel', '--bg', String(PORT)]);
if (res.status !== 0) {
  console.warn(`[tunnel] Could not enable Tailscale Funnel (exit ${res.status}). The server will still start.`);
  if (res.stderr) console.warn('[tunnel] ' + res.stderr.trim());
  process.exit(0);
}

// Look up the public URL (…​.ts.net) for a friendly log line.
let url = '';
try {
  const st = run(bin, ['status', '--json']);
  if (st.status === 0) {
    const dns = JSON.parse(st.stdout)?.Self?.DNSName?.replace(/\.$/, '');
    if (dns) url = `https://${dns}`;
  }
} catch {
  // best-effort only
}

console.log('[tunnel] ─────────────────────────────────────────────');
console.log(`[tunnel] Tailscale Funnel is exposing  http://127.0.0.1:${PORT}`);
if (url) console.log(`[tunnel] Public URL:  ${url}`);
console.log('[tunnel] ─────────────────────────────────────────────');
process.exit(0);
