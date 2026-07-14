import fs from 'fs';
import path from 'path';
import { config } from './config';

/**
 * Durable per-chat notes store. Each chat holds a LIST of individual note
 * entries, each stamped with its creation time. Persisted to a JSON file so
 * notes survive refresh, logout and restarts, and sync across browsers/machines.
 */
export interface NoteEntry {
  id: string;
  text: string;
  createdAt: number;
}

type NotesMap = Record<string, NoteEntry[]>;

const notesFile = path.resolve(config.dataFolder, 'notes.json');
let cache: NotesMap | null = null;

function newId(): string {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function load(): NotesMap {
  if (cache) return cache;
  let raw: any = {};
  try {
    raw = fs.existsSync(notesFile) ? JSON.parse(fs.readFileSync(notesFile, 'utf-8')) : {};
  } catch {
    raw = {};
  }
  const map: NotesMap = {};
  for (const [chatId, val] of Object.entries(raw)) {
    if (Array.isArray(val)) {
      map[chatId] = val as NoteEntry[];
    } else if (val && typeof val === 'object' && typeof (val as any).text === 'string') {
      // migrate the old single-blob shape { text, updatedAt } into one entry
      const text = (val as any).text as string;
      if (text.trim()) {
        map[chatId] = [{ id: newId(), text, createdAt: (val as any).updatedAt || Date.now() }];
      }
    }
  }
  cache = map;
  return cache;
}

function persist(map: NotesMap): void {
  try {
    fs.mkdirSync(path.dirname(notesFile), { recursive: true });
    fs.writeFileSync(notesFile, JSON.stringify(map, null, 2), 'utf-8');
  } catch (e) {
    console.error('[notes] failed to persist:', e);
  }
}

export function getNotes(chatId: string): NoteEntry[] {
  return load()[chatId] ?? [];
}

/** Append a new timestamped note entry. Returns the full (chronological) list. */
export function addNote(chatId: string, text: string): NoteEntry[] {
  const map = load();
  const value = typeof text === 'string' ? text : '';
  if (value.trim() === '') return map[chatId] ?? [];
  const entry: NoteEntry = { id: newId(), text: value, createdAt: Date.now() };
  map[chatId] = [...(map[chatId] ?? []), entry];
  persist(map);
  return map[chatId];
}

/** Remove a single note entry by id. Returns the remaining list. */
export function deleteNote(chatId: string, noteId: string): NoteEntry[] {
  const map = load();
  const list = (map[chatId] ?? []).filter((n) => n.id !== noteId);
  if (list.length) map[chatId] = list;
  else delete map[chatId];
  persist(map);
  return map[chatId] ?? [];
}

/** Chat ids that currently have at least one note (for list indicators). */
export function getNoteChatIds(): string[] {
  const map = load();
  return Object.keys(map).filter((k) => (map[k]?.length ?? 0) > 0);
}
