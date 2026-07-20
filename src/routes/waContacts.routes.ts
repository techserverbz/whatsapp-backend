/**
 * WhatsApp-contact endpoints — saving a number into the linked WhatsApp
 * account's OWN contacts, independent of the CRM.
 *
 * The two address books are deliberately separate here: a number can be in the
 * CRM, in WhatsApp, in both, or in neither, and the UI offers each as its own
 * action so an existing CRM contact can still be pushed to WhatsApp (and vice
 * versa). That is why this is not folded into POST /crm/contact.
 */
import { Router } from 'express';
import { manager } from '../engines/manager';
import type { WhatsAppEngine } from '../engines/common/engine';

const router = Router();

/**
 * Pick the engine to write through. An explicit sessionId wins; otherwise fall
 * back to the single CONNECTED session, which is the normal case here — it
 * saves the frontend from having to thread a session id through every chat view.
 * With SEVERAL connected we refuse rather than guess: writing a contact into the
 * wrong WhatsApp account is hard to notice and hard to undo.
 */
function resolveEngine(sessionId?: string): { engine?: WhatsAppEngine; reason?: string } {
  if (sessionId) {
    const engine = manager.ensure(sessionId);
    if (!engine) return { reason: 'Session not found.' };
    if (!engine.getStatus().connected) return { reason: 'That WhatsApp session is not connected.' };
    return { engine };
  }
  const connected = manager
    .list()
    .map((m) => manager.get(m.id))
    .filter((e): e is WhatsAppEngine => !!e && e.getStatus().connected);
  if (!connected.length) return { reason: 'WhatsApp is not connected.' };
  if (connected.length > 1) return { reason: 'Several WhatsApp sessions are connected.' };
  return { engine: connected[0] };
}

/**
 * Save a number to WhatsApp contacts: { phone, firstName, lastName?, sessionId? }.
 *
 * Unlike the CRM route's old piggy-backed save, this is NOT best-effort: the
 * user pressed a button that does exactly one thing, so a failure has to surface
 * as a failure rather than a quiet no-op.
 */
router.post('/save', async (req, res, next) => {
  try {
    const phone = String(req.body?.phone ?? '').trim();
    const firstName = String(req.body?.firstName ?? '').trim();
    const lastName = req.body?.lastName ? String(req.body.lastName).trim() : undefined;
    const sessionId = req.body?.sessionId ? String(req.body.sessionId) : undefined;
    if (!phone) return res.status(400).json({ error: 'A phone number is required.' });
    if (!firstName) return res.status(400).json({ error: 'A name is required.' });

    const { engine, reason } = resolveEngine(sessionId);
    if (!engine) return res.status(409).json({ error: reason });
    if (!engine.saveContact) {
      return res.status(400).json({ error: `A ${engine.kind} session cannot save contacts.` });
    }
    await engine.saveContact(phone, firstName, lastName);
    res.status(201).json({ saved: true });
  } catch (e) {
    next(e);
  }
});

export default router;
