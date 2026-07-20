/**
 * CRM contact endpoints for the WhatsApp app: look up a WhatsApp number in the
 * SAM CRM (to show the CRM contact name beside the WhatsApp name) and add a new
 * contact to the CRM from the chat view. All calls reuse the caller's crm_token.
 */
import { Router, type Request } from 'express';
import { tokenFromRequest } from '../auth';
import type { CrmUser } from '../auth';
import {
  addLeadCall,
  attachContact,
  createContact,
  createLead,
  deleteLeadCall,
  getLead,
  listAllContacts,
  listLeads,
  listMembers,
  listServices,
  lookupByPhone,
  lookupMany,
  searchContacts,
  toPhone,
  updateContact,
  updateLead,
  updateLeadCall,
} from '../crmContacts';

const router = Router();

function ctx(req: Request): { token: string | undefined; userId: string } {
  return {
    token: tokenFromRequest(req),
    userId: (req as Request & { crmUser?: CrmUser }).crmUser?.userId ?? 'default',
  };
}

/** Single lookup: ?phone=919820282994 (or a chat id). */
router.get('/contact', async (req, res, next) => {
  try {
    const { token, userId } = ctx(req);
    const phone = toPhone(String(req.query.phone ?? ''));
    if (!token || !phone) return res.json({ found: false, contact: null });
    const contact = await lookupByPhone(userId, token, phone);
    res.json({ found: !!contact, contact });
  } catch (e) {
    next(e);
  }
});

/** Batch lookup: { phones: [...] } -> { <last10>: contact | null }. */
router.post('/contacts/lookup', async (req, res, next) => {
  try {
    const { token, userId } = ctx(req);
    const phones: string[] = Array.isArray(req.body?.phones)
      ? req.body.phones.map((p: unknown) => String(p))
      : [];
    if (!token || !phones.length) return res.json({});
    res.json(await lookupMany(userId, token, phones));
  } catch (e) {
    next(e);
  }
});

/** One lead's full detail incl. its call/update records. */
router.get('/lead/:id', async (req, res, next) => {
  try {
    const { token } = ctx(req);
    if (!token) return res.json(null);
    res.json(await getLead(token, req.params.id));
  } catch (e) {
    next(e);
  }
});

/** Create a new lead (optionally linked to a contact via customerId). */
router.post('/lead', async (req, res, next) => {
  try {
    const { token } = ctx(req);
    if (!token) return res.status(401).json({ error: 'Not authenticated with the CRM.' });
    const b = req.body ?? {};
    const lead = await createLead(token, {
      customerId: b.customerId,
      serviceId: b.serviceId,
      assignedUserIds: Array.isArray(b.assignedUserIds)
        ? b.assignedUserIds.map((x: unknown) => String(x))
        : undefined,
      name: b.name,
      status: b.status,
      source: b.source,
      hotWarmCold: b.hotWarmCold,
      paymentStatus: b.paymentStatus,
      totalPayment: b.totalPayment,
      paymentLeft: b.paymentLeft,
      callbackOn: b.callbackOn,
      description: b.description,
      notes: b.notes,
    });
    res.status(201).json(lead);
  } catch (e) {
    next(e);
  }
});

/** Update a lead's fields (the lead edit form). */
router.patch('/lead/:id', async (req, res, next) => {
  try {
    const { token } = ctx(req);
    if (!token) return res.status(401).json({ error: 'Not authenticated with the CRM.' });
    const b = req.body ?? {};
    const lead = await updateLead(token, req.params.id, {
      status: b.status,
      name: b.name,
      source: b.source,
      hotWarmCold: b.hotWarmCold,
      paymentStatus: b.paymentStatus,
      totalPayment: b.totalPayment,
      paymentLeft: b.paymentLeft,
      callbackOn: b.callbackOn,
      description: b.description,
      notes: b.notes,
      assignedUserIds: Array.isArray(b.assignedUserIds)
        ? b.assignedUserIds.map((x: unknown) => String(x))
        : undefined,
    });
    res.json(lead);
  } catch (e) {
    next(e);
  }
});

/** Add a call / update record to a lead: { description, callDate? }. */
router.post('/lead/:id/calls', async (req, res, next) => {
  try {
    const { token } = ctx(req);
    if (!token) return res.status(401).json({ error: 'Not authenticated with the CRM.' });
    const call = await addLeadCall(token, req.params.id, {
      description: req.body?.description ? String(req.body.description) : '',
      callDate: req.body?.callDate ? String(req.body.callDate) : undefined,
    });
    res.status(201).json(call);
  } catch (e) {
    next(e);
  }
});

