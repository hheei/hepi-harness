"use client";

import { useMemo, useState } from "react";
import { useI18n } from "../hooks/useI18n";
import type { ConversationRunState, SessionInfo } from "../lib/types";

interface Props {
  rootSession: SessionInfo;
  subagents: SessionInfo[];
  selectedSessionId: string;
  runningSessionIds: ReadonlySet<string>;
  onSelectSession: (session: SessionInfo) => void;
}

export function sessionTitle(session: SessionInfo): string {
  return session.name || session.firstMessage || session.id.slice(0, 12);
}

function formatRelativeTime(value: string, locale: string): string {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return "";
  const elapsedSeconds = Math.round((timestamp - Date.now()) / 1000);
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  if (Math.abs(elapsedSeconds) < 60) return formatter.format(elapsedSeconds, "second");
  const elapsedMinutes = Math.round(elapsedSeconds / 60);
  if (Math.abs(elapsedMinutes) < 60) return formatter.format(elapsedMinutes, "minute");
  const elapsedHours = Math.round(elapsedMinutes / 60);
  if (Math.abs(elapsedHours) < 24) return formatter.format(elapsedHours, "hour");
  return formatter.format(Math.round(elapsedHours / 24), "day");
}

/**
 * The colour one real status is shown in. Every state the backend can project has one, and the palette says which
 * states are work in flight, which are the user's own decision, and which are problems rather than progress.
 */
function statusColor(state: ConversationRunState): string {
  if (state === "running") return "var(--accent)";
  if (state === "held" || state === "stopping") return "#d97706";
  if (state === "blocked" || state === "interrupted") return "#dc2626";
  if (state === "waiting-report") return "#7c3aed";
  return "var(--text-dim)";
}

/** The spinner is only for work in flight; every other state has its own glyph, so no state is shown as another. */
function StatusIcon({ state }: { state: ConversationRunState }) {
  if (state === "running") {
    return (
      <svg className="animate-spin" width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" opacity="0.25" />
        <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
    );
  }
  if (state === "held" || state === "stopping") {
    return (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
        <circle cx="12" cy="12" r="9" /><path d="M10 9v6M14 9v6" />
      </svg>
    );
  }
  if (state === "blocked" || state === "interrupted") {
    return (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
        <circle cx="12" cy="12" r="9" /><path d="m9 9 6 6M15 9l-6 6" />
      </svg>
    );
  }
  if (state === "waiting-report") {
    return (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M4 6h16v10H8l-4 4z" /><path d="M9 11h6" />
      </svg>
    );
  }
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" /><path d="m8 12 3 3 5-6" />
    </svg>
  );
}

/**
 * One conversation's status row: the backend's own state, its own reason, and nothing inferred.
 *
 * The status is read from the catalogue's `runStatus`, which the backend projects from **that conversation's** run,
 * its committed control, its live tasks and whether its delegated result is queued. A child is therefore never shown
 * as running because its parent is busy, and a child the user stopped is shown held rather than completed (spec D15).
 * A row the catalogue stated no status for says so, instead of defaulting to a state nobody read.
 */
export function StatusCell({ session, running, t }: { session: SessionInfo; running: boolean; t: (key: string) => string }) {
  const status = session.runStatus;
  if (status === undefined) {
    // The busy flag is the catalogue's own fact and it is the one fallback that is not a guess: a row with no projected
    // status but a live run is running, and a row with neither states that its status is unknown rather than inventing
    // one. This is what a transient client-side session looks like before the catalogue answers for it.
    const state: ConversationRunState = running ? "running" : "idle";
    return (
      <span style={{ display: "flex", alignItems: "center", gap: 6, color: statusColor(state), fontSize: 11, whiteSpace: "nowrap" }}>
        <StatusIcon state={state} />
        <span>{t("agentSwitcher.status." + state)}</span>
      </span>
    );
  }
  // The runtime's own reason, shown as it is when this build has no word for it. A reason that is translated and one
  // that is passed through are both the backend's fact; neither is a sentence invented here.
  const reasonKey = status.reason === undefined ? undefined : "agentSwitcher.reason." + status.reason;
  const reasonText = reasonKey === undefined ? "" : t(reasonKey);
  const reason = reasonText === reasonKey ? " · " + String(status.reason) : " · " + reasonText;
  return (
    <span data-run-status={status.state} style={{ display: "flex", alignItems: "center", gap: 6, color: statusColor(status.state), fontSize: 11, whiteSpace: "nowrap" }}>
      <StatusIcon state={status.state} />
      <span>{t("agentSwitcher.status." + status.state)}{reason}</span>
    </span>
  );
}

