# Settings test reduction

Coordinator refinement after worker completion: six more dormant tests retired: lib/mcp-add.test.mjs, lib/mcp-transport.test.mjs, lib/provider-usage.test.mjs, lib/subagent-input.test.mjs, lib/subagents.test.mjs and lib/web-push.test.mjs. Static source references confirm the old add implementation/transport factory, provider usage and push publisher, and Web subagent execution/profile implementation are outside current delivered runtime paths (subagent references from active UI are type-only; current provider/push/profile API families return501). Keep the active importer/secret escaping tests, actual composer/producer/host adapter boundaries and Web auth lifecycle. The original worker table and19-contract measurement below are historical before this refinement; final counts/source hashes belong to results.md and the recursive runner. This is deliberate coverage retirement, with no equivalent test replacement claimed for those dormant implementations.

Implemented the second reduction against `.dev/verify/web-test-value/before/`, not HEAD or the earlier consolidation baseline. Only manifest-owned tests changed. No product files, scripts, discovery rules, agent configuration, or graph output changed.

| Measurement | Backed-up baseline | Final | Reduction |
| --- | ---: | ---: | ---: |
| Test files | 37 | 10 | 27 (73.0%) |
| Source bytes | 271,784 | 32,300 | 239,484 (88.1%) |
| Source lines (`splitlines`) | 5,881 | 614 | 5,267 (89.6%) |
| Nonblank source lines excluding standalone `//` comments | 5,266 | 550 | 4,716 (89.6%) |

Actual Node registrations: **19**, below the owned budget of 40. No nested registrations, collectors, skips, filters, exclusions, or empty files. The remaining files contain direct assertions and labelled input tables; real transport connections close in `finally`, filesystem fixtures register cleanup or use `finally`, and asynchronous cases are awaited.

Historical coverage is intentionally cut: SDK CLI/validator parity inventories, configuration format permutations, model settings/catalog algorithms, dormant caches and queues, subagent execution/persistence internals, and display formatting no longer have these Web tests. This does not claim equivalent old coverage or implementation of unserved settings capabilities. Active host-service lifecycle behavior remains the parent integration partition's responsibility; that partition was not changed or run here.

