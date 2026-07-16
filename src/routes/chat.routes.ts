import { Router } from 'express';
import { session } from '../whatsapp/session';
import { serializeChat, serializeMessage } from '../whatsapp/serializers';
import { resolveRealNumber } from '../whatsapp/lid';
import { cacheMessages } from '../whatsapp/msgCache';
import { archiveMessages, readArchive } from '../whatsapp/msgStore';
import { addNote, deleteNote, getNoteChatIds, getNotes } from '../notes';
import { attachSenders } from '../attribution';
import { config } from '../config';

const router = Router();

// Raised from 200 so a single request can return deep history. The real
// "show older messages" fix is the back-loading loop below (it mirrors
// whatsapp-web.js `fetchMessages({ limit })`, which the WPPConnect store won't
// do on its own — it only keeps a recent window).
const MAX_MESSAGES = 2000;
const DEFAULT_MESSAGES = 50;
const BACKFILL_MAX_ROUNDS = 60;        // safety cap on loadEarlierMessages iterations per request
const EARLIER_SETTLE_MS = 350;         // wait after each loadEarlierMessages so async history can arrive
const EMPTY_ROUNDS_BEFORE_STOP = 5;    // consecutive empty rounds that mean we've truly reached the start

/** All chats (conversations), newest activity first. */
router.get('/', async (_req, res, next) => {
  try {
    const client = session.getClient();
    const chats: any[] = await client.listChats();
    const dto = chats.map(serializeChat).sort((a, b) => b.timestamp - a.timestamp);
    res.json(dto);
  } catch (e) {
    next(e);
  }
});

// ---- Per-chat notes (persisted; independent of the WhatsApp session) ----

/** Chat ids that currently have a note (for list indicators). */
router.get('/note-index', (_req, res) => {
  res.json(getNoteChatIds());
});

/** List a chat's note entries (chronological). */
router.get('/:chatId/notes', (req, res) => {
  res.json(getNotes(req.params.chatId));
});

/** Add a new timestamped note entry. Returns the full list. */
router.post('/:chatId/notes', (req, res) => {
  const text = typeof req.body?.text === 'string' ? req.body.text : '';
  res.json(addNote(req.params.chatId, text));
});

/** Delete a single note entry by id. Returns the remaining list. */
router.delete('/:chatId/notes/:noteId', (req, res) => {
  res.json(deleteNote(req.params.chatId, req.params.noteId));
});

/**
 * Messages in a chat (oldest -> newest). Pass `before=<messageId>` to page
 * backwards through history — returns the batch immediately older than that id.
 */
router.get('/:chatId/messages', async (req, res, next) => {
  try {
    const chatId = req.params.chatId;
    const requested = Number(req.query.count) || DEFAULT_MESSAGES;
    const count = Math.min(Math.max(requested, 1), MAX_MESSAGES);
    const before = typeof req.query.before === 'string' ? req.query.before : undefined;

    // ---- Paging BACK (scroll up / "Load earlier") ----
    // Serve older messages straight from the durable archive (instant, and keeps
    // history WhatsApp may have already dropped). Only when the archive runs out
    // near this point do we ask WhatsApp to pull the next older batch from the phone.
    if (before) {
      let older = readArchive(chatId, count, before);
      if (older.length < count) {
        try {
          const client = session.getClient();
          // Back-load older history from the phone until the archive can satisfy
          // `count` messages older than `before`, or WhatsApp has nothing older
          // left. WPPConnect's store keeps only a recent window and won't backfill
          // on its own, so we drive it with REPEATED loadEarlierMessages calls —
          // the equivalent of whatsapp-web.js `fetchMessages({ limit })`. (The old
          // code called loadEarlierMessages just once, so history stopped early.)
          let prevOlderTotal = readArchive(chatId, Number.MAX_SAFE_INTEGER, before).length;
          let emptyRounds = 0;
          for (let round = 0; round < BACKFILL_MAX_ROUNDS && older.length < count; round++) {
            await client.loadEarlierMessages(chatId);
            // WhatsApp pulls earlier history from the phone ASYNChronously, so give
            // the store a beat to populate before we read it back.
            await new Promise((r) => setTimeout(r, EARLIER_SETTLE_MS));
            const live: any[] = await client.getMessages(chatId, {
              count,
              id: before,
              direction: 'before',
            } as any);
            cacheMessages(live);
            if (live.length) archiveMessages(chatId, live.map(serializeMessage));
            older = readArchive(chatId, count, before);
            const olderTotal = readArchive(chatId, Number.MAX_SAFE_INTEGER, before).length;
            if (olderTotal <= prevOlderTotal) {
              // No new older messages THIS round — but since loading is async, don't
              // give up yet. Only conclude we've hit the true start of the chat after
              // several consecutive empty rounds (prevents a premature "Start of
              // conversation" while WhatsApp is still backfilling from the phone).
              if (++emptyRounds >= EMPTY_ROUNDS_BEFORE_STOP) break;
            } else {
              emptyRounds = 0;
              prevOlderTotal = olderTotal;
            }
          }
        } catch {
          /* not connected / reached the real start — serve what the archive has */
        }
      }
      return res.json(await attachSenders(older, config.session));
    }

    // ---- Initial open ----
    // If we already have this chat archived, serve it INSTANTLY (no WhatsApp
    // round-trip — fixes "loads the chat again every time"), then refresh from
    // WhatsApp in the background so the archive keeps up. Live messages also
    // stream in over the socket, so an open chat stays current.
    const cached = readArchive(chatId, count);
    if (cached.length) {
      res.json(await attachSenders(cached, config.session));
      void (async () => {
        try {
          const client = session.getClient();
          const live: any[] = await client.getMessages(chatId, { count } as any);
          cacheMessages(live);
          if (live.length) archiveMessages(chatId, live.map(serializeMessage));
        } catch {
          /* background refresh is best-effort */
        }
      })();
      return;
    }

    // First time we've ever seen this chat — fetch live, archive, then serve.
    const client = session.getClient();
    const messages: any[] = await client.getMessages(chatId, { count } as any);
    cacheMessages(messages);
    archiveMessages(chatId, messages.map(serializeMessage));
    res.json(await attachSenders(readArchive(chatId, count), config.session));
  } catch (e) {
    next(e);
  }
});

