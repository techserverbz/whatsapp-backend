import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import { createServer } from 'http';
import fs from 'fs';
import path from 'path';
import { config, isAllowedOrigin } from './config';
import {
  authenticateToken,
  canSend,
  canViewAll,
  isAdminUser,
  requireAuth,
  ssoEnabled,
  tokenFromRequest,
} from './auth';
import type { CrmUser } from './auth';
import { emitToAll, initSocket, SocketEvents, startSocketRevalidation } from './socket';
import { session } from './whatsapp/session';
import { manager } from './engines/manager';
import { hasSavedWebJsSession } from './engines/webjs/engine';
import sessionRoutes from './routes/session.routes';
import sessionsRoutes from './routes/sessions.routes';
import chatRoutes from './routes/chat.routes';
import messageRoutes from './routes/message.routes';
import attributionRoutes from './routes/attribution.routes';
import crmRoutes from './routes/crm.routes';
import waContactsRoutes from './routes/waContacts.routes';
import accessRoutes from './routes/access.routes';

const app = express();

// In production the app sits behind a same-host reverse proxy (Caddy) that
// terminates TLS and forwards to 127.0.0.1. Trust ONLY the loopback proxy so
// req.ip / req.protocol reflect the real client (correct per-client rate
// limiting + logs) without trusting any spoofable external X-Forwarded-For.
//
// Behind a Cloudflare Tunnel the immediate peer is the `cloudflared` sidecar,
// which is NOT loopback — leaving this as 'loopback' would collapse every
// request to one rate-limit bucket and make req.secure false (dropping the
// cookie Secure flag). Set TRUST_PROXY=true in the container: it is safe there
// because the origin is ONLY reachable via the tunnel, never directly. Unset
// (native Windows deploy) keeps the original loopback-only behaviour.
const trustProxyEnv = process.env.TRUST_PROXY;
app.set(
  'trust proxy',
  trustProxyEnv === undefined || trustProxyEnv === ''
    ? 'loopback'
    : trustProxyEnv === 'true'
      ? true
      : trustProxyEnv === 'false'
        ? false
        : /^\d+$/.test(trustProxyEnv)
          ? Number(trustProxyEnv)
          : trustProxyEnv,
);

// Credentialed CORS so the CRM `crm_token` cookie is sent from the frontend.
app.use(cors({ origin: (origin, cb) => cb(null, isAllowedOrigin(origin)), credentials: true }));
app.use(express.json({ limit: `${config.maxUploadMb}mb` })); // base64 media uploads
app.use(cookieParser());

// Health stays open (probes / connectivity checks) — no auth, minimal info.
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'wpp-backend', state: session.getStatus().state });
});

// Who is the logged-in CRM user? (self-handles 401 so the frontend can show login.)
app.get('/api/auth/me', async (req: Request, res: Response) => {
  if (!ssoEnabled())
    return res.json({ sso: false, user: null, isAdmin: true, canSend: true, viewAll: true });
  const user = await authenticateToken(tokenFromRequest(req));
  if (!user) return res.status(401).json({ error: 'Not authenticated', login: true });
  const admin = isAdminUser(user);
  res.json({ sso: true, user, isAdmin: admin, canSend: canSend(user), viewAll: canViewAll(user) });
});

// App sign-out: clear the CRM cookie for this app's host (any user can do this;
// it does NOT touch the WhatsApp device link — that's admin-only via /session/logout).
app.post('/api/auth/logout', (_req: Request, res: Response) => {
  res.cookie('crm_token', '', {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
    ...(config.cookieDomain ? { domain: config.cookieDomain } : {}),
  });
  res.json({ ok: true });
});

/** Pull a named cookie value out of an array of Set-Cookie header strings. */
function cookieFromSetCookies(setCookies: string[], name: string): string | undefined {
  for (const c of setCookies) {
    const pair = c.split(';', 1)[0];
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    if (pair.slice(0, eq).trim() === name) return pair.slice(eq + 1).trim();
  }
  return undefined;
}

// Throttle the unauthenticated login proxy: it is public and (via Tailscale
// Funnel) internet-exposed, so without this it would relay unlimited
// credential-stuffing / brute-force attempts to the CRM.
const loginLimiter = rateLimit({
  windowMs: 60_000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts — please wait a minute and try again.' },
});

