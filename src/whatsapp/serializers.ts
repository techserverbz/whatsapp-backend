/**
 * Transforms raw WPPConnect objects (which are large, circular and noisy)
 * into lean, stable DTOs that the frontend can rely on.
 *
 * WPPConnect is loosely typed at the edges (ids can be strings or Wid objects,
 * fields come and go across versions), so these helpers are intentionally
 * defensive and use `any` at the boundary only.
 */

/** Normalise a Wid (which may be a string or `{ _serialized }`) to a string. */
function widStr(w: any): string | undefined {
  if (!w) return undefined;
  if (typeof w === 'string') return w;
  return w._serialized ?? w.id?._serialized ?? undefined;
}

/** Message ids can be a string or a serialised-id object. */
function messageId(id: any): string {
  if (!id) return '';
  if (typeof id === 'string') return id;
  return id._serialized ?? '';
}

export interface ChatDTO {
  id: string;
  name: string;
  isGroup: boolean;
  unreadCount: number;
  timestamp: number;
  pinned: boolean;
  archived: boolean;
  muted: boolean;
  lastMessage: string;
  lastMessageFromMe: boolean;
  /** Real phone number (individual chats), for CRM matching. Set for @c.us here;
   *  the webjs engine resolves @lid ids to their number too. */
  number?: string;
}

export interface MessageDTO {
  id: string;
  chatId: string;
  fromMe: boolean;
  author?: string;
  senderName?: string;
  type: string;
  body: string;
  caption?: string;
  timestamp: number;
  hasMedia: boolean;
  mimetype?: string;
  filename?: string;
  isGroupMsg: boolean;
  ack: number;
  quotedMsgId?: string;
}

const MEDIA_TYPES = new Set(['image', 'video', 'audio', 'ptt', 'document', 'sticker']);

/** Short human-readable preview for a chat's last message. */
function previewText(msg: any): string {
  const caption = msg?.caption ? `: ${msg.caption}` : '';
  switch (msg?.type) {
    case 'image':
      return `📷 Photo${caption}`;
    case 'video':
      return `🎞️ Video${caption}`;
    case 'ptt':
      return '🎤 Voice message';
    case 'audio':
      return '🎵 Audio';
    case 'document':
      return `📄 ${msg?.filename ?? 'Document'}`;
    case 'sticker':
      return 'Sticker';
    case 'location':
      return '📍 Location';
    case 'vcard':
    case 'multi_vcard':
      return '👤 Contact';
    default:
      return msg?.body ?? '';
  }
}

export function serializeChat(chat: any): ChatDTO {
  const id = widStr(chat?.id) ?? widStr(chat) ?? '';
  const isGroup = id.endsWith('@g.us');
  const last =
    chat?.lastMessage ??
    (Array.isArray(chat?.msgs) && chat.msgs.length ? chat.msgs[chat.msgs.length - 1] : undefined);

  const name =
    chat?.name ??
    chat?.formattedTitle ??
    chat?.contact?.name ??
    chat?.contact?.pushname ??
    chat?.contact?.formattedName ??
    (id ? id.split('@')[0] : 'Unknown');

  const t = chat?.t ?? last?.t ?? 0;

  return {
    id,
    name,
    isGroup,
    unreadCount: chat?.unreadCount ?? 0,
    timestamp: t ? t * 1000 : 0,
    pinned: !!chat?.pin,
    archived: !!chat?.archive,
    muted: (chat?.muteExpiration ?? 0) > 0,
    lastMessage: last ? previewText(last) : '',
    lastMessageFromMe: !!last?.fromMe,
    number: !isGroup && id.endsWith('@c.us') ? id.split('@')[0] : undefined,
  };
}

export function serializeMessage(msg: any): MessageDTO {
  const fromMe = !!msg?.fromMe;
  const chatId =
    widStr(msg?.chatId) ??
    (fromMe ? widStr(msg?.to) : widStr(msg?.from)) ??
    '';
  const type: string = msg?.type ?? 'chat';
  const hasMedia = MEDIA_TYPES.has(type);

  return {
    id: messageId(msg?.id),
    chatId,
    fromMe,
    author: widStr(msg?.author) ?? widStr(msg?.sender?.id) ?? widStr(msg?.from),
    senderName: msg?.sender?.pushname ?? msg?.sender?.name ?? msg?.notifyName ?? undefined,
    type,
    body: type === 'chat' ? msg?.body ?? '' : msg?.caption ?? '',
    caption: msg?.caption ?? undefined,
    timestamp: (msg?.t ?? 0) * 1000,
    hasMedia,
    mimetype: msg?.mimetype ?? undefined,
    filename: msg?.filename ?? undefined,
    isGroupMsg: !!msg?.isGroupMsg,
    ack: msg?.ack ?? 0,
    quotedMsgId: msg?.quotedMsgId ?? messageId(msg?.quotedMsg?.id) ?? undefined,
  };
}
