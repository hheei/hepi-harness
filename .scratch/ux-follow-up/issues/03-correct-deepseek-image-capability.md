# 03: DeepSeek 图片能力元数据正确

**What to build:** 模型目录正确声明配置别名下 DeepSeek 的图片能力，现有 provider、endpoint 与凭据来源保持一致。

**Blocked by:** None (can start immediately within the authorized dispatch phase)

**Status:** done

**Dispatch phase:** A — bug fixes (01–04 first)

**Stories:** 6

- [x] 通过真实 Web 模型目录请求看到目标模型支持 image，文本调用仍使用原配置路由。
- [x] 能力来源沿用上游/显式配置数据，其他模型不会因 provider 名称猜测被错误标成图片模型。
- [x] 在现有原生内容接口及受控 provider 上验证图片不被静默降级；本票不宣称浏览器图片传输已接通。

**Context:** [Approved spec](../spec.md). Before choosing work, read [dispatch order](../ticket-breakdown.md#dispatch-order). For the native runtime/integration contracts, read [framework evidence](../framework-fit.md).

## Capability source of truth

Upstream generated catalog `@earendil-works/pi-ai/providers/all` (pi-ai 1.1.0), never the provider id. `HEPI_PROVIDER`
names the endpoint; the model id names the model. Resolution order in `apps/server/src/provider-config.ts`:

1. The configured provider's own catalog entry, when the provider id is itself an upstream provider id — keeps that
   provider's pricing and `compat` as well as its capabilities, and only the `baseUrl` is replaced.
2. Otherwise the facts **every** catalog entry for that model id agrees on: `name`, `reasoning`, `thinkingLevelMap`,
   `input`, `inputLimits`, `contextWindow`, `maxTokens`. Cost and `compat` are provider-specific and are never
   adopted across catalogs. A field the catalogs disagree about stays unknown.
3. Otherwise the unchanged `(unverified)` placeholder.

Evidence: `deepseek-v4.1-flash` has four `openai-completions` entries (opencode, opencode-go, qwen-token-plan,
qwen-token-plan-cn) that agree on `input: ["text","image"]`; `deepseek-v4-pro` is `["text"]` in all seven of its
entries; `zai-org/GLM-5.3` disagrees (Baseten `["text","image"]`, Together/HuggingFace `["text"]`).

## Evidence

Red (before the fix), `apps/server/test/provider-config.test.ts`:

- `the configured alias advertises the upstream image input of its model id`: actual `["text"]`, expected `["text","image"]`.
- `an image content block reaches the configured endpoint as image bytes`: the configured endpoint received
  `{type:"text",text:"(image omitted: model does not support images)"}` instead of the `image_url` data URL — the
  silent downgrade in pi-ai `dist/api/transform-messages.js`.

Green after the fix (`pnpm --filter @hepi/server test`): 75/75 pass, including the 5 new tests. The native seam is
`Models.streamSimple` + `openAICompletionsApi`; the request body is read from a controlled loopback
OpenAI-completions endpoint, so the assertions are on the real wire payload, not on helper output. The image
fixture is a real 1x1 RGBA PNG, and the image test asserts its exact base64 bytes arrive as the `image_url` data
URL. The text-route test settles on the public state snapshot (`busy === false` **and** an assistant entry reading
`ok`) and fails explicitly if that never holds, so an idle snapshot taken before the run starts cannot pass it.

Web origin proof: `pnpm --filter @hepi/server smoke:catalog` (production `next start` on an ephemeral loopback port,
Web `/api/models`, authenticated session, one prompt). Observed `magpie/deepseek-v4.1-flash`
`input: ["text","image"]`, `defaultModel magpie/deepseek-v4.1-flash`, and exactly one request to
`/v1/chat/completions` with `Authorization: Bearer <configured key>` and `model: deepseek-v4.1-flash`.

Regression gate: `pnpm -r typecheck` and `pnpm -r test` (protocol 10, client 9, session 3, gateway 59, server 75)
plus Web `test:upstream` 15/15.

## Not claimed

**Dated note (kept as written, paths since retired).** At this ticket's revision the browser's image transport was
ticket 06's: `apps/web/adapters/durable-api.ts` still answered 501 for a prompt carrying `images`, and the protocol
command was text-only. Both were delivered by [ticket 06](06-image-submission-durable-history.md) — `SubmitCommand` now
carries `images`, the Backend validates them and refuses per model (`unsupported_model_images`), and the whole adapter
directory is gone (retired by [client-app 17](../../client-app/issues/17-retire-next-and-transition-paths.md)). No live
paid DeepSeek request was made then, and none is implied now.
