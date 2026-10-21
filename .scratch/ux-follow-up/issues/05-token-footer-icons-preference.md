# 05: 响应页脚 SVG 与浏览器显示开关

**What to build:** 响应页脚使用匹配现有视觉语言的 SVG 和数字；Settings 开关仅控制这些页脚并按浏览器保存。

**Blocked by:** None (can start immediately within the authorized dispatch phase)

**Status:** complete — merged as 0bcd1e0; browser regression and workspace checks re-verified on the merged tree (no human acceptance claimed)

**Dispatch phase:** B — features after 01–04 are verified

**Stories:** 17, 18, 19, 20

- [x] 选择统一笔画/比例的输入、输出、缓存读取图标，实际页脚尺寸下评审明暗主题与窄屏；方向语义与现有总量栏一致。
- [x] 保留数字、本地化 tooltip 及包含指标名称和值的可访问名称；复制外部路径时保存完整许可证和固定来源。
- [x] 默认显示延续既有行为，关闭/开启及刷新恢复均正常；总量显示与后端计费统计保持原行为。
- [x] 通过浏览器偏好与可访问性验证；复用现有存储/订阅及 inline SVG 风格，不新增图标运行库。

**Context:** [Approved spec](../spec.md). Before choosing work, read [dispatch order](../ticket-breakdown.md#dispatch-order). Before selecting SVG paths, read [style brief](../icon-style-notes.md) and [pinned source research](../icon-source-research.md).

## Implementation

- `apps/web/lib/response-usage-visibility.ts`：`pi-response-usage-visible` 浏览器偏好，默认可见，读写
  best-effort（storage 不可用/SSR 时仍显示），`subscribeResponseUsageVisibility` 通知已挂载页脚。
  与 `lib/thinking-expansion-preference.ts` 同一形态。
- `apps/web/components/TokenUsageIcons.tsx`：四个 inline SVG，24 网格、`strokeWidth={1.8}`、11px、
  `currentColor`，与同一行复制按钮一致；输入上箭头、输出下箭头，方向沿用总量栏；缓存读用
  `hard-drive-upload`（箭头向上离开盘，与输入同向）、缓存写用 `hard-drive-download`（箭头向下落到盘，
  与输出同向），两者在 11px 下无需 tooltip 即可分辨。路径逐字取自 lucide `1.54.0`，完整许可证保存在同目录
  `lucide-icons.LICENSE`，来源记录于 `docs/upstream-sources.md`。未新增图标依赖。
- `MessageView.tsx`：`formatUsage` 的纯文本行换成 `ResponseUsage`——每个指标是一个
  `data-token-metric` 容器，含装饰性图标、数字，以及 `sr-only` 的本地化指标名，容器 `title`
  保留本地化名称与数值；费用数值不变。窄屏用 `flexWrap` 换行。
- `SettingsPanel.tsx` General › Chat 增加开关，调用同一偏好模块。总量工具栏、后端计费未改动。

## Red / green evidence

红（`git stash` 还原改动前工作区，保留新测试）：

```
node --test components/MessageView.test.mjs
✖ renders response-footer token metrics as labeled icons beside their numbers
✖ hides response-footer token metrics when this browser turned them off
node --test components/SettingsPanel.response-usage.test.mjs
✖ General chat settings own the response token statistics switch
```

绿（当前分支，同一命令）：MessageView 34/34、response-usage-visibility 4/4、
SettingsPanel.response-usage 1/1。

## Verification seam

`apps/web/e2e/ux-token-footer.mjs`（`pnpm --filter @hepi/web test:token-footer`）用工作区自带 esbuild
打包 fixture（挂载真实 `MessageView`、真实 i18n 与真实偏好模块），在 127.0.0.1:43105 提供临时构建目录，
用已安装 Playwright 读取渲染 DOM、计算样式、可访问名称与真实点击/刷新：

- 四个指标各 11×11、统一 strokeWidth 1.8、颜色取自页脚；数字与本地化指标名成对，tooltip 含名称与数值；
  旧的 `in/out/cache R/cache W` 文本标签不再出现。
- 输入/输出路径方向与总量栏一致；两个缓存指标共用同一盘面轮廓（一个 `rect` + 两个 `h.01` 指示灯），
  但箭头方向不同、字形不同（`hard-drive-upload` vs `hard-drive-download`）。
- 可分辨性检查：在页面内用 canvas 以页脚真实 11px 光栅化两个缓存字形并逐像素比较，明暗两主题均要求两者
  都有墨迹且差异像素超过 12%；放大副本 `token-footer-<theme>-zoom.png` 供人工查看。
- 明暗 × 900/360 四种组合页脚不溢出、无横向滚动；截图写入 `UX05_ARTIFACT_DIR`
  （默认 `/tmp/hepi-ux05-artifacts`，含每主题 8× 放大副本 `token-footer-<theme>-zoom.png` 与候选图标对比
  `icon-candidates-3x.png`）。人工视觉评审由用户进行，本票不声称已通过人工评审。
- 开关默认开；关闭后页脚统计消失而回复文本保留、`localStorage` 记为 false、刷新后仍隐藏且开关状态一致；
  再次打开恢复四项并写回 true。中文下名称与 tooltip 本地化，数字不变。
- 断言总量工具栏仍保留自己的 10 网格 / 1.2 笔画。

候选对比（3×，明暗并排）显示 `database` 在 11px 下三条椭圆带糊在一起，故缓存改用 `hard-drive`；
`database-zap`、`refresh` 因语义（Reload/指标混淆）排除。该对比是证据，不是人工验收。

### Review follow-up: 缓存读/写可分辨

评审指出 `cacheRead 89` 与 `cacheWrite 12` 共用同一 `hard-drive` 剪影，无 tooltip（尤其移动端）时无法区分。
按同一 24 网格 / 1.8 笔画 / `currentColor` / 11px、不新增图标运行库的要求，缓存读改用
`hard-drive-upload`、缓存写改用 `hard-drive-download`：箭头方向沿用输入上 / 输出下的既有语义。
真实尺寸的放大副本为 e2e 写出的 8× 设备像素截图 `token-footer-<theme>-zoom.png`；
`icon-candidates-3x.png` 保留原候选。人工视觉评审仍由用户进行，本票不声称已通过人工评审。

## Commands run

| Check | Command | Result |
| --- | --- | --- |
| Types | `pnpm -r typecheck` | Passed (exit 0), 6/6 packages. |
| Workspace tests | `pnpm -r test` | Passed (exit 0): protocol 10, client 9, session 3, gateway 59, server 83 — 0 fail. |
| Ticket units | `node --test lib/response-usage-visibility.test.mjs components/MessageView.test.mjs components/SettingsPanel.response-usage.test.mjs lib/i18n/registry.test.mjs` | Passed: 42/42. |
| i18n completeness | `node --test lib/i18n/registry.test.mjs` | Passed: 3/3 (new keys present in all three locales with matching placeholders). |
| Browser | `pnpm --filter @hepi/web test:token-footer` | exit 0, "UX-05 BROWSER CHECKS PASSED". |
| Browser, merged tip `0bcd1e0` | `pnpm --filter @hepi/web test:token-footer` | exit 0, "UX-05 BROWSER CHECKS PASSED" — same driver, unpiped, esbuild standalone bundle (no production `.next` built or used). |
| Types, merged tip | `pnpm -r typecheck` | exit 0, 6/6 projects. |
| Workspace tests, merged tip | `pnpm -r test` | exit 0: protocol 10, client 9, session 3, gateway 59, server 83 — 164, 0 fail. |
| Ticket units, merged tip | `node --test lib/response-usage-visibility.test.mjs components/MessageView.test.mjs components/SettingsPanel.response-usage.test.mjs lib/i18n/registry.test.mjs` | exit 0, 42/42. |

Whole-web source-test run keeps its 21 pre-existing failures (2078 tests, 2057 pass; baseline without this change:
2071 tests, 2050 pass, same 21 failures — `components/SettingsPanel.test.mjs` is one of them, because it reads an
absent `app/login/page.tsx`). Those are historical baseline, not reclassified as passing. No production `.next`
was built, no service restarted, no paid provider called.

## Notes / limits

- `SettingsPanel.test.mjs` cannot run in this checkout (missing `app/login/page.tsx`), so the switch wiring is
  asserted by `SettingsPanel.response-usage.test.mjs`; the count expectations in the broken file were still updated
  so it stays correct once that unrelated read is fixed.
- The browser fixture supplies its own `sr-only` rule (Tailwind provides it in the app); the real page is
  unaffected.
- Machine-wide preference persistence, aggregate icon redesign and usage-accounting changes remain out of scope.
