# 03: Run one durable conversation through the server

**What to build:** One authenticated Web UI client can create, open, submit to, stream, abort, and reload a conversation whose state and committed results survive server restart.

**Blocked by:** 02: Define the versioned protocol and workspace model

**Status:** complete (single-client slice; gateway tool integration remains ticket 04)

- [x] Start one server-owned `pi-durable` runtime with one SQLite writer/owner.
- [x] Expose narrowly scoped authenticated APIs for conversation list/open, submit, busy mode, abort, settings/model, and snapshot/event streaming.
- [x] Preserve request IDs, server-owned ordering, durable results, and reconnect hydration.
- [x] Adapt pi-web AgentEventConnection behind an authenticated durable-session browser transport; serve a minimal chat page at /.
- [x] Persist per-conversation model/thinking settings through configure(); expose provider catalogue and map React controls. Admit steer/follow-up through durable inbox and expose queued state. Preserve structured messages for upstream rendering. Gateway-generated tool verification remains ticket 04.
- [x] Verify authenticated access, streamed event connection, durable response, invalid protocol rejection, and server restart persistence.

## Comments

The first formal pnpm backend slice is `apps/server` (`@hepi/server`). It consumes the unchanged published `@earendil-works/pi-durable@1.1.0` runtime over one SQLite storage and uses the deterministic faux provider. The server owns the root conversation, HTTP admission, SSE, request IDs, and authentication; clients do not run an agent loop.

The first pi-web connection pathway is now copied and adapted; see docs/chat.md for source mapping and behavior. A custom minimal chat page supports conversation selection/creation, submission, stop, and reconnect. Server and client share complete durable state frames. The full pi-web React/Next shell and components are now copied into apps/web and adapted through one authenticated Next API boundary plus a durable_state hook handler. Typecheck/build and a local browser submit/reload smoke passed. See apps/web/README.md; unsupported capabilities return 501 and remain explicit follow-ups. The backend supports durable independent conversation creation, list/reload routing, authenticated state/events/messages/settings/busy/abort endpoints, and explicit reconnect resync signaling.

Evidence: `apps/server/src/server.ts`, `apps/server/test/server.test.ts`, `apps/server/src/harness.ts`, and `docs/architecture.md`. Verified follow-up: per-conversation configure() settings survive restart; unknown models are rejected; a gated faux provider verifies busy reject/steer/follow-up without time sleeps, with queue contents and final transcript observed via HTTP/SSE. The artificial faux response delay was removed. Browser smoke verifies prompt/reply, settings command, backend 400 preservation, reload history and persisted level. All five workspace packages typecheck, 30 tests pass, and Next production build passes. Real OpenAI generation, gateway tools and visual tool-call progress remain unverified integration follow-ups.
