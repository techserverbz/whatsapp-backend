/**
 * Common engine contract — shared by BOTH WhatsApp engines.
 *
 * The whole point of this folder layout is that a "session" doesn't care which
 * engine backs it: WPPConnect and whatsapp-web.js each implement this ONE
 * interface and emit the SAME DTOs (ChatDTO / MessageDTO from serializers.ts),
 * so the routes, socket, and (untouched) frontend behave identically regardless
 * of engine.
 *
 *   engines/
 *     common/     ← this file: the interface + shared types (engine-agnostic)
 *     wppconnect/ ← WPPConnect adapter
 *     webjs/      ← whatsapp-web.js adapter
 */
import type { ChatDTO, MessageDTO } from '../../whatsapp/serializers';

export type EngineKind = 'wppconnect' | 'webjs';

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

/** Live connection state for one session (the shape the frontend already reads). */
export interface EngineStatus {
  state: SessionState;
  connected: boolean;
  qr: string | null; // data URL, admins only
  me: HostDevice | null;
}

export interface MediaResult {
  mimetype: string;
  dataUrl: string;
}

export interface SendFileOpts {
  type?: string; // image | video | audio | document | auto-detect
  filename?: string;
  caption?: string;
}

export interface ContactInfo {
  id: string;
  isGroup: boolean;
  name: string;
  pushname?: string;
  number?: string;
  realWid?: string;
  isBusiness: boolean;
  isMyContact: boolean;
  about?: string;
  profilePic: string | null;
}

/** Events an engine emits; the socket layer forwards these tagged with the sessionId. */
export type EngineEvent = 'status' | 'qr' | 'message' | 'ack';

export interface EngineEventPayloads {
  status: EngineStatus;
  qr: string; // data URL
  message: MessageDTO;
  ack: { id: string; ack: number };
}

/**
 * The unified WhatsApp engine. Every method returns engine-agnostic DTOs so the
 * frontend sees one shape. Both adapters MUST honour these semantics exactly —
 * especially `getMessages(chatId, count, before)` which pages BACKWARDS through
 * history (this is what lets whatsapp-web.js surface much older messages).
 */
export interface WhatsAppEngine {
  readonly id: string;
  readonly kind: EngineKind;

  // ---- lifecycle ----
  start(): Promise<void>;
  /**
   * Close the browser but KEEP the WhatsApp link — the opposite of logout().
   *
   * Called on process shutdown so the engine's Chromium is closed in an orderly
   * way instead of being killed with the process. That matters: the auth profile
   * is a LevelDB store, and killing Chromium mid-write can corrupt it badly
   * enough to force a QR re-scan. Optional so engines without a browser can skip.
   */
  disconnect?(): Promise<void>;
  logout(): Promise<void>;
  getStatus(): EngineStatus;

  // ---- chats & messages (unified DTOs) ----
  listChats(): Promise<ChatDTO[]>;
  /** Latest `count` messages, or the `count` messages older than `before` (exclusive). */
  getMessages(chatId: string, count: number, before?: string): Promise<MessageDTO[]>;

  // ---- media ----
  getMedia(msgId: string, chatId?: string): Promise<MediaResult>;

  // ---- send ----
  sendText(chatId: string, content: string): Promise<MessageDTO>;
  sendFile(chatId: string, base64: string, opts: SendFileOpts): Promise<MessageDTO>;

  // ---- presence / contact ----
  /**
   * Save a number into the linked WhatsApp account's own contact list.
   *
   * OPTIONAL — only engines whose library exposes a contact-WRITE API implement
   * it (whatsapp-web.js does; WPPConnect does not). Callers must treat a missing
   * method as "unsupported" rather than an error: the CRM add-contact route is
   * best-effort and must never fail a CRM write because of this.
   */
  saveContact?(phone: string, firstName: string, lastName?: string): Promise<void>;
  sendSeen(chatId: string): Promise<void>;
  setTyping(chatId: string, on: boolean): Promise<void>;
  getContact(chatId: string): Promise<ContactInfo>;
  getProfilePic(chatId: string): Promise<string | null>;

  // ---- events ----
  on<E extends EngineEvent>(event: E, handler: (payload: EngineEventPayloads[E]) => void): void;
  off<E extends EngineEvent>(event: E, handler: (payload: EngineEventPayloads[E]) => void): void;
}

/** Metadata persisted per session (independent of the live engine instance). */
export interface SessionMeta {
  id: string;
  kind: EngineKind;
  label: string;
  createdAt: number;
}
