/**
 * whatsapp-web.js engine adapter.
 *
 * Wraps a per-session whatsapp-web.js `Client` (isolated LocalAuth dir) and maps
 * everything onto v2's unified ChatDTO / MessageDTO so the existing UI + media
 * pipeline work unchanged. Its `getMessages` uses `chat.fetchMessages({limit})`,
 * which back-loads older history from the phone — the reason this engine exists.
 */
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client, LocalAuth, MessageMedia } from 'whatsapp-web.js';
import qrcode from 'qrcode';
import { config } from '../../config';
import type { ChatDTO, MessageDTO } from '../../whatsapp/serializers';
import type {
  ContactInfo,
  EngineStatus,
  HostDevice,
  MediaResult,
  SendFileOpts,
  SessionState,
  WhatsAppEngine,
} from '../common/engine';

/**
 * Base dir holding one LocalAuth Chromium profile per session.
 *
 * CRITICAL (Windows): keep this SHORT. Under a long project path, whatsapp-web.js's
 * deeply-nested profile files exceed the 260-char MAX_PATH limit, crashing the page
 * mid-injection with "Execution context was destroyed" so the QR never appears.
 * LocalAuth appends `session-<clientId>`, so this base must stay short.
 */
export function webJsDataPath(): string {
  return (
    process.env.WA_SESSION_PATH ||
    (process.platform === 'win32' ? 'C:\\wa-sessions' : path.join(os.homedir(), '.wa-sessions'))
  );
}

/**
 * True when `sessionId` has a LocalAuth profile on disk — i.e. it was linked once
 * and can reconnect with no QR re-scan. Boot-time resume is gated on this: calling
 * start() on a never-linked session would just spawn a Chromium to render a QR
 * nobody is watching.
 */
