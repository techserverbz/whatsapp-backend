import dotenv from 'dotenv';

dotenv.config();

const corsEnv = (process.env.CORS_ORIGIN ?? '').trim();

/** True for localhost and private/LAN hostnames (RFC1918 + .local). */
function isPrivateHost(host: string): boolean {
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return true;
  if (host.endsWith('.local')) return true;
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  return false;
}

/**
 * CORS policy. If CORS_ORIGIN is set, honour it exactly ("*" or a
 * comma-separated allow-list). Otherwise default to allowing localhost + any
 * private LAN address — so the app works from other devices on your network,
 * while still blocking arbitrary public websites (drive-by protection).
 */
export function isAllowedOrigin(origin?: string): boolean {
  if (!origin) return true; // same-origin / non-browser clients
  if (corsEnv === '*') return true;
  if (corsEnv) {
    return corsEnv
      .split(',')
      .map((s) => s.trim())
      .includes(origin);
  }
  try {
    return isPrivateHost(new URL(origin).hostname);
  } catch {
    return false;
  }
}

/**
 * Centralised, validated runtime configuration.
 *
 * Binds to all interfaces by default so the app is reachable from other devices
 * on your LAN (the WhatsApp session lives here and is shared by every client).
 * CORS allows localhost + private LAN by default; set API_KEY to require a
 * shared secret when you want to lock LAN access down (see README).
 */
export const config = {
  port: Number(process.env.PORT ?? 8099),
  /** Bind all interfaces so other devices on the LAN can reach the backend. */
  host: process.env.HOST ?? '0.0.0.0',
  /**
   * Optional shared secret. When set, REST calls must send `X-API-Key` and
   * Socket.io must send `auth.token`. Strongly recommended (required in
   * practice) whenever the server is exposed beyond localhost.
   */
  apiKey: (process.env.API_KEY ?? '').trim(),
  /**
   * Shared secret with the SAM CRM (same value as the CRM's JWT_SECRET). Used to
   * verify the CRM's `crm_token` cookie so only logged-in CRM users get in.
   * When set, CRM SSO is enforced on every route + socket.
   */
  jwtSecret: (process.env.JWT_SECRET ?? '').trim(),
  /**
   * Base URL of the SAM CRM backend. The WhatsApp backend proxies the inline
   * login form to `${crmApiUrl}/auth/login` (server-to-server, so no CORS), then
   * hands the resulting CRM `crm_token` back to the browser. No trailing slash.
   */
  crmApiUrl: (process.env.CRM_API_URL ?? 'https://sam-crm-be.vercel.app').trim().replace(/\/$/, ''),
  /** CRM database (same DB as the CRM) — used to re-check tokenVersion for instant revocation. */
  databaseUrl: (process.env.DATABASE_URL ?? '').trim(),
  dbSchema: (process.env.DB_SCHEMA ?? 'prod').trim(),
  /** How long (ms) to cache a user's revocation state before re-querying the DB. */
  authCacheMs: Number(process.env.AUTH_CACHE_MS ?? 15000),
  /**
   * Emails of the WhatsApp "device admins" — the only users who may connect/scan
   * a QR (choose which WhatsApp is linked) and log the session out. Everyone else
   * is a read-only viewer. If empty, admin falls back to the CRM superadmin role.
   */
  adminEmails: (process.env.WPP_ADMIN_EMAILS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
  /** Allow non-admin viewers to also SEND messages (they still can't manage the session). */
  allowViewerSend: (process.env.WPP_ALLOW_VIEWER_SEND ?? 'false').toLowerCase() === 'true',
  /** Cookie domain for clearing the CRM cookie on sign-out (prod: e.g. ".bhole.co"). */
  cookieDomain: (process.env.COOKIE_DOMAIN ?? '').trim(),
  /** Max upload body size in MB (base64 media). */
  maxUploadMb: Number(process.env.MAX_UPLOAD_MB ?? 32),
  /** WhatsApp session name — also the token folder key. */
  session: process.env.WPP_SESSION ?? 'wpp-standalone',
  /**
   * Where WPPConnect persists its auth tokens/profile so re-login is not needed.
   * Kept inside the project as `./wwp` (renamed from `./tokens`) so a copy of the
   * backend folder carries the WPPConnect session with it.
   */
  tokenFolder: process.env.WPP_TOKEN_FOLDER ?? './wwp',
  /** Where per-chat notes (and other app data) are persisted (survives logout). */
  dataFolder: process.env.WPP_DATA_FOLDER ?? './data',
  /** Headless puppeteer. Set WPP_HEADLESS=false to watch the browser. */
  headless: (process.env.WPP_HEADLESS ?? 'true').toLowerCase() !== 'false',
  /**
   * Auto-resume a previously linked session on server boot (no QR re-scan),
   * so the same session is instantly available to any browser/machine that
   * connects to this backend. Set WPP_AUTO_START=false to require a manual
   * "Connect" click instead.
   */
  autoStart: (process.env.WPP_AUTO_START ?? 'true').toLowerCase() !== 'false',
} as const;

export type AppConfig = typeof config;
