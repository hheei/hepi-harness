# 08: 同一主机多目录 Project 与 default

**What to build:** Project 可记录同一电脑的多个已有目录和一个 default；新对话只绑定 default，其他目录保持元数据。

**Blocked by:** 07: Web 主机单目录 New Project

**Status:** implemented, verified — merged as cc22f75; three whole-web source assertions this ticket left stale were corrected to the delivered contract (test-only, no production change), and the drivers were re-run on the merged tree

**Dispatch phase:** B — features after 01–04 are verified

**Stories:** 13, 14, 15

- [x] 同一主机多目录可添加到 Project，Create 时指定一个 default；主机关联保留，跨主机组合明确不属于当前功能。
- [x] 新增对话的实际工具执行根来自 default，额外目录不自动注入 prompt 或开放工具根。
- [x] 保留已存在的单根 Workspace/Project 记录，刷新/重启恢复 metadata、default 和展示名称。
- [x] 用已绑定会话及变化后的 Project 元数据验证：旧会话保持原位置，新对话选择新的 default；不为此新增 default 编辑器或迁移 UI。
- [x] 通过浏览器创建和实际对话/工具请求验证，不能只断言 metadata schema。

**Context:** [Approved spec](../spec.md). Before choosing work, read [dispatch order](../ticket-breakdown.md#dispatch-order). For the native runtime/integration contracts, read [framework evidence](../framework-fit.md).

## Comments

**Delivered.**

- **Schema.** `projects(id, name, host_id, default_folder_id, created_at)` with `default_folder_id` referencing
  `project_folders(id) DEFERRABLE INITIALLY DEFERRED`, and `project_folders(id, project_id REFERENCES projects(id) ON
  DELETE CASCADE, workspace_id UNIQUE, root, created_at)`. The two tables reference each other, so neither row can be
  inserted first under an immediate foreign key: the default reference is deferred and a project with its folders is
  written in **one transaction**. At commit the deferred reference is checked, so an unknown or missing folder cannot
  be committed. Membership (a folder of *this* project) is validated in code, because the foreign key proves a folder
  exists, not that it belongs to the project.
- **Store.** `create` writes the project and every folder in one transaction and rolls back as a whole; `setDefault`
  checks membership and updates the project row only — it never moves a workspace or rebinds a conversation.
- **Migration.** The released single-folder file has `workspace_id TEXT NOT NULL UNIQUE` on `projects`, and SQLite
  refuses to drop a UNIQUE column (checked: `cannot drop UNIQUE column: "workspace_id"`), so the file is rebuilt in
  **one** `BEGIN IMMEDIATE`: rename the old table, create both current tables, copy each project's own `workspace_id`
  and `root` into a folder row and point the project at it, drop the old table, check `PRAGMA foreign_key_check`,
  commit. Foreign keys are switched off **before** the transaction and restored **after** it (a pragma inside a
  transaction is ignored), and a failure rolls back to the untouched old file. Ids, workspace ids and roots are
  preserved exactly.
- **Backend.** `POST /api/projects` takes `{ hostId, name, folders: [{ root, default? }] }`, registers every folder on
  the one named host (each with its own opaque workspace id) and records the project only if all were accepted; exactly
  one default is required, a repeated folder is refused, and one host per request makes a cross-host project
  unexpressible. `PATCH /api/projects/:id { hostId, defaultFolderId }` is the default-change contract (no editor UI).
  `bindingOf`, `ensureBinding`, the install target and the startup replay all resolve **every folder of every project**,
  so a conversation bound to a non-default folder keeps executing after a gateway or backend restart, and each
  conversation re-asserts its own folder rather than the project's default.
- **Web.** A project is one group: `/project/<id>` keys every folder of it, so its conversations share a group named by
  the project. **Every** new-session affordance — the header's New, a group's own "+", the composer's bar — resolves to
  the project's default folder, so no affordance can create a conversation outside the user's default. The dialog adds
  and removes folders, refuses the same folder twice, and picks the default with a radio; it offers no default *editor*
  and no directory creation.
- **Host parse.** `HEPI_GATEWAYS` is parsed in a `try` whose failure reports a fixed message: a `JSON.parse`
  `SyntaxError` quotes the offending input, which there is a list of gateway tokens. Per-entry validation reports the
  index instead of echoing the entry.

**Evidence.**

- `apps/server/test/project.test.ts` (9 tests) over real loopback gateways: several folders with one default, the
  extra folder refused as a tool root, an old-bound conversation keeping its folder across a default change, every
  folder resolved after a backend+gateway restart, a **real old-DDL fixture** migrated and asserted through this API
  (including its original workspace id still executing), plus the ticket-07 cases.
- `apps/web/e2e/ux-new-project.mjs` (49 checks) in a browser against the real build, a real backend, a real gateway,
  and a controlled endpoint: two folders chosen and the same one refused twice, one default, the first turn running
  `bash`/`read` in the default with the extra folder's own file refused, one group for the project, reload plus
  backend+gateway and gateway-alone restarts, then every new-session affordance binding the default, `PATCH` naming
  the other folder the default, a new session binding the new default, and the conversation bound before the change
  still running where it was. Run `pnpm --filter @hepi/web build` first.
- `apps/web/lib/project-routing.test.mjs` (3 tests): every folder of a project resolves to that project's group and its
  default folder.
