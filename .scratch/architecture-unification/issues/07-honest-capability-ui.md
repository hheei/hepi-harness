# 07: Settings 与 MCP trust 如实呈现能力

**What to build:** 暂时无法确认能力时不将其当永久缺失；MCP trust 只读状态和主机操作说明可用，点击不会落入注定失败的 POST。

**Blocked by:** None (can start immediately)

**Status:** done — claimed and implemented by agent-39 on 2026-10-14; result and verification below

**Spec:** [统一设计](../spec.md)

## Acceptance criteria

- [x] 只有显式 unsupported 应答得出 unavailable，网络错误维持 unknown；沿用现有状态形状足够时不造状态机。
- [x] 已支持操作仍可用，loading/unknown/unsupported 呈现明确；无静默自动重试或全局能力注册表。
- [x] 移除 Web trust mutation、busy/error 和死流程；reader 与项目 MCP 声明仍显示，给出当前主机端操作指引。
- [x] host ownership refusal、global/local MCP 配置与 credential lineage 不变；不新增 Web trust writer 或经 backend 的主机写路径。
- [x] 相关语言文本一致，temporary failure 的恢复和明确 501 的隐藏/说明由既有公共 hook 测试验证（`settings-capabilities.test.mjs`：unsupported→`false`、普通失败→`true`、请求未到达→`null`、`capabilityNoticeKey` 映射）。本 ticket 未跑浏览器场景。
- [x] 清理 obsolete mutation tests，用真实 GET 与 UI 无失败动作的行为覆盖，更新 MCP/能力指南。

## Verification

Settings/MCP 的生产 Web routes 与 UI，临时 fetch failure/显式 501 对照；Execution Host identity 负向回归。 每次结果保存命令、源版本/dirty指纹、实际退出码和原始日志；本 ticket 更新自己的当前指南。

## Context

读取 [已定决策](../decisions.md)、[导航与 owning guides](../navigation.md) 和 [review notes](../review-notes.md)。按 spec 删除被替代知识与路径；可跨 Module 整理，最终 Interface 应统一且可维护。具体源位置在导航表，本 ticket 的行为目标不绑定过时文件布局。

## Result

Implemented on `integration/architecture-unification` in the shared checkout at HEAD
`1758c1fb4479e9d4637a957857246c5998619d73` with a dirty tree (this ticket's edits plus the coordinator's
pre-existing ones). No build, deploy, restart or commit was made.

### What changed

**Capability availability — `apps/web/lib/capability-availability.ts`**

`capabilityServed(path)` now returns `Promise<boolean | null>`:

- `false` — the route answered HTTP 501 **with** `code: "unsupported"`: the deployment's own statement.
- `true` — any other answer (200, 401, 403, 405, 500, or a 501 without that code).
- `null` — the request never arrived (offline, proxy, timeout, unreadable body): **unknown**, never the
  deployment's limit.

No state machine, no retry, no capability registry was added. `useCapabilityServed` still returns
`boolean | null` (it is now `boolean | null` rather than a falsy `false` for a lost request) and re-asks on
mount only. `capabilityNoticeKey(served, limitKey)` was added as the single mapping a surface uses to pick its
text: `undefined` when served, the capability's own limit key for `false`, `settings.capabilityUnknown` for
`null`. `unsupportedCapability(response, body)` is unchanged and still serves panels whose own read is the
capability's only surface.

**Surfaces that read it** — `SettingsPanel.tsx` (push) and `ModelsConfig.tsx` (provider sign-in/API keys,
discovery, connection test, catalog) now show `capabilityNoticeKey`'s text instead of treating a lost request as
an unavailable capability; a control stays offered while the answer is unknown.

**MCP trust is read-only, end to end**

