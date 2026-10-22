# Source navigation

Parent graph queries, 2026-10-21. Locations require source confirmation; broad/truncated neighbors are navigation only.

## 1

```text
Graph: graphify-out/graph.json (15488 nodes) | Traversal: BFS depth=2 | Start: ['createBackendServer()', 'handle()'] | 1697 nodes found

[!] TRUNCATED: showing 25 of 1697 nodes (~1000-token budget). The answer may be among the 1672 cut nodes — raise the token budget (CLI: --budget) or narrow the query (e.g. context_filter=['call'], or get_node for a specific symbol).

NODE createBackendServer() [src=apps/server/src/server.ts loc=L897 community=createBackendServer]
NODE handle() [src=apps/server/src/server.ts loc=L1885 community=server.ts]
NODE server.ts [src=apps/server/src/server.ts loc=L1 community=server.ts]
NODE openServerHarness() [src=apps/server/src/harness.ts loc=L86 community=createBackendServer]
NODE mcp-conversation-tools.test.ts [src=apps/server/test/mcp-conversation-tools.test.ts loc=L1 community=mcp-conversation-tools.test.ts]
NODE conversation-navigation.test.ts [src=apps/server/test/conversation-navigation.test.ts loc=L1 community=conversation-navigation.test.ts]
NODE subagents.test.ts [src=apps/server/test/subagents.test.ts loc=L1 community=subagents.test.ts]
NODE ingress-catalogue.test.ts [src=packages/gateway/test/ingress-catalogue.test.ts loc=L1 community=ingress-catalogue.test.ts]
NODE ingress-resources-install.test.ts [src=packages/gateway/test/ingress-resources-install.test.ts loc=L1 community=WorkspaceRegistry]
NODE skills-ui-smoke.ts [src=apps/server/scripts/skills-ui-smoke.ts loc=L1 community=skills-ui-smoke.ts]
NODE ssh-project.test.ts [src=apps/server/test/ssh-project.test.ts loc=L1 community=ingress-catalogue.test.ts]
NODE perf-history-scaling.ts [src=apps/server/scripts/perf-history-scaling.ts loc=L1 community=perf-history-scaling.ts]
NODE ingress-ssh-workbench.test.ts [src=packages/gateway/test/ingress-ssh-workbench.test.ts loc=L1 community=WorkspaceRegistry]
NODE subtree-control-projection.test.ts [src=apps/server/test/subtree-control-projection.test.ts loc=L1 community=subtree-control-projection.test.ts]
NODE workspace-resources.test.ts [src=apps/server/test/workspace-resources.test.ts loc=L1 community=workspace-resources.ts]
NODE ingress-control.test.ts [src=packages/gateway/test/ingress-control.test.ts loc=L1 community=ingress/index.ts]
NODE project.test.ts [src=apps/server/test/project.test.ts loc=L1 community=ingress-catalogue.test.ts]
NODE ingress-mcp.test.ts [src=packages/gateway/test/ingress-mcp.test.ts loc=L1 community=ingress/index.ts]
NODE catalogue-binding.test.ts [src=apps/server/test/catalogue-binding.test.ts loc=L1 community=ingress-catalogue.test.ts]
NODE ingress-resources.test.ts [src=packages/gateway/test/ingress-resources.test.ts loc=L1 community=ingress/index.ts]
NODE conversation-api.http.test.ts [src=packages/ui/src/lib/conversation-api.http.test.ts loc=L1 community=ingress/index.ts]
NODE workspace-api.http.test.ts [src=packages/ui/src/lib/workspace-api.http.test.ts loc=L1 community=ingress/index.ts]
NODE subtree-control-acceptance.test.ts [src=apps/server/test/subtree-control-acceptance.test.ts loc=L1 community=subtree-control-acceptance.test.ts]
NODE terminal-transcript.test.ts [src=apps/server/test/terminal-transcript.test.ts loc=L1 community=WorkspaceRegistry]
NODE subagent-acceptance-fixture.ts [src=apps/server/scripts/subagent-acceptance-fixture.ts loc=L1 community=subagents.test.ts]
... (truncated — 1672 more nodes cut by ~1000-token budget. Narrow with context_filter=['call'] or use get_node for a specific symbol)
```

## 2

