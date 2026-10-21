# 06: 图片提交、SSE 与重启历史

**What to build:** 从浏览器提交的图片以原生内容块到达目标模型，随后在 SSE、重连与重启后的历史中正确恢复。

**Blocked by:** 03: DeepSeek 图片能力元数据正确

**Status:** complete — merged as `0d22103`; browser drivers re-run on the merged tree (no human acceptance claimed).
Dated note: this record names `apps/web/adapters/durable-api.ts` and the Web-adapter prompt route, which
[client-app 17](../../client-app/issues/17-retire-next-and-transition-paths.md) has since deleted; the image path now runs
from the shared UI through the client ingress, and `apps/web/e2e/ux-image-submit.mjs` still drives it.

**Dispatch phase:** B — features after 01–04 are verified

**Stories:** 7, 8, 9

- [x] 使用既有附件与原生图片内容机制接通协议、Web、后端及运行时，受控 provider 收到正确 MIME、图片内容与文本。
- [x] Web origin 上的真实提交成功；HTTP/HTTPS 支持场景均验证实际发送，不仅验证 composer 可编辑。
- [x] SSE 投影、断线重连及 SQLite/后端重启保留图片与文本含义，文本-only 历史和命令兼容。
- [x] 大小与内容校验在浏览器/协议/后端一致，不支持或超限时返回可理解的实际错误，不静默丢图。
- [x] 使用受控 provider 与暂存状态验证；付费真实模型 smoke 仍需后续明确授权。

