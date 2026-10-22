/**
 * What a submit, a queued steer/follow-up and a built-in command actually do with the draft on screen.
 *
 * The rule lives here, in one place, because the four keys and buttons that reach it — Enter, the send button, Steer,
 * Follow-up, the palette's Enter — must agree about three things no rendering can decide: a draft a shell command
 * claims is refused before anything is dispatched and therefore never leaves the composer; a built-in the runtime
 * answers itself consumes the draft only when the text it ran on is still the text on screen; and a prompt sent while a
 * turn streams is queued rather than sent twice.
 *
 * It is stated over the live draft (read at the moment of dispatch, never captured) so a keystroke that arrives while a
 * built-in is in flight is preserved rather than overwritten by a stale copy.
 */
import { isShellCommandDraft } from "../../lib/composer-limits";
import { isBareMcpCommand } from "../../lib/mcp-command";
import type { AttachedImage } from "./attachments";
import {
  canClearBuiltinCommandInput,
  canRunBuiltinSlashCommandWhileStreaming,
  offersBuiltinSlashCommandWhileStreaming,
  type ComposerCommands,
} from "./commands";

export type { ComposerCommands } from "./commands";

/** The draft as the editor holds it: the text exactly as typed, and the pictures attached to it. */
export interface ComposerDraftValue {
  text: string;
  images: readonly AttachedImage[];
}

export interface ComposerDispatchDeps {
  /** Whether a turn is streaming: while it is, a prompt is queued instead of sent. */
  isStreaming: boolean;
  /** The live draft, read when a dispatch happens rather than when this object was built. */
  draft(): ComposerDraftValue;
  /** The conversation operations this surface can reach. A quote box's port has only a send and no queue. */
  commands: ComposerCommands;
  /** Take a dispatched draft off the screen — the one owner of that decision. */
  clearInput(): void;
  /** The user's own gesture unlocked audio output; a send is the gesture. */
  unlockAudio(): void;
  /** A built-in is running: the surface locks its input for the duration. */
  onBuiltinPendingChange(pending: boolean): void;
}

export interface ComposerDispatch {
  /** Send the draft, or queue it while a turn streams. */
  submit(): Promise<void>;
  /** Queue the draft against the running turn in the mode named. */
  queue(mode: "steer" | "followup"): void;
  /** Hand a `/command` draft to the runtime's own handler; `true` means it owned the draft. */
  runBuiltinCommand(message: string): Promise<boolean>;
  /** End the user's own stop, through the conversation's own control. */
  continueRun(): Promise<"resumed" | "stopping" | "allowed" | "failed">;
}

export function createComposerDispatch(deps: ComposerDispatchDeps): ComposerDispatch {
  let builtinPending = false;

  const runBuiltinCommand = async (message: string): Promise<boolean> => {
    const { images } = deps.draft();
    if (images.length || !message.startsWith("/")) return false;
    // A second press while the first is in flight is the same command, already owned: it neither runs twice nor
    // reports the draft as free.
    if (builtinPending) return true;
    builtinPending = true;
    deps.onBuiltinPendingChange(true);
    try {
      const result = await deps.commands.runBuiltin(message);
      if (!result.handled) return false;
      // The draft is taken only when the text the command ran on is still the text on screen: a command that
      // succeeded must not swallow what the user typed while it worked.
      if (!result.error && canClearBuiltinCommandInput(deps.draft().text, deps.draft().images.length, message)) {
        deps.clearInput();
      }
      return true;
    } finally {
      builtinPending = false;
      deps.onBuiltinPendingChange(false);
    }
  };

  const submit = async (): Promise<void> => {
    const { text, images } = deps.draft();
    const message = text.trim();
    if (!message && images.length === 0) return;
    deps.unlockAudio();
    // A built-in may run while a turn streams only if it says it can, or if it is a bare `/mcp` the built-in MCP
    // extension owns. Everything else waits for the idle send: while streaming, a plain prompt is queued elsewhere.
    const builtinMayRun = !deps.isStreaming || offersBuiltinSlashCommandWhileStreaming(message);
    if (builtinMayRun && await runBuiltinCommand(message)) return;
    if (deps.isStreaming) return;
    // A shell draft is refused by the host before it is sent, so this composer does not clear it: the text and its
    // attachments stay where they are, and the banner above the composer — the same rule the refusal is made of —
    // states why nothing was dispatched.
    if (!isShellCommandDraft(text, images.length)) deps.clearInput();
    deps.commands.send(message, images.length ? images : undefined);
  };

  const queue = (mode: "steer" | "followup"): void => {
    const { text, images } = deps.draft();
    const message = text.trim();
    if (!message && images.length === 0) return;
    deps.unlockAudio();
    const commands = deps.commands;
    const dispatchQueued = () => {
      // A queued shell draft is refused by the same rule as an idle one, so the composer keeps it here too rather
      // than clearing text the host never dispatched.
      if (!isShellCommandDraft(text, images.length)) deps.clearInput();
      const attached = images.length ? images : undefined;
      if (message.startsWith("/")) {
        commands.promptWithStreamingBehavior(message, mode === "steer" ? "steer" : "followUp", attached);
        return;
      }
      if (mode === "steer") commands.steer(message, attached);
      else commands.followUp(message, attached);
    };
    if (images.length === 0 && canRunBuiltinSlashCommandWhileStreaming(message)) {
      void runBuiltinCommand(message);
      return;
    }
    if (images.length === 0 && isBareMcpCommand(message)) {
      // Settings › MCP opens when pi's built-in MCP extension owns /mcp; another extension's /mcp is queued as
      // before. The composer is disabled meanwhile.
      void runBuiltinCommand(message).then((handled) => {
        if (!handled) dispatchQueued();
      }, dispatchQueued);
      return;
    }
    dispatchQueued();
  };

  const continueRun = (): Promise<"resumed" | "stopping" | "allowed" | "failed"> => deps.commands.continueRun();

  return { submit, queue, runBuiltinCommand, continueRun };
}
