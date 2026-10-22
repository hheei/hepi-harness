"use client";

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { useI18n } from "../hooks/useI18n";
import { useIsMobile } from "../hooks/useIsMobile";
import type { ProjectTrustStatus } from "@hepi/protocol/mcp-ui";
import { shortenPath } from "../lib/display-path";
import {
  AGENT_DEFINITION_SCOPES,
  agentDefinitionKey,
  capabilitiesOf,
  type AgentDefinitionCapabilities,
  type AgentDefinitionContextStrategy,
  type AgentDefinitionFields,
  type AgentDefinitionIssue,
  type AgentDefinitionScope,
  type AgentDefinitionView,
} from "../lib/agent-definitions";
import {
  getLastSettingsSelection,
  setLastSettingsSelection,
} from "../lib/settings-navigation";
import { workspaceIdFromCwd } from "../lib/skill-inventory";
import { useConversationRefreshes, useExecutionTarget, useTargetFence } from "../lib/workbench-scope";
import type { ExecutionTarget } from "@hepi/session/execution-resources";
import {
  ConfigButton,
  ConfigDetail,
  ConfigDetailActions,
  ConfigDetailHeader,
  ConfigDetailHeaderInfo,
  ConfigDetailStack,
  ConfigEmptyState,
  ConfigField,
  ConfigFooter,
  ConfigListAction,
  ConfigPanelShell,
  ConfigSaveTarget,
  ConfigScopeTag,
  ConfigSidebar,
  ConfigSidebarGroupLabel,
  ConfigSidebarItem,
  ConfigSidebarList,
  ConfigSidebarText,
  ConfigSplitView,
  ConfigStatusDot,
  ConfigSwitch,
} from "./SettingsUi";

type EditorMode = "view" | "edit" | "create";
type DocumentMode = "form" | "raw";

const inputStyle: CSSProperties = {
  width: "100%",
  minWidth: 0,
  height: 34,
  padding: "0 9px",
  border: "1px solid var(--border)",
  borderRadius: 5,
  background: "var(--bg)",
  color: "var(--text)",
  fontSize: 12,
  outline: "none",
};

const disabledInputStyle: CSSProperties = { background: "var(--bg-panel)", color: "var(--text-dim)", cursor: "default" };

type Draft = {
  name: string;
  description: string;
  model: string;
  thinking: string;
  tools: string[];
  context: AgentDefinitionContextStrategy;
  enabled: boolean;
  instructions: string;
};

/**
 * A new definition starts from what the backend says it can execute, so a default the panel offers is a default the
 * save accepts. The tool list is the whole installed vocabulary, which is also the framework's own default for an
 * unset `tools` field.
 */
function emptyDraft(capabilities: AgentDefinitionCapabilities): Draft {
  return {
    name: "custom-agent",
    description: "",
    model: "",
    thinking: "",
    tools: [...capabilities.tools],
    context: "fresh",
    enabled: true,
    instructions: "",
  };
}

function draftOf(definition: AgentDefinitionView): Draft {
  return {
    name: definition.name,
    description: definition.description,
    model: definition.model ?? "",
    thinking: definition.thinking ?? "",
    tools: [...definition.tools],
    context: definition.context,
    enabled: definition.enabled,
    instructions: definition.instructions,
  };
}

function ConfigFieldRow({ label, children }: { label: string; children: React.ReactNode }) {
  return <ConfigField label={label}>{children}</ConfigField>;
}

function Toggle({ checked, disabled, label, onChange }: { checked: boolean; disabled: boolean; label: string; onChange: (checked: boolean) => void }) {
  return (
    <label style={{ display: "flex", alignItems: "center", gap: 7, color: disabled ? "var(--text-dim)" : "var(--text-muted)", fontSize: 12, cursor: disabled ? "default" : "pointer" }}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
      {label}
    </label>
  );
}