// Inline CRM login: proxy the credentials to the SAM CRM (server-to-server, so
// no browser CORS blocks it), lift the CRM's `crm_token` out of its Set-Cookie
// response, then (a) set that cookie for THIS app's host and (b) return the token
// in the body so the frontend can also send it as `Authorization: Bearer` / socket
// `auth.token` — which works even when the CRM cookie can't be shared across hosts.
// This replaces the old CRM login popup.
app.post('/api/auth/login', loginLimiter, async (req: Request, res: Response) => {
  if (!ssoEnabled()) {
    return res.status(400).json({ error: 'CRM SSO is not configured on this server.' });
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  const loginId = String(body.username ?? body.email ?? '').trim();
  const password = String(body.password ?? '');
  if (!loginId || !password) {
    return res.status(400).json({ error: 'Email/username and password are required.' });
  }

  // Send the identifier in the right field so a username isn't rejected as a
  // malformed email (the CRM accepts either `username` or `email`).
  const idField = loginId.includes('@') ? { email: loginId } : { username: loginId };
  const crmRes = await fetch(`${config.crmApiUrl}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...idField,
      password,
      ...(body.portal ? { portal: body.portal } : {}),
    }),
    // Don't let a slow/hung CRM (cold Vercel function) pin this request open.
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);

  if (!crmRes) {
    return res.status(502).json({ error: 'Could not reach the CRM login service.' });
  }

  // Forward CRM auth failures (invalid credentials, disabled account, etc.).
  if (!crmRes.ok) {
    const data = (await crmRes.json().catch(() => ({}))) as { error?: string };
    return res.status(crmRes.status).json({ error: data.error ?? 'Login failed.' });
  }

  // The CRM delivers the JWT only as an httpOnly `crm_token` cookie.
  const token = cookieFromSetCookies(crmRes.headers.getSetCookie?.() ?? [], 'crm_token');
  if (!token) {
    return res.status(502).json({ error: 'CRM login did not return a session token.' });
  }

  // Validate with OUR shared secret + live revocation check. Failing here means
  // this backend's JWT_SECRET does not match the CRM's — a server misconfiguration.
  const user = await authenticateToken(token);
  if (!user) {
    return res.status(502).json({
      error:
        'CRM login succeeded but its session could not be verified here. ' +
        'Ensure JWT_SECRET matches the CRM and the account is active.',
    });
  }

  // Mirror the logout cookie options so the browser stores it for this host.
  // `secure` follows the actual request scheme (https in prod behind the proxy,
  // http on localhost) so the 7-day JWT is never sent over cleartext in prod.
  res.cookie('crm_token', token, {
    httpOnly: true,
    secure: req.secure,
    sameSite: 'lax',
    path: '/',
    maxAge: 7 * 24 * 60 * 60 * 1000,
    ...(config.cookieDomain ? { domain: config.cookieDomain } : {}),
  });

  const admin = isAdminUser(user);
  res.json({
    sso: true,
    user,
    isAdmin: admin,
    canSend: canSend(user),
    viewAll: canViewAll(user),
    token,
  });
});

// CSRF guard: browser CORS does NOT block the *sending* of a cross-origin
// simple request, so a malicious site could fire a state-changing POST. Reject
// any mutating request whose Origin is present but not allowed. (Absent Origin =
// a non-browser client such as curl on the LAN, which is allowed.)
app.use('/api', (req: Request, res: Response, next: NextFunction) => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  const origin = req.headers.origin;
  if (origin && !isAllowedOrigin(origin)) {
    return res.status(403).json({ error: 'Forbidden origin' });
  }
  next();
});

// Require a valid CRM login (SSO) — or the legacy API key — for every route below.
app.use('/api', requireAuth);

// Role gating: only device admins may manage the session (connect/scan/logout).
// Unless viewers are allowed to send, all state-changing WhatsApp actions
// (send / mark-seen / typing) are admin-only too — everyone else is read-only.
// NOTE: `path` here is mount-relative (e.g. "/session/start", not "/api/...").
function permNeeded(method: string, path: string): 'admin' | 'send' | null {
  // Managing the send-access allow-list is admin-only (any method).
  if (/^\/access(\/|$)/.test(path)) return 'admin';
  // Linking / unlinking the WhatsApp device is admin-only.
  if (method === 'POST' && (path === '/session/start' || path === '/session/logout')) {
    return 'admin';
  }
  // Sending / chat-write actions — the global session AND per-engine sessions.
  const isSend =
    (method === 'POST' && (path === '/messages/text' || path === '/messages/file')) ||
    (method === 'POST' && /^\/chats\/[^/]+\/(seen|typing)$/.test(path)) ||
    (method === 'POST' && /^\/sessions\/[^/]+\/messages\/(text|file)$/.test(path)) ||
    (method === 'POST' && /^\/sessions\/[^/]+\/chats\/[^/]+\/(seen|typing)$/.test(path)) ||
    // Saving a WhatsApp contact writes to the real linked account (and, with
    // syncToAddressbook, to the phone's address book), so it is gated like any
    // other write rather than treated as a read-only lookup.
    (method === 'POST' && path === '/wa-contacts/save');
  if (isSend) return 'send';
  return null;
}

app.use('/api', (req: Request, res: Response, next: NextFunction) => {
  if (!config.jwtSecret) return next(); // no SSO -> no role gating (open dev)
  // Normalise so it works whether req.path is mount-relative or absolute.
  const relPath = req.path.replace(/^\/api/, '');
  const need = permNeeded(req.method, relPath);
  if (!need) return next();
  const user = (req as unknown as { crmUser?: CrmUser }).crmUser;
  if (need === 'admin' && !isAdminUser(user)) {
    return res.status(403).json({ error: 'Admin access required', adminOnly: true });
  }
  if (need === 'send' && !canSend(user)) {
    return res.status(403).json({ error: 'You do not have permission to send messages.', noSend: true });
  }
  next();
});

// Rate-limit the message-sending endpoints: guards against runaway loops and,
// importantly, against tripping WhatsApp's spam detection on the real account.
const messageLimiter = rateLimit({
  windowMs: 60_000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many messages — slow down.' },
});

app.use('/api/session', sessionRoutes);
app.use('/api/sessions', sessionsRoutes); // multi-session, multi-engine (webjs, …)
app.use('/api/chats', chatRoutes);
app.use('/api/messages', messageLimiter, messageRoutes);
app.use('/api/attribution', attributionRoutes); // "who sent what" audit log
app.use('/api/crm', crmRoutes); // CRM contact lookup + create (dual naming)
app.use('/api/wa-contacts', waContactsRoutes); // save a number to WhatsApp's own contacts
app.use('/api/access', accessRoutes); // per-user send-access allow-list (admin-only)

// Centralised error handler. Expected 4xx (e.g. the 409 "not connected" case,
// route-level 400s) pass their message through; 5xx return a generic message
// so internal library/exception detail is never leaked to the client.
app.use((err: Error & { status?: number }, _req: Request, res: Response, _next: NextFunction) => {
  const status = err.status ?? 500;
  if (status >= 500) console.error('[api] error:', err);
  const message = status >= 500 ? 'Internal server error' : err.message ?? 'Error';
  res.status(status).json({ error: message });
});

const httpServer = createServer(app);
const io = initSocket(httpServer);

// Send the current session state to any frontend the moment it connects.
// Admins join the "admins" room (they alone receive the QR) and get it in status.
io.on('connection', (socket) => {
  const isAdmin = (socket.data as { isAdmin?: boolean }).isAdmin === true;
  if (isAdmin) socket.join('admins');
  socket.emit(SocketEvents.SessionStatus, session.getStatus(isAdmin));
});

// Disconnect sockets whose CRM access is revoked mid-session.
startSocketRevalidation();

// Bridge multi-engine session events (WhatsApp Web JS, …) to the frontend,
// tagged with the sessionId. The QR goes to admins only; everything else to all.
manager.onEvent((sessionId, event, payload) => {
  // Every socket is CRM-authenticated, so emit to all — this reliably delivers
  // the QR to the admin who opened the session (no admin-room timing race).
  emitToAll('session:event', { sessionId, type: event, payload });
});

/**
 * A linked session persists as a Chromium profile at `<tokenFolder>/<session>`.
 * If one exists we can reconnect on boot with no QR re-scan.
 */
function hasSavedSession(): boolean {
  try {
    const dir = path.resolve(config.tokenFolder, config.session);
    return fs.existsSync(dir) && fs.readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

/**
 * Reconnect multi-engine sessions that were linked before the last shutdown.
 *
 * The manager persists session METADATA, and `ensure()` rebuilds an engine object
 * on demand — but a rebuilt engine is inert until `start()` runs, and nothing else
 * calls it at boot. Without this, a reboot leaves every linked session listed in
 * the UI but DISCONNECTED, which is indistinguishable from the "no chats" failure.
 * That matters on a box meant to run unattended: no one is there to click Connect.
 */
function resumeSavedEngineSessions(): void {
  // wppconnect sessions still run on the legacy singleton resumed just above;
  // only webjs sessions are owned by the manager today.
  const resumable = manager.list().filter((m) => m.kind === 'webjs' && hasSavedWebJsSession(m.id));
  if (!resumable.length) return;

  resumable.forEach((meta, i) => {
    // Stagger the launches: each start() spawns a Chromium, and firing them all at
    // once competes with everything else Windows is doing in the first seconds of boot.
    setTimeout(() => {
      const engine = manager.ensure(meta.id);
      if (!engine) return;
      console.log(`[manager] resuming saved session ${meta.id} ("${meta.label}") — no QR needed…`);
      engine.start().catch((e) => console.error(`[manager] resume failed for ${meta.id}:`, e));
    }, i * 5000);
  });
}

httpServer.listen(config.port, config.host, () => {
  console.log(`\n  wpp-backend ready`);
  console.log(`  ├─ REST:   http://localhost:${config.port}/api`);
  console.log(`  ├─ Socket: ws://localhost:${config.port}`);
  console.log(`  └─ Session: "${config.session}" (headless: ${config.headless})\n`);

  if (config.host === '0.0.0.0' && !config.apiKey) {
    console.warn(
      '  ⚠  Bound to 0.0.0.0 (LAN-reachable) with NO API_KEY set — anyone on the\n' +
      '     network can control this WhatsApp account. Set API_KEY (and VITE_API_KEY\n' +
      '     on the frontend) before exposing beyond localhost.\n',
    );
  }

  // Auto-resume a previously linked session so it stays alive across restarts
  // and is immediately available to any browser/machine hitting this backend.
  if (config.autoStart && hasSavedSession()) {
    console.log('[wpp] saved session found — auto-resuming (no QR needed)…');
    session.start().catch((e) => console.error('[wpp] auto-resume failed:', e));
  }

  if (config.autoStart) resumeSavedEngineSessions();
});

// Graceful shutdown: close the browser but DO NOT log out (logout would
// invalidate the WhatsApp link and force a QR re-scan on the next start).
let shuttingDown = false;
const shutdown = async (signal: string) => {
  if (shuttingDown) return; // a second signal must not race the first teardown
  shuttingDown = true;
  console.log(`\n[wpp-backend] received ${signal}, shutting down (session preserved)…`);
  try {
    await session.disconnect();
  } catch {
    /* ignore */
  }
  // Close the multi-engine sessions too. This was missing: only the legacy
  // singleton was being torn down, so every webjs Chromium was killed with the
  // process instead of closing cleanly — the one thing most likely to corrupt an
  // auth profile and force a QR re-scan after a restart.
  try {
    await manager.shutdownAll();
  } catch {
    /* ignore */
  }
  httpServer.close(() => process.exit(0));
  // Chromium needs longer than the old 3s to flush its profile; exiting early
  // would reintroduce exactly the abrupt kill this teardown exists to avoid.
  setTimeout(() => process.exit(0), 15_000).unref();
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
// tsx watch restarts and Windows console closes arrive as SIGHUP/SIGBREAK, not
// SIGTERM. Without these, an editor-triggered reload skips the teardown above.
process.on('SIGHUP', () => void shutdown('SIGHUP'));
process.on('SIGBREAK', () => void shutdown('SIGBREAK'));
