# 06: Explicit global/workspace installation with conversation Reload

**What to build:**
Install a Skill Bundle from the repository onto a target execution host (local or SSH) with explicit global or workspace scope. Stages files safely, records provenance and install-time content hashes, and requests a Reload for the initiating conversation. Installed skills remain usable without repository connectivity.

**Copy / Borrow from:**
- Lockfile & Hashes: `apps/web/vendor/pi-web/lib/skill-lock.ts` (`.skill-lock.json`, hash calculation, scope tracking).
- Atomic Installation & Staging: `cc-switch/src-tauri/src/services/skill.rs` (conflict checking, safe extraction).
- UI Installation Controls: `cc-switch/src/components/skills/SkillsPage.tsx` (`InstallToPopover`, status badges).

**Blocked by:**
- 03: Atomic Reload, durable recovery, and isolated notifications
- 04: SSH resources resolve target identity and real host paths
- 05: Manage versioned Skill Bundles in the cloud repository

**Status:** complete

- [x] Downloads bundle from repository and stages atomically on the target host via ExecutionEnv.
      `POST /api/skill-market/install` reads the bundle from the repository (`retrieve` for a published version, or
      `preview` at the pinned revision for a curated source) and sends it to the conversation's bound workspace gateway
      as one `publishDirectory` request. `packages/gateway/src/install.ts` writes every file into a fresh
      `.hepi-install-<random>` sibling of the destination and publishes the directory with one rename, so a failed or
      interrupted publication leaves no partial skill directory. The SSH host runs the same staged publication through
      its own real Python helper over the existing runner; nothing is installed on the host but Python 3.
- [x] Enforces installation safety: rejects path traversal and escaping symlinks.
      A bundle file path must be relative with no `..`/`.`/empty segment, no backslash, no trailing slash and no nested
      `SKILL.md`; the repository refuses these at publication and the capability refuses them again. An existing
      destination in any form (including a dangling link or a link elsewhere) is a `conflict`; staging writes refuse to
      write through a symlink; the published directory is re-checked to be inside the scope root and not a link, and the
      remote helper verifies the staged file's real path stays inside the staging directory. The capability accepts a
      scope and a slug, never a destination path.
- [x] Writes/updates install-time content hash baseline and provenance record on the host.
      `<scope parent>/.skill-lock.json` (`version: 1`) holds, per skill: source, sourceType, ref, version, skillPath,
      scope, installedAtMs, a sha256 per installed file and one hash over the sorted path/hash pairs. The entry shape is
      borrowed from pi-web `lib/skill-lock.ts`; the directory hash is adapted from cc-switch `compute_dir_hash`. An
      absent entry or baseline is unknown provenance, never proof of modification. A corrupt lock is refused
      (`invalid`) and never overwritten; the lock is rewritten through a same-directory temp file and one rename.
- [x] Global installs target execution account home; workspace installs target project directory.
      Global is `<execution account home>/.agents/skills/<name>` and is shared by every workspace of the same host and
      login; workspace is `<bound workspace root>/.agents/skills/<name>`. The account is resolved on the host
      (`pwd.getpwuid` in the remote helper, `os.userInfo()` locally), never from the gateway process environment, and
      the target workspace is the initiating conversation's bound workspace.
- [x] Initiating conversation receives a reload request upon successful installation; failure to reload does not roll back installation.
      The response carries `installed` and `reload` separately. The reload is the existing `reloadResources` path for
      that conversation only: a failed candidate keeps the previous prefix/catalog, answers HTTP 200 with
      `reload.ok === false` and an error, and leaves the published files and lock exactly as they were. No other
      conversation is touched.
- [x] Installed skills are discoverable offline without repository connectivity.
      The gateway's installation and the loader share nothing at runtime: once published, the skill is ordinary host
      content. With the repository's fetch failing, the market reports the unavailable source and the installed skill
      still lists as a command and loads from the host.

**Comments**

**Design (minimal, copy-first).** One narrow host capability plus one orchestrator; no general filesystem, no framework.
`/v1/installs` is a separate route from `/v1/files`, so ordinary resource mutations keep their existing read-only
boundaries and installation is the only writer. The capability is deliberately shaped so ticket 07's confirmed
overwrite and backup reuse the same staging seam rather than a second publication path.

**Interface changes:**
- `packages/gateway/src/install.ts` (new): `InstallScope`, `PublishFile`, `InstallLockEntry`, `InstallLockDocument`,
  `InstallRequest`/`InstallServer`, `installScopeRoot`, `installLockPath`, `safeInstallPath`,
  `validLockEntry`/`validLockDocument`, `LocalInstallServer`, `SshInstallServer`, `gatewayInstalls` (backend client),
  `REMOTE_INSTALL_SCRIPT`.
- `packages/gateway/src/index.ts`: `GatewayRpcServer` takes a fourth optional `InstallServer` and serves `POST
  /v1/installs`; the new exports are re-exported.
- `packages/gateway/src/main.ts`: wires the local or SSH installation server for the running gateway.
- `apps/server/src/skill-install.ts` (new): `createInstaller`, `installContentHashes`, `installLockEntry`,
  `bundleFiles`, `installDirectoryName`, `InstallResponse`.
- `apps/server/src/server.ts`: authenticated `POST /api/skill-market/install`, and an optional `installer` option for
  tests.
- `apps/web/lib/skill-market.ts`: `INSTALL_SCOPES`, `installRequestBody`, `installNotice`.
- `apps/web/components/SkillMarketPanel.tsx`: `InstallControls` and an enabled scope choice bound to the conversation;
  `SettingsPanel` passes `sessionId` as `conversationId`.
- `packages/gateway/test/ssh-transport.ts`: the controlled transport fixture accepts the helper script(s) a gateway
  serves, so one SSH gateway can carry both the filesystem and installation helpers.

**Evidence.** `pnpm -r typecheck` and `pnpm -r test` pass (protocol 10, session 3, gateway 42, server 70).
`node --test components/SkillMarketPanel.test.mjs` passes 15/15. Red-then-green: with only the gateway dispatch and the
server route reverted (both new modules present), `apps/server/test/skill-install.test.ts` fails 6/6 and passes 6/6
with the wiring restored; with the two modules removed the suites fail to import.

- `packages/gateway/test/install.test.ts` (6 cases): local global/workspace publication with exact script and binary
  bytes and no staging residue; conflict, traversal and symlink refusal; lock round trip, malformed lock refusal and
  metadata-only shape; controlled-SSH publication with the transport's account/home and its own lock; unreachable host
  and lost-response (`outcome_unknown`, sent once); global sharing across two workspaces.
- `apps/server/test/skill-install.test.ts` (6 cases): authenticated HTTP/SSE through the real backend, gateway and
  repository — global installation shared by two workspaces with the expected baseline hashes, workspace placement and
  repository-offline discovery, install-success/reload-failure with files retained, traversal and existing-destination
  and symlink refusal, SSH publication plus an unreachable SSH host reported as `outcome_unknown`, and the
  authentication/target checks.

**Known limitations.**
- No live SSH host was authorized: SSH installation is verified through the controlled transport fixture that runs the
  real Python helper locally with a generated account. A real-host smoke test remains unrun and is reported, not
  fabricated.
- Ticket 07 (Update, confirmed overwrite, retained backups) is not implemented beyond the reusable publication and lock
  seams. An existing destination is refused with `conflict`.
- Ticket 04's follow-up (context shadow computed in `filesystem.ts` / `ssh-filesystem.ts`) is untouched: this ticket
  adds separate modules and narrow dispatch hooks, so the overlap with that work is one optional constructor argument
  and one new route.
