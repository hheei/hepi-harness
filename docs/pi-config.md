# Pi Configuration Source

The backend optionally reads compatible Pi configuration using `HEPI_CONFIG_SOURCE=pi`. This is a configuration adapter, not a second agent runtime or full Pi CLI compatibility.

Both configuration modes are served by one kind of authority: a backend-owned `ModelRuntime` over the backend agent
directory's `models.json`. The Settings › Models editor reads and saves that file through the backend
(`GET`/`PUT /api/models-config`); the Web UI process never reads or writes its own host's agent directory. Pi mode
builds the runtime from that directory (including `auth.json`); environment mode builds the same runtime but registers
the deployment's configured provider as an **environment-owned base layer** and keeps credentials in memory. The file
overlays that base layer: a provider definition with the same id wins for the ids it defines, and removing that
definition restores the environment provider rather than deleting it. See [docs/providers.md](providers.md).

## Enable

```bash
HEPI_CONFIG_SOURCE=pi PI_CODING_AGENT_DIR=/absolute/path/to/agent \
  HEPI_AUTH_TOKEN=local-server-token pnpm --filter @hepi/server start
```

The agent directory defaults to `~/.pi/agent` on the **backend host**. `PI_CODING_AGENT_DIR` changes that directory (`~` and `~/…` expand against the backend home directory; a relative value resolves against the backend cwd); it does not select the gateway or UI host's configuration. Unset or `HEPI_CONFIG_SOURCE=env` preserves environment mode and reads no Pi configuration. Unknown sources fail startup.

Pi mode replaces the model registry instead of merging it with the environment-owned OpenAI provider or any other base layer. `HEPI_PROVIDER` and `HEPI_MODEL` may select a model already in the Pi catalog, but must be supplied together. `HEPI_PROVIDER_BASE_URL` and `HEPI_PROVIDER_API_KEY` are rejected; endpoints and credentials belong in Pi configuration. Unknown explicit models and malformed files fail startup instead of falling back to another catalog.

Without that pair the default comes from `settings.json` (`defaultProvider` and `defaultModel` must be set together); with neither, the first authenticated catalog entry is used, matching Pi's own fallback. Environment mode has no equivalent fallback: with no configured provider and no `HEPI_PROVIDER`/`HEPI_MODEL` pair it states no default, and a conversation created before a model is selected settles natively as `no_model` (docs/providers.md).

A valid configuration whose default model is **unavailable or unauthenticated** does not stop the backend: the
`settings.json` reference is preserved, the condition is reported as a startup warning, and the Settings API stays
reachable so the configuration can be corrected. A conversation whose model the catalog no longer offers keeps that
reference and settles its next request natively as `no_model`; it is never silently switched to another model. A
malformed `models.json` or `settings.json` still fails startup, because nothing can be served from a file that does
not parse.

## Supported Inputs

| Input | Behavior |
| --- | --- |
| `models.json` | Upstream model catalog, endpoints, model metadata and overrides. Read and saved by Settings › Models, which is the same file this backend serves from. |
| `auth.json` | Upstream API-key/OAuth credential resolution; no interactive login |
| `settings.json` | User defaults and supported host-wide policies |
| `skills/`, `prompts/*.md`, `skills`, `prompts` | Not applied in production: skills, prompts, context and system prompts are execution-side resources discovered on the conversation's execution host (see below). Reported as ignored paths at startup. |
| Context files | Not read from the backend directory in production: the execution host's own context files load instead. The upstream discovery order this adapter no longer applies is `AGENTS.override.md`, `AGENTS.md`, `AGENTS.MD`, `CLAUDE.md`, `CLAUDE.MD` |
| `SYSTEM.md`, `APPEND_SYSTEM.md` | Not applied in production: the execution host's own system/append prompts are used instead |

The settings adapter forwards default provider/model, default or selected-model thinking level, ordinary compaction thresholds, retry/provider-retry policy, transport, steering and follow-up mode. A thinking level the selected model cannot serve is clamped to one it can; Pi's own fallback when nothing is configured is `medium`. New conversations receive model/thinking defaults; existing conversations keep saved choices. Runtime policies apply host-wide after restart.

Unsupported settings produce a warning listing field names, not values. These include `compaction.modelOverrides`, `thinkingBudgets`, `enabledModels`, tool selection, shell configuration, cache warming, proxy/TUI/display options, analytics/telemetry and Pi session storage. There is no settings hot reload or `/reload` compatibility claim.

## Workspace Resources

Project context files are read from the gateway workspace, from its logical root down to the conversation cwd; this backend keeps every conversation at the workspace root, so that chain is one level in practice. They are never discovered from the backend process cwd. Project `settings.json` is not merged into runtime settings.

Workspace `.pi/SYSTEM.md`, `.pi/APPEND_SYSTEM.md` and `.pi/prompts/` load only when the user settings set `defaultProjectTrust: "always"`. `ask` and `never` skip those resources because this adapter has no interactive project-trust dialog. Context files and `.agents/skills` load independently of this switch. This resource trust setting is not a shell sandbox or tool approval policy.

A trusted workspace system or append file replaces its account counterpart. A trusted workspace prompt wins a
same-name collision with an account prompt, matching upstream Pi's project-local resource precedence.

