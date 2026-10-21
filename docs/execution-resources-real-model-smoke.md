# Execution-resources real-model and UI smoke (ticket 08, step 1)

**Historical record — one dated operator smoke at tip `6a81863`, not a current check.** Nothing below is a CI entry
point and nothing was re-run since; the counts and limitations are as observed then. For what to run now and what the
current whole-web baseline is, read [docs/verification.md](verification.md). The script it names,
`apps/server/scripts/real-model-smoke.ts`, still exists and is still operator-only (paid credential required).

One real-model, real-browser run of the unified execution-resource loader, driven through the local Next UI. This is an
operator-authorized one-off smoke, not a CI test: it needs a live OpenAI-compatible credential, so it runs only from
`apps/server/scripts/real-model-smoke.ts` with an operator env file present.

| Item | Value |
| --- | --- |
| Tested tip | `6a81863` (`integration/execution-resources`, the ticket-08 merge tip with the prompt-precedence fix) |
| Model | `magpie/deepseek-v4.1-flash`, a real remote OpenAI-completions endpoint reached from the backend only |
| Model turns | 10 (step 1: 1, step 2: 2, step 3: 3, step 4: 4; step 5 is UI-driven and reloads without a model turn) |
| Backend | real `createBackendServer` + real `Harness`, Pi-config mode, ephemeral SQLite, loopback only |
| Gateway | real `GatewayRpcServer` over `LocalGateway` + `LocalFilesystem` + `LocalInstallServer`, ephemeral account home and workspace |
| UI | real Next production server + headless Chromium (Playwright), driving only visible controls |
| Settlement | the conversation's durable SSE stream, not a state poll |
| Result | **PASS — 100/100 checks, 0 failures** (`node apps/server/scripts/real-model-smoke.ts`) |

## How a turn is settled

Every turn is submitted and then settled on the conversation's durable event stream
(`GET /api/conversations/:id/events`). A settled turn is a state event that is idle, carries a higher `revision` than
the turn's baseline, holds more entries than the baseline, and has this turn's submitted text as its **last** user
entry. That removes the stale-idle hole of a bare "revision > 0 and not busy" poll: a previous turn's idle revision can
never be read as this turn's result, and the entries this turn added are a fact of the stream rather than the whole
history re-examined.

For each turn the smoke asserts, on the turn's own new entries only:

