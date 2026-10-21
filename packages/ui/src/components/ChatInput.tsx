"use client";

/**
 * The composer: the surface a message is written on.
 *
 * It assembles four things that each answer one question and nothing else:
 *
 * - {@link useComposerDraft} owns the live text, the pictures and the single write path to the connection's draft store;
 * - {@link useComposerMenus} owns the `@` index, the `/` palette, the input history and which of them a key belongs to;
 * - {@link createComposerDispatch} owns what a submit, a queued steer/follow-up and a built-in command do with the draft;
 * - this file owns the layout, and the conversation readout (model, reasoning, queue, notices) that it draws.
 *
 * What it deliberately no longer does is relay runtime internals: the conversation operations arrive as
 * {@link ComposerCommands} — send, steer, follow up, run a built-in, reach one queued item by identity — and the model,
 * reasoning and queue arrive as readouts of the domain that owns them. Nothing here holds a second writable copy of a
 * model choice or a queued item, and no editor fact (caret, composition, open menu) travels back out.
 *
 * The imperative handle stays, because a surrounding surface legitimately needs to put text into a textarea (a quoted
 * selection, a recalled queue, a failed submission's recovery) and to move a draft between keys. Those are *editor*
 * operations, performed on the native element so the browser's own undo and selection behaviour survives.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState, useImperativeHandle, forwardRef } from "react";
import type { QueuedItemProjection } from "@hepi/protocol";
import { getMarkdownListContinuation } from "../lib/markdown-list-continuation";
import { isShellCommandDraft } from "../lib/composer-limits";
import { useChatAppearance } from "../hooks/useChatAppearance";
import { useFontPreferences } from "../hooks/useFontPreferences";
import { useI18n } from "../hooks/useI18n";
import { useIsMobile } from "../hooks/useIsMobile";
import { useComposerDrafts } from "../lib/workbench-scope";
import { useComposerDraft, type ComposerEditorHandle } from "./composer/useComposerDraft";
import { useComposerMenus } from "./composer/useComposerMenus";
import { useSkillDormancy } from "./composer/useSkillDormancy";
import { createComposerDispatch, type ComposerDraftValue } from "./composer/dispatch";
import type { AttachedImage } from "./composer/attachments";
import { ComposerPopups } from "./composer/ComposerPopups";
import { ComposerModelControl, ComposerThinkingControl, type ThinkingLevel } from "./composer/ComposerControls";
import { ComposerQueue, HeldBanner, type QueuedMessagesView } from "./composer/ComposerQueue";
import type { BuiltinSlashCommandResult, SlashCommandInfo } from "./composer/commands";
import {
  DraftStorageBanner,
  ImageNotSupportedBanner,
  ImageRejectionBanner,
  ModelErrorBanner,
  ModelScopeWarningBanner,
  RunFailureBanner,
  modelSupportsImageInput,
} from "./composer/ComposerNotices";
import { ImagePreview } from "./ImagePreview";
import type { ImageFileRejection } from "../lib/image-attachments";
import type { ComposerCommands } from "./composer/commands";

export { filterModelOptions } from "./ModelSelector";
export { ModelErrorBanner, ModelScopeWarningBanner, RunFailureBanner, modelSupportsImageInput } from "./composer/ComposerNotices";
export { cycleListIndex, getUpwardMenuMaxHeight, replaceLinksWithMarkdown, replaceTextareaRange } from "./composer/editor-text";
export { compressImageFile, shouldCompressImageFile, type AttachedImage } from "./composer/attachments";
export {
  buildSlashCommandLayout,
  canClearBuiltinCommandInput,
  canRunBuiltinSlashCommandWhileStreaming,
  isExactSlashCommand,
  offersBuiltinSlashCommandWhileStreaming,
  submitsSlashCommandOnEnter,
} from "./composer/commands";

/** The editor operations a surrounding surface may perform. */
export type ChatInputHandle = ComposerEditorHandle;

/**
 * The composer's props.
 *
 * The conversation's *operations* travel as one {@link ComposerCommands} value where the caller can state them that way;
 * the individual callbacks below are the same operations named one at a time, and exist because the chat surface still
 * passes them that way. Where both are given, `commands` is the seam — it is the smaller interface, and a caller that
 * states it names a submission, a queue mode and a queued item's identity rather than eight separate prop names.
 */