**The harness agent directory supplies no resources in production.** Every execution-side resource is discovered by the
Workspace Resource Loader on the conversation's execution host and reported under
[execution-side resources](execution-side-skills.md): `skills/`, `prompts/`, `SYSTEM.md`, `APPEND_SYSTEM.md`,
context files and the `skills`/`prompts` path settings therefore have no effect here, and the settings paths are
reported as ignored at startup. The legacy `pi-resources.ts` module and its `pi-resource://`/`read_pi_resource`
surface were removed in ticket 08.

## Excluded

Extensions, Pi packages and MCP are never loaded, installed or connected **by this adapter**. Merely having `extensions/`, package settings or `mcp.json` in the directory does not execute them. The adapter does not create a coding-agent session, spawn the Pi CLI or use Pi session JSONL. The durable Harness remains the only authoritative runtime. No sandbox or per-call tool-approval mode (approve-for-me, ask-for-approval, full-access) is implemented here; tool permissions stay with the gateway capability model (docs/local-integration.md).

MCP is not an exception to that, and it is not this adapter's capability: the Web host's own service owns MCP
configuration, tests and OAuth credentials in that host's account, and reaches it without the backend. A backend
`mcp.json` is still read by nothing. See [MCP on the Web host](mcp-on-the-web-host.md).

## Credential Trust

Pi keys and headers may contain upstream `!command` expressions. Opting in trusts the backend agent directory and the backend environment: those expressions execute with backend permissions, and upstream credential resolution falls back to backend process environment variables and ambient credential files when `auth.json` stores nothing for a provider. Do not point the adapter at an untrusted directory. The upstream credential store creates a missing `auth.json`, takes a lock beside it and rewrites it during OAuth refresh; the agent directory must be writable and restricted to the backend account. This mode is not suitable for a read-only configuration mount without a writable credential directory. The adapter passes an in-memory model store and disables catalog network refresh, so an existing `models-store.json` is ignored, none is created, and `models.json` alone defines the catalog.

`GET /api/models-config` returns the backend's parsed `models.json` (a missing or blank file is `{"providers":{}}`, and
no file is created by reading); an unusable file is reported as unreadable with a fixed message, because the upstream
reader's parse error quotes the file's own bytes. `PUT /api/models-config` validates the candidate on a throwaway
`ModelRuntime` before the real file is touched, so a draft the loader or the provider composer rejects leaves both the
file and the running runtime untouched and answers `400`. On success it writes the file atomically with mode `0600` and
refreshes the live runtime with network access disabled; `{"success":true,"applied":true}` means the running backend
serves the new configuration, and `{"success":true,"applied":false,"error":…}` means the file was written but could not
be applied — the editor shows that as saved-but-not-applied rather than as Saved. There is no queue or lock in front of a
save: each `PUT` writes a complete file through a private temporary file renamed over `models.json`, so the last
completed replacement is what stands on disk and a reader during a write sees the old or the new file, never a partial
one. An ordinary save's refresh is what the running backend then serves. Two overlapping saves can still leave the file
and the live runtime disagreeing, because each refresh is asynchronous: the disk winner is the last completed write,
while the runtime can serve an earlier save's content though both answered `applied:true`. That divergence is a
recorded limitation whose owner is the refresh, not a save queue or lock. Validation skips the create-time refresh, so
a configured `!command` credential reference is never executed by saving. No scheduler, global-idle gate or second
registry is involved: the framework resolves the model reference at each request, so an in-flight request keeps the
endpoint it was prepared with and the change applies from the next request.

`GET /api/models` lists the catalog models whose provider has resolvable credentials and exposes selected public metadata, never credentials, headers or endpoint URLs. Nested values are rebuilt from the allowed `ModelCost` and `ThinkingLevelMap` fields rather than forwarded, because `models.json` passes unknown properties through the upstream schema and provider composer; a key or header smuggled into `cost`, `cost.tiers` or `thinkingLevelMap` therefore never reaches a client.

Credential and configuration failures are sanitized on every surface. Upstream `@earendil-works/pi-ai` (`dist/auth/resolve.js`, `withCauseDetail`) and `@earendil-works/pi-coding-agent` (`dist/core/auth-storage.js`) quote the offending `auth.json`/`models.json` value in the thrown message, and a corrupt `auth.json` surfaces as a bare JSON `SyntaxError` from the credential store. The backend replaces those with fixed text in HTTP 500 bodies, in conversation entries (including `errorMessage` on a failed assistant entry) and in SSE state frames; `GET /api/models` reports the safe text for any failure of its credential resolution. Unrelated errors are not hidden: protocol validation responses, provider messages such as a finish-reason refusal, and ordinary request errors keep their own text. Keep secrets out of logs, issues and version control.

A configured `api` id is treated the same way. `models.json` accepts any string there, so startup succeeds and the value is echoed only when a model call reaches the api registry, which throws `No API provider registered for api: <api>`; `dist/api/lazy.js` copies that into the assistant entry. The backend replaces the message with the same fixed text and reports an `api` that no registered provider claims as `unknown`, in conversation entries and live assistant messages alike. Registered api ids are defined by code or an extension, never by configuration, so a working provider is unaffected.

## Verification

`pnpm -r typecheck` and `pnpm -r test` cover opt-in behavior, defaults/persistence, malformed config, resource discovery, gateway integration and path confinement. A one-off localhost HTTP/SSE smoke verified actual `main.ts` startup, catalog metadata, `auth.json` precedence, configured headers, instruction composition, template expansion and the final streamed response without loading extensions/packages/MCP. It used an isolated fixture provider, not a paid-model compatibility test.