export function hasSavedWebJsSession(sessionId: string): boolean {
  try {
    const dir = path.join(webJsDataPath(), `session-${sessionId}`);
    return fs.existsSync(dir) && fs.readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

const MEDIA_TYPES = new Set(['image', 'video', 'audio', 'ptt', 'document', 'sticker']);

/** whatsapp-web.js message -> unified MessageDTO. */
function toMessageDTO(m: any): MessageDTO {
  const type: string = m?.type ?? 'chat';
  const hasMedia = !!m?.hasMedia || MEDIA_TYPES.has(type);
  const fromMe = !!m?.fromMe;
  const chatId: string = fromMe ? m?.to ?? '' : m?.from ?? '';
  const body: string = typeof m?.body === 'string' ? m.body : '';
  return {
    id: m?.id?._serialized ?? '',
    chatId,
    fromMe,
    author: m?.author || undefined,
    senderName: m?._data?.notifyName ?? undefined,
    type,
    body: type === 'chat' ? body : hasMedia ? body : body, // wwebjs puts caption in body
    caption: hasMedia ? body || undefined : undefined,
    timestamp: (m?.timestamp ?? 0) * 1000,
    hasMedia,
    mimetype: m?._data?.mimetype ?? undefined,
    filename: m?._data?.filename ?? undefined,
    isGroupMsg: chatId.endsWith('@g.us'),
    ack: typeof m?.ack === 'number' ? m.ack : 0,
    quotedMsgId: m?._data?.quotedStanzaID ?? undefined,
  };
}

/** whatsapp-web.js chat -> unified ChatDTO. */
function toChatDTO(c: any): ChatDTO {
  const id: string = c?.id?._serialized ?? '';
  const last = c?.lastMessage;
  const isGroup = !!c?.isGroup;
  return {
    id,
    name: c?.name || (id ? id.split('@')[0] : 'Unknown'),
    isGroup,
    unreadCount: c?.unreadCount ?? 0,
    timestamp: (c?.timestamp ?? 0) * 1000,
    pinned: !!c?.pinned,
    archived: !!c?.archived,
    muted: !!c?.isMuted,
    lastMessage: last ? previewOf(last) : '',
    lastMessageFromMe: !!last?.fromMe,
    // @c.us ids contain the number; @lid ids are resolved in listChats().
    number:
      !isGroup && (id.endsWith('@c.us') || id.endsWith('@s.whatsapp.net'))
        ? id.split('@')[0]
        : undefined,
  };
}

function previewOf(m: any): string {
  switch (m?.type) {
    case 'image': return '📷 Photo';
    case 'video': return '🎞️ Video';
    case 'ptt': return '🎤 Voice message';
    case 'audio': return '🎵 Audio';
    case 'document': return `📄 ${m?._data?.filename ?? 'Document'}`;
    case 'sticker': return 'Sticker';
    case 'location': return '📍 Location';
    default: return m?.body ?? '';
  }
}

export class WebJsEngine extends EventEmitter implements WhatsAppEngine {
  readonly kind = 'webjs' as const;
  private client: Client | null = null;
  private state: SessionState = 'DISCONNECTED';
  private qr: string | null = null;
  private me: HostDevice | null = null;
  /**
   * whatsapp-web.js is unreliable at emitting `ready` on current WhatsApp Web
   * builds: loading reaches 100% and `authenticated` fires, but `ready` never
   * arrives because its internal `client.info` build throws. The page itself is
   * fully functional, so rather than depend on `ready` we poll WhatsApp Web's
   * OWN connection state (`client.getState()`) and finalize the moment it
   * reports CONNECTED. Recycle only as a last resort.
   */
  private connectPoll: ReturnType<typeof setInterval> | null = null;
  private connectPolls = 0;
  private postAuthRecycles = 0;
  /** Resolved @lid -> real phone number (persistent; a number never changes). */
  private readonly lidToNumber = new Map<string, string>();

  constructor(readonly id: string) {
    super();
  }

  private setState(state: SessionState, extra: Partial<{ me: HostDevice | null; qr: string | null }> = {}) {
    this.state = state;
    if ('me' in extra) this.me = extra.me ?? this.me;
    if ('qr' in extra) this.qr = extra.qr ?? null;
    this.emit('status', this.getStatus());
  }

  getStatus(): EngineStatus {
    return {
      state: this.state,
      connected: this.state === 'CONNECTED',
      qr: this.qr,
      me: this.me,
    };
  }

  async start(): Promise<void> {
    if (this.client) return; // idempotent
    this.setState('INITIALIZING', { qr: null });
    this.launch(1);
  }

  /**
   * Launch the client, retrying the transient "Execution context was destroyed"
   * error whatsapp-web.js sometimes throws while WhatsApp Web finishes loading.
   */
  private launch(attempt: number): void {
    const dataPath = webJsDataPath();
    // Force WhatsApp Web to reload on our PINNED build every connect. WA's
    // service worker silently self-updates to the latest build, which
    // whatsapp-web.js@1.34.7 can't read (getChats throws `r: r` -> "no
    // conversations"). Wiping the SW/HTTP cache (NOT IndexedDB/Local Storage,
    // which hold the login) makes the page re-fetch under our webVersion pin,
    // so the compatible build always loads and no QR re-scan is needed.
    this.clearWebCache(dataPath);
    const client = new Client({
      authStrategy: new LocalAuth({ clientId: this.id, dataPath }),
      puppeteer: {
        headless: config.headless,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
      },
      // Pin WhatsApp Web to the EXACT build whatsapp-web.js@1.34.7's injected
      // layer is compatible with. On other builds the in-page helpers throw
      // `r: r` and getChats/getChatById/sendMessage all fail. This build
      // (2.3000.1043126001) is the one the known-good reference (v3) runs on;
      // its HTML is vendored locally at .wwebjs_cache/ so we never depend on a
      // remote fetch (the wa-version repo doesn't host this build).
      webVersion: process.env.WA_WEB_VERSION || '2.3000.1043126001',
      webVersionCache: {
        type: 'local',
        path: path.resolve(process.cwd(), '.wwebjs_cache'),
      },
    });
    this.client = client;
    this.attach(client);

    client.initialize().catch(async (err: unknown) => {
      const msg = (err as { message?: string })?.message ?? String(err);
      console.error(`[webjs:${this.id}] init attempt ${attempt} failed:`, msg);
      try {
        await client.destroy();
      } catch {
        /* ignore */
      }
      this.client = null;
      if (attempt < 4 && this.state !== 'LOGGED_OUT') {
        setTimeout(() => this.launch(attempt + 1), 1500);
      } else {
        this.setState('FAILED', { qr: null });
      }
    });
  }

  private attach(client: Client): void {
    client.on('qr', async (qr: string) => {
      try {
        this.qr = await qrcode.toDataURL(qr, { margin: 1, width: 320 });
      } catch {
        this.qr = null;
      }
      this.setState('QRCODE');
      this.emit('qr', this.qr ?? '');
    });

    client.on('loading_screen', (percent: unknown, message: unknown) =>
      console.log(`[webjs:${this.id}] loading ${percent}% ${message ?? ''}`),
    );
    client.on('change_state', (s: unknown) => console.log(`[webjs:${this.id}] change_state ${s}`));

    client.on('authenticated', () => {
      console.log(`[webjs:${this.id}] authenticated`);
      this.setState('AUTHENTICATED', { qr: null });
      this.startConnectPoll();
    });
    client.on('auth_failure', () => {
      this.stopConnectPoll();
      this.setState('FAILED', { qr: null });
    });

    // `ready` is the happy path — but often doesn't fire (see startConnectPoll).
    client.on('ready', () => {
      console.log(`[webjs:${this.id}] READY event fired`);
      void this.finalizeConnected(client);
    });

    client.on('disconnected', () => {
      this.stopConnectPoll();
      this.setState('DISCONNECTED', { me: null, qr: null });
    });

    client.on('message', async (m: any) => this.emit('message', toMessageDTO(m)));
    client.on('message_create', async (m: any) => {
      if (m?.fromMe) this.emit('message', toMessageDTO(m));
    });
    client.on('message_ack', (m: any, ack: number) =>
      this.emit('ack', { id: m?.id?._serialized ?? '', ack }),
    );
  }

  /**
   * After `authenticated`, poll WhatsApp Web's own connection state every 3s and
   * finalize as soon as it reports CONNECTED — because whatsapp-web.js's `ready`
   * event frequently never fires on current WA builds even though the page is
   * fully usable. Recycle once (then FAIL) only if it never connects.
   */
  private startConnectPoll(): void {
    this.stopConnectPoll();
    this.connectPolls = 0;
    this.connectPoll = setInterval(() => {
      void (async () => {
        this.connectPolls += 1;
        const client = this.client;
        if (!client) return this.stopConnectPoll();
        let waState: string | null = null;
        try {
          waState = await client.getState();
        } catch {
          /* page busy mid-load — try again next tick */
        }
        if (waState === 'CONNECTED') {
          await this.finalizeConnected(client);
          return;
        }
        // ~90s (30 * 3s) without WA reporting CONNECTED -> recycle once, else FAIL.
        if (this.connectPolls >= 30 && this.state !== 'CONNECTED') {
          this.stopConnectPoll();
          if (this.postAuthRecycles >= 2) {
            console.error(`[webjs:${this.id}] never reached CONNECTED after retries — FAILED`);
            this.setState('FAILED', { qr: null });
            return;
          }
          this.postAuthRecycles += 1;
          console.error(
            `[webjs:${this.id}] no CONNECTED state 90s after auth — recycling (attempt ${this.postAuthRecycles})`,
          );
          void this.recycle();
        }
      })();
    }, 3000);
  }

  private stopConnectPoll(): void {
    if (this.connectPoll) {
      clearInterval(this.connectPoll);
      this.connectPoll = null;
    }
  }

  /** Mark the session CONNECTED (best-effort `me` — `client.info` may be unset
   * when `ready` never fired; the session still works and `me` fills in later). */
  private async finalizeConnected(client: Client): Promise<void> {
    if (this.state === 'CONNECTED') return;
    this.stopConnectPoll();
    this.postAuthRecycles = 0;
    const info: any = client.info;
    console.log(`[webjs:${this.id}] connected`, info?.wid?._serialized ?? '(info pending)');
    void (client as any)
      .getWWebVersion?.()
      .then((v: string) => console.log(`[webjs:${this.id}] WA build loaded: ${v}`))
      .catch(() => undefined);
    this.setState('CONNECTED', {
      qr: null,
      me: info?.wid
        ? {
            wid: info.wid._serialized ?? '',
            phone: info.wid.user ?? undefined,
            pushname: info.pushname ?? undefined,
            platform: info.platform ?? undefined,
          }
        : this.me,
    });
  }

  /** Tear down a stuck client and re-launch so the session can reach CONNECTED. */
  private async recycle(): Promise<void> {
    const c = this.client;
    this.client = null;
    try {
      await c?.destroy();
    } catch {
      /* already dead */
    }
    if (this.state !== 'LOGGED_OUT') {
      this.setState('INITIALIZING', { qr: null });
      this.launch(1);
    }
  }

  /**
   * Drop the service worker for this session's profile (keeps IndexedDB / Local
   * Storage, so the WhatsApp login survives). Best-effort & synchronous — safe
   * to call right before launching the client.
   *
   * ONLY the service worker: it can intercept navigation and serve a whole
   * different WhatsApp Web app shell, which is what defeats the `webVersion`
   * pin and brings back the `r: r` / "no chats" failure.
   *
   * The HTTP and code caches used to be wiped here too, which forced WhatsApp
   * Web to re-download and re-JIT its entire bundle on EVERY connect — the main
   * reason a restart took minutes to come back. Those entries are keyed by
   * immutable versioned URLs, so keeping them cannot serve a stale build.
   * If `r: r` ever returns, adding 'Cache' and 'Code Cache' back here is the
   * first thing to try.
   */
  private clearWebCache(dataPath: string): void {
    const base = path.join(dataPath, `session-${this.id}`, 'Default');
    for (const sub of ['Service Worker']) {
      try {
        fs.rmSync(path.join(base, sub), { recursive: true, force: true });
      } catch {
        /* not present / locked — ignore */
      }
    }
  }

  /**
   * Close the browser WITHOUT logging out, so the next start reconnects with no
   * QR. Note the deliberate absence of a `logout()` call — that would invalidate
   * the WhatsApp link, which is exactly what must survive a restart.
   */
  async disconnect(): Promise<void> {
    this.stopConnectPoll();
    try {
      // destroy() closes the page and the browser, letting Chromium flush its
      // auth profile to disk. Skipping this is what risks a corrupted session.
      await this.client?.destroy();
    } catch {
      /* already gone */
    }
    this.client = null;
    this.setState('DISCONNECTED', { qr: null });
  }

  async logout(): Promise<void> {
    this.stopConnectPoll();
    try {
      await this.client?.logout();
    } catch {
      /* ignore */
    }
    try {
      await this.client?.destroy();
    } catch {
      /* ignore */
    }
    this.client = null;
    this.setState('LOGGED_OUT', { me: null, qr: null });
  }

  private need(): Client {
    if (!this.client || this.state !== 'CONNECTED') {
      const err: any = new Error('WhatsApp (webjs) is not connected');
      err.status = 409;
      throw err;
    }
    return this.client;
  }

  async listChats(): Promise<ChatDTO[]> {
    const client = this.need();
    const chats = await client.getChats();
    const dtos = chats.map(toChatDTO);
    await this.resolveLidNumbers(client, dtos);
    return dtos.sort((a, b) => b.timestamp - a.timestamp);
  }

  /**
   * Fill `number` for @lid individual chats (modern WhatsApp privacy ids that
   * don't contain the phone number) using whatsapp-web.js's bulk
   * getContactLidAndPhone — ONE page call per batch. Cached persistently, so
   * only the first listChats after a (re)connect pays the resolution cost. This
   * is what lets CRM matching work for @lid chats.
   */
  private async resolveLidNumbers(client: Client, dtos: ChatDTO[]): Promise<void> {
    const need: string[] = [];
    for (const d of dtos) {
      if (d.number || d.isGroup || !d.id.endsWith('@lid')) continue;
      const cached = this.lidToNumber.get(d.id);
      if (cached) d.number = cached;
      else need.push(d.id);
    }
    if (!need.length) return;
    const BATCH = 100;
    for (let i = 0; i < need.length; i += BATCH) {
      const batch = need.slice(i, i + BATCH);
      try {
        const pairs: Array<{ lid?: string; pn?: string }> = await (
          client as unknown as { getContactLidAndPhone: (ids: string[]) => Promise<any[]> }
        ).getContactLidAndPhone(batch);
        pairs.forEach((p, j) => {
          const num = p?.pn ? String(p.pn).split('@')[0] : '';
          if (num) this.lidToNumber.set(batch[j], num);
        });
      } catch (e) {
        console.warn(`[webjs:${this.id}] LID resolve failed:`, (e as Error).message);
        break;
      }
    }
    for (const d of dtos) {
      if (!d.number && d.id.endsWith('@lid')) {
        const n = this.lidToNumber.get(d.id);
        if (n) d.number = n;
      }
    }
  }

  /**
   * Latest `count`, or the `count` messages older than `before`. fetchMessages
   * back-loads history from the phone, so we grow the fetch window until we have
   * enough messages older than `before` (or reach the real start).
   */
  async getMessages(chatId: string, count: number, before?: string): Promise<MessageDTO[]> {
    const client = this.need();
    const chat = await client.getChatById(chatId);

    if (!before) {
      const msgs = await chat.fetchMessages({ limit: count });
      return msgs.map(toMessageDTO);
    }

    // Page backwards: fetch an ever-larger window until `before` has `count`
    // messages before it, or the window stops growing (start of chat).
    let limit = Math.max(count * 4, 200);
    let all: any[] = [];
    for (let round = 0; round < 6; round++) {
      all = await chat.fetchMessages({ limit });
      const idx = all.findIndex((m: any) => m?.id?._serialized === before);
      if (idx === -1) {
        // `before` not in window yet — grow and retry.
        if (all.length < limit) break; // window is the whole chat; stop
        limit *= 2;
        continue;
      }
      if (idx >= count || all.length < limit) {
        return all.slice(Math.max(0, idx - count), idx).map(toMessageDTO);
      }
      limit *= 2; // have `before` but not enough older — grow.
    }
    // Fallback: everything older than `before` we managed to load.
    const idx = all.findIndex((m: any) => m?.id?._serialized === before);
    const end = idx === -1 ? all.length : idx;
    return all.slice(Math.max(0, end - count), end).map(toMessageDTO);
  }

  async getMedia(msgId: string): Promise<MediaResult> {
    const client = this.need();
    const msg: any = await client.getMessageById(msgId);
    if (!msg) {
      const e: any = new Error('Message not found.');
      e.status = 404;
      throw e;
    }
    const media = await msg.downloadMedia();
    if (!media?.data) {
      const e: any = new Error('Media is no longer available.');
      e.status = 410;
      throw e;
    }
    const mimetype = media.mimetype ?? 'application/octet-stream';
    return { mimetype, dataUrl: `data:${mimetype};base64,${media.data}` };
  }

  async sendText(chatId: string, content: string): Promise<MessageDTO> {
    const sent: any = await this.need().sendMessage(chatId, content);
    return toMessageDTO(sent);
  }

  async sendFile(chatId: string, base64: string, opts: SendFileOpts): Promise<MessageDTO> {
    // base64 may be a data URL (`data:<mime>;base64,<data>`) or raw base64.
    let mimetype = 'application/octet-stream';
    let data = base64;
    const m = /^data:([^;]+);base64,(.*)$/s.exec(base64);
    if (m) {
      mimetype = m[1];
      data = m[2];
    }
    const media = new MessageMedia(mimetype, data, opts.filename ?? 'file');
    const sent: any = await this.need().sendMessage(chatId, media, { caption: opts.caption });
    return toMessageDTO(sent);
  }

  async sendSeen(chatId: string): Promise<void> {
    const chat = await this.need().getChatById(chatId);
    await chat.sendSeen();
  }

  async setTyping(chatId: string, on: boolean): Promise<void> {
    const chat = await this.need().getChatById(chatId);
    if (on) await chat.sendStateTyping();
    else await chat.clearState();
  }

  /**
   * Save a number into the linked WhatsApp account's contact list.
   *
   * `syncToAddressbook: true` ALSO writes the contact to the address book on the
   * linked phone. That is required, not cosmetic: with `false` the contact is
   * only recorded server-side (the number really does flip to isMyContact), but
   * the WhatsApp mobile app builds the contact list it displays from the phone's
   * address book — so a contact saved with `false` is invisible in the app and
   * the feature looks broken. Verified by write-test on 2026-07-20.
   *
   * whatsapp-web.js implements this by calling a WhatsApp Web internal module
   * (`WAWebSaveContactAction`) by name, so it can break on a WhatsApp update
   * even though nothing here changed. Callers must treat failure as non-fatal.
   */
  async saveContact(phone: string, firstName: string, lastName = ''): Promise<void> {
    // WA wants bare digits with a country code and no "+" (e.g. "919820282994").
    const number = phone.split('@')[0].replace(/\D/g, '');
    if (!number) throw new Error('a phone number is required');
    await this.need().saveOrEditAddressbookContact(number, firstName, lastName, true);
  }

  async getContact(chatId: string): Promise<ContactInfo> {
    const client = this.need();
    const isGroup = chatId.endsWith('@g.us');
    const contact: any = await client.getContactById(chatId).catch(() => null);
    let profilePic: string | null = null;
    try {
      profilePic = (await client.getProfilePicUrl(chatId)) ?? null;
    } catch {
      /* none */
    }
    let about: string | undefined;
    try {
      about = (await contact?.getAbout?.()) ?? undefined;
    } catch {
      /* none */
    }
    return {
      id: chatId,
      isGroup,
      name: contact?.name ?? contact?.pushname ?? contact?.number ?? '',
      pushname: contact?.pushname ?? undefined,
      number: contact?.number ?? undefined,
      realWid: contact?.id?._serialized ?? undefined,
      isBusiness: !!contact?.isBusiness,
      isMyContact: !!contact?.isMyContact,
      about,
      profilePic,
    };
  }

  async getProfilePic(chatId: string): Promise<string | null> {
    try {
      return (await this.need().getProfilePicUrl(chatId)) ?? null;
    } catch {
      return null;
    }
  }

  // on()/off() are inherited from EventEmitter and satisfy WhatsAppEngine.
}