**Context:** [Approved spec](../spec.md). Before choosing work, read [dispatch order](../ticket-breakdown.md#dispatch-order). For the native runtime/integration contracts, read [framework evidence](../framework-fit.md).

## Comments

**Missing contract report (before any code).** No image framework was added, and none was needed: the runtime already
accepts native image content, and four existing pieces were reused unchanged.

| What was missing | Existing equivalent reused |
| --- | --- |
| The protocol command was text-only, so a browser image had no defined place in a submission. | `pi-ai` `UserMessage.content` already accepts `(TextContent \| ImageContent)[]`; `pi-durable` `SubmissionDraft.input.content` is that same `UserInput`. `SubmitCommand.images` was added as an additive, optional field carrying those exact native blocks. |
| `apps/web/adapters/durable-api.ts` answered `prompt` with images by refusing: "Image input is not connected yet". | The same `/api/agent/:id` prompt route; the images now ride on the `conversation.submit` body it already posts. |
| The backend's `readBody` capped every request at 1 MiB, below one attachment. | The same `readBody`, given an explicit limit for this route. No second body reader. |
| The browser's own limits (`image-attachments.ts`) were not reachable from the command layer, so both sides could disagree. | The same 10 images / 10 MB rule, restated once in `@hepi/protocol` with the byte-length arithmetic; the Web validator now shares `selectImageFiles`. |
| Historical image blocks were already rendered (`MessageView`) but never produced by the Web origin. | The existing `MessageView` image path, unchanged. |
| `crypto.randomUUID` is unavailable in an insecure HTTP context, which is how the deployment is reached off-loopback. | `crypto.getRandomValues`, which every context provides. |

**Implementation.** Protocol (`packages/protocol/src/index.ts`): optional `SubmitCommand.images`, `validateSubmitImages`
with a new `invalid_images` result carrying a readable message, shared `MAX_SUBMISSION_IMAGES`/`MAX_SUBMISSION_IMAGE_BYTES`,
and `MAX_SUBMISSION_BODY_BYTES` derived from them. Backend (`apps/server/src/server.ts`): the messages route reads up to
that body bound, validates images with the command, refuses an image the selected model cannot read
(`unsupported_model_images`) instead of letting the adapter replace it with its placeholder, and submits text-only
submissions in the exact string shape they always had. Web adapter: the prompt case forwards `images` and turns a 400
into a definitive `prompt_rejected` so the composer restores the submission and shows the reason. Composer: every refused
file is named (unsupported / oversized / at most 10); the pre-send warning now says the submission is refused rather than
sent without the image. `createRequestId` gives the composer a submission ID in an insecure context too.

**Verification.** Red first: `packages/protocol/test/submission-images.test.ts` and
`apps/server/test/submission-images.test.ts` failed against the unchanged code (no `images` field; durable entry text-only;
the adapter returned 501). The browser driver failed against the pre-change adapter with
"Image input is not connected yet". Green after the change.

| Boundary | Command | Result |
| --- | --- | --- |
| Protocol limits | `pnpm --filter @hepi/protocol test` | exit 0, 14/14 (image-only accepted, unsupported/oversized/too-many rejected with a message, decoded-byte counting). |
| Backend HTTP + controlled provider | `node apps/server/test/submission-images.test.ts` | exit 0, 5/5 — exact bytes and text at the endpoint, image-only durable entry restored after a restart on the same SQLite file, state event carries the block, text-only submission and commands unchanged, a text-only model refuses without calling the model. |
| Shared Web validation | `node --test apps/web/lib/image-attachments.test.mjs apps/web/lib/i18n/registry.test.mjs apps/web/lib/agent-client.test.mjs apps/web/components/ChatInput.test.mjs apps/web/adapters/durable-api.test.mjs` | exit 0, 54/54. |
| Real browser, real Web origin | `pnpm --filter @hepi/web build` (exit 0) then `pnpm --filter @hepi/web test:image-submit` | **exit 0**, 21 `ok`, "UX-06 image submission checks PASSED". Scenes: insecure HTTP LAN origin (isSecureContext=false) submits an attached real PNG and the controlled endpoint records the exact base64 bytes plus the prompt text; a fresh page restores image and text; a backend restart on the same SQLite file restores both; a local self-signed HTTPS proxy origin (isSecureContext=true) sends the same bytes; a non-image file and a 10 MB+ PNG are named in the visible error and reach no model; a text-only model refuses with the backend's reason in the UI, sends nothing and leaves no submitted image. |

The driver owns a real gateway + backend fixture (`apps/server/scripts/image-submit-fixture.ts`) because a conversation
with no execution host cannot load resources, and the controlled OpenAI-completions endpoint is the only substitution.
No paid provider, no deployment, no live credential; loopback ports 43106/44106 and a temporary worktree build.

Whole-repo: `pnpm -r typecheck` 6/6 exit 0; `pnpm -r test` protocol 14, client 9, session 3, gateway 59, server 88 —
0 fail. Regression on the untouched tickets: `node apps/web/e2e/ux-terminal-close.mjs` 8/8 PASS and
`pnpm --filter @hepi/web test:visible-turns` PASSED. The whole-web source run keeps its documented 21 pre-existing
baseline failures (2076 tests, 2055 pass) and is not claimed as a pass.

**Limits.** A paid/live image smoke remains unauthorized and unimplemented. Only OpenAI-completions image transport
(`image_url` data URL) was exercised; other provider APIs reuse the framework's own conversion and are not covered here.

**Review follow-up (parent-requested).** Two corrections, both test-first:

1. `validateCommand` treated `text: ""` with `images: []` as a valid image-only submission, because the empty list
   made the command skip the text requirement. An empty list is not an image submission: `invalid_text` now applies
   unless at least one image is present. Protocol test "does not treat an empty image list as an image submission"
   (red before the fix) and the backend HTTP test's `{ text: "", images: [] }` → 400 `invalid_text` cover it.
2. The backend's image guard classified a model it cannot resolve as unsupported-for-images, which preempted the
   framework's own `no_model` failure for a conversation whose selection was removed from the catalog (ticket 13).
   The refusal is now limited to a model that exists and declares no image input; a missing selection is admitted,
   the native image content is persisted, the run fails natively (`no_model`) without an assistant reply, and the
   selected reference is preserved. New backend test "a selected model the catalog no longer serves admits the
   submission and fails natively" deletes the provider through the same public `Models` seam the configuration uses,
   asserts the 202 admission, zero model requests, the preserved `settings.model` and the absent assistant entry.
   `settings.model` is now `ModelRef | null` in the snapshot (no fabricated `faux-1` default), and the Web adapter
   omits `state.model` when the selection is null; `apps/web/adapters/durable-api.test.mjs` asserts both.

The `durable-api.ts` prompt path was re-checked and needs no change: it already returns `prompt_rejected` for any
backend 400, which now includes the `invalid_text` empty-list case. The controlled fixture endpoint in
`apps/server/test/submission-images.test.ts` also ignores non-completion traffic, so an unrelated probe on its
ephemeral port can no longer be counted as a model request.

| Check | Command | Result |
| --- | --- | --- |
| Protocol | `pnpm --filter @hepi/protocol test` | exit 0, 15/15. |
| Backend image path | `node apps/server/test/submission-images.test.ts` (25 consecutive runs) | exit 0 every run, 6/6. |
| Web units | `node --test lib/image-attachments.test.mjs lib/i18n/registry.test.mjs lib/agent-client.test.mjs components/ChatInput.test.mjs adapters/durable-api.test.mjs` | exit 0, 55/55. |
| Merged tree | `pnpm -r typecheck`; `pnpm -r test` | exit 0, 6/6; protocol 15, client 9, session 3, gateway 59, server 89 — 0 fail. |
| Browser, real Web origins | `pnpm --filter @hepi/web build` then `pnpm --filter @hepi/web test:image-submit` | **exit 0**, 21 `ok`, unchanged scenes (HTTP insecure, HTTPS, reconnect, restart, refusals). |

Committed as `a1420a4` on `impl/ux-follow-up-06`. No role-hook, queued-model or generation-state machinery was added:
the missing-model behavior is the framework's own failure surfaced through the existing snapshot and events.