| Original manifest path | Decision | User failure protected / reason retired; replacement owner |
| --- | --- | --- |
| `lib/codemode-settings.test.mjs` | delete | Dormant copied SDK settings persistence/budget/mode permutations; SDK settings owner, no Web replacement. |
| `lib/codemode-view.test.mjs` | delete | Formatting, previews, costs and snapshot extraction inventory; no replacement. |
| `lib/enabled-models-runtime.test.mjs` | delete | Dormant model-settings runtime projection and persistence; SDK/runtime owner. |
| `lib/enabled-models.test.mjs` | delete | Large glob/normalization inventory for copied settings subsystem; SDK settings owner. |
| `lib/mcp-add.test.mjs` | keep | Prevents project typed-secret writes, Web-password references, silent host-variable disclosure and command interpretation; checks successful imports/references and refusal responses. Removed small request-shape/helper inventories. |
| `lib/mcp-command.test.mjs` | delete | Copied command ownership/parser permutations; actual dispatch belongs to active host/composer integration. |
| `lib/mcp-config-key.test.mjs` | delete | Tiny canonical-key/depth helper; no independent high-value Web seam. |
| `lib/mcp-config-values.test.mjs` | delete | Parser parity inventory; real refusal and resolver checks remain in transport and importer integration tests. |
| `lib/mcp-import.integration.test.mjs` | keep | SDK actually resolves foreign commands as inert text without executing a marker command; typed secrets stay literal and explicit references resolve. Retired CLI/validator/quoting parity inventories. |
| `lib/mcp-import.test.mjs` | keep | URL credential extraction/query escaping, management/shell refusal, foreign metadata/provider credential removal, argument/env/path secret identification. Retired CLI/client/deeplink/label/timeout/prefix catalogs. |
| `lib/mcp-read-only-policy.test.mjs` | delete | Tiny copied tool classification helper; execution permissions owned by active host policy integration. |
| `lib/mcp-secrets.test.mjs` | keep | Stops URL userinfo/query/path and argument secrets leaking through display while preserving references/public text. Retired token-brand and syntax inventories. |
| `lib/mcp-server-display.test.mjs` | delete | Quotes, chips, labels and diagnostics formatting; no replacement. |
| `lib/mcp-status.test.mjs` | delete | Dormant copied local MCP status/cache ownership; active gateway/host integration owns live status. |
| `lib/mcp-tool-display.test.mjs` | delete | Label and JSON indentation helper; actual tool/result pairing belongs to parent UI integration. |
| `lib/mcp-transport.test.mjs` | keep | Connects a real stdio fixture and proves Web secrets/runtime env are absent; password references refuse before SDK transport/process creation. Retired SDK option delegation, process-tree and malformed-object inventories. |
| `lib/mcp-undo.test.mjs` | delete | Dormant process-local undo timer/store; no replacement. |
| `lib/model-catalog.test.mjs` | delete | Dormant catalog/pricing consensus algorithm inventory; no Web replacement. |
| `lib/model-discovery.test.mjs` | delete | Copied protocol parsing and URL construction helpers; active discovery/capability contracts integration-owned. |
| `lib/model-scope.test.mjs` | delete | SDK pattern resolution and thinking pins; SDK/runtime owner. |
| `lib/models-cache.test.mjs` | delete | Dormant copied model loader cache; stale reads in active host services belong to integration partition. |
| `lib/node-cli.test.mjs` | delete | SDK executable-layout probing; no Web-owned user seam. |
| `lib/provider-credential-store.test.mjs` | delete | Copied SDK credential storage internals; active authentication integration owns credential operations. |
| `lib/provider-listing.test.mjs` | delete | SDK auth status projection and labels; no replacement. |
| `lib/provider-usage.test.mjs` | keep | Prevents usage credentials going to proxy/lookalike/HTTP origins; retired quota normalization/label inventories. |
| `lib/subagent-extension.integration.test.mjs` | delete | Dormant copied subagent session/runtime feature; active host execution integration owns dispatch. |
| `lib/subagent-extension.test.mjs` | delete | Dormant extension registration, result notifications and run internals; active host lifecycle integration owns current behavior. |
| `lib/subagent-input.test.mjs` | keep | Existing concise smoke protects document preservation, cwd/symlink confinement, UTF-8 and bounded input refusal. |
| `lib/subagent-isolation.test.mjs` | delete | Dormant copied worktree manager; no Web replacement. |
| `lib/subagent-prompt.test.mjs` | delete | Dormant prompt-plan permutations; no replacement. |
| `lib/subagent-queue.test.mjs` | delete | Dormant copied queue; active host queue acceptance/lifecycle integration owns current queues. |
| `lib/subagent-settings.test.mjs` | delete | Dormant built-in feature toggles and settings serialization; no replacement. |
| `lib/subagent-skills.test.mjs` | delete | SDK discovery/diagnostic internals; SDK owner. |
| `lib/subagents.test.mjs` | keep | Scoped extension grants cannot escape alias denies or ambiguous discovery units; profile loader enforces denies; symlinked profile roots cannot read/write/delete outside project. Retired profile formatting/precedence/run persistence inventories. |
| `lib/web-auth-lifecycle.test.mjs` | keep | Existing active route smoke protects cookie gating, login/logout, foreign-origin refusal, cookie attributes and post-logout invalidation. |
| `lib/web-auth.test.mjs` | delete | Old PI_WEB_PASSWORD Basic/signed-session helpers; active HEPI_AUTH_TOKEN route seam covered by web-auth-lifecycle. |
| `lib/web-push.test.mjs` | keep | Completion notification reaches a live subscriber, persists registration, prunes a 410 endpoint, and delivers again; retired locale/title/options/key inventories. |

Verification ran on dirty `integration/architecture-unification`, HEAD `1758c1fb4479e9d4637a957857246c5998619d73` (the machine-recorded SHA is authoritative if the shared branch moves). Exact argv, per-file SHA-256 hashes and dirty file metadata are in `.dev/verify/web-test-value/settings-result.json`; argv alone is in `settings-argv.json`.

- One full focused owned-file run: `node --test` with all 10 explicit retained paths, cwd `apps/web`; actual summary **19 tests, 18 pass, 1 fail, 0 skipped**, exit **1**, raw log `.dev/verify/web-test-value/settings-tests.log`. Failure was the shortened profile fixture missing required `displayName`, before the path boundary could run.
- Fixed that fixture and reran only `node --test lib/subagents.test.mjs`: actual summary **3 tests, 3 pass, 0 fail, 0 skipped**, exit **0**, log `.dev/verify/web-test-value/settings-repair.log`, metadata/hashes/argv `settings-repair.json`.
- Final source verification combines **16 unchanged passing tests** from the full run with **3 passing tests** in the repaired file: **19 passing contracts**. This is reused verification, not a claimed second full run. Parent owns recursive suite acceptance.
- `git diff --check -- apps/web/lib/*test.mjs`: exit **0**. Diff reviewed within the exact owned manifest. HEAD diff includes prior shared consolidation work; the size comparison above uses backed-up bytes exclusively. Per-path measurements and final hashes: `.dev/verify/web-test-value/settings-size.json`.

Parent should migrate any explicit script targets naming the 27 genuinely retired paths above; scripts were left outside worker ownership.

net: -5,267 source lines implemented.
