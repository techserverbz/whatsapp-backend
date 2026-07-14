import { Router, type Request } from 'express';
import { session } from '../whatsapp/session';
import { isAdminUser, ssoEnabled, type CrmUser } from '../auth';

const router = Router();

/** Current connection state, host device info, and QR (admins only). */
router.get('/status', (req: Request, res) => {
  const admin = !ssoEnabled() || isAdminUser((req as unknown as { crmUser?: CrmUser }).crmUser);
  res.json(session.getStatus(admin));
});

/** Start (or resume) a WhatsApp session. Non-blocking + idempotent. */
router.post('/start', async (_req, res, next) => {
  try {
    await session.start();
    res.json(session.getStatus());
  } catch (e) {
    next(e);
  }
});

/** Log out of WhatsApp and clear the local token. */
router.post('/logout', async (_req, res, next) => {
  try {
    await session.logout();
    res.json(session.getStatus());
  } catch (e) {
    next(e);
  }
});

export default router;
