/**
 * What the composer may *ask the conversation to do*, and the palette rules it answers with.
 *
 * This is the composer's business seam: sending, queuing a steer or a follow-up, running a built-in, and the three
 * controls over an already-queued item. Everything here is stated in the conversation's own terms — text, attachments,
 * a submission id and its content token — so the surface never receives the session hook's state and never re-states
 * its decisions. The editor's own facts (caret, composition, which menu is open) are deliberately absent: they belong
 * to {@link ./useComposerEditor} and never travel through this port.
 *
 * The palette half is the other direction: an exact rule for what Enter means on a highlighted command, which source a
 * command came from, and which commands this deployment's runtime actually answers.
 */
import { isBareMcpCommand, isBuiltinMcpCommand } from "../../lib/mcp-command";
import type { AttachedImage } from "./attachments";

/** One picture, in the two shapes the composer speaks: with a preview for the screen, bytes alone for the wire. */
export type ComposerImages = readonly AttachedImage[];

/**
 * One command the conversation's own `/commands` read returned.
 *
 * Declared here, in the composer's vocabulary, rather than imported from the session hook: the composer needs the shape
 * of a command and nothing else about a conversation, and stating it at this seam is what keeps the hook's internals
 * out of the surface. Structural typing means the hook's answer is assignable without either side owning the other.
 */
export interface SlashCommandInfo {
  name: string;
  description?: string;
  source: "extension" | "prompt" | "skill";
  sourceInfo?: {
    path: string;
    source: string;
    scope: "user" | "project" | "temporary";
    origin: "package" | "top-level";
    baseDir?: string;
  };
}

/** What the runtime's own command handler answered: whether it owned the draft, and why it did not. */
export type BuiltinSlashCommandResult =
  | { handled: false }
  | { handled: true; message?: string; error?: string; action?: "openSessionStats" | "openSettings" };

/**
 * The conversation operations the composer calls, each with the value the user actually produced.
 *
 * A port rather than the hook: what a caller must be able to do is send a turn, queue one against a running turn, run a
 * command the runtime answers itself, and reach the queued items by identity. Nothing here exposes pending state, a
 * request id, or an ordering the composer would have to reproduce.
 */
export interface ComposerCommands {
  send(text: string, images?: ComposerImages): void;
  steer(text: string, images?: ComposerImages): void;
  followUp(text: string, images?: ComposerImages): void;
  /** A streaming prompt whose queue mode the caller names: `/command` drafts carry their own behavior. */
  promptWithStreamingBehavior(text: string, behavior: "steer" | "followUp", images?: ComposerImages): void;
  /** A command this deployment's runtime answers itself; `handled: false` means "send it as a prompt instead". */
  runBuiltin(message: string): Promise<BuiltinSlashCommandResult>;
  /** End the user's own stop. The answer says whether the queue moved, so the button never claims it did. */
  continueRun(): Promise<"resumed" | "stopping" | "allowed" | "failed">;
  recallQueue(): void;
  editItem(submissionId: string, contentToken: string, content: string): Promise<
    { ok: true } | { ok: false; reason: string; code?: string; current?: import("@hepi/protocol").QueuedItemProjection }
  >;
  cancelItem(submissionId: string): Promise<{ ok: boolean; reason?: string; code?: string }>;
}

type BuiltinSlashCommand = {
  name: string;
  description: string;
  source: "builtin";
  availableWhileStreaming?: boolean;
};

export type SlashCommandPaletteItem = SlashCommandInfo | BuiltinSlashCommand;
export type SlashCommandSource = SlashCommandPaletteItem["source"];

// Only the commands this deployment's durable runtime answers: every other built-in the copied composer offered
// (`/compact`, `/auto-compact`, `/name`, `/session`, `/copy`, `/clone`) was answered 501 by the Web host, so the
// palette does not offer them. Ticket 09 removed them rather than leaving an entry that can only fail; the session's
// own commands still arrive from the conversation's `/commands` read and are listed beside this one.
const BUILTIN_SLASH_COMMANDS: BuiltinSlashCommand[] = [
  { name: "reload", description: "chat.commandReload", source: "builtin" },
];

export function getBuiltinSlashCommand(message: string): BuiltinSlashCommand | undefined {
  const match = message.trim().match(/^\/([^\s]+)(?:\s|$)/);
  if (!match) return undefined;
  return BUILTIN_SLASH_COMMANDS.find((command) => command.name === match[1]);
}

export function canRunBuiltinSlashCommandWhileStreaming(message: string): boolean {
  return getBuiltinSlashCommand(message)?.availableWhileStreaming === true;
}

/**
 * Whether a message sent while a run streams goes to the built-in handler
 * first: a built-in that may run then, or a bare `/mcp`, which opens
 * Settings › MCP when pi's built-in MCP extension owns it and is otherwise
 * sent as before.
 */
export function offersBuiltinSlashCommandWhileStreaming(message: string): boolean {
  return canRunBuiltinSlashCommandWhileStreaming(message) || isBareMcpCommand(message);
}

export function isExactSlashCommand(message: string, command: SlashCommandPaletteItem): boolean {
  return command.source === "builtin" && message.trim() === `/${command.name}`;
}

