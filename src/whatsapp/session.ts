import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { create as createSession } from '@wppconnect-team/wppconnect';
import type { Whatsapp } from '@wppconnect-team/wppconnect';
import { config } from '../config';
import { emitToAdmins, emitToAll, SocketEvents } from '../socket';
import { serializeMessage } from './serializers';
import { cacheMessages } from './msgCache';
import { archiveMessages } from './msgStore';

/**
 * Kill any Chromium still holding THIS session's profile folder — scoped to the
 * exact userDataDir path so it can never touch another app's browser (e.g. a
 * separate production instance sharing the session name). A previous session
 * that crashed, timed out, or was force-killed can leave the profile locked;
 * without this, the next start() fails with "browser is already running" and the
 * UI shows "Connection failed" instead of a fresh QR.
 */
function killStaleBrowser(): Promise<void> {
  const profileDir = path.resolve(config.tokenFolder, config.session);
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      const psScript =
        "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | " +
        "Where-Object { $_.CommandLine -like '*" + profileDir + "*' } | " +
        'ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }';
      execFile(
        'powershell',
        ['-NoProfile', '-NonInteractive', '-Command', psScript],
        () => resolve(),
      );
    } else {
      // Linux/macOS: match Chromium launched with this user-data-dir.
      execFile('pkill', ['-f', `--user-data-dir=${profileDir}`], () => resolve());
    }
  });
}

/**
 * Delete the session's on-disk profile so the next start() is pristine and shows
 * a fresh QR. Used after a full logout: WhatsApp Web left in a half-logged-out
 * state otherwise "auto-closes" on reconnect instead of showing the QR code.
 */
