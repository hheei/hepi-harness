# Split deployment verification (UI → oracle backend → local gateway)

Split topology exercised end to end on this workstation: browser UI on `127.0.0.1:30141`, durable backend reached through an SSH local forward, gateway reached by the backend through an SSH remote forward.

| Role | Endpoint | Notes |
| --- | --- | --- |
| Web UI | `http://127.0.0.1:30141` | Next production server, adapter proxy only, no agent loop |
| Backend (oracle host) | `127.0.0.1:8787` there, `127.0.0.1:18787` here | `ssh -L 127.0.0.1:18787:127.0.0.1:8787 remote-host` |
| Gateway | `127.0.0.1:28788` here, `127.0.0.1:18788` on the oracle host | `ssh -R 127.0.0.1:18788:127.0.0.1:28788 remote-host` |

Workspace: logical id `integration` (UI path `/workspace/integration`) bound to the gateway root `/tmp/hepi-split-workspace`. Model: `magpie/deepseek-v4.1-flash`, a real OpenAI-compatible endpoint reached from the backend only. The gateway token never enters the browser; the UI proxy holds the backend token in an HttpOnly cookie.

## Verified: browser login hydration

- Fresh browser context, `GET http://127.0.0.1:30141/?session=8`: password gate is shown, token accepted, composer `textarea` appears.
- `page.reload()` on the same context stays authenticated (no second gate, composer present, session 8 history rendered) — the HttpOnly cookie survives reload and the adapter rehydrates the session.
- A request with a wrong cookie is rejected with 401 by the adapter, so the gate is real and not client-side only.

## Verified: full turn through the UI to the gateway

Prior backend-direct runs (this session, without a browser) exercised the same path through `/api/conversations/8/messages`: read, write, bash, `pwd`, and `node --test test/billing.test.ts` — 3 tests passed, and `split-proof.txt` was written and read back.

Then the same work was repeated from the actual local UI in headless Chromium (Playwright), driving only the visible controls:

1. Navigate to `http://127.0.0.1:30141/?session=8`, authenticate, wait for the composer `textarea`.
2. Fill the textarea with: "Use the read tool on split-proof.txt and reply with its exact content on one line." and click the `Send` button.
3. Poll `GET /api/agent/running` until it reports the run started, then until it reports the run finished (no fixed sleeps).
4. Read the resulting durable state from the backend.

Observed during the run (adapter request log):

- `POST /api/agent/8` → 200 (submission accepted), `GET /api/agent/8/events` → 200 (SSE open).
- `GET /api/files/workspace/integration?type=list` → 200 (workbench listing through the backend).
- `GET /api/models` → 200; `GET /api/worktrees`, `GET /api/sessions/8/state` → 200.

Observed in the durable snapshot `GET /api/conversations/8/state` (backend direct, token from the runtime secrets file):

```text
busy: false | revision: 8 | workspaceId: integration
model: {"provider":"magpie","modelId":"deepseek-v4.1-flash"} | thinkingLevel: off
entry count: 22 | liveTools: []
ENTRY user        "Use the read tool on split-proof.txt and reply with its exact content on one line."
ENTRY assistant   ""
ENTRY toolResult  "oracle backend to local gateway verified"
ENTRY assistant   "oracle backend to local gateway verified"
```

The rendered transcript in the browser shows the same turn: `Process details · 1 message · 1 tool call`, the tool result `oracle backend to local gateway verified`, and the assistant reply `oracle backend to local gateway verified` (usage `140 in · 7 out · 1,536 cache R`). The file content matches the on-disk `/tmp/hepi-split-workspace/split-proof.txt` exactly, so the read really executed in the gateway workspace and not against a local copy.

This is the end-to-end claim: a real browser session on the UI host caused a real model turn on the oracle backend, whose `read` tool call executed in the gateway workspace on this workstation and returned through the backend to the UI.

## Expected non-failures

These are observed, expected limitations of the current read-only adapter, not regressions:

- `GET /api/project-trust` → 501, logged by the UI as "This capability is not connected to the durable server yet". Project trust is a UI-local concept here; the backend has no such state.
- `POST /api/sessions/ui-state` → 501 at the time of this run (`GET` answered 200 with an empty state). This was true of that revision: ticket 01 of the capability-integration effort later made pins, archive, project order and the unread marker one durable document on the backend. Read the paragraph as a dated observation about `78078de`, not as current behaviour.
- `GET /api/git/status` → 502 for this workspace because `/tmp/hepi-split-workspace` is not a Git repository. The adapter surfaces the gateway's failure instead of inventing a clean tree; an empty changed-file list would be a false claim.

None of these blocked the turn.

## Secrets handling

- `backendToken` was read from `/tmp/hepi-split-secrets.json` at run time only and never printed, logged, or written into the repository; it lives in the browser only as an HttpOnly cookie.
- The gateway token is used by the backend over the tunnel and never reaches the browser or the page's network traffic.
- No credential value appears in this document or in any command line recorded here.

## Not claimed

- PTY/terminal and workbench writes remain unsupported by design; this run used the read path only.
- The gateway root is not a Git repository, so Git status/diff behavior in this deployment is unverified beyond the 502 above.
- One model, one workspace, one UI process, and one browser context were exercised. Multi-client concurrency, abort, and reconnection are covered elsewhere (docs/verification.md), not by this run.
