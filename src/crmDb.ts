import postgres from 'postgres';
import { config } from './config';

/**
 * Read-only access to the CRM's Postgres (same DB as the CRM) to re-check a
 * user's live revocation state — so a CRM logout / password reset / disable /
 * delete invalidates this app's access within `authCacheMs`, not the token's
 * 7-day expiry.
 */
export interface UserAuthState {
  exists: boolean;
  isDisabled: boolean;
  tokenVersion: string;
}

let sql: ReturnType<typeof postgres> | null = null;
function getSql(): ReturnType<typeof postgres> | null {
  if (!config.databaseUrl) return null;
  if (!sql) {
    // Match the CRM's Supavisor-pooler-safe settings (tx-mode requires prepare:false).
    sql = postgres(config.databaseUrl, {
      prepare: false,
      max: 2,
      idle_timeout: 20,
      connect_timeout: 10,
      onnotice: () => undefined,
    });
  }
  return sql;
}

/** Quoted, schema-qualified table (schema comes from trusted env, not user input). */
function tbl(name: string): string {
  return config.dbSchema === 'public' ? `"${name}"` : `"${config.dbSchema}"."${name}"`;
}

interface CacheEntry {
  state: UserAuthState;
  at: number;
}
const cache = new Map<string, CacheEntry>();

/**
 * Current disabled/tokenVersion for a CRM user (or superadmin), cached briefly.
 * Returns `null` on DB error/unavailability so the caller can fail open (the JWT
 * itself is still cryptographically valid).
 */
export async function getUserAuthState(
  userId: string,
  isSuperadmin: boolean,
): Promise<UserAuthState | null> {
  const key = `${isSuperadmin ? 'sa' : 'u'}:${userId}`;
  const now = Date.now();
  const cached = cache.get(key);
  if (cached && now - cached.at < config.authCacheMs) return cached.state;

  const db = getSql();
  if (!db) return null;

  try {
    let state: UserAuthState;
    if (isSuperadmin) {
      const rows = await db.unsafe(
        `SELECT token_version FROM ${tbl('superadmins')} WHERE id = $1 LIMIT 1`,
        [userId],
      );
      state = rows.length
        ? { exists: true, isDisabled: false, tokenVersion: String(rows[0].token_version ?? '0') }
        : { exists: false, isDisabled: false, tokenVersion: '0' };
    } else {
      const rows = await db.unsafe(
        `SELECT is_disabled, token_version FROM ${tbl('users')} WHERE id = $1 LIMIT 1`,
        [userId],
      );
      state = rows.length
        ? {
            exists: true,
            isDisabled: !!rows[0].is_disabled,
            tokenVersion: String(rows[0].token_version ?? '0'),
          }
        : { exists: false, isDisabled: false, tokenVersion: '0' };
    }
    cache.set(key, { state, at: now });
    return state;
  } catch (e) {
    console.warn('[crmDb] revocation lookup failed (failing open):', (e as Error).message);
    return null;
  }
}
