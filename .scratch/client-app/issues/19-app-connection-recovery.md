# 19 — App 连接拒绝与重新配置入口

Type: implementation
Status: complete (implemented and evidenced on the packaged artifact, 2026-10-19; see
[Result](#result-2026-10-19))
Blocked by: [17](./17-retire-next-and-transition-paths.md) — complete, so this ticket is unblocked
Parent spec: [全栈重构后续 UX](../spec.md)

## Outcome

App 保存了被撤销或错误的 device bearer 时，用户可从拒绝面重新配置或断开连接，无需命令行。

## Scope

复用 apps/app shell 的 configureConnection、forgetConnection 与 Rust app_configure/app_forget。原生宿主向共享入口提供有意义的配置动作；配置成功按现有 restart 机制重建 origin policy。网络故障提供读取重试，凭证拒绝提供配置入口，清除配置须明确由用户选择。CLI --configure/--forget 继续作为现有运维能力。

## Acceptance

- [x] 无配置、正常配置、被拒凭证、不可达 Gateway 分别有明确状态与下一步；Configure/Disconnect 可通过键盘操作。
- [x] 取消配置保留旧连接；替换成功重启后只报告实际 admit 的 backend/account/client；不能沿用旧 descriptor 冒称连上新 profile。
- [x] 用户断开只清本机连接，不暗示撤销服务端 device 或终止 durable run。
- [x] 原生验证只使用隔离 Secret Service bus/mock keyring；不写开发者的 dev.hepi.app/connection。
- [x] Rust 按 debug、CARGO_BUILD_JOBS=6、CARGO_INCREMENTAL=1、共享 .dev/cargo-target；记录 packaged 目标与证据，Android 仍单列限制。
- [x] 更新 App 连接恢复指南；command、tested SHA、exit、log 齐全。

## Evidence and verification

[研究 A3/A4](../../ux-closeout-research/04-web-app-and-operational-feedback.md)。聚焦原生实际可操作恢复面；纯动态 profile 热切换是否存在普通触发留作 investigate，不扩展新 profile 管理系统。

## Result (2026-10-19)

Implemented on `d356152` + this change, in a worktree of that revision.

**Where the seam is.** `admissionOf` in `packages/ui/src/lib/web-session-gate.ts` now classifies a refusal as
`credential` (401/403 — only a different credential changes it) or `unreachable` (no answer, or a status that is not a
refusal — only another read can). `packages/ui/src/components/ConnectionRecovery.tsx` renders that state with the actions
that can make progress, and `workbench.tsx` offers a host's `connectionManagement` only when the host states one, so the
App supplies `configure`/`disconnect` and the Web page supplies nothing. `apps/app/src/main.tsx` states those two actions
and `apps/app/src/Configure.tsx` gained the replacement mode: the same form opened over the stored connection, with
Cancel. Retry is the workbench's own new descriptor read, not a replayed mutation.

**Evidence.** Packaged artifact test 54/54 (exit 0) on the two fixture ingresses — `.dev/artifacts/ticket19/verify-2026-10-19T18-07-26-325Z/report.json` — including the assertions this
ticket adds — refusal reported as refused with no connection named, the primary action reachable by keyboard, the stored
Secret Service entry unchanged by opening the replacement form, and the replacement admitting the second fixture's own
backend/account/client. The run used a private `/tmp/hepi-artifact-cred-*` bus and keyring with the developer's own
`login.keyring` digest identical before and after (`loginKeyringUntouched: true`), so no `dev.hepi.app/connection` write
reached the real store. Rust build stayed debug with `CARGO_BUILD_JOBS=6`, `CARGO_INCREMENTAL=1` and the shared
`.dev/cargo-target`; target `x86_64` (Android still unbuilt and unclaimed). Commands, SHAs, exits and logs:
[verification](../../../docs/verification.md#app-connection-refusal-and-recovery-ticket-19). Guide:
[apps/app README](../../../apps/app/README.md#when-the-gateway-refuses-the-connection).

**Not claimed.** No Android artifact, and no recovery journey against a real Gateway and Backend — both ends of the
packaged run are fixture ingresses. Pure dynamic profile hot-switching remains the investigate item it was, not a
feature this ticket added.
