# 01: 失败终端页签可关闭

**What to build:** 失败或未创建的终端页签可立即关闭；正常终端仍请求清理，远端清理失败不恢复已关闭页签。

**Blocked by:** None (can start immediately within the authorized dispatch phase)

**Status:** complete

**Dispatch phase:** A — bug fixes (01–04 first)

**Stories:** 1, 2, 3

- [x] 创建失败、清理拒绝/不存在、网络断开均不会留下无法关闭的页签。
- [x] 正常关闭保留必要的连接/资源清理，已关闭页签不会在刷新或恢复布局时重现。
- [x] 通过浏览器交互与受控失败响应验证，不接入交互 PTY。

**Context:** [Approved spec](../spec.md). Before choosing work, read [dispatch order](../ticket-breakdown.md#dispatch-order).

## Comments

**First pass.** Red (before any fix), real browser against the real production UI (apps/web/e2e/ux-terminal-close.mjs):
"AssertionError: a terminal whose creation failed must close". TerminalPanel only called onClosed after the
DELETE /api/terminal/:id cleanup resolved, and AppShell.onCloseError reverted the tab's "closing" flag on rejection, so a
failed creation (HTTP 501 in this application) or a rejected/absent/offline cleanup left a tab that could not be closed.
Green: the DELETE became best effort and the unused onCloseError prop plus its revert handler were deleted.

**Review follow-up.** That first pass still awaited startRef, the writer stop and the DELETE before reporting the close,
so a pending creation or cleanup (each request may wait for the 15 s typed timeout) kept the tab visible. Red gates added
for that gap, run against the first-pass code, both failing with "must close":

- Held creation: the fixture never answers POST /api/terminal; the tab stayed in the tab bar and in the saved layout.
- Held cleanup: the fixture never answers DELETE /api/terminal/:id; the tab stayed visible while the cleanup was pending.

Fix: TerminalPanel now treats closing as a local action. The close effect captures startRef and writerRef, calls onClosed
immediately (guarded by a closedRef so the callback fires exactly once per panel), and only then runs the best-effort
cleanup — await the captured creation, stop the captured writer, send the keepalive DELETE, swallow any failure. The
creation is never aborted, so a shell that does get created is still released after the tab is gone. AppShell also drops
tabs that are closing from the saved layout, so the one-commit window before the panel reports the close cannot persist a
tab that is going away. The 15 s typed timeout in terminalRequest is unchanged.

Browser cases (headless Chromium, real Next production server + real backend process, controlled HTTP fixtures only, no
PTY). Every wait is an observable UI, request or stored-state change — no fixed sleeps, no response-driven polling:

1. Real failed creation (501) closes the tab, still sends the DELETE, leaves the saved layout, and is not restored by a
   reload.
2. Cleanup rejected (HTTP 500) still closes the tab.
3. Cleanup absent (HTTP 404) still closes the tab.
4. Disconnected cleanup (aborted request) still closes the tab, attempted exactly once.
5. Creation held open: the tab leaves the UI and the saved layout while the creation is still pending, nothing is
   released early, and the release is still attempted once that creation settles.
6. Cleanup held open: the tab is gone before the cleanup resolves, a refused cleanup never brings it back, and the
   cleanup is attempted exactly once.
7. Normal successful creation and cleanup: one successful cleanup, tab dropped from the layout, not restored by a reload.
8. Restart replaces the tab exactly once and releases the previous terminal; an open tab survives a reload and closes.

Commands: "pnpm --filter @hepi/web build"; "node apps/web/e2e/ux-terminal-close.mjs" (8/8 PASS);
"pnpm -r typecheck" (6/6); "pnpm -r test" (protocol 10, client 9, session 3, gateway 59, server 70 — 0 fail); web subset
"node --test components/AppShell.terminal.test.mjs components/TerminalPanel.test.mjs lib/terminal-client.ts
lib/terminal-input.test.mjs" (11/11). The whole-web run keeps its documented 21 pre-existing baseline failures
(2055 tests, 2034 pass).
