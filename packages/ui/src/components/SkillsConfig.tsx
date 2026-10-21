"use client";

import { useState, useEffect, useCallback, useId, useRef } from "react";
import { useI18n } from "../hooks/useI18n";
import type { ProjectTrustStatus } from "../lib/api-types";
import { displayPathWithin, shortenPath } from "../lib/display-path";
import {
  getLastSettingsSelection,
  setLastSettingsSelection,
} from "../lib/settings-navigation";
import type { ReactNode } from "react";
import {
  availableBundleId,
  canCheckForUpdate,
  checkOutcome,
  conversationTarget,
  hostLabel,
  initialWorkspaceId,
  installOutcome,
  installedAt,
  installedVersion,
  catalogState,
  needsUpdateConfirmation,
  searchMisses,
  sourceState,
  toggleOutcome,
  updateOutcome,
  workspaceIdFromCwd,
  selectableWorkspaces,
  type ExecutionWorkspace,
  type InstalledSkill,
  type OperationOutcome,
  type SearchMiss,
  type SkillInventory,
  type SourceState,
  type UpdateCheck,
} from "../lib/skill-inventory";
import { folderRoutingPath, projectDefaultWorkspaceId, projectGroupOfPath, type ProjectRouting } from "../lib/project-routing";
import {
  ConfigAddSourceHeading,
  ConfigButton,
  ConfigDetail,
  ConfigDetailActions,
  ConfigDetailGrid,
  ConfigDetailGridRow,
  ConfigDetailHeader,
  ConfigDetailHeaderInfo,
  ConfigDetailStack,
  ConfigEmptyState,
  ConfigField,
  ConfigFooter,
  ConfigListAction,
  ConfigNotice,
  ConfigPanelShell,
  ConfigSaveTarget,
  ConfigScopeTag,
  ConfigSidebar,
  ConfigSidebarGroupStatus,
  ConfigSidebarGroupSwitch,
  ConfigSwitch,
  ConfigSidebarGroupLabel,
  ConfigSidebarItem,
  ConfigSidebarList,
  ConfigSidebarText,
  ConfigSplitView,
  ConfigStatusDot,
  ConfigTrustNotice,
} from "./SettingsUi";
import { itemsToSwitch, projectTrustReloadKey } from "./settings-ui-helpers";
import { useExecutionResources, useExecutionTarget, useTargetFence, useWorkbenchConnection } from "../lib/workbench-scope";
import type { ExecutionFailure, ExecutionTarget } from "@hepi/session/execution-resources";

/** A refusal as the one sentence a panel shows: the host's own message, and its code when that is all it named. */
function refusalText(error: ExecutionFailure): string {
  return error.message === "" ? (error.code ?? error.kind) : error.message;
}

/** A scope choice: the execution account's own skills, or the selected workspace's project directory. */
type InstallScope = "global" | "project";

/** The installation scope the backend uses for a UI destination. `project` is the gateway's `workspace` scope. */
function wireScope(scope: InstallScope): "global" | "workspace" {
  return scope === "project" ? "workspace" : "global";
}

/** The library listing the backend already serves: curated sources and stored harness bundles, with provenance. */
type LibrarySkill = {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly source: { readonly kind: "github"; readonly repository: string; readonly revision: string } | { readonly kind: "repository"; readonly name: string; readonly version: string };
  readonly version?: string;
};
type LibraryListing = { readonly skills: readonly LibrarySkill[]; readonly unavailableSources: readonly string[] };
type LibraryPreview = { readonly markdown: string; readonly files: readonly { readonly path: string; readonly encoding: "utf8" | "base64" }[] };

/** The directory name an installation becomes, which is also the bundle name an update replaces. */
function directoryOf(skill: LibrarySkill): string {
  return skill.source.kind === "repository" ? skill.source.name : skill.name;
}

/** Where a library skill comes from, as one label. */
function sourceLabelOf(skill: LibrarySkill, repositoryLabel: string): string {
  return skill.source.kind === "repository" ? repositoryLabel : skill.source.repository;
}

/** The revision a library skill's content was read at: a commit for a curated source, the bundle version for a store. */
function revisionOf(skill: LibrarySkill): string {
  return skill.source.kind === "repository" ? skill.source.version : skill.source.revision.slice(0, 12);
}

function scopeLabel(scope: InstallScope, t: ReturnType<typeof useI18n>["t"]): string {
  return scope === "global" ? t("skills.scope.global") : t("skills.scope.project");
}

/** One installed-skill group's own label, from the placement the host reported. */
function groupLabel(scope: "global" | "project" | "path", t: ReturnType<typeof useI18n>["t"]): string {
  return scope === "project" ? t("skills.scope.project") : scope === "global" ? t("skills.scope.global") : t("skills.scope.path");
}

/** Whether every row of a group is already active, which is what the group's switch reads as on. */
function allActive(skills: readonly InstalledSkill[]): boolean {
  return skills.every((skill) => !skill.disableModelInvocation);
}

/** Installed skills first by activity, then as the host listed them: dormant skills stay visible, not hidden. */
export function orderSkillsByDormancy<T extends { disableModelInvocation: boolean }>(skills: T[]): T[] {
  return [
    ...skills.filter((skill) => !skill.disableModelInvocation),
    ...skills.filter((skill) => skill.disableModelInvocation),
  ];
}

