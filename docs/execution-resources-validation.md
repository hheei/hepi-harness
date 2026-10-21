# Execution-side resources — merged validation (code tip d8f3633)

**Historical record — dated evidence at one merge tip, not current state.** Everything below was measured at
`d8f3633` on `integration/execution-resources`; counts, failure sets and "in progress" statuses are frozen at that tip
and were superseded by later UX work (the whole-web baseline there was 21 failures of 2055 tests; the tip now carries
23 of 2084, both pre-existing). For what to run and what the current baseline is, read
[docs/verification.md](verification.md); for the tickets' final statuses, read each file under
[.scratch/execution-resources/issues/](../.scratch/execution-resources/issues/).

Durable record of what was actually run on the merged integration tip, so later readers do not have to trust a ticket
comment. Feature: [execution-side resources spec](../.scratch/execution-resources/spec.md) (tickets 01–08).

## Merged tip

`integration/execution-resources` at **d8f3633**, the sequential merge of four review-authorized fixes:

| Merged | Subject |
| --- | --- |
| 818b053 | fix(install): publish zero-byte files, pin updates to the caller's snapshot, serialize replacements |
| 5462724 | fix(gateway): load .pi skills roots in upstream order and refuse resource aliases |
| ae460a9 | feat(resources): retire the legacy pi-resource namespace and harness loader |
| d8f3633 | fix(resources): project prompts outrank account prompts, account `.agents` stays global |

Merge commits 958bd21, c164afe, 7985dbb; d8f3633 fast-forwarded. No conflict resolution dropped `requiresTrust` roots
or `enableSkillCommands` in `apps/server/src/workspace-resources.ts`. d8f3633 closes the prompt-precedence defect
(the workspace `.pi/prompts` root was listed after the account's, inverting upstream `resourcePrecedenceRank`) and
stops the ancestor walk from re-tagging the account's own `.agents/skills` when the workspace sits below the account
home; the two new gateway cases bring the count from 57 to 59.

## Workspace checks (this tip)

| Command | Result |
| --- | --- |
| `pnpm -r typecheck` | pass, 5/5 projects |
| `pnpm -r test` | protocol 10/10, session 3/3, gateway 59/59, server 70/70, **0 fail** |
| `pnpm -r build` | pass (`apps/web` is the only project with a build script) |

`packages/gateway/test/install.test.ts` was rerun 25× in isolation: 25/25 green. The pre-merge flake (two simultaneous
confirmed replacements both winning) is fixed by 818b053's per-destination serialization; the counts above are the
post-fix ones.

## Targeted web subsets (run directly, not via `pnpm -r test`)

`apps/web` has no `test` script, so `pnpm -r test` never runs web. Run directly with
`node --test <files>`:

- skills (ticket 14 entry point): `pnpm --filter @hepi/web test:skills` — the retirement assertions,
  `lib/skill-inventory.test.mjs`, the built-in panel's unit files, `lib/i18n/registry.test.mjs`, then the two browser
  fixtures and the built-in smoke. `pnpm --filter @hepi/web test:skills-sshd` adds the real-sshd transport.
  (The retired `SkillMarketPanel` / `skill-market` / `skill-lock` files these lines used to name are gone. The original
  text named `@hepi/client`; `test:skills` is defined in `apps/web/package.json`, so the filter was wrong — corrected
  here, with the ticket-14 record itself left as written.)
- file browsing and turn-written files: `components/TurnWrittenFiles`, `FileExplorer.linked-directory`,
  `FileViewer`, `FileViewer.state`, `AppShell.file-viewer-state`, `SettingsUi`, `AgentSessionPanel`,
  `lib/slash-display`, `lib/turn-written-files`, `lib/file-links`, `components/MessageView`,
  `components/SessionTree` — **172/172 pass, 0 fail** (the current resources-relevant subset).
- chat window/input/minimap and chat-state helpers — 87/87 pass.

## Whole-web run is **not** green (baseline failures)

Running every web test file (`node --test lib/*.test.mjs components/*.test.mjs hooks/*.test.mjs`, 247 files):
**2055 tests, 2034 pass, 21 fail**. The same 21 failures reproduce on `d15364c`, on `152db2f` and on `ae460a9`
(three consecutive runs each, identical failing test list), so they are a pre-existing baseline, not a regression from
this feature:

`components/SessionSidebar.file-search`, `components/SettingsPanel` (module-level `readFile("../app/login/page.tsx")`,
never tracked), `lib/builtin-extensions`, `lib/mcp-config-file`, `lib/mcp-config-read`, `lib/mcp-host`,
`lib/mcp-sign-in`, `lib/mcp-sign-in.integration`, `lib/mcp-test`, `lib/model-catalog-refresh`, `lib/node-version`,
`lib/pi-web-node-args`, `lib/pi-web-options`, `lib/process-lifecycle`, `lib/rotate-preview-secrets`,
`lib/terminal-manager`, `lib/web-auth-proxy`, plus four leaf assertions inside otherwise-passing files
(`gfm-autolink-email-loader`, the SDK inline budget, the provider Base-URL and API-key-route cases).

No resources-related web test fails. **Do not claim whole-web green.**

## Controlled SSH, no live host

The SSH half (publication, inspection, lock, replacement, confinement) is verified through the controlled transport
fixture in `packages/gateway/test/install.test.ts`, `ssh-resources.test.ts` and `apps/server/test/skill-install.test.ts`,
which runs the real Python helper locally against a generated account. **No live SSH host was authorized**, so a
real-host smoke test remains unrun and is reported, not fabricated.

## Known limitation: the local publish lock is in-process

`packages/gateway/src/install.ts` serializes the local mutation boundary (re-read → move aside → publish) in a
module-wide queue, so it covers every server instance in one gateway process. A second writer in **another process** is
not covered by that queue; it is refused only by the `rename` itself. The SSH helper uses an exclusive `fcntl.flock`
on a sidecar guard, so two helper processes cannot race. Ticket 07's retained backup has no list/restore/prune.

## Read-only resources are path discipline, not a security boundary

Agreed position (operator decision): a symlink the operator creates inside the workspace is their own file. Writes
through it are covered by the existing workspace-confinement and installation checks; the resource read-only rule is
**not** a sandbox and gets no extra per-tool guard, because the agent already has a shell on the execution host. Any
future isolation belongs at the Execution Environment abstraction, not in monkey-patched guards. The symlink-alias
resource write is therefore **not a blocker** for ticket 08, and neither the ticket nor this record lists it as one.
Canonicalizing paths stays, because resource discovery, deduplication and install placement need it.

## Ticket 08 status

At this tip ticket 08 was **in progress, not complete**: removal and merged-tip regression evidence were in place but
the final code review had not reported, so the review-pending note was kept in
`.scratch/execution-resources/issues/08-retire-legacy-resources-regression.md`.
**Superseded:** that review has since reported and ticket 08 is complete; see
[08-retire-legacy-resources-regression.md](../.scratch/execution-resources/issues/08-retire-legacy-resources-regression.md).
