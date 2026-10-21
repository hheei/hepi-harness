/**
 * The composer's menus and keys: the `@` file index, the `/` palette, the input-history popup, and the one key handler
 * that decides which of them (or a send) an Enter, Tab, arrow or Escape belongs to.
 *
 * This is the editor's interaction layer. It reads the live text and the caret, and it answers with a replacement of
 * the draft — it never dispatches a turn itself except through the two callbacks the surface hands it (`submit`,
 * `queue`), so the priority between "the palette consumes this Enter" and "this Enter sends" is stated once, here, in
 * the same order a user learns it.
 *
 * IME is a first-class case rather than a guard bolted onto a keypress: a composition is never a command, so every
 * menu and every send is skipped while one is open, and a composition that just ended keeps the next Enter for a short
 * grace period so a confirming keystroke cannot arrive as a send.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { buildEntriesFromFiles, filterFileEntries, isWorkspaceRoutingPath, type FileIndexEntry } from "@hepi/protocol/files";
import { buildAtInsertText, extractAtQuery, type AtQueryMatch } from "../../lib/file/file-fuzzy";
import { useOptionalWorkbenchConnection } from "../../lib/workbench-scope";
import { useEnterSendMode } from "../../hooks/useEnterSendMode";
import { useIsMobile } from "../../hooks/useIsMobile";
import { useI18n } from "../../hooks/useI18n";
import { cycleListIndex, replaceLinksWithMarkdown, replaceTextareaRange, subscribeUpwardMenuMaxHeight } from "./editor-text";
import { COMPOSITION_END_ENTER_GRACE_MS, decideComposerKey, type ComposerKeyAction } from "./keyboard";
import {
  buildSlashCommandLayout,
  matchingSlashCommands,
  slashQueryOf,
  submitsSlashCommandOnEnter,
  type SlashCommandPaletteItem,
} from "./commands";
import type { ComposerEditorHandle } from "./useComposerDraft";

const FILE_INDEX_FRESHNESS_MS = 10_000;
const SERVER_SEARCH_DEBOUNCE_MS = 150;
const TEXT_COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

type MenuState = { open: boolean; maxHeight: number | null };

export interface ComposerMenusOptions {
  value: string;
  setValue(value: string): void;
  /** Replace the draft from outside the textarea. */
  replaceValue(next: string): void;
  textareaRef: { current: HTMLTextAreaElement | null };
  /** The draft's menus all close when a rekey, restore or clear replaced the text. */
  closeMenuSignal: number;
  onOpenMenusChange?(open: boolean): void;
  cwd: string | null | undefined;
  compact: boolean;
  isStreaming: boolean;
  inputHistory: readonly string[];
  slashCommands: readonly import("../../hooks/useAgentSession").SlashCommandInfo[] | undefined;
  onLoadSlashCommands?: () => Promise<import("../../hooks/useAgentSession").SlashCommandInfo[]> | import("../../hooks/useAgentSession").SlashCommandInfo[];
  skillDormancy: Record<string, boolean>;
  submit(): void;
  queue(mode: "steer" | "followup"): void;
  /** Whether Steer is offered: while it is not, Enter queues a follow-up instead. */
  canSteer: boolean;
  onAbort?: () => void;
  /** The composer's own key: the editor handle, so the menus can complete into it. */
  editorRef: { current: ComposerEditorHandle | null };
}

