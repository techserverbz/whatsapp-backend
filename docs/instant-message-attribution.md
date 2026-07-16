# Live "Sent by" Attribution — the "untracked" bug and its fix

_Last updated: 2026-07-16_

## The problem

The WhatsApp app is a **shared inbox**: one linked WhatsApp account, one backend, but
many CRM users (e.g. `Shubhambhole68`, `akashkambli123`) logged in at the same time.
Every outbound message is tagged with **which CRM user sent it** ("Sent by …").

The bug: when two users were watching the same chat **live**, each saw their _own_
sends correctly attributed, but the _other_ person's message showed **"not tracked"**
(styled `untracked`). A page reload fixed it — but nobody reloads mid-conversation.

```
Shubham sends  ──►  Shubham's screen:  "Sent by Shubham"   ✅
                    Akash's screen:    "not tracked"        ❌   (should be "Sent by Shubham")
```

## Why it happened

There are **two ways** a message reaches a browser, and only one of them carried the
sender identity:

| Path | Carries `sentBy`? | Who relies on it |
| --- | --- | --- |
| **REST reload** — `GET /chats/:id/messages` → `attachSenders()` reads the attribution DB | ✅ Yes | Anyone who (re)opens/reloads a chat |
| **Live socket push** — WhatsApp `onAnyMessage` → `emitToAll('message:new', dto)` | ❌ **No** | Everyone watching live |

The sender's own screen looked fine only because the frontend **optimistically stamps
its own identity** on messages it sends (`meSender`). It was never reading attribution
from the server for its own sends — so it masked the bug for the sender while everyone
else got the un-attributed live push.

Attribution itself was never the problem: it's stored once, server-side, in a shared
PGlite table (`sent_messages`, keyed by WhatsApp message id) via `recordSent()`, and the
message ids are identical between the send result and history (same serializer). So a
reload always worked. The **live broadcast just didn't include it.**

## The fix

Add a tiny, dedicated **attribution-patch** event that rides alongside the message,
so every viewer — admin or not — resolves the sender live, without a reload.

### Backend

1. **New socket event** `message:sender` (`src/socket.ts`).
2. **`recordSent()` broadcasts it immediately** (`src/attribution.ts`). Because
   `recordSent` runs inside the authenticated send request, it already knows the CRM
   user **synchronously** — so it emits the identity straight from the request. **No DB
   read-after-write**, therefore no race:

   ```ts
   emitToAll(SocketEvents.MessageSender, {
     id: rec.messageId,
     chatId: rec.chatId,
     sentBy: { userId, email, name, role, at: Date.now() },
   });
   ```

   Both engines (WPPConnect **and** whatsapp-web.js) route every send through
   `recordSent`, so this one line covers both. It's best-effort and wrapped in
   try/catch — a socket hiccup can never break sending.

### Frontend

3. **Same event constant** (`src/lib/socket.ts`).
4. **Handle + buffer the patch** (`src/App.tsx`). The patch and the `message:new` echo
   are emitted from independent code paths, so they can arrive in **either order**. A
   small `Map` (`pendingSendersRef`) makes it order-independent:
   - `message:sender` arrives first → buffered; applied when the message shows up.
   - `message:new` arrives first → appended un-attributed; the patch stamps it in place.

   The listener is registered **globally** (not inside the per-engine branch) because
   `recordSent` broadcasts globally, so it works for both the single-session and the
   multi-engine (`session:event`) paths.

## Why this design

- **Race-free on _who_.** The identity comes from the request, not a DB round-trip, so
  it's correct even if the DB write hasn't committed yet.
- **No delay to the message.** The message still appears instantly; attribution follows
  a beat later (usually the same tick) and patches in.
- **Self-healing.** The old reload path (`attachSenders`) is untouched — anything the
  live patch misses is still correct on the next load.
- **Everyone sees it.** Nothing about attribution is admin-gated — non-admins get the
  same `message:sender` patches and the same historical attribution on load.
- **Phone-sent messages stay honest.** `recordSent` no-ops when there's no CRM user, so
  messages sent from the actual phone still read "not tracked" (correct).

## Files changed

| Repo | File | Change |
| --- | --- | --- |
| backend | `src/socket.ts` | add `MessageSender: 'message:sender'` |
| backend | `src/attribution.ts` | `recordSent()` emits the `message:sender` patch |
| frontend | `src/lib/socket.ts` | same event constant |
| frontend | `src/App.tsx` | buffer + apply the patch (`pendingSendersRef`, `onSender`) |
| frontend | `vercel.json` | proxy `/socket.io/*` to the backend so live events work in prod |

## Deploying

- **Backend** runs on the standalone machine (`desktop-vm4nf62`): copy the two changed
  `src/` files and restart (it hot-reloads under `tsx watch`).
- **Frontend** is on Vercel; the `vercel.json` `/socket.io/*` rewrite is required or the
  production site never receives the live events (it would fall back to reload-only).
