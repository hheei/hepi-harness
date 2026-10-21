# 14: Durable extension inventory and selection state

**What to build:** The backend answers which durable extensions are installed, stores a global default selection as
hepi application state, materializes each conversation's selection explicitly when the conversation is created, and
accepts a per-conversation override. A change to the global default never rewrites an existing conversation.

**Blocked by:** None (can start immediately)

**Status:** resolved — merged into `integration/ux-follow-up`.

**Demo path:** List the installed extensions, change the global default, create a conversation and show it selected the
new default, then change the default again and show the older conversation still selects what it was created with.

**Stories:** 91, 92, 93, 94, 95, 96, 97, 98, 99, 100

**Seam:** the backend's public surface through the existing Web adapter, with the real store. No paid model call.

- [x] The backend answers the installed extension names from the runtime's registry, not from a parallel list.
- [x] An extension that fails to install at startup is reported at startup rather than being silently absent.
- [x] The global default is stored as hepi application state, survives a backend restart, and applies to a
      conversation created after the change.
- [x] Each conversation's selection is materialized explicitly at creation, and a later global-default change leaves
      that conversation's selection and its offered tools unchanged.
- [x] A per-conversation override writes that conversation's own selection and survives a reload.
- [x] An extension not selected by a conversation is absent from that conversation's offered tools.
- [x] The installed set comes from the runtime's registry and the selected set from the framework's own
      per-conversation selection field; no second extension registry is introduced.
- [x] The runtime's harness-wide default is read at resolution and never copied, so no conversation's selection moves
      because of it.

**Context:** [Spec](../spec.md) decisions 43–50; stories 91–100. The browser half is ticket 15.

## Comments

**Implemented.** Four pieces, all on the backend's public surface through the existing Web adapter:

- `GET /api/extensions` answers the installed set from `runtime.registry.snapshot().installed()` — the same registry
  `Harness.open` was given — with each extension's own tools and sections, the resolved global default, and the
  startup install failures. `POST /api/extensions` writes the whole default in one request.
- The default is hepi application state: `hepi.extension-selection`, a session-scoped document in
  `apps/server/src/extension-selection.ts`, written through the durable document path and read once at startup and
  kept current from this process's own commit stream. `HarnessSettings.extensions` is never set, so the runtime's
  harness-wide default cannot move a conversation that never chose (asserted).
- `POST /api/conversations` materializes the resolved default into the new conversation's own
  `pi.agent.extensions` in the creating commit. A conversation bound to no execution workspace withholds
  `coding-tools`, which has nothing to run in there.
- `PATCH /api/conversations/<id>/extensions` writes that conversation's own selection; the answer is the selection
  after the write and the tools it now offers. A name that is not installed, or a request that is not an array, is
  refused as a whole with the reason, so nothing is partially applied.
- The state snapshot's `extensions`/`toolNames` are derived with the framework's own selection rule
  (`reportedSelection`) from the conversation's committed `pi.agent.extensions`, which the view already carries; the
  read is not repeated on the session line, and the answer is what a request is actually offered.
- Startup install failures: `openServerHarness` installs each extension through a wrapper that catches the runtime's
  own validation error, records `{ name, message }` and reports it, so a broken extension is named at startup and
  listed in the inventory instead of being silently absent. The rest of the backend still starts.
- The Web adapter forwards `/api/extensions` and `PATCH /api/sessions/<id>/extensions`, keeping the backend's status
  and reason on a refusal, and carries the conversation's selected extensions on its state answer and `durable_state`
  frame.

Verified on `impl/capability-14` at `9bc3db4` (this change on `76e75f7`, the integration branch's HEAD, which is
therefore already merged in):

| Command | Result | Log |
| --- | --- | --- |
| `node --test apps/server/test/extensions.test.ts` | exit 0, 7/7 pass | `.dev/verify/2026-10-11T14-50-49-980-verify-fast/` |
| `node --test apps/web/adapters/*.test.mjs` | exit 0, 34/34 pass (4 new) | `.dev/verify/2026-10-11T14-51-33-524-web-unit/` |
| `pnpm verify --profile=fast` | exit 0: `workspace-typecheck` PASS, `workspace-tests` PASS (`@hepi/server` 174/174) | `.dev/verify/2026-10-11T14-50-49-980-verify-fast/verify.json` |
| `pnpm test:web:unit` | exit 1: 2087 tests, 2064 pass, 23 fail / 24 `not ok` names — the recorded whole-Web baseline | `.dev/verify/2026-10-11T14-51-33-524-web-unit/web-unit.json` |
| `pnpm compare:tests --base=76e75f7` | exit 0: base 2083/2060/23, tip 2087/2064/23, failure names 24 on each side, **0 new on tip, 0 only on base, identical failure set** | `.dev/verify/2026-10-11T14-52-44-277-compare-tests/` |
| `pnpm check:docs`, `pnpm check:entrypoints` | exit 0; entrypoints reports its two known-missing files | — |

No paid model call and no sleep-based wait: every case drives the public HTTP surface over a real SQLite store, a real
local gateway and a controlled faux model, and waits on a committed transcript or a request answer.

## Review notes

Findings recorded here follow [review policy](../../../docs/agents/review-policy.md).

| # | Finding | Trigger and impact | Disposition | Revisit if |
| --- | --- | --- | --- | --- |
| 1 | `reportedSelection` re-implements the framework's selection rule (array / `{add, remove}` / absent) in `apps/server/src/extension-selection.ts`, because the runtime resolves the agent asynchronously on the session line and the state projection runs inside a publication. The rule is asserted against the runtime's own resolution in `apps/server/test/extensions.test.ts`. | A future pi-durable release changing that rule would make the reported `extensions`/`toolNames` disagree with what a request is offered, and no compile error would say so. | `record` | The runtime exposes a synchronous selection read, or a pi-durable upgrade changes `selectExtensions`. |
| 2 | A conversation with no execution workspace is withheld `coding-tools`, so it cannot select the extension whose tools reach the host. The refusal names the workspace as the reason. | A user who wants coding tools on a workspace-less conversation cannot have them; such a conversation has no host to run them on, so the tools would be offered and then refused by the runtime. | `record` | A workspace-less conversation is expected to reach an execution host. |
| 3 | The default selection is one document per backend deployment, not per user. | Two operators of one backend share the default; the deployment has one authenticated token today, so there is no second user to distinguish. | `record` | A deployment serves more than one authenticated user. |
| 4 | `hepi.extension-selection` is written on every `POST /api/extensions`, even when the selection is unchanged. | One small document write per settings change; the surface is a settings panel, not a hot path. | `record` | The write path is shown to be a bottleneck. |
