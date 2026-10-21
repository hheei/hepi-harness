/**
 * Which of the composer's consumers owns one keystroke.
 *
 * Enter has five possible owners — a menu, a send, a queue, a built-in command, a native newline — and the order they are
 * asked in is behaviour a user learns. Stating that order as a pure decision, rather than inside a key handler that only
 * a mounted browser can exercise, is what makes it checkable: the same inputs produce the same answer here and in the
 * real textarea.
 *
 * The IME cases come first and are not guards bolted onto a send: while a composition is open no key is a command, and
 * for a short grace period after one ends the Enter that confirms it is still the IME's, not the sender's.
 */
import { submitsSlashCommandOnEnter, type SlashCommandPaletteItem } from "./commands";

export const COMPOSITION_END_ENTER_GRACE_MS = 100;

export interface ComposerKeyEvent {
  key: string;
  shiftKey: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  /** The native event's own composition state. */
  isComposing: boolean;
  /** `keyCode` 229 is what some IMEs report on the keystroke that ends a composition. */
  keyCode: number;
}

export interface ComposerKeyState {
  isMobile: boolean;
  enterSendMode: "enter" | "ctrlEnter";
  /** Whether the composer is holding an open composition. */
  composing: boolean;
  /** How long ago the last composition ended, in milliseconds. */
  msSinceCompositionEnd: number;
  isStreaming: boolean;
  /** Whether Steer is offered; when it is not, Enter queues a follow-up. */
  canSteer: boolean;
  hasAbortHandler: boolean;
  /** Whether the draft is empty (an arrow-up on an empty draft opens the history popup). */
  draftEmpty: boolean;
  inputHistoryLength: number;
  historyMenuOpen: boolean;
  slashMenuOpen: boolean;
  slashQuery: string | null;
  /** The highlighted palette entry, when there is one. */
  slashSelected?: SlashCommandPaletteItem;
  atMenuOpen: boolean;
  atQueryOpen: boolean;
  /** Whether the highlighted `@` match exists. */
  atHasMatch: boolean;
  value: string;
}

export type ComposerKeyAction =
  /** Let the textarea do what it does natively. */
  | { kind: "native" }
  /** Consume the key and change nothing. */
  | { kind: "swallow" }
  | { kind: "submit" }
  | { kind: "queue"; mode: "steer" | "followup" }
  | { kind: "abort" }
  | { kind: "slash-move"; direction: "up" | "down" | "left" | "right" }
  | { kind: "slash-close" }
  | { kind: "slash-complete"; command: SlashCommandPaletteItem }
  | { kind: "slash-submit"; command: SlashCommandPaletteItem }
  | { kind: "file-move"; delta: -1 | 1 }
  | { kind: "file-close" }
  | { kind: "file-complete" }
  | { kind: "history-open" }
  | { kind: "history-move"; delta: -1 | 1 }
  | { kind: "history-close" }
  | { kind: "history-apply" };

const NATIVE: ComposerKeyAction = { kind: "native" };

export function decideComposerKey(state: ComposerKeyState, event: ComposerKeyEvent): ComposerKeyAction {
  const enterKey = event.key === "Enter" && !event.shiftKey;
  const sendShortcut = state.isMobile || state.enterSendMode === "ctrlEnter"
    ? enterKey && (event.ctrlKey || event.metaKey)
    : enterKey;
  // Popup menus and the IME guard take plain Enter in either send mode on a desktop keyboard. Mobile keyboards insert a
  // line break on Enter, so they keep using the send shortcut there.
  const acceptShortcut = state.isMobile ? sendShortcut : enterKey;
  const composing = state.composing || event.isComposing || event.keyCode === 229;

  if (acceptShortcut && (composing || state.msSinceCompositionEnd < COMPOSITION_END_ENTER_GRACE_MS)) {
    // The grace swallow only matters once the composition itself has ended: the confirming Enter would otherwise send.
    return state.msSinceCompositionEnd < COMPOSITION_END_ENTER_GRACE_MS ? { kind: "swallow" } : NATIVE;
  }

  if (state.historyMenuOpen && !composing) {
    if (event.key === "ArrowDown") return { kind: "history-move", delta: 1 };
    if (event.key === "ArrowUp") return { kind: "history-move", delta: -1 };
    if (event.key === "Escape") return { kind: "history-close" };
    if (event.key === "Tab" || acceptShortcut) return { kind: "history-apply" };
  }

  if (state.slashMenuOpen && state.slashQuery !== null) {
    if (event.key === "ArrowDown") return { kind: "slash-move", direction: "down" };
    if (event.key === "ArrowUp") return { kind: "slash-move", direction: "up" };
    if (event.key === "ArrowRight") return { kind: "slash-move", direction: "right" };
    if (event.key === "ArrowLeft") return { kind: "slash-move", direction: "left" };
    if (event.key === "Escape") return { kind: "slash-close" };
    const command = state.slashSelected;
    if (event.key === "Tab" && command) return { kind: "slash-complete", command };
    if (acceptShortcut && command) {
      return sendShortcut && submitsSlashCommandOnEnter(state.value, command, state.isStreaming)
        ? { kind: "slash-submit", command }
        : { kind: "slash-complete", command };
    }
  }

  // The `@` menu is skipped while composing so IME candidate navigation (arrows/Enter/Tab) is never intercepted.
  if (state.atMenuOpen && state.atQueryOpen && !composing) {
    if (event.key === "ArrowDown") return { kind: "file-move", delta: 1 };
    if (event.key === "ArrowUp") return { kind: "file-move", delta: -1 };
    if (event.key === "Escape") return { kind: "file-close" };
    if ((event.key === "Tab" || acceptShortcut) && state.atHasMatch) return { kind: "file-complete" };
  }

  if (
    event.key === "ArrowUp" && !composing && !state.isStreaming && state.inputHistoryLength > 0 && state.draftEmpty
  ) {
    return { kind: "history-open" };
  }

  // Esc stops the agent when no slash/@/history menu or IME composition is active.
  if (event.key === "Escape" && !composing && state.isStreaming && state.hasAbortHandler) {
    return { kind: "abort" };
  }

  if (sendShortcut) {
    if (!state.isStreaming) return { kind: "submit" };
    return { kind: "queue", mode: event.altKey || !state.canSteer ? "followup" : "steer" };
  }

  return NATIVE;
}
