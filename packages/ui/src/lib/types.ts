// Types mirrored from pi-mono coding-agent session-manager

export interface SessionHeader {
  type: "session";
  version?: number;
  id: string;
  timestamp: string;
  cwd: string;
  parentSession?: string;
}

export interface SessionEntryBase {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
}

export interface TextContent {
  type: "text";
  text: string;
  /**
   * Historical content is a bounded preview; the full text is loaded on demand from `textUrl`.
   *
   * A heavy text block — a large paste, answer or tool output — is replaced by its leading characters in a history
   * frame, exactly as a thinking block is, and the read block restores exactly what the preview replaced. The live
   * partial never carries this: a streaming message stays exact.
   */
  deferred?: boolean;
  /** The read block that restores the text this preview replaced. Present exactly when `deferred` is true. */
  textUrl?: string;
}

export interface ImageContent {
  type: "image";
  source: {
    type: "base64" | "url";
    media_type?: string;
    data?: string;
    url?: string;
  };
}

export interface ThinkingContent {
  type: "thinking";
  thinking: string;
  /** Historical content is a short preview; full reasoning is loaded on demand. */
  deferred?: boolean;
}

export interface ToolCallContent {
  type: "toolCall";
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
  /** Client-only buffer for streamed tool input. Never persisted to session files. */
  rawInput?: string;
}

export type AssistantContentBlock = TextContent | ImageContent | ThinkingContent | ToolCallContent;

export interface UserMessage {
  role: "user";
  content: string | (TextContent | ImageContent)[];
  timestamp?: number;
}

export interface AgentUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}

export interface AssistantMessage {
  role: "assistant";
  content: AssistantContentBlock[];
  model: string;
  provider: string;
  stopReason?: string;
  errorMessage?: string;
  timestamp?: number;
  usage?: AgentUsage;
}

export interface ToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName?: string;
  content: (TextContent | ImageContent)[];
  isError?: boolean;
  details?: unknown;
  timestamp?: number;
  usage?: AgentUsage;
}

export interface CustomMessage {
  role: "custom";
  customType: string;
  content: string | (TextContent | ImageContent)[];
  display: boolean;
  details?: unknown;
  timestamp?: number;
}

export interface BashExecutionMessage {
  role: "bashExecution";
  command: string;
  output: string;
  exitCode?: number;
  cancelled?: boolean;
  truncated?: boolean;
  fullOutputPath?: string;
  excludeFromContext?: boolean;
  timestamp?: number;
}

export type AgentMessage = UserMessage | AssistantMessage | ToolResultMessage | CustomMessage | BashExecutionMessage;

/**
 * Prompt and tool loadout carried by the session transcript (Pi >= 0.86). The
 * leading one holds the base prompt; later ones patch `sections` by name and
 * list tool changes. Never a chat message: the UI hides it everywhere.
 */
export interface SystemMessage {
  role: "system";
  content: string | TextContent[];
  sections?: Record<string, string | null>;
  toolsAdded?: unknown[];
  toolsRemoved?: Array<{ name: string }>;
  timestamp?: number;
}

/** Any message a `message` entry can store, including transcript system messages. */
export type SessionMessage = AgentMessage | SystemMessage;

export interface ExtensionStatusItem {
  key: string;
  text: string;
}

export interface ExtensionWidgetItem {
  key: string;
  lines: string[];
  placement: "aboveEditor" | "belowEditor";
}

export interface SessionMessageEntry extends SessionEntryBase {
  type: "message";
  message: SessionMessage;
}

export interface ThinkingLevelChangeEntry extends SessionEntryBase {
  type: "thinking_level_change";
  thinkingLevel: string;
}

export interface ModelChangeEntry extends SessionEntryBase {
  type: "model_change";
  provider: string;
  modelId: string;
}

/** Model usage outside the conversation, such as prompt-cache warming (`kind: "cache_warm"`). */
export interface UsageEntry extends SessionEntryBase {
  type: "usage";
  kind: string;
  provider: string;
  model: string;
  usage: AgentUsage;
  note?: string;
}

export interface CompactionEntry extends SessionEntryBase {
  type: "compaction";
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  details?: unknown;
  fromHook?: boolean;
  usage?: AgentUsage;
}

export interface BranchSummaryEntry extends SessionEntryBase {
  type: "branch_summary";
  fromId: string;
  summary: string;
  details?: unknown;
  fromHook?: boolean;
  usage?: AgentUsage;
}

export interface CustomEntry extends SessionEntryBase {
  type: "custom";
  customType: string;
  data?: unknown;
}

export interface CustomMessageEntry extends SessionEntryBase {
  type: "custom_message";
  customType: string;
  content: string | (TextContent | ImageContent)[];
  details?: unknown;
  display: boolean;
}

export interface LabelEntry extends SessionEntryBase {
  type: "label";
  targetId: string;
  label: string | undefined;
}

export interface SessionInfoEntry extends SessionEntryBase {
  type: "session_info";
  name?: string;
}

/**
 * Append-only edit of an earlier entry's model context. Raw history, usage
 * and the UI are unaffected: `replacement: null` omits the target from future
 * provider requests, a value replaces only its content.
 */
