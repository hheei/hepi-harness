# 12: 后台 Pi 模型配置读写与原生刷新

**What to build:** Models 设置读取/保存后台权威 Pi 配置，并通过原有 ModelRuntime 验证、刷新与持久化路径影响后续请求。

**Blocked by:** None (can start immediately within the authorized dispatch phase)

**Status:** implemented, verified — merged as 7ca85f0; models editor and image-admission paths re-checked on the merged tree, core 208 tests, 6 typechecks

**Dispatch phase:** B — features after 01–04 are verified

**Stories:** 21, 22, 23, 24, 26, 27

- [x] Models 设置真实读取后台配置；经 Web origin 验证读写及所需 HTTP 方法，不读取另一个 Web 主机的配置文件。
- [x] 复用上游验证、凭据解析与 refresh；清楚区分校验失败、保存及运行时应用结果，诊断保持既有凭据脱敏。
- [x] 修改后通过受控 provider 检查实际后续请求的 endpoint/参数，保持别名和当前凭据来源；已有 prepared/in-flight 工作遵守上游时机。
- [x] 配置保存后重启仍生效；显式对话选择、模型目录、新对话默认值及资源 Reload 保持各自既有职责。
- [x] 实现前说明 env-mode 接到 Pi 权威配置的具体转换方案；现有部署设置须可保留，不开展 live 配置迁移。
- [x] OAuth、账户用量及其他 provider Settings 子功能保留各自 TODO，不以编辑模型配置扩张实现范围。

