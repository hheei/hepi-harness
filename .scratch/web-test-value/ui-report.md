# UI second reduction result

Completed UI ownership: **23 actual Node tests, 23 pass, 0 fail/cancelled/skipped/todo**, **10 files**. Budget: 35 tests; target: at most 2,200 lines. No registration collectors, nested subtests, skips, exclusions or filters.

Measured against `.dev/verify/web-test-value/before/` original backed-up bytes, not Git HEAD or the older consolidation source:

| Measure | Original | Final | Reduction |
| --- | ---: | ---: | ---: |
| Files | 49 | 10 | 39 |
| Physical source lines | 7,807 | 864 | 6,943 (88.9%) |
| Lines containing code tokens | 7,131 | 773 | 6,358 (89.2%) |
| Bytes | 362,786 | 42,334 | 320,452 (88.3%) |

Code-token lines use the TypeScript scanner with whitespace/comments excluded, counting each line occupied by a nontrivia token once. This distinguishes code deletion from removed blank lines/comments. Per-file measurements: `.dev/verify/web-test-value/ui-reduction.json`.

Verification ran once after edits stabilized, from `apps/web`, on SHA `1758c1fb4479e9d4637a957857246c5998619d73` with a dirty shared tree at `2026-10-15T03:18:16.196597+00:00`. Exit **0**. Exact argv:

```sh
node --test --test-reporter=tap components/AppShell.session-delete.test.mjs components/AppShell.terminal.test.mjs components/ChatInput.test.mjs components/MessageView.test.mjs components/OAuthPastePanel.test.mjs components/SessionSidebar.marker-effect.test.mjs components/TerminalPanel.test.mjs components/file-tab-state.test.mjs components/mcp-add-helpers.test.mjs components/mcp-sign-in-helpers.test.mjs
```

Raw log: `.dev/verify/web-test-value/ui-tests.log`. Exact argv, start/end, SHA, dirty status, and hashes of retained tests/direct owning source seams: `.dev/verify/web-test-value/ui-tests.json`. Explicit surviving list: `.dev/verify/web-test-value/ui-remaining-files.json`. All recorded source hashes still matched after verification. Owned `git diff --check` exit **0**, recorded in `.dev/verify/web-test-value/ui-diff-check.log`. Node emitted module-type warnings; the run passed. No test reruns were needed.

Only manifest test paths, this report, and `.dev` evidence were changed by this worker. Product source, discovery, scripts, browser/e2e tests, graph and agent configuration were outside worker edits. `SettingsUi.test.mjs`, `SkillsConfig.dormancy.test.mjs`, and `SkillsRetirement.test.mjs` are genuinely retired; parent owns any explicit-target migration. At final inspection, neither root nor Web package.json named these three paths. `test:upstream` still names retained ChatInput/MessageView files.

Each original manifest path follows (relative to `apps/web`):