/** Edit a lead's call / update record: { description?, callDate? }. */
router.patch('/lead/:leadId/calls/:callId', async (req, res, next) => {
  try {
    const { token } = ctx(req);
    if (!token) return res.status(401).json({ error: 'Not authenticated with the CRM.' });
    const call = await updateLeadCall(token, req.params.leadId, req.params.callId, {
      description: req.body?.description !== undefined ? String(req.body.description) : undefined,
      callDate: req.body?.callDate ? String(req.body.callDate) : undefined,
    });
    res.json(call);
  } catch (e) {
    next(e);
  }
});

/** Delete a lead's call / update record. */
router.delete('/lead/:leadId/calls/:callId', async (req, res, next) => {
  try {
    const { token } = ctx(req);
    if (!token) return res.status(401).json({ error: 'Not authenticated with the CRM.' });
    await deleteLeadCall(token, req.params.leadId, req.params.callId);
    res.json({ deleted: true });
  } catch (e) {
    next(e);
  }
});

/** The org's members (for the "assigned to" picker on a lead). */
router.get('/members', async (req, res, next) => {
  try {
    const { token } = ctx(req);
    if (!token) return res.json([]);
    res.json(await listMembers(token));
  } catch (e) {
    next(e);
  }
});

/** The org's services (for the "service" picker when creating a lead). */
router.get('/services', async (req, res, next) => {
  try {
    const { token } = ctx(req);
    if (!token) return res.json([]);
    res.json(await listServices(token));
  } catch (e) {
    next(e);
  }
});

/** All org leads (for the WhatsApp "Leads" tab, grouped by status). */
router.get('/leads', async (req, res, next) => {
  try {
    const { token } = ctx(req);
    if (!token) return res.json([]);
    res.json(await listLeads(token));
  } catch (e) {
    next(e);
  }
});

/** All org contacts (for the admin CRM contacts page). */
router.get('/contacts', async (req, res, next) => {
  try {
    const { token, userId } = ctx(req);
    if (!token) return res.json([]);
    res.json(await listAllContacts(userId, token));
  } catch (e) {
    next(e);
  }
});

/** Search existing CRM contacts by name (for the "attach" picker): ?q=. */
router.get('/contacts/search', async (req, res, next) => {
  try {
    const { token, userId } = ctx(req);
    if (!token) return res.json([]);
    res.json(await searchContacts(userId, token, String(req.query.q ?? '')));
  } catch (e) {
    next(e);
  }
});

/** Attach a WhatsApp number to an EXISTING CRM contact: body { phone }. */
router.post('/contact/:id/attach', async (req, res, next) => {
  try {
    const { token, userId } = ctx(req);
    if (!token) return res.status(401).json({ error: 'Not authenticated with the CRM.' });
    const phone = req.body?.phone ? String(req.body.phone) : '';
    if (!phone) return res.status(400).json({ error: 'A phone number is required.' });
    const detachFromId = req.body?.detachFromId ? String(req.body.detachFromId) : undefined;
    const contact = await attachContact(userId, token, req.params.id, phone, detachFromId);
    res.json({ found: true, contact });
  } catch (e) {
    next(e);
  }
});

/** Update an existing CRM contact (the contact edit form). */
router.patch('/contact/:id', async (req, res, next) => {
  try {
    const { token, userId } = ctx(req);
    if (!token) return res.status(401).json({ error: 'Not authenticated with the CRM.' });
    const b = req.body ?? {};
    const contact = await updateContact(userId, token, req.params.id, {
      firstName: b.firstName,
      lastName: b.lastName,
      phone: b.phone,
      email: b.email,
      type: b.type,
      street: b.street,
      city: b.city,
      state: b.state,
      pincode: b.pincode,
      country: b.country,
      description: b.description,
    });
    res.json({ contact });
  } catch (e) {
    next(e);
  }
});

/**
 * Add a contact to the CRM: { firstName, lastName?, phone }.
 *
 * CRM only. Saving the same number into WhatsApp's own contacts is a SEPARATE
 * action (POST /wa-contacts/save) so either can be done without the other —
 * a number already in the CRM can still be pushed to WhatsApp later, and a
 * number already in WhatsApp can be added to the CRM alone.
 */
router.post('/contact', async (req, res, next) => {
  try {
    const { token, userId } = ctx(req);
    if (!token) return res.status(401).json({ error: 'Not authenticated with the CRM.' });
    const firstName = String(req.body?.firstName ?? '').trim();
    const lastName = req.body?.lastName ? String(req.body.lastName).trim() : undefined;
    const phone = req.body?.phone ? String(req.body.phone) : undefined;
    const description = req.body?.description ? String(req.body.description) : undefined;
    if (!firstName) return res.status(400).json({ error: 'A first name is required.' });
    const contact = await createContact(userId, token, { firstName, lastName, phone, description });
    res.status(201).json({ found: true, contact });
  } catch (e) {
    next(e);
  }
});

export default router;
