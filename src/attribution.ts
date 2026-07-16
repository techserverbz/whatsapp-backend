/**
 * Embedded Postgres store (PGlite: real Postgres compiled to WASM, in-process,
 * persisted to disk) that powers two things for the WhatsApp app:
 *
 *  1. SENDER ATTRIBUTION (`sent_messages`) — which CRM-logged-in user sent each
 *     outbound message. Engine-agnostic: both the WPPConnect ("WWP") and the
 *     WhatsApp Web JS send paths funnel through the REST routes where the
 *     authenticated CRM user (`req.crmUser`) is known, so one `recordSent()`
 *     attributes messages identically across every engine.
 *
 *  2. MESSAGE CACHE (`cached_messages`) — every message the app loads is
 *     upserted here so the DB acts as a durable cache of the conversation
 *     history (survives restarts / engine history eviction), keyed by session.
 *
 * Design rules:
 *  - Best-effort & isolated: a failure here must NEVER break sending or loading
 *    messages. Every path swallows its own errors (logs a warning, no throw).
 */
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { config } from './config';
import { emitToAll, SocketEvents } from './socket';

export type EngineKind = 'wppconnect' | 'webjs';

/** The CRM identity that sent a message (from the verified `crm_token`). */
export interface MessageSender {
  userId: string;
  email?: string;
  /** Display name, when resolvable (falls back to email on the client). */
  name?: string;
  role?: string;
  /** When it was sent (epoch ms). */
  at: number;
}

/** A single outbound-send attribution record. */
export interface SentRecord {
  messageId: string;
  chatId: string;
  engine: EngineKind;
  sessionId: string;
  user: { userId: string; email?: string; name?: string; role?: string } | null | undefined;
  body?: string;
  hasMedia?: boolean;
}

/** Minimal shape of a message DTO needed for caching / sender lookup. */
export interface CacheableMessage {
  id: string;
  chatId: string;
  fromMe: boolean;
  timestamp?: number;
}

let dbPromise: Promise<PGlite> | null = null;

/** Lazily open (and migrate) the embedded Postgres. Retries on a failed open. */
async function getDb(): Promise<PGlite> {
  if (!dbPromise) {
    dbPromise = (async () => {
      const dir = path.resolve(config.dataFolder, 'attribution');
      const db = new PGlite(dir);
      await db.exec(`
        CREATE TABLE IF NOT EXISTS sent_messages (
          message_id  TEXT PRIMARY KEY,
          chat_id     TEXT NOT NULL DEFAULT '',
          engine      TEXT NOT NULL,
          session_id  TEXT NOT NULL DEFAULT '',
          crm_user_id TEXT NOT NULL,
          crm_email   TEXT,
          crm_name    TEXT,
          crm_role    TEXT,
          body        TEXT,
          has_media   BOOLEAN NOT NULL DEFAULT FALSE,
          created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        ALTER TABLE sent_messages ADD COLUMN IF NOT EXISTS crm_name TEXT;
        CREATE INDEX IF NOT EXISTS sent_messages_chat_idx ON sent_messages (chat_id);
        CREATE INDEX IF NOT EXISTS sent_messages_user_idx ON sent_messages (crm_user_id);
        CREATE INDEX IF NOT EXISTS sent_messages_created_idx ON sent_messages (created_at DESC);

        CREATE TABLE IF NOT EXISTS cached_messages (
          session_id TEXT NOT NULL,
          message_id TEXT NOT NULL,
          chat_id    TEXT NOT NULL DEFAULT '',
          from_me    BOOLEAN NOT NULL DEFAULT FALSE,
          ts         BIGINT NOT NULL DEFAULT 0,
          dto        JSONB NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          PRIMARY KEY (session_id, message_id)
        );
        CREATE INDEX IF NOT EXISTS cached_messages_chat_idx ON cached_messages (session_id, chat_id, ts);
      `);
      console.log('[attribution] embedded Postgres (PGlite) ready at', dir);
      return db;
    })().catch((e) => {
      console.error('[attribution] init failed (store disabled until next call):', e);
      dbPromise = null; // let a later call retry the open
      throw e;
    });
  }
  return dbPromise;
}

/**
 * Record who sent an outbound message. Fire-and-forget: returns immediately and
 * never throws, so the send path is untouched by attribution failures. No-ops
 * when there is no message id or no CRM user (e.g. legacy API-key mode).
 */
export function recordSent(rec: SentRecord): void {
  const uid = rec.user?.userId;
  if (!rec.messageId || !uid) return;

  // Broadcast the sender to EVERY connected client immediately, so anyone
  // watching the chat live (not just the person who sent it) sees the correct
  // "sent by" name without reloading. This carries the full identity from the
  // authenticated request — no DB round-trip, so there's no read-after-write
  // race. Clients patch the matching message by id (buffering if it hasn't
  // arrived yet). Best-effort: never let a socket hiccup break sending.
  try {
    emitToAll(SocketEvents.MessageSender, {
      id: rec.messageId,
      chatId: rec.chatId ?? '',
      sentBy: {
        userId: uid,
        email: rec.user?.email,
        name: rec.user?.name,
        role: rec.user?.role,
        at: Date.now(),
      },
    });
  } catch (e) {
    console.warn('[attribution] sender broadcast failed:', (e as Error).message);
  }

  void (async () => {
    try {
      const db = await getDb();
      await db.query(
        `INSERT INTO sent_messages
           (message_id, chat_id, engine, session_id, crm_user_id, crm_email, crm_name, crm_role, body, has_media)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (message_id) DO NOTHING`,
        [
          rec.messageId,
          rec.chatId ?? '',
          rec.engine,
          rec.sessionId ?? '',
          uid,
          rec.user?.email ?? null,
          rec.user?.name ?? null,
          rec.user?.role ?? null,
          (rec.body ?? '').slice(0, 500),
          !!rec.hasMedia,
        ],
      );
    } catch (e) {
      console.warn('[attribution] record failed:', (e as Error).message);
    }
  })();
}

