// Frees PORT before the dev server starts, so a stale instance can't cause EADDRINUSE.
//
// Why this is needed: `npm run dev` -> `tsx watch` -> node. The server is a *grandchild*,
// and on Windows Ctrl+C / closing the terminal frequently reaps only the top of that tree,
// leaving an orphan holding the port with no terminal attached to stop it from.
//
// It only ever kills a process whose command line points back at THIS backend folder. If
// something unrelated owns the port it refuses and says so, rather than killing a stranger's
// process because it happened to pick the same number.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(ROOT, '.env') });

const PORT = process.env.PORT ?? '5000';

if (process.platform !== 'win32') {
  process.exit(0); // Windows-only helper; other platforms reap the tree properly.
}

const sh = (cmd) => spawnSync(cmd, { encoding: 'utf8', shell: true }).stdout ?? '';

// PIDs LISTENING on PORT. Match the local address column so we skip outbound
// connections that merely have PORT as their remote peer.
const pids = new Set();
for (const line of sh(`netstat -ano -p tcp`).split('\n')) {
  const m = line.trim().match(/^TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)/i);
  if (m && m[2] === String(PORT)) pids.add(m[3]);
}

if (!pids.size) process.exit(0);

for (const pid of pids) {
  const out = sh(
    `powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter \\"ProcessId=${pid}\\").CommandLine"`,
  );
  const cmdline = out.trim();

  // Only reclaim the port from this project's own server.
  const isOurs = cmdline.includes(ROOT) || /tsx|index\.(ts|js)/.test(cmdline);

  if (!isOurs) {
    console.warn(
      `\n  Port ${PORT} is held by PID ${pid}, which is NOT this backend:\n` +
        `    ${cmdline || '(command line unavailable — may need admin to inspect)'}\n` +
        `  Refusing to kill it. Stop it yourself, or change PORT in .env.\n`,
    );
    process.exit(1);
  }

  // Ask politely FIRST. The server's SIGTERM/SIGBREAK handler closes the
  // WhatsApp browser cleanly; killing it outright (/F) skips that and can
  // corrupt the Chromium auth profile mid-write, costing a QR re-scan. Escalate
  // to /F only if it is still holding the port after the grace period.
  const stillListening = () =>
    sh('netstat -ano -p tcp')
      .split('\n')
      .some((l) => {
        const m = l.trim().match(/^TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)/i);
        return m && m[2] === String(PORT) && m[3] === String(pid);
      });

  console.log(`  [port] asking PID ${pid} to shut down (preserving the WhatsApp session)…`);
  spawnSync(`taskkill /T /PID ${pid}`, { encoding: 'utf8', shell: true });

  const GRACE_MS = 20_000;
  const startedAt = Date.now();
  while (stillListening() && Date.now() - startedAt < GRACE_MS) {
    spawnSync(`powershell -NoProfile -Command "Start-Sleep -Milliseconds 500"`, { shell: true });
  }

  if (!stillListening()) {
    console.log(`  [port] reclaimed :${PORT} from PID ${pid} (clean shutdown)`);
    continue;
  }

  console.warn(`  [port] PID ${pid} did not exit in ${GRACE_MS / 1000}s — forcing.`);
  const res = spawnSync(`taskkill /F /T /PID ${pid}`, { encoding: 'utf8', shell: true });
  if (res.status === 0) console.log(`  [port] reclaimed :${PORT} from stale PID ${pid}`);
  else console.warn(`  [port] could not kill PID ${pid} — may need admin.`);
}