export interface ComposerMenus {
  atMenuOpen: boolean;
  atMatches: FileIndexEntry[];
  atActiveIndex: number;
  atMenuMaxHeight: number | null;
  atMenuRef: React.RefObject<HTMLDivElement | null>;
  atItemRefs: React.RefObject<Array<HTMLButtonElement | null>>;
  atIndexLoading: boolean;
  atTruncated: boolean;
  atServerSearchPending: boolean;
  /** A server-ranked answer is on screen instead of the local index's. */
  atServerResultActive: boolean;
  /** The dormancy map the palette annotates skills with. */
  skillDormancy: Record<string, boolean>;
  /** The recalled inputs the history popup lists. */
  historyItems: readonly string[];
  atQuery: AtQueryMatch | null;
  setAtActiveIndex(index: number): void;
  completeFile(entry: FileIndexEntry): void;
  slashMenuOpen: boolean;
  slashQuery: string | null;
  slashActiveIndex: number;
  slashMenuMaxHeight: number | null;
  slashMenuRef: React.RefObject<HTMLDivElement | null>;
  slashItemRefs: React.RefObject<Array<HTMLButtonElement | null>>;
  slashMatches: SlashCommandPaletteItem[];
  groupedSlashCommands: ReturnType<typeof buildSlashCommandLayout>["groups"];
  setSlashActiveIndex(index: number): void;
  completeSlashCommand(command: SlashCommandPaletteItem): void;
  historyMenuOpen: boolean;
  historyActiveIndex: number;
  historyMenuRef: React.RefObject<HTMLDivElement | null>;
  historyItemRefs: React.RefObject<Array<HTMLButtonElement | null>>;
  setHistoryActiveIndex(index: number): void;
  applyHistoryInput(text: string): void;
  handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void;
  handleChange(event: React.ChangeEvent<HTMLTextAreaElement>): void;
  handleInput(event: React.FormEvent<HTMLTextAreaElement>): void;
  handlePaste(event: React.ClipboardEvent<HTMLTextAreaElement>): void;
  handleCompositionStart(): void;
  handleCompositionEnd(event: React.CompositionEvent<HTMLTextAreaElement>): void;
  handleSelect(event: React.SyntheticEvent<HTMLTextAreaElement>): void;
}