/** One conversation as a row of the tree, with the depth it sits at and the child count beneath it. */
type TreeNode = { session: SessionInfo; depth: number; children: number };

/**
 * The child tree, built from the **catalogue's own relations**.
 *
 * The edge is the conversation's display parent, falling back to the creator and then to the subagent relation, which
 * are the three facts the catalogue states and which are deliberately separate from each other (spec D03). A child whose
 * display parent is hidden stays where it is and is marked as such rather than being promoted or dropped, and a
 * conversation whose parent is not in this listing is shown at the root with that fact visible.
 *
 * The order is a stable depth-first walk, so a child is always shown under its own parent and the list does not
 * reshuffle when a run ends.
 */
export function buildChildTree(root: SessionInfo, subagents: readonly SessionInfo[]): TreeNode[] {
  const parentOf = (session: SessionInfo): string | undefined => {
    if (session.id === root.id) return undefined;
    if (session.displayParentSessionId !== undefined) return session.displayParentSessionId;
    if (session.createdBy !== undefined) return session.createdBy;
    return session.relation?.kind === "subagent" ? session.relation.parentSessionId : undefined;
  };
  const byParent = new Map<string, SessionInfo[]>();
  for (const session of subagents) {
    const parent = parentOf(session) ?? root.id;
    const list = byParent.get(parent);
    if (list === undefined) byParent.set(parent, [session]);
    else list.push(session);
  }
  const rows: TreeNode[] = [];
  const walk = (parentId: string, depth: number, seen: Set<string>): void => {
    for (const child of byParent.get(parentId) ?? []) {
      // A cycle cannot be created by the backend — the creation seam refuses a self-parent and a cycle — but a listing
      // that somehow held one would otherwise walk forever, so the walk refuses to revisit an id.
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      const children = byParent.get(child.id) ?? [];
      rows.push({ session: child, depth, children: children.length });
      walk(child.id, depth + 1, seen);
    }
  };
  walk(root.id, 0, new Set());
  // A conversation whose parent left this listing entirely — a hidden middle conversation, or a creator outside the
  // family — would not have been reached by the walk. It is kept, at the root, rather than dropped: a removal above a
  // child must not erase the child (spec D03, D22).
  const reached = new Set(rows.map((row) => row.session.id));
  for (const session of subagents) if (!reached.has(session.id)) rows.push({ session, depth: 0, children: 0 });
  return rows;
}

function AgentRow({
  session,
  main,
  depth,
  selected,
  running,
  onSelect,
}: {
  session: SessionInfo;
  main?: boolean;
  depth?: number;
  selected: boolean;
  running: boolean;
  onSelect: () => void;
}) {
  const { locale, t } = useI18n();
  const relation = session.relation?.kind === "subagent" ? session.relation : null;
  const primary = main ? t("agentSwitcher.main") : relation?.description || sessionTitle(session);
  const hiddenParent = session.displayParentDeleted === true;
  // The host the conversation really runs on, from the catalogue's own answer. A row the catalogue stated no host for
  // shows none: an absent fact is not replaced by the gateway this page happens to be served from, because that would
  // name a computer the work is not on (spec D12).
  const host = session.gatewayId === undefined ? "" : t("agentSwitcher.host", { host: session.gatewayId });
  const secondary = main
    ? [sessionTitle(session), host].filter((part) => part !== "").join(" · ")
    : [relation?.profile ?? t("agentSwitcher.subagent"), host, formatRelativeTime(session.modified, locale), hiddenParent ? t("agentSwitcher.parentHidden") : ""]
        .filter((part) => part !== "")
        .join(" · ");

  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      data-child-session={main ? undefined : session.id}
      onClick={onSelect}
      style={{
        width: "100%",
        minHeight: 56,
        display: "grid",
        gridTemplateColumns: "28px minmax(0, 1fr) auto",
        alignItems: "center",
        gap: 9,
        padding: "7px 12px",
        paddingLeft: 12 + (depth ?? 0) * 16,
        border: "none",
        borderBottom: "1px solid var(--border)",
        borderLeft: selected ? "2px solid var(--accent)" : "2px solid transparent",
        background: selected ? "var(--bg-selected)" : "transparent",
        color: "var(--text)",
        cursor: "pointer",
        textAlign: "left",
      }}
      onMouseEnter={(event) => {
        if (!selected) event.currentTarget.style.background = "var(--bg-hover)";
      }}
      onMouseLeave={(event) => {
        if (!selected) event.currentTarget.style.background = "transparent";
      }}
    >
      <span style={{ width: 28, height: 28, display: "grid", placeItems: "center", color: main ? "var(--text-muted)" : "var(--accent)" }}>
        {main ? (
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" />
          </svg>
        ) : (
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="5" y="7" width="14" height="11" rx="2" /><path d="M9 11h.01M15 11h.01M9 15h6M12 7V4M10 4h4" />
          </svg>
        )}
      </span>
      <span style={{ minWidth: 0 }}>
        <span style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12, fontWeight: selected ? 600 : 500 }} title={primary}>
          {primary}
        </span>
        <span style={{ display: "block", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text-dim)", fontSize: 11 }} title={secondary}>
          {secondary}
        </span>
      </span>
      <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
        {main && !running && selected ? (
          <span style={{ color: "var(--text-dim)", fontSize: 11 }}>{t("agentSwitcher.current")}</span>
        ) : (
          <StatusCell session={session} running={running} t={t} />
        )}
      </span>
    </button>
  );
}

