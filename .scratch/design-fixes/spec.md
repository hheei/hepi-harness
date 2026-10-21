# Design review bug fixes

User authorized2026-10-14: fix four material findings in development-audit/design-review.md and explicitly distinguish codebase design causes from ordinary logic bugs before fixing. Existing audit changes remain uncommitted; baseHEAD1758c1f, dirty. No deployment/restart or broad advisory refactor.

## Process and completion

For each: actual caller-Seam red regression, minimal trigger, ranked falsifiable hypotheses (published in parent commentary), evidence-based design/logic/mixed classification, smallest owner fix, green regression and original scenario. Record command/revision+dirty/exit/raw log under.dev/verify/design-fixes. Review public behavior and integration, preserve upstream ownership and existing deepModules. No fake successes or new centralregistries. Keep16currentWeb upstream failures recorded.

## Exclusive ownership

| Finding | Worker | Ownedsource | Classification record |
| --- | --- | --- | --- |
| Foreign Execution Host reaches localMCP | agent19 | durable-api.ts, scopedhost/MCPtests | host/diagnosis.md |
| Rejected snapshot rewinds metadata | agent21 | useAgentSession +lifecycleprojection/acquisition +theirtests | snapshot/diagnosis.md |
| InitialSSHlinkedroot deletion breaksmainlist | agent20 | gatewayworktrees.ts +worktreetests | ssh/diagnosis.md |
| Large accepted text inaccessible in history | agent22 | Backend history/projection/read blocks, protocol, Web text types and backend regression tests | text/diagnosis.md |
| Deferred-text browser recovery | agent25 | MessageView, deferred-text helper/tests, locale labels and React fixture; coordinator owns final browser driver/backend fixture | text/diagnosis.md |

Coordinator owns guides/index/migration, finalverification, onegraphupdate andreview. Shared durable-api.ts edits: hostworker exclusive initially; textworker supplies readblockproxy proposal withouteditingit. Coordinator integrates onlyafterhoststable. useAgentSession belongssnapshotworker; textworker mustpropose anyrequiredhookintegration ratherthaneditit. Allnewprobe names unique.

## Acceptance

- ForeignMCP/project-trust resolve refused withoutlocalhostcalls; local/global stillwork. SameGatewaySSHprofile andsamephysicalpath onotherhost included; remoteWorktree/files unaffected.
- HTTP/SSE ordering treatsmessageprojection andremote metadata underoneacceptance decision. Rejectedframe cannotclearfreshfailure,rewindhistory/leaf/model/queue. Acceptedframes stillapply, transientUI stayslocal.
- SSH mainlist andgone-seed fallback remainusable afterinitiallinkedcheckoutremove; typedfailure onhosterrors, local/dirty/mainprotection unchanged.
- Real0.5/1.5MiB submissions preservefulltext andboundedstate/SSE/olderpage withprogress; textpreview explicitlyrecoverable inuser/assistant/tool text, noautomaticfullfetch. Existingthinking/images/fork-aware reads andProtocolEntry.text consumers preserved. Backendproxy+browsertextrecovery verified; raw-onlypageprogresschecked separately.

## Integration checks

pnpm verify:changed aftersourceintegration; reuseunchangedchecks, focusedrealSSH/hook/HTTP tests. FreshisolatedlocalNextbuild+browserrecovery andpriorSettings smoke. No buildonremote-host. Finaldiff/doclinks/entrypoints andmaterialreview, thenrecordresults. Renderingprefix/perfadvisories remainoutside scope.