```text
Graph: graphify-out/graph.json (15488 nodes) | Traversal: BFS depth=2 | Start: ['CatalogueBinding', 'store', 'store()', 'PROJECT'] | 73 nodes found

[!] TRUNCATED: showing 29 of 73 nodes (~1000-token budget). The answer may be among the 44 cut nodes — raise the token budget (CLI: --budget) or narrow the query (e.g. context_filter=['call'], or get_node for a specific symbol).

NODE CatalogueBinding [src=apps/server/src/catalogue-binding.ts loc=L44 community=server.ts]
NODE store [src=apps/web/e2e/mcp-skills/ux-mcp-tool-states.fixture.tsx loc=L87 community=ux-mcp-tool-states.fixture.tsx]
NODE store() [src=apps/server/test/delta-frames.test.ts loc=L27 community=createBackendServer]
NODE PROJECT [src=apps/web/e2e/mcp-skills/ux-skills-project-target.fixture.tsx loc=L20 community=ux-extensions-panel.fixture.tsx]
NODE server.ts [src=apps/server/src/server.ts loc=L1 community=server.ts]
NODE ux-mcp-tool-states.fixture.tsx [src=apps/web/e2e/mcp-skills/ux-mcp-tool-states.fixture.tsx loc=L1 community=ux-mcp-tool-states.fixture.tsx]
NODE ux-skills-project-target.fixture.tsx [src=apps/web/e2e/mcp-skills/ux-skills-project-target.fixture.tsx loc=L1 community=ux-extensions-panel.fixture.tsx]
NODE delta-frames.test.ts [src=apps/server/test/delta-frames.test.ts loc=L1 community=createBackendServer]
NODE catalogue-binding.ts [src=apps/server/src/catalogue-binding.ts loc=L1 community=server.ts]
NODE createBackendServer() [src=apps/server/src/server.ts loc=L897 community=createBackendServer]
NODE useI18n.tsx [src=packages/ui/src/hooks/useI18n.tsx loc=L1 community=useI18n.tsx]
NODE faux-fixture.ts [src=apps/server/test/faux-fixture.ts loc=L1 community=createBackendServer]
NODE SkillsConfig.tsx [src=packages/ui/src/components/SkillsConfig.tsx loc=L1 community=SkillsConfig.tsx]
NODE SERVER_MODEL [src=apps/server/test/faux-fixture.ts loc=L10 community=createBackendServer]
NODE workbench-scope.ts [src=packages/ui/src/lib/workbench-scope.ts loc=L1 community=SkillsConfig.tsx]
NODE fauxModels() [src=apps/server/test/faux-fixture.ts loc=L29 community=createBackendServer]
NODE openServerHarness() [src=apps/server/src/harness.ts loc=L86 community=createBackendServer]
NODE directory() [src=apps/server/test/acceptance-recovery.test.ts loc=L101 community=createBackendServer]
NODE ui/src/client.ts [src=packages/ui/src/client.ts loc=L1 community=ui/src/client.ts]
NODE BackendServer [src=apps/server/src/server.ts loc=L66 community=createBackendServer]
NODE harness.ts [src=apps/server/src/harness.ts loc=L1 community=createBackendServer]
NODE ExtensionsConfig.tsx [src=packages/ui/src/components/ExtensionsConfig.tsx loc=L1 community=AgentsConfig.tsx]
NODE createClient() [src=packages/ui/src/client.ts loc=L167 community=workbench.tsx]
NODE workbenchConnection [src=packages/ui/src/lib/workbench-scope.ts loc=L59 community=workbench.tsx]
NODE I18nProvider() [src=packages/ui/src/hooks/useI18n.tsx loc=L42 community=useI18n.tsx]
NODE project-store.ts [src=apps/server/src/project-store.ts loc=L1 community=ingress-catalogue.test.ts]
NODE SkillsConfig() [src=packages/ui/src/components/SkillsConfig.tsx loc=L600 community=SkillsConfig.tsx]
NODE WorkbenchConnectionProvider [src=packages/ui/src/lib/workbench-scope.ts loc=L72 community=ux-extensions-panel.fixture.tsx]
NODE ServerSnapshot [src=apps/server/src/server.ts loc=L64 community=streamFolder]
... (truncated — 44 more nodes cut by ~1000-token budget. Narrow with context_filter=['call'] or use get_node for a specific symbol)
```

