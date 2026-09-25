/**
 * WhatsApp now hides many contacts/participants behind a privacy "Linked ID"
 * (`<lid>@lid`) whose digits are NOT a phone number. This resolves an id to its
 * real phone number, following `@lid -> @c.us` via WPPConnect's LID/PN mapping.
 *
 * Returns `null` for groups and for LIDs that cannot be resolved (so callers
 * can hide the number rather than show a bogus one).
 */
export async function resolveRealNumber(
  client: any,
  id: string,
): Promise<{ wid: string; number: string } | null> {
  if (!id || id.endsWith('@g.us')) return null;

  if (id.endsWith('@c.us')) {
    const number = id.split('@')[0];
    return number ? { wid: id, number } : null;
  }

  if (id.endsWith('@lid')) {
    if (typeof client.getPnLidEntry !== 'function') return null;
    try {
      const entry: any = await client.getPnLidEntry(id);
      const number: string | undefined = entry?.phoneNumber?.id;
      const wid: string | undefined =
        entry?.phoneNumber?._serialized ?? (number ? `${number}@c.us` : undefined);
      if (number && wid) return { wid, number };
    } catch {
      /* unresolved — fall through to null */
    }
    return null;
  }

  // Bare digits or other server — treat the leading digits as the number.
  const number = id.split('@')[0].replace(/\D/g, '');
  return number ? { wid: `${number}@c.us`, number } : null;
}

// ---- Cached resolution for the chat list --------------------------------
//
// The chat-list endpoint must attach a real number to every individual chat so
// the frontend can search/match by phone — but @lid ids need an async lookup.
// The PN<->LID mapping is stable, so we cache successes for the process
// lifetime and only briefly back off on failures (WhatsApp may not have synced
// the mapping yet), so an unresolved contact self-heals on a later refetch.
const lidNumberCache = new Map<string, string>(); // id -> number (permanent)
const lidRetryAfter = new Map<string, number>(); // id -> epoch ms to retry a prior miss
const LID_MISS_TTL_MS = 10 * 60 * 1000;

/** Resolve one chat id to its phone number, with caching. undefined for groups
 *  and LIDs the library can't resolve. */
export async function resolveNumberCached(client: any, id: string): Promise<string | undefined> {
  if (!id || id.endsWith('@g.us')) return undefined;
  if (id.endsWith('@c.us')) return id.split('@')[0] || undefined;
  const hit = lidNumberCache.get(id);
  if (hit) return hit;
  const retryAt = lidRetryAfter.get(id);
  if (retryAt && Date.now() < retryAt) return undefined; // recently failed — back off
  const r = await resolveRealNumber(client, id).catch(() => null);
  if (r?.number) {
    lidNumberCache.set(id, r.number);
    lidRetryAfter.delete(id);
    return r.number;
  }
  lidRetryAfter.set(id, Date.now() + LID_MISS_TTL_MS);
  return undefined;
}

/** Fill in `number` for individual chats whose id is a privacy @lid — the
 *  serializer only sets it for @c.us, so saved contacts shown behind a LID would
 *  otherwise have no number to search by. Batched (bounded concurrency) and
 *  cached, so the first call pays the cost and later refetches are ~instant.
 *  Mutates the passed DTOs in place. */
export async function attachRealNumbers(
  client: any,
  chats: { id: string; isGroup: boolean; number?: string }[],
  concurrency = 24,
): Promise<void> {
  const pending = chats.filter((c) => !c.number && !c.isGroup && c.id.includes('@lid'));
  for (let i = 0; i < pending.length; i += concurrency) {
    const batch = pending.slice(i, i + concurrency);
    await Promise.all(
      batch.map(async (c) => {
        const num = await resolveNumberCached(client, c.id).catch(() => undefined);
        if (num) c.number = num;
      }),
    );
  }
}
