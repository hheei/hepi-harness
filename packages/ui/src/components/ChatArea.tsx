"use client";

import type { ReactNode, RefObject } from "react";
import type { ChatScrollPosition } from "../lib/chat/chat-scroll-position";
import type { UseAgentSessionOptions } from "../hooks/useAgentSession";
import type { ReloadOutcome } from "../hooks/useAgentSession";
import type { Step } from "../lib/lifecycle-projection";
import type { SessionInfo } from "../lib/types";
import type { SessionStatsInfo } from "../lib/pi-types";
import type { ToolEntry } from "../lib/tool-presets";
import type { SettingsSection } from "../lib/settings-navigation";
import type { ReadFailure } from "../lib/read-recovery";
import { readFailureRetryable } from "../lib/read-recovery";
import type { ChatInputHandle } from "./ChatInput";
import type { NewSessionChoices } from "../hooks/useAgentSession";
import type { CompletionNotice } from "../lib/completion-delivery";
import { ChatWindow } from "./ChatWindow";
import { ReadFailurePanel } from "./ReadFailurePanel";
import { useI18n } from "../hooks/useI18n";

interface Props {
  /** The chat's mount identity: the conversation it is showing, or the fresh composer it is showing. */
  chatIdentity: string | null;
  session: SessionInfo | null;
  /** Whether the shell has something to show: a conversation, or a fresh composer with a folder. */
  showChat: boolean;
  openFailure: { readonly failure: ReadFailure; readonly sessionId: string; readonly entryId?: string } | null;
  openRetrying: boolean;
  onRetryOpen: () => Promise<void>;
  onDismissOpenFailure: () => void;
  /** The first navigation a page performs, and what it is doing. */
  initialCwd: { readonly requested: string | null; readonly status: "idle" | "validating" | "ready" | "error"; readonly error: string | null };
  /** The folder in effect, and whether the reader has been told where a conversation would come from. */
  cwd: string | null;
  showPlaceholder: boolean;
  searchTarget: { sessionId: string; entryId: string; blockIndex?: number } | null;
  onSearchTargetHandled: (target: { sessionId: string; entryId: string }) => void;
  onReadFailureBack: () => void;
  initialScrollPosition: ChatScrollPosition | null;
  onScrollPositionChange: (sessionId: string, position: ChatScrollPosition) => void;
  subscribeAgentEvents: UseAgentSessionOptions["subscribeAgentEvents"];
  onProjectionChange: (conversationId: string, step: Step) => void;
  onLiveSettlement: (notice: CompletionNotice) => boolean;
  newSessionCwd: string | null;
  newSessionDraftKey: string | null;
  newSessionContextBar: ReactNode;
  /** A fresh composer's model and reasoning picks, carried from the composer it replaces. */
  carriedChoices: NewSessionChoices | null;
  onNewSessionChoicesChange: (choices: NewSessionChoices) => void;
  onAgentEnd: () => void;
  onSessionCreated: (session: SessionInfo, sourceDraftKey: string) => void;
  onSessionForked: (sessionId: string) => void;
  chatInputRef: RefObject<ChatInputHandle | null>;
  onSystemPromptChange: (prompt: string | null) => void;
  onSystemToolsChange: (tools: ToolEntry[] | null) => void;
  onSystemInfoLoaderChange: (loader: (() => Promise<void>) | null) => void;
  onConversationReloadChange: (reload: (() => Promise<ReloadOutcome>) | null) => void;
  onSessionStatsChange: (stats: SessionStatsInfo | null) => void;
  onOpenSettings: (section: SettingsSection) => void;
  onContextUsageChange: (usage: { percent: number | null; contextWindow: number; tokens: number | null } | null) => void;
  onOpenFile: (filePath: string, page?: number) => void;
  onOpenSession: (sessionId: string, entryId?: string, options?: { rawHistoryFocus?: boolean }) => void;
  onAskInNewChat: (prompt: string, sourceSessionId: string, sourceEntryId: string) => Promise<void>;
  quoteSelectionEnabled: boolean;
  initialPrompt: string | undefined;
  onInitialPromptConsumed: () => void;
  soundEnabled: boolean;
  onSoundToggle: () => void;
  playDoneSound: () => void;
  unlockAudio: () => void;
}

/**
 * The middle of the workbench: the conversation, or the state the reader is waiting in.
 *
 * It is one component because it is one region with one rule — what belongs where the chat is — and every branch is a
 * fact about the selection rather than a decision of its own: a read that did not answer takes the chat's place, a
 * conversation or a fresh composer is the chat, a first navigation still being validated is its own state, and the rest
 * is the placeholder that says what to do first.
 *
 * Every fact it shows was stated by the selection or by the conversation's own surface; every action it sends is an
 * intent. That is what keeps this region out of the data path: it decides *what is shown*, never *what is true*.
 */
