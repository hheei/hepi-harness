# 07: Update conflicts, confirmed overwrite, and retained backups

**What to build:**
Update installed skills with conflict detection against install-time content hashes. If local modifications exist, update halts and requires explicit overwrite confirmation in the UI. Overwrite preserves a backup of the replaced directory before updating.

**Copy / Borrow from:**
- Backup & Restore API: `cc-switch/src/lib/api/skills.ts` (`SkillBackupEntry`, `SkillUninstallResult`, `restore_skill_backup`).
- Update Logic: `apps/web/vendor/pi-web/lib/skill-updates.ts` and `cc-switch/src-tauri/src/services/skill.rs`.

**Blocked by:** 06: Explicit global/workspace installation with conversation Reload

**Status:** complete

- [x] Compares current files against install-time content-hash baseline.
      `GET /api/skill-market/installed?conversationId=&scope=&name=` asks the host for the directory's **current
      recursive** entries (`inspectDirectory` on `/v1/installs`) and compares them with the scope lock's baseline: every
      path and every digest, plus the directory hash. **Added** files, **deleted** files, replaced files, directories
      and symlinks are all covered: a link is hashed as `link:<sha256 of its target>`, so it can never pass as
      unchanged file content and can never collide with one. The same `folderContentHash` rule the install-time
      baseline uses is shared by both sides; the SSH helper recomputes it independently in Python and the tests pin
      both to the same literal.
- [x] Halts update if files are locally modified, reporting `locally-modified` state.
      The state is `unchanged` | `locally-modified` | `unmanaged`. `POST /api/skill-market/update` without a
      confirmation answers HTTP 409 `confirmation_required` **and the state**, and writes nothing: no replacement, no
      backup, no lock change. A missing baseline is `unmanaged` — unknown provenance is never reported as unmodified.
- [x] Offers explicit overwrite confirmation in UI with clear warning.
      `UpdateControls` shows **Update** for an unchanged installation and, for a modified or unmanaged one, names the
      state (`market.warn.locally-modified` / `market.warn.unmanaged`), warns that a backup is kept, and requires a
      second, explicitly dangerous press (`market.updateConfirm`). The UI shares the scope/target selection the install
      controls already use. The confirmation is **pinned to a fingerprint**: the preview sends the digest set it read,
      and the host re-reads the directory **inside the publishing operation, at the mutation boundary**, refusing the
      replacement with `conflict` if anything changed in between — so a concurrent edit is never silently deleted.
- [x] Preserves backup of replaced directory before overwriting.
      A confirmed replacement moves the directory to a unique `<name>.bak` path beside the skills directory (never
      inside it, so it is never scanned as an installation) before publishing. It is a rename: the replaced content is
      never copied and never partially written. A name already in use is stepped over (`<name>.1.bak`, …) rather than
      overwritten, so a later replacement never destroys an earlier backup. If the publish rename fails the backup is
      moved back, so a failed replacement never leaves the destination missing. The path is returned as
      `installed.backup`. No restore, list, prune or GC is implemented.
- [x] Refreshes install baseline and requests reload for initiating conversation upon success.
      The lock entry is rewritten from the newly published bytes, so the next status reads `unchanged` again, and the
      same `reloadResources` path adopts it for the initiating conversation only — no other conversation is re-adopted.
      Publication and adoption stay separate: a failed Reload answers 200 with `reload.ok === false` and never rolls the
      replacement back.

**Comments**

**Gaps found in review, fixed in the same capability** (each reproduced before fixing, with a test that fails without the
fix):

| Gap | Fix |
| --- | --- |
| `realpath(scopeRoot)` trusted a symlinked `.agents`/skills parent, so a publication could land outside the account home or the workspace root (local **and** SSH). | Both scope roots are resolved segment by segment and confined to the canonical authorized root (`confinedScopeRoot`, Python `confined_scope`) before any write. A link inside the root is followed; a link leaving it is `permission_denied`. |
| The lock path came from the **raw** scope root while the publish used the **resolved** one, so the lock could be written through a link the publish refused. | The lock is derived from the confined scope root only, and the lock file itself must be a regular file: a linked or non-file lock is `invalid`, never read or written through. |
| `recordInstall` read-merge-wrote the lock with no serialization: five concurrent records left one entry. Global is one scope for every workspace of a host and account, so records from two workspaces contend for one lock path. | The local server serializes records per **lock path** (`serialized`), and the SSH helper takes an exclusive `fcntl.flock` on a sidecar guard for the read-merge-write. |
| Local `readLock`/`recordInstall` threw instead of returning a result (`EACCES`, `EISDIR`), which the RPC turned into a 500. | Every host failure inside `execute` is returned as an `InstallResult`, and the lock path is checked with `lstat` first. |
| Publish succeeded but the lock record failed: the response carried only a 502 with no `installed`, so a retry answered 409 and the files that had landed were invisible. | The published result is returned with a `warning` naming the lock failure; the caller sees the path, the files and the fact that provenance is now unknown. |
| The SSH helper's `valid_entry` was laxer than Node's `validLockEntry`: it accepted `files:{"../escape.md":"NOT-A-HASH"}` and a non-hash `contentHash`. | The helper validates source, sourceType, absolute skillPath, scope, installedAtMs, a 64-hex `contentHash` and every file path and hash with the same rule. |
| A **zero-byte file** was never sent on an SSH publish: the write loop stepped by byte count, so an empty file produced no `publish_file` call, while the response and the recorded baseline both claimed it. | The loop sends one explicit `publish_file` for an empty file (`Math.max(1, …)`), and a test pins the exact bytes and the sha256 of no bytes on both hosts, with matching digests. |
| The status was read, the user confirmed, and an edit landed **before publication**: `publish` re-inspected and pinned the replacement to a fresh read, so the edit became the accepted snapshot and was overwritten with no confirmation of what the user actually saw. | `publish` no longer inspects: the replacement is pinned to the digest set the caller sent (the UI sends `skill.files`), or to the state the update reads for itself when the request carries none. An edit after the status read answers `conflict` with the edit intact; the UI re-reads the state and asks again. |
| Two confirmed replacements of one directory were not serialized: both could check the destination, both could move it aside and both could publish, so both reported `ok` and a stepped-over `pdf.1.bak` was left behind (reproduced 3/25 repeats). | The destination check, the move-aside and the publish are one section serialized per **canonical destination**: in-process for the local host (module-wide, so two server instances over one account home contend) and `fcntl.flock` on a sidecar guard for the SSH helper. Staging stays outside the lock. The loser finds the directory already replaced and is refused as `conflict`. |

