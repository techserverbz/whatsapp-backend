/**
 * Read API over the embedded-Postgres send-attribution log: "who sent what",
 * across every engine (WPPConnect + WhatsApp Web JS). Behind the same CRM auth
 * as the rest of /api.
 */
import { Router } from 'express';
import { getSender, listRecent } from '../attribution';

const router = Router();

/** Recent sends across all sessions/engines (newest first). ?limit=1..1000. */
router.get('/recent', async (req, res, next) => {
  try {
    const limit = Number(req.query.limit) || 100;
    res.json(await listRecent(limit));
  } catch (e) {
    next(e);
  }
});

/** Who sent one specific message (by WhatsApp message id). */
router.get('/message/:msgId', async (req, res, next) => {
  try {
    res.json({ sender: await getSender(req.params.msgId) });
  } catch (e) {
    next(e);
  }
});

export default router;