/** One installed skill's state, said as text: the baseline question and the revision question are separate facts. */
function SkillStateRows({ skill }: { skill: InstalledSkill }) {
  const { t } = useI18n();
  const install = skill.install;
  return (
    <ConfigDetailGrid>
      <ConfigDetailGridRow label={t("skills.state.revision")}>
        {skill.revision === "update-available"
          ? t("skills.revision.updateAvailable", { version: skill.availableVersion ?? t("i18n.unknown") })
          : skill.revision === "up-to-date"
            ? t("skills.revision.upToDate")
            : t("skills.revision.unknown")}
      </ConfigDetailGridRow>
      <ConfigDetailGridRow label={t("skills.state.local")} tone={install?.state === "locally-modified" ? "plain" : "muted"}>
        {install === undefined
          ? t("skills.local.noBaseline")
          : install.state === "unchanged"
            ? t("skills.local.unchanged")
            : install.state === "locally-modified"
              ? t("skills.local.modified")
              : t("skills.local.unmanaged")}
      </ConfigDetailGridRow>
      {install !== undefined && (
        <ConfigDetailGridRow label={t("skills.installedVersion")} mono>
          {installedVersion(skill) ?? t("i18n.unknown")}
        </ConfigDetailGridRow>
      )}
      {install !== undefined && (
        <ConfigDetailGridRow label={t("skills.source")} mono>
          {install.source}
        </ConfigDetailGridRow>
      )}
      <ConfigDetailGridRow label={t("skills.directory")} mono>
        {skill.directory}
      </ConfigDetailGridRow>
      <ConfigDetailGridRow label={t("skills.path")} mono>
        {skill.filePath}
      </ConfigDetailGridRow>
    </ConfigDetailGrid>
  );
}

/**
 * The retained Skills detail pane: what the host holds for one skill, the two state questions, and the one action the
 * recorded provenance supports. A repository installation with a newer version offers Update; the confirmation for a
 * locally modified or unmanaged directory is a second, explicit press, and a directory that changed since this pane
 * read it is refused by the host rather than overwritten.
 */
function SkillDetail({
  skill,
  scope,
  workspace,
  outcome,
  busy,
  confirming,
  toggling,
  checking,
  canCheck,
  onUpdate,
  onConfirm,
  onCancelConfirm,
  onToggle,
  onCheck,
}: {
  skill: InstalledSkill;
  scope: InstallScope;
  workspace: ExecutionWorkspace | undefined;
  outcome: OperationOutcome | undefined;
  busy: boolean;
  confirming: boolean;
  /** The skill's own document is being edited, or its revision is being asked about, right now. */
  toggling: boolean;
  checking: boolean;
  /** This skill's recorded provenance names a repository, so the revision question can be asked of it. */
  canCheck: boolean;
  onUpdate: () => void;
  onConfirm: () => void;
  onCancelConfirm: () => void;
  onToggle: (disableModelInvocation: boolean) => void;
  onCheck: () => void;
}) {
  const { t } = useI18n();
  const toggleReasonId = useId();
  const placement = skill.scope;
  const bundleId = availableBundleId(skill);
  const install = skill.install;
  const scopeMatches = install !== undefined && install.scope === wireScope(scope);
  // A skill below either installation scope's own root can be switched; one discovered in an ancestor root cannot,
  // because no installation scope owns that directory and this host must not edit outside its own roots.
  const toggleable = skill.scope === "global" || skill.scope === "project";
  return (
    <ConfigDetailStack>
      <div>
        <ConfigDetailHeader>
          <ConfigDetailHeaderInfo>
            <ConfigScopeTag scope={placement === "project" ? "project" : placement}>
              {placement === "global" ? t("skills.scope.global") : placement === "project" ? t("skills.scope.project") : t("skills.scope.path")}
            </ConfigScopeTag>
            <span className="config-detail-path">
              {placement === "project" ? displayPathWithin(skill.filePath, workspace?.workspaceRoot ?? "") : shortenPath(skill.filePath)}
            </span>
          </ConfigDetailHeaderInfo>
          <ConfigDetailActions>
            <ConfigSwitch
              checked={!skill.disableModelInvocation}
              disabled={!toggleable || toggling}
              loading={toggling}
              size="small"
              label={t("skills.modelInvocation")}
              describedBy={toggleable ? undefined : toggleReasonId}
              onChange={(enabled) => onToggle(!enabled)}
            />
            {canCheck && bundleId === undefined && (
              <ConfigButton size="small" disabled={checking} onClick={onCheck}>
                {checking ? t("skills.checking") : t("skills.checkUpdate")}
              </ConfigButton>
            )}
            {bundleId !== undefined && scopeMatches && (
              <ConfigButton variant="primary" size="small" disabled={busy} onClick={confirming ? onConfirm : onUpdate}>
                {confirming && install !== undefined && needsUpdateConfirmation(install.state)
                  ? t("skills.confirmUpdate")
                  : busy ? t("i18n.updating") : t("i18n.update")}
              </ConfigButton>
            )}
            {confirming && <ConfigButton size="small" onClick={onCancelConfirm}>{t("i18n.close")}</ConfigButton>}
          </ConfigDetailActions>
        </ConfigDetailHeader>
        {confirming && install !== undefined && (
          <div className="skill-detail-status-row">
            <span style={{ fontSize: 11, color: "var(--text-dim)" }}>
              {install.state === "locally-modified" ? t("skills.warn.modified") : t("skills.warn.unmanaged")}
            </span>
          </div>
        )}
        {install !== undefined && install.state === "locally-modified" && !confirming && (
          <div className="skill-detail-status-row">
            <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{t("skills.local.modified")}</span>
          </div>
        )}
        {!toggleable && (
          <div className="skill-detail-status-row">
            <span id={toggleReasonId} style={{ fontSize: 11, color: "var(--text-dim)" }}>{t("skills.toggleUnavailable")}</span>
          </div>
        )}
      </div>

      {/* The operation's outcome is rendered here, outside every installed/status switch, so it survives a list
          refresh and a scope change: the files are installed whether or not anything was reloaded. */}
      {outcome?.notice !== null && outcome?.notice !== undefined && (
        <ConfigNotice><span className="skill-outcome">{outcome.notice}</span></ConfigNotice>
      )}
      {outcome?.error !== null && outcome?.error !== undefined && (
        <ConfigNotice><span className="skill-outcome is-error">{outcome.error}</span></ConfigNotice>
      )}

      <ConfigField label={t("config.name")}>
        <span className="skill-name-value">{skill.name}</span>
      </ConfigField>
      <ConfigField label={t("i18n.description")}>
        <span className="skill-description">{skill.description}</span>
      </ConfigField>
      <SkillStateRows skill={skill} />
    </ConfigDetailStack>
  );
}