**No automatic replay.** A lost response, a dropped SSH connection or a timeout is reported as `outcome_unknown` and the
request is never sent again; the existing test asserts the transport saw exactly one call.

**Interface changes:**
- `packages/gateway/src/install.ts`: `inspectDirectory` operation; `publishDirectory` gains `overwrite` and `expect`;
  `DirectoryInspection`, `ExpectedDigests`, `LINK_DIGEST_PREFIX`, `BACKUP_SUFFIX`, `folderContentHash`, `sameDigests`,
  `backupPath`, `confinedScopeRoot`, `serialized`; `PublishedDirectory.backup`; `InstallFailureCode` gains
  `not_found`.
- `apps/server/src/skill-install.ts`: `updateState`, `UpdateState`, `UpdateResponse`, `updateRequest`,
  `installer.status`, `installer.update`, `InstalledSkill.backup`, `InstallWarning`.
- `apps/server/src/server.ts`: `GET /api/skill-market/installed`, `POST /api/skill-market/update`.
- `apps/web/lib/skill-market.ts`: `UpdateState`, `updateNeedsConfirmation`, `updateRequestBody`, `updateNotice`.
- `apps/web/components/SkillMarketPanel.tsx`: `InstalledState`, `UpdateControls`, the status read and
  confirm-then-replace flow; i18n keys in en, zh-CN and zh-TW.

**Evidence.** `pnpm -r typecheck` clean; `pnpm -r test` passes (protocol 10, session 3, gateway 57, server 82);
`node --test components/SkillMarketPanel.test.mjs lib/i18n/registry.test.mjs lib/skill-lock.test.mjs` passes 24/24.

Red-then-green. Reverting the gateway confinement and serialization while keeping the new tests: the linked-scope
cases publish outside the authorized root, five concurrent records leave one entry, and `EISDIR` escapes as a
rejection. Reverting the pinned fingerprint to the pre-staging check: a two-simultaneous-replacement case loses a
backup and reports a host failure instead of `conflict`.

- `packages/gateway/test/install.test.ts` (18 cases): local and controlled-SSH publication and placement, including
  **zero-byte files** with identical digests on both hosts; scope confinement on both hosts; concurrent lock records
  retained per scope and across workspaces; host failures as results; inspection across added/deleted/linked entries; a
  confirmed replacement pinned to the inspected content and refused when it changed; a unique retained backup per
  replacement; two simultaneous replacements of one destination — including across two server instances over one account
  home — settling with one winner, one retained backup and no orphaned or stepped-over backup; a replacement that cannot
  be published leaving the installed directory intact; a full SSH install/update with its own backup and lock; malformed
  lock refusal; unreachable host and unknown outcome. The race test was repeated 8× green after the fix; before it, the
  pre-fix build failed it in 9 of 25 repeats.
- `apps/server/test/skill-install.test.ts` (15 cases): the 06 cases plus the update flow (state, refusal, confirmation,
  backup content, refreshed baseline), **zero-byte files** installed byte for byte on a local and an SSH host with
  matching digests and no false local modification afterwards, an edit made **after the status was read** refused as
  `conflict` and never overwritten by a fresh read, the lock-failure warning, an unknown-baseline directory,
  added/deleted/linked modifications, initiating-conversation-only adoption, update-success / Reload-failure, and a
  repository-bundle install and update against real files on a controlled SSH host.
- `apps/web/components/SkillMarketPanel.test.mjs` (17 cases): the install controls plus the update controls and
  helpers, including the digest set travelling with a confirmation and the changed-since-preview notice.

**Known limitations.**
- No live SSH host was authorized: the SSH half is verified through the controlled transport fixture that runs the real
  Python helper locally with a generated account. A real-host smoke test remains unrun and is reported, not fabricated.
- A retained backup is kept on the host but is not listed, restored or deleted anywhere; there is no pruning or GC.
- The update is driven from the bundle preview rather than a per-skill management list: the state check happens when
  the user opens the bundle they intend to install.
- The local host's per-destination lock is in-process, shared across every server instance in one gateway process. Two
  separate gateway processes writing one scope are not coordinated by a lock; the rename still refuses the loser as
  `conflict` with no backup taken. The SSH host takes a cross-process `fcntl.flock`, because each helper is its own
  process.
- Ticket 04's follow-up (context shadow computed in `filesystem.ts` / `ssh-filesystem.ts`) is untouched: this work
  adds separate modules and narrow dispatch hooks.
