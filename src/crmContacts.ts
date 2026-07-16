/**
 * SAM CRM contact lookup / create / attach, for showing the CRM contact name
 * beside the WhatsApp name and linking a WhatsApp number to the CRM.
 *
 * The CRM has NO search-by-phone endpoint, so we fetch the org's whole contact
 * list once (GET /v1/org/contacts, paginated), index it by the last 10 digits of
 * each phone (absorbs the country-code prefix), keep the full list for name
 * search, and cache both briefly per CRM user. All calls reuse the logged-in
 * user's `crm_token` as a Bearer — the CRM resolves the org from the token.
 */
import { randomBytes } from 'node:crypto';
import { config } from './config';

export interface CrmContact {
  id: string;
  name: string; // "firstName lastName"
  firstName: string;
  lastName?: string;
  phone?: string;
  email?: string;
  type?: string;
  street?: string;
  city?: string;
  state?: string;
  pincode?: string;
  country?: string;
  description?: string;
  /** Audit: who created / last edited the contact (names, from the CRM). */
  createdByName?: string;
  updatedByName?: string;
}

/** Editable contact fields (matches the CRM's contact form). */
export type CrmContactEdit = Partial<
  Pick<
    CrmContact,
    | 'firstName'
    | 'lastName'
    | 'phone'
    | 'email'
    | 'type'
    | 'street'
    | 'city'
    | 'state'
    | 'pincode'
    | 'country'
    | 'description'
  >
>;

const digitsOnly = (s: string | undefined | null): string => (s || '').replace(/\D/g, '');

/** Match key: last 10 digits (Indian mobile) — empty when < 10 digits. */
function last10(value: string | undefined | null): string {
  const d = digitsOnly(value);
  return d.length >= 10 ? d.slice(-10) : '';
}

/** A chat id (`919820282994@c.us`) or raw value -> bare number string. */
export function toPhone(v: string): string {
  return (v || '').split('@')[0];
}

interface CacheEntry {
  map: Map<string, CrmContact>; // last10 -> contact
  all: CrmContact[]; // every contact (incl. those without a phone) for name search
  at: number;
}
const cache = new Map<string, CacheEntry>(); // key: CRM userId
const TTL_MS = 5 * 60 * 1000;

async function crmFetch(path: string, token: string, init?: RequestInit): Promise<Response> {
  const method = (init?.method ?? 'GET').toUpperCase();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    ...(init?.headers as Record<string, string> | undefined),
  };
  // The CRM enforces double-submit CSRF on state-changing methods: the
  // `crm_csrf` cookie must equal the `x-csrf-token` header. For our
  // server-to-server calls we generate one token and send it in both (auth
  // still comes from the Bearer header, so no crm_token cookie is needed).
  if (method !== 'GET' && method !== 'HEAD') {
    const csrf = randomBytes(24).toString('hex');
    headers['x-csrf-token'] = csrf;
    headers['cookie'] = `crm_csrf=${csrf}`;
  }
  return fetch(`${config.crmApiUrl}${path}`, {
    ...init,
    headers,
    signal: AbortSignal.timeout(15_000),
  });
}

function toContact(c: any, fallbackFirst?: string, fallbackPhone?: string): CrmContact {
  const name = [c?.firstName, c?.lastName].filter(Boolean).join(' ').trim();
  return {
    id: String(c?.id ?? ''),
    name: name || fallbackFirst || '',
    firstName: c?.firstName ?? fallbackFirst ?? '',
    lastName: c?.lastName ?? undefined,
    phone: c?.phone ?? fallbackPhone ?? undefined,
    email: c?.email ?? undefined,
    type: c?.type ?? undefined,
    street: c?.street ?? undefined,
    city: c?.city ?? undefined,
    state: c?.state ?? undefined,
    pincode: c?.pincode ?? undefined,
    country: c?.country ?? undefined,
    description: c?.description ?? undefined,
    createdByName: c?.createdByName ?? undefined,
    updatedByName: c?.updatedByName ?? undefined,
  };
}

