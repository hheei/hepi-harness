# 23 — 删除无产品调用方的 SettingsReader

Type: implementation
Status: **complete 2026-10-20** — dead export, its dedicated test and the stale guide reference are removed; the real cache
primitive is unchanged.
Blocked by: [17](./17-retire-next-and-transition-paths.md) (complete 2026-10-19)
Parent spec: [Shared React Client / Gateway Ingress](../spec.md)

## Outcome

模型读取只保留实际使用的 connection-scoped cache 原语，维护者无需理解未接入产品的 SettingsReader。

## Scope

依据 [Pilo 研究](../../../docs/research/pilo-simplicity-review.md)，在当前 integration tip 重查引用后，删除 packages/session/src/settings.ts 的 ModelCatalog、SettingsReader、createSettingsReader，以及 packages/ui/src/lib/models-cache.test.mjs 的专属测试/import。实际产品继续使用 createScopedCache。同步 docs/client-ingress.md 的公开 API 清单；相关能力指南只按实际变更更新。

## Acceptance

- [x] 当前源码确认无产品消费者；若并行工作已引入消费者，先与其 owner 协调并保持实际业务合同。
      Re-searched at `0a3d065`: `createSettingsReader|SettingsReader|ModelCatalog` matched only the definition, the
      dedicated test import/case and `docs/research/pilo-simplicity-review.md`. `models-cache.ts` and
      `useAgentSession.loadModels` reach `createScopedCache` directly; no product surface ever named the reader.
- [x] 死导出、专属测试/import、当前指南中的失效 API 引用均移除；历史研究保留为历史证据。
      Removed `ModelCatalog`, `SettingsReader` and `createSettingsReader` from `packages/session/src/settings.ts`, the
      jiti import and the `the settings reader caches the catalog and a save invalidates it` case from
      `packages/ui/src/lib/models-cache.test.mjs`, and the `createSettingsReader` entry in the public-API sentence of
      `docs/client-ingress.md`. `docs/research/pilo-simplicity-review.md` is untouched.
- [x] 真实模型读取仍使用 createScopedCache；scope隔离、in-flight去重、失效后迟到回答不回填、TTL/容量证据保留。
      The seven surviving `models-cache.test.mjs` cases are unchanged and still cover the descriptor-derived scope,
      per-connection entry keys, in-flight isolation, the invalidated-late-answer rule, TTL and the entry bound, the
      page instance a credential change drops, and `createModelsCache`'s catalog lifetime.
- [x] 记录实际净 diff；研究估算38行仅作参考，不为凑数删语义或增加替代封装。
      Net: `packages/session/src/settings.ts` 0/-27, `packages/ui/src/lib/models-cache.test.mjs` 1/-13, plus one changed
      line in each of `docs/client-ingress.md` and `docs/migration-status.md` — 1 added, 41 removed across the ticket. No
      wrapper, shim or replacement type was added; `createScopedCache` and `connectionScopeOf` are exactly as they were.

## Verification

定向引用搜索、模型快取现有测试、相关包typecheck与 pnpm verify:changed；复用未变源码的既有证据，不新增镜像实现的测试。按 docs/agents/verification.md 记录 command、revision、dirty state、exit、log。

Tested source `0a3d065eb259f9ec19f9af4c6e8f631b34f90cbb`, dirty tree carrying this ticket plus 24/25 (same commit block).

| Command | Exit | Log / result |
| --- | --- | --- |
| `rg -n 'createSettingsReader|SettingsReader|ModelCatalog' -g '!node_modules' -g '!graphify-out' .` | 0 | only `docs/research/pilo-simplicity-review.md` (historical) and `model-catalog.ts`'s unrelated `ModelCatalogEntry`/`ModelCatalogPreset` types |
| `node --test packages/ui/src/lib/models-cache.test.mjs` | 0 | 8 pass (7 cache cases + `createModelsCache` lifetime) |
| `pnpm --filter @hepi/session typecheck` | 0 | `tsc --noEmit`, no output |
| `pnpm --filter @hepi/session test` | 0 | 57 pass, 0 fail |
| `pnpm --filter @hepi/ui typecheck` | 0 | `tsc --noEmit`, no output |
| `pnpm verify:changed --base=0a3d065` | 0 | `.dev/verify/2026-10-20T10-36-30-742-verify-changed/` (`verify.json`: sha `0a3d065e`, `dirty: true`, `ok: true`) |

Committed revision `7345384` (clean tree): `pnpm verify:changed --base=0a3d065` exit 0,
`.dev/verify/2026-10-20T10-40-08-666-verify-changed/verify.json` — sha `7345384f`, `dirty: false`, `ok: true`,
`changed-typecheck`/`changed-test`/`web-unit`/`check-docs` all 0.

## Coordination

17后可与24/25按路径并行；涉及provider模型刷新时保留其失效合同并协调同文件写入。本票不重开11或provider验收，不阻挡18–22。
Implemented together with 24/25 because they share `workbench-scope.ts`, the fixtures and `docs/client-ingress.md`; the
provider invalidation contract (`invalidateModelCatalog`) is untouched.
