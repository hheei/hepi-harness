# Deferred decision records — provider/MCP settings closeout

Status: deferred, **not ready implementation tickets**
Date: 2026-10-19
Source: [\`../ux-closeout-research/02-provider-mcp-and-settings.md\`](../ux-closeout-research/02-provider-mcp-and-settings.md) (S1, S2)

These two candidates were surfaced by the UX closeout and are deliberately **not** turned into tickets. Each has an
owner question that is not answered, so scheduling implementation now would pick an ownership by accident. Reopen
only when the trigger below fires.

## D1 — Provider connection test and model discovery

**What was seen.** Ingress \`packages/gateway/src/ingress/index.ts:129-140\` intentionally excludes deployment default,
enabled scope, catalog refresh and model discover/test/catalog; capability probing in
\`packages/ui/src/lib/capability-availability.ts:46-60\` plus ModelsConfig gates suppress the unsupported actions. A
missing API is therefore not necessarily a clickable dead control. The provider connection spec excludes provider/model
discovery and benchmarking by decision, and per-conversation model choice already exists.

**Why deferred.** Ownership differs from OAuth: an explicit "Test connection" would validate a specific host, account
and provider configuration, and discovery would persist a desired model configuration — both are model-configuration
capabilities, not provider-auth ones. Choosing where that lives (provider connection vs model configuration vs a
separate capability) is the open decision.

**Reopen trigger.** A user configures a provider without manual model IDs and cannot proceed, or a connection failure
cannot be told apart from a bad model selection without an explicit test.

**If reopened, the acceptance bar.** Say what Test validates and which host/account/provider configuration it used;
expose success or failure without mutating configuration and without echoing a secret; discovery selection explicitly
persists the desired model configuration. Do not recreate a deployment-wide model default merely because copied UI
once exposed it.

## D2 — Managed skill uninstall

**What was seen.** Install/update/toggle and local-modification/conflict feedback exist
(\`packages/gateway/src/install.ts\`, \`packages/ui/src/components/SkillsConfig.tsx\`). There is no uninstall operation
or UI; disable is available and the absence is documented at \`docs/migration-status.md:926\`. This is a missing
capability, not a broken install flow.

**Why deferred.** A generic recursive delete plus lock cleanup is not a design: removal must distinguish a managed
installation from manual or repository content, and must decide the disposition of local edits, retained update
backups and provenance. That is a skills-installation ownership question, so it does not belong to provider
connection, and this note parks the record rather than claiming the work. **No owning ticket exists yet**; when an
owning effort is chosen, move this record there instead of implementing it from this directory.

**Reopen trigger.** A person needs to remove a managed installation and disabling it is not sufficient (for example,
the skill must stop occupying its directory), or install metadata becomes misleading because a removed install still
appears.

**If reopened, the acceptance bar.** Remove only the selected managed installation; make the target host, scope and
source visible before removal and require confirmation; handle manual or locally edited installations according to an
explicit user choice; report the metadata and Reload outcome truthfully; re-read stale inventory afterwards. Decide
managed-only removal versus broader manual directory deletion first.
