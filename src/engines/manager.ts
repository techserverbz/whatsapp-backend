/**
 * Session manager — the registry that lets many sessions (each backed by any
 * engine) coexist. It owns the live engine instances, persists lightweight
 * session metadata to disk, and fans every engine event out to a single
 * listener (the socket bridge) tagged with the sessionId.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config';
import type { EngineKind, SessionMeta, WhatsAppEngine } from './common/engine';
import { WebJsEngine } from './webjs/engine';

const META_FILE = path.resolve(config.dataFolder, 'sessions.json');

type Listener = (sessionId: string, event: string, payload: unknown) => void;

class SessionManager {
  private engines = new Map<string, WhatsAppEngine>();
  private meta = new Map<string, SessionMeta>();
  private listeners: Listener[] = [];

  constructor() {
    this.loadMeta();
  }

  private loadMeta(): void {
    try {
      const arr = JSON.parse(fs.readFileSync(META_FILE, 'utf8'));
      if (Array.isArray(arr)) for (const m of arr) if (m?.id) this.meta.set(m.id, m);
    } catch {
      /* no sessions yet */
    }
  }

  private saveMeta(): void {
    try {
      fs.mkdirSync(path.dirname(META_FILE), { recursive: true });
      fs.writeFileSync(META_FILE, JSON.stringify([...this.meta.values()], null, 2));
    } catch {
      /* best effort */
    }
  }

  /** Register the socket bridge (called once at boot). */
  onEvent(l: Listener): void {
    this.listeners.push(l);
  }

  private emit(id: string, event: string, payload: unknown): void {
    for (const l of this.listeners) l(id, event, payload);
  }

  private wire(engine: WhatsAppEngine): void {
    engine.on('status', (p) => this.emit(engine.id, 'status', p));
    engine.on('qr', (p) => this.emit(engine.id, 'qr', p));
    engine.on('message', (p) => this.emit(engine.id, 'message', p));
    engine.on('ack', (p) => this.emit(engine.id, 'ack', p));
  }

  private build(id: string, kind: EngineKind): WhatsAppEngine {
    if (kind === 'webjs') return new WebJsEngine(id);
    // wppconnect sessions currently run on the legacy singleton path; they will
    // move onto a WppConnectEngine here without changing this signature.
    throw new Error(`Engine "${kind}" is not registered in the manager.`);
  }

  list(): SessionMeta[] {
    return [...this.meta.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  get(id: string): WhatsAppEngine | undefined {
    return this.engines.get(id);
  }

  meta_(id: string): SessionMeta | undefined {
    return this.meta.get(id);
  }

  create(kind: EngineKind, label?: string): SessionMeta {
    const id = `${kind}-${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
    const meta: SessionMeta = {
      id,
      kind,
      label: label ?? (kind === 'webjs' ? 'WhatsApp Web JS' : 'WPPConnect'),
      createdAt: Date.now(),
    };
    this.meta.set(id, meta);
    this.saveMeta();
    const engine = this.build(id, kind);
    this.wire(engine);
    this.engines.set(id, engine);
    return meta;
  }

  /** Get (or lazily rebuild) the engine instance for a persisted session. */
  ensure(id: string): WhatsAppEngine | undefined {
    const existing = this.engines.get(id);
    if (existing) return existing;
    const m = this.meta.get(id);
    if (!m) return undefined;
    const engine = this.build(id, m.kind);
    this.wire(engine);
    this.engines.set(id, engine);
    return engine;
  }

  /**
   * Close every live engine's browser on process shutdown, keeping the WhatsApp
   * links intact. Without this the engines' Chromium processes are killed along
   * with the parent, which can corrupt an auth profile mid-write and cost a QR
   * re-scan. Never rejects: shutdown must proceed even if one engine misbehaves.
   */
  async shutdownAll(): Promise<void> {
    await Promise.all(
      [...this.engines.values()].map(async (engine) => {
        try {
          await engine.disconnect?.();
        } catch {
          /* best effort — keep closing the others */
        }
      }),
    );
  }

  async remove(id: string): Promise<void> {
    const engine = this.engines.get(id);
    if (engine) {
      try {
        await engine.logout();
      } catch {
        /* ignore */
      }
    }
    this.engines.delete(id);
    this.meta.delete(id);
    this.saveMeta();
  }
}

export const manager = new SessionManager();
