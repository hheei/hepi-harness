"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../hooks/useI18n";
import { delegateAttemptKey, delegateRequestId, delegateSettled, type DelegateAttempts, type DelegateRefusal } from "../lib/delegate-attempt";
import { delegateFrom, listDelegateDefinitions, type DelegateDefinition } from "../lib/delegate-client";
import { workspaceIdFromCwd } from "../lib/skill-inventory";
import { useExecutionTarget, useTargetFence, useWorkbenchConnection } from "../lib/workbench-scope";
import type { SessionInfo } from "../lib/types";
import { ConfigButton, ConfigDetailStack, ConfigEmptyState, ConfigField } from "./SettingsUi";

/**
 * The main conversation's quick delegate: pick a configured agent definition, write the task, and get a child.
 *
 * It is the same host interface the model's `agent_spawn` uses — the Web origin posts to the backend's own delegation
 * route, which resolves the definition on the conversation's execution host, checks the depth and concurrency limits
 * and writes the child, its anchor and its dispatch record in one commit. Nothing here decides a context strategy: the
 * definition owns it, and the form has no field for it, so a quick create cannot override the policy the definition or
 * the user's configuration set (spec D01, D11, D15).
 *
 * The definitions are read through the **same** document and validation interface the Settings panel edits
 * (`/api/agent-definitions`), so what the quick create offers is what Settings saved, and a save affects only creates
 * that happen after it (spec D10, A12).
 *
 * The request identity belongs to the **attempt**, not to the click: it is held per conversation and definition until
 * the attempt is answered, so a retry after a lost answer is answered with the child the first attempt created instead
 * of making a second one. Every refusal — an unreachable host, an over-limit request, a definition this build cannot
 * run — is shown with the backend's own message and code, and none of them is a hidden queue (spec D12, A15).
 */