interface Props {
  /** The conversation's operations, as one port. Preferred over the individual callbacks below. */
  commands?: ComposerCommands;
  onSend: (message: string, images?: AttachedImage[]) => void;
  onAbort: () => void;
  onSteer?: (message: string, images?: AttachedImage[]) => void;
  onFollowUp?: (message: string, images?: AttachedImage[]) => void;
  onPromptWithStreamingBehavior?: (message: string, behavior: "steer" | "followUp", images?: AttachedImage[]) => void;
  isStreaming: boolean;
  /** Text-only composer without the session controls or outer spacing. */
  compact?: boolean;
  model?: { provider: string; modelId: string } | null;
  isAutoModelSelection?: boolean;
  modelNames?: Record<string, string>;
  modelList?: { id: string; name: string; provider: string; input?: string[] }[];
  modelError?: string | null;
  /** The framework's own outcome for the newest terminal run: a missing model or a failed request. */
  runFailure?: { reason: string; message: string } | null;
  /** Diagnostics from resolving `enabledModels`, e.g. a pattern that matched nothing. */
  modelScopeWarnings?: string[];
  onModelChange?: (provider: string, modelId: string) => void;
  modelSwitching?: boolean;
  thinkingLevel?: ThinkingLevel;
  /** New session has not committed a thinking level; the button still shows the resolved default. */
  isAutoThinkingSelection?: boolean;
  onThinkingLevelChange?: (level: ThinkingLevel) => void;
  availableThinkingLevels?: string[] | null;
  thinkingLevelMap?: Record<string, string | null> | null;
  queuedMessages?: QueuedMessagesView | null;
  /**
   * The same queue as items, with the source and the token each per-item control needs. It is the authoritative queue
   * for the rows: the text lists beside it stay for the count and for a caller that has no items.
   */
  queuedItems?: readonly QueuedItemProjection[] | null;
  /** The conversation's committed input control. `held` is the user's own stop, which only they can end. */
  control?: { state: "allowed" | "held"; revision: number; stopSource?: "user" | "agent"; stoppedAt?: number } | null;
  /**
   * Edit one queued item against the token it was read at. The answer says whether the edit landed; a conflict comes
   * back with the **current** item, which is what the row then shows instead of the text the user typed.
   */
  onEditItem?: (submissionId: string, contentToken: string, content: string) => Promise<{ ok: true } | { ok: false; reason: string; code?: string; current?: QueuedItemProjection }>;
  /** Cancel one queued item through the host's own native abort. */
  onCancelItem?: (submissionId: string) => Promise<{ ok: boolean; reason?: string; code?: string }>;
  /**
   * The user's explicit Continue: the one thing that ends their own stop. It is offered only while the conversation is
   * held, and a resume whose old scope still drains answers `stopping` — which this surface shows rather than pretending
   * the queue moved.
   */
  onContinue?: () => Promise<"resumed" | "stopping" | "allowed" | "failed">;
  /** Open the child's own record for one report item, so the whole answer behind a preview stays reachable. */
  onOpenConversation?: (conversationId: string) => void;
  inputHistory?: string[];
  onRecallQueue?: () => void;
  slashCommands?: SlashCommandInfo[];
  slashCommandsLoading?: boolean;
  onLoadSlashCommands?: () => Promise<SlashCommandInfo[]> | SlashCommandInfo[];
  onBuiltinCommand?: (message: string) => Promise<BuiltinSlashCommandResult>;
  soundEnabled?: boolean;
  onSoundToggle?: () => void;
  onAudioUnlock?: () => void;
  draftKey?: string;
  /** Session working directory — enables the @ file autocomplete menu */
  cwd?: string | null;
}

/**
 * The conversation operations, stated over the props a chat surface already passes.
 *
 * This is the composer's entire business seam: a text and its pictures, one built-in command, one queued item by the
 * identity the host gave it. The adapter is the only place that knows which props carry them, so the rest of the
 * composer — and its tests — speak the port rather than the surface's prop list.
 */