## 3

```text
Graph: graphify-out/graph.json (15488 nodes) | Traversal: BFS depth=2 | Start: ['GatewayRpcServer'] | 1087 nodes found

[!] TRUNCATED: showing 27 of 1087 nodes (~1000-token budget). The answer may be among the 1060 cut nodes — raise the token budget (CLI: --budget) or narrow the query (e.g. context_filter=['call'], or get_node for a specific symbol).

NODE GatewayRpcServer [src=packages/gateway/src/index.ts loc=L503 community=WorkspaceRegistry]
NODE gateway/src/index.ts [src=packages/gateway/src/index.ts loc=L1 community=gateway/src/index.ts]
NODE mcp-conversation-tools.test.ts [src=apps/server/test/mcp-conversation-tools.test.ts loc=L1 community=mcp-conversation-tools.test.ts]
NODE startup.ts [src=packages/gateway/src/startup.ts loc=L1 community=WorkspaceRegistry]
NODE subagents.test.ts [src=apps/server/test/subagents.test.ts loc=L1 community=subagents.test.ts]
NODE ingress-catalogue.test.ts [src=packages/gateway/test/ingress-catalogue.test.ts loc=L1 community=ingress-catalogue.test.ts]
NODE ingress-resources-install.test.ts [src=packages/gateway/test/ingress-resources-install.test.ts loc=L1 community=WorkspaceRegistry]
NODE skills-ui-smoke.ts [src=apps/server/scripts/skills-ui-smoke.ts loc=L1 community=skills-ui-smoke.ts]
NODE GatewayFiles [src=packages/gateway/src/filesystem.ts loc=L55 community=WorkspaceRegistry]
NODE ssh-project.test.ts [src=apps/server/test/ssh-project.test.ts loc=L1 community=ingress-catalogue.test.ts]
NODE .close() [src=packages/gateway/src/index.ts loc=L1018 community=WorkspaceRegistry]
NODE ingress-ssh-workbench.test.ts [src=packages/gateway/test/ingress-ssh-workbench.test.ts loc=L1 community=WorkspaceRegistry]
NODE subtree-control-projection.test.ts [src=apps/server/test/subtree-control-projection.test.ts loc=L1 community=subtree-control-projection.test.ts]
NODE workspace-resources.test.ts [src=apps/server/test/workspace-resources.test.ts loc=L1 community=workspace-resources.ts]
NODE ingress-control.test.ts [src=packages/gateway/test/ingress-control.test.ts loc=L1 community=ingress/index.ts]
NODE project.test.ts [src=apps/server/test/project.test.ts loc=L1 community=ingress-catalogue.test.ts]
NODE ingress-mcp.test.ts [src=packages/gateway/test/ingress-mcp.test.ts loc=L1 community=ingress/index.ts]
NODE subagents-crash-harness.ts [src=apps/server/test/subagents-crash-harness.ts loc=L1 community=subagents.test.ts]
NODE ProviderLoginService [src=packages/gateway/src/provider-login.ts loc=L115 community=src/provider-login.ts]
NODE startGateway() [src=packages/gateway/src/startup.ts loc=L164 community=WorkspaceRegistry]
NODE file-transfer.test.ts [src=packages/gateway/test/file-transfer.test.ts loc=L1 community=WorkspaceRegistry]
NODE catalogue-binding.test.ts [src=apps/server/test/catalogue-binding.test.ts loc=L1 community=ingress-catalogue.test.ts]
NODE terminal.test.ts [src=packages/gateway/test/terminal.test.ts loc=L1 community=terminal.test.ts]
NODE McpHostService [src=packages/gateway/src/mcp/host.ts loc=L104 community=gateway.ts]
NODE TerminalSessions [src=packages/gateway/src/terminal.ts loc=L547 community=WorkspaceRegistry]
NODE workspace-api.http.test.ts [src=packages/ui/src/lib/workspace-api.http.test.ts loc=L1 community=ingress/index.ts]
NODE ssh-workbench.test.ts [src=packages/gateway/test/ssh-workbench.test.ts loc=L1 community=WorkspaceRegistry]
... (truncated — 1060 more nodes cut by ~1000-token budget. Narrow with context_filter=['call'] or use get_node for a specific symbol)
```

