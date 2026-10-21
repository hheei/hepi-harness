# 04: Session fork

**What to build:** Forking a session at a chosen point creates a new session carrying the history up to that point,
answers the new session identity and its catalogue row, and leaves the source session's live run undisturbed. Fork
uses the runtime's own conversation fork, including its fork-aware document semantics.

**Blocked by:** None (can start immediately)

**Status:** resolved — merged into `integration/ux-follow-up`.

**Demo path:** Fork a session from an entry in the middle of its history, see the new row appear in the list, open it
and find exactly the history up to that point while the original session keeps running.

**Stories:** 33, 34, 35, 36, 37

**Seam:** browser → existing Web adapter → durable backend, with the real store.

- [x] A fork answers the new session identity and its catalogue row, and the new session appears in the list without a
      page reload.
- [x] The fork's history equals the source's history up to the chosen entry, asserted by reading both back through the
      durable API.
- [x] The source session's entries are unchanged by the fork and a live run in it continues undisturbed.
- [x] A fork of a missing, unsaved, empty or subagent session is refused with a readable reason, and nothing is
      created.
- [x] The fork is created by the runtime's own fork, so its conversation-scoped documents follow the runtime's
      fork semantics.
- [x] Two windows of one backend agree after the fork.

**Context:** [Spec](../spec.md) decisions 12, 13; stories 33–37. The upstream route's request and response shapes are
the contract to honour; the durable conversation is not a file to copy.

## What was built

The backend owns the copy: `POST /api/conversations/:id/fork` (body `{ at? }`) forks through pi-durable's own
`Conversation.fork()` at a named entry, or at the conversation's newest committed entry when none is named, and
answers `{ conversationId, conversation }` where the row is built by the same `catalogueEntry()` the
`GET /api/conversations` list uses. Refusals are the upstream vocabulary — `not_found`, `unsaved`, `empty`,
`subagent` — decided before the fork commit, so nothing is created; every conversation-scoped route now also carries
`code: "not_found"` on an unknown conversation, which is what the sidebar's `forkFailureMessage` already names.

The Web adapter's `POST /api/sessions/:id/fork` forwards to that operation and rebuilds the row through the one
`catalogueRow()` the list also uses, so the copy cannot be handed a row the next list read contradicts; a refusal is
forwarded with the backend's status and code. `/api/agent/:id` `fork`/`fork_branch` reaches the same operation, so
the message view's "new session from here" and the sidebar's row-menu Fork are one capability.

Two supporting changes were needed and are minimal: the catalogue carries each conversation's `parentConversationId`
from its immutable record (set at attach time from the scan already being done, so no per-list read was added), and the
session-list version now counts conversations as well as revisions, because a new conversation's revision starts at
zero and a fork would otherwise be invisible to another window's poll.

## Review notes

- **Recorded: no name is given to the copy.** The upstream file-backed fork names its copy (`source · 3f9a`), and the
  copied sidebar splits that suffix in the row and the toast. Here the title is hepi conversation-scoped state that
  tickets 02 and 06 own, so the fork route does not invent one; the copy's row shows its first message until it is
  renamed or auto-named. Trigger: a user forks twice and both rows look alike. Impact: cosmetic. Revisit when ticket 02
  lands the title document, or when a user asks for fork naming.
- **Recorded: a fork point the client names but the durable conversation has not committed is refused as `unsaved`.**
  Upstream distinguishes "the session has no file yet" from "the entry is not there"; both mean the same thing here,
  and the sidebar's message for `unsaved` reads correctly for either. Trigger: a client whose transcript is ahead of
  the committed one. Impact: the reason is slightly broader than the cause. Revisit if a user reports a misleading
  reason.

Findings recorded here follow [review policy](../../../docs/agents/review-policy.md).