export function QuickDelegatePanel({
  sessionId,
  cwd,
  canDelegate,
  isChild,
  existingChildren,
  onOpenChild,
  onCreated,
}: {
  sessionId: string;
  cwd: string;
  /** Whether this conversation currently selects the delegation capability; false hides the entry entirely. */
  canDelegate: boolean;
  /** Whether the conversation on screen is itself a child, which is what "delegate again" means here. */
  isChild: boolean;
  /** The children of the conversation on screen, so an existing one can be given another task explicitly. */
  existingChildren: readonly { readonly id: string; readonly label: string }[];
  /**
   * Open the child the delegation created, in the same ChatWindow and its own native stream. The row is the backend's
   * own catalogue row for it, answered with the delegation, so opening it needs no second read that could race the
   * session list.
   */
  onOpenChild: (session: SessionInfo) => void;
  /** The catalogue row changed, so the child tree can read it back rather than guessing. */
  onCreated?: (conversationId: string) => void;
}) {
  const { t } = useI18n();
  // The conversation's own folder names its execution workspace: the definitions offered are that host's, read through
  // the connection rather than by a path this bundle would have to resolve.
  const definitionsTarget = useExecutionTarget(workspaceIdFromCwd(cwd));
  /** Whether a read's target is the one on screen now; see {@link useTargetFence}. */
  const belongsTo = useTargetFence(definitionsTarget);
  const [definitions, setDefinitions] = useState<readonly DelegateDefinition[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string>("");
  const [task, setTask] = useState("");
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<DelegateRefusal | null>(null);
  const [lastChild, setLastChild] = useState<string | null>(null);
  // One identity per attempt, held across retries and released the moment the backend answers it. It lives in a ref
  // because it is bookkeeping rather than something the screen shows: a re-render must not mint a new attempt.
  const attemptsRef = useRef<DelegateAttempts>(new Map());
  // Which conversation the task goes to: an empty string means a **new child** of the conversation on screen, and an
  // id means that conversation gets one more task whose report comes back here. The two are deliberately one control,
  // because "delegate" and "delegate again" are the same decision about the same work — the backend owns the
  // difference, and this panel only states which one the user asked for.
  //
  // A plain chat in a child is **not** this: sending a message in the child's own composer is an ordinary turn of that
  // conversation and registers no report at all. Only this explicit choice registers one (spec D05).
  const [target, setTarget] = useState<string>("");
  // The default follows what the user is looking at: a child's own view offers "this child again" first, because that
  // is the conversation they are already in, while a main conversation offers a new child.
  useEffect(() => {
    setTarget(isChild ? sessionId : "");
  }, [isChild, sessionId]);

  // Both calls are this connection's own: the Gateway origin under this page's credential, never the bundle's. The
  // definitions are read through the target on screen and the delegation is posted from it, so a child is created on
  // the host this page is connected to under this page's credential, exactly as the composer's own sends are.
  const { client } = useWorkbenchConnection();
  const load = useCallback(async () => {
    // Every completion of this read belongs to the target that asked: the conversation's folder may have changed, and
    // the previous host's refusal — including the connection's own `disposed` — is not a fact about the host on screen.
    // Writing it would hide the definition selector of a folder that loaded perfectly well.
    const asked = definitionsTarget;
    const stillShown = () => asked === null ? definitionsTarget === null : belongsTo(asked);
    setLoading(true);
    setLoadError(null);
    try {
      if (definitionsTarget === null) throw new Error(t("agents.unavailable"));
      const listed = await listDelegateDefinitions(definitionsTarget);
      if (!stillShown()) return;
      setDefinitions(listed);
      // A definition this build cannot run is offered as unusable rather than hidden: the user has to see that the
      // definition exists and why it will not run, instead of finding a name that silently is not there (spec D10).
      const runnable = listed.filter((definition) => definition.enabled && definition.issues.length === 0);
      setSelected((current) => runnable.some((definition) => definition.name === current) ? current : runnable[0]?.name ?? "");
    } catch (error) {
      if (!stillShown()) return;
      setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      if (stillShown()) setLoading(false);
    }
  }, [belongsTo, definitionsTarget, t]);

  useEffect(() => { void load(); }, [load]);

  const runnable = useMemo(() => definitions.filter((definition) => definition.enabled && definition.issues.length === 0), [definitions]);
  const chosen = runnable.find((definition) => definition.name === selected) ?? null;

  const submit = async () => {
    if (chosen === null || task.trim() === "") return;
    const key = delegateAttemptKey(sessionId, chosen.name, target);
    const requestId = delegateRequestId(attemptsRef.current, key, () => crypto.randomUUID());
    setBusy(true);
    setRefusal(null);
    setLastChild(null);
    // The delegation is made **from the conversation on screen**: a task for an existing child is dispatched from here
    // and its report comes back here, while a new child is created beneath this conversation. The backend decides which
    // of the two the body means, and it refuses a user's own stop on the target rather than queueing hidden work.
    const result = await delegateFrom(client, sessionId, {
      requestId,
      definition: chosen.name,
      task,
      ...(target === "" ? {} : { conversationId: target }),
    });
    if (!result.ok) {
      // A refused attempt keeps its identity: that refusal is exactly what the user retries, and reusing the identity
      // is what makes the retry answer the same child if the first attempt really did commit (spec D04, A19).
      setRefusal(result.refusal);
      setBusy(false);
      return;
    }
    delegateSettled(attemptsRef.current, key);
    setTask("");
    setLastChild(result.answer.childConversationId);
    setBusy(false);
    onCreated?.(result.answer.childConversationId);
    // Opening the child is what makes this a delegation and not a form: the user lands in the conversation that is now
    // doing the work, in the same ChatWindow and its own native stream. A dispatch to a conversation already on screen
    // is already there, so it is not reopened.
    if (result.answer.childConversationId !== sessionId && result.answer.session !== undefined) onOpenChild(result.answer.session);
  };

  if (!canDelegate) {
    return <ConfigEmptyState>{t("delegate.disabled")}</ConfigEmptyState>;
  }

  return (
    <ConfigDetailStack className="is-fill">
      <ConfigField label={t("delegate.definition")}>
        {loading ? (
          <span style={{ color: "var(--text-dim)", fontSize: 12 }}>{t("agents.loading")}</span>
        ) : loadError !== null ? (
          <span role="alert" data-delegate-error style={{ color: "#ef4444", fontSize: 12 }}>{loadError}</span>
        ) : definitions.length === 0 ? (
          <ConfigEmptyState>{t("delegate.noDefinitions")}</ConfigEmptyState>
        ) : (
          <select
            aria-label={t("delegate.definition")}
            data-delegate-definition
            value={selected}
            disabled={busy}
            onChange={(event) => setSelected(event.target.value)}
            style={{ width: "100%", height: 34, padding: "0 9px", border: "1px solid var(--border)", borderRadius: 5, background: "var(--bg)", color: "var(--text)", fontSize: 12 }}
          >
            {definitions.map((definition) => {
              const usable = definition.enabled && definition.issues.length === 0;
              return (
                <option key={definition.name} value={definition.name} disabled={!usable}>
                  {definition.name + " · " + definition.scope + " · " + definition.context + (usable ? "" : " · " + t("delegate.unusable"))}
                </option>
              );
            })}
          </select>
        )}
      </ConfigField>
      {chosen !== null && (
        <p data-delegate-summary style={{ margin: 0, color: "var(--text-dim)", fontSize: 11 }}>
          {chosen.description + " · " + t("delegate.context", { strategy: chosen.context })}
        </p>
      )}
      {/*
        The target: a new child of the conversation on screen, or one that already exists. An existing child is offered
        explicitly so "delegate again" is a decision the user makes rather than something inferred from the layout, and
        the default follows the view they are in — a child's own view offers that child, a main conversation offers a
        new one.
      */}
      <ConfigField label={t("delegate.target")}>
        <select
          aria-label={t("delegate.target")}
          data-delegate-target
          value={target}
          disabled={busy}
          onChange={(event) => setTarget(event.target.value)}
          style={{ width: "100%", height: 34, padding: "0 9px", border: "1px solid var(--border)", borderRadius: 5, background: "var(--bg)", color: "var(--text)", fontSize: 12 }}
        >
          <option value="">{t("delegate.targetNew")}</option>
          {existingChildren.map((child) => (
            <option key={child.id} value={child.id}>{t("delegate.targetExisting", { label: child.label })}</option>
          ))}
        </select>
      </ConfigField>
      <ConfigField label={t("delegate.task")}>
        <textarea
          aria-label={t("delegate.task")}
          data-delegate-task
          value={task}
          disabled={busy}
          onChange={(event) => setTask(event.target.value)}
          placeholder={t("delegate.taskPlaceholder")}
          style={{ width: "100%", minHeight: 110, padding: 9, border: "1px solid var(--border)", borderRadius: 5, background: "var(--bg)", color: "var(--text)", fontSize: 12, lineHeight: 1.5, resize: "vertical" }}
        />
      </ConfigField>
      {refusal !== null && (
        // The backend's own words and its own code, together: an over-limit refusal and an unreachable host are
        // different problems and a user can act on each of them only if both are named (spec D12, A15).
        <p role="alert" data-delegate-refusal={refusal.code} style={{ margin: 0, color: "#ef4444", fontSize: 12 }}>
          {refusal.message}
        </p>
      )}
      {lastChild !== null && (
        <p data-delegate-created={lastChild} style={{ margin: 0, color: "var(--text-dim)", fontSize: 12 }}>
          {target === "" ? t("delegate.created", { id: lastChild }) : t("delegate.dispatched", { id: lastChild })}
        </p>
      )}
      <div style={{ display: "flex", gap: 8 }}>
        <ConfigButton variant="primary" onClick={() => void submit()} disabled={busy || chosen === null || task.trim() === ""} data-delegate-submit>
          {busy ? t("delegate.delegating") : t("delegate.submit")}
        </ConfigButton>
        <ConfigButton onClick={() => void load()} disabled={busy || definitionsTarget === null}>{t("delegate.reload")}</ConfigButton>
      </div>
    </ConfigDetailStack>
  );
}
