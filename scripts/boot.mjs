// Boot supervisor — the entry point for the "wpp-backend-boot" scheduled task.
//
// Task Scheduler starts this at machine boot (as SYSTEM). It is NOT used by
// `npm run dev`; that path stays exactly as it was. This script exists to make
// the backend survive a reboot unattended, which means it must handle three
// things a bare `node dist/index.js` does not:
//
//   1. Tailscale is not up yet at boot. The service starts in parallel with us
//      and takes a few seconds to reach the tailnet. Applying the funnel before
//      then fails, so we wait for BackendState=Running first.
//   2. Nothing supervises a crash. Task Scheduler's restart-on-failure only
//      fires a fixed number of times; we want indefinite restarts with backoff.
//   3. There is no console. SYSTEM has no desktop, so stdout must go to a file
//      or it is lost.
//
// Runs the server through tsx against src/ rather than `node dist/index.js`:
// dist/ is a build artifact that goes stale silently (it already had, by ~6h),
// and a boot path that runs code the source no longer matches is a trap.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// WPP_TOKEN_FOLDER (./tokens) and dotenv's own lookup are cwd-relative, so the
// server finds neither its session nor its .env unless cwd is the repo root.
// The task sets this too; doing it here as well means the script is correct
// even when launched from somewhere else.
process.chdir(ROOT);

const LOG_DIR = path.join(ROOT, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'boot.log');
const MAX_LOG_BYTES = 10 * 1024 * 1024;

fs.mkdirSync(LOG_DIR, { recursive: true });

function rotateIfBig() {
  try {
    if (fs.statSync(LOG_FILE).size > MAX_LOG_BYTES) {
      fs.renameSync(LOG_FILE, LOG_FILE + '.1'); // keep exactly one previous log
    }
  } catch {
    /* no log yet */
  }
}
rotateIfBig();

let logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });

function log(msg) {
  const line = `[${new Date().toISOString()}] [boot] ${msg}\n`;
  logStream.write(line);
  process.stdout.write(line);
}

// ── Tailscale ──────────────────────────────────────────────────────────────
const TS_CANDIDATES = [
  'tailscale',
  'C:\\Program Files\\Tailscale\\tailscale.exe',
  'C:\\Program Files (x86)\\Tailscale\\tailscale.exe',
];

function runTs(bin, args) {
  const cmd = /\s/.test(bin) ? `"${bin}"` : bin;
  return spawnSync(cmd, args, { encoding: 'utf8', shell: true });
}

function resolveTailscale() {
  for (const bin of TS_CANDIDATES) {
    if (runTs(bin, ['version']).status === 0) return bin;
  }
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Block until Tailscale reports BackendState=Running, or give up after `timeoutMs`.
 * Giving up is deliberately non-fatal: a backend serving only localhost is far
 * better than no backend at all, and the funnel config persists server-side, so
 * it reattaches on its own once the tailnet comes back.
 */
async function waitForTailscale(bin, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const st = runTs(bin, ['status', '--json']);
    if (st.status === 0) {
      try {
        const j = JSON.parse(st.stdout);
        if (j?.BackendState === 'Running') return j?.Self?.DNSName?.replace(/\.$/, '') || '';
      } catch {
        /* status not parseable yet */
      }
    }
    await sleep(3000);
  }
  return null;
}

async function setUpTunnel() {
  const bin = resolveTailscale();
  if (!bin) {
    log('Tailscale CLI not found — starting backend on localhost only.');
    return;
  }
  log('waiting for Tailscale to reach the tailnet…');
  const dns = await waitForTailscale(bin);
  if (dns === null) {
    log('WARN: Tailscale did not come up in 180s — starting backend anyway.');
    return;
  }
  log(`Tailscale up${dns ? ` as ${dns}` : ''}.`);

  const PORT = process.env.PORT ?? '5000';
  const res = runTs(bin, ['funnel', '--bg', String(PORT)]);
  if (res.status !== 0) {
    log(`WARN: could not apply funnel (exit ${res.status}): ${(res.stderr || '').trim()}`);
    return;
  }
  log(`funnel -> http://127.0.0.1:${PORT}${dns ? ` published at https://${dns}` : ''}`);
}

// ── Server supervision ─────────────────────────────────────────────────────
const TSX_CLI = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const ENTRY = path.join('src', 'index.ts');

let child = null;
let shuttingDown = false;
let backoffMs = 5_000;
const MAX_BACKOFF_MS = 60_000;
const STABLE_MS = 60_000; // uptime after which a run counts as healthy

function startServer() {
  const startedAt = Date.now();
  log(`starting server: node ${path.relative(ROOT, TSX_CLI)} ${ENTRY}`);

  child = spawn(process.execPath, [TSX_CLI, ENTRY], {
    cwd: ROOT,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout.pipe(logStream, { end: false });
  child.stderr.pipe(logStream, { end: false });

  child.on('exit', (code, signal) => {
    child = null;
    if (shuttingDown) return;

    const upFor = Date.now() - startedAt;
    // Only a run that stayed up a while proves the config is good. Resetting on
    // every exit would turn a boot-time crash loop into a tight 5s retry storm.
    if (upFor > STABLE_MS) backoffMs = 5_000;

    log(`server exited (code=${code} signal=${signal}) after ${Math.round(upFor / 1000)}s — restarting in ${backoffMs / 1000}s`);
    setTimeout(startServer, backoffMs);
    backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
  });

  child.on('error', (err) => log(`ERROR spawning server: ${err.message}`));
}

// Forward shutdown to the child so index.ts runs its own graceful teardown —
// that path is what preserves the linked WhatsApp session across a restart.
// A hard kill here would cost a QR re-scan.
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGBREAK']) {
  process.on(sig, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`received ${sig} — shutting down`);
    if (child) {
      child.kill('SIGTERM');
      setTimeout(() => process.exit(0), 10_000).unref();
    } else {
      process.exit(0);
    }
  });
}

log('─'.repeat(60));
log(`boot supervisor starting (root=${ROOT})`);
await setUpTunnel();
startServer();
