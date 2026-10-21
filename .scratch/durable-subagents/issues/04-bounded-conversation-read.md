# 04: 提供有界原始会话读取与可靠续读

**What to build:** 调用方通过核心 read/HTTP 读取真实会话原始历史、指定 entry/block 和图片；即使历史很长、单行超限或读取期间有新消息，仍能有界、可靠地继续。

**Blocked by:** None (can start immediately)

**Status:** resolved

**Labels:** ready-for-agent

**Spec:** [D01](../spec.md#d01)、[D02](../spec.md#d02)、[D13](../spec.md#d13)；[验收 A16、A17](../spec.md#testing-decisions)。

## Acceptance criteria

- [x] 实现 ConversationOperations.read 与 raw-history HTTP adapter，读取 fork-aware 原始 Conversation.entries，不用 active context 或 SSE 窗口替代；精确验证成员关系。
- [x] 稳定呈现保留 entry/role/block 定位，offset 为1-based实际文本行，limit 为最大行数，缺省2000行/50 KiB；正文与 details/diagnostics 分离。
- [x] 首次读取固定 tail；续读携带 entry/block、entry 内行/字符位置、tail 和呈现版本。历史追加不改变已读映射，连续页从 token 前进而非逐页重扫全部历史。
- [x] 超长单行提供 UTF-8 安全分片与有效续读位置；不输出主机 bash/sed 续读提示；精确说明首次大 offset 和内部整 entry 解码的限制。
- [x] 图片按明确 block 读取并受输入/宿主预算约束，文本/图片输出与原生 Read 兼容；compact 前记录及已有 fork 共享前缀/附件仍可读。
- [x] 继承附件用当前读取的 conversation+entry 解析；父 tombstone 不使有效继承内容失效，其他会话的全局 entry ID 不能绕过成员校验。
- [x] 读取与指定 entry/block HTTP 使用同一核心实现；接口可直接供后续 agent_read adapter 使用，不复制历史成文件、不内置搜索。

## Verification seam

- 真实 SQLite 构造多行、超长UTF-8行、compact前记录、图片、共享前缀与并发追加；逐页重组内容并核对字节/行预算与定位。
- 对不属于目标的 entry 拒绝；用公开调用确认续读不重复/遗漏，不依赖 helper 内部结构断言。

## Scope and handoff

agent_read 模型 adapter 在06注册并于08检查最终工具集；不交付 codemode、搜索、全文索引或会话虚拟文件系统。

遵守[共同完成条件](../README.md#completion-criteria)：实际证据、owning guide 更新和材料性问题处置随本票交付，不等最后一票代做。

## Evidence

Branch `impl/durable-subagents-04`, base and integration tip `e784b45` (in sync with `integration/durable-subagents` before completion). Code:

- `apps/server/src/conversation-read.ts` — the one implementation. `readConversation(harness, request)` resolves the conversation and reads **`Conversation.entries()`**, the runtime's fork-aware, membership-checked native scan: the whole raw history ascending, or one entry, or one block of it. Presentation is the native Read's — `output` is `[{type:"text",text}]` or `[{type:"image",data,mimeType}]`, and `details` carries scope, `tail`, first line number, limits, `outputLines`/`outputBytes`, `truncatedBy`, `hasMore`, the entries with their block refs (native `blockIndex`, line ranges, image mime and bytes) and `next`; `diagnostics` says why a page stopped. `offset` is a 1-based actual text line, `limit` a line count, defaults 2000 lines / 50 KiB. The first page pins the snapshot's newest entry as `tail`; a continuation carries `{version, entryId, blockIndex, blockLine, charOffset, offset, tail}` and starts at that entry through a bounded native scan instead of re-walking the history. A single line over the byte budget is cut on a code-point boundary with a cursor continuing inside the same line; no shell hint is emitted. Refusals are `ConversationReadRefusal` with the code and status the route answers with: 404 `not_found` (unknown conversation/entry/tail, an entry id from a conversation that did not inherit it, a block carrying no text), 400 `invalid_request`, 409 `version_mismatch`/`stale_cursor`, 415 `image_not_served` (the one wire policy: `TOOL_RESULT_IMAGE_MIMES` and `MAX_TOOL_RESULT_IMAGE_BYTES`).
- `apps/server/src/conversation-read-route.ts` — the raw-history HTTP adapter. It parses the query into the read's own request, calls the same `read()`, and translates a `ConversationReadRefusal` into its status and `{protocol, code, error}`. It holds no second copy of the bounds, the cursor or the membership rule.
- `apps/server/src/conversation-operations.ts` — `ConversationOperations.read` added; the operations object is the seam `agent_read` (ticket 06) will use.
- `apps/server/src/server.ts` — `GET /api/conversations/:id/read` (`offset`, `limit`, `entryId`, `blockIndex`, `tail`, `cursor`) delegates to the adapter behind the same token as every other conversation route.
- `docs/chat.md` — new section under *Bounded history, older pages, and the read blocks* stating the route, the parameters, the 2000-line/50 KiB budget, the coding of the continuation, the refusals and the two named limits.
- `docs/migration-status.md` — the raw read and its two limits recorded beside the bounded-history section, per the repository's rule for remaining capability limits.
- `apps/server/test/conversation-read.test.ts` — nine tests at the public core and the real HTTP seams over native SQLite.

Commands and raw logs (node v26.5.1, pnpm 12.4.1, logs under the git-ignored `.dev/verify/durable-subagents-04/`):

| Command | Result | Log |
| --- | --- | --- |
| `pnpm --filter @hepi/server typecheck` | exit 0 | `typecheck-server.log` |
| `cd apps/server && node --test test/conversation-read.test.ts` | exit 0, 9/9 | `test-conversation-read.log` |
| `cd apps/server && node --test test/*.test.ts` | exit 0, 304/304 | `test-server.log` |
| `pnpm verify:changed --base=integration/durable-subagents` | `changed-typecheck` exit 0, `changed-test` exit 0 (server 304/304), `check-docs` exit 1 | `verify-changed.log` |

Repository selector run at `043a295` (clean tree): the only failing step is `check-docs`, with the same 12 pre-existing broken `.scratch/**` links recorded as the baseline on ticket 03; none of them is a file this ticket touched. Report: `.dev/verify/2026-10-16T08-09-48-359-verify-changed/verify.json`. Re-run at the tip `1db3621` with the two documentation commits in the tree: `changed-typecheck` exit 0, `changed-test` exit 0 (server 304/304), `check-docs` exit 1 with the same 12 links (`verify-changed-tip.log`); report: `.dev/verify/2026-10-16T08-12-44-380-verify-changed/verify.json`.

Observable acceptance covered, all through public calls over real SQLite:

- Multi-line history read as 1-based text lines: `offset: 2` starts at the second **line**, `details.entries` maps each line back to its entry, block and line range, and an offset past the end is an empty page with `end_of_history` rather than an error.
- Fixed tail and continuation: a page over one entry's two lines returns a cursor holding the entry, its block, the in-block line and the character offset; an entry appended between the two pages does not move the second line, and a fresh read states the new snapshot. A continuation's first scan is bounded at its cursor entry (observed through a counting proxy in front of the **runtime** boundary) and the four-page walk reassembles the history exactly once; `pnpm test` covers the 30-entry case.
- Byte budget and oversized lines: a 60 000-character ASCII line and a 30 000-character CJK line come back as UTF-8-safe pieces that rejoin byte for byte, with no replacement character, `outputBytes` within 50 KiB, a cursor whose `charOffset` continues inside the same line, and no `sed`/`bash` hint anywhere in the diagnostics. A 2 500-line entry stops at 2000 lines with `truncatedBy: "lines"` and `next.offset` 2001.
- Blocks and images: an image block reads as `[{type:"image", ...}]` with the message's own block index and a `bytes`/`mimeType` reference in the inventory, while the text block beside it reads as lines; an `image/tiff` block is refused 415, a tool-call block 404, an index outside the content 400, a `blockIndex` without an `entryId` 400.
- Raw history versus the active window: an entry dropped by a compaction head marker is still read; a fork reads the prefix it inherited and does not gain entries appended to its parent afterwards; tombstoning the parent does not invalidate the fork's inherited entries; a sibling conversation's entry id is 404 through another conversation and a `tail` naming an unknown entry is 404.
- HTTP: the real backend's `GET /api/conversations/:id/read` answers the same page as the core, the continuation it returns round-trips through the query as JSON, refusals keep their codes (400 `invalid_request`, 404 `not_found`, 409 `version_mismatch`), an image block comes back as an image, and the route requires the token.

## Correction (review round 1)

Three material ordinary-use failures were found at the walk/`readBlock` seam of the first revision (`043a295`, merged as `3040511`) and are fixed in `ff08535`, merged into the tip `29709bf`:

1. A block-scoped read passed only `limit` to `readBlock`, which hardcoded `offset: 1` and dropped the cursor, so a block larger than one page answered its own first page to every continuation and `offset` was ignored. `readBlock` now takes the read's `offset` and `cursor` and hands them to the same walk, whose lines are already numbered inside the block's own scope.
2. The over-long-line branch stored `piece.length` as the next `charOffset` instead of the position the page started at plus the piece, so a line needing more than two byte budgets repeated its second piece forever. The walk now remembers where its piece starts (`from`) and returns `from + piece.length`, and the diagnostic states the character range the page carried.
3. `markSpanned` ran only for returned lines, so an entry carrying no text line (image-only, tool-call-only) never entered `details.entries` and its block could not be discovered by a caller. The walk now registers an entry it passes inside the page's range that carries blocks but no text line, before lines are handed out, so the inventory lists it with the block index that addresses it — and stays as bounded as the page: the entries whose lines were returned plus the traversed non-text entries up to the stop, never the entry its own cursor names next.

The literal backslashes the first revision left before the inline-code markers in this ticket, `docs/chat.md`, `docs/migration-status.md` and the JSDoc of the touched modules were removed as well. The two recorded limits are unchanged.

Commands and raw logs (node v26.5.1, pnpm 12.4.1, `.dev/verify/durable-subagents-04/`):

| Command | Result | Log |
| --- | --- | --- |
| `git stash push -- apps/server/src/conversation-read.ts`, then `node --test test/conversation-read.test.ts` | exit 1 — 3 of 12 fail, and they are the three new tests | red check below |
| `pnpm --filter @hepi/server typecheck` | exit 0 | `typecheck-server.log` |
| `cd apps/server && node --test test/conversation-read.test.ts` | exit 0, 12/12 | `test-conversation-read.log` |
| `cd apps/server && node --test test/*.test.ts` | exit 0, 307/307 | `test-server.log` |

Red check: with the pre-fix `conversation-read.ts` restored and the new tests in place, `not ok 5` (a line spanning several byte budgets), `not ok 8` (block offset and scoped cursor) and `not ok 9` (non-text entry inventory) — 9 pass, 3 fail; the same tests against the fixed module pass 12/12.

Repository selector at `29709bf` (clean tree, after merging integration `1d56310`): `changed-typecheck` exit 0, `changed-test` exit 0 (server 307/307), `check-docs` exit 1 with the same 12 pre-existing `.scratch/**` links. Report: `.dev/verify/2026-10-16T08-26-43-553-verify-changed/verify.json`.

New coverage, all through the public core and the real route over native SQLite: a 170 000-character positional ASCII line and a 160 000-byte emoji line advance one piece per page with strictly increasing character positions inside a line, reassemble exactly and terminate in 8 pages; a 120 000-character block honours `offset` inside its own lines and continues from its own cursor over the core and over HTTP (three pages rejoining into the block, no repeated page); a one-line history page lists the entries it passed without claiming the entry its cursor names; an image-only entry inside and at the end of a snapshot is listed with the block index that then serves the image, and a tool-call-only entry is listed with its name and no line range.

Limits, recorded rather than implied: a first read with a large absolute `offset` locates its start by counting lines from the oldest entry — no line index is built, persisted or scanned — and one entry is decoded whole before it is split, so the 50 KiB budget bounds the output and not the memory one entry costs. The image policy bounds the declared mime and the decoded bytes, not the host's total page cost. `cursor` is the resume mechanism the model adapter will use; no codemode, search, full-text index or conversation virtual filesystem is delivered here.
