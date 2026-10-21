# Framework fit and reuse evidence

Status: planning-only evidence through grill round 3, kept as the dated record of what fit at that point.
Requirements and decided behavior are authoritative in [plan.md](plan.md); delivery is in [validation.md](validation.md).
No application/configuration/deployment changes or live-provider checks accompanied this record. An absent API is a
missing integration, not proof that the behavior is impossible; contract extensions and product decisions had to be
identified before implementation.

**Current state of the rows this file called missing.** Images: delivered by tickets 03 and 06 — the model metadata is
corrected, `SubmitCommand` carries `images`, the backend validates and refuses by model, and image bytes survive
submission, SSE and restart ([03](issues/03-correct-deepseek-image-capability.md),
[06](issues/06-image-submission-durable-history.md)). No image patch, vendored fork or resource-image workaround is
pending or needed, and no active image gap remains. Models, interactive terminal and built-in Skills were delivered by
tickets 12, 10/11/14 and the capability-integration tickets; the rows below are the planning-time reading, not an open
backlog.

## Project and execution model

| Area | Existing capability | Missing integration / limitation | Candidate direction, not approved design |
| --- | --- | --- | --- |
| Project sidebar | Existing grouping via session-tree and workspace-memory; grouping uses projectKey/projectRoot/cwd; displayed name defaults to the directory leaf. | No persisted named, multi-folder Project record is currently mapped through this UI. | Adapt existing grouping and remembered selections rather than adding a parallel Project sidebar. |
| Conversation binding | WorkspaceBinding has one cwd; a conversation keeps its workspaceId. | There is no multi-root Workspace contract. A multi-folder Project does not automatically make all its folders tool roots. | Reuse a single-root Workspace for the confirmed default folder. Other folder metadata does not enable prompt injection or tool access in this effort. |
| File access | Local/SSH FilesystemServer lists directories inside a configured workspace root. | Arbitrary host browsing outside that root is not provided by this interface; sibling project folders are not automatically file-tool roots. | Extend host project-management browsing explicitly; do not mislabel current listDir as an arbitrary host picker. |
| Host registration | Local and SSH gateway implementations already exist. Backend receives configured workspaces at startup. | Current APIs do not register arbitrary new workspace roots or SSH profiles at runtime. | Reuse gateways/SSH runner; design registration and metadata lifetime instead of a second execution engine. |
| Web-host identity | Split deployment can show the same configured execution workspace from different Web hosts. | Local relative to Web host is not equivalent to the backend's configured gateway. Selecting a local folder needs execution access to that actual Web host. | Resolve the host/account and reuse its gateway before claiming New Project works on that host. |

Evidence: packages/protocol/src/index.ts:9-11,73; apps/web/lib/workspace-memory.ts:91-97;
apps/web/lib/session-tree.ts:149-156; packages/gateway/src/filesystem.ts:16-36;
packages/gateway/src/ssh-filesystem.ts:66-102; apps/server/src/main.ts:12;
apps/server/src/server.ts:205-207,309-314. The current single-root implementation needs extension for simultaneous
multi-root access, but ADR 0002's execution-side ownership alone does not forbid such an extension.

## Existing mechanisms for other feature groups

| Feature | Reuse available | What is still missing / must be designed |
| --- | --- | --- |
| Token visibility | Existing useChatAppearance browser preference pattern and inline SVG style. | New response-footer preference and researched SVG selection; no backend accounting or aggregate display change. |
| Models | Backend already supports Pi models.json/auth.json/settings.json. Upstream ModelRuntime already has refresh, provider registration and credential operations. | Ticket 12 wired this: one backend-owned ModelRuntime over the agent directory in both modes, with the env deployment registered as an environment-owned base layer (`registerNativeProvider`), `GET`/`PUT /api/models-config` validated on a throwaway runtime before an atomic write, and the Web process proxying rather than reading its own host's agent directory. |
| Interactive terminal | Upstream terminal-manager already uses node-pty for local PTYs. SSH gateway can execute remote commands. | Current gateway/API does not expose the interactive PTY lifecycle. Running a PTY on the Web process alone would not provide a terminal on the selected remote execution host. |
| Images | Durable runtime accepts image content. | SubmitCommand is text-only; adapter rejects image commands; model metadata and body limits also need alignment. A metadata edit alone does not enable image submission. |
| Skills | Existing repository/bundles, installation hashes, conflict backups and reload outcomes; builtin Skills UI. | Builtin Skills endpoints are not wired. Keep global/project destinations; offer harness bundles as sources, reuse the existing installer and preserve the library's non-execution role. |

