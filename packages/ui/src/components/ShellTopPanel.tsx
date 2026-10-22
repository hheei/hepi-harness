"use client";

import type { SessionInfo } from "../lib/types";
import type { SessionStatsInfo } from "../lib/pi-types";
import type { ToolEntry } from "../lib/tool-presets";
import type { SessionFamily } from "../lib/session-family";
import { useI18n } from "../hooks/useI18n";
import { AgentSessionPanel } from "./AgentSessionPanel";
import { SubtreeControlPanel } from "./SubtreeControlPanel";
import { QuickDelegatePanel } from "./QuickDelegatePanel";
import { RawHistoryPanel } from "./RawHistoryPanel";
import { SystemPromptPanel } from "./SystemPromptPanel";
import { ToolDefinitionsPanel } from "./ToolDefinitionsPanel";
import { SessionStatsPopover } from "./SessionStatsPopover";
import type { SessionCopyField } from "./SessionStatsPopover";

/** The panels that hang from the top bar. One at a time, because they are one dropdown at one anchor. */
export type TopPanel = "agents" | "delegate" | "system" | "tools" | "session" | "history";

interface Props {
  activePanel: TopPanel;
  /** Where the bar is, so the panel opens under it rather than over it. */
  position: { readonly top: number; readonly left: number; readonly width: number };
  session: SessionInfo | null;
  family: SessionFamily | null;
  runningSessionIds: ReadonlySet<string>;
  onSelectConversation: (session: SessionInfo) => void;
  onSubtreeControlled: () => void;
  onDelegated: () => void;
  canDelegate: boolean;
  delegateTargets: readonly { id: string; label: string }[];
  historyFocus: { sessionId: string; entryId: string } | null;
  onOpenSession: (sessionId: string, entryId?: string, options?: { rawHistoryFocus?: boolean }) => void;
  onSessionForked: (sessionId: string) => void;
  /** The system prompt and tool list, as the conversation's own surface stated them. */
  systemInfo: { readonly prompt: string | null; readonly tools: ToolEntry[] | null; readonly loading: boolean };
  stats: SessionStatsInfo | null;
  contextUsage: { percent: number | null; contextWindow: number; tokens: number | null } | null;
  copiedField: SessionCopyField | null;
  onCopyField: (field: SessionCopyField, value: string) => void;
  /** The narrow layout states the conversation's facts in one column. */
  mobile: boolean;
}

/**
 * The one panel the top bar has open: the child tree with its subtree control, a delegation, the raw history behind the
 * window, the system prompt, the tool list, or the conversation's own facts.
 *
 * It is the shell's presentation of what its children stated. Nothing here reads a resource, and the only writes are the
 * intents a reader sends — select this conversation, control this subtree, delegate, fork, copy a field — which the
 * owner of that fact carries out.
 */
export function ShellTopPanel({ activePanel, position, session, family, runningSessionIds, onSelectConversation, onSubtreeControlled, onDelegated, canDelegate, delegateTargets, historyFocus, onOpenSession, onSessionForked, systemInfo, stats, contextUsage, copiedField, onCopyField, mobile }: Props) {
  const { t } = useI18n();
  return (
    <div style={{
      position: "fixed",
      top: position.top,
      left: position.left,
      width: position.width,
      maxHeight: `calc(100dvh - ${position.top}px)`,
      overflowY: "auto",
      zIndex: 500,
    }}>
      {activePanel === "agents" && family && session && (
        <>
          <AgentSessionPanel
            rootSession={family.root}
            subagents={family.subagents}
            selectedSessionId={session.id}
            runningSessionIds={runningSessionIds}
            onSelectSession={onSelectConversation}
          />
          {/*
            Subtree control sits **below** the tree it names: a row stays a row, and navigation stays available while a
            request is in flight. The descendants offered are the family listing the panel already holds — a proposal
            only, since the Backend captures the governing set from durable relations — and the whole subtree is chosen
            by default so an omitted child is a decision rather than a silence.
          */}
          {family.subagents.length > 0 && (
            <SubtreeControlPanel
              root={family.root}
              descendants={family.subagents.map((session) => ({ id: session.id, session }))}
              runningSessionIds={runningSessionIds}
              onSelectSession={onSelectConversation}
              onControlled={onSubtreeControlled}
            />
          )}
        </>
      )}
      {activePanel === "delegate" && session && (
        <QuickDelegatePanel
          sessionId={session.id}
          cwd={session.cwd}
          canDelegate={canDelegate}
          isChild={session.relation?.kind === "subagent"}
          existingChildren={delegateTargets}
          onOpenChild={(session) => onSelectConversation(session)}
          onCreated={onDelegated}
        />
      )}
      {activePanel === "history" && session && (
        <RawHistoryPanel
          sessionId={session.id}
          focusEntryId={historyFocus?.sessionId === session.id ? historyFocus.entryId : null}
          onOpenSession={onOpenSession}
          onForked={onSessionForked}
        />
      )}
      {activePanel === "system" && (
        <SystemPromptPanel loading={systemInfo.loading} prompt={systemInfo.prompt} translate={t} />
      )}
      {activePanel === "tools" && (
        <ToolDefinitionsPanel loading={systemInfo.loading} tools={systemInfo.tools} translate={t} />
      )}
      {activePanel === "session" && (
        <SessionStatsPopover
          stats={stats}
          session={session}
          contextUsage={contextUsage}
          copiedField={copiedField}
          onCopy={onCopyField}
          mobile={mobile}
        />
      )}
    </div>
  );
}