/** Profile picture URL for a chat/contact (null if none or private). */
router.get('/:chatId/profile-pic', async (req, res, next) => {
  try {
    const client = session.getClient();
    try {
      const pic: any = await client.getProfilePicFromServer(req.params.chatId);
      res.json({ url: pic?.eurl ?? pic?.imgFull ?? pic?.img ?? null });
    } catch {
      res.json({ url: null });
    }
  } catch (e) {
    next(e);
  }
});

const PARTICIPANT_RESOLVE_CAP = 64;

/** Resolve a chat/participant id to its real phone number (follows @lid). */
router.get('/:chatId/phone', async (req, res, next) => {
  try {
    const client = session.getClient();
    const r = await resolveRealNumber(client, req.params.chatId);
    res.json({ wid: r?.wid ?? null, number: r?.number ?? null });
  } catch (e) {
    next(e);
  }
});

/** Consolidated contact / group info for the "View contact" panel. */
router.get('/:chatId/contact', async (req, res, next) => {
  try {
    const client = session.getClient();
    const chatId = req.params.chatId;
    const isGroup = chatId.endsWith('@g.us');
    const wid = (w: any): string =>
      !w ? '' : typeof w === 'string' ? w : w._serialized ?? w.id?._serialized ?? '';

    const contact: any = await client.getContact(chatId).catch(() => null);
    // Follow @lid -> @c.us so we display the real phone number, not the LID.
    const resolved = isGroup ? null : await resolveRealNumber(client, chatId);

    let about: string | undefined;
    try {
      const s: any = await (client as any).getStatus(chatId);
      about = typeof s === 'string' ? s : s?.status ?? undefined;
    } catch {
      /* "about" not available */
    }

    let profilePic: string | null = null;
    try {
      const pic: any = await client.getProfilePicFromServer(chatId);
      profilePic = pic?.eurl ?? pic?.imgFull ?? pic?.img ?? null;
    } catch {
      /* no picture / private */
    }

    const info: Record<string, unknown> = {
      id: chatId,
      isGroup,
      name:
        contact?.formattedName ?? contact?.name ?? contact?.pushname ?? resolved?.number ?? '',
      pushname: contact?.pushname ?? undefined,
      number: resolved?.number ?? undefined,
      realWid: resolved?.wid ?? undefined,
      isBusiness: !!contact?.isBusiness,
      isMyContact: !!contact?.isMyContact,
      about,
      profilePic,
    };

    if (isGroup) {
      try {
        const chat: any = await (client as any).getChatById(chatId);
        const meta: any = chat?.groupMetadata ?? {};
        const parts: any[] = Array.isArray(meta?.participants) ? meta.participants : [];
        info.groupDesc = meta?.desc ?? undefined;
        info.owner = wid(meta?.owner);
        info.participantsCount = parts.length;

        let nameById = new Map<string, string>();
        try {
          const members: any[] = await (client as any).getGroupMembers(chatId);
          nameById = new Map(
            members.map((m: any) => [
              wid(m?.id),
              m?.formattedName ?? m?.name ?? m?.pushname ?? '',
            ]),
          );
        } catch {
          /* participant names are best-effort */
        }

        const capped = parts.slice(0, 1024);
        // Resolve real phone numbers for up to N participants (LIDs), in parallel.
        const numberById = new Map<string, string>();
        await Promise.all(
          capped.slice(0, PARTICIPANT_RESOLVE_CAP).map(async (p: any) => {
            const pid = wid(p?.id);
            const r = await resolveRealNumber(client, pid).catch(() => null);
            if (r) numberById.set(pid, r.number);
          }),
        );

        info.participants = capped.map((p: any) => {
          const id = wid(p?.id);
          return {
            id,
            number: numberById.get(id) ?? '',
            name: nameById.get(id) ?? '',
            isAdmin: !!(p?.isAdmin || p?.isSuperAdmin),
            isSuperAdmin: !!p?.isSuperAdmin,
          };
        });
      } catch {
        /* group metadata unavailable */
      }
    }

    res.json(info);
  } catch (e) {
    next(e);
  }
});

/** Mark a chat as read/seen. */
router.post('/:chatId/seen', async (req, res, next) => {
  try {
    const client = session.getClient();
    await client.sendSeen(req.params.chatId);
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

/** Show/hide the "typing…" indicator to the other side. */
router.post('/:chatId/typing', async (req, res, next) => {
  try {
    const client = session.getClient();
    const on = !!req.body?.on;
    if (on) await (client as any).startTyping(req.params.chatId);
    else await (client as any).stopTyping(req.params.chatId);
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

export default router;