/**
 * Persist a batch of loaded messages into the durable cache (DB-as-cache), keyed
 * by session. Fire-and-forget & best-effort. Upserts so re-loading a chat keeps
 * the cache fresh (ack/status changes) without duplicating rows.
 */
export function cacheMessages(sessionId: string, msgs: CacheableMessage[]): void {
  const rows = (msgs || []).filter((m) => m && m.id);
  if (!sessionId || !rows.length) return;
  void (async () => {
    try {
      const db = await getDb();
      const cols = 6;
      const placeholders = rows
        .map((_, i) => `($${i * cols + 1},$${i * cols + 2},$${i * cols + 3},$${i * cols + 4},$${i * cols + 5},$${i * cols + 6})`)
        .join(',');
      const params = rows.flatMap((m) => [
        sessionId,
        m.id,
        m.chatId ?? '',
        !!m.fromMe,
        Math.floor(Number(m.timestamp) || 0),
        JSON.stringify(m),
      ]);
      await db.query(
        `INSERT INTO cached_messages (session_id, message_id, chat_id, from_me, ts, dto)
         VALUES ${placeholders}
         ON CONFLICT (session_id, message_id) DO UPDATE SET
           chat_id = EXCLUDED.chat_id,
           from_me = EXCLUDED.from_me,
           ts = EXCLUDED.ts,
           dto = EXCLUDED.dto,
           updated_at = now()`,
        params,
      );
    } catch (e) {
      console.warn('[attribution] cacheMessages failed:', (e as Error).message);
    }
  })();
}

interface SenderRow {
  message_id: string;
  crm_user_id: string;
  crm_email: string | null;
  crm_name: string | null;
  crm_role: string | null;
  created_at: string;
}

/** Look up the CRM sender for a batch of message ids. */
export async function getSenders(ids: string[]): Promise<Map<string, MessageSender>> {
  const out = new Map<string, MessageSender>();
  const clean = ids.filter(Boolean);
  if (!clean.length) return out;
  try {
    const db = await getDb();
    const placeholders = clean.map((_, i) => `$${i + 1}`).join(',');
    const res = await db.query<SenderRow>(
      `SELECT message_id, crm_user_id, crm_email, crm_name, crm_role, created_at
         FROM sent_messages
        WHERE message_id IN (${placeholders})`,
      clean,
    );
    for (const r of res.rows) {
      out.set(r.message_id, {
        userId: r.crm_user_id,
        email: r.crm_email ?? undefined,
        name: r.crm_name ?? undefined,
        role: r.crm_role ?? undefined,
        at: new Date(r.created_at).getTime(),
      });
    }
  } catch (e) {
    console.warn('[attribution] getSenders failed:', (e as Error).message);
  }
  return out;
}

/** Single-message convenience over {@link getSenders}. */
export async function getSender(id: string): Promise<MessageSender | null> {
  const m = await getSenders([id]);
  return m.get(id) ?? null;
}

/**
 * Decorate a list of message DTOs (from ANY engine) with `sentBy`, the CRM user
 * who sent each outbound message, AND persist them to the durable cache. Only
 * `fromMe` messages get a `sentBy` lookup; incoming messages and messages sent
 * directly from the phone stay unattributed (the client shows "not tracked").
 */
export async function attachSenders<T extends CacheableMessage>(
  msgs: T[],
  sessionId?: string,
): Promise<(T & { sentBy?: MessageSender | null })[]> {
  if (sessionId) cacheMessages(sessionId, msgs);
  if (!msgs.length) return msgs;
  const ids = msgs.filter((m) => m.fromMe && m.id).map((m) => m.id);
  if (!ids.length) return msgs;
  const senders = await getSenders(ids);
  if (!senders.size) return msgs;
  return msgs.map((m) => (m.fromMe && senders.has(m.id) ? { ...m, sentBy: senders.get(m.id) } : m));
}

export interface SentAuditRow {
  message_id: string;
  chat_id: string;
  engine: string;
  session_id: string;
  crm_user_id: string;
  crm_email: string | null;
  crm_name: string | null;
  crm_role: string | null;
  body: string | null;
  has_media: boolean;
  created_at: string;
}

/** Most-recent sends across every engine — the "who sent what" audit log. */
export async function listRecent(limit = 100): Promise<SentAuditRow[]> {
  try {
    const db = await getDb();
    const res = await db.query<SentAuditRow>(
      `SELECT message_id, chat_id, engine, session_id, crm_user_id, crm_email, crm_name, crm_role, body, has_media, created_at
         FROM sent_messages
        ORDER BY created_at DESC
        LIMIT $1`,
      [Math.min(Math.max(limit, 1), 1000)],
    );
    return res.rows;
  } catch (e) {
    console.warn('[attribution] listRecent failed:', (e as Error).message);
    return [];
  }
}