/**
 * The add pane: the harness-managed bundles the backend already serves, browsed without an active conversation, with
 * each source named. An installation always names its execution target, and the outcome it reports is the one the
 * backend returned: publication, and adoption only when a conversation was actually asked to reload.
 */
function AddSkillPanel({
  workspaceId,
  target,
  workspace,
  conversation,
  scope,
  skills,
  trust,
  onScope,
  onChanged,
}: {
  workspaceId: string | null;
  /** The selected execution target: where an installation writes. Absent when no workspace is selected. */
  target: ExecutionTarget | null;
  workspace: ExecutionWorkspace | undefined;
  /** The conversation that runs on this target, or null when this target is not its own: then nothing adopts. */
  conversation: string | null;
  scope: InstallScope;
  skills: readonly InstalledSkill[];
  trust?: ProjectTrustStatus | null;
  onScope: (scope: InstallScope) => void;
  /** The inventory is read again after an operation; the outcome stays panel state and is not re-fetched. */
  onChanged: () => void;
}) {
  const { t } = useI18n();
  const execution = useExecutionResources();
  const [query, setQuery] = useState("");
  const [listing, setListing] = useState<LibraryListing | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  // The skills.sh catalog is a separate source with its own request, so its loading, empty and failure states are its
  // own: a catalog that cannot be reached never empties the harness library beside it.
  const [catalog, setCatalog] = useState<{ readonly skills: readonly LibrarySkill[]; readonly unavailable: readonly SearchMiss[] } | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ id: string; document: LibraryPreview | null; error: string | null } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [outcomes, setOutcomes] = useState<Record<string, OperationOutcome>>({});

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const answer = await execution.library.list();
      if (!answer.ok) throw new Error(refusalText(answer.error));
      const body = answer.value;
      setListing({ skills: body.skills, unavailableSources: body.unavailableSources });
    } catch (failure) {
      setLoadError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  /**
   * The catalog query, one request per settled keystroke and cancelled when the next one arrives. An empty box asks
   * the catalog nothing: the harness library is already listed in full, so browsing it needs no query and no
   * conversation.
   */
  useEffect(() => {
    const needle = query.trim();
    if (needle === "") { setCatalog(null); setCatalogLoading(false); setCatalogError(null); return; }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setCatalogLoading(true);
      setCatalogError(null);
      void (async () => {
        try {
          const answer = await execution.library.search(needle, { signal: controller.signal });
          if (!answer.ok) throw new Error(refusalText(answer.error));
          // Every hit that could not be offered is carried beside the ones that could, with the reason the backend
          // reported: a query that lost one repository is not rewritten as "no match", and the readable hits survive.
          setCatalog({ skills: answer.value.skills, unavailable: searchMisses(answer.value.unavailable) });
        } catch (failure) {
          if (controller.signal.aborted) return;
          setCatalogError(failure instanceof Error ? failure.message : String(failure));
          setCatalog(null);
        } finally {
          if (!controller.signal.aborted) setCatalogLoading(false);
        }
      })();
    }, 300);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query]);

  const open = useCallback(async (skill: LibrarySkill) => {
    setPreview({ id: skill.id, document: null, error: null });
    try {
      const answer = await execution.library.preview(skill.id);
      if (!answer.ok) throw new Error(refusalText(answer.error));
      setPreview({ id: skill.id, document: { markdown: answer.value.markdown, files: answer.value.files }, error: null });
    } catch (failure) {
      setPreview({ id: skill.id, document: null, error: failure instanceof Error ? failure.message : String(failure) });
    }
  }, []);

  const install = useCallback(async (skill: LibrarySkill, confirm: boolean) => {
    const directory = directoryOf(skill);
    setBusy(skill.id);
    try {
      const installed = installedAt(skills, directory, wireScope(scope));
      const isUpdate = installed?.install !== undefined;
      // The target is the workspace this pane writes to; a pane without one cannot install at all, which is why the
      // action is disabled there. The conversation is named only when it runs on that same workspace.
      if (target === null) throw new Error(t("skills.noWorkspace"));
      const result = isUpdate
        ? await target.update({
          id: skill.id, name: directory, scope: wireScope(scope), confirm,
          // The digest set this pane was shown pins the replacement to the content the user saw.
          files: installed!.install!.files,
          ...(conversation === null ? {} : { conversationId: conversation }),
        })
        : await target.install({ id: skill.id, scope: wireScope(scope), ...(conversation === null ? {} : { conversationId: conversation }) });
      // The host refuses a replacement it was not asked to confirm, and one whose directory changed since this pane
      // read it: both are reported as the state to review, never as a silent overwrite.
      if (!result.ok && result.error.kind === "disposed") return;
      if (!result.ok && result.error.code === "confirmation_required") {
        setOutcomes((current) => ({ ...current, [skill.id]: { notice: null, error: t("skills.updateNeedsConfirm") } }));
        await open(skill);
        return;
      }
      if (!result.ok && result.error.code === "conflict" && isUpdate) {
        setOutcomes((current) => ({ ...current, [skill.id]: { notice: null, error: t("skills.updateStale") } }));
        onChanged();
        return;
      }
      if (!result.ok) throw new Error(refusalText(result.error));
      const reported = isUpdate
        ? updateOutcome({ name: result.value.installed.name, scope: result.value.installed.scope, adopted: result.value.reload !== undefined, ...(result.value.installed.backup === undefined ? {} : { backup: result.value.installed.backup }), ...(result.value.reload === undefined ? {} : { reload: result.value.reload }) })
        : installOutcome({ name: result.value.installed.name, scope: result.value.installed.scope, adopted: result.value.reload !== undefined, ...(result.value.reload === undefined ? {} : { reload: result.value.reload }) });
      setOutcomes((current) => ({ ...current, [skill.id]: reported }));
      // The list is read again so the panel shows the host's state; the outcome stays, because it is not list state.
      onChanged();
    } catch (failure) {
      setOutcomes((current) => ({ ...current, [skill.id]: { notice: null, error: t("skills.operationFailed") + ": " + (failure instanceof Error ? failure.message : String(failure)) } }));
    } finally {
      setBusy(null);
    }
  }, [conversation, onChanged, open, scope, skills, t, target]);

  const needle = query.trim().toLocaleLowerCase();
  // The harness library is listed in full and narrowed here; the catalog is queried for the same words. Both sources
  // are shown as their own block with their own state, so which one answered is never ambiguous.
  const library = (listing?.skills ?? []).filter((skill) => needle === "" || [skill.name, skill.description, sourceLabelOf(skill, t("skills.source.repository"))].some((text) => text.toLocaleLowerCase().includes(needle)));
  const unavailable = listing?.unavailableSources ?? [];
  const libraryState = sourceState({ loading: loading && listing === null, error: loadError, count: library.length });
  // The catalog is only queried for words the user typed, so an empty box is not a catalog that answered nothing.
  // A source that failed is only the state of the source when it returned nothing at all: a query that lost one
  // repository still shows the hits it did answer.
  const catalogSkills = catalog?.skills ?? [];
  const catalogMisses = catalog?.unavailable ?? [];
  // A query that returned hits is ready even when some rows were dropped: those rows are named beside the hits.
  const catalogStatus: SourceState = catalogState({ queried: needle !== "", loading: catalogLoading, error: catalogError, count: catalogSkills.length, misses: catalogMisses });

  /** The state line of one source: loading, empty, or the failure it actually reported, always naming the source. */
  const sourceMessage = (source: string, state: SourceState, error: string | null): ReactNode => {
    const label = source === "repository" ? t("skills.source.repository") : t("skills.source.skillsSh");
    if (state === "idle") return t("market.sourceIdle", { source: label });
    if (state === "loading") return t("market.sourceLoading", { source: label });
    if (state === "failed") return t("market.sourceFailed", { source: label }) + ": " + (error ?? "");
    if (state === "empty") return t("market.sourceEmpty", { source: label });
    return null;
  };

  return (
    <ConfigDetailStack className="is-full-height">
      <ConfigAddSourceHeading
        title={t("i18n.addSkill")}
        catalogs={[{ href: "https://skills.sh", label: "skills.sh" }]}
        target={
          <ConfigSaveTarget
            value={scope}
            label={t("config.saveTo")}
            options={[
              { value: "global", label: scopeLabel("global", t) },
              { value: "project", label: scopeLabel("project", t), disabled: workspaceId === null },
            ]}
            path={scope === "global"
              ? (workspace?.host === undefined ? t("skills.hostUnknown") : workspace.host.home + "/.agents/skills/")
              : (workspace?.workspaceRoot ?? t("skills.hostUnknown")) + "/.agents/skills/"}
            disabledReason={workspaceId === null ? t("skills.noWorkspace") : null}
            onChange={(value) => onScope(value)}
          />
        }
      />

      {trust?.requiresTrust === true && trust.trusted === false && <ConfigTrustNotice message={t("trust.skillsNotLoaded")} />}

      <div style={{ display: "flex", gap: 8 }}>
        <input
          value={query}
          aria-label={t("i18n.skillSearchPlaceholder")}
          placeholder={t("i18n.skillSearchPlaceholder")}
          onChange={(event) => setQuery(event.target.value)}
          className="config-add-source-input"
        />
        <ConfigButton onClick={() => void load()} disabled={loading}>{t("market.refresh")}</ConfigButton>
      </div>

      {unavailable.length > 0 && <ConfigNotice><span className="skill-outcome">{t("market.unavailableSources") + ": " + unavailable.join(", ")}</span></ConfigNotice>}

      {([["repository", library, libraryState, loadError], ["skills.sh", catalogSkills, catalogStatus, catalogError]] as const).map(([source, entries, state, error]) => (
        <ConfigDetailStack key={source} className="market-source">
          <ConfigSidebarGroupLabel>
            {source === "repository" ? t("skills.source.repository") : t("skills.source.skillsSh")}
          </ConfigSidebarGroupLabel>
          {source === "skills.sh" && catalogMisses.length > 0 && (
            <ConfigNotice>
              <span className="skill-outcome">
                {catalogMisses.map((miss) => miss.source + ": " + t("market.searchMiss." + miss.reason)).join("; ")}
              </span>
            </ConfigNotice>
          )}
          {state !== "ready"
            ? <ConfigEmptyState><span className={state === "failed" ? "skill-outcome is-error" : "skill-outcome"}>{sourceMessage(source, state, error)}</span></ConfigEmptyState>
            : (
              <ul className="market-cards">
                {entries.map((skill) => {
                  const directory = directoryOf(skill);
                  const installed = installedAt(skills, directory, wireScope(scope));
                  const outcome = outcomes[skill.id];
                  const isBusy = busy === skill.id;
                  return (
                    <li key={skill.id}>
                      <div className="market-card is-static">
                        <span className="market-card-name">{skill.name}</span>
                        <span className="market-card-description">{skill.description === "" ? t("market.noDescription") : skill.description}</span>
                        <span className="market-card-meta">
                          {sourceLabelOf(skill, t("skills.source.repository"))} · {revisionOf(skill)}
                        </span>
                        <span className="market-preview-actions">
                          <ConfigButton size="small" onClick={() => void open(skill)}>{t("skills.preview")}</ConfigButton>
                          <ConfigButton
                            size="small"
                            variant={installed?.revision === "update-available" ? "primary" : "secondary"}
                            disabled={target === null || isBusy}
                            title={t("skills.installTo", { scope: scopeLabel(scope, t), host: hostLabel(workspace) })}
                            onClick={() => void install(skill, true)}
                          >
                            {installed?.install === undefined
                              ? isBusy ? t("i18n.installing") : t("i18n.install")
                              : installed.install.scope !== wireScope(scope)
                                ? isBusy ? t("i18n.installing") : t("i18n.install")
                                : installed.revision === "update-available"
                                  ? isBusy ? t("i18n.updating") : t("i18n.update")
                                  : t("i18n.installed")}
                          </ConfigButton>
                        </span>
                        {outcome?.notice !== null && outcome?.notice !== undefined && <span className="skill-outcome">{outcome.notice}</span>}
                        {outcome?.error !== null && outcome?.error !== undefined && <span className="skill-outcome is-error">{outcome.error}</span>}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
        </ConfigDetailStack>
      ))}

      {preview !== null && (
        <ConfigDetailStack className="is-fill">
          <ConfigField label={t("skills.preview")}>
            <span className="skill-name-value">{preview.id}</span>
          </ConfigField>
          {preview.error !== null && <ConfigNotice><span className="skill-outcome is-error">{t("market.previewError") + ": " + preview.error}</span></ConfigNotice>}
          {preview.document !== null && (
            <>
              <ConfigField label={t("market.fieldDocument")}>
                <span className="skill-description">{preview.document.markdown}</span>
              </ConfigField>
              <ConfigField label={t("market.files")}>
                <span className="skill-description">
                  {preview.document.files.length === 0
                    ? t("market.bundleEmpty")
                    : preview.document.files.map((file) => file.path + (file.encoding === "base64" ? " " + t("market.encodingBase64") : "")).join(", ")}
                </span>
              </ConfigField>
            </>
          )}
          <div>
            <ConfigButton size="small" onClick={() => setPreview(null)}>{t("i18n.close")}</ConfigButton>
          </div>
        </ConfigDetailStack>
      )}
    </ConfigDetailStack>
  );
}

/**
 * The builtin Skills panel. Installed skills come from the selected execution workspace's own resource discovery, so
 * they are the host's real content with the host's own paths; the harness library is a source within the same
 * global/project installation flow, never a third destination. Browsing needs no active conversation, and an
 * installation names the execution target it writes to.
 */
export function SkillsConfig({
  cwd,
  sessionId,
  onClose,
  embedded = false,
  trust,
}: {
  /** The folder Settings was opened for; it names the session's own execution workspace when it has one. */
  cwd?: string | null;
  /** The conversation this Settings was opened from, so an installation can ask exactly it to reload. */
  sessionId?: string | null;
  onClose: () => void;
  embedded?: boolean;
  /** The page's trust status for `cwd`; a new decision loads the inventory again. */
  trust?: ProjectTrustStatus | null;
}) {
  const { t } = useI18n();
  const connection = useWorkbenchConnection();
  const [workspaces, setWorkspaces] = useState<readonly ExecutionWorkspace[] | null>(null);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [inventory, setInventory] = useState<SkillInventory | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(() => getLastSettingsSelection("skills", cwd));
  const [scope, setScope] = useState<InstallScope>("global");
  const [addMode, setAddMode] = useState(false);
  const [outcomes, setOutcomes] = useState<Record<string, OperationOutcome>>({});
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [checking, setChecking] = useState(false);
  const [groupBusy, setGroupBusy] = useState<string | null>(null);
  const [groupStatus, setGroupStatus] = useState<{ group: string; error?: string | null; note?: string | null } | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  // The projects recorded for this Web origin. A project's skills belong to the folder that project's own default names
  // (ticket 09), so a Project operation targets that folder even while the sidebar is showing another one of its
  // folders — and a Project whose default is on a host this origin does not serve is not offered as a target at all.
  const [projects, setProjects] = useState<readonly ProjectRouting[]>([]);

  // The configured execution workspaces, each with the account its tools actually run as.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await connection.client.request("/api/workspaces", { cache: "no-store" });
        const body = await response.json() as { workspaces?: readonly ExecutionWorkspace[]; error?: string };
        if (!response.ok || body.error) throw new Error(body.error ?? "HTTP " + response.status);
        if (cancelled) return;
        // A workspace a Project removal retained is never an installation target: it is left out of the selector here,
        // exactly as it is left out of every new-session picker.
        const list = selectableWorkspaces(body.workspaces ?? []);
        setWorkspaces(list);
        setWorkspaceId((current) => current ?? initialWorkspaceId(list, cwd));
      } catch (failure) {
        if (!cancelled) setError(failure instanceof Error ? failure.message : String(failure));
      }
    })();
    return () => { cancelled = true; };
  }, [connection, cwd]);

  // The projects this origin serves, so a Project scope can resolve the folder the project itself names as default
  // rather than whichever of its folders happens to be open in the sidebar.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await connection.client.request("/api/projects", { cache: "no-store" });
        const body = await response.json() as { projects?: readonly ProjectRouting[] };
        if (!cancelled && response.ok) setProjects(body.projects ?? []);
      } catch {
        // Projects are optional metadata here: without them only the explicit execution hosts are offered, which is
        // exactly the state a deployment with no recorded projects is in.
      }
    })();
    return () => { cancelled = true; };
  }, [connection]);

  /**
   * The target the sidebar is showing. Selecting is what retires the previous one, so the panel's own reads and its
   * detail actions share this scope and a late answer for the host the user left is refused by the connection.
   */
  const selectedTarget = useExecutionTarget(workspaceId);
  /** Whether a read's target is the one on screen now; see {@link useTargetFence}. */
  const belongsTo = useTargetFence(selectedTarget);

  // One read of the host's inventory may be overtaken by the next one: switching execution target, pressing Refresh
  // and an operation's own refresh all start reads, and the slowest answer is not necessarily the one that was asked
  // for last. The fence is the **selection**, not a counter: switching target disposes the target that asked, and the
  // connection refuses its late answer as `disposed`, so an earlier host's answer cannot replace the skills of the host
  // the sidebar shows.
  const loadSkills = useCallback(async (target: ExecutionTarget) => {
    setLoading(true);
    setError(null);
    // Every completion of this read — the answer, the failure, and the end of loading — belongs to the target that
    // asked. A read whose target is no longer on screen writes nothing at all: not the previous host's skills, and not
    // its error either, and it does not end the loading state of the read that replaced it.
    const stillShown = () => belongsTo(target);
    try {
      const answer = await target.inventory();
      if (!stillShown()) return;
      if (!answer.ok && answer.error.kind === "disposed") return;
      if (!answer.ok) throw new Error(refusalText(answer.error));
      setInventory(answer.value);
      setSelected((current) => {
        if (current && answer.value.skills.some((skill) => skill.filePath === current)) return current;
        return answer.value.skills[0]?.filePath ?? null;
      });
    } catch (failure) {
      if (!stillShown()) return;
      setError(failure instanceof Error ? failure.message : String(failure));
      setInventory(null);
    } finally {
      if (stillShown()) setLoading(false);
    }
  }, [belongsTo]);

  // Whether the project's skills load follows its trust, which can change while this section stays mounted (hidden)
  // in Settings: trusting from Settings › MCP. A new decision loads the inventory again in place, keeping the
  // selection and the workspace choice; the first load is the effect above.
  const trustKey = projectTrustReloadKey(trust);
  const loadedTrustKeyRef = useRef(trustKey);
  useEffect(() => {
    if (loadedTrustKeyRef.current === trustKey) return;
    loadedTrustKeyRef.current = trustKey;
    setReloadKey((key) => key + 1);
  }, [trustKey]);

  useEffect(() => {
    if (selected) setLastSettingsSelection("skills", selected, cwd);
  }, [cwd, selected]);

  /**
   * Where a **project-scope** operation is written. When the selected execution target is one folder of a recorded
   * project, the project's own **default** folder is the target, even while the sidebar shows a different folder of that
   * project: a project's work belongs to the folder the project itself names, which is what every other part of the app
   * already does. A target that belongs to no project is its own folder, which is the case for a plain configured
   * workspace. A global operation is not a project operation at all, so it targets the selected host instead.
   */
  const projectWorkspaceId = workspaceId === null ? null : (projectGroupOfPath(projects, folderRoutingPath(workspaceId)) === null ? workspaceId : projectDefaultWorkspaceId(projects, workspaceId));
  /**
   * The execution target one operation actually writes to. The scope is the **installation's** own, not the add pane's:
   * a detail action acts on the skill in front of the user, so it writes where that skill lives, and the add pane's
   * chosen destination cannot redirect it somewhere else.
   */
  const writeTarget = (wireScope_: "global" | "workspace"): string | null => wireScope_ === "workspace" ? projectWorkspaceId : workspaceId;

  /**
   * The add pane writes to the folder its scope resolves to, which for a Project is the project's own default and so is
   * often not the folder the sidebar shows. It therefore needs a target of **that** workspace: the selected one when
   * they are the same folder, and a target selected for the resolved folder otherwise, so the pane can install where it
   * says it will instead of finding no target at all.
   */
  const addWorkspaceId = writeTarget(wireScope(scope));
  // Only while the pane is open, and only when it writes somewhere other than the folder on screen.
  const offSelectedAddTarget = useExecutionTarget(addMode && addWorkspaceId !== workspaceId ? addWorkspaceId : null);
  const addTarget = addWorkspaceId === null ? null : addWorkspaceId === workspaceId ? selectedTarget : offSelectedAddTarget;

  /**
   * One operation against a workspace that may not be the selected one — a Project operation writes to the project's
   * own default folder while the sidebar shows another. A target that is not the selected one is created for this call
   * and disposed in the same frame, so no second scope outlives the operation.
   */
  const withTarget = useCallback(async <T,>(id: string | null, work: (target: ExecutionTarget) => Promise<T>): Promise<T> => {
    if (id === null) throw new Error(t("skills.noWorkspace"));
    if (selectedTarget !== null && selectedTarget.workspaceId === id) return await work(selectedTarget);
    const temporary = connection.client.execution.select(id);
    try { return await work(temporary); } finally { temporary.dispose(); }
  }, [connection, selectedTarget, t]);

  useEffect(() => {
    if (selectedTarget !== null) void loadSkills(selectedTarget);
  }, [selectedTarget, loadSkills, reloadKey]);

  // A selection change starts from nothing: the previous host's skills, its selected row and its failure are not facts
  // about the host being shown. The list is cleared here rather than left until the new answer arrives, so a slow host
  // cannot leave another host's inventory on screen under its own name.
  useEffect(() => {
    setInventory(null);
    setError(null);
    setLoading(true);
  }, [workspaceId]);

  const workspace = workspaces?.find((item) => item.id === workspaceId);
  // The conversation this Settings was opened from, and the workspace it is actually bound to: the session's cwd is
  // the workspace path the backend itself reports, so no second mapping is invented here.
  const sessionWorkspaceId = workspaceIdFromCwd(cwd);
  const skills = inventory?.skills ?? [];
  const selectedSkill = skills.find((skill) => skill.filePath === selected) ?? null;

  // An outcome is keyed by the host directory it happened to, because the display name need not match it.
  const outcomeKey = (skill: InstalledSkill): string => (skill.install?.scope ?? "global") + "\0" + skill.directory;

  const runUpdate = useCallback(async (skill: InstalledSkill, confirm: boolean) => {
    const id = availableBundleId(skill);
    const install = skill.install;
    if (id === undefined || install === undefined) return;
    setBusy(true);
    setError(null);
    try {
      const workspaceOfOperation = writeTarget(install.scope);
      if (workspaceOfOperation === null) throw new Error(t("skills.noWorkspace"));
      // Only a conversation that runs exactly on this target is asked to adopt; a write that lands on another folder
      // of the project names no conversation, because nothing there belongs to the one that asked.
      const adopted = conversationTarget(sessionId, sessionWorkspaceId, workspaceOfOperation);
      const answer = await withTarget(workspaceOfOperation, target => target.update({
        id, name: install.directory, scope: install.scope, confirm, files: install.files,
        ...(adopted === null ? {} : { conversationId: adopted }),
      }));
      if (!answer.ok && answer.error.kind === "disposed") return;
      if (!answer.ok && answer.error.code === "confirmation_required") {
        setConfirming(true);
        setOutcomes((current) => ({ ...current, [outcomeKey(skill)]: { notice: null, error: t("skills.updateNeedsConfirm") } }));
        return;
      }
      if (!answer.ok && answer.error.code === "conflict") {
        setConfirming(false);
        setOutcomes((current) => ({ ...current, [outcomeKey(skill)]: { notice: null, error: t("skills.updateStale") } }));
        setReloadKey((key) => key + 1);
        return;
      }
      if (!answer.ok) throw new Error(refusalText(answer.error));
      const result = answer.value;
      const reported = updateOutcome({
        name: result.installed.name,
        scope: result.installed.scope,
        adopted: result.reload !== undefined,
        ...(result.installed.backup === undefined ? {} : { backup: result.installed.backup }),
        ...(result.reload === undefined ? {} : { reload: result.reload }),
      });
      setOutcomes((current) => ({ ...current, [outcomeKey(skill)]: reported }));
      setConfirming(false);
      // The host's state is read again; the outcome above is panel state, so it survives this refresh.
      setReloadKey((key) => key + 1);
    } catch (failure) {
      setOutcomes((current) => ({ ...current, [outcomeKey(skill)]: { notice: null, error: t("skills.operationFailed") + ": " + (failure instanceof Error ? failure.message : String(failure)) } }));
    } finally {
      setBusy(false);
    }
  }, [sessionId, sessionWorkspaceId, t, withTarget, workspaceId]);

  /**
   * Switch one skill, through the canonical toggle the panel already offered: the body names the SKILL.md paths, and
   * the route writes the execution-side documents. The host answers each directory on its own, so what happened is
   * read per directory rather than assumed from the status, and the inventory is read again because the host's
   * discovery is the source of truth for what the document now declares.
   */
  const runToggle = useCallback(async (targets: readonly InstalledSkill[], enabled: boolean, group: string | null) => {
    if (targets.length === 0) return;
    if (group === null) setToggling(true);
    else setGroupBusy(group);
    if (group !== null) setGroupStatus({ group, error: null, note: null });
    try {
      const first = targets[0]!;
      const installedScope = first.install?.scope ?? (first.scope === "project" ? "workspace" : "global");
      const workspaceOfOperation = writeTarget(installedScope);
      const adopted = conversationTarget(sessionId, sessionWorkspaceId, workspaceOfOperation);
      // The host names each directory it switched, so the panel reads the answer per directory rather than inferring it
      // from the status: a refusal of one document is not a failed request.
      const answer = await withTarget(workspaceOfOperation, (selected) => selected.toggle({
        directories: targets.map((skill) => skill.directory),
        disableModelInvocation: !enabled,
        scope: installedScope,
        ...(adopted === null ? {} : { conversationId: adopted }),
      }));
      if (!answer.ok && answer.error.kind === "disposed") return;
      if (!answer.ok) throw new Error(refusalText(answer.error));
      const result = answer.value;
      const outcome = toggleOutcome(result);
      if (group === null) {
        // A single switch reports the one directory, whether the host changed it or refused it, and the reload outcome
        // stays a separate fact: the document is written either way.
        const directory = targets[0]!.directory;
        const failed = outcome.failed.find((item) => item.directory === directory);
        setOutcomes((current) => ({
          ...current,
          [outcomeKey(targets[0]!)]: failed !== undefined
            ? { notice: null, error: t("skills.toggleFailed") + ": " + failed.error }
            : { notice: t(outcome.changed.includes(directory) ? "skills.toggleChanged" : "skills.toggleUnchanged", { name: directory }), error: result.reload?.ok === false ? "Reload failed: " + result.reload.error : null },
        }));
      } else {
        // A group switch names what it left undone rather than reporting success for the whole group.
        const kept = targets.filter((skill) => !outcome.changed.includes(skill.directory));
        setGroupStatus({
          group,
          error: outcome.failed.length === 0 ? null : t("skills.toggleFailedGroup", { count: String(outcome.failed.length), total: String(targets.length) }) + " " + outcome.failed.map((item) => item.directory + ": " + item.error).join("; "),
          note: outcome.failed.length === 0 && kept.length === 0 ? t("skills.toggleGroupDone") : null,
        });
      }
      setReloadKey((key) => key + 1);
    } catch (failure) {
      const message = t("skills.operationFailed") + ": " + (failure instanceof Error ? failure.message : String(failure));
      if (group === null) setOutcomes((current) => ({ ...current, [outcomeKey(targets[0]!)]: { notice: null, error: message } }));
      else setGroupStatus({ group, error: message, note: null });
    } finally {
      if (group === null) setToggling(false);
      else setGroupBusy(null);
    }
  }, [sessionId, sessionWorkspaceId, t, withTarget, workspaceId]);

  /**
   * Ask the repository what the installed revision is. This is the only request that reaches GitHub, and it happens
   * because the user asked: listing the host's skills never does. The answer names the revision it compared, and the
   * pinned selection an update would install when the repository has moved.
   */
  const runCheck = useCallback(async (skill: InstalledSkill) => {
    setChecking(true);
    try {
      const installedScope = skill.install?.scope ?? wireScope(scope);
      const answer = await withTarget(writeTarget(installedScope), (target) => target.check({ name: skill.directory, scope: installedScope }));
      if (!answer.ok && answer.error.kind === "disposed") return;
      if (!answer.ok) throw new Error(refusalText(answer.error));
      const body = answer.value;
      // The revision the repository now holds is not drawn from the list: only this answer changes what the panel
      // shows, so a check that moved nothing leaves an already listed installation exactly as it was.
      setOutcomes((current) => ({ ...current, [outcomeKey(skill)]: checkOutcome({ check: body, error: null, skill }) }));
    } catch (failure) {
      setOutcomes((current) => ({ ...current, [outcomeKey(skill)]: checkOutcome({ check: undefined, error: t("skills.operationFailed") + ": " + (failure instanceof Error ? failure.message : String(failure)), skill }) }));
    } finally {
      setChecking(false);
    }
  }, [scope, t, withTarget, workspaceId]);

  const toggleGroup = useCallback((group: string, groupSkills: readonly InstalledSkill[], enabled: boolean) => {
    // Only the rows not already in the requested state are switched, which is the rule the group heading's own switch
    // has always used, so a group already on answers an empty request rather than rewriting every document.
    const targets = itemsToSwitch([...groupSkills], enabled, (skill) => !skill.disableModelInvocation);
    void runToggle(targets, enabled, group);
  }, [runToggle]);

  const groups: { scope: "global" | "project" | "path"; skills: InstalledSkill[] }[] = [
    { scope: "project", skills: skills.filter((skill) => skill.scope === "project") },
    { scope: "global", skills: skills.filter((skill) => skill.scope === "global") },
    { scope: "path", skills: skills.filter((skill) => skill.scope === "path") },
  ];

  return (
    <ConfigPanelShell embedded={embedded} title={t("common.skills")} subtitle={workspace === undefined ? "" : hostLabel(workspace)} closeLabel={t("i18n.close")} onClose={onClose}>
      {workspace === undefined ? null : workspace.host === undefined ? (
        <ConfigNotice><span className="skill-outcome is-error">{t("skills.hostUnreachable", { error: workspace.hostError ?? t("i18n.unknown") })}</span></ConfigNotice>
      ) : null}

      <ConfigSplitView>
        <ConfigSidebar>
          {/* The execution target is explicit: the workspace whose host the skills are read from and installed to. */}
          <div className="config-sidebar-group">
            <ConfigSidebarGroupLabel>{t("skills.executionHost")}</ConfigSidebarGroupLabel>
            {(workspaces ?? []).map((item) => (
              <ConfigSidebarItem key={item.id} active={item.id === workspaceId} onClick={() => { setWorkspaceId(item.id); setAddMode(false); }}>
                <ConfigStatusDot active={item.host !== undefined} />
                <ConfigSidebarText className="is-grow">{hostLabel(item)}</ConfigSidebarText>
              </ConfigSidebarItem>
            ))}
          </div>
          <ConfigSidebarList>
            {loading ? (
              <div className="config-sidebar-message">{t("i18n.loading")}</div>
            ) : error !== null ? (
              <div className="config-sidebar-message is-error">{error}</div>
            ) : skills.length === 0 ? (
              <div className="config-sidebar-message is-empty">{t("i18n.noSkills")}</div>
            ) : (
              groups.filter((group) => group.skills.length > 0).map((group) => (
                <div key={group.scope} className="config-sidebar-group">
                  <ConfigSidebarGroupLabel
                    aside={group.scope === "path" ? undefined : (
                      <ConfigSidebarGroupSwitch
                        enabled={group.skills.filter((skill) => !skill.disableModelInvocation).length}
                        total={group.skills.length}
                        disabled={groupBusy !== null || toggling}
                        loading={groupBusy === group.scope}
                        label={t(allActive(group.skills) ? "skills.groupSwitchOff" : "skills.groupSwitchOn", { group: groupLabel(group.scope, t) })}
                        onChange={(enabled) => toggleGroup(group.scope, group.skills, enabled)}
                      />
                    )}
                  >
                    {groupLabel(group.scope, t)}
                  </ConfigSidebarGroupLabel>
                  {groupStatus?.group === group.scope && <ConfigSidebarGroupStatus error={groupStatus.error} note={groupStatus.note} />}
                  {orderSkillsByDormancy(group.skills).map((skill) => (
                    <ConfigSidebarItem
                      key={skill.filePath}
                      active={!addMode && selected === skill.filePath}
                      onClick={() => { setSelected(skill.filePath); setAddMode(false); setConfirming(false); }}
                    >
                      <ConfigStatusDot active={!skill.disableModelInvocation} />
                      <ConfigSidebarText className={"is-grow" + (skill.disableModelInvocation ? " is-muted" : "")}>{skill.name}</ConfigSidebarText>
                      {skill.revision === "update-available" && <span title={t("i18n.updateAvailable")} className="skill-update-indicator">↑</span>}
                      {skill.install?.state === "locally-modified" && <span title={t("skills.local.modified")} className="skill-update-indicator">*</span>}
                    </ConfigSidebarItem>
                  ))}
                </div>
              ))
            )}
          </ConfigSidebarList>
          <ConfigListAction onClick={() => setAddMode(true)} active={addMode}>{t("i18n.addSkill")}</ConfigListAction>
        </ConfigSidebar>

        <ConfigDetail>
          <ConfigDetailStack className="is-fill">
            {addMode ? (
              <AddSkillPanel
                workspaceId={addWorkspaceId}
                target={addTarget}
                workspace={workspaces?.find((item) => item.id === addWorkspaceId)}
                conversation={conversationTarget(sessionId, sessionWorkspaceId, addWorkspaceId)}
                scope={scope}
                skills={skills}
                trust={trust}
                onScope={setScope}
                onChanged={() => setReloadKey((key) => key + 1)}
              />
            ) : loading ? null : selectedSkill !== null ? (
              <SkillDetail
                key={selectedSkill.filePath}
                skill={selectedSkill}
                scope={scope}
                workspace={workspace}
                outcome={outcomes[outcomeKey(selectedSkill)]}
                busy={busy}
                confirming={confirming}
                toggling={toggling}
                checking={checking}
                canCheck={canCheckForUpdate(selectedSkill)}
                onUpdate={() => void runUpdate(selectedSkill, false)}
                onConfirm={() => void runUpdate(selectedSkill, true)}
                onCancelConfirm={() => setConfirming(false)}
                onToggle={(disableModelInvocation) => void runToggle([{ ...selectedSkill, disableModelInvocation }], !disableModelInvocation, null)}
                onCheck={() => void runCheck(selectedSkill)}
              />
            ) : (
              <ConfigEmptyState>{t("i18n.selectSkill")}</ConfigEmptyState>
            )}
          </ConfigDetailStack>
        </ConfigDetail>
      </ConfigSplitView>

      <ConfigFooter status={workspace?.host === undefined ? null : <span style={{ fontSize: 12, color: "var(--text-dim)" }}>{t("skills.installTarget", { host: hostLabel(workspace), scope: scopeLabel(scope, t) })}</span>}>
        {!embedded && <ConfigButton onClick={onClose}>{t("i18n.close")}</ConfigButton>}
        <ConfigButton variant="secondary" onClick={() => setReloadKey((key) => key + 1)} disabled={loading || workspaceId === null}>{t("market.refresh")}</ConfigButton>
      </ConfigFooter>
    </ConfigPanelShell>
  );
}