export function ChatArea(props: Props) {
  const { t } = useI18n();
  const {
    chatIdentity, session, showChat, openFailure, openRetrying, onRetryOpen, onDismissOpenFailure, initialCwd, cwd,
    showPlaceholder, searchTarget, onSearchTargetHandled, onReadFailureBack, initialScrollPosition,
    onScrollPositionChange, subscribeAgentEvents, onProjectionChange, onLiveSettlement, newSessionCwd,
    newSessionDraftKey, newSessionContextBar, carriedChoices, onNewSessionChoicesChange, onAgentEnd, onSessionCreated,
    onSessionForked, chatInputRef, onSystemPromptChange, onSystemToolsChange, onSystemInfoLoaderChange,
    onConversationReloadChange, onSessionStatsChange, onOpenSettings, onContextUsageChange, onOpenFile,
    onOpenSession, onAskInNewChat, quoteSelectionEnabled, initialPrompt, onInitialPromptConsumed, soundEnabled,
    onSoundToggle, playDoneSound, unlockAudio,
  } = props;
  return (
    <div style={{ flex: 1, overflow: "hidden", position: "relative" }}>
    {/* A conversation the shell was asked for and could not open. It takes the chat's place because nothing else
        can honestly be shown for it: the selection did not move, so the panel names the target and offers the
        read again — or leaving it alone. */}
    {openFailure ? (
      <ReadFailurePanel
        failure={openFailure.failure}
        variant="surface"
        retrying={openRetrying}
        onRetry={readFailureRetryable(openFailure.failure) ? () => { void onRetryOpen(); } : undefined}
        onBack={() => onDismissOpenFailure()}
      />
    ) : showChat ? (
      <ChatWindow
        key={chatIdentity}
        session={session}
        searchTarget={searchTarget?.sessionId === session?.id ? searchTarget : null}
        onSearchTargetHandled={onSearchTargetHandled}
        onReadFailureBack={onReadFailureBack}
        initialScrollPosition={session ? initialScrollPosition : null}
        onScrollPositionChange={onScrollPositionChange}
        subscribeAgentEvents={subscribeAgentEvents}
        onProjectionChange={onProjectionChange}
        onLiveSettlement={onLiveSettlement}
        newSessionCwd={newSessionCwd}
        newSessionDraftKey={newSessionDraftKey}
        newSessionContextBar={newSessionContextBar}
        initialNewSessionChoices={session === null ? carriedChoices : null}
        onNewSessionChoicesChange={onNewSessionChoicesChange}
        onAgentEnd={onAgentEnd}
        onSessionCreated={onSessionCreated}
        onSessionForked={onSessionForked}
        chatInputRef={chatInputRef}
        onSystemPromptChange={onSystemPromptChange}
        onSystemToolsChange={onSystemToolsChange}
        onSystemInfoLoaderChange={onSystemInfoLoaderChange}
        onConversationReloadChange={onConversationReloadChange}
        onSessionStatsChange={onSessionStatsChange}
        onOpenSettings={onOpenSettings}
        onContextUsageChange={onContextUsageChange}
        onOpenFile={onOpenFile}
        onOpenSession={onOpenSession}
        onAskInNewChat={onAskInNewChat}
        quoteSelectionEnabled={quoteSelectionEnabled}
        initialPrompt={initialPrompt}
        onInitialPromptConsumed={onInitialPromptConsumed}
        soundEnabled={soundEnabled}
        onSoundToggle={onSoundToggle}
        playDoneSound={playDoneSound}
        unlockAudio={unlockAudio}
      />
    ) : initialCwd.status === "validating" ? (
      <div
        role="status"
        style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, padding: 24, color: "var(--text-muted)", textAlign: "center" }}
      >
         <div style={{ fontSize: 14, color: "var(--text)" }}>{t("workspace.opening")}</div>
        <div style={{ maxWidth: "min(720px, 100%)", overflowWrap: "anywhere", fontFamily: "var(--font-mono)", fontSize: 12 }}>
          {initialCwd.requested}
        </div>
      </div>
    ) : initialCwd.status === "error" ? (
      <div
        role="alert"
        style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, padding: 24, color: "var(--text-muted)", textAlign: "center" }}
      >
         <div style={{ fontSize: 14, color: "#dc2626" }}>{t("workspace.unable")}</div>
        <div style={{ maxWidth: "min(720px, 100%)", overflowWrap: "anywhere", fontFamily: "var(--font-mono)", fontSize: 12 }}>
          {initialCwd.requested}
        </div>
        <div style={{ maxWidth: 720, fontSize: 12 }}>{initialCwd.error}</div>
      </div>
    ) : showPlaceholder ? (
      cwd ? (
        <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-muted)", fontSize: 15 }}>
           {t("workspace.selectSession")}
        </div>
      ) : (
        <div style={{ position: "absolute", top: 12, left: 12, display: "flex", alignItems: "flex-start", gap: 8, userSelect: "none", pointerEvents: "none" }}>
          <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.7, flexShrink: 0 }}>
            <line x1="20" y1="12" x2="4" y2="12" /><polyline points="10 6 4 12 10 18" />
          </svg>
          <div>
             <div style={{ fontSize: 18, fontWeight: 600, color: "var(--text)", marginBottom: 8 }}>{t("workspace.getStarted")}</div>
            <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.8 }}>
               <span style={{ color: "var(--text-dim)", marginRight: 6 }}>1.</span>{t("workspace.selectProject")}<br />
               <span style={{ color: "var(--text-dim)", marginRight: 6 }}>2.</span>{t("workspace.addModels")}
            </div>
          </div>
        </div>
      )
    ) : null}
    </div>
  );
}