| Path | Disposition | Failure protected / reason retired; replacement owner |
| --- | --- | --- |
| `components/AgentSessionPanel.test.mjs` | delete | Agent dropdown ordering/status render inventory retired; no replacement. |
| `components/AgentsConfig.test.mjs` | delete | Profile draft/scope helper and source-action inventory retired; no replacement. |
| `components/AnsiText.test.mjs` | delete | ANSI palette/style/escape variant rendering retired; no replacement. |
| `components/AppShell.mobile-toolbar.test.mjs` | delete | Source-only toolbar and dismissal wiring retired; no executed viewport coverage lost from this file. |
| `components/AppShell.session-delete.test.mjs` | merge | Executed delete completion preserves a newly selected chat; active deletion returns to the correct empty composer. Same file; exact ref syntax checks retired. |
| `components/AppShell.terminal.test.mjs` | merge | Restored shells retain identities/selection and reject corrupted stored tabs. Same file; plain independent scopes replace closures. |
| `components/AppShell.workspace-memory.test.mjs` | delete | Context restore/draft movement callback and persistence wiring retired; no equivalent replacement claimed. |
| `components/BranchNavigator.test.mjs` | delete | Branch label/structure helpers and deep-tree/locked-navigation samples retired; no replacement. |
| `components/ChatAppearance.test.mjs` | delete | Low-risk preference defaults/bounds inventory retired; no replacement. |
| `components/ChatInput.test.mjs` | merge | Actual dispatch, built-in ownership/pending lock, IME/completion priorities, image edit/recovery and rekey race remain. Same file; menus, native undo helpers, compression, paste/model formatting and many key variants retired. |
| `components/ChatMinimap.test.mjs` | delete | Heading/math and tool-count rendering inventory retired; no replacement. |
| `components/ChatWindow.extension-request.test.mjs` | delete | Source-only overlay ownership and collapse/waiting wiring retired; no replacement. |
| `components/EnabledModelsSection.test.mjs` | delete | Filtering/toggle helpers, source serialization and unsupported capability assertions retired; no equivalent UI toggle coverage claimed. |
| `components/ExtensionStatusBar.test.mjs` | delete | Status normalization/layout and command-button activation samples retired; no replacement. |
| `components/ExtensionWidgets.test.mjs` | delete | Widget expansion/change helpers and render variants retired; no replacement. |
| `components/ExtensionsConfig.test.mjs` | delete | Selection/group helper and route ownership snapshots retired; no replacement. |
| `components/FileExplorer.linked-directory.test.mjs` | delete | Link disclosure rendering and source-only authorization wiring retired; no replacement in this group. |
| `components/ImagePreview.test.mjs` | delete | Source-only modal/focus/Escape lifecycle smoke retired; MessageView retains image preview affordance rendering only. |
| `components/MarkdownBody.test.mjs` | delete | Markdown/CJK/currency/math/image/URL rendering matrices retired, including UI sanitizer samples; no equivalent renderer coverage claimed. |
| `components/McpConfig.test.mjs` | delete | Large server inventory, controls/refusal/Undo/test/sign-in display matrices retired; no equivalent interactive MCP pane coverage claimed. |
| `components/MermaidBlock.test.mjs` | delete | Diagram/code streaming rendering and SVG download cleanup retired; no replacement. |
| `components/MessageView.test.mjs` | merge | Image-preserving text edits, paired collapsed image/expanded patch failure, Code mode nested failure and provider partial-answer errors remain. Same file; thinking/search/metrics/model/subagent/MCP formatting variants retired. |
| `components/ModelSelector.test.mjs` | delete | Mobile autofocus source policy retired; no replacement. |
| `components/ModelsConfig.test.mjs` | delete | Header/cost/rename helpers and save wiring retired; no equivalent model editor coverage claimed. |
| `components/NewSessionContextBar.test.mjs` | delete | Project/worktree control rendering and focus source smoke retired; no replacement. |
| `components/OAuthPastePanel.test.mjs` | keep | Empty/pending submissions stay disabled and IME cannot submit an authorization paste. Same file; unrelated ModelsConfig source check removed. |
| `components/ProjectRemovalMenu.test.mjs` | delete | Rendered replacement-default/refusal gating retired; no equivalent removal-flow coverage claimed. |
| `components/ProjectTrustDialog.test.mjs` | delete | Disclosure, response decoding and source-only focus/abort/no-write checks retired; no equivalent dialog lifecycle coverage claimed. |
| `components/ProjectWorktreePicker.test.mjs` | delete | Picker/removal renders and source-only stale menu/routing checks retired; no equivalent picker behavior coverage claimed. |
| `components/SessionSearch.test.mjs` | delete | Search rendering/gating and result/refusal wiring snapshots retired; no replacement. |
| `components/SessionSidebar.marker-effect.test.mjs` | keep | Executed owning effects and real shared reducer retain unread completion across queued runs/refresh, avoid duplicate writes and clear on open. Same file unchanged. |
| `components/SessionSidebar.test.mjs` | delete | Broad deletion/polling/activity/identity/rename source inventory retired; AppShell.session-delete owns executed post-delete navigation only. |
| `components/SessionTree.test.mjs` | delete | Row state/action render matrices, viewport window/reveal samples and source focus/IME wiring retired; browser window/history checks remain separate evidence. |
| `components/SettingsPanel.test.mjs` | delete | Source-only settings destination/mount/focus/trust propagation matrix retired; no replacement. |
| `components/SettingsUi.test.mjs` | delete | Shared control rendering matrix retired; no replacement. Former explicit script target is retired. |
| `components/SidebarMenu.test.mjs` | delete | Menu render/placement/filter helpers and source-only focus/keyboard wiring retired; no replacement. |
| `components/SidebarToast.test.mjs` | delete | Live-region rendering and source-only pause/action wiring retired; no replacement. |
| `components/SkillsConfig.dormancy.test.mjs` | delete | Low-risk active-before-dormant sort smoke retired; no replacement. Former explicit script target is retired. |
| `components/SkillsRetirement.test.mjs` | delete | Retired Market/settings source wiring smoke retired; no replacement. Former explicit script target is retired. |
| `components/TerminalPanel.test.mjs` | merge | Cwd/diagnostic requests, ordered slow writes/resize/batching, bounded Unicode and no retry after failed/stopped delivery remain; same file, with cleanup on failed assertions. |
| `components/ToolDefinitionsPanel.test.mjs` | delete | Source-only schema inspection/layout smoke retired; no replacement. |
| `components/TurnWrittenFiles.test.mjs` | delete | Low-risk filename/button and empty rendering matrix retired; no replacement. |
| `components/file-tab-state.test.mjs` | merge | Source-session remount, same-source stability, diff/PDF navigation and revision-fenced stale cleanup remain; same file, plain scopes replace closures. |
| `components/mcp-add-helpers.test.mjs` | merge | Project literal-secret refusal, credential-masked previews and honest shell command disclosure remain; same file. Import-format/locale/prose/name variants retired. |
| `components/mcp-config-helpers.test.mjs` | delete | Large state/trust/exposure/request/group helper matrices retired; no equivalent helper coverage claimed. Focused add/sign-in boundaries remain in their own files. |
| `components/mcp-sign-in-helpers.test.mjs` | merge | Untrusted project/web-password refusal, safe authorization schemes and redirect refusal/expiry transitions remain; same file. Outcome prose/tones, shared identity and HTTP wrapper samples retired. |
| `components/session-catalog-helpers.test.mjs` | delete | Small catalog merge/title/metadata helpers retired; no replacement. |
| `components/settings-capabilities.test.mjs` | delete | Notice classification helper inventory retired; no replacement. |
| `components/settings-ui-helpers.test.mjs` | delete | Group switch/count/reason helper inventory retired; no replacement. |

These are real contract cuts, not equivalent historical coverage. The smaller suite prioritizes composer dispatch/recovery, paired failure/image output, unread lifecycle, stale file snapshots, terminal identity and ordered delivery, plus focused credential/trust boundaries. Deferred thinking/search highlighting, branch/model/settings/menu helper variants, detailed disclosure renderers, and several source-only lifecycle checks are intentionally retired. The retained callbacks execute extracted production bodies with controlled context; they do not mount React or prove browser focus/layout. Existing real-app window/history browser checks remain unchanged and were not rerun by this worker. Parent owns the global recursive suite and integration review; this focused run alone does not establish the global count.

net: -6,943 physical lines; -6,358 code-token lines.
