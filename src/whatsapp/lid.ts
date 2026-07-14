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