/** Fetch ALL org contacts (paginated); build the phone index + the full list. */
async function fetchAll(token: string): Promise<{ map: Map<string, CrmContact>; all: CrmContact[] }> {
  const map = new Map<string, CrmContact>();
  const all: CrmContact[] = [];
  const limit = 200; // CRM caps limit at 200
  for (let page = 1; page <= 100; page++) {
    let res: Response;
    try {
      res = await crmFetch(`/org/contacts?page=${page}&limit=${limit}`, token);
    } catch {
      break;
    }
    if (!res.ok) break;
    const data: any = await res.json().catch(() => null);
    const rows: any[] = Array.isArray(data?.contacts)
      ? data.contacts
      : Array.isArray(data)
        ? data
        : [];
    for (const c of rows) {
      const contact = toContact(c);
      all.push(contact);
      const key = last10(contact.phone);
      if (key && !map.has(key)) map.set(key, contact); // first wins on duplicates
    }
    const totalPages: number | undefined = data?.pagination?.totalPages;
    if (rows.length < limit) break;
    if (totalPages && page >= totalPages) break;
  }
  return { map, all };
}

async function getCache(userId: string, token: string): Promise<CacheEntry> {
  const cached = cache.get(userId);
  if (cached && Date.now() - cached.at < TTL_MS) return cached;
  const { map, all } = await fetchAll(token);
  const entry: CacheEntry = { map, all, at: Date.now() };
  cache.set(userId, entry);
  return entry;
}

/** The CRM contact matching a single WhatsApp number (or null). */
export async function lookupByPhone(
  userId: string,
  token: string,
  phone: string,
): Promise<CrmContact | null> {
  const key = last10(toPhone(phone));
  if (!key) return null;
  return (await getCache(userId, token)).map.get(key) ?? null;
}

/** Batch: map each requested number's last-10 key -> CRM contact or null. */
export async function lookupMany(
  userId: string,
  token: string,
  phones: string[],
): Promise<Record<string, CrmContact | null>> {
  const out: Record<string, CrmContact | null> = {};
  const keys = phones.map((p) => last10(toPhone(p))).filter(Boolean);
  if (!keys.length) return out;
  const { map } = await getCache(userId, token);
  for (const key of keys) out[key] = map.get(key) ?? null;
  return out;
}

export interface CrmLead {
  id: string;
  leadNumber?: string;
  name?: string;
  status: string;
  customerId?: string;
  customerName?: string;
  customerPhone?: string;
  serviceName?: string;
  paymentStatus?: string;
  totalPayment?: string;
  hotWarmCold?: string;
  assignedUsers: { userId: string; userName?: string }[];
  createdAt?: string;
  /** When to follow up (from the lead's callback_on). */
  callbackOn?: string;
  /** Number of call / update records logged on this lead. */
  callCount?: number;
  /** Audit: who created / last edited the lead (names). */
  createdByName?: string;
  updatedByName?: string;
}

/** All org leads (paginated) — for the WhatsApp app's "Leads" tab (by status). */
export async function listLeads(token: string): Promise<CrmLead[]> {
  const out: CrmLead[] = [];
  const limit = 200;
  for (let page = 1; page <= 50; page++) {
    let res: Response;
    try {
      res = await crmFetch(`/org/leads?page=${page}&limit=${limit}`, token);
    } catch {
      break;
    }
    if (!res.ok) break;
    const data: any = await res.json().catch(() => null);
    const rows: any[] = Array.isArray(data?.leads) ? data.leads : Array.isArray(data) ? data : [];
    for (const l of rows) {
      out.push({
        id: String(l?.id ?? ''),
        leadNumber: l?.leadNumber ?? undefined,
        name: l?.name ?? undefined,
        status: String(l?.status ?? 'new'),
        customerId: l?.customerId ?? undefined,
        customerName: (l?.customerName ?? '').trim() || undefined,
        customerPhone: l?.customerPhone ?? undefined,
        serviceName: l?.serviceName ?? undefined,
        paymentStatus: l?.paymentStatus ?? undefined,
        totalPayment: l?.totalPayment != null ? String(l.totalPayment) : undefined,
        hotWarmCold: l?.hotWarmCold ?? undefined,
        assignedUsers: Array.isArray(l?.assignedUsers)
          ? l.assignedUsers.map((a: any) => ({ userId: String(a?.userId ?? ''), userName: a?.userName ?? undefined }))
          : [],
        createdAt: l?.createdAt ?? undefined,
        callbackOn: l?.callbackOn ?? undefined,
        callCount: Number(l?.callCount ?? 0),
        createdByName: l?.creatorName ?? undefined,
        updatedByName: l?.updaterName ?? undefined,
      });
    }
    const totalPages: number | undefined = data?.pagination?.totalPages;
    if (rows.length < limit) break;
    if (totalPages && page >= totalPages) break;
  }
  return out;
}

export interface CrmMember {
  userId: string;
  name: string;
  email: string;
  role?: string;
}