async function clearSessionProfile(): Promise<void> {
  const dir = path.resolve(config.tokenFolder, config.session);
  // Chromium releases its file locks a beat after the process is killed, so on
  // Windows the first rm often fails with EBUSY. Retry a few times.
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      await fs.promises.rm(dir, { recursive: true, force: true });
      if (!fs.existsSync(dir)) return;
    } catch {
      /* locked — wait for handles to release and retry */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

export type SessionState =
  | 'DISCONNECTED'
  | 'INITIALIZING'
  | 'QRCODE'
  | 'AUTHENTICATED'
  | 'CONNECTED'
  | 'LOGGED_OUT'
  | 'FAILED';

export interface HostDevice {
  wid: string;
  phone?: string;
  pushname?: string;
  platform?: string;
}

export interface SessionStatus {
  state: SessionState;
  connected: boolean;
  qr: string | null;
  me: HostDevice | null;
}

/** Message types we forward to the frontend in real time. */
const RENDERABLE_TYPES = new Set([
  'chat',
  'image',
  'video',
  'audio',
  'ptt',
  'document',
  'sticker',
  'location',
  'vcard',
  'multi_vcard',
]);

/**
 * Owns the single WhatsApp connection and its lifecycle.
 *
 * The server boots without a live browser: nothing happens until `start()`
 * is called (typically from the frontend "Connect" button). All state
 * transitions are broadcast over Socket.io so the UI stays in sync.
 */
class WppSession {
  private client: Whatsapp | null = null;
  private state: SessionState = 'DISCONNECTED';
  private qr: string | null = null;
  private me: HostDevice | null = null;
  private starting = false;

  getStatus(includeQr = true): SessionStatus {
    return {
      state: this.state,
      connected: this.state === 'CONNECTED',
      qr: includeQr ? this.qr : null, // QR is admin-only (scanning it links a device)
      me: this.me,
    };
  }

  isConnected(): boolean {
    return this.state === 'CONNECTED' && this.client !== null;
  }

  /** Returns the live client or throws a 409 the routes translate to JSON. */
  getClient(): Whatsapp {
    if (!this.client || this.state !== 'CONNECTED') {
      const err = new Error(
        'WhatsApp session is not connected. Start a session and scan the QR code first.',
      ) as Error & { status?: number };
      err.status = 409;
      throw err;
    }
    return this.client;
  }

  private setState(state: SessionState): void {
    this.state = state;
    emitToAll(SocketEvents.SessionStatus, this.getStatus(false)); // no QR in broadcast
  }

  /**
   * Kicks off a session. Idempotent and non-blocking: it fires the
   * WPPConnect bootstrap and returns immediately — progress arrives through
   * `catchQR` / `statusFind` / the resolved client via Socket.io events.
   */
  async start(): Promise<void> {
    if (this.client || this.starting) return;
    this.starting = true;
    this.qr = null;
    this.me = null;
    this.setState('INITIALIZING');

    // A crashed/timed-out/force-killed previous browser can still hold this
    // profile's lock. Clear it first so reconnect always gets a clean launch
    // (and therefore a fresh QR) instead of failing with "browser already running".
    await killStaleBrowser();

    this.bootstrap().catch(async (err) => {
      // A stale lock or a transient launch race shouldn't surface as
      // "Connection failed" when a clean retry succeeds. Clean up and try once more.
      console.warn('[wpp] start failed, retrying once:', (err as Error)?.message);
      await killStaleBrowser();
      await new Promise((r) => setTimeout(r, 1500));
      this.bootstrap().catch((err2) => {
        console.error('[wpp] session bootstrap failed:', err2);
        this.starting = false;
        this.setState('FAILED');
      });
    });
  }

  /** A single WPPConnect launch. Resolves once connected; rejects on launch failure. */
  private bootstrap(): Promise<void> {
    return createSession({
      session: config.session,
      headless: config.headless,
      folderNameToken: config.tokenFolder,
      tokenStore: 'file',
      autoClose: 0, // keep the QR alive until the user scans it
      disableWelcome: true,
      updatesLog: false,
      logQR: false,
      puppeteerOptions: {
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      },
      catchQR: (base64Qr, _asciiQR, attempts, urlCode) => {
        this.qr = base64Qr;
        this.state = 'QRCODE';
        emitToAdmins(SocketEvents.SessionQr, { base64Qr, urlCode, attempts }); // admins only
        emitToAll(SocketEvents.SessionStatus, this.getStatus(false));
      },
      statusFind: (statusSession) => {
        console.log('[wpp] statusFind:', statusSession);
        if (['qrReadSuccess', 'isLogged', 'inChat', 'chatsAvailable'].includes(statusSession)) {
          if (this.state !== 'CONNECTED') this.setState('AUTHENTICATED');
        }
        if (
          ['desconnectedMobile', 'deviceNotConnected', 'browserClose', 'serverClose'].includes(
            statusSession,
          )
        ) {
          this.handleDisconnect();
        }
      },
    }).then((client) => this.onReady(client));
  }

  private async onReady(client: Whatsapp): Promise<void> {
    this.client = client;
    this.starting = false;
    this.qr = null;
    this.me = await this.fetchHost(client);
    this.registerListeners(client);
    this.setState('CONNECTED');
    console.log('[wpp] session connected as', this.me?.wid ?? 'unknown');
  }

  private async fetchHost(client: Whatsapp): Promise<HostDevice | null> {
    try {
      const wid = await (client as any).getWid();
      const serialized: string | undefined =
        typeof wid === 'string' ? wid : wid?._serialized;

      let host: any = {};
      try {
        host = await (client as any).getHostDevice();
      } catch {
        /* older/newer versions may not expose this — ignore */
      }

      return {
        wid: serialized ?? '',
        phone: serialized ? serialized.split('@')[0] : undefined,
        pushname: host?.pushname,
        platform: host?.platform,
      };
    } catch (e) {
      console.warn('[wpp] could not resolve host device:', e);
      return null;
    }
  }

  private registerListeners(client: Whatsapp): void {
    // Fires for BOTH incoming and outgoing messages -> keeps every device in sync.
    client.onAnyMessage((message: any) => {
      try {
        cacheMessages([message]); // so freshly-received media can be decrypted
        if (!RENDERABLE_TYPES.has(message?.type)) return;
        const dto = serializeMessage(message);
        if (dto.chatId && dto.id) archiveMessages(dto.chatId, [dto]); // durable history
        emitToAll(SocketEvents.MessageNew, dto);
      } catch (e) {
        console.warn('[wpp] failed to serialize incoming message:', e);
      }
    });

    client.onStateChange((stateStr: string) => {
      console.log('[wpp] onStateChange:', stateStr);
      if (stateStr === 'CONNECTED' && this.client && this.state !== 'CONNECTED') {
        this.setState('CONNECTED');
      }
      if (['UNPAIRED', 'UNPAIRED_IDLE', 'CONFLICT', 'DEPRECATED_VERSION'].includes(stateStr)) {
        this.handleDisconnect();
      }
    });

    try {
      (client as any).onIncomingCall((call: any) => {
        emitToAll(SocketEvents.Call, {
          id: call?.id,
          from: call?.peerJid ?? call?.sender,
          isVideo: !!call?.isVideo,
        });
      });
    } catch {
      /* onIncomingCall not available in this version — non-fatal */
    }

    // Delivery/read acknowledgements: keep the message ticks live
    // (1 = sent, 2 = delivered, 3 = read).
    try {
      (client as any).onAck((ack: any) => {
        try {
          const rawId = ack?.id;
          const id = typeof rawId === 'string' ? rawId : rawId?._serialized;
          if (!id) return;
          const to = ack?.to;
          const chatId = typeof to === 'string' ? to : to?._serialized;
          emitToAll(SocketEvents.MessageAck, { id, ack: ack?.ack ?? 0, chatId });
        } catch {
          /* ignore malformed ack */
        }
      });
    } catch {
      /* onAck not available — ticks will just stay at their initial state */
    }
  }

  private handleDisconnect(): void {
    const client = this.client;
    this.client = null;
    this.starting = false;
    this.me = null;
    this.qr = null;
    // Best-effort close so an automatic disconnect never orphans Chromium.
    if (client) void client.close().catch(() => undefined);
    this.setState('DISCONNECTED');
  }

  /**
   * Close the browser WITHOUT invalidating the WhatsApp link. Used on process
   * shutdown so the next start silently resumes the persisted session
   * (do NOT call client.logout() here — that unlinks the device).
   */
  async disconnect(): Promise<void> {
    const client = this.client;
    this.client = null;
    this.starting = false;
    this.qr = null;
    if (client) {
      try {
        await client.close();
      } catch {
        /* ignore */
      }
    }
    this.state = 'DISCONNECTED';
  }

  /** Fully logs out (invalidates the WhatsApp link) and clears local state. */
  async logout(): Promise<void> {
    const client = this.client;
    if (client) {
      try {
        await client.logout();
      } catch (e) {
        console.warn('[wpp] logout error:', e);
      }
      try {
        await client.close();
      } catch {
        /* ignore */
      }
    }
    this.client = null;
    this.starting = false;
    this.me = null;
    this.qr = null;
    // Make sure the browser is gone, then wipe the profile so the next connect
    // starts fresh and shows a QR (instead of auto-closing on a stale session).
    await killStaleBrowser();
    await clearSessionProfile();
    this.setState('LOGGED_OUT');
  }
}

export const session = new WppSession();