**Context:** [Approved spec](../spec.md). Before choosing work, read [dispatch order](../ticket-breakdown.md#dispatch-order). For the native runtime/integration contracts, read [framework evidence](../framework-fit.md).

## Authority scheme (reported before implementation, then implemented)

One backend-owned `ModelRuntime` over the backend agent directory's `models.json` serves both modes, so the editor's
file is authoritative in both. Pi mode builds it from that directory (including `auth.json`); environment mode builds
the same runtime and re-registers the deployment's configured provider on every boot through the public
`registerNativeProvider` as an **environment-owned base layer**, with an `$HEPI_PROVIDER_API_KEY` reference rather than
a copied key. Credentials stay in memory there (`InMemoryCredentialStore`), so no `auth.json` is read or created. The
file overlays the base layer; removing a file definition restores the base provider, which is why a file deletion is not
claimed to delete the deployment's provider. Startup is no longer bricked by a valid configuration whose default model
was deleted or is unauthenticated: the reference is preserved, a warning is reported, and the next request settles
natively as `no_model`.

## Implementation

- `apps/server/src/model-config.ts` (new): agent-directory resolution shared by both modes, lenient `models.json`
  reading, cost normalization and blank-row sanitization, atomic `0600` writes, candidate validation on a throwaway
  `ModelRuntime` (`refreshOnCreate: false`, so a `!command` credential reference never runs), error sanitization, the
  serialized save chain, and `openEnvModelRuntime` for environment mode.
- `apps/server/src/server.ts`: `GET`/`PUT /api/models-config` with three truthful outcomes (`400` = invalid, file and
  runtime untouched; `success:true,applied:true`; `success:true,applied:false` = written but not applied).
- `apps/server/src/pi-config.ts`: tolerant default resolution; `defaultModel` may be undefined; unavailable or
  unauthenticated defaults become warnings. Malformed files still fail startup.
- `apps/server/src/harness.ts`, `main.ts`, `provider-config.ts`: the caller-supplied registry owns its default
  reference (including none); environment mode passes the runtime and its `modelConfig` target; the custom provider
  object is exported so the same provider is registered as the base layer.
- `apps/web/app/api/[...path]/route.ts` exports `PUT`; `apps/web/adapters/durable-api.ts` proxies
  `models-config` to the backend and invalidates the models cache after a save.
- `apps/web/components/ModelsConfig.tsx`: a saved-but-not-applied response is reported as such instead of Saved; the
  panel names the backend as the file's owner instead of a path on the UI host. The orphaned Web-host file reader
  `apps/web/lib/models-config-store.ts` and its test were removed; its still-meaningful session assertion moved to
  `apps/web/lib/session-reader.test.mjs`.

## Review follow-up (branch `impl/ux-follow-up-12`, merged with `integration/ux-follow-up`)

Triage per [review policy](../../../docs/agents/review-policy.md). Two findings were material normal-use failures and were
fixed at their owners; the rest are recorded.

**Fixed.** (1) `openServerHarness` had an implicit default argument, so `createBackendServer`'s explicit "no default
model" was folded back into `SERVER_MODEL` and a faux reference was manufactured. The three states are now distinct:
omitted keeps the built-in scripted default, `null` reaches the harness as none, and a supplied registry's reference is
kept as given. The public catalog states `defaultModel: null` and the conversation snapshot reports `model: null`
instead of inventing one. (2) `normalizeModelConfigCosts` dropped a malformed cost group, which turned a draft the
loader rejects into a valid one that then replaced a working file. It now repairs only what the editor model itself can
express — an empty group is omitted, a partial group of known finite rates is completed with zero — and writes anything
else through, so the loader answers `400` and both the file and the running runtime stay untouched.

**Recorded (negligible, contrived, or no evidence of normal-use impact).**

- `sanitizeModelConfigError` collapses whole-file load failures (whose upstream message quotes the file's bytes) to one
  fixed sentence, and keeps schema-path and provider/model-id diagnostics, because those are the operator's own input.
  A contrived secret *inside an unknown api id or a malformed header value* reaches the caller as its own input echoed
  back; there is no path by which an environment secret enters those fields, and the demonstrated leak — a parse error
  quoting a file that holds a credential reference — is covered. Revisit if a real incident shows a configured secret
  echoing through a provider-composition message.
- Whether the editor's own model should distinguish "empty" from "invalid" before serialization is a UI question, not an
  ownership boundary: the backend already gives the truthful answer at its public seam.
- The `!command` credential reference is persisted verbatim and is resolved only when a request actually uses the
  provider. Saving and validating never execute it; that is asserted without a sleep, by the save's own completion.

## Review notes

`record` — the localized saved-but-not-applied message is unreachable (no patch, no test, no repeated review).

- **Trigger:** saving a draft the backend writes to `models.json` but cannot apply to the running runtime.
- **Evidence:** in `handleSave` (`apps/web/components/ModelsConfig.tsx`), `if (!res.ok || d.error) setSaveError(d.error ?? \`HTTP ${res.status}\`)` runs **before** `if (d.applied === false) setSaveError(t("models.savedNotApplied", …))`. The backend's saved-not-applied result is `{ status: "saved", applied: false, error: string }` (`apps/server/src/model-config.ts`), where `error` is always present — it is the message "the saved models.json could not be applied". So the earlier guard always fires and the specialized localized `models.savedNotApplied` string never renders.
- **Normal-use likelihood:** the write path itself is exercised (a save whose overlay the runtime rejects), so the condition occurs; only the *string choice* differs.
- **User impact:** low. The operator still sees the truthful "the saved models.json could not be applied" diagnostic from the backend; the observed failure is conveyed. The only loss is localization — the English backend sentence instead of the translated `models.savedNotApplied` wording — and no user confusion has been reported.
- **Disposition:** `record`. No production patch, no regression test, no Response-layer redesign; ordering the two guards is a UI-localization polish, not a correctness or ownership fix, and the backend already gives the truthful answer at its public seam.
- **Revisit if:** a real user reports being unable to tell a saved-but-unapplied configuration from a failed save, or the saved-not-applied result is ever returned without an `error` (which would then also drop the message entirely).

## Evidence

`pnpm -r typecheck` and `pnpm -r test` pass on the merged tree (server 119, gateway 62, protocol 15, client 9,
session 3); `node --test` across the Web unit files 74.
`apps/server/test/models-config.test.ts` drives the real HTTP surface with two controlled endpoints: an untouched
environment alias keeps its endpoint and credential source; a saved provider serves the next request while an
already-prepared request finishes on its original endpoint; the saved configuration survives a restart; a rejected
draft leaves the bytes and the live runtime intact without echoing a secret; a malformed file cannot be overwritten;
saving never executes a credential command; environment mode reads no `auth.json` and creates no `models-store.json`;
a write that cannot be applied is reported as saved-but-not-applied; a conversation without an available model settles
without a synthetic assistant reply and recovers after an explicit reselection.
`apps/web/e2e/ux-models-config-save.mjs` runs the real production Web UI, a real backend and a real workbench gateway
against two controlled endpoints: the editor reads an empty file for an unconfigured deployment, saves through the UI,
the next turn is served by the saved endpoint with the environment credential, an in-flight turn keeps its original
endpoint, and the saved endpoint still serves after a backend restart.

The same file now also covers: an unconfigured environment deployment actually serves the offline scripted reply
`Server reply to: …` through `openEnvModelRuntime` (the registry and environment mode share one scripted provider
definition); malformed cost groups (string, array, non-finite rate, unknown rate key) are refused with `400` while the
file stays byte-identical and the live runtime keeps serving; and a conversation with no available model reports no
default in the public catalog and `model: null` on its snapshot, settles without a synthetic reply, and recovers after
an explicit reselection.

Limits: no live deployment or paid provider was used. OAuth, provider usage, `/api/models/enabled|default|refresh` and
`models-config/discover|test|catalog` remain unimplemented TODOs.