/** All org members (users) — for the access page. */
export async function listMembers(token: string): Promise<CrmMember[]> {
  const out: CrmMember[] = [];
  const limit = 200;
  for (let page = 1; page <= 20; page++) {
    let res: Response;
    try {
      res = await crmFetch(`/org/members?page=${page}&limit=${limit}`, token);
    } catch {
      break;
    }
    if (!res.ok) break;
    const data: any = await res.json().catch(() => null);
    const rows: any[] = Array.isArray(data?.members)
      ? data.members
      : Array.isArray(data)
        ? data
        : [];
    for (const m of rows) {
      const userId = String(m?.userId ?? m?.id ?? '');
      const email = (m?.email ?? '').trim();
      if (!userId && !email) continue;
      out.push({
        userId,
        name: (m?.fullName ?? m?.username ?? '').trim() || email || '(unnamed)',
        email,
        role: m?.role ?? undefined,
      });
    }
    const totalPages: number | undefined = data?.pagination?.totalPages;
    if (rows.length < limit) break;
    if (totalPages && page >= totalPages) break;
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export interface CrmService {
  id: string;
  name: string;
}

/** The org's services (for the "service" picker when creating a lead). */
export async function listServices(token: string): Promise<CrmService[]> {
  const out: CrmService[] = [];
  const limit = 200;
  for (let page = 1; page <= 50; page++) {
    let res: Response;
    try {
      res = await crmFetch(`/org/services?page=${page}&limit=${limit}`, token);
    } catch {
      break;
    }
    if (!res.ok) break;
    const data: any = await res.json().catch(() => null);
    const rows: any[] = Array.isArray(data?.services)
      ? data.services
      : Array.isArray(data)
        ? data
        : [];
    for (const s of rows) {
      const id = String(s?.id ?? '');
      if (id) out.push({ id, name: (s?.name ?? '').trim() || '(unnamed service)' });
    }
    const totalPages: number | undefined = data?.pagination?.totalPages;
    if (rows.length < limit) break;
    if (totalPages && page >= totalPages) break;
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export interface CrmCall {
  id: string;
  callDate?: string;
  description?: string;
  createdAt?: string;
  /** Name of the CRM user who logged this record. */
  createdByName?: string;
}

/** A lead's full detail (incl. its call/update records) from the CRM. */
export async function getLead(token: string, leadId: string): Promise<Record<string, unknown> | null> {
  try {
    const res = await crmFetch(`/org/leads/${encodeURIComponent(leadId)}`, token);
    if (!res.ok) return null;
    return (await res.json().catch(() => null)) as Record<string, unknown> | null;
  } catch {
    return null;
  }
}

/** Add a call / update record to a lead (the CRM "check" modal action). */
export async function addLeadCall(
  token: string,
  leadId: string,
  input: { description?: string; callDate?: string },
): Promise<CrmCall> {
  const res = await crmFetch(`/org/leads/${encodeURIComponent(leadId)}/calls`, token, {
    method: 'POST',
    body: JSON.stringify({
      description: input.description ?? '',
      ...(input.callDate ? { call_date: input.callDate } : {}),
    }),
  });
  if (!res.ok) {
    const data: any = await res.json().catch(() => ({}));
    const e: any = new Error(data?.error || data?.message || `CRM add-call failed (${res.status})`);
    e.status = res.status === 401 || res.status === 403 || res.status === 404 ? res.status : 502;
    throw e;
  }
  const c: any = await res.json().catch(() => ({}));
  return {
    id: String(c?.id ?? ''),
    callDate: c?.callDate ?? undefined,
    description: c?.description ?? undefined,
    createdAt: c?.createdAt ?? undefined,
  };
}

/** Edit an existing call / update record (description and/or date). */
export async function updateLeadCall(
  token: string,
  leadId: string,
  callId: string,
  input: { description?: string; callDate?: string },
): Promise<CrmCall> {
  const body: Record<string, unknown> = {};
  if (input.description !== undefined) body.description = input.description;
  if (input.callDate !== undefined) body.call_date = input.callDate;
  const res = await crmFetch(
    `/org/leads/${encodeURIComponent(leadId)}/calls/${encodeURIComponent(callId)}`,
    token,
    { method: 'PATCH', body: JSON.stringify(body) },
  );
  if (!res.ok) {
    const data: any = await res.json().catch(() => ({}));
    const e: any = new Error(data?.error || data?.message || `CRM call update failed (${res.status})`);
    e.status = res.status === 401 || res.status === 403 || res.status === 404 ? res.status : 502;
    throw e;
  }
  const c: any = await res.json().catch(() => ({}));
  return {
    id: String(c?.id ?? callId),
    callDate: c?.callDate ?? undefined,
    description: c?.description ?? undefined,
    createdAt: c?.createdAt ?? undefined,
  };
}

/** Delete a call / update record from a lead. */
export async function deleteLeadCall(
  token: string,
  leadId: string,
  callId: string,
): Promise<void> {
  const res = await crmFetch(
    `/org/leads/${encodeURIComponent(leadId)}/calls/${encodeURIComponent(callId)}`,
    token,
    { method: 'DELETE' },
  );
  if (!res.ok) {
    const data: any = await res.json().catch(() => ({}));
    const e: any = new Error(data?.error || data?.message || `CRM call delete failed (${res.status})`);
    e.status = res.status === 401 || res.status === 403 || res.status === 404 ? res.status : 502;
    throw e;
  }
}

/** Editable lead fields (a sensible subset of the CRM lead form). */
export interface CrmLeadEdit {
  status?: string;
  name?: string;
  source?: string;
  hotWarmCold?: string;
  paymentStatus?: string;
  totalPayment?: string;
  paymentLeft?: string;
  callbackOn?: string;
  description?: string;
  notes?: string;
  /** Full replacement set of assigned user ids (the CRM replaces, not appends). */
  assignedUserIds?: string[];
}

/** Create a new lead (optionally linked to a contact/service via id). */
export async function createLead(
  token: string,
  fields: CrmLeadEdit & { customerId?: string; serviceId?: string },
): Promise<Record<string, unknown> | null> {
  const map: Record<string, string | undefined> = {
    customer_id: fields.customerId,
    service_id: fields.serviceId,
    name: fields.name,
    status: fields.status,
    source: fields.source,
    hot_warm_cold: fields.hotWarmCold,
    payment_status: fields.paymentStatus,
    total_payment: fields.totalPayment,
    payment_left: fields.paymentLeft,
    callback_on: fields.callbackOn,
    description: fields.description,
    notes: fields.notes,
  };
  const body: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(map)) if (v !== undefined && v !== '') body[k] = v;
  if (fields.assignedUserIds !== undefined) body.assigned_user_ids = fields.assignedUserIds;
  const res = await crmFetch('/org/leads', token, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const data: any = await res.json().catch(() => ({}));
    const e: any = new Error(data?.error || data?.message || `CRM lead create failed (${res.status})`);
    e.status = res.status === 401 || res.status === 403 ? res.status : 502;
    throw e;
  }
  return (await res.json().catch(() => null)) as Record<string, unknown> | null;
}

/** Update a lead's fields (the CRM lead edit form). Returns the updated lead. */
export async function updateLead(
  token: string,
  leadId: string,
  fields: CrmLeadEdit,
): Promise<Record<string, unknown> | null> {
  const map: Record<string, string | undefined> = {
    status: fields.status,
    name: fields.name,
    source: fields.source,
    hot_warm_cold: fields.hotWarmCold,
    payment_status: fields.paymentStatus,
    total_payment: fields.totalPayment,
    payment_left: fields.paymentLeft,
    callback_on: fields.callbackOn,
    description: fields.description,
    notes: fields.notes,
  };
  const body: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(map)) if (v !== undefined) body[k] = v;
  if (fields.assignedUserIds !== undefined) body.assigned_user_ids = fields.assignedUserIds;
  const res = await crmFetch(`/org/leads/${encodeURIComponent(leadId)}`, token, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const data: any = await res.json().catch(() => ({}));
    const e: any = new Error(data?.error || data?.message || `CRM lead update failed (${res.status})`);
    e.status = res.status === 401 || res.status === 403 || res.status === 404 ? res.status : 502;
    throw e;
  }
  return (await res.json().catch(() => null)) as Record<string, unknown> | null;
}

/** The full org contact list (cached) — for the admin "all contacts" page. */
export async function listAllContacts(userId: string, token: string): Promise<CrmContact[]> {
  const { all } = await getCache(userId, token);
  return [...all].sort((a, b) => a.name.localeCompare(b.name));
}

/** Search the org's contacts by name (case-insensitive), for the "attach" picker. */
export async function searchContacts(
  userId: string,
  token: string,
  q: string,
  limit = 20,
): Promise<CrmContact[]> {
  const needle = q.trim().toLowerCase();
  const { all } = await getCache(userId, token);
  const pool = needle
    ? all.filter((c) => c.name.toLowerCase().includes(needle) || (c.phone ?? '').includes(needle))
    : all;
  return pool.slice(0, Math.min(Math.max(limit, 1), 50));
}

function applyToCache(userId: string, contact: CrmContact): void {
  const entry = cache.get(userId);
  if (!entry) return;
  // refresh the full-list row
  const idx = entry.all.findIndex((c) => c.id === contact.id);
  if (idx >= 0) entry.all[idx] = contact;
  else entry.all.push(contact);
  const key = last10(contact.phone);
  if (key) entry.map.set(key, contact);
}

/** Create a CRM contact, then update the cache so it shows immediately. */
export async function createContact(
  userId: string,
  token: string,
  input: { firstName: string; lastName?: string; phone?: string; description?: string },
): Promise<CrmContact> {
  const res = await crmFetch('/org/contacts', token, {
    method: 'POST',
    body: JSON.stringify({
      first_name: input.firstName,
      ...(input.lastName ? { last_name: input.lastName } : {}),
      ...(input.phone ? { phone: toPhone(input.phone) } : {}),
      ...(input.description ? { description: input.description } : {}),
    }),
  });
  if (!res.ok) {
    const data: any = await res.json().catch(() => ({}));
    const e: any = new Error(data?.error || data?.message || `CRM create failed (${res.status})`);
    e.status = res.status === 401 || res.status === 403 ? res.status : 502;
    throw e;
  }
  const contact = toContact(await res.json().catch(() => ({})), input.firstName, input.phone);
  applyToCache(userId, contact);
  return contact;
}

/** Update a CRM contact's fields (matches the CRM's contact edit form). */
export async function updateContact(
  userId: string,
  token: string,
  contactId: string,
  fields: CrmContactEdit,
): Promise<CrmContact> {
  const map: Record<string, string | undefined> = {
    first_name: fields.firstName,
    last_name: fields.lastName,
    email: fields.email,
    type: fields.type,
    street: fields.street,
    city: fields.city,
    state: fields.state,
    pincode: fields.pincode,
    country: fields.country,
    description: fields.description,
  };
  const body: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(map)) if (v !== undefined) body[k] = v;
  if (fields.phone !== undefined) body.phone = toPhone(fields.phone ?? '');
  const res = await crmFetch(`/org/contacts/${encodeURIComponent(contactId)}`, token, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const data: any = await res.json().catch(() => ({}));
    const e: any = new Error(data?.error || data?.message || `CRM update failed (${res.status})`);
    e.status = res.status === 401 || res.status === 403 || res.status === 404 ? res.status : 502;
    throw e;
  }
  const contact = toContact(await res.json().catch(() => ({})));
  applyToCache(userId, contact);
  return contact;
}

/**
 * Attach a WhatsApp number to an EXISTING CRM contact (sets its phone). When
 * `detachFromId` is given (a "switch"), the number is first cleared off that
 * previous contact so it isn't left on two contacts.
 */
export async function attachContact(
  userId: string,
  token: string,
  contactId: string,
  phone: string,
  detachFromId?: string,
): Promise<CrmContact> {
  if (detachFromId && detachFromId !== contactId) {
    try {
      const res0 = await crmFetch(`/org/contacts/${encodeURIComponent(detachFromId)}`, token, {
        method: 'PATCH',
        body: JSON.stringify({ phone: '' }),
      });
      if (res0.ok) {
        const old = toContact(await res0.json().catch(() => ({})));
        const entry = cache.get(userId);
        if (entry) {
          const idx = entry.all.findIndex((c) => c.id === old.id);
          if (idx >= 0) entry.all[idx] = { ...old, phone: undefined };
          for (const [k, v] of entry.map) if (v.id === old.id) entry.map.delete(k);
        }
      }
    } catch {
      /* best-effort — still attach to the new contact below */
    }
  }
  const res = await crmFetch(`/org/contacts/${encodeURIComponent(contactId)}`, token, {
    method: 'PATCH',
    body: JSON.stringify({ phone: toPhone(phone) }),
  });
  if (!res.ok) {
    const data: any = await res.json().catch(() => ({}));
    const e: any = new Error(data?.error || data?.message || `CRM attach failed (${res.status})`);
    e.status = res.status === 401 || res.status === 403 || res.status === 404 ? res.status : 502;
    throw e;
  }
  const contact = toContact(await res.json().catch(() => ({})), undefined, phone);
  applyToCache(userId, contact);
  return contact;
}
