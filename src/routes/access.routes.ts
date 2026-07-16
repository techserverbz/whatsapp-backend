/**
 * Admin-only management of the send-access allow-list: which CRM users (by
 * email) may send messages. Gated to admins by the permission middleware in
 * index.ts (every /api/access path requires admin).
 */
import { Router, type Request } from 'express';
import { canSend, canViewAll, isAdminUser, tokenFromRequest, type CrmUser } from '../auth';
import { grantAccess, grantViewAll, listAccess, revokeAccess, revokeViewAll } from '../access';
import { listMembers } from '../crmContacts';

const router = Router();
const emailOf = (req: Request) => (req as Request & { crmUser?: CrmUser }).crmUser?.email;

/** The current allow-list. */
router.get('/', (_req, res) => res.json(listAccess()));

/**
 * Every org user with their WhatsApp-app access flags, for the access page:
 * who is a device admin (always allowed) and who currently has send access.
 */
router.get('/users', async (req, res, next) => {
  try {
    const token = tokenFromRequest(req);
    if (!token) return res.json([]);
    const members = await listMembers(token);
    res.json(
      members.map((m) => {
        const u: CrmUser = { userId: m.userId, email: m.email, role: m.role };
        return {
          userId: m.userId,
          name: m.name,
          email: m.email,
          role: m.role,
          isAdmin: isAdminUser(u),
          canSend: canSend(u),
          viewAll: canViewAll(u),
        };
      }),
    );
  } catch (e) {
    next(e);
  }
});

/** Grant send access to an email. Body: { email }. */
router.post('/', (req, res) => {
  const email = String(req.body?.email ?? '').trim();
  if (!email || !email.includes('@')) {
    return res.status(400).json({ error: 'A valid email address is required.' });
  }
  res.status(201).json(grantAccess(email, emailOf(req)));
});

/** Grant view-all (see all leads/chats) to an email. Body: { email }. */
router.post('/view-all', (req, res) => {
  const email = String(req.body?.email ?? '').trim();
  if (!email || !email.includes('@')) {
    return res.status(400).json({ error: 'A valid email address is required.' });
  }
  res.status(201).json(grantViewAll(email, emailOf(req)));
});

/** Revoke view-all for an email (back to allotted-only). */
router.delete('/view-all/:email', (req, res) => {
  revokeViewAll(decodeURIComponent(req.params.email));
  res.json({ ok: true });
});

/** Revoke send access for an email. */
router.delete('/:email', (req, res) => {
  revokeAccess(decodeURIComponent(req.params.email));
  res.json({ ok: true });
});

export default router;