function composerCommands(props: Props): ComposerCommands {
  if (props.commands !== undefined) return props.commands;
  const images = (value?: readonly AttachedImage[]) => (value === undefined ? undefined : [...value]);
  // A compact quote box is a text collector: it sends the prompt it holds and has no queue, catalog or queued item to
  // reach. Stating that as its own port keeps the send seam identical instead of branching on `compact` at every use.
  if (props.compact) {
    return {
      send: (text, attached) => props.onSend(text, images(attached)),
      steer: () => {},
      followUp: () => {},
      promptWithStreamingBehavior: () => {},
      runBuiltin: async () => ({ handled: false }),
      continueRun: async () => "failed",
      recallQueue: () => {},
      editItem: async () => ({ ok: false, reason: "A quote box holds no queued items." }),
      cancelItem: async () => ({ ok: false, reason: "A quote box holds no queued items." }),
    };
  }
  return {
    send: (text, attached) => props.onSend(text, images(attached)),
    steer: (text, attached) => props.onSteer?.(text, images(attached)),
    followUp: (text, attached) => props.onFollowUp?.(text, images(attached)),
    promptWithStreamingBehavior: (text, behavior, attached) => props.onPromptWithStreamingBehavior?.(text, behavior, images(attached)),
    runBuiltin: async (message) => {
      if (props.onBuiltinCommand === undefined) return { handled: false };
      return props.onBuiltinCommand(message);
    },
    continueRun: async () => (props.onContinue === undefined ? "failed" : props.onContinue()),
    recallQueue: () => props.onRecallQueue?.(),
    editItem: async (submissionId, contentToken, content) => (
      props.onEditItem === undefined
        ? { ok: false, reason: "Editing a queued item is not available here." }
        : props.onEditItem(submissionId, contentToken, content)
    ),
    cancelItem: async (submissionId) => (
      props.onCancelItem === undefined
        ? { ok: false, reason: "Cancelling a queued item is not available here." }
        : props.onCancelItem(submissionId)
    ),
  };
}

const TEXTAREA_MAX_HEIGHT = 200;

