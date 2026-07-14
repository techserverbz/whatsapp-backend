import type { Server as HttpServer } from 'http';
import { Server } from 'socket.io';
import { config, isAllowedOrigin } from './config';
import { authenticateToken, cookieFromHeader, isAdminUser, ssoEnabled } from './auth';

/**
 * Names of the events the server pushes to connected frontends.
 * Kept in one place so the frontend contract never drifts.
 */
export const SocketEvents = {
  SessionStatus: 'session:status',
  SessionQr: 'session:qr',
  MessageNew: 'message:new',
  MessageAck: 'message:ack',
  Call: 'call:incoming',
} as const;

let io: Server | null = null;

export function initSocket(httpServer: HttpServer): Server {
  io = new Server(httpServer, {
    cors: {
      origin: (origin, cb) => cb(null, isAllowedOrigin(origin)),
      methods: ['GET', 'POST'],
    },
  });

  // Handshake auth: when an API key is configured, every socket must present
  // it (via `auth.token` or the `x-api-key` header) before receiving any
  // events — otherwise it would leak the QR code and live message stream.
  io.use(async (socket, next) => {
    // WebSocket handshakes are NOT gated by browser CORS, so reject cross-site
    // browser origins server-side. A present-but-disallowed Origin = a page from
    // another website; an absent Origin = a non-browser client (allowed).
    const origin = socket.handshake.headers.origin;
    if (origin && !isAllowedOrigin(origin)) return next(new Error('Forbidden origin'));

    // CRM SSO: require a valid, non-revoked CRM login (cookie or auth.token).
    if (ssoEnabled()) {
      const cookieToken = cookieFromHeader(socket.handshake.headers.cookie, 'crm_token');
      const bearer = socket.handshake.auth?.token as string | undefined;
      const token = cookieToken ?? bearer;
      const user = await authenticateToken(token);
      if (!user) return next(new Error('Not authenticated'));
      socket.data.crmToken = token; // for periodic revalidation
      socket.data.isAdmin = isAdminUser(user); // gate QR to admins only
      return next();
    }

    if (!config.apiKey) return next();
    const key =
      (socket.handshake.auth?.token as string | undefined) ??
      (socket.handshake.headers['x-api-key'] as string | undefined);
    if (key === config.apiKey) return next();
    next(new Error('Unauthorized'));
  });

  return io;
}

/**
 * Periodically re-check connected sockets and disconnect any whose CRM access
 * was revoked mid-session (logout / disable / password reset). Handshake auth
 * only runs once, so this keeps long-lived sockets honest.
 */
export function startSocketRevalidation(intervalMs = 20_000): void {
  setInterval(async () => {
    if (!io || !ssoEnabled()) return;
    try {
      const sockets = await io.fetchSockets();
      for (const s of sockets) {
        const token = (s.data as { crmToken?: string }).crmToken;
        const user = await authenticateToken(token);
        if (!user) s.disconnect(true);
      }
    } catch {
      /* ignore sweep errors */
    }
  }, intervalMs).unref();
}

export function getIo(): Server {
  if (!io) throw new Error('Socket.io has not been initialised yet.');
  return io;
}

/** Broadcast an event to every connected frontend. No-op before init. */
export function emitToAll(event: string, payload: unknown): void {
  io?.emit(event, payload);
}

/** Emit only to admin (device-manager) sockets — used for the QR code. */
export function emitToAdmins(event: string, payload: unknown): void {
  io?.to('admins').emit(event, payload);
}
