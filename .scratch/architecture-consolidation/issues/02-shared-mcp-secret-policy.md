# 02: 让 MCP 导入与宿主响应共用脱敏实现

**Parent:** [Architecture consolidation spec](../spec.md)

**What to build:** 用户导入 MCP 配置与查看宿主结果时使用同一套脱敏纯规则，Gateway 自有错误 walker 继续承担其原职责。

**Blocked by:** None (can start immediately)

**Status:** resolved

## Acceptance criteria

- [x] 协议包 mcp-secrets 子路径成为脱敏纯模块的唯一可执行实现；当前在线调用方及仍存在的休眠直接引用均改接，旧实现副本删除。
- [x] URL、命令、参数、引用变量和字面凭据的现有输出语义保持；有意义的行为用例随实现迁到正确所有者。
- [x] Gateway walker 保留，休眠 Web redactor 的退役交由 04/09；本票不把两个职责合成策略框架。
- [x] 来源 revision、迁移 hash 和 notices 路径更新；实际 CLI bundle/安装包携带所需许可，Web/Gateway 分发许可不因 private 而省略。
- [x] MCP 配置、宿主调用和导入 UI 的现有工作流通过；不增加永久 vendor 字节相等测试。

## Resolution

Moved the 523-line pi-web masking module to `packages/protocol/src/mcp-secrets.ts`, exported as the
`@hepi/protocol/mcp-secrets` subpath (same shape as `@hepi/session`'s `./browser`). The copy is byte-identical to
`apps/web/vendor/pi-web/lib/mcp-secrets.ts` (md5 `dc94b7732a7b05a6211d485ab5d8037f`, sha256
`982c17fe8ddbef7f228c46db2aabbc40a1a38dfb0dd292af28ca2b6e7cedea4d`); the vendored provenance snapshot is untouched.

Re-pointed callers, all now the one subpath:

- live Web: `lib/mcp-import.ts`, `lib/mcp-import-core.ts`, `lib/mcp-import-json.ts`, `components/mcp-add-helpers.ts`,
  `components/McpAddServer.tsx`
- dormant Web direct imports (04 will retire the modules, so they were migrated, not pre-deleted):
  `lib/mcp-config-read.ts`, `lib/mcp-test.ts`
- gateway: `src/mcp/secrets.ts` only; its own walker (`literalSecrets`/`createRedactor`/`maskedEntry`,
  longest-first replacement, `MASK_MIN_LENGTH = 4`) is unchanged apart from the import.

Deleted the two duplicate copies (`apps/web/lib/mcp-secrets.ts`, `packages/gateway/src/mcp/mcp-secrets.ts`) and moved
the behavior matrix to `packages/protocol/test/mcp-secrets.test.ts` (2 cases, unchanged assertions, no byte-equality
test). `packages/gateway` gained `"@hepi/protocol": "workspace:*"`; lockfile updated with `pnpm install
--lockfile-only --offline` (manifest edits shared with ticket 01 — coordinator integrates).

Docs/notices: `docs/upstream-sources.md` (new owner path, move hash), `docs/mcp-on-the-web-host.md`,
`packages/client/THIRD_PARTY_NOTICES.md`. `packages/client/scripts/build.mjs` NOTICE and its `smoke-pack` assertion
are unchanged and still pass — the CLI bundles `@hepi/protocol` sources and carries the pi-web copyright line.

### Evidence (revision b49e44e + this change; logs in `.dev/verify/consolidation-02/`)

| Command | Exit | Log |
| --- | --- | --- |
| `pnpm install --offline --frozen-lockfile` | 0 | — |
| `pnpm --filter @hepi/protocol test` | 0 (47 pass, includes the 2 moved cases) | `protocol-test.log` |
| `pnpm -r typecheck` | 0 | `typecheck.log` |
| `pnpm --filter @hepi/gateway test` | 1 — one failure, `terminal.test.ts:286` "a process the shell started outlived the closed session" | `gateway-test.log` |
| `node --test test/terminal.test.ts` (alone) | 0 | `gateway-terminal-retry.log` |
| `node --test test/mcp.test.ts` | 0 (9 pass) | `gateway-mcp-test.log` |
| `node scripts/test-web-unit.mjs` | 0 (63 files, 109 tests, 0 fail — was 64/111) | `web-unit.out`, `web-unit.json` |
| `pnpm --filter @hepi/client build` | 0; `dist/cli.js` contains the masking module and the notice | `client-build.log` |
| `pnpm --filter @hepi/client smoke:pack` | 0 (6 checks, tarball notice assertion included) | `client-smoke-pack.log` |
| `pnpm check:docs` | 1 — 12 pre-existing broken links, none in a file this change touches | `check-docs.log` |
| `pnpm check:entrypoints` | 0 (2 pre-existing known-missing) | `check-entrypoints.log` |

The gateway failure is a terminal-timing flake unrelated to this change: it passes when run alone and no file in this
change is on that path. It is recorded, not repaired (review policy: `record`).

## Verification seam

复用脱敏行为矩阵、MCP 导入/宿主浏览器检查与 CLI artifact notice/pack smoke。

## Integration notes

与 01 共享协议包 manifest，集成时由协调者串行合并 manifest/lockfile。若 04 已删休眠消费者，则只迁移当前剩余引用；这不是虚构的语义阻塞边。
