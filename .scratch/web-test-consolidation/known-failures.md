# Sixteen Web failures — diagnosis, 2026-10-15 UTC

Source: dirty integration/architecture-unification, HEAD1758c1fb4479e9d4637a957857246c5998619d73. Original full suite2381 tests/2365pass/16fail. Focused reproduction from apps/web: node --test --test-reporter=tap over16 explicit files, exit1,20 reported tests/4pass/16fail. Exact invocation: parent session bash39; raw `.dev/verify/web-known-failures/repro.log`. No product edits or production probes needed.

| Group | Original failing files | Root cause | Current owner / disposition |
| --- | --- | --- | --- |
| Old MCP runtime,7 | builtin-extensions, mcp-config-file, mcp-config-read, mcp-host, mcp-sign-in.integration, mcp-sign-in, mcp-test | Imports reach lib/mcp-test.ts:16, importing absent ./model-runtime; crash before assertions | Live adapters/mcp-surface → adapters/mcp-host → gateway /v1/mcp; remove obsolete tests after mapping current coverage |
| Old model catalog,1 | model-catalog-refresh | lib/model-catalog-refresh.ts:2 imports absent @/lib/model-runtime | ModelRuntime/config/credentials backend-owned; old Web runtime not restored |
| Old standalone launcher,5 | node-version, pi-web-node-args, pi-web-options, process-lifecycle, rotate-preview-secrets | Imported apps/web/bin/*.js absent | Web uses next dev/start; installed CLI belongs to packages/client. Old launcher tests obsolete |
| Old Web auth proxy,1 | web-auth-proxy | Imports absent ../proxy.ts | Old PI_WEB_PASSWORD/pi_web_session/Basic Auth differs from current HEPI_AUTH_TOKEN/hepi-web-token catch-all/page auth; retain current route auth tests |
| Undelivered discovery route,1 | model-discovery: asks for a Base URL… | Directly imports absent app/api/models-config/discover/route.ts | Current adapter501 unsupported; retain useful pure-helper cases, replace old route expectation with current capability contract |
| Undelivered API-key route,1 | provider-api-key-route | Reads absent app/api/auth/api-key/[provider]/route.ts | Current adapter501 unsupported; replace old source-shape check with current capability contract |

All16 fail on missing local files/modules, not network timeouts or failed business assertions. Eight share the omitted Web model-runtime dependency; the other eight name five old startup files, one auth proxy, and two route targets. Discovery and credential routes also represent documented feature limits: test cleanup does not implement those features.

Why build/typecheck passed: tsconfig includes app/components/hooks/adapters roots and traverses their imports; it does not independently compile every disconnected lib/*.ts. Recursive Node discovery runs every active *.test.mjs, including disconnected upstream tests. This mismatch explains red tests alongside a successful production build.

Prior summary “16 dormant upstream tests” was incomplete:14 are import-time/file-level failures,2 are individual missing-route cases. User now explicitly prioritized this debt. Before-edit copies: `.dev/verify/web-test-consolidation/before/`; all281 matched completed-source hashes at backup. Worker reports record each disposition and replacement. Vendor reference remains untouched.