/**
 * Whether Enter on the highlighted palette entry submits the message rather
 * than completing it to "/name ": a built-in typed in full (while a run
 * streams, only one that may run then), or a bare `/mcp` on pi's built-in
 * `/mcp`, which opens Settings › MCP at once, as it does before the command
 * list has loaded. Every other extension command still takes a second Enter.
 */
export function submitsSlashCommandOnEnter(message: string, command: SlashCommandPaletteItem, isStreaming: boolean): boolean {
  if (command.source === "builtin") {
    return isExactSlashCommand(message, command) && (!isStreaming || command.availableWhileStreaming === true);
  }
  return isBuiltinMcpCommand(command) && isBareMcpCommand(message);
}

/** Whether a built-in that just ran may take the draft with it: only the text it was handed, and only with no pictures. */
export function canClearBuiltinCommandInput(message: string, imageCount: number, submittedMessage: string): boolean {
  return imageCount === 0 && message.trim() === submittedMessage;
}

/** What the built-in palette offers while a run streams: the commands that say they may run then. */
export function builtinSlashCommands(isStreaming: boolean): BuiltinSlashCommand[] {
  return isStreaming ? BUILTIN_SLASH_COMMANDS.filter((command) => command.availableWhileStreaming) : BUILTIN_SLASH_COMMANDS;
}

const SLASH_SOURCES: SlashCommandSource[] = ["builtin", "extension", "prompt", "skill"];

export const SLASH_SOURCE_GROUP_LABEL_KEYS: Record<SlashCommandSource, string> = {
  builtin: "chat.builtIn",
  extension: "chat.extensions",
  prompt: "chat.prompts",
  skill: "chat.skills",
};

const SLASH_SOURCE_ORDER: Record<SlashCommandSource, number> = {
  builtin: 0,
  extension: 1,
  prompt: 2,
  skill: 3,
};

function slashMatchRank(command: SlashCommandPaletteItem, query: string, t: (key: string) => string): number {
  const name = command.name.toLowerCase();
  const description = getSlashDescription(command, t).toLowerCase();
  if (name === query) return 0;
  if (name.startsWith(query)) return 1;
  if (name.includes(query)) return 2;
  if (description.includes(query)) return 3;
  return 4;
}

export function getSlashDescription(command: SlashCommandPaletteItem, t: (key: string) => string): string {
  return command.source === "builtin" ? t(command.description) : command.description ?? "";
}

// Skill slash commands are named "skill:<skillName>"; look the skill up in the
// dormancy map fetched from /api/skills. Unknown skills are treated as active.
export function isDormantSkillCommand(command: SlashCommandPaletteItem, dormancy: Record<string, boolean>): boolean {
  if (command.source !== "skill" || !command.name.startsWith("skill:")) return false;
  return dormancy[command.name.slice("skill:".length)] === true;
}

/**
 * The palette as it is drawn: matching commands in rank order, then grouped by where they came from, with a dormant
 * skill last inside its own group. The returned `commands` list is the keyboard's own order, so an index into it is the
 * highlighted row in both.
 */
export function buildSlashCommandLayout(
  commands: SlashCommandPaletteItem[],
  dormancy: Record<string, boolean>,
) {
  let index = 0;
  const groups = SLASH_SOURCES
    .map((source) => {
      const sourceCommands = commands.filter((command) => command.source === source);
      const orderedCommands = source === "skill"
        ? [
            ...sourceCommands.filter((command) => !isDormantSkillCommand(command, dormancy)),
            ...sourceCommands.filter((command) => isDormantSkillCommand(command, dormancy)),
          ]
        : sourceCommands;
      return {
        source,
        items: orderedCommands.map((command) => ({ command, index: index++ })),
      };
    })
    .filter((group) => group.items.length > 0);

  return {
    commands: groups.flatMap((group) => group.items.map(({ command }) => command)),
    groups,
  };
}

/** The commands a `/query` draft offers, in the order the palette draws them. */
export function matchingSlashCommands(
  query: string,
  sessionCommands: readonly SlashCommandInfo[] | undefined,
  isStreaming: boolean,
  t: (key: string) => string,
  collator: Intl.Collator,
): SlashCommandPaletteItem[] {
  return [...builtinSlashCommands(isStreaming), ...(sessionCommands ?? [])]
    .filter((command) => {
      const name = command.name.toLowerCase();
      const description = getSlashDescription(command, t).toLowerCase();
      return name.includes(query) || description.includes(query);
    })
    .sort((a, b) => {
      const rankDelta = slashMatchRank(a, query, t) - slashMatchRank(b, query, t);
      if (rankDelta !== 0) return rankDelta;
      return SLASH_SOURCE_ORDER[a.source] - SLASH_SOURCE_ORDER[b.source]
        || collator.compare(a.name, b.name);
    });
}

/**
 * The `/query` a draft is asking for, or `null` when it is asking for something else.
 *
 * A compact composer is a quote box, not a command surface, and a draft with a space in its first word is already an
 * ordinary prompt carrying a slash.
 */
export function slashQueryOf(value: string, compact: boolean): string | null {
  return !compact && value.startsWith("/") && !/\s/.test(value.slice(1))
    ? value.slice(1).toLowerCase()
    : null;
}