## 4

```text
Graph: graphify-out/graph.json (15488 nodes) | Traversal: BFS depth=2 | Start: ['LocalFilesystem', 'SshFilesystem'] | 586 nodes found

[!] TRUNCATED: showing 27 of 586 nodes (~1000-token budget). The answer may be among the 559 cut nodes — raise the token budget (CLI: --budget) or narrow the query (e.g. context_filter=['call'], or get_node for a specific symbol).

NODE LocalFilesystem [src=packages/gateway/src/filesystem.ts loc=L312 community=WorkspaceRegistry]
NODE SshFilesystem [src=packages/gateway/src/ssh-filesystem.ts loc=L361 community=WorkspaceRegistry]
NODE WorkspaceRegistry [src=packages/gateway/src/workspaces.ts loc=L22 community=WorkspaceRegistry]
NODE filesystem.ts [src=packages/gateway/src/filesystem.ts loc=L1 community=filesystem.ts]
NODE ssh-filesystem.ts [src=packages/gateway/src/ssh-filesystem.ts loc=L1 community=filesystem.ts]
NODE startup.ts [src=packages/gateway/src/startup.ts loc=L1 community=WorkspaceRegistry]
NODE subagents.test.ts [src=apps/server/test/subagents.test.ts loc=L1 community=subagents.test.ts]
NODE ingress-catalogue.test.ts [src=packages/gateway/test/ingress-catalogue.test.ts loc=L1 community=ingress-catalogue.test.ts]
NODE ingress-resources-install.test.ts [src=packages/gateway/test/ingress-resources-install.test.ts loc=L1 community=WorkspaceRegistry]
NODE skills-ui-smoke.ts [src=apps/server/scripts/skills-ui-smoke.ts loc=L1 community=skills-ui-smoke.ts]
NODE ssh-project.test.ts [src=apps/server/test/ssh-project.test.ts loc=L1 community=ingress-catalogue.test.ts]
NODE ingress-ssh-workbench.test.ts [src=packages/gateway/test/ingress-ssh-workbench.test.ts loc=L1 community=WorkspaceRegistry]
NODE project.test.ts [src=apps/server/test/project.test.ts loc=L1 community=ingress-catalogue.test.ts]
NODE SshProfile [src=packages/gateway/src/index.ts loc=L141 community=filesystem.ts]
NODE ingress-mcp.test.ts [src=packages/gateway/test/ingress-mcp.test.ts loc=L1 community=ingress/index.ts]
NODE startGateway() [src=packages/gateway/src/startup.ts loc=L164 community=WorkspaceRegistry]
NODE file-transfer.test.ts [src=packages/gateway/test/file-transfer.test.ts loc=L1 community=WorkspaceRegistry]
NODE catalogue-binding.test.ts [src=apps/server/test/catalogue-binding.test.ts loc=L1 community=ingress-catalogue.test.ts]
NODE workspace-api.http.test.ts [src=packages/ui/src/lib/workspace-api.http.test.ts loc=L1 community=ingress/index.ts]
NODE ssh-workbench.test.ts [src=packages/gateway/test/ssh-workbench.test.ts loc=L1 community=WorkspaceRegistry]
NODE worktree-picker.test.ts [src=apps/server/test/worktree-picker.test.ts loc=L1 community=ingress-catalogue.test.ts]
NODE ingress-files.test.ts [src=packages/gateway/test/ingress-files.test.ts loc=L1 community=ingress/index.ts]
NODE ingress-providers.test.ts [src=packages/gateway/test/ingress-providers.test.ts loc=L1 community=ingress/index.ts]
NODE file-transfer-evidence.ts [src=packages/gateway/test/file-transfer-evidence.ts loc=L1 community=ingress/index.ts]
NODE SshRunner [src=packages/gateway/src/runner.ts loc=L44 community=WorkspaceRegistry]
NODE mcp-list-tools.test.ts [src=packages/gateway/test/mcp-list-tools.test.ts loc=L1 community=WorkspaceRegistry]
NODE test/provider-login.test.ts [src=packages/gateway/test/provider-login.test.ts loc=L1 community=WorkspaceRegistry]
... (truncated — 559 more nodes cut by ~1000-token budget. Narrow with context_filter=['call'] or use get_node for a specific symbol)
```