export function useComposerMenus(options: ComposerMenusOptions): ComposerMenus {
  const { t } = useI18n();
  const isMobile = useIsMobile();
  const enterSendMode = useEnterSendMode();
  const files = useOptionalWorkbenchConnection()?.files ?? null;
  const { value, setValue, textareaRef, cwd, compact, isStreaming, inputHistory } = options;

  const [atQuery, setAtQuery] = useState<AtQueryMatch | null>(null);
  const [atMenu, setAtMenu] = useState<MenuState>({ open: false, maxHeight: null });
  const [atActiveIndex, setAtActiveIndex] = useState(0);
  const [fileIndex, setFileIndex] = useState<{ cwd: string; entries: FileIndexEntry[]; truncated: boolean } | null>(null);
  const [fileIndexLoading, setFileIndexLoading] = useState(false);
  const [atServerResult, setAtServerResult] = useState<{ cwd: string; query: string; matches: FileIndexEntry[] } | null>(null);
  const [slashMenu, setSlashMenu] = useState<MenuState>({ open: false, maxHeight: null });
  const [slashActiveIndex, setSlashActiveIndex] = useState(0);
  const [historyMenuOpen, setHistoryMenuOpen] = useState(false);
  const [historyActiveIndex, setHistoryActiveIndex] = useState(0);
  const isComposingRef = useRef(false);
  const lastCompositionEndAtRef = useRef(0);
  const slashCommandsRequestedRef = useRef(false);
  const fileIndexMetaRef = useRef<{ cwd: string; fetchedAt: number } | null>(null);
  const fileIndexFetchingRef = useRef<string | null>(null);
  const atMenuRef = useRef<HTMLDivElement | null>(null);
  const atItemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const slashMenuRef = useRef<HTMLDivElement | null>(null);
  const slashItemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const historyMenuRef = useRef<HTMLDivElement | null>(null);
  const historyItemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const closeMenus = useCallback(() => {
    setAtQuery(null);
    setAtMenu({ open: false, maxHeight: null });
    setSlashMenu({ open: false, maxHeight: null });
    setHistoryMenuOpen(false);
  }, []);

  // Every replacement the surface performs (rekey, restored submission, clear) closes the menus: they describe a caret
  // that no longer exists.
  const closeMenuSignal = options.closeMenuSignal;
  const lastCloseSignal = useRef(closeMenuSignal);
  useEffect(() => {
    if (lastCloseSignal.current === closeMenuSignal) return;
    lastCloseSignal.current = closeMenuSignal;
    closeMenus();
  }, [closeMenuSignal, closeMenus]);

  // ── @ file completion ───────────────────────────────────────────────────
  // Recomputed from the text before the caret on every change and caret move. Disabled with no cwd (a fresh composer
  // without a directory has no files to mention).
  const updateAtQuery = useCallback((text: string, cursor: number | null) => {
    if (!cwd) {
      setAtQuery(null);
      return;
    }
    setAtQuery(extractAtQuery(text.slice(0, cursor ?? text.length)));
  }, [cwd]);

  const atQueryText = atQuery?.query ?? null;
  const atLocalMatches: FileIndexEntry[] = useMemo(() => (
    atQueryText !== null && fileIndex && fileIndex.cwd === cwd
      ? filterFileEntries(fileIndex.entries, atQueryText)
      : []
  ), [atQueryText, fileIndex, cwd]);

  // When the client index is truncated (a repository larger than the index cap) local filtering cannot see deep
  // files, so queries are also ranked server-side against the full listing. Local matches render immediately and are
  // replaced when the debounced server result for the current query arrives; a stale answer is ignored by its tag.
  const needsServerSearch = Boolean(atQueryText && fileIndex?.truncated && fileIndex.cwd === cwd);
  useEffect(() => {
    if (!needsServerSearch || !cwd || !atQueryText || files === null) return;
    // The index belongs to a workspace. A conversation with no execution workspace has no files to mention, so the
    // composer keeps its local matches instead of asking the workspace API about a cwd that is not one.
    if (!isWorkspaceRoutingPath(cwd)) return;
    const fetchCwd = cwd;
    const query = atQueryText;
    const timer = setTimeout(() => {
      files.index(fetchCwd, query)
        .then((data) => setAtServerResult({ cwd: fetchCwd, query, matches: "matches" in data ? data.matches : [] }))
        .catch(() => {
          // Keep showing local matches; the next keystroke retries.
        });
    }, SERVER_SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [needsServerSearch, atQueryText, cwd, files]);

  const serverResultInUse = needsServerSearch
    && atServerResult !== null
    && atServerResult.cwd === cwd
    && atServerResult.query === atQueryText;
  const atMatches: FileIndexEntry[] = serverResultInUse ? atServerResult.matches : atLocalMatches;

  // Open/reset the menu whenever the @token appears or changes (the slash menu behaves the same way: Escape closes it,
  // the next keystroke re-opens it).
  const atTokenKey = atQuery === null ? null : `${atQuery.start}:${atQuery.quoted ? 1 : 0}:${atQuery.query}`;
  useEffect(() => {
    if (atTokenKey === null) {
      setAtMenu({ open: false, maxHeight: null });
      setAtActiveIndex(0);
      return;
    }
    setAtMenu((current) => ({ ...current, open: true }));
    setAtActiveIndex(0);
  }, [atTokenKey]);

  // Fetch the file index when the menu opens. The server caches per cwd for ~10s, so re-opening refreshes cheaply;
  // while typing nothing refetches.
  const atTokenActive = atQuery !== null;
  useEffect(() => {
    if (!atTokenActive || !cwd || !isWorkspaceRoutingPath(cwd) || files === null) return;
    const meta = fileIndexMetaRef.current;
    if (meta && meta.cwd === cwd && Date.now() - meta.fetchedAt < FILE_INDEX_FRESHNESS_MS) return;
    if (fileIndexFetchingRef.current === cwd) return;
    fileIndexFetchingRef.current = cwd;
    const fetchCwd = cwd;
    setFileIndexLoading(true);
    files.index(fetchCwd)
      .then((data) => {
        const listed = "files" in data ? data.files : data.matches.map((entry) => entry.path);
        setFileIndex({ cwd: fetchCwd, entries: buildEntriesFromFiles(listed), truncated: "truncated" in data && data.truncated === true });
        fileIndexMetaRef.current = { cwd: fetchCwd, fetchedAt: Date.now() };
      })
      .catch(() => {
        // Leave any previous index in place; the next open retries.
        fileIndexMetaRef.current = null;
      })
      .finally(() => {
        fileIndexFetchingRef.current = null;
        setFileIndexLoading(false);
      });
  }, [atTokenActive, cwd, files]);

  const completeFile = useCallback((entry: FileIndexEntry) => {
    if (!atQuery) return;
    const ta = textareaRef.current;
    if (!ta) return;
    const cursor = ta.selectionStart ?? ta.value.length;
    // Completing inside a quoted token (@“my dir/… with the caret before the closing quote) replaces that old quote
    // too, since the insertion has one.
    const replaceEnd = cursor + (atQuery.quoted && ta.value[cursor] === '"' ? 1 : 0);
    const insert = buildAtInsertText(entry.path, entry.isDir, atQuery.quoted);
    const newPos = atQuery.start + insert.cursorOffset;
    replaceTextareaRange(ta, atQuery.start, replaceEnd, insert.text, insert.cursorOffset);
    // The native input event updates the controlled value. Re-derive using the adjusted caret because quoted
    // directories place it before the last quote.
    setAtQuery(extractAtQuery(ta.value.slice(0, newPos)));
  }, [atQuery, textareaRef]);

  useEffect(() => {
    if (atActiveIndex >= atMatches.length) setAtActiveIndex(Math.max(0, atMatches.length - 1));
  }, [atMatches.length, atActiveIndex]);

  useEffect(() => {
    atItemRefs.current.length = atMatches.length;
  }, [atMatches.length]);

  useEffect(() => {
    if (!atMenu.open) return;
    atItemRefs.current[atActiveIndex]?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [atActiveIndex, atMenu.open]);

  // ── / palette ───────────────────────────────────────────────────────────
  const slashQuery = slashQueryOf(value, compact);
  const slashMatches = useMemo(
    () => (slashQuery === null ? [] : matchingSlashCommands(slashQuery, options.slashCommands, isStreaming, t, TEXT_COLLATOR)),
    [isStreaming, options.slashCommands, slashQuery, t],
  );
  const { commands: orderedSlashCommands, groups: groupedSlashCommands } = useMemo(
    () => buildSlashCommandLayout(slashMatches, options.skillDormancy),
    [slashMatches, options.skillDormancy],
  );

  useEffect(() => {
    if (slashQuery === null) {
      setSlashMenu({ open: false, maxHeight: null });
      setSlashActiveIndex(0);
      slashCommandsRequestedRef.current = false;
      return;
    }
    setSlashMenu((current) => ({ ...current, open: true }));
    setSlashActiveIndex(0);
    if (!slashCommandsRequestedRef.current && options.onLoadSlashCommands) {
      slashCommandsRequestedRef.current = true;
      Promise.resolve(options.onLoadSlashCommands()).catch(() => {
        slashCommandsRequestedRef.current = false;
      });
    }
  }, [slashQuery, options.onLoadSlashCommands]);

  useEffect(() => {
    if (slashActiveIndex >= orderedSlashCommands.length) setSlashActiveIndex(Math.max(0, orderedSlashCommands.length - 1));
  }, [orderedSlashCommands.length, slashActiveIndex]);

  // An upward menu is capped by the room its anchor can actually show, measured rather than assumed: the composer sits
  // at the bottom of a viewport a mobile keyboard, a drawer or a scrolled panel can crop.
  useEffect(() => {
    const menu = slashMenuRef.current;
    if (!slashMenu.open || slashQuery === null || !menu) {
      setSlashMenu((current) => (current.maxHeight === null ? current : { ...current, maxHeight: null }));
      return;
    }
    return subscribeUpwardMenuMaxHeight(menu, (maxHeight) => {
      setSlashMenu((current) => (current.maxHeight === maxHeight ? current : { ...current, maxHeight }));
    });
  }, [slashMenu.open, slashQuery]);

  useEffect(() => {
    const menu = atMenuRef.current;
    if (!atMenu.open || atQuery === null || !menu) {
      setAtMenu((current) => (current.maxHeight === null ? current : { ...current, maxHeight: null }));
      return;
    }
    return subscribeUpwardMenuMaxHeight(menu, (maxHeight) => {
      setAtMenu((current) => (current.maxHeight === maxHeight ? current : { ...current, maxHeight }));
    });
  }, [atMenu.open, atQuery]);

  useEffect(() => {
    slashItemRefs.current.length = orderedSlashCommands.length;
  }, [orderedSlashCommands.length]);

  useEffect(() => {
    if (!slashMenu.open) return;
    slashItemRefs.current[slashActiveIndex]?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [slashActiveIndex, slashMenu.open]);

  const completeSlashCommand = useCallback((command: SlashCommandPaletteItem) => {
    const nextValue = `/${command.name} `;
    options.replaceValue(nextValue);
    setSlashMenu({ open: false, maxHeight: null });
    setSlashActiveIndex(0);
    requestAnimationFrame(() => {
      const ta = textareaRef.current;
      if (!ta) return;
      ta.focus();
      ta.setSelectionRange(nextValue.length, nextValue.length);
      ta.style.height = "auto";
      ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
    });
  }, [options, textareaRef]);

  const getNextSlashIndex = useCallback((direction: "up" | "down" | "left" | "right") => {
    const lastIndex = orderedSlashCommands.length - 1;
    if (lastIndex < 0) return 0;

    if (direction === "left") return Math.max(0, slashActiveIndex - 1);
    if (direction === "right") return Math.min(lastIndex, slashActiveIndex + 1);

    const currentNode = slashItemRefs.current[slashActiveIndex];
    if (!currentNode) {
      return direction === "down"
        ? Math.min(lastIndex, slashActiveIndex + 1)
        : Math.max(0, slashActiveIndex - 1);
    }

    const currentRect = currentNode.getBoundingClientRect();
    const currentX = currentRect.left + currentRect.width / 2;
    const currentY = currentRect.top + currentRect.height / 2;
    let bestIndex = -1;
    let bestScore = Number.POSITIVE_INFINITY;

    for (let index = 0; index <= lastIndex; index += 1) {
      if (index === slashActiveIndex) continue;
      const node = slashItemRefs.current[index];
      if (!node) continue;
      const rect = node.getBoundingClientRect();
      const candidateY = rect.top + rect.height / 2;
      const verticalDelta = candidateY - currentY;
      if (direction === "down" ? verticalDelta <= 4 : verticalDelta >= -4) continue;

      const candidateX = rect.left + rect.width / 2;
      const score = Math.abs(verticalDelta) * 1000 + Math.abs(candidateX - currentX);
      if (score < bestScore) {
        bestIndex = index;
        bestScore = score;
      }
    }

    if (bestIndex >= 0) return bestIndex;
    return direction === "down"
      ? Math.min(lastIndex, slashActiveIndex + 1)
      : Math.max(0, slashActiveIndex - 1);
  }, [orderedSlashCommands.length, slashActiveIndex]);

  // ── input history ───────────────────────────────────────────────────────
  useEffect(() => {
    if (historyActiveIndex >= inputHistory.length) setHistoryActiveIndex(Math.max(0, inputHistory.length - 1));
  }, [inputHistory.length, historyActiveIndex]);

  useEffect(() => {
    historyItemRefs.current.length = inputHistory.length;
  }, [inputHistory.length]);

  useEffect(() => {
    if (!historyMenuOpen) return;
    historyItemRefs.current[historyActiveIndex]?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [historyActiveIndex, historyMenuOpen]);

  const applyHistoryInput = useCallback((text: string) => {
    options.replaceValue(text);
    setHistoryMenuOpen(false);
    setHistoryActiveIndex(0);
    setAtQuery(null);
    requestAnimationFrame(() => {
      const ta = textareaRef.current;
      if (!ta) return;
      ta.focus();
      ta.setSelectionRange(text.length, text.length);
      ta.style.height = "auto";
      ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
    });
  }, [options, textareaRef]);

  // ── keys ────────────────────────────────────────────────────────────────
  const handleKeyDown = useCallback((event: KeyboardEvent<HTMLTextAreaElement>) => {
    const nativeEvent = event.nativeEvent;
    const action: ComposerKeyAction = decideComposerKey({
      isMobile,
      enterSendMode,
      composing: isComposingRef.current,
      msSinceCompositionEnd: Date.now() - lastCompositionEndAtRef.current,
      isStreaming,
      canSteer: options.canSteer,
      hasAbortHandler: options.onAbort !== undefined,
      draftEmpty: value.trim().length === 0,
      inputHistoryLength: inputHistory.length,
      historyMenuOpen,
      slashMenuOpen: slashMenu.open,
      slashQuery,
      ...(orderedSlashCommands[slashActiveIndex] === undefined ? {} : { slashSelected: orderedSlashCommands[slashActiveIndex] }),
      atMenuOpen: atMenu.open,
      atQueryOpen: atQuery !== null,
      atHasMatch: atMatches[atActiveIndex] !== undefined,
      value,
    }, {
      key: event.key,
      shiftKey: event.shiftKey,
      altKey: event.altKey,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      isComposing: nativeEvent.isComposing,
      keyCode: nativeEvent.keyCode,
    });

    switch (action.kind) {
      case "native":
        return;
      case "swallow":
        event.preventDefault();
        return;
      case "submit":
        event.preventDefault();
        void options.submit();
        return;
      case "queue":
        event.preventDefault();
        options.queue(action.mode);
        return;
      case "abort":
        event.preventDefault();
        options.onAbort?.();
        return;
      case "slash-move":
        event.preventDefault();
        setSlashActiveIndex(getNextSlashIndex(action.direction));
        return;
      case "slash-close":
        event.preventDefault();
        setSlashMenu({ open: false, maxHeight: null });
        return;
      case "slash-complete":
        event.preventDefault();
        completeSlashCommand(action.command);
        return;
      case "slash-submit":
        event.preventDefault();
        setSlashMenu({ open: false, maxHeight: null });
        void options.submit();
        return;
      case "file-move":
        event.preventDefault();
        setAtActiveIndex((index) => cycleListIndex(index, atMatches.length, action.delta));
        return;
      case "file-close":
        event.preventDefault();
        setAtMenu((current) => ({ ...current, open: false }));
        return;
      case "file-complete": {
        event.preventDefault();
        const entry = atMatches[atActiveIndex];
        if (entry !== undefined) completeFile(entry);
        return;
      }
      case "history-open":
        event.preventDefault();
        setSlashMenu({ open: false, maxHeight: null });
        setAtMenu({ open: false, maxHeight: null });
        setHistoryActiveIndex(inputHistory.length - 1);
        setHistoryMenuOpen(true);
        return;
      case "history-move":
        event.preventDefault();
        setHistoryActiveIndex((index) => Math.max(0, Math.min(inputHistory.length - 1, index + action.delta)));
        return;
      case "history-close":
        event.preventDefault();
        setHistoryMenuOpen(false);
        return;
      case "history-apply": {
        event.preventDefault();
        const recalled = inputHistory[historyActiveIndex];
        if (recalled !== undefined) applyHistoryInput(recalled);
        return;
      }
    }
  }, [applyHistoryInput, atActiveIndex, atMatches, atMenu.open, atQuery, completeFile, completeSlashCommand, getNextSlashIndex, historyActiveIndex, historyMenuOpen, inputHistory, isMobile, isStreaming, orderedSlashCommands, slashActiveIndex, slashMenu.open, slashQuery, value, enterSendMode, options]);

  const handleChange = useCallback((event: React.ChangeEvent<HTMLTextAreaElement>) => {
    options.setValue(event.target.value);
    setHistoryMenuOpen(false);
    updateAtQuery(event.target.value, event.target.selectionStart);
  }, [options, updateAtQuery]);

  const handleInput = useCallback((event: React.FormEvent<HTMLTextAreaElement>) => {
    const ta = event.currentTarget;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
  }, []);

  const handlePaste = useCallback((event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = Array.from(event.clipboardData?.items ?? []);
    const imageItems = items.filter((item) => item.type.startsWith("image/"));
    if (!compact && imageItems.length) {
      event.preventDefault();
      const dropped = imageItems.map((item) => item.getAsFile()).filter((file): file is File => file !== null);
      options.editorRef.current?.addImages(dropped);
      return;
    }

    const html = event.clipboardData.getData("text/html");
    const text = event.clipboardData.getData("text/plain");
    if (!html || !text) return;
    const document = new DOMParser().parseFromString(html, "text/html");
    const links = Array.from(document.querySelectorAll("a[href]"), (link) => {
      const label = link.textContent ?? "";
      const range = document.createRange();
      range.setStart(document.body, 0);
      range.setEndBefore(link);
      return {
        label,
        href: link.getAttribute("href")?.trim() ?? "",
        occurrence: label ? range.toString().split(label).length - 1 : 0,
      };
    });
    const markdown = replaceLinksWithMarkdown(text, links);
    if (markdown === null) return;

    const ta = event.currentTarget;
    const start = ta.selectionStart;
    const nextValue = ta.value.slice(0, start) + markdown + ta.value.slice(ta.selectionEnd);
    event.preventDefault();
    options.replaceValue(nextValue);
    updateAtQuery(nextValue, start + markdown.length);
    requestAnimationFrame(() => {
      ta.focus();
      ta.setSelectionRange(start + markdown.length, start + markdown.length);
    });
  }, [compact, options, updateAtQuery]);

  const handleCompositionStart = useCallback(() => {
    isComposingRef.current = true;
  }, []);

  const handleCompositionEnd = useCallback((event: React.CompositionEvent<HTMLTextAreaElement>) => {
    isComposingRef.current = false;
    lastCompositionEndAtRef.current = Date.now();
    const ta = event.currentTarget;
    updateAtQuery(ta.value, ta.selectionStart);
  }, [updateAtQuery]);

  const handleSelect = useCallback((event: React.SyntheticEvent<HTMLTextAreaElement>) => {
    const ta = event.currentTarget;
    updateAtQuery(ta.value, ta.selectionStart);
  }, [updateAtQuery]);

  return {
    atMenuOpen: atMenu.open,
    atMatches,
    atActiveIndex,
    atMenuMaxHeight: atMenu.maxHeight,
    atMenuRef,
    atItemRefs,
    atIndexLoading: fileIndexLoading && (!fileIndex || fileIndex.cwd !== cwd),
    atTruncated: Boolean(fileIndex?.truncated),
    atServerSearchPending: needsServerSearch && !serverResultInUse,
    atServerResultActive: serverResultInUse,
    skillDormancy: options.skillDormancy,
    historyItems: inputHistory,
    atQuery,
    setAtActiveIndex,
    completeFile,
    slashMenuOpen: slashMenu.open,
    slashQuery,
    slashActiveIndex,
    slashMenuMaxHeight: slashMenu.maxHeight,
    slashMenuRef,
    slashItemRefs,
    slashMatches,
    groupedSlashCommands,
    setSlashActiveIndex,
    completeSlashCommand,
    historyMenuOpen,
    historyActiveIndex,
    historyMenuRef,
    historyItemRefs,
    setHistoryActiveIndex,
    applyHistoryInput,
    handleKeyDown,
    handleChange,
    handleInput,
    handlePaste,
    handleCompositionStart,
    handleCompositionEnd,
    handleSelect,
  };
}