export interface ContextEditEntry extends SessionEntryBase {
  type: "context_edit";
  targetId: string;
  replacement: { content: unknown } | null;
}

export type SessionEntry =
  | SessionMessageEntry
  | ThinkingLevelChangeEntry
  | ModelChangeEntry
  | UsageEntry
  | CompactionEntry
  | BranchSummaryEntry
  | CustomEntry
  | CustomMessageEntry
  | ContextEditEntry
  | LabelEntry
  | SessionInfoEntry;

export type FileEntry = SessionHeader | SessionEntry;

export type SubagentSessionStatus =
  | "starting"
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "aborted"
  | "interrupted";

/**
 * One conversation's own execution status, as the backend projects it from facts about **that** conversation: its own
 * run, its own committed control, its own live tasks, and whether its delegated result is waiting in its creator's
 * queue. A surface shows this and never infers a child's state from a parent being busy (spec D15).
 */
export type ConversationRunState = "running" | "held" | "stopping" | "waiting-report" | "blocked" | "interrupted" | "idle";

/** One conversation's run status, with the runtime's own reason when the state has one. */
export type ConversationRunStatus = {
  readonly state: ConversationRunState;
  readonly reason?: string;
};

export interface SessionInfo {
  path: string;
  id: string;
  cwd: string;
  name?: string;
  created: string;
  modified: string;
  messageCount: number;
  firstMessage: string;
  /**
   * When this session's newest run ended, as the catalogue states it from the run's own durable receipt; absent while
   * it has finished none. It is what lets the sidebar mark a run that started and finished between two polls, which a
   * running flag cannot express. It says nothing about how the run ended — a marker is not a completion notice.
   */
  lastRunEndedAt?: number;
  /** True while the sidebar has only header/stat metadata for this session. */
  detailsPending?: boolean;
  parentSessionId?: string; // source session for a fork, or parent session for a subagent
  /**
   * The conversation this one is displayed under, from the backend's hepi-owned relations, and whether that parent is
   * hidden. A child keeps its place while its parent is tombstoned — it is never promoted to a conversation of its own
   * — so a surface reads this instead of inferring placement from the fork source or from a live parent (spec D03).
   */
  displayParentSessionId?: string;
  displayParentDeleted?: boolean;
  /** The conversation that asked for this one, which is separate from its fork source and from its display parent. */
  createdBy?: string;
  /**
   * This conversation's own execution status, from the backend's projection of its own facts. Absent for a row the
   * catalogue did not state one for — a transient client-side session, say — which is why the panel shows a named
   * "unknown" rather than a default that would claim a state nobody read (spec D15).
   */
  runStatus?: ConversationRunStatus;
  /**
   * The extensions this conversation currently selects, as the catalogue states them from the runtime's own resolution.
   * The delegate entry follows this list, so turning the delegation capability off for a conversation removes the entry
   * without removing the child's history, relations or generic control (spec D15, A01).
   */
  extensions?: readonly string[];
  /**
   * The execution host this conversation's folder really runs on, as the catalogue resolves it. It is a fact about the
   * conversation, not about the Web origin serving the page: a delegation runs there, and a surface that showed this
   * origin's own name instead would name the wrong computer. Absent for a conversation bound to no workspace.
   */
  gatewayId?: string;
  /** How this session relates to another session. Forks remain top-level in the
   *  UI; only subagent relations form a visible parent/child tree. */
  relation?:
    | { kind: "fork"; originSessionId?: string }
    | {
        kind: "subagent";
        /** The conversation whose task created this one. The catalogue states this edge and nothing else about the
         *  subagent, so the fields that describe the run itself are absent until a surface reads them from the
         *  conversation: a default here would be a claim about a run nobody has looked at. */
        parentSessionId: string;
        profile?: string;
        description?: string;
        status?: SubagentSessionStatus;
      };
  /** Main repo root shared by all worktrees of this cwd (cwd itself for non-git dirs).
   *  Always set by the server; optional because the client builds transient
   *  SessionInfo objects before the first refresh. Fall back to cwd. */
  projectRoot?: string;
  /** The project's own folder path on its execution host — what a surface *shows*. It differs from projectRoot
   *  where that is a routing address (/workspace/<id>): the durable adapter reports the registered root here, so a
   *  folder in ~/Downloads is displayed as ~/Downloads rather than as the id the API addresses it by. Absent when
   *  the folder is unknown, in which case projectRoot/cwd stand in. */
  projectDisplayRoot?: string;
  /** Stable server-computed project identity for grouping and comparison.
   *  Unlike projectRoot, Windows keys are case- and separator-insensitive.
   *  Internal only: use projectRoot/cwd for display and filesystem operations. */
  projectKey?: string;
  /** True when this conversation's workspace is one a Project removal retained. The conversation keeps running and
   *  stays listed; the pickers that offer a target for a new conversation leave the folder out. */
  workspaceRetained?: boolean;
  /** Current git branch for any git repo (undefined for non-git or detached HEAD) */
  branch?: string;
  /** True when cwd is a linked git worktree (not the main checkout) */
  isWorktree?: boolean;
  /** True while the runtime session exists only in memory and its JSONL file
   *  has not been created yet. Disk-backed actions must wait until this clears. */
  transient?: boolean;
}
