# cc-switch vendor snapshots

Verbatim source snapshots, not imported modules. Nothing in this directory is on a runtime import path or inside the
TypeScript include list; they are kept so the adapted behavior can be compared against the original.

- Source: `https://github.com/farion1231/cc-switch`
- Revision: `b4a079430ce85a604e10d97d4b7530774e00e112` (main)
- License: MIT (`LICENSE`, fetched from the same revision)

| File | md5 | Source path | Adapted as |
| --- | --- | --- | --- |
| `skill.rs` | `9fcb2c3275f128ec1ca372cef6f2605f` | `src-tauri/src/services/skill.rs` | Reference for install-time directory hashing (`compute_dir_hash`, `collect_files_for_hash`), staged replacement and the retained backup shape |
| `skills.ts` | `27e107203cfc597fa71a6585ac3500b4` | `src/lib/api/skills.ts` | Reference for the `InstalledSkill` / `contentHash` / `SkillBackupEntry` contracts |
| `SkillsPage.tsx` | `d4774614a026db7c0847c596c5ee8b41` | `src/components/skills/SkillsPage.tsx` | Reference for discovery, installed list, installation targets and conflict status in the UI |

What this repository adapts:

- The install-time content baseline idea — one hash per file plus one hash over the directory's sorted entries — is
  reimplemented in `apps/server/src/skill-install.ts` `installContentHashes` over bundle-relative paths, and shared
  with the host side through `packages/gateway/src/install.ts` `folderContentHash`.
- The scope-aware destination shape (account home vs project directory) is reimplemented in
  `packages/gateway/src/install.ts` `installScopeRoot` / `confinedScopeRoot`.
- The update comparison in `apps/server/src/skill-install.ts` `updateState` follows the same idea as cc-switch's
  update detection: the host's real directory is hashed and compared with the recorded baseline, and anything that does
  not match is a local modification rather than an update.
- The retained backup before a confirmed overwrite follows `create_uninstall_backup` / `SkillBackupEntry` in shape:
  the replaced directory is moved aside first, and the response names where it went.

Deliberately not borrowed: the Rust archive extraction and ZIP budgets, the `~/.cc-switch` SSOT directory, symlinked
multi-app deployment, `skills.sh` search, the app matrix and the migration tooling, the `skill-backups` directory with
its `meta.json` metadata and 20-item retention, and the backup list / restore / delete API
(`list_backups`, `restore_skill_backup`, `delete_skill_backup`).

Two qualifications on that list. `skills.sh` **search** is not borrowed here in Rust, but the repository does query the
same public catalog: `apps/server/src/skill-repository.ts` implements it independently in ticket 10 (`SKILLS_SH_API`),
reusing only the response *shape* noted in `skill.rs` — no cc-switch code, and no Rust. Separately, the replacement for
the backup API is not a single file: `packages/gateway/src/install.ts` `moveToBackup` renames a replaced directory to
`<name>.bak` beside the skills directory and steps over a name already in use (`<name>.1.bak`, …), so backups
accumulate and a previous one is never overwritten. There is still no restore, no list and no GC.

No cc-switch code is executed here. See [docs/execution-side-installation.md](../../../../docs/execution-side-installation.md).
