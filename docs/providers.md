# Backend provider configuration

The backend owns model access. A browser client picks from `GET /api/models` and every model request is made by the
backend process; browser clients never send a provider endpoint or a provider key there.

The one credential path that does involve the browser is separate from the backend's registry: a provider key or OAuth
sign-in a person enters in Settings goes to the **client ingress**, which hands it to the gateway on that same Web host
(`POST /v1/providers/auth`, `/api/auth/login/:id`). The gateway writes that host account's own `auth.json`; the
provider-management request is **not forwarded to the Backend**, so the Backend receives no copy and no notification.
What the Backend resolves is only what its own account, environment or `models.json` makes available — and for a
Pi-mode Backend that account *is* a file, so it later reads the same stored value from disk when the two processes were
pointed at the same agent directory (see [Availability](#availability-after-a-credential-written-elsewhere)). See
[Secrets](#secrets) and [the client ingress](client-ingress.md#the-client-api).

## Registry, and the file that overrides it

Every mode is served by one backend-owned `ModelRuntime` over the backend agent directory's `models.json`. That file
is what Settings › Models reads and saves (`GET`/`PUT /api/models-config`), and it overlays whatever the mode registers
as a base layer. A provider definition in the file wins for the ids it defines; a model entry with an existing id
replaces that model. Removing the definition restores the base layer rather than deleting it — the file owns overrides,
not the deployment.

- No provider env and no file entry: no environment-owned base provider is registered. Whatever `models.json`
  defines is the whole catalog — the ambient built-in catalog is present in the runtime, but `GET /api/models` lists only
  providers whose credentials resolve — and a deployment that defines nothing offers no model and states no default: new
  conversations start with none and their requests settle natively as `no_model` until a model is selected. There is
  no offline scripted fallback in production; `faux` is a test fixture only
  (`apps/server/test/faux-fixture.ts`). This paragraph describes environment mode; `HEPI_CONFIG_SOURCE=pi` has its own
  fallback ([Default model](#default-model)). The optional `HEPI_CONFIG_SOURCE=pi` mode builds the runtime from the backend
  host's `pi` agent directory instead, including `auth.json`; see [docs/pi-config.md](pi-config.md).
- `OPENAI_API_KEY` set and no custom pair: the upstream OpenAI provider is registered as the base layer;
  `HEPI_PROVIDER=openai` plus `HEPI_MODEL=<catalog id>` selects the default model for new conversations.
- A custom `HEPI_PROVIDER`/`HEPI_MODEL` pair is registered as an environment-owned base provider with an
  environment credential reference (`$HEPI_PROVIDER_API_KEY`), and it takes the one base slot: `OPENAI_API_KEY` does not
  also register OpenAI as the base provider. Its alias, endpoint and credential reference are re-applied on every boot
  from the environment; nothing is copied into `models.json` by starting the backend, and the editor's first read of an
  unconfigured deployment is therefore empty rather than a synthetic copy of the deployment.

**The base slot is not the catalog.** Because the base layer is a `ModelRuntime`, the upstream built-in providers remain
registered in every branch — a custom provider replaces *this deployment's* base registration, not the runtime's
built-ins. `GET /api/models` lists only providers whose credentials resolve, and that credential filter is what governs
the exposed catalog: an ambient key in the backend process environment (for example `DEEPSEEK_API_KEY`) makes that
provider's models available in environment mode too, including beside a custom provider. Configure credentials
deliberately per backend host.

## Custom OpenAI-completions provider

Set all four variables on the backend process:

| Variable | Required | Meaning |
| --- | --- | --- |
| `HEPI_PROVIDER` | yes | Provider id, e.g. `deepseek` or any local id such as `magpie`. |
| `HEPI_MODEL` | yes | Model id sent as-is to the endpoint. |
| `HEPI_PROVIDER_BASE_URL` | unless the provider id has a built-in default | OpenAI-compatible base URL, e.g. `https://api.deepseek.com` or `http://127.0.0.1:8080/v1`. |
| `HEPI_PROVIDER_API_KEY` | yes for custom providers | Bearer key; for a local endpoint that ignores auth, supply an explicit non-secret placeholder. |

`deepseek` is the only provider id with a built-in default base URL (`https://api.deepseek.com`). Any other id requires an explicit base URL.

Startup is strict so misconfiguration surfaces immediately, not as a failed request later:

- A configured provider requires `HEPI_MODEL`. Missing/blank model, or endpoint/key settings without provider and model, fail startup instead of starting a backend that serves nothing. `HEPI_MODEL` alone retains the legacy OpenAI selection path.
- `HEPI_PROVIDER=faux` is rejected: the offline scripted provider is a test fixture, not a custom endpoint.
- `HEPI_PROVIDER_BASE_URL` must be an absolute `http`/`https` URL; a malformed or other-scheme value fails at startup.
- Unknown provider id without `HEPI_PROVIDER_BASE_URL`: startup fails with "HEPI_PROVIDER_BASE_URL is required for provider <id>" instead of silently calling the wrong endpoint.
- `HEPI_PROVIDER=openai` without a base URL is treated as unconfigured, because the built-in OpenAI provider already covers that case and needs `OPENAI_API_KEY`. In that combination `HEPI_PROVIDER_API_KEY` is ignored: `OPENAI_API_KEY` is the variable that authenticates.
- `HEPI_PROVIDER=openai` *with* a base URL is a normal custom endpoint (for example a gateway or a local OpenAI-compatible server). Then the built-in OpenAI provider is not used at all: auth comes from `HEPI_PROVIDER_API_KEY`, and the model id must be a real id at that endpoint, not a catalog id you expect to be filled in from upstream metadata (see Model metadata below).
- Built-in default base URL and no `HEPI_PROVIDER_API_KEY`: startup fails with "HEPI_PROVIDER_API_KEY is required". A key that is present but wrong is not detectable at startup; the endpoint answers 401 per request.
- `HEPI_PROVIDER_API_KEY` set to whitespace only is a startup failure ("is set but empty") rather than a silent keyless request, so a blanked variable in an env file cannot quietly drop authentication.

### Auth behavior (environment mode)

These statements describe the default mode, where `HEPI_CONFIG_SOURCE` is unset. They are not global claims about every backend mode: with `HEPI_CONFIG_SOURCE=pi` the backend instead builds its registry from the `pi` agent directory, including `auth.json` (docs/pi-config.md).

- With `HEPI_PROVIDER_API_KEY` set, the provider uses exactly that environment variable. It never falls back to another provider's ambient key.
- The upstream OpenAI-completions implementation requires a key, including for explicit base URLs. Missing keys fail startup. For local servers that ignore authentication, set an explicit non-secret placeholder; a Bearer credential is still sent. Truly unauthenticated requests are not supported by this adapter.
- In this mode credentials live in memory: the backend reads no `auth.json` and creates none, and consults no file on disk for auth. A credential reference in `models.json` still resolves against the backend process environment, so the editor can save `$HEPI_PROVIDER_API_KEY` or a literal key without the value being copied anywhere.
- Consequence for Settings › Models: a key a user stores there belongs to the Gateway's account. No refresh route or
  invalidation signal carries it to a backend, because there is no such wire; the only way it reaches one is a Pi-mode
  backend that was configured on the **same** agent directory, which then re-reads that file on its next catalog read.
  A backend on a different account, host or directory — and any environment-mode backend — never sees it. See
  "Availability after a credential written elsewhere" below.

### Model metadata

Model capabilities come from the upstream generated catalog (`@earendil-works/pi-ai/providers/all`), never from the provider id. `HEPI_PROVIDER` names the endpoint, not the model: the alias `magpie` and the id `deepseek-v4.1-flash` describe one model, and only the catalog knows what that model accepts.

Two lookups decide the metadata, both before the configured base URL replaces the endpoint:

1. **The provider's own catalog entry**, when the configured provider id is also an upstream provider id (for example `HEPI_PROVIDER=deepseek`, `HEPI_MODEL=deepseek-flash`). This keeps that provider's pricing and wire compatibility as well as its capabilities.
2. **The facts every catalog agrees on for that model id**, when the configured provider is an alias such as `magpie`. A model id identifies the same model wherever it appears, so name, `reasoning`, `thinkingLevelMap`, `input`, `inputLimits`, `contextWindow` and `maxTokens` are adopted only when all entries for that id match. A field the catalogs disagree about stays unknown rather than guessed: `zai-org/GLM-5.3` is image-capable at Baseten and text-only at Together, so that id keeps the text-only default.

Any other id gets a placeholder, and the placeholder is a guess, not a measurement:

- Name is suffixed `(unverified)` unless the shared upstream facts above supplied a name.
- Cost is all zeros, which means **unknown cost, not free**. Pricing is provider-specific, so it is never adopted across catalogs: usage accounting will under-report spend; treat budgets from these conversations as unreliable.
- `contextWindow` (128000) and `maxTokens` (8192) are conservative placeholders, replaced by the agreed upstream values when the model id is known. A model with a smaller window can still be over-sent, and one with a larger window is used below its capability.
- `reasoning` is false and input is text-only unless the agreed upstream facts say otherwise. An id that is text-only in the catalog (`deepseek-v4-pro`) stays text-only even under a DeepSeek-named alias, and an image-capable id such as `deepseek-v4.1-flash` keeps image input: an image content block then reaches the configured endpoint as image bytes instead of being replaced by the framework's `(image omitted…)` placeholder.

Thinking levels are not validated per model by this backend. The settings endpoint accepts the known level names (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`); what a given endpoint actually does with one is decided by the upstream provider adapter at request time, which maps or clamps it per model. A placeholder model reports no reasoning support, so a level selected against it is not guaranteed to change anything at the endpoint.

### Registry scope

Startup registers **at most one environment-owned base provider**, and the branches are exclusive
(`openEnvModelRuntime`, `apps/server/src/model-config.ts`): `custom` → `registerNativeProvider(custom)`; else
`OPENAI_API_KEY` → `registerNativeProvider(openaiProvider())`; else nothing. That is a statement about *this
deployment's registration*, not about the runtime's catalog. The base layer is a `ModelRuntime` whose built-in
provider map is composed from the upstream catalog, and `registerNativeProvider` only adds or replaces the single id it
names — so the **other built-in providers are still there** in every branch, a custom provider does not remove them,
and reusing a built-in's id (say `openai`) is what replaces that one entry. The
`models.json` file overlays them, so a model the file defines is served alongside, and an entry for an existing id
replaces it. What decides which of those are *exposed* is the credential filter: `GET /api/models` lists every model
whose credentials resolve, so a built-in provider shows up when its key is resolvable from this backend's account and
is absent otherwise. An `OPENAI_API_KEY` in the environment is therefore still enough to expose OpenAI models beside a
custom provider; what the exclusive branch means is narrower — with `HEPI_PROVIDER`+`HEPI_MODEL` set, the deployment's
own base credential resolution is that provider's, and `OPENAI_API_KEY` is not registered as *the* base provider. An
unknown provider id with no base URL still fails startup rather than being silently folded into a built-in
([custom provider](#custom-openai-completions-provider)). Conversations persist their model reference, so existing
conversations keep the model they were created with.

`HEPI_CONFIG_SOURCE=pi` changes which base layer is registered: the backend uses the `pi` agent directory's catalog and credential store instead of the environment-configured provider. In that mode an explicit `HEPI_PROVIDER`+`HEPI_MODEL` pair selects a model that must already exist in the `pi` registry, and `HEPI_PROVIDER_BASE_URL`/`HEPI_PROVIDER_API_KEY` are rejected rather than allowed to override that catalog. The `models.json` file layer and the editor's save path are the same in both modes. See docs/pi-config.md.

In environment mode, `HEPI_MODEL` without `HEPI_PROVIDER`/base URL keeps the previous behavior: provider defaults to `openai`, the model must exist in the built-in OpenAI catalog, and an unknown one fails at startup. Pi mode rejects that half-set pair instead.

### Default model

**Environment mode** (`HEPI_CONFIG_SOURCE` unset): `HEPI_PROVIDER`+`HEPI_MODEL`, or the legacy `HEPI_MODEL` alone,
names the model new conversations start with. Without one there is **no implicit default**: the catalog still lists
every model the file and the ambient environment make available, `GET /api/models` states `defaultModel: null`, and a
conversation created before a model is selected settles its next request natively as `no_model`. No model is chosen on
the operator's behalf and no conversation's stored reference is rewritten. The client then selects a model explicitly,
which is the recovery path.

**Pi mode** (`HEPI_CONFIG_SOURCE=pi`) resolves differently: with no `HEPI_PROVIDER`+`HEPI_MODEL` pair the default comes
from the Pi `settings.json` `defaultProvider`/`defaultModel` (which must be set together), and with neither the first
authenticated catalog entry is used — Pi's own fallback ([backend Pi configuration](pi-config.md#supported-inputs)). The
difference is deliberate: environment mode has no ambient account to inherit a default from, and a Pi agent directory
does.

## Secrets

- In environment mode (`HEPI_CONFIG_SOURCE` unset) keys are read from the process environment only, and ambient lookup
  is restricted to this deployment's environment: the auth context answers `env(name)` from `process.env` and reports no
  files, so `~/.pi` credentials cannot be picked up. `HEPI_CONFIG_SOURCE=pi` deliberately reads the backend host's `pi`
  `auth.json`; that is the mode's point ([backend Pi configuration](pi-config.md)). In both modes the **backend's own
  account is the boundary**, and the Gateway's file is not read *here*: a key stored through the Web Settings panel is
  written into the Web host's gateway account, and this backend reads it only in the one case where that account and
  this one are the same file — Pi mode configured on the same agent directory (same account, same directory, and, for
  two hosts, a shared or matching mount). Environment mode never reads it, on any host.
- Keys the backend uses never leave the backend. `GET /api/models` exposes provider id, model id, name and limits, never
  credentials or base URLs, and no browser bundle contains one.
- Do not commit keys or print them in logs, issue reports or transcripts. Startup logs the listen address only. Put keys in a mode-600 env file per host (docs/deployment.md).

## Model configuration editing

Settings › Models edits this backend's `models.json` through `GET`/`PUT /api/models-config`. A save is validated on a
throwaway `ModelRuntime` before the real file is replaced atomically with mode `0600`, then applied to the live runtime
with network access disabled. Each save replaces the file, so the last completed write is the one that stands. A rejected draft answers `400` and changes nothing; a written file that could not be
applied answers `success: true, applied: false` with a diagnostic and is shown as saved-but-not-applied. Diagnostics
name a schema path or a provider/model id; a parse failure is reported as a fixed message, because the upstream reader's
own error quotes the file's bytes and a credential reference may be among them. The change reaches the next request the
framework prepares — an already-prepared request keeps the endpoint it resolved.

## Availability after a credential written elsewhere

Provider availability is not cached across a request: each catalog read re-resolves credentials from the account this
process was configured with. So "does a credential another process stored become available without a restart" depends on
one thing only — whether that process wrote into *this* backend's account.

- **Pi mode** — the account is the agent directory this backend was configured with (`PI_CODING_AGENT_DIR`, else
  `~/.pi/agent` on the backend host, [backend Pi configuration](pi-config.md#supported-inputs)). The Gateway writes its
  own agent directory — the executing account's `~/.pi/agent`, or a `PI_CODING_AGENT_DIR` override on *its* host. So a
  stored credential becomes available to this backend **only when those two directories are the same file**: the same
  account and directory, and for two hosts a shared or identically mounted path. That is a configuration property, not
  an automatic consequence of Pi mode. When it holds, the credential the Gateway stores (or a sign-in it completes) is
  read by the next catalog read, with no restart and no signal; removing one withdraws the model just as directly. The
  backend is not told when the file changes: it re-reads it on the next read it was going to make anyway, so an idle
  backend shows the change on its next request. When the directories differ — the ordinary case when the gateway runs on
  the client host and the backend elsewhere — nothing crosses, exactly as in environment mode.
- **Environment mode** — the account is this process's environment and an in-memory store. A credential the Gateway
  stores on the Web host is not this backend's concern, and no refresh route, invalidation signal or restart would change
  that: it is a property of which account the deployment chose (docs/deployment.md).

That is the whole backend side of a credential change. The change invalidates the *page's* cached catalog and re-reads
it in whatever is mounted (the client rule docs/client-ingress.md states), including a composer behind an open Settings
dialog; it owes this backend nothing, and no wire between them carries a credential either way. Both halves are held by `apps/server/test/provider-availability.test.ts`, which writes through the Gateway's own
service and reads through the Backend's own route in each mode.

## Verification

Use the repository entrypoints rather than ad-hoc snippets: `pnpm -r typecheck && pnpm -r test` is the fast gate (docs/verification.md).

To verify the catalog and one text turn through the real Web origin against a controlled endpoint (no paid call), build the Web UI and run `pnpm --filter @hepi/server smoke:catalog`. It checks that `GET /api/models` through the Web origin advertises the configured alias's real input modalities and that exactly one text request reaches the configured endpoint, key and model id.

To verify a configured provider end to end against the paid endpoint, start the backend with `HEPI_PROVIDER`/`HEPI_MODEL` (and key/base URL) plus `HEPI_AUTH_TOKEN`, then run `pnpm --filter @hepi/server smoke:provider`. It submits one short request through authenticated SSE and reports the final assistant response; it is a manual operator smoke, not part of the test suite. Configuration alone can be checked by starting the backend and reading `GET /api/models`: it must list the configured provider and model, and startup must fail loudly when the base URL or key is missing as described above.
