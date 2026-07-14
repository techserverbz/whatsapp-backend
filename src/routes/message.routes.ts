import { Router } from 'express';
import { session } from '../whatsapp/session';
import { serializeMessage } from '../whatsapp/serializers';
import { cacheMessages, getCachedMessage } from '../whatsapp/msgCache';

const router = Router();

/**
 * Accepts either a full chat id (`123@c.us` / `123-456@g.us`) or a bare
 * phone number and returns a valid individual chat id.
 */
function normalizeChatId(to: string): string {
  if (!to) return to;
  if (to.includes('@')) return to;
  const digits = to.replace(/\D/g, '');
  return `${digits}@c.us`;
}

/** Send a plain text message. */
router.post('/text', async (req, res, next) => {
  try {
    const { to, content } = req.body ?? {};
    if (!to || typeof content !== 'string' || !content.trim()) {
      return res
        .status(400)
        .json({ error: 'Both "to" and a non-empty "content" string are required.' });
    }
    const client = session.getClient();
    const result: any = await client.sendText(normalizeChatId(to), content);
    res.json(serializeMessage(result));
  } catch (e) {
    next(e);
  }
});

/**
 * Send a file (image / video / audio / document) from a base64 data URL.
 * `type` is one of image|video|audio|document (defaults to auto-detect).
 */
router.post('/file', async (req, res, next) => {
  try {
    const { to, base64, filename, caption, type } = req.body ?? {};
    if (!to || !base64) {
      return res.status(400).json({ error: '"to" and "base64" (data URL) are required.' });
    }
    const client = session.getClient();
    const result: any = await (client as any).sendFile(normalizeChatId(to), base64, {
      type: type ?? 'auto-detect',
      filename: filename ?? 'file',
      caption: caption ?? '',
    });
    res.json(result);
  } catch (e) {
    next(e);
  }
});

/**
 * Decrypt and return the media of a message as a base64 data URL.
 *
 * Uses the raw message snapshot from the message cache (populated when a chat
 * loads) because `getMessageById()` is unreliable on this WhatsApp build. Pass
 * `?chatId=` so we can (re)load the chat and locate the message on a cache miss.
 */
router.get('/:msgId/media', async (req, res, next) => {
  try {
    const client = session.getClient();
    const msgId = req.params.msgId;
    const chatId = typeof req.query.chatId === 'string' ? req.query.chatId : undefined;

    let msg: any = getCachedMessage(msgId);
    if (!msg && chatId) {
      const msgs: any[] = await client.getMessages(chatId, { count: 100 });
      cacheMessages(msgs);
      msg = getCachedMessage(msgId);
    }
    if (!msg) {
      try {
        msg = await client.getMessageById(msgId);
      } catch {
        /* getMessageById is unreliable here — fall through */
      }
    }
    if (!msg) return res.status(404).json({ error: 'Message not found.' });

    let buffer: Buffer;
    try {
      buffer = await (client as any).decryptFile(msg);
    } catch {
      // Media files expire on WhatsApp's servers if never downloaded.
      return res
        .status(410)
        .json({ error: 'Media is no longer available (expired on WhatsApp servers).' });
    }

    const mimetype = msg.mimetype ?? 'application/octet-stream';
    res.json({
      mimetype,
      dataUrl: `data:${mimetype};base64,${buffer.toString('base64')}`,
    });
  } catch (e) {
    next(e);
  }
});

export default router;
