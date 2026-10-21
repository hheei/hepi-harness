# 01 - Gateway provider auth and API keys

Status: done
Blocked by: None

Add typed Gateway provider-auth protocol and Gateway-owned service using pi-ai credential store/auth definitions. Implement provider listing and write-only API-key set/remove against execution-host `auth.json`, with locking, atomic persistence, restrictive permissions, masked status, validation and secret redaction.

Acceptance: unit/integration tests prove supported provider listing, CRUD, permissions, concurrency/locking, unknown-provider refusal and absence of raw secrets from results/logs/errors. Backend is untouched and receives no credential values. The system acceptance sits in ticket 05. Ticket 02 (Web relay) and ticket 03 (pi-ai login flows) build on this contract; both are still open, so no browser route and no OAuth flow exists yet.

## Delivered

- **Protocol** (`packages/protocol/src/gateway.ts`): `ProviderAuthRequest` (`list`, `set-key`, `remove`), `ProviderAuthStatus`, `ProviderAuthResult`, `ProviderCredentialType`, `ProviderAuthFailureCode`. Every operation answers the whole listing as it stands after the operation; there is no separate mutation result shape, so a caller has nothing to render that it just wrote.
- **Service** (`packages/gateway/src/provider-auth.ts`): `ProviderAuthService` reads the provider set and each provider's auth semantics from `@earendil-works/pi-ai`'s own `builtinProviders()`; a listing reports `configured` from the provider's own `apiKey.resolve()` and `storedType`/`maskedHint` from `auth.json` separately, because a provider authenticated from the environment is configured with nothing stored. No provider list and no auth protocol is reimplemented here.
- **Storage**: pi's own credential shape, one `{ type, ... }` record per provider id, in the account's `<home>/.pi/agent/auth.json`. Writes are a locked read-modify-write (`proper-lockfile`, the same lock the pi CLI's `FileAuthStorageBackend` takes), replaced through a same-directory temporary file and `rename`, with directory `0700` and file `0600` applied on every write rather than only on creation.
- **First-write safety**: a missing `auth.json` is created *inside* that lock by an exclusive create (`flag: "wx"`) whose `EEXIST` is tolerated, never by asking whether the file exists and then writing it. One account's credential file has several writers of its own — this service, another process of it, and the pi CLI — and an unlocked create would truncate whatever the writer it had been waiting for had just stored.
- **Route**: `POST /v1/providers/auth` on `GatewayRpcServer`, behind the existing bearer check and the existing 1 MiB JSON body. A gateway composed without the service answers `unsupported_operation` with "this gateway host serves no provider-auth capability" rather than a generic failure. `startup.ts` composes it for a **local** gateway only: an SSH gateway's `auth.json` belongs to a remote account this Web host does not own.
- **Secret containment**: the raw key appears in no answer, no refusal, no listing and no error text. A refusal forwards this service's own fixed sentence, never the upstream message, because pi's credential errors and a provider's resolution error can quote the value they read. An unreadable `auth.json` is `auth_file_unreadable` with fixed text and the file is left as found.
- **Masked status**: `maskedKeyHint` shows a 4-character prefix and 4-character suffix with `SECRET_MASK` (`@hepi/protocol/mcp-secrets`, the repo's one mask) between them, and discloses nothing at all below 16 characters.
- **Bundling**: the provider catalog is a ~1 MB lazy chunk of the published `@hepi/client` bundle, not the CLI entry (entry 629 KB, chunk `all-*.js` 1.0 MB, loaded only on the first provider operation; `--version` startup stays 45 ms). `@earendil-works/pi-ai` became a runtime dependency of `@hepi/gateway`, and its MIT notice plus `proper-lockfile`'s were added to the bundle banner and `THIRD_PARTY_NOTICES.md`.

## Verification

Revision `95f9257` (branch base; the commit below it is this ticket's own) on `workstation`, Node 26.5.1.

These rows describe the ticket's own delivery. The focused and suite counts changed with the review-loop fix below, which re-ran the same commands at `e561039`; that run is the table in this section's last part.

| Check | Command | Exit | Result |
| --- | --- | --- | --- |
| Focused provider-auth tests | `node --test test/provider-auth.test.ts` (`packages/gateway`) | 0 | 13/13 pass |
| Gateway suite | `pnpm --filter @hepi/gateway test` | 0 | 387/387 pass, 1 suite |
| Gateway typecheck | `pnpm --filter @hepi/gateway typecheck` | 0 | no errors |
| Published bundle | `pnpm --filter @hepi/client build` | 0 | 629 KB entry, 5.2 MB total with chunks |
| Pack + install + local and SSH gateway | `pnpm --filter @hepi/client smoke:pack` | 0 | 6/6 checks, 48-entry tarball, bundled notice present |

`provider-auth.test.ts` holds the public seam — the route, the bearer check, the answer and the file the answer describes — and covers: the SDK's own provider listing (ids unique, `apiKey`/`oauth` read from the definitions, `openai-codex` API-key-less), set/list/remove, restrictive modes, mode narrowed again after being widened to `0644`, four concurrent writes to different providers all surviving, a lock held by an outside writer refused as retryable `lock_unavailable` and then succeeding, a first write refused under a held lock leaving no file where the waiting writer had stored a credential, and eight separate processes racing to create the first `auth.json` all keeping their own entry, a wrong `expectedType` refused as `credential_mismatch` with the entry left in place, unknown/blank/missing provider ids refused without creating an entry, six unusable key shapes refused before anything is written, unreadable `auth.json` refused with fixed text and no quoted value, idempotent removal, and a gateway without the capability naming that limit. Every test asserts the raw key and its prefix are absent from the answer text.

Two defects were found and fixed by these tests rather than by inspection: the lock schedule derived a `maxTimeout` below `minTimeout`, which made every locked write fail with "minTimeout is greater than maxTimeout" (`lockRetryOptions` now derives both from the wait budget), and the file mode was applied only on creation, so a file widened by another tool stayed world-readable (`update` now re-applies `0600` on every locked write).

### Review loop on the delivered revision

A material review finding on `619e66a` was fixed in `406573b`: the credential file was created before the lock was taken, by `existsSync` followed by a `writeFileSync` with the default truncate flag. Two writers that both saw no file therefore left the later one's empty store in place of the first one's credential. It is a cross-process window — in one process the check and the write are back-to-back synchronous calls — and this account's file really has several processes writing it, so the trigger is an ordinary one: a Web panel saving a key while the pi CLI signs in, or two gateway processes of the same account starting together.

Two regressions were added at the same supported write seam (no security or bypass test), one of which is red against `619e66a`:

- `a first write that cannot take the lock leaves no credential file behind` — holds the lock of a nonexistent file from outside, refuses the write as `lock_unavailable`, asserts nothing was created, then lets the waiting writer store its own credential and asserts the retried request keeps it. Against `619e66a`: `AssertionError [ERR_ASSERTION]: a write refused before the lock was taken creates no credential file`, `node --test --test-name-pattern="first writ" test/provider-auth.test.ts` exit 1. On the fix: pass.
- `concurrent first writers on a host with no credential file all land` — eight separate processes waiting on one start line, then all calling `set-key` for their own provider on a host with no `auth.json`. Asserts every answer succeeds, all eight entries survive and the file is `0600`. This one passes on both revisions: the window sits between two syscalls of different processes, so it is a genuine concurrency assertion that guards the invariant, not a reproduction.

Evidence for the fixed and merged tip, `e561039` (`406573b` plus `integration/client-app` merged in, working tree clean), on `workstation`, Node 26.5.1, via `pnpm verify:changed --base=619e66a`:

| Check | Command | Exit | Result |
| --- | --- | --- | --- |
| Typecheck of changed packages and dependents | step `changed-typecheck` (`pnpm --filter @hepi/server --filter @hepi/web --filter @hepi/gateway -r typecheck`) | 0 | no errors |
| Tests of changed packages and dependents | step `changed-test` (`pnpm --filter @hepi/server --filter @hepi/gateway -r test`) | 0 | 396/396 gateway, 467/467 server, 0 failures |
| Web unit | step `web-unit` | 0 | pass |
| Docs link check | step `check-docs` | 1 | 12 broken relative links — the pre-existing set |

Raw logs and the JSON report naming the SHA: `.dev/verify/2026-10-18T11-12-22-284-verify-changed/` (`changed-typecheck.log`, `changed-test.log`, `web-unit.log`, `check-docs.log`, `verify.json`).

`check-docs` fails on `619e66a` too, and is a known failure rather than a new one: run against that revision checked out detached at `.dev/baselines/619e66a`, it exits 1 with the identical 12 broken links (`.scratch/design-fixes/host/diagnosis.md` and `.scratch/architecture-unification/issues/11-integrate-verify.md` point into the git-ignored `.dev/verify/`; `.scratch/development-audit/*.md` point at a `.pi/skills` path this checkout does not have). Nothing in this change adds or fixes a link.

Advisory, recorded and not fixed here: the lock that makes the write safe leaves an `auth.json.lock` directory beside the credential file at `0775`, which is `proper-lockfile`'s own default and is created by the pi CLI's store identically, so narrowing it here would diverge from the shared lock contract; and the pi CLI's `FileAuthStorageBackend.ensureFileExists()` still creates a missing `auth.json` by check-then-write outside its lock, which is upstream code this ticket preserves rather than patches. Revisit either one only with evidence it matters in ordinary use, or upstream.

## Merge into `integration/client-app`

Merged into the integration tip as `e406971` (`--no-ff`, `ort`, second parent `db1470f`) with no conflict and no hand
resolution: `git diff db1470f..e406971` is empty, so the merged tree is the reviewed tree, same hashes. The branch
already carried `b51926b` (its `e561039` is a merge of `integration/client-app` into this branch, an ancestor of
`db1470f`), so this merge moves the integration branch forward with no new work on the branch and nothing to rebase.
Status stays `done`; the two advisories above stand unchanged and are recorded as advisories, not defects.

The branch evidence (`e561039`, gateway 396 / server 467) is reused for unchanged source. Two runs were made at the
merged tip, the second because the merge introduced a dependency this worktree had not yet installed:

| Check | Command | Revision | Exit | Raw log |
| --- | --- | --- | --- | --- |
| Provider seam + startup composition on the merged tree | `node --test packages/gateway/test/provider-auth.test.ts packages/gateway/test/startup.test.ts` | `e406971` | 0 (21 tests: 16 provider-auth, 5 startup) | `.dev/verify/merge-client-app-9/provider-startup-seam.log` |
| Gateway typecheck with `proper-lockfile` newly linked | `pnpm --filter @hepi/gateway typecheck` | `e406971` | 0 | `.dev/verify/merge-client-app-9/gateway-typecheck.log` |
| Whole tree | `pnpm verify:changed --base=b51926b` | `e406971` (`dirty: false`) | 1 — `check-docs` only | `.dev/verify/2026-10-18T11-24-28-738-verify-changed/verify.json` |

`pnpm install --frozen-lockfile --prefer-offline` (exit 0, 1 package added) was needed first: the merge brought
`proper-lockfile`/`@types/proper-lockfile` into `packages/gateway/package.json` and `pnpm-lock.yaml` (both byte-identical
to `db1470f`'s) while this worktree's store had the runtime but not the types link. The install changed no tracked file
(`git status --porcelain` empty after it), so it is environment, not source.

`verify:changed` escalated to the full workspace because `pnpm-lock.yaml` is not a recognised changed path: it ran
`pnpm -r typecheck` and `pnpm -r test` over all 8 packages, both exit 0 (gateway 396, server 467, ui 193, session 52,
protocol 51, client 10, app 9), with `web-unit`, `script-tests` and `check-entrypoints` also 0. `check-docs` exits 1 on
the same **12** pre-existing broken links, now across 368 files (8 of them this ticket's own, clean): the name-qualified
broken set at `e406971` is byte-identical to the `80608d6` baseline recorded in
`.scratch/…/issues/01-capability-audit.md`'s sibling evidence — `merge-client-app-9/broken-tip-provider.txt` vs
`merge-client-app-8/broken-base-80608d6.txt`, `diff` exit 0. Recorded, not repaired here.

Advisory, recorded and not fixed: `.scratch/provider-connection/spec.md` ends with a trailing blank line (its last two
bytes are `\n\n`), the one merged Markdown file with that defect; `check-docs` does not report it and this merge does not
edit ticket content to fix formatting.

## Limits

- **No Web route yet.** Nothing in `apps/web`, `apps/server` or `packages/ui` was touched: the relay and the panel are ticket 02, which this ticket does not enter.
- **No OAuth.** `login-start`/`login-submit`/`login-poll`/`login-cancel` are ticket 03 and are absent from the request union; an `oauth` credential stored by the pi CLI is listed (type and presence) and cannot be created here.
- **Backend untouched, as required.** The Backend receives no credential and exposes no route for one; this surface is Web-to-Gateway only. No test asserts the Backend's absence of a path because the path was never added — ticket 05 owns that system-level check.
- **No model refresh.** A set or removed key does not retrigger a catalog read; that is ticket 04.
- **Deployment.** This is a source change only; nothing was built for `remote-host` and no host was touched. The gateway composes the surface on its next release, which is a routine deployment of this branch.
- **Recorded, not fixed:** `configured` for an ambient-only provider depends on this host's environment, so two hosts can report different status for the same empty `auth.json`. That is the truthful reading of each host's own configuration, not a defect to reconcile here.