## 5

```text
Graph: graphify-out/graph.json (15488 nodes) | Traversal: BFS depth=2 | Start: ['servesFolder()', 'createClientIngress()'] | 397 nodes found

[!] TRUNCATED: showing 26 of 397 nodes (~1000-token budget). The answer may be among the 371 cut nodes — raise the token budget (CLI: --budget) or narrow the query (e.g. context_filter=['call'], or get_node for a specific symbol).

NODE servesFolder() [src=packages/gateway/src/ingress/index.ts loc=L316 community=ingress/index.ts]
NODE createClientIngress() [src=packages/gateway/src/ingress/index.ts loc=L209 community=ingress/index.ts]
NODE ingress/index.ts [src=packages/gateway/src/ingress/index.ts loc=L1 community=ingress/index.ts]
NODE ingress-catalogue.test.ts [src=packages/gateway/test/ingress-catalogue.test.ts loc=L1 community=ingress-catalogue.test.ts]
NODE ingress-resources-install.test.ts [src=packages/gateway/test/ingress-resources-install.test.ts loc=L1 community=WorkspaceRegistry]
NODE ingress-ssh-workbench.test.ts [src=packages/gateway/test/ingress-ssh-workbench.test.ts loc=L1 community=WorkspaceRegistry]
NODE ingress-control.test.ts [src=packages/gateway/test/ingress-control.test.ts loc=L1 community=ingress/index.ts]
NODE ingress-mcp.test.ts [src=packages/gateway/test/ingress-mcp.test.ts loc=L1 community=ingress/index.ts]
NODE ingress-resources.test.ts [src=packages/gateway/test/ingress-resources.test.ts loc=L1 community=ingress/index.ts]
NODE conversation-api.http.test.ts [src=packages/ui/src/lib/conversation-api.http.test.ts loc=L1 community=ingress/index.ts]
NODE workspace-api.http.test.ts [src=packages/ui/src/lib/workspace-api.http.test.ts loc=L1 community=ingress/index.ts]
NODE ingress-files.test.ts [src=packages/gateway/test/ingress-files.test.ts loc=L1 community=ingress/index.ts]
NODE ingress-navigation.test.ts [src=packages/gateway/test/ingress-navigation.test.ts loc=L1 community=createBackendServer]
NODE ingress-providers.test.ts [src=packages/gateway/test/ingress-providers.test.ts loc=L1 community=ingress/index.ts]
NODE ingress-conversation.test.ts [src=packages/gateway/test/ingress-conversation.test.ts loc=L1 community=createBackendServer]
NODE file-transfer-evidence.ts [src=packages/gateway/test/file-transfer-evidence.ts loc=L1 community=ingress/index.ts]
NODE createFileSurface() [src=packages/gateway/src/files-surface.ts loc=L164 community=createFileSurface]
NODE ingress-terminal.test.ts [src=packages/gateway/test/ingress-terminal.test.ts loc=L1 community=ingress/index.ts]
NODE ingress.test.ts [src=packages/gateway/test/ingress.test.ts loc=L1 community=ingress/index.ts]
NODE Fixture [src=packages/gateway/test/ingress-resources-install.test.ts loc=L48 community=WorkspaceRegistry]
NODE history-navigation-acceptance-fixture.ts [src=apps/server/scripts/history-navigation-acceptance-fixture.ts loc=L1 community=subagents.test.ts]
NODE handle() [src=packages/gateway/src/ingress/index.ts loc=L363 community=ingress/index.ts]
NODE Fixture [src=packages/gateway/test/ingress-catalogue.test.ts loc=L50 community=WorkspaceRegistry]
NODE settings.test.ts [src=packages/gateway/test/settings.test.ts loc=L1 community=ingress/index.ts]
NODE Fixture [src=packages/gateway/test/ingress-ssh-workbench.test.ts loc=L88 community=WorkspaceRegistry]
NODE Fixture [src=packages/ui/src/lib/workspace-api.http.test.ts loc=L46 community=WorkspaceRegistry]
... (truncated — 371 more nodes cut by ~1000-token budget. Narrow with context_filter=['call'] or use get_node for a specific symbol)
```

## 6

