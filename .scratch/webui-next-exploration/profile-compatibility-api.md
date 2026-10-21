# Profile compatibility API — agent MD, two readers, one document

Current scope: behavior should resemble pi-subagents; Markdown compatibility/import-export is deferred. This document is a historical format comparison, to consult when compatibility is explicitly resumed. Harness ignores unknown frontmatter while retaining raw text; profile edits affect future agents only.

Source study; latest user decisions and API contract are in [conversation-api-proposal.md](conversation-api-proposal.md). Configuration creation and editing share an upsert PUT with whole-document last-write-wins. Frontend suppresses repeated clicks while saving. Context preparation policy belongs in subagent configuration and is interpreted by the extension; its encoding is not constrained by current CLI Markdown compatibility.

First pass from current evidence. Read-only; no product, test, build or graph changes. Sources: sibling dirty tree
`../hepi-mono/packages/pi-subagents/src/agent-resolver.ts` (hepi-mono `519d7872`), `apps/web/lib/subagents.ts`,
`apps/web/lib/frontmatter.ts`, `apps/web/lib/subagent-profile-precedence.ts`, `apps/web/components/AgentsConfig.tsx`.
Graph query: `subagent profile document parse serialize` (returned `parseProfileFile()`, `saveSubagentProfile()`,
`subagents.ts`, `AgentsConfig.tsx`, `frontmatter.ts`; each confirmed in source).

## 1. Two readers, one document

Resolver roots (`agentDirectories`): `<cwd>/.pi/agents`, `<cwd>/.agents/agents`, `<agentDir>/agents` (`getAgentDir()`, or
`PI_CODING_AGENT_DIR/agents`); most specific first, first definition of a name wins. That also resolves the README's
duplicated line: the second root is `.agents/agents`.

Resolver fields (`SUPPORTED_FIELDS`): `name`, `display_name`, `description`, `hidden`, `model`, `thinking`, `tools`,
`exclude_tools`, `extensions`, `skills`, `codemode`, `mcp`. `DEFERRED_FIELDS` (`exclude_extensions`, `preload_skills`,
`max_turns`, `max_tokens`) and every other key are hard errors at resolve time (`unsupported field X`, `not part of the V1
agent contract`). `enabled` is **derived** (model present and `inherit` or `provider/id`), never read.

UI typed projection (`parseProfileFile` L329): reads `name`, `display_name`, `description`, `thinking`, `max_turns`, `tools`,
`disallowed_tools`, `skills`, `extensions`, `load_skills`, `load_extensions`, `model`, `inherit_context`,
`run_in_background`, `prompt_mode`, `color`, `isolation`, `persist_session`, `enabled`. UI writer (`saveSubagentProfile` L474)
owns `description`, `display_name`, `tools`, `load_skills`, `load_extensions`, `enabled`, `inherit_context`,
`run_in_background`, `prompt_mode`, `skills`, `extensions`, `model`, `thinking`, `max_turns`, `color`, `isolation`,
`persist_session`, and carries everything else through in file order (`unmanagedFrontmatter` L295).

So the three field classes are: **shared** (`name`, `display_name`, `description`, `model`, `thinking`, `skills`, `extensions`, `tools`),
**resolver-only** (`hidden`, `exclude_tools`, `codemode`, `mcp`), **UI-only** (`max_turns`, `prompt_mode`, `color`, `isolation`,
`persist_session`, `inherit_context`, `run_in_background`, `enabled`, `load_skills`/`load_extensions`, `disallowed_tools`).

## 2. Source-traced round-trip incompatibilities (no runtime experiment performed)

1. **`tools` rewrite drops plain names.** `saveSubagentProfile` filters to `BUILTIN_TOOLS` (L124: `read`, `bash`, `edit`, `write`, `grep`,
   `find`, `ls`) and `composeToolsField` (L307) carries through only stored `ext:` selectors, so `contact_parent` (required by the
   resolver), `codemode` and `mcp__*` are deleted on save; the file then fails `tools must include the required contact_parent bridge`.
