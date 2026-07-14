/**
 * LRU cache of raw WPPConnect message objects keyed by message id.
 *
 * `getMessageById()` is unreliable on this WhatsApp build (throws on
 * `msgChunks`), but the raw message snapshots returned by `getMessages()`
 * work fine with `decryptFile()`. So we stash those snapshots here when a chat
 * loads and reuse them to decrypt media on demand — no re-lookup needed.
 */
const MAX = 1000;
const cache = new Map<string, any>();

function idOf(m: any): string | undefined {
  const id = m?.id;
  if (!id) return undefined;
  return typeof id === 'string' ? id : id._serialized;
}

export function cacheMessages(msgs: any[]): void {
  for (const m of msgs) {
    const id = idOf(m);
    if (!id) continue;
    if (cache.has(id)) cache.delete(id);
    cache.set(id, m);
  }
  while (cache.size > MAX) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

export function getCachedMessage(id: string): any | undefined {
  const m = cache.get(id);
  if (m !== undefined) {
    cache.delete(id);
    cache.set(id, m); // mark most-recently-used
  }
  return m;
}
