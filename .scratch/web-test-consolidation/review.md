# Test consolidation review

Read-only reviewer50 inspected the completed Settings slice against saved original bytes, then the six critical State suites. Standards and Spec are separate. Product source remains unchanged. Review scope excludes obsolete runtime/bin/proxy behavior intentionally retired by the user-authorized cleanup.

## Standards

Settings: no material findings. State: no material findings. The State inspection confirmed awaited async assertions, fresh VM harnesses, fixture cleanup/cache resets, and coherent contract grouping.

## Spec

Initial Settings inspection found5 material coverage regressions. All were corrected at test owners; focused validation `cd apps/web && node --test --test-reporter=tap lib/subagents.test.mjs lib/mcp-secrets.test.mjs lib/mcp-add.test.mjs lib/mcp-import.test.mjs` exited0. Raw `.dev/verify/web-test-consolidation/settings-review-fixes.log`. Reviewer50 confirmed all five corrections; zero unresolved Standards or Spec findings.

| Finding | Correction |
| --- | --- |
| Extension deny aliases and auto/local scope cases dropped | Restore original scoped/deny/wildcard/uppercase/case-sensitive selector inputs inside the async selector contract |
| URL secret masking lost path/user/signed-query rows | Restore original URL masking inputs in the existing masking contract |
| MCP import filtering/refusals/secret parity checks dropped | Restore foreign-description/provider-auth stripping, management-command rejection with valid server controls, and shared secret-path parity assertions |
| Typed project password refusal dropped | Assert409 secret-global-only with env.GITHUB_TOKEN field, alongside pasted-secret refusal |
| Symlink EPERM skipped unrelated frontmatter cases | Isolate symlink boundary into its own test; frontmatter/alias/malformed-input contract always executes independently |

State: no material assertion weakening or useful input loss in hooks/useAgentSession.lifecycle, lifecycle-projection, deferred-text, transcript-window, scroll-settlement and session-view-cache. Exact hashes match state-verification.json; recorded105pass/0fail/0skip reused.

UI/integration reviewer51 reported no Standards findings and three UI Spec findings: real composer dispatch callbacks replaced by stubs, attachment-preserving user edit row dropped, and expanded Code mode paired failure/newest-call assertions dropped. Restored original callback bodies as awaited rows in the existing slash-command contract; restored original text-plus-image edit and expanded25-call failure fixture in MessageView matrices. Corrected the restored helper import to its actual owner @/lib/mcp-command.ts after the focused run exposed the fixture mistake. Reviewer51 confirmed all three corrections with zero remaining findings; integration had no material findings.

Final unchanged recursive runner:239files461tests461pass0fail0skip, exit0; accepted/web-unit.json. State and integration outcomes unchanged. No unresolved Standards or Spec findings remain. Passing case counts alone do not establish equivalent coverage; reports disclose cuts. Final acceptance belongs to [results.md](results.md).