- the turn was admitted as a new durable entry (this turn's text);
- the turn produced at least one assistant entry, none of them with `stopReason: "error"` or `"aborted"` or an
  `errorMessage`, and the final one stopping normally (`stop`/`length`);
- the tool output this turn was asked for is present and is not an error.

The smoke also checks afterwards that every entry the stream reported is present in the durable state and that the
durable transcript holds the successful results it relied on.

A real model sometimes runs commands this smoke never asked for, and one may fail — in the earlier run the model ran
`git` in a directory that is not a repository, which legitimately exits non-zero. Such unrelated failures are recorded
as a **note** naming the tool, not as a smoke failure: this smoke asserts the execution-resource contract, not the
model's tool discipline. Every result the smoke actually relies on is asserted positively and can never be exempted.

## Read result and "exact bytes"

The ordinary `read` assertion is byte-exact: the result must equal the file's bytes, keep the trailing newline, and be
under 512 bytes, so no truncation or diagnostic line is appended. The `read` tool returns the selected lines bounded
by its own head truncation (`truncateHead`); the fixture file is one short line plus one newline, so its result is the
file's exact bytes with the newline. The extra length bound is what documents that this fixture's shape, not the tool's
formatting, is why the comparison can be exact.

## Verified

**1. Discovery and `/skill:` expansion (13 checks).** The first real turn adopted 2 skills and 2 prompts from the
temporary execution host, the state reported `status: loaded`, an ordinary `read` returned the file's exact bytes, and
the command list was exactly the adopted catalog (`ship, skill:deploy, skill:global-notes, summarize`).

**2. Ordinary read and script execution (16 checks).** A `bash` call ran
`.agents/skills/deploy/scripts/run.sh` through the gateway and returned `smoke-script-ok`. `/skill:deploy production`
expanded into a `<skill name="deploy" ...>` block carrying the real host location, the `References are relative to`
line, the body read from the host, and the appended argument — with no `pi-resource://` anywhere.

**3. Prompt/skill edit and explicit Reload (22 checks).** After editing `SKILL.md` and `ship.md` on disk, **before**
the Reload `/ship before reload` still expanded the committed template to its adopted text (`Ship it v1.`) and proved
the substitution (`Args: before reload`, no `$@` left), while the skill command already read the disk (documented
live-body behaviour). An explicit `POST /api/conversations/:id/reload` then returned 200, and the next turns expanded
the edited skill body (`Deploy steps v2.`) and the edited template (`Ship it v2.`), with the replaced texts gone.

**4. Backend restart retains the adopted prefix (28 checks).** The backend was closed, a brand-new skill was created on
disk, and the skill body and the prompt template were both changed to v3. The restarted backend did **not** rediscover
the new skill; it still reported the committed resource state. Its first turn expanded `skill:deploy` to v3, because a
skill body is read from its real host path at expansion time by design, while `/ship` still expanded to the committed
**v2** template and not the disk's v3 — the committed-template replay, asserted directly. An explicit Reload after the
restart then adopted `skill:brand-new`, and `/ship` expanded to `Ship it v3.` with the v2 text gone.

**5. Local UI publish / install / update (21 checks).** In headless Chromium against the real UI: the password gate
accepted the backend token and the composer appeared; **Settings › Skill market › Repository** published a bundle
version and listed it; the published bundle was opened in the market preview and installed at the `workspace` scope
(on-disk `SKILL.md` and `notes.md` held exactly the published bytes, the installing conversation adopted
`skill:smoke-bundle`, the controls switched to Update); the installed `notes.md` was edited on disk, the preview
re-read (reporting the skill as locally modified and requiring confirmation), and **Replace anyway** completed the
confirmed update: the notice named the retained backup directory, that directory exists and holds the locally modified
bytes, the installed directory is back to the published bytes and contains exactly `SKILL.md, notes.md`; no page error
occurred.

**Final (5 checks).** The fixture's own script bytes are unchanged; the settled stream revision is not ahead of the
durable state; every stream entry is in the durable transcript; the durable transcript holds the successful results for
`smoke-notes-exact-bytes` and `smoke-script-ok`; and no durable assistant entry errored or was aborted.

## Credential and output hygiene

The operator credential is read from `HEPI_SMOKE_ENV_FILE` (default `/tmp/hepi-backend.env`) in memory and copied into
a mode-0600 temporary Pi agent directory outside the repository. Everything the script logs or reports passes a
sanitizer, and **every value read from that env file is treated as a secret**: the api key and the base URL are
redacted, and the fixed fixture tokens are redacted. Stack traces are never printed, because an upstream error stack can
embed the raw configuration it failed to parse. Only the provider id and model id are printed — not the endpoint host.
The operator's real `~/.pi/agent` is never read or written, no live SSH or oracle deployment is touched, and the only
script executed is the fixture's own harmless `echo` script.

This was checked against a deliberately broken env file (an unroutable base URL with a marker secret): the run failed
its checks, and neither the marker secret nor the endpoint appeared in the output, and no stack trace was printed.

A failure is reported as the failing check's name plus the sanitized error message, never a stack trace. The two fixed
fixture tokens are values this script generates for itself, not operator secrets, and they are still redacted from its
output so that a genuine secret sitting in the same message cannot slip through unexamined.

## Commands

```bash
pnpm -r typecheck          # clean
pnpm -r test               # protocol 10, session 3, gateway 59, server 70 — 0 fail
node apps/server/scripts/real-model-smoke.ts          # PASS, 100/100 (includes the Playwright UI step)
node apps/server/scripts/real-model-smoke.ts --no-ui  # backend-only subset
```

`--keep` leaves the fixture directory for inspection; without it the directory is removed and every spawned child is
killed in the `finally` block.

## Limitations and not claimed

- **One model, one run, one workspace, one browser context.** The endpoint is a remote OpenAI-compatible gateway; the
  provider id and endpoint are not part of this repository's configuration and may change under the operator.
- **Not a CI entry point.** The script requires an operator credential and is deliberately not wired into
  `pnpm -r test`; it is a smoke, not a regression suite.
- **The UI claims cover the controls exercised above only**: authentication, Settings › Skill market (repository
  publish, market preview, install, confirmed update). Chat, file browsing, terminal, MCP and the remaining settings
  sections were not driven in a browser by this run.
- **No live SSH host and no oracle deployment were used.** The SSH gateway path is covered by
  `apps/server/test/ssh-resources.test.ts` and `apps/server/test/skill-install.test.ts`, not by this smoke.
- **Skill body reads are host-live by design; prompt templates are committed content.** A turn after an on-disk edit
  but without an explicit Reload expands the disk's current skill body while the adopted catalog membership stays as
  adopted, and it still expands the committed prompt template. That is the loader's contract, and both sides are now
  asserted rather than assumed.
- **Model-chosen commands are not asserted.** A model may run extra tool calls and one may fail; those are noted, not
  failed, and are outside the execution-resource contract this smoke proves.
- **`apps/web` e2e scripts remain broken** (`test:e2e`/`test:terminal` reference a missing `apps/web/e2e`
  directory) and `apps/web` has no `test` script, so `pnpm -r test` does not run web tests. The browser checks above
  come from this smoke's own Playwright driver, not from those scripts.