- `ProjectTrustDialog.tsx` is a reader: it fetches `GET /api/project-trust` when it opens, lists what the
  folder's `.pi/mcp.json` declares, shows the folder's trust, states where the decision belongs
  (`trust.recordOnHost`: the `pi` CLI's own `/trust` on the host that owns the folder), and offers a single
  **Close** button. `onConfirm`, `busy`, `error`, `ProjectTrustFailure`, `ProjectTrustError` and the primary
  Trust button are gone.
- `AppShell.tsx` no longer holds `projectTrustBusy`/`projectTrustError` or `handleTrustProject`: there is no
  `POST /api/project-trust` and no state for a write's progress or failure. The dialog is mounted with `onClose`
  and `onStatus` only.
- `SettingsPanel.tsx`'s dead `onOpenTrustDialog` prop was removed (declared and destructured, never used).
- `McpConfig.tsx` / `McpAddServer.tsx`: the `onTrustProject` plumbing, `ConfigTrustNotice` trust button and
  `mcpProjectTrustable` gating are gone; an untrusted project shows `mcp.trust.recordOnHost` instead.
- `lib/project-trust.ts` keeps only the read helpers (`getProjectTrustStatus`, `mayReadProjectConfigNow`,
  `projectTrustReloadOptions`). `trustProject`, `trustFreshFolderAndWrite`, `freshFolderTrustBreadth`,
  `hasTrustRelevantEntries` and the fresh-folder breadth machinery were deleted; `mcp-config-read.ts` no longer
  computes `trustFolder`.
- `lib/api-types.ts`: `FreshFolderTrustBreadth`, `McpTrustFolderInfo`, `McpProjectInfo.trustFolder` and the
  refusal reasons `folder-not-fresh`, `trust-too-broad`, `trust-not-required`, `session-busy` were removed.
- Locales (`en`, `zh-CN`, `zh-TW`) gained `settings.capabilityUnknown` and `trust.recordOnHost`, and lost the
  retired mutation keys (`trust.trustProject`, `trust.trusting`, `trust.cancel`, `trust.trustFailed`,
  `mcp.trust.trustButton`, `mcp.add.buttonTrust`, `mcp.add.trustExplain`, `mcp.add.trustKept`,
  `mcp.add.addedTrusted`, `mcp.add.addedTrustedHere`, `mcp.add.projectBlocked.folder-not-fresh`,
  `mcp.add.projectBlocked.trust-too-broad.*`). `mcp.reason.trust-not-required` was **kept**: it is still
  rendered by `settledTrustNotice`. `mcp.add.projectBlocked.project-untrusted` now names the `pi` CLI's
  `/trust` as where the decision is recorded.

**Preserved lineages (unchanged by this ticket)**

- Host ownership refusal: `hostCwdOf` / `isThisWebHost` and `/api/hosts` ownership resolution untouched;
  `host-cwd-ownership.test.mjs` (foreign folder → 403) passes.
- `GET /api/project-trust` and the global/local MCP configuration and credential lineages are untouched;
  `POST /api/project-trust` still answers 405 `methodNotAllowed` (`adapters/mcp-surface.test.mjs`).
- The gateway's own `projectTrustRefusal` (`packages/gateway/src/mcp/config.ts`) still refuses an untrusted
  project write with `project-untrusted`. No Web trust writer and no trust path through the durable backend was
  added.

**Browser seam added** — `apps/web/e2e/ux-capability-trust.mjs` plus its fixture
`apps/web/e2e/ux-capability-trust.fixture.tsx` and `apps/web/e2e/ux-capability-trust.fixture.css`, registered as
`pnpm --filter @hepi/web test:capability-trust` (`apps/web/package.json`). It bundles the production
`SettingsPanel` and `ProjectTrustDialog` from source with only `window.fetch` replaced, so it needs neither a
Next build nor a backend, and drives them in a real Chromium. It also corrected three stale comments that still
described a Trust button the panel no longer has (`lib/stacked-dialog.ts`, `components/SettingsUi.tsx`,
`components/McpConfig.tsx`).

### Verification

Owned suites (all pass): `components/settings-capabilities`, `ProjectTrustDialog`, `SettingsPanel`,
`McpConfig`, `McpAddServer`, `mcp-add-helpers`, `mcp-config-helpers`, `SettingsUi`, `ModelsConfig`,
`AgentsConfig`, `EnabledModelsSection`, `lib/i18n/registry`, `lib/settings-navigation`,
`adapters/mcp-surface`, `adapters/host-cwd-ownership` — **289 tests, 289 pass, 0 fail**.

The public seams covered: the route (`durableApi` 501-unsupported → `false`; ordinary failure → `true`; a
request that never arrived → `null`; `capabilityNoticeKey` mapping), the browser (all three states rendered by
the production `SettingsPanel`), the dialog (read-only, Close only, no primary Trust button, host instruction
rendered, loading/Escape/focus behaviour), the panel (no `onOpenTrustDialog`/`onTrustProject` in source), the
MCP panel (untrusted notice names the host decision and offers no trust control), and `McpAddServer` (an
untrusted folder blocks a project add with `project-untrusted` and the request never sets `trustFolder`).

| check | command | exit | log |
| --- | --- | --- | --- |
| owned unit suites (15 files) | `node --test --test-reporter=tap <files>` (cwd `apps/web`) | 0 — 289 pass, 0 fail | `.dev/verify/2026-10-14-ticket07/unit.tap` |
| capability + trust browser seam | `node e2e/ux-capability-trust.mjs` (cwd `apps/web`) | 0 — 15 checks, 0 failures | `.dev/verify/2026-10-14-ticket07/browser-capability-trust.log` |
| typecheck | `npx tsc --noEmit` (cwd `apps/web`) | 0 — no errors at all (an earlier run showed two `ChatWindow.tsx` errors from ticket 08/10's in-flight edit; that worker has since fixed them and the tree is clean) | `.dev/verify/2026-10-14-ticket07/typecheck.log` (empty) |
| lint | `npx eslint <owned files>` (cwd `apps/web`) | 0 | — |
| docs | `node scripts/check-docs.mjs` | 0 | 235 Markdown files, 0 broken relative links, 0 missing indexed guides |

**Not re-run, and why.** The whole-Web-suite runs and their known-name comparison belong to ticket 11 (integration
and evidence), which owns the pinned two-revision comparison; this ticket's earlier observed-known-set accounting is
superseded by that. The one Web-suite name this ticket's predecessor moved,
`adapters/mcp-surface.test.mjs`'s "a project's other folder and its checkout reach the host as themselves", passes
standalone (9/9) and is absent from the last two whole-suite runs.

Source fingerprints at delivery: `capability-availability.ts` `0647e305…`, `ProjectTrustDialog.tsx`
`4e8a2a7a…`, `AppShell.tsx` `54209faf…`, `SettingsPanel.tsx` `916b8d0c…`, `McpConfig.tsx`
`c04268f0…`, `McpAddServer.tsx` `6b0fcb99…`, `ModelsConfig.tsx` `542de5cf…`, `project-trust.ts`
`5328336c…`, `mcp-config-read.ts` `a97df879…`, `api-types.ts` `c2b1d6d3…`, `en.ts` `30efb4e8…`,
`ux-capability-trust.mjs` `f1f9ecab…`, `ux-capability-trust.fixture.tsx` `ae87331c…`.

### Owning guides updated

- `docs/mcp-on-the-web-host.md` — "Project scope is trust-gated" now states that the whole Web origin only
  reads `trust.json` (no `POST /api/project-trust`, no writer, no path through the backend), that the trust
  dialog is a read-only view with a single Close, and quotes the host instruction the surfaces show; "The panel
  offers no control the host cannot perform" now covers a project **add** to an untrusted folder; "Not built"
  records the absent trust write and the absent trust-and-write add step.
- `docs/migration-status.md` — new paragraph stating that a capability is unavailable only for an explicit
  unsupported answer, with `unknown` for a request that never arrived and no registry/retry; the MCP trust
  paragraph now records the read-only Web origin and the absence of a trust writer.
- `docs/verification.md` — the new browser driver and what it proves, beside the existing `ux-truthfulness`
  entry.

### Recorded limit (not a defect to fix here)

`McpAddServer`'s legacy `trustFolder`/`trust-and-write` request field is gone from the request type, but the
host write path still has no way to trust a folder, so a project add to a folder with no decision remains blocked
with `project-untrusted` and the host instruction. That is the settled behaviour, not a regression.
