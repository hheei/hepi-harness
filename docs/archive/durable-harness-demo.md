# Durable harness demo

A deliberately small runnable demo of the boundary in
[`docs/adr/0001-single-authoritative-durable-runtime.md`](../../docs/adr/0001-single-authoritative-durable-runtime.md):
**one server-owned durable runtime, thin clients.** The browser holds no agent loop and no conversation
state it can lose.

The runtime is the real [`@earendil-works/pi-durable`](https://www.npmjs.com/package/@earendil-works/pi-durable)
`Harness` (1.1.0) over SQLite, not a stand-in. Only the model is fake: a deterministic
`faux` provider answers with a fixed delay and a fixed reply.

## Run

```bash
npm install
npm start          # http://localhost:8787
npm test           # node:test: SSE streaming, restart persistence, request-id dedup, reducer
npm run typecheck  # tsc --noEmit
```

`PORT` and `DEMO_DB` (default `data/demo.sqlite`) override the port and the storage file.

Things to try:

1. Send a message, then **close the tab while it answers**. Reopen: the answer is there.
2. Send a message, then **kill the server** mid-run and start it again. The run resumes from committed state.
3. Open **two tabs**: both see the same conversation, and neither owns it.

## What it demonstrates

| Demo behavior | Runtime feature |
| --- | --- |
| The conversation survives a server restart | SQLite storage; `Harness.open` reopens the same root |
| A run continues with no client attached | The server owns generation; the submission response is only an acknowledgement |
| A reconnect gets a coherent state, no duplicates | Snapshot hydration + event batches, applied by one pure reducer |
| Two clients submit safely | Server-owned ordering; a repeated `requestId` is admitted once |
| The UI draws streaming text | `watchEvents` batches: `message_start`, `message_update` deltas, `message_end` |

## Shape

```
src/harness.ts   one Harness over SQLite + the scripted faux provider
src/server.ts    HTTP + SSE projection of the conversation; no conversation state of its own
src/main.ts      wiring: port, storage path, signals
ui/reducer.js    pure browser projection of snapshots and agent events
ui/client.js     EventSource + submit; render only
test/demo.test.ts
```

Endpoints:

- `GET /` — the UI.
- `GET /api/state` — the current snapshot as JSON.
- `POST /api/messages` — `{ text, requestId? }` → `202` with the submission ID. Admission only: it does
  not wait for the answer, and generation commits the assistant entry itself.
- `GET /api/events` — SSE. `snapshot` on (re)connect, then one `events` frame per commit batch.
- `GET /ui/client.js`, `GET /ui/reducer.js` — the browser modules.

## Demo limitations

This is a demo, not the MVP slice. Deliberately absent:

- **No real model.** The `faux` provider answers with `Demo reply to: <your message>` after 400 ms. No
  LLM, no API key, no network. The provider script is not persisted, so a run that resumes after a
  restart is answered by the *new* process's script — the same reply, by construction.
- **No tools, no environment, no gateway.** No filesystem or shell execution, no SSH, no workspace or
  gateway model, no `ExecutionEnv`.
- **No authentication.** Every endpoint is open; bind it to localhost only. The ADR's token/private
  network requirement is untouched.
- **One conversation, one process, no multi-writer storage.** No conversation list, create, fork, abort,
  steer, compaction, settings, or usage UI. No SQLite writer coordination beyond the single process.
- **Revision markers are coarse.** SSE frames carry no revision number yet, and a slow client is simply
  dropped rather than resynchronized from a bounded buffer. The runtime's view delivery sequence is the
  natural next marker; see the versioned-protocol ticket
  (`.scratch/durable-harness/issues/02-versioned-protocol-and-workspace-model.md`).
- **The UI is throwaway.** It is a ~100-line prototype that proves reconnect and streaming. The
  incremental `pi-web` adaptation behind a durable-session adapter is deferred
  (`.scratch/durable-harness/issues/03-durable-server-single-client-slice.md`), and no upstream UI code
  is copied here.
- **Not a durability guarantee.** SQLite in WAL mode with `synchronous = NORMAL` survives a process
  crash; the newest commits can be lost on power or host failure.

## Upstream

`@earendil-works/pi-durable`, `@earendil-works/pi-ai`, and `@earendil-works/chord` are MIT-licensed
Earendil Works packages, pinned to `1.1.0`. Nothing is vendored: the demo consumes their published
entrypoints only. Provenance capture for adapted upstream sources remains
`.scratch/durable-harness/issues/01-upstream-provenance-and-baseline.md`.
