/**
 * Send-access allow-list: which CRM users (by email) may SEND messages, beyond
 * the device admins. Admins can always send; this grants send permission to
 * specific non-admin users. Persisted to a small JSON file under the data dir.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config';

export interface AccessEntry {
  email: string;
  addedBy?: string;
  addedAt: number;
}

const file = () => path.resolve(config.dataFolder, 'send-access.json');
const norm = (e: string | undefined | null) => (e || '').trim().toLowerCase();

let cache: AccessEntry[] | null = null;

function load(): AccessEntry[] {
  if (cache) return cache;
  try {
    const arr = JSON.parse(fs.readFileSync(file(), 'utf8'));
    cache = Array.isArray(arr)
      ? arr.filter((e) => e && typeof e.email === 'string').map((e) => ({ ...e, email: norm(e.email) }))
      : [];
  } catch {
    cache = [];
  }
  return cache;
}

function save(): void {
  try {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), JSON.stringify(cache ?? [], null, 2));
  } catch (e) {
    console.warn('[access] save failed:', (e as Error).message);
  }
}

/** Is this email on the send allow-list? */
export function hasSendAccess(email: string | undefined | null): boolean {
  const e = norm(email);
  if (!e) return false;
  return load().some((x) => x.email === e);
}

/** The full allow-list (sorted by email). */
export function listAccess(): AccessEntry[] {
  return [...load()].sort((a, b) => a.email.localeCompare(b.email));
}

/** Grant send access to an email (idempotent). */
export function grantAccess(email: string, addedBy?: string): AccessEntry {
  const e = norm(email);
  const list = load();
  let entry = list.find((x) => x.email === e);
  if (!entry) {
    entry = { email: e, addedBy: norm(addedBy) || undefined, addedAt: Date.now() };
    list.push(entry);
    save();
  }
  return entry;
}

/** Revoke an email's send access. */
export function revokeAccess(email: string): void {
  const e = norm(email);
  const list = load();
  const idx = list.findIndex((x) => x.email === e);
  if (idx >= 0) {
    list.splice(idx, 1);
    save();
  }
}

// ── view-all allow-list ─────────────────────────────────────────────────────
// By default non-admins only see leads/chats ALLOTTED (assigned) to them. Emails
// on this list are allowed to see ALL leads/chats (like admins do). Admins are
// always "view all" regardless of this list.
const viewAllFile = () => path.resolve(config.dataFolder, 'view-all.json');
let viewAllCache: AccessEntry[] | null = null;

function loadViewAll(): AccessEntry[] {
  if (viewAllCache) return viewAllCache;
  try {
    const arr = JSON.parse(fs.readFileSync(viewAllFile(), 'utf8'));
    viewAllCache = Array.isArray(arr)
      ? arr.filter((e) => e && typeof e.email === 'string').map((e) => ({ ...e, email: norm(e.email) }))
      : [];
  } catch {
    viewAllCache = [];
  }
  return viewAllCache;
}

function saveViewAll(): void {
  try {
    fs.mkdirSync(path.dirname(viewAllFile()), { recursive: true });
    fs.writeFileSync(viewAllFile(), JSON.stringify(viewAllCache ?? [], null, 2));
  } catch (e) {
    console.warn('[access] view-all save failed:', (e as Error).message);
  }
}

/** Is this email allowed to see ALL leads/chats (not just their allotted ones)? */
export function hasViewAll(email: string | undefined | null): boolean {
  const e = norm(email);
  if (!e) return false;
  return loadViewAll().some((x) => x.email === e);
}

/** The full view-all list (sorted by email). */
export function listViewAll(): AccessEntry[] {
  return [...loadViewAll()].sort((a, b) => a.email.localeCompare(b.email));
}

/** Grant view-all to an email (idempotent). */
export function grantViewAll(email: string, addedBy?: string): AccessEntry {
  const e = norm(email);
  const list = loadViewAll();
  let entry = list.find((x) => x.email === e);
  if (!entry) {
    entry = { email: e, addedBy: norm(addedBy) || undefined, addedAt: Date.now() };
    list.push(entry);
    saveViewAll();
  }
  return entry;
}

/** Revoke an email's view-all (back to allotted-only). */
export function revokeViewAll(email: string): void {
  const e = norm(email);
  const list = loadViewAll();
  const idx = list.findIndex((x) => x.email === e);
  if (idx >= 0) {
    list.splice(idx, 1);
    saveViewAll();
  }
}