export function AgentsConfig({
  cwd,
  displayCwd,
  sessionId = null,
  onClose,
  embedded = false,
  trust: _trust,
}: {
  cwd: string;
  displayCwd?: string | null;
  /**
   * The conversation Settings was opened from. Saving a definition is a change a conversation picks up by re-reading
   * its resources, so this panel asks that conversation — and only that one — to do it; the panel never performs the
   * reload itself and never names a session key.
   */
  sessionId?: string | null;
  onClose: () => void;
  embedded?: boolean;
  trust?: ProjectTrustStatus | null;
}) {
  const isMobile = useIsMobile();
  const { t } = useI18n();
  // The folder Settings was opened for names its execution workspace; the definitions are that target's own documents,
  // read and written through the connection rather than by a path this bundle would have to resolve.
  const target = useExecutionTarget(workspaceIdFromCwd(cwd));
  /** Whether a read's target is the one on screen now; see {@link useTargetFence}. */
  const belongsTo = useTargetFence(target);
  // The conversation's own read, published by the chat that owns it. A saved document is this panel's fact; whether
  // that conversation then picked it up is the conversation's answer, which is what this panel reports.
  const refreshes = useConversationRefreshes();
  const [definitions, setDefinitions] = useState<AgentDefinitionView[]>([]);
  const [shadowed, setShadowed] = useState<AgentDefinitionView[]>([]);
  const [selectedKey, setSelectedKey] = useState<string | null>(() => getLastSettingsSelection("agents", cwd));
  const [capabilities, setCapabilities] = useState<AgentDefinitionCapabilities>(() => capabilitiesOf(undefined));
  const [draft, setDraft] = useState<Draft>(() => emptyDraft(capabilitiesOf(undefined)));
  const [mode, setMode] = useState<EditorMode>("view");
  const [documentMode, setDocumentMode] = useState<DocumentMode>("form");
  const [raw, setRaw] = useState("");
  const [targetScope, setTargetScope] = useState<AgentDefinitionScope>("user");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [validating, setValidating] = useState(false);
  const [savedOk, setSavedOk] = useState(false);
  const [valid, setValid] = useState(false);
  const [issues, setIssues] = useState<readonly AgentDefinitionIssue[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  // What the open conversation established after this panel wrote a document. It is the conversation's answer, not an
  // assumption of this panel's: a reload the chat could not complete is stated as the failure it reported.
  const [conversationRead, setConversationRead] = useState<{ readonly notice?: string; readonly error?: string } | null>(null);

  // A definition another scope shadows is still a definition the user may edit or delete, so the list carries both:
  // the effective ones and the shadowed ones, each marked by the `effective` flag the backend answered with.
  const listed = useMemo(() => [...definitions, ...shadowed], [definitions, shadowed]);
  const selected = useMemo(() => listed.find((definition) => agentDefinitionKey(definition) === selectedKey) ?? null, [listed, selectedKey]);
  const editing = mode !== "view";
  const creating = mode === "create";
  const disabled = !editing || saving || validating;
  const controlStyle = disabled ? { ...inputStyle, ...disabledInputStyle } : inputStyle;
  const displayedPath = creating ? "" : selected?.path ?? "";

  const load = useCallback(async (target: ExecutionTarget, preferredKey?: string) => {
    // Every completion of this read belongs to the target that asked: the folder may have moved, and the previous
    // host's answer — its definitions, its refusal, and the end of loading — is not a fact about the folder on screen.
    const stillShown = () => belongsTo(target);
    setLoading(true);
    setError(null);
    setUnavailable(false);
    try {
      const answer = await target.definitions();
      if (!stillShown()) return;
      // A folder whose owning gateway is not recorded is a configuration state, not a failure: the panel says so
      // instead of offering an editor whose save could only be refused.
      if (!answer.ok && answer.error.code === "configuration_required") { setUnavailable(true); return; }
      // The folder moved while this read was in flight: its answer belongs to the target the panel has left.
      if (!answer.ok && answer.error.kind === "disposed") return;
      if (!answer.ok) throw new Error(answer.error.message === "" ? answer.error.code ?? answer.error.kind : answer.error.message);
      const data = answer.value;
      const stated = capabilitiesOf(data);
      setCapabilities(stated);
      const next = [...data.definitions];
      setDefinitions(next);
      setShadowed([...data.shadowed]);
      const remembered = preferredKey ?? getLastSettingsSelection("agents", cwd);
      const chosen = next.find((definition) => agentDefinitionKey(definition) === remembered) ?? next.find((definition) => definition.scope === "project") ?? next[0] ?? null;
      setSelectedKey(chosen ? agentDefinitionKey(chosen) : null);
      if (chosen) {
        setDraft(draftOf(chosen));
        setRaw(chosen.raw);
        setMode("edit");
      }
    } catch (cause) {
      if (!stillShown()) return;
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (stillShown()) setLoading(false);
    }
  }, [belongsTo, cwd]);

  useEffect(() => { if (target !== null) void load(target); }, [load, target]);
  useEffect(() => { if (selectedKey) setLastSettingsSelection("agents", selectedKey, cwd); }, [cwd, selectedKey]);

  const select = (definition: AgentDefinitionView) => {
    setSelectedKey(agentDefinitionKey(definition));
    setDraft(draftOf(definition));
    setRaw(definition.raw);
    setMode("edit");
    setDocumentMode("form");
    setIssues([]);
    setValid(false);
    setError(null);
  };

  const beginCreate = () => {
    let name = "custom-agent";
    let suffix = 2;
    while (definitions.some((definition) => definition.name === name)) name = "custom-agent-" + suffix++;
    setSelectedKey(null);
    setDraft({ ...emptyDraft(capabilities), name });
    setRaw("");
    setMode("create");
    setDocumentMode("form");
    setTargetScope("user");
    setIssues([]);
    setValid(false);
    setError(null);
  };

  const update = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((current) => ({ ...current, [key]: value }));

  const fields = (): AgentDefinitionFields => ({
    name: draft.name.trim(),
    description: draft.description.trim(),
    model: draft.model.trim(),
    thinking: draft.thinking,
    tools: draft.tools,
    context: draft.context,
    enabled: draft.enabled,
    instructions: draft.instructions,
  });

  const request = async (dryRun: boolean): Promise<void> => {
    if (target === null) throw new Error(t("agents.unavailable"));
    const scope = creating ? targetScope : selected!.scope;
    const name = draft.name.trim();
    // The raw document is the whole request only when the raw editor is showing it; the form's fields are the request
    // otherwise, so a form create sends what the form says rather than the empty document the raw editor starts with.
    const rawMode = documentMode === "raw";
    const answer = await target.saveDefinition({ scope, name, ...(rawMode ? { document: raw } : { fields: fields() }), ...(dryRun ? { dryRun: true } : {}) });
    if (!answer.ok) {
      setIssues(answer.error.issues ?? []);
      throw new Error(answer.error.message === "" ? answer.error.code ?? answer.error.kind : answer.error.message);
    }
    setIssues([]);
    // A raw document names itself, so the reload follows the name the backend saved rather than the draft's.
    if (!dryRun) await load(target, rawMode ? agentDefinitionKey(answer.value.definition) : agentDefinitionKey({ scope, name }));
  };

  const validate = async () => {
    setValidating(true);
    setError(null);
    setValid(false);
    try { await request(true); setValid(true); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setValidating(false); }
  };

  /**
   * Ask the conversation this Settings was opened from to pick the change up.
   *
   * A definition is stored on the execution host, so the conversation that runs there reads it again through its own
   * reload. This panel names only the conversation it was opened for: the operation, the read and the notice belong to
   * that chat, and a conversation nothing is mounted for answers "not_open" rather than a reload this panel never
   * performed.
   */
  const readConversation = useCallback(async () => {
    setConversationRead(null);
    if (sessionId === null) return;
    const outcome = await refreshes.refresh(sessionId);
    if (outcome.status === "reloaded") setConversationRead({ notice: outcome.message });
    else if (outcome.status === "failed") setConversationRead({ error: outcome.message });
    // "superseded" and "not_open" are the conversation having nothing to say about what this panel shows: another
    // conversation is on screen, or none is. Neither is a reload, so neither is reported as one.
  }, [refreshes, sessionId]);

  const save = async () => {
    setSaving(true);
    setError(null);
    setSavedOk(false);
    setConversationRead(null);
    try {
      await request(false);
      setSavedOk(true);
      setTimeout(() => setSavedOk(false), 2000);
      await readConversation();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setSaving(false); }
  };

  const remove = async () => {
    if (!selected) return;
    if (!window.confirm(t("agents.deleteConfirm", { name: selected.name }))) return;
    setSaving(true);
    setError(null);
    try {
      if (target === null) throw new Error(t("agents.unavailable"));
      const answer = await target.removeDefinition({ scope: selected.scope, name: selected.name });
      if (!answer.ok) throw new Error(answer.error.message === "" ? answer.error.code ?? answer.error.kind : answer.error.message);
      await load(target);
      await readConversation();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setSaving(false); }
  };

  if (unavailable) {
    return (
      <ConfigPanelShell embedded={embedded} title={t("common.agents")} subtitle={shortenPath(displayCwd ?? cwd)} closeLabel={t("agents.close")} onClose={onClose}>
        <ConfigEmptyState>{t("agents.unavailable")}</ConfigEmptyState>
      </ConfigPanelShell>
    );
  }

  return (
    <ConfigPanelShell embedded={embedded} title={t("common.agents")} subtitle={shortenPath(displayCwd ?? cwd)} closeLabel={t("agents.close")} onClose={onClose}>
      <ConfigSplitView>
        <ConfigSidebar>
          <ConfigSidebarList>
            {loading ? (
              <div style={{ padding: 10, color: "var(--text-dim)", fontSize: 12 }}>{t("agents.loading")}</div>
            ) : AGENT_DEFINITION_SCOPES.slice().reverse().map((scope) => {
              const scoped = listed.filter((definition) => definition.scope === scope);
              if (scoped.length === 0) return null;
              return (
                <div key={scope} className="config-sidebar-group">
                  <ConfigSidebarGroupLabel>{t("agents.scope." + scope)}</ConfigSidebarGroupLabel>
                  {scoped.map((definition) => (
                    <ConfigSidebarItem key={agentDefinitionKey(definition)} active={selectedKey === agentDefinitionKey(definition) && !creating} onClick={() => select(definition)}>
                      <ConfigStatusDot active={definition.enabled} />
                      <ConfigSidebarText className={"is-grow" + (definition.enabled ? "" : " is-muted")}>{definition.name}</ConfigSidebarText>
                      {!definition.effective && <span className="agents-overridden-label">{t("agents.overridden")}</span>}
                    </ConfigSidebarItem>
                  ))}
                </div>
              );
            })}
          </ConfigSidebarList>
          <ConfigListAction active={creating} onClick={beginCreate}>{t("agents.new")}</ConfigListAction>
        </ConfigSidebar>

        <ConfigDetail>
          <ConfigDetailStack className="is-fill">
            {!selected && !creating ? (
              <ConfigEmptyState>{t("agents.empty")}</ConfigEmptyState>
            ) : (
              <ConfigDetailStack>
                <ConfigDetailHeader>
                  <ConfigDetailHeaderInfo>
                    {creating ? (
                      <ConfigSaveTarget
                        value={targetScope}
                        label={t("config.saveTo")}
                        options={AGENT_DEFINITION_SCOPES.map((scope) => ({ value: scope, label: t("agents.scope." + scope), disabled: saving }))}
                        path=""
                        onChange={(scope: AgentDefinitionScope) => setTargetScope(scope)}
                      />
                    ) : (
                      <>
                        <ConfigScopeTag scope={selected!.scope}>{t("agents.scope." + selected!.scope)}</ConfigScopeTag>
                        <span title={displayedPath} className="config-detail-path">{displayedPath}</span>
                      </>
                    )}
                  </ConfigDetailHeaderInfo>
                  <ConfigDetailActions>
                    <ConfigButton size="small" onClick={() => setDocumentMode(documentMode === "form" ? "raw" : "form")} disabled={saving || validating}>
                      {documentMode === "form" ? t("agents.raw") : t("agents.form")}
                    </ConfigButton>
                    {selected && <ConfigButton variant="danger" size="small" onClick={() => void remove()} disabled={saving || validating}>{t("agents.delete")}</ConfigButton>}
                    <ConfigSwitch checked={draft.enabled} disabled={disabled} label={draft.enabled ? t("agents.disable") : t("agents.enable")} onChange={(checked) => update("enabled", checked)} />
                  </ConfigDetailActions>
                </ConfigDetailHeader>

                {documentMode === "raw" ? (
                  <ConfigFieldRow label={t("agents.prompt")}>
                    <textarea
                      className="agents-system-prompt"
                      aria-label={t("agents.raw")}
                      value={raw}
                      disabled={disabled}
                      onChange={(event) => setRaw(event.target.value)}
                      style={{ ...controlStyle, height: 320, minHeight: 220, padding: 9, overflow: "auto", resize: disabled ? "none" : "vertical", fontFamily: "monospace", lineHeight: 1.5 }}
                    />
                  </ConfigFieldRow>
                ) : (
                  <>
                    <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "minmax(0, 1fr) minmax(0, 1fr)", gap: 12 }}>
                      <ConfigFieldRow label={t("agents.name")}>
                        <input aria-label={t("agents.name")} value={draft.name} disabled={disabled || !creating} onChange={(event) => update("name", event.target.value)} style={controlStyle} />
                      </ConfigFieldRow>
                      <ConfigFieldRow label={t("agents.description")}>
                        <input aria-label={t("agents.description")} value={draft.description} disabled={disabled} onChange={(event) => update("description", event.target.value)} style={controlStyle} />
                      </ConfigFieldRow>
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1fr)", gap: 12 }}>
                      <ConfigFieldRow label={t("agents.model")}>
                        <input aria-label={t("agents.model")} value={draft.model} disabled={disabled} onChange={(event) => update("model", event.target.value)} style={controlStyle} placeholder={t("agents.inherit")} />
                      </ConfigFieldRow>
                      <ConfigFieldRow label={t("agents.thinking")}>
                        <select aria-label={t("agents.thinking")} value={draft.thinking} disabled={disabled} onChange={(event) => update("thinking", event.target.value)} style={controlStyle}>
                          <option value="">{t("agents.inherit")}</option>
                          {capabilities.thinking.map((value) => <option key={value} value={value}>{value}</option>)}
                        </select>
                      </ConfigFieldRow>
                      <ConfigFieldRow label={t("agents.context")}>
                        <select aria-label={t("agents.context")} value={draft.context} disabled={disabled} onChange={(event) => update("context", event.target.value as AgentDefinitionContextStrategy)} style={controlStyle}>
                          {capabilities.contextStrategies.map((value) => <option key={value} value={value}>{t("agents.context." + value)}</option>)}
                        </select>
                      </ConfigFieldRow>
                    </div>
                    <ConfigFieldRow label={t("agents.tools")}>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: "8px 16px" }}>
                        {capabilities.tools.map((tool) => (
                          <Toggle key={tool} label={tool} disabled={disabled} checked={draft.tools.includes(tool)} onChange={(checked) => update("tools", checked ? [...draft.tools, tool] : draft.tools.filter((item) => item !== tool))} />
                        ))}
                      </div>
                    </ConfigFieldRow>
                    <ConfigFieldRow label={t("agents.prompt")}>
                      <textarea className="agents-system-prompt" aria-label={t("agents.prompt")} value={draft.instructions} disabled={disabled} onChange={(event) => update("instructions", event.target.value)} style={{ ...controlStyle, height: 195, minHeight: 195, maxHeight: "60vh", padding: 9, overflow: "auto", resize: disabled ? "none" : "vertical", lineHeight: 1.5 }} />
                    </ConfigFieldRow>
                  </>
                )}

                {issues.length > 0 && (
                  <ConfigFieldRow label={t("agents.issues")}>
                    <ul role="alert" style={{ margin: 0, paddingLeft: 18, color: "#ef4444", fontSize: 12, lineHeight: 1.5 }}>
                      {issues.map((issue, index) => <li key={index}><strong>{issue.code}</strong> · {issue.field}: {issue.message}</li>)}
                    </ul>
                  </ConfigFieldRow>
                )}
              </ConfigDetailStack>
            )}
          </ConfigDetailStack>
        </ConfigDetail>
      </ConfigSplitView>
      <ConfigFooter status={
        // Three separate facts, each in its own words: whether the document itself was saved and validated, whether the
        // conversation read the change, and the reason anything failed. A save this panel performed is never reported as
        // a reload the conversation did not confirm.
        error !== null ? (
          <span role="alert" style={{ color: "#ef4444" }}>{error}</span>
        ) : conversationRead?.error !== undefined ? (
          // The conversation's own sentence, stated as it reported it: the definition was saved either way, and a
          // reload that failed says so rather than being dressed up as one that worked.
          <span role="alert" style={{ color: "#ef4444" }}>{conversationRead.error}</span>
        ) : conversationRead?.notice !== undefined ? (
          <span role="status" style={{ color: "var(--text-dim)" }}>{conversationRead.notice}</span>
        ) : valid ? (
          <span role="status" style={{ color: "var(--text-dim)" }}>{t("agents.valid")}</span>
        ) : null
      }>
        {editing && (
          <>
            <ConfigButton onClick={() => void validate()} disabled={saving || validating || (!creating && draft.name.trim() === "")}>{validating ? t("agents.validating") : t("agents.validate")}</ConfigButton>
            <ConfigButton
              variant="primary"
              onClick={() => void save()}
              disabled={saving || savedOk || validating || draft.name.trim() === ""}
              className={savedOk ? "is-success" : undefined}
            >
              {savedOk ? t("i18n.saved") : saving ? t("agents.saving") : t("agents.save")}
            </ConfigButton>
          </>
        )}
      </ConfigFooter>
    </ConfigPanelShell>
  );
}
