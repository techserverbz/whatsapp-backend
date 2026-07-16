/**
 * Multi-session, multi-engine API. Everything under /api/sessions/:id operates
 * on the engine that backs that session (WhatsApp Web JS today; WPPConnect
 * sessions can register here too). All responses are the SAME unified DTOs the
 * existing UI already consumes, so a webjs session renders identically.
 */
import { Router, type NextFunction, type Request, type Response } from 'express';
import { manager } from '../engines/manager';
import type { EngineKind, WhatsAppEngine } from '../engines/common/engine';
import { attachSenders, recordSent } from '../attribution';
import type { CrmUser } from '../auth';

const router = Router();

/** The CRM user attached by `requireAuth` (undefined in legacy API-key mode). */
const crmUserOf = (req: Request): CrmUser | undefined =>
  (req as Request & { crmUser?: CrmUser }).crmUser;

const OFFLINE = { state: 'DISCONNECTED', connected: false, qr: null, me: null } as const;

/** List all sessions with their live status. */
router.get('/', (_req, res) => {
  const out = manager.list().map((m) => {
    const engine = manager.get(m.id);
    const s = engine ? engine.getStatus() : OFFLINE;
    return { ...m, state: s.state, connected: s.connected, me: s.me };
  });
  res.json(out);
});

/** Create a new session and choose its engine. Body: { kind, label? }. */
router.post('/', (req, res) => {
  const kind = String(req.body?.kind ?? '') as EngineKind;
  if (kind !== 'webjs' && kind !== 'wppconnect') {
    return res.status(400).json({ error: 'kind must be "webjs" or "wppconnect"' });
  }
  const meta = manager.create(kind, typeof req.body?.label === 'string' ? req.body.label : undefined);
  res.status(201).json(meta);
});

/** Resolve the engine for a :id route (rebuilds it lazily after a restart). */
function withEngine(req: Request, res: Response, next: NextFunction) {
  const engine = manager.ensure(req.params.id);
  if (!engine) return res.status(404).json({ error: 'session not found' });
  (req as Request & { engine: WhatsAppEngine }).engine = engine;
  next();
}
const eng = (req: Request) => (req as Request & { engine: WhatsAppEngine }).engine;

// ---- lifecycle ----
router.get('/:id/status', withEngine, (req, res) => res.json(eng(req).getStatus()));
router.post('/:id/start', withEngine, async (req, res, next) => {
  try {
    await eng(req).start();
    res.json(eng(req).getStatus());
  } catch (e) {
    next(e);
  }
});
router.post('/:id/logout', withEngine, async (req, res, next) => {
  try {
    await eng(req).logout();
    res.json(eng(req).getStatus());
  } catch (e) {
    next(e);
  }
});
router.delete('/:id', async (req, res) => {
  await manager.remove(req.params.id);
  res.json({ ok: true });
});

// ---- chats ----
router.get('/:id/chats', withEngine, async (req, res, next) => {
  try {
    res.json(await eng(req).listChats());
  } catch (e) {
    next(e);
  }
});
router.get('/:id/chats/:chatId/messages', withEngine, async (req, res, next) => {
  try {
    const count = Math.min(Math.max(Number(req.query.count) || 50, 1), 200);
    const before = typeof req.query.before === 'string' ? req.query.before : undefined;
    const msgs = await eng(req).getMessages(req.params.chatId, count, before);
    // Persist to the DB cache (keyed by session) + decorate outbound messages
    // with the CRM user who sent them (cross-engine).
    res.json(await attachSenders(msgs, eng(req).id));
  } catch (e) {
    next(e);
  }
});
router.get('/:id/chats/:chatId/contact', withEngine, async (req, res, next) => {
  try {
    res.json(await eng(req).getContact(req.params.chatId));
  } catch (e) {
    next(e);
  }
});
router.get('/:id/chats/:chatId/profile-pic', withEngine, async (req, res, next) => {
  try {
    res.json({ url: await eng(req).getProfilePic(req.params.chatId) });
  } catch (e) {
    next(e);
  }
});
router.post('/:id/chats/:chatId/seen', withEngine, async (req, res, next) => {
  try {
    await eng(req).sendSeen(req.params.chatId);
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});
router.post('/:id/chats/:chatId/typing', withEngine, async (req, res, next) => {
  try {
    await eng(req).setTyping(req.params.chatId, !!req.body?.on);
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

// ---- messages / media ----
router.get('/:id/messages/:msgId/media', withEngine, async (req, res, next) => {
  try {
    const chatId = typeof req.query.chatId === 'string' ? req.query.chatId : undefined;
    res.json(await eng(req).getMedia(req.params.msgId, chatId));
  } catch (e) {
    next(e);
  }
});
router.post('/:id/messages/text', withEngine, async (req, res, next) => {
  try {
    const { to, content } = req.body ?? {};
    if (!to || typeof content !== 'string' || !content.trim()) {
      return res.status(400).json({ error: '"to" and non-empty "content" are required.' });
    }
    const engine = eng(req);
    const dto = (await engine.sendText(to, content)) as { id?: string; chatId?: string };
    recordSent({
      messageId: dto?.id ?? '',
      chatId: dto?.chatId || to,
      engine: engine.kind,
      sessionId: engine.id,
      user: crmUserOf(req),
      body: content,
      hasMedia: false,
    });
    res.json(dto);
  } catch (e) {
    next(e);
  }
});
router.post('/:id/messages/file', withEngine, async (req, res, next) => {
  try {
    const { to, base64, filename, type, caption } = req.body ?? {};
    if (!to || !base64) return res.status(400).json({ error: '"to" and "base64" are required.' });
    const engine = eng(req);
    const dto = (await engine.sendFile(to, base64, { type, filename, caption })) as {
      id?: string;
      chatId?: string;
    };
    recordSent({
      messageId: dto?.id ?? '',
      chatId: dto?.chatId || to,
      engine: engine.kind,
      sessionId: engine.id,
      user: crmUserOf(req),
      body: caption ?? '',
      hasMedia: true,
    });
    res.json(dto);
  } catch (e) {
    next(e);
  }
});

export default router;
