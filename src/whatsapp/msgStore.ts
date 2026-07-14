import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config';
import type { MessageDTO } from './serializers';

/**
 * Durable, per-chat message archive on disk.
 *
 * WhatsApp linked devices (WhatsApp Web / WPPConnect) only keep a RECENT window
 * of history and won't backfill older messages on request. So we persist every
 * message we ever see — whether pushed live or pulled on fetch — into a growing
 * local archive. This survives reloads, avoids re-fetching from WhatsApp, and
 * (going forward) keeps history that outlives WhatsApp's own sync horizon.
 *
 * One JSON file per chat under `<WPP_DATA_FOLDER>/messages/<chatId>.json`,
 * kept sorted oldest -> newest and de-duplicated by message id.
 */
const DIR = path.resolve(config.dataFolder, 'messages');

function fileFor(chatId: string): string {
  // WhatsApp ids contain `@`, `.`, digits — sanitise anything else for the FS.
  const safe = chatId.replace(/[^a-zA-Z0-9._@-]/g, '_');
  return path.join(DIR, `${safe}.json`);
}

function readAll(chatId: string): MessageDTO[] {
  try {
    const arr = JSON.parse(fs.readFileSync(fileFor(chatId), 'utf8'));
    return Array.isArray(arr) ? arr : [];
  } catch {
    return []; // no archive yet, or unreadable — treat as empty
  }
}

function writeAll(chatId: string, msgs: MessageDTO[]): void {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(fileFor(chatId), JSON.stringify(msgs));
  } catch (e) {
    console.warn('[archive] write failed for', chatId, (e as Error)?.message);
  }
}

/**
 * Merge messages into the chat's archive (dedupe by id, keep the highest ack so
 * delivery/read ticks advance, sort oldest -> newest). Returns the full archive.
 */
export function archiveMessages(chatId: string, incoming: MessageDTO[]): MessageDTO[] {
  const existing = readAll(chatId);
  if (!incoming.length) return existing;

  const byId = new Map<string, MessageDTO>();
  for (const m of existing) byId.set(m.id, m);

  let changed = false;
  for (const m of incoming) {
    if (!m?.id) continue;
    const prev = byId.get(m.id);
    if (!prev) {
      byId.set(m.id, m);
      changed = true;
    } else if ((m.ack ?? 0) > (prev.ack ?? 0)) {
      byId.set(m.id, { ...prev, ...m });
      changed = true;
    }
  }

  const merged = [...byId.values()].sort((a, b) => a.timestamp - b.timestamp);
  if (changed) writeAll(chatId, merged);
  return merged;
}

/**
 * Read a window from the archive: the `count` messages immediately older than
 * `before` (exclusive), or the latest `count` when `before` is omitted.
 */
export function readArchive(chatId: string, count: number, before?: string): MessageDTO[] {
  const all = readAll(chatId);
  if (!all.length) return [];
  let end = all.length;
  if (before) {
    const idx = all.findIndex((m) => m.id === before);
    end = idx >= 0 ? idx : all.length; // strictly older than `before`
  }
  return all.slice(Math.max(0, end - count), end);
}

/** True if the archive already holds messages for this chat. */
export function hasArchive(chatId: string): boolean {
  return readAll(chatId).length > 0;
}