export function AgentSessionPanel({ rootSession, subagents, selectedSessionId, runningSessionIds, onSelectSession }: Props) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const tree = useMemo(() => buildChildTree(rootSession, subagents), [rootSession, subagents]);
  const normalizedQuery = query.trim().toLowerCase();
  const visibleTree = normalizedQuery
    ? tree.filter(({ session }) => {
        const relation = session.relation?.kind === "subagent" ? session.relation : null;
        return [relation?.description, relation?.profile, session.name, session.firstMessage]
          .some((value) => value?.toLowerCase().includes(normalizedQuery));
      })
    : tree;
  // The count of children that are really at work, from the same projected status the rows show rather than from the
  // poll's busy set: a held or blocked child is not "running", and saying so is the point of the projection.
  const workingCount = subagents.filter((session) => session.runStatus?.state === "running" || runningSessionIds.has(session.id)).length;

  return (
    <div
      role="listbox"
      aria-label={t("agentSwitcher.title")}
      style={{
        background: "var(--bg-panel)",
        borderLeft: "1px solid var(--border)",
        borderRight: "1px solid var(--border)",
        borderBottom: "1px solid var(--border)",
        borderRadius: "0 0 6px 6px",
        boxShadow: "0 10px 28px rgba(0,0,0,0.10)",
        overflow: "hidden",
      }}
    >
      <div>
        <div style={{ minHeight: 44, display: "flex", alignItems: "center", gap: 8, padding: "7px 12px", borderBottom: "1px solid var(--border)" }}>
          <strong style={{ fontSize: 12, fontWeight: 600 }}>{t("agentSwitcher.title")}</strong>
          <span style={{ color: "var(--text-dim)", fontSize: 11 }}>
            {t("agentSwitcher.count", { count: subagents.length })}
          </span>
          {workingCount > 0 && (
            <span style={{ marginLeft: "auto", color: "var(--accent)", fontSize: 11 }}>
              {t("agentSwitcher.runningCount", { count: workingCount })}
            </span>
          )}
        </div>
        {subagents.length > 8 && (
          <div style={{ padding: 8, borderBottom: "1px solid var(--border)" }}>
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("agentSwitcher.search")}
              aria-label={t("agentSwitcher.search")}
              style={{
                width: "100%", height: 32, padding: "0 10px",
                border: "1px solid var(--border)", borderRadius: 6,
                background: "var(--bg)", color: "var(--text)", fontSize: 12, outline: "none",
              }}
            />
          </div>
        )}
        <div style={{ maxHeight: "min(58dvh, 480px)", overflowY: "auto" }}>
          <AgentRow
            session={rootSession}
            main
            selected={rootSession.id === selectedSessionId}
            running={runningSessionIds.has(rootSession.id)}
            onSelect={() => onSelectSession(rootSession)}
          />
          {visibleTree.map(({ session, depth }) => (
            <AgentRow
              key={session.id}
              session={session}
              depth={depth}
              selected={session.id === selectedSessionId}
              running={runningSessionIds.has(session.id)}
              onSelect={() => onSelectSession(session)}
            />
          ))}
          {visibleTree.length === 0 && (
            <div style={{ padding: "22px 12px", color: "var(--text-dim)", fontSize: 12, textAlign: "center" }}>
              {t("agentSwitcher.noMatches")}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