export const ChatInput = forwardRef<ChatInputHandle, Props>(function ChatInput(props, ref) {
  const { isStreaming, compact = false } = props;
  const { t } = useI18n();
  const { fontSize } = useChatAppearance();
  const { ui: uiFontFamily, uiWeight } = useFontPreferences();
  const isMobile = useIsMobile();

  const [thinkingDropdownOpen, setThinkingDropdownOpen] = useState(false);
  const [controlsMenuOpen, setControlsMenuOpen] = useState(false);
  const [imageWarningDismissed, setImageWarningDismissed] = useState(false);
  const [imageRejections, setImageRejections] = useState<readonly ImageFileRejection[]>([]);
  const [continuePhase, setContinuePhase] = useState<null | "pending" | "stopping">(null);
  const [builtinCommandPending, setBuiltinCommandPending] = useState(false);
  /** Bumped whenever the surface replaces the draft from outside the textarea, so every menu closes. */
  const [draftReplaced, setDraftReplaced] = useState(0);
  const pendingImageCountRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const controlsMenuRef = useRef<HTMLDivElement>(null);
  /** The editor handle, mirrored into a ref because the menus and the paste path call it from callbacks. */
  const editorRef = useRef<ComposerEditorHandle | null>(null);

  const drafts = useComposerDrafts();

  const closeMenus = useCallback(() => setDraftReplaced((count) => count + 1), []);

  const draft = useComposerDraft({
    drafts,
    draftKey: props.draftKey,
    attachmentsEnabled: !compact,
    measureKey: `${fontSize}|${uiFontFamily}|${uiWeight}`,
    handleRef: editorRef,
    pendingImages: pendingImageCountRef,
    onImageRejections: setImageRejections,
    onDraftReplaced: closeMenus,
  });

  const commands = useMemo<ComposerCommands>(() => composerCommands(props), [
    props.commands, props.compact, props.onSend, props.onSteer, props.onFollowUp, props.onPromptWithStreamingBehavior,
    props.onBuiltinCommand, props.onContinue, props.onRecallQueue, props.onEditItem, props.onCancelItem,
  ]);

  const dispatch = useMemo(() => createComposerDispatch({
    isStreaming,
    draft: (): ComposerDraftValue => ({ text: draft.valueRef.current, images: draft.imagesRef.current }),
    commands,
    clearInput: draft.clearInput,
    unlockAudio: () => props.onAudioUnlock?.(),
    onBuiltinPendingChange: setBuiltinCommandPending,
  }), [commands, draft.clearInput, draft.imagesRef, draft.valueRef, isStreaming, props.onAudioUnlock]);

  const bashMode = isShellCommandDraft(draft.value, draft.images.length);
  const canQueueStreamingMessage = draft.value.trim().length > 0 || draft.images.length > 0;
  const showImageUnsupportedWarning = draft.images.length > 0
    && !modelSupportsImageInput(props.model, props.modelList)
    && !imageWarningDismissed;
  useEffect(() => {
    if (draft.images.length === 0) setImageWarningDismissed(false);
  }, [draft.images.length]);

  const runContinue = useCallback(async () => {
    if (props.onContinue === undefined || continuePhase !== null) return;
    setContinuePhase("pending");
    const outcome = await dispatch.continueRun();
    // The host's own control state arrives on the next frame, so this only states the phase the answer named.
    setContinuePhase(outcome === "stopping" ? "stopping" : null);
  }, [continuePhase, dispatch, props.onContinue]);

  // The handle the surrounding surface holds and the handle the menus complete into are the same object: `insertText`
  // and the `@` completion both go through one native range replacement, so a completed mention and a quoted insertion
  // are one kind of edit — undoable, and observed by the controlled value through the input event the textarea fires.
  useImperativeHandle(ref, () => draft.handle, [draft.handle]);

  const skillDormancy = useSkillDormancy(props.cwd, Boolean(draft.value.startsWith("/")) && !compact);

  const menus = useComposerMenus({
    value: draft.value,
    setValue: draft.setValue,
    replaceValue: draft.replaceValue,
    textareaRef: draft.textareaRef,
    closeMenuSignal: draftReplaced,
    cwd: props.cwd,
    compact,
    isStreaming,
    inputHistory: props.inputHistory ?? [],
    slashCommands: props.slashCommands,
    onLoadSlashCommands: props.onLoadSlashCommands,
    skillDormancy,
    submit: () => { void dispatch.submit(); },
    queue: dispatch.queue,
    canSteer: props.onSteer !== undefined,
    onAbort: props.onAbort,
    editorRef,
  });

  // Shift+Enter on desktop, Enter on mobile keyboards: every newline the textarea inserts arrives here, while IME
  // confirmations and sends do not.
  useEffect(() => {
    const ta = draft.textareaRef.current;
    if (!ta) return;
    const continueList = (event: InputEvent) => {
      if (event.inputType !== "insertLineBreak" || event.isComposing) return;
      const edit = getMarkdownListContinuation(ta.value, ta.selectionStart, ta.selectionEnd);
      if (!edit) return;
      event.preventDefault();
      ta.setSelectionRange(edit.start, edit.end);
      // insertText keeps the edit on the native undo stack and fires the input event that updates the controlled value.
      document.execCommand(edit.text ? "insertText" : "delete", false, edit.text);
    };
    ta.addEventListener("beforeinput", continueList);
    return () => ta.removeEventListener("beforeinput", continueList);
  }, [draft.textareaRef]);

  useEffect(() => {
    if (!isMobile) setControlsMenuOpen(false);
  }, [isMobile]);

  useEffect(() => {
    const handler = (event: MouseEvent) => {
      if (controlsMenuRef.current && !controlsMenuRef.current.contains(event.target as Node)) {
        setControlsMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  return (
    <fieldset
      disabled={builtinCommandPending}
      aria-busy={builtinCommandPending}
      className={compact ? undefined : "chat-input-shell"}
      style={{
        flexShrink: 0,
        minWidth: 0,
        margin: 0,
        border: 0,
        background: "transparent",
        padding: compact ? 0 : "0 16px 8px",
        paddingRight: compact ? 0 : isMobile ? 16 : 52, // desktop: 16px base + 36px for ChatMinimap alignment
        opacity: builtinCommandPending ? 0.5 : 1,
        transition: "opacity 0.15s",
      }}
    >
      {!compact && (
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          style={{ display: "none" }}
          onChange={(event) => {
            const files = Array.from(event.target.files ?? []);
            draft.addImages(files);
            event.target.value = "";
          }}
        />
      )}
      <div style={{ maxWidth: "var(--chat-content-max-width, 820px)", margin: "0 auto" }}>
        <ModelErrorBanner error={props.modelError} />
        <RunFailureBanner failure={props.runFailure} />
        <ModelScopeWarningBanner warnings={props.modelScopeWarnings} />
        {draft.storageIssue !== null && <DraftStorageBanner onClose={draft.dismissStorageIssue} />}
        <ImageRejectionBanner rejections={imageRejections} onClose={() => setImageRejections([])} />
        {showImageUnsupportedWarning && (() => {
          const entry = props.modelList?.find((m) => m.provider === props.model?.provider && m.id === props.model?.modelId);
          return (
            <ImageNotSupportedBanner
              modelLabel={entry?.name || props.model?.modelId || ""}
              onClose={() => setImageWarningDismissed(true)}
            />
          );
        })()}

        {/* The user's own stop. While it is held nothing the queue holds will run, so the surface says so and offers the
            one control that ends it — the user's own Continue. An automatic report is a queued item like any other, so
            the same rows below decide what the model eventually reads (spec D07, D08, D09). */}
        {props.control?.state === "held" && (
          <HeldBanner phase={continuePhase} {...(props.onContinue === undefined ? {} : { onContinue: () => void runContinue() })} />
        )}

        <ComposerQueue
          items={props.queuedItems}
          messages={props.queuedMessages}
          busy={isStreaming}
          {...(props.onEditItem === undefined || props.onCancelItem === undefined
            ? {}
            : { commands: { edit: props.onEditItem, cancel: props.onCancelItem } })}
          {...(props.onRecallQueue === undefined ? {} : { onRecall: props.onRecallQueue })}
          {...(props.onOpenConversation === undefined ? {} : { onOpenConversation: props.onOpenConversation })}
        />

        {/* Image previews */}
        {draft.images.length > 0 && (
          <div style={{ display: "flex", gap: 6, marginBottom: 6, flexWrap: "wrap" }}>
            {draft.images.map((image, index) => (
              <div key={image.previewUrl} style={{ position: "relative", flexShrink: 0 }}>
                <ImagePreview src={image.previewUrl}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={image.previewUrl}
                    alt=""
                    style={{ width: 56, height: 56, objectFit: "cover", borderRadius: 6, border: "1px solid var(--border)", display: "block" }}
                  />
                </ImagePreview>
                <button
                  type="button"
                  onClick={() => draft.removeImage(index)}
                  style={{
                    position: "absolute", top: -4, right: -4,
                    width: 16, height: 16, borderRadius: "50%",
                    background: "var(--bg-panel)", border: "1px solid var(--border)",
                    display: "flex", alignItems: "center", justifyContent: "center",
                    cursor: "pointer", padding: 0, color: "var(--text-muted)",
                  }}
                >
                  <svg width="8" height="8" viewBox="0 0 8 8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                    <line x1="1" y1="1" x2="7" y2="7" /><line x1="7" y1="1" x2="1" y2="7" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        )}

        <div style={{ position: "relative", minWidth: 0 }}>
          <ComposerPopups menus={menus} slashCommandsLoading={props.slashCommandsLoading ?? false} />
          <div
            style={{
              minWidth: 0,
              display: "flex",
              flexDirection: compact ? "column" : "row",
              gap: 8,
              alignItems: compact ? "stretch" : "center",
              background: "var(--bg)",
              border: compact ? "none" : `1px solid ${bashMode ? "var(--tool-bg)" : isStreaming && (props.onSteer || props.onFollowUp)
                ? "rgba(234,179,8,0.4)"
                : "color-mix(in srgb, var(--border) 70%, transparent)"}`,
              borderRadius: compact ? 0 : 14,
              padding: compact ? 0 : isMobile ? "6px 6px 6px 12px" : "10px 10px 10px 14px",
              boxShadow: compact ? "none" : "0 1px 2px rgba(15,23,42,0.04), 0 8px 24px -12px rgba(15,23,42,0.10)",
              transition: "border-color 0.15s, background 0.15s, box-shadow 0.15s",
            } as React.CSSProperties}
          >
            <textarea
              ref={draft.textareaRef}
              className="chat-input-textarea"
              aria-label={compact ? t("chat.quoteQuestion") : undefined}
              value={draft.value}
              onChange={menus.handleChange}
              onSelect={menus.handleSelect}
              onKeyDown={menus.handleKeyDown}
              onCompositionStart={menus.handleCompositionStart}
              onCompositionEnd={menus.handleCompositionEnd}
              onInput={menus.handleInput}
              onPaste={menus.handlePaste}
              placeholder={
                isStreaming && (props.onSteer || props.onFollowUp)
                  ? t("chat.steerPlaceholder")
                  : isStreaming ? t("chat.agentPlaceholder")
                  : t("chat.messagePlaceholder")
              }
              rows={1}
              style={{
                flex: compact ? "none" : 1,
                minWidth: 0,
                width: "100%",
                background: "none",
                border: "none",
                outline: "none",
                resize: "none",
                color: "var(--text)",
                fontSize: "var(--chat-content-font-size, 14px)",
                lineHeight: 1.6,
                fontFamily: "inherit",
                minHeight: compact ? 96 : 24,
                maxHeight: TEXTAREA_MAX_HEIGHT,
                overflow: "auto",
              }}
            />

            {isStreaming ? (
              <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0, alignSelf: "flex-end" }}>
                {props.onSteer && (
                  <button
                    onClick={() => dispatch.queue("steer")}
                    disabled={!canQueueStreamingMessage}
                    title={t("chat.steerHint")}
                    style={{
                      display: "flex", alignItems: "center", gap: 5,
                      padding: "7px 12px",
                      background: canQueueStreamingMessage ? "rgba(234,179,8,0.12)" : "none",
                      border: "1px solid rgba(234,179,8,0.35)",
                      borderRadius: 8,
                      color: canQueueStreamingMessage ? "rgba(180,130,0,1)" : "var(--text-dim)",
                      cursor: canQueueStreamingMessage ? "pointer" : "not-allowed",
                      fontSize: 13, fontWeight: 600, letterSpacing: "-0.01em",
                      transition: "background 0.12s",
                    }}
                  >
                    <svg width="12" height="12" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M5 1 L9 5 L5 9" /><line x1="1" y1="5" x2="9" y2="5" />
                    </svg>
                    {t("chat.steer")}
                  </button>
                )}
                {props.onFollowUp && (
                  <button
                    onClick={() => dispatch.queue("followup")}
                    disabled={!canQueueStreamingMessage}
                    title={`${t("chat.followUpHint")} (${isMobile ? "Ctrl/Cmd+" : ""}Alt/Option+Enter)`}
                    aria-keyshortcuts={isMobile ? "Control+Alt+Enter Meta+Alt+Enter" : "Alt+Enter"}
                    style={{
                      display: "flex", alignItems: "center", gap: 5,
                      padding: "7px 12px",
                      background: canQueueStreamingMessage ? "rgba(129,140,248,0.12)" : "none",
                      border: "1px solid rgba(129,140,248,0.35)",
                      borderRadius: 8,
                      color: canQueueStreamingMessage ? "rgba(99,102,241,1)" : "var(--text-dim)",
                      cursor: canQueueStreamingMessage ? "pointer" : "not-allowed",
                      fontSize: 13, fontWeight: 600, letterSpacing: "-0.01em",
                      transition: "background 0.12s",
                    }}
                  >
                    <svg width="12" height="12" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="5" y1="1" x2="5" y2="6" /><polyline points="2.5 3.5 5 1 7.5 3.5" />
                      <line x1="2" y1="9" x2="8" y2="9" />
                    </svg>
                    {t("chat.followUp")}
                  </button>
                )}
              </div>
            ) : (
              <button
                onClick={() => void dispatch.submit()}
                disabled={!draft.value.trim() && draft.images.length === 0}
                title={t("chat.send")}
                aria-label={t("chat.send")}
                style={{
                  flexShrink: 0,
                  alignSelf: "flex-end",
                  display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
                  // Mobile: icon-only so the placeholder and draft keep the width.
                  ...(isMobile ? { width: 36, height: 36, padding: 0 } : { padding: "7px 14px" }),
                  background: (draft.value.trim() || draft.images.length) ? "var(--accent)" : "var(--bg-panel)",
                  border: "none",
                  borderRadius: 8,
                  color: (draft.value.trim() || draft.images.length) ? "var(--accent-contrast)" : "var(--text-dim)",
                  cursor: (draft.value.trim() || draft.images.length) ? "pointer" : "not-allowed",
                  fontSize: 13,
                  fontWeight: 600,
                  letterSpacing: "-0.01em",
                  boxShadow: (draft.value.trim() || draft.images.length) ? "0 1px 3px color-mix(in srgb, var(--accent) 25%, transparent)" : "none",
                  transition: "background 0.15s, box-shadow 0.15s",
                }}
              >
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="2" y1="7" x2="11" y2="7" />
                  <polyline points="7.5 3 12 7 7.5 11" />
                </svg>
                {!isMobile && t("chat.send")}
              </button>
            )}
          </div>
        </div>

        {/* A draft that starts with "!" asks for a shell command this host does not run. The limit is stated here, as
            soon as the draft asks for it and before anything is sent: the send refuses the same way, so the text never
            leaves the composer as a command and no session is created to be told about it. */}
        {bashMode && (
          <div className="text-xs px-2 py-1" style={{ color: "var(--text-muted)", marginTop: 4 }}>
            {t("chat.shellNotServed")}
          </div>
        )}

        {!compact && (
          <div className="chat-input-controls" style={{
            marginTop: isMobile ? 4 : 8,
            display: isMobile ? "grid" : "flex",
            gridTemplateColumns: isMobile ? "minmax(0, 1fr) auto" : undefined,
            alignItems: "center",
            gap: 6,
          }}>
            <div style={{ flex: isMobile ? "1 1 auto" : "0 0 auto", minWidth: 0, display: "flex", alignItems: "center", gap: 2 }}>
              <button
                onClick={() => fileInputRef.current?.click()}
                title={t("chat.attachImage")}
                style={{
                  flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center",
                  width: 32, height: 32, padding: 0,
                  background: "none", border: "none",
                  borderRadius: 9,
                  color: draft.images.length ? "var(--accent)" : "var(--text-muted)",
                  cursor: "pointer",
                  opacity: 1,
                  transition: "background 0.12s, color 0.12s",
                }}
                onMouseEnter={(event) => {
                  event.currentTarget.style.background = "var(--bg-hover)";
                  event.currentTarget.style.color = draft.images.length ? "var(--accent)" : "var(--text)";
                }}
                onMouseLeave={(event) => {
                  event.currentTarget.style.background = "none";
                  event.currentTarget.style.color = draft.images.length ? "var(--accent)" : "var(--text-muted)";
                }}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                  <circle cx="8.5" cy="8.5" r="1.5" />
                  <polyline points="21 15 16 10 5 21" />
                </svg>
              </button>
              <ComposerModelControl
                readout={{
                  model: props.model,
                  isAutoSelection: props.isAutoModelSelection,
                  modelNames: props.modelNames,
                  modelList: props.modelList,
                  modelError: props.modelError,
                  switching: props.modelSwitching,
                  ...(props.onModelChange === undefined ? {} : { onModelChange: props.onModelChange }),
                }}
                disabled={isStreaming}
              />
            </div>

            {!isMobile && <div style={{ flex: 1 }} />}

            <div ref={controlsMenuRef} style={{
              flex: "0 0 auto",
              display: "flex",
              alignItems: "center",
              justifyContent: "flex-end",
              position: "relative",
              marginLeft: isMobile ? 0 : "auto",
            }}>
              {isMobile && (
                <button
                  type="button"
                  title={controlsMenuOpen ? undefined : t("chat.moreControls")}
                  aria-label={t("chat.moreControls")}
                  aria-expanded={controlsMenuOpen}
                  aria-hidden={controlsMenuOpen || undefined}
                  tabIndex={controlsMenuOpen ? -1 : undefined}
                  onClick={() => setControlsMenuOpen(true)}
                  style={{
                    display: "flex", alignItems: "center", justifyContent: "center",
                    width: "100%", height: 32, padding: "8px 10px",
                    background: "none", border: "none", borderRadius: 9,
                    color: "var(--text-muted)",
                    cursor: controlsMenuOpen ? "default" : "pointer",
                    fontSize: 12, fontWeight: 500,
                    visibility: controlsMenuOpen ? "hidden" : "visible",
                    pointerEvents: controlsMenuOpen ? "none" : "auto",
                    transition: "background 0.12s, color 0.12s",
                  }}
                  onMouseEnter={(event) => {
                    if (controlsMenuOpen) return;
                    event.currentTarget.style.background = "var(--bg-hover)";
                    event.currentTarget.style.color = "var(--text)";
                  }}
                  onMouseLeave={(event) => {
                    if (controlsMenuOpen) return;
                    event.currentTarget.style.background = "none";
                    event.currentTarget.style.color = "var(--text-muted)";
                  }}
                >
                  {t("chat.moreControls")}
                </button>
              )}
              <div style={{
                display: isMobile ? (controlsMenuOpen ? "flex" : "none") : "flex",
                alignItems: "center",
                gap: isMobile ? 1 : 2,
                ...(isMobile ? {
                  position: "absolute",
                  right: 0,
                  bottom: 0,
                  zIndex: 60,
                  padding: 1,
                  width: "max-content",
                  maxWidth: "calc(100vw - 32px)",
                  flexWrap: "nowrap",
                  justifyContent: "flex-end",
                  border: "1px solid color-mix(in srgb, var(--border) 72%, transparent)",
                  borderRadius: 10,
                  background: "color-mix(in srgb, var(--bg-panel) 92%, var(--bg))",
                  boxShadow: "0 8px 24px rgba(0,0,0,0.14)",
                  backdropFilter: "blur(10px)",
                } : null),
              }}>
                <ComposerThinkingControl
                  readout={{
                    level: props.thinkingLevel,
                    isAutoSelection: props.isAutoThinkingSelection,
                    availableLevels: props.availableThinkingLevels,
                    levelMap: props.thinkingLevelMap,
                    ...(props.onThinkingLevelChange === undefined ? {} : { onLevelChange: props.onThinkingLevelChange }),
                  }}
                  isStreaming={isStreaming}
                  open={thinkingDropdownOpen}
                  onOpenChange={setThinkingDropdownOpen}
                />

                {isStreaming && (
                  <button
                    onClick={props.onAbort}
                    title={t("chat.stopAgent")}
                    style={{
                      display: "flex", alignItems: "center", gap: 6,
                      padding: "8px 14px",
                      height: 32,
                      background: "rgba(239,68,68,0.08)",
                      border: "1px solid rgba(239,68,68,0.3)",
                      borderRadius: 9,
                      color: "#ef4444",
                      cursor: "pointer",
                      fontSize: 12, fontWeight: 600,
                      whiteSpace: "nowrap", letterSpacing: "-0.01em",
                      transition: "background 0.12s",
                    }}
                    onMouseEnter={(event) => { event.currentTarget.style.background = "rgba(239,68,68,0.16)"; }}
                    onMouseLeave={(event) => { event.currentTarget.style.background = "rgba(239,68,68,0.08)"; }}
                  >
                    <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                      <rect x="1.5" y="1.5" width="7" height="7" rx="1.5" fill="currentColor" />
                    </svg>
                    {t("chat.stop")}
                  </button>
                )}

                {props.onSoundToggle !== undefined && (
                  <button
                    onClick={props.onSoundToggle}
                    title={props.soundEnabled ? t("chat.disableSound") : t("chat.enableSound")}
                    aria-label={props.soundEnabled ? t("chat.disableSound") : t("chat.enableSound")}
                    style={{
                      display: "flex", alignItems: "center", justifyContent: "center", gap: 5,
                      width: 32, height: 32, padding: 0,
                      background: "none", border: "none", borderRadius: 9,
                      color: props.soundEnabled ? "var(--text-muted)" : "var(--text-dim)",
                      cursor: "pointer",
                      opacity: props.soundEnabled ? 1 : 0.55,
                      transition: "background 0.12s, color 0.12s, opacity 0.12s",
                    }}
                    onMouseEnter={(event) => {
                      event.currentTarget.style.background = "var(--bg-hover)";
                      event.currentTarget.style.color = "var(--text)";
                      event.currentTarget.style.opacity = "1";
                    }}
                    onMouseLeave={(event) => {
                      event.currentTarget.style.background = "none";
                      event.currentTarget.style.color = props.soundEnabled ? "var(--text-muted)" : "var(--text-dim)";
                      event.currentTarget.style.opacity = props.soundEnabled ? "1" : "0.55";
                    }}
                  >
                    {props.soundEnabled ? (
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                        <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                        <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
                      </svg>
                    ) : (
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                        <line x1="23" y1="9" x2="17" y2="15" />
                        <line x1="17" y1="9" x2="23" y2="15" />
                      </svg>
                    )}
                  </button>
                )}
                {isMobile && controlsMenuOpen && (
                  <button
                    type="button"
                    title={t("chat.collapseControls")}
                    aria-label={t("chat.collapseControls")}
                    aria-expanded={true}
                    onClick={() => {
                      setThinkingDropdownOpen(false);
                      setControlsMenuOpen(false);
                    }}
                    style={{
                      display: "flex", alignItems: "center", justifyContent: "center",
                      width: 36, height: 32, padding: 0, marginLeft: 0,
                      background: "var(--bg-hover)",
                      border: "none",
                      borderLeft: "1px solid color-mix(in srgb, var(--border) 72%, transparent)",
                      borderRadius: "0 9px 9px 0",
                      color: "var(--text)",
                      cursor: "pointer",
                      transition: "background 0.12s, color 0.12s",
                    }}
                    onMouseEnter={(event) => { event.currentTarget.style.background = "var(--bg-selected)"; }}
                    onMouseLeave={(event) => { event.currentTarget.style.background = "var(--bg-hover)"; }}
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                      <line x1="18" y1="6" x2="6" y2="18" />
                      <line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </button>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </fieldset>
  );
});