2. **UI-owned keys are resolver-unsupported.** Every file the UI saves contains `load_skills`, `load_extensions`, `enabled`,
   `inherit_context`, `run_in_background`, `prompt_mode`, plus optional `max_turns`, `color`, `isolation`, `persist_session`,
   `disallowed_tools` — each one an `unsupported field` error for `resolveAgent`. Today the UI cannot write a document the
   resolver accepts.
3. **`exclude_tools` is preserved but not projected**, so the UI can produce an allow/exclude overlap the resolver rejects
   (`tool X is both allowed and excluded`) without warning.
4. **Aliases disagree in kind.** `skills`/`extensions` are booleans to the UI (`syncFlagAlias` L318 rewrites only `true`/`false`/`none`/`all`)
   and Pi selections to the resolver (`parsePiSelection`: `true` = all, `false` = none, list = whitelist, `+`/`-` = modifier).
5. **`enabled` has two sources of truth**: written into the file by the UI, derived by the resolver.

## 3. Proposal: keep original MD plus a typed projection

Keep both, with distinct roles. The **document text is the only write model** (source of truth; a writer owns its keys and
must re-emit everything else verbatim). The **projection is a read model** carrying a per-reader verdict:
`{ shared, uiOnly[], resolverSupported[], resolverRejected[{key, reason}] }`. Reason: the resolver's failure surface is
per-field and per-file (`readableError`), the UI needs a form model, and unknown keys must survive a save. The projection
must never be sent back as the write payload — that is what loses keys today.

## 4. Minimum API (three operations, no per-field endpoints)

1. `GET /api/agents/profiles?cwd=` → `{ profiles: [{ name, scope, path, document, projection, resolver: { status, errors[] } }], defaults }`.
   One round trip returns whole documents plus the resolver verdict, so the UI never lists an unrunnable profile as runnable.
   `defaults` carries tool names and the model-list source (`/api/models` already exists) for quick create.
2. `PUT /api/agents/profiles` `{ cwd, scope, name, document, dryRun? }` → validate through the resolver path; write atomically
   unless `dryRun`. `dryRun` is the validate operation, which is why no `/validate` endpoint is needed.
3. `DELETE /api/agents/profiles` `{ cwd, scope, name }`.

Quick create is then Web-side only: template constant → `dryRun` PUT (live validation while the user types) → real PUT.
Duplicate is list-projection → new `name` → PUT. No `PATCH`: today it only flips `enabled`, which is either a UI-side setting
or a whole-document edit — never a field patch.

## 5. Cross-host store location — explicit unresolved

The resolver reads the **execution host** (`<cwd>/.pi/agents`, `<cwd>/.agents/agents`, `<agentDir>/agents`, `PI_CODING_AGENT_DIR`);
the UI library reads and writes with Node `fs` and `getAgentDir()` inside the Web process (`subagents.ts` L329, L474). Unresolved:
the authoritative root on the execution host; whether `.agents/agents` (workspace scope) is writable there; and whether the
write path belongs to the backend (execution resources) or the gateway (host filesystem). Until decided, the API must return
the resolved absolute `path` per profile so a split is visible rather than silent.

## 6. Decisions to take (≤5)

D1 whole-document PUT; no field PATCH. D2 raw MD + read-only projection. D3 UI-only keys leave the shared frontmatter
(UI settings or a namespaced key) so a UI save cannot invalidate a resolver-readable file. D4 the `tools` writer unions
instead of filtering, and never drops a name it cannot dispatch. D5 the writer round-trips `hidden`, `mcp`, `codemode`, `exclude_tools` and
unknown keys verbatim, and reports any key it cannot represent instead of dropping it.

**Still unknown:** whether the pi CLI settings writer and the resolver can both write one profile file; whether
`allowed_subagents` (named in the UI comment at `subagents.ts` L132) has a reader in the current tree; the execution host's
agent directory.