Evidence: apps/server/src/pi-config.ts; apps/server/src/model-config.ts; apps/server/src/harness.ts;
apps/web/lib/terminal-manager.ts:74-103;
packages/protocol/src/index.ts:27-37. More Skills and endpoint evidence lives in
[skills-reuse.md](skills-reuse.md) and [settings-api-audit.md](settings-api-audit.md).

Important upstream reuse: installed @earendil-works/pi-coding-agent ModelRuntime.refresh reloads ModelConfig
from modelsPath and rebuilds providers (dist/core/model-runtime.js:582-609; exposed in model-runtime.d.ts:109).
The backend passes that models collection to Harness.open. A new registry or generic hot-reload subsystem is
not justified merely because Settings routes are absent. Reuse still needs verification of invalid-config
handling, active-run timing, default-model ownership and credential persistence before a save/apply contract is
promised. Startup loading alone is what the application currently wires; upstream support is not a completed API.

## Round 2 model-request evidence

pi-durable 1.1.0 GenerationTask.prepare resolves agent/model settings for a generation, while its request phase
looks up the model again through runtime.models.getModel(ref.provider, ref.modelId). A later generation after
tools also performs this lookup. Evidence: installed dist/harness/generation.js:28-37,103-119.
ModelRuntime.prepareRequest resolves the provider and auth for each new call (model-runtime.js:447-475).
This supports applying a successfully refreshed configuration on the next model call without waiting for every
conversation to become idle. It does not itself guarantee atomic config validation/application or snapshot
consistency between prepare and request; verify these before promising a save-success boundary.
An already sent streaming call continues; changing the catalog is distinct from changing a conversation's selected
provider/model ID or the default used for new conversations (server.ts settings PATCH and conversations POST).

Project round 2 scope: same computer first; future folder locations may reference other hosts/platforms. Current
protocol cwd validation requires a leading slash (protocol/src/index.ts:114); Windows path support is not established
by the current contract. Preserve host association rather than treating bare paths as universal identities; do
not build a speculative multi-host executor or general platform abstraction now.

## Round 3: use the framework lifecycle

User Q12 settles model timing by adopting upstream behavior, rather than a bespoke per-turn/per-call rule.
The installed pi-durable 1.1.0 README, Per-Conversation Agent, states that configure commits agent changes,
request model/prompt/tools are fixed when prepared, and changes apply from the next request. Environment is
built from current cwd at each use; a cwd/extension change can therefore reach already-issued tool calls.
The Reload section separately states that already-started work keeps its implementation; later phases,
requests and calls use newly installed code. These describe different surfaces and should not be flattened
into a new application-wide freeze or scheduling policy.

Source: [installed-version upstream README](https://www.npmjs.com/package/@earendil-works/pi-durable/v/1.1.0),
Per-Conversation Agent, Environment and Reload sections; installed dist/harness/generation.js prepare/request.
ModelRuntime.refresh owns provider/model configuration refresh. Its reuse does not require duplicating durable
registry logic. Current model/configuration Settings routes are still missing; verify actual save/apply diagnostics.

The generic configure API accepts cwd changes. The application's immutable Workspace binding is a first-version
integration/product boundary, not proof that pi-durable forbids moving a conversation. Q13 accepts the present
boundary: new defaults affect new conversations only. Future relocation would need coherent execution binding,
resource context and an explicit location notice; record only, preserving ADR 0002 for current conversations.

Q14 matches the existing generation failNoModel path: missing selection resolves the input as unanswered with
reason no_model and a failed task whose message identifies the unavailable model. Evidence: installed
pi-durable dist/harness/generation.js:236-245. Verify the Web event/state presentation: a native failure path
alone does not prove that users currently see the error. Preserve the selected reference and explicit recovery;
no implicit alternate model or synthetic assistant result is needed.