```text
Graph: graphify-out/graph.json (15488 nodes) | Traversal: BFS depth=2 | Start: ['verify-artifacts.mjs', 'artifacts', 'verify()'] | 109 nodes found

[!] TRUNCATED: showing 31 of 109 nodes (~1000-token budget). The answer may be among the 78 cut nodes — raise the token budget (CLI: --budget) or narrow the query (e.g. context_filter=['call'], or get_node for a specific symbol).

NODE verify-artifacts.mjs [src=apps/app/scripts/verify-artifacts.mjs loc=L1 community=verify-artifacts.mjs]
NODE artifacts [src=apps/app/package.json loc=L14 community=app/package.json]
NODE verify() [src=scripts/verify.mjs loc=L60 community=verify.mjs]
NODE verify.mjs [src=scripts/verify.mjs loc=L1 community=verify.mjs]
NODE credential-sandbox.mjs [src=scripts/lib/credential-sandbox.mjs loc=L1 community=credential-sandbox.mjs]
NODE offline-install.mjs [src=apps/app/scripts/offline-install.mjs loc=L1 community=verify-artifacts.mjs]
NODE changedChecks() [src=scripts/lib/changed-checks.mjs loc=L99 community=verify.mjs]
NODE profileSteps() [src=scripts/lib/presets.mjs loc=L48 community=verify.mjs]
NODE scripts [src=apps/app/package.json loc=L7 community=app/package.json]
NODE gitState() [src=scripts/lib/cli.mjs loc=L36 community=cli.mjs]
NODE startCredentialSandbox() [src=scripts/lib/credential-sandbox.mjs loc=L259 community=credential-sandbox.mjs]
NODE runOfflineInstall() [src=apps/app/scripts/offline-install.mjs loc=L130 community=verify-artifacts.mjs]
NODE main() [src=scripts/verify.mjs loc=L90 community=verify.mjs]
NODE runDir() [src=scripts/lib/cli.mjs loc=L249 community=cli.mjs]
NODE run [src=apps/app/scripts/verify-artifacts.mjs loc=L41 community=verify-artifacts.mjs]
NODE packagedEnvironment() [src=scripts/lib/credential-sandbox.mjs loc=L103 community=verify-artifacts.mjs]
NODE findWindow() [src=apps/app/scripts/verify-artifacts.mjs loc=L205 community=verify-artifacts.mjs]
NODE CONNECTION_ATTRIBUTES [src=scripts/lib/credential-sandbox.mjs loc=L38 community=credential-sandbox.mjs]
NODE loginKeyringDigest() [src=scripts/lib/credential-sandbox.mjs loc=L123 community=credential-sandbox.mjs]
NODE runProfile() [src=scripts/verify.mjs loc=L50 community=verify.mjs]
NODE cleanupInstallRoot() [src=apps/app/scripts/offline-install.mjs loc=L158 community=verify-artifacts.mjs]
NODE installSupport() [src=apps/app/scripts/offline-install.mjs loc=L51 community=verify-artifacts.mjs]
NODE packagedEnv() [src=apps/app/scripts/verify-artifacts.mjs loc=L365 community=verify-artifacts.mjs]
NODE pressPrimaryAction() [src=apps/app/scripts/verify-artifacts.mjs loc=L251 community=verify-artifacts.mjs]
NODE typeFirstRunForm() [src=apps/app/scripts/verify-artifacts.mjs loc=L224 community=verify-artifacts.mjs]
NODE capture() [src=apps/app/scripts/verify-artifacts.mjs loc=L71 community=verify-artifacts.mjs]
NODE launch() [src=apps/app/scripts/verify-artifacts.mjs loc=L265 community=verify-artifacts.mjs]
NODE startDisplay() [src=apps/app/scripts/verify-artifacts.mjs loc=L184 community=verify-artifacts.mjs]
NODE arg() [src=apps/app/scripts/verify-artifacts.mjs loc=L45 community=verify-artifacts.mjs]
NODE args [src=apps/app/scripts/verify-artifacts.mjs loc=L44 community=verify-artifacts.mjs]
NODE artifactDir [src=apps/app/scripts/verify-artifacts.mjs loc=L48 community=verify-artifacts.mjs]
... (truncated — 78 more nodes cut by ~1000-token budget. Narrow with context_filter=['call'] or use get_node for a specific symbol)
```
