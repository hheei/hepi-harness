"use client";

import { useState, useCallback, useRef, useEffect, useMemo, useReducer } from "react";
import type {
  AgentMessage,
  ExtensionStatusItem,
  ExtensionWidgetItem,
  SessionInfo,
  ToolResultMessage,
} from "../lib/types";
import {
  projectAgentState,
  projectContext,
  projectLive,
  projectMessages,
  projectSession,
  type NativeEntryPage,
  type NativeFrame,
  type SessionData,
} from "../lib/durable-projection";
import { createRequestId, isRefusal, operationFailure, type ConversationApi } from "../lib/conversation-api";
import { ConversationSession, type StreamJoin } from "../lib/conversation-session";
import { workspaceIdOfRoutingPath } from "@hepi/protocol/files";
import {
  deleteSessionViewSnapshot,
  getSessionViewSnapshot,
  setSessionViewSnapshot,
  type SessionViewSnapshot,
} from "../lib/session-view-cache";
import { emptyStreamState, reduceSseFrame, type SessionState } from "@hepi/session";
import { classifyReadFailure, type ReadFailure } from "../lib/read-recovery";
import type { LandedWindow } from "../lib/history-navigation";
import {
  acceptSession,
  claimEarlierHistory,
  clearPrefix,
  emptyReadout,
  landHistory,
  prefixOf,
  prependOlderPage,
  transcriptOf,
  windowOf,
  type AcceptedReadout,
} from "../lib/conversation-readout";
import type { ToolEntry } from "../lib/tool-presets";
import type { SessionStatsInfo } from "../lib/pi-types";
import { mergeSessionStats, type SessionFileStats } from "../lib/session-stats";
import {
  advance,
  createProjection,
  pendingMessage,
  type Acquisition,
  type AnswerInterest,
  type Effect,
  type Input,
  type Notice,
  type PendingTurn,
  type ProjectionId,
  type Step,
  type State as ProjectionState,
  type View as ProjectionView,
} from "../lib/lifecycle-projection";
import {
  httpStatement,
  nextAcquisition,
  receiveAccepted,
  sseStatement,
  submissionStatement,
  unavailableStatement,
  type AcceptedStatement,
  type LifecycleFrame,
  type LifecycleRecordFrame,
  type StatementReceipt,
  type WireSubmission,
} from "../lib/lifecycle-acquisition";
import { readProjection, rekeyProjection, saveProjection } from "../lib/lifecycle-store";
import { useWorkbenchConnection, useWorkbenchScope } from "../lib/workbench-scope";
import { modelsScopeOf, pageModelsCache, subscribeModelCatalog } from "../lib/models-cache";
import { readCatalogAnswer, type CatalogAnswer } from "../lib/catalog-answer";
import type { ScopedCache } from "@hepi/session/settings";
import { hasUnfinishedWork } from "../lib/lifecycle-projection";
import type { CompletionNotice } from "../lib/completion-delivery";
import type { NoticeFact } from "../lib/notice-shelf";
import type { AgentEventSubscription } from "@hepi/session/browser";
import type { QueuedItemProjection, ServerSnapshot } from "@hepi/protocol";
import type { AgentEventLike } from "../lib/agent-event-wire";
import { bareMcpOpensSettings } from "../lib/mcp-command";
import { isShellCommandDraft } from "../lib/composer-limits";
import type { SettingsSection } from "../lib/settings-navigation";
import {
  INITIAL_STREAMING_STATE,
  streamReducer,
} from "../lib/streaming-message";

/**
 * One conversation's complete payload as the browser holds it: the copied app's own shape, produced by the browser's
 * one projection (`lib/durable-projection.ts`) from the **native** snapshot every read now answers with. The type
 * lives with the projection because that module is its owner; this hook consumes it.
 */
export type { SessionData };

/** One conversation's native snapshot, as the backend states it and as every read now forwards it. */
type NativeSnapshot = ServerSnapshot<AgentMessage>;

/**
 * One native snapshot's composer-state fields, projected by the browser's one projection. This is the shape the
 * conversation read, the agent-state read and the `get_state` command all answer with now — they answer the native
 * snapshot, and the fields the composer reads out of it are read from it here rather than synthesized by the Web host.
 */
function agentStateOf(snapshot: NativeSnapshot): AgentStateResponse {
  return projectAgentState(snapshot).state;
}

/**
 * One remembered view as the beside-window payload it was: the window, the cursor behind it, the leaf and the display
 * facts. It is the same payload a read publishes, so a mount that adopts it is holding exactly what the previous mount
 * was rendering rather than a second shape of the cache's own.
 */
function sessionDataOf(cached: SessionViewSnapshot): SessionData {
  return {
    sessionId: cached.sessionId,
    leafId: cached.leafId,
    historyHead: cached.historyHead,
    context: {
      messages: cached.messages,
      entryIds: cached.entryIds,
      oldestEntryId: cached.oldestEntryId,
      hasMore: cached.hasMore,
      thinkingLevel: cached.thinkingLevel,
      model: cached.model,
    },
    stats: cached.stats as SessionData["stats"],
  };
}

interface AgentEvent {
  type: string;
  [key: string]: unknown;
}

type AgentStateResponse = {
  model?: { provider: string; id: string };
  contextUsage?: { percent: number | null; contextWindow: number; tokens: number | null } | null;
  systemPrompt?: string;
  thinkingLevel?: string;
  isStreaming?: boolean;
  isPromptRunning?: boolean;
  isBashRunning?: boolean;
  extensionStatuses?: ExtensionStatusItem[];
  extensionWidgets?: ExtensionWidgetItem[];
  queuedMessages?: { steering?: string[]; followUp?: string[] } | null;
  queuedItems?: readonly QueuedItemProjection[];
  /** The committed input control, read from the same native snapshot the queue comes from (spec D08). */
  control?: ControlState;
};

/**
 * What one conversation read established, stated as the fact rather than as an absence.
 *
 * A read has five ways to end and only one of them is "the conversation said something". The other four are not
 * interchangeable: a read the surface itself superseded says nothing and must claim nothing, a window the fold refused
 * is an older statement of the same conversation, a `not_found` is the Backend saying the row is gone, and a failure
 * carries the kind a surface offers recovery for. Reporting them all as `null` made every caller guess which one it got,
 * and a caller that guessed wrong stated a success over a failure.
 */
type ConversationReadOutcome =
  /** The read answered and the surface is showing it. `agentState` is the composer state when the caller asked for it. */
  | { readonly status: "accepted"; readonly agentState: { running: boolean; state: AgentStateResponse } | null }
  /** This answer belongs to a connection or a conversation the surface no longer shows: it says nothing, and claims none. */
  | { readonly status: "superseded" }
  /** The fold called this window older than the one on screen: the same conversation, a statement it already superseded. */
  | { readonly status: "refused" }
  /** The Backend answered `not_found`: the conversation row is gone, so no retry can bring it back. */
  | { readonly status: "missing" }
  /** The read did not answer, as the kind the surface offers recovery for. */
  | { readonly status: "failed"; readonly failure: ReadFailure }
  /** The caller aborted the read. Not a state to report. */
  | { readonly status: "cancelled" };

/**
 * What one resource reload established, as the operation that performed it states it.
 *
 * `reloaded` is the only outcome that claims the route's own answer, because only then did the read accept the
 * conversation the route changed. `failed` carries the sentence the notice already stated, so a command line can repeat
 * it without deciding a second time what happened. `superseded` is the operation having nothing to say: another
 * connection, or a newer window, is what the surface shows.
 */
export type ReloadOutcome =
  | { readonly status: "reloaded"; readonly message: string }
  | { readonly status: "failed"; readonly message: string }
  | { readonly status: "superseded" };

export interface QueuedMessages {
  steering: string[];
  followUp: string[];
}

function normalizeQueuedMessages(q?: { steering?: string[]; followUp?: string[] } | null): QueuedMessages {
  return { steering: q?.steering ?? [], followUp: q?.followUp ?? [] };
}

/**
 * The pending queue as items, with the source and the edit token each row needs. It is read from the same frame as the
 * text lists beside it, so the two cannot disagree, and it is what the composer's per-item controls address (spec D09).
 */
export type QueuedItems = readonly QueuedItemProjection[];

/** One conversation's committed input control, as the wire states it. */
export type ControlState = ServerSnapshot["control"];

export type NoticeType = NoticeFact["type"];

/**
 * One notice the conversation stated. It is a **fact** — an id, a sentence, a kind — and carries no presentation: nothing
 * here says how long it is drawn, which one is leaving, or how many are on screen. Those belong to the shelf that draws
 * them (`components/NoticeShelf.tsx`), which is what keeps a toast's clock out of a session that can be handed over to
 * the background (spec R3, acceptance C7).
 */
export type NoticeItem = NoticeFact;

export type AgentPhase =
  /** This surface's own turn is staged and the run does not exist yet: nothing has been asked of a model. */
  | { kind: "preparing" }
  | { kind: "waiting_model" }
  | { kind: "running_command" }
  | { kind: "running_tools"; tools: { id: string; name: string; progress?: string }[] }
  | null;

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

export type BuiltinSlashCommandResult =
  | { handled: false }
  | { handled: true; message?: string; error?: string; action?: "openSessionStats" | "openSettings" };

export interface UseAgentSessionOptions {
  session: SessionInfo | null;
  newSessionCwd: string | null;
  newSessionDraftKey: string | null;
  /**
   * Join the conversation's event stream through the shell, which owns one stream per conversation for the whole page.
   * The open surface and a background interest in the same conversation are two readers of that one stream, so joining
   * here is what makes a handover on selection open and close nothing.
   */
  subscribeAgentEvents?: (conversationId: string, listener: (event: AgentEventLike) => void) => AgentEventSubscription<AgentMessage>;
  /**
   * Hand this conversation's projection over, so leaving it keeps its stream instead of dropping the run. The
   * projection travels rather than a summary of it: what the surface is still waiting for — a queued follow-up, a turn
   * whose answer has not arrived — is exactly the interest the shell must keep the stream for, and a watch told only
   * that work is outstanding would read the first terminal fact it saw as the end of it.
   */
  onProjectionChange?: (conversationId: string, step: Step) => void;
  /**
   * Register this conversation's completion with the page's one registry, which sounds each answer once: the answer
   * says whether this surface is the owner that reports it, or `false` when another owner already did.
   */
  onLiveSettlement?: (notice: CompletionNotice) => boolean;
  onAgentEnd?: () => void;
  onSessionCreated?: (session: SessionInfo, sourceDraftKey: string) => void;
  onSessionForked?: (newSessionId: string) => void;
  chatInputRef?: React.RefObject<ChatInputHandle | null>;
  onSystemPromptChange?: (prompt: string | null) => void;
  onSystemToolsChange?: (tools: ToolEntry[] | null) => void;
  /** Registers an action that lazily starts the session and loads its prompt and tools. */
  onSystemInfoLoaderChange?: (loader: (() => Promise<void>) | null) => void;
  /**
   * Registers this conversation's explicit reload — the Backend's own resource reload followed by the read that states
   * it — so a surface outside the chat (Settings) asks for one operation instead of remounting the conversation.
   */
  /**
   * Registers this conversation's explicit reload — the Backend's own resource reload followed by the read that states
   * it — so a surface outside the chat (Settings, the definitions panels) asks for one operation instead of remounting
   * the conversation, and reads the outcome that operation established.
   *
   * The outcome is the operation's whole answer rather than a bare completion, because a caller that reports success has
   * to be able to tell a reload this conversation picked up from one that failed or that another connection superseded.
   * A `() => Promise<void>` would make every failure look like a success at the call site.
   */
  onConversationReloadChange?: (reload: (() => Promise<ReloadOutcome>) | null) => void;
  /** Opens Settings on a section; a bare `/mcp` the built-in MCP extension owns opens Settings › MCP. */
  onOpenSettings?: (section: SettingsSection) => void;
  /** A fresh composer's model and reasoning picks to start with: the composer it replaces had them. */
  initialNewSessionChoices?: NewSessionChoices | null;
  /** A fresh composer reports its own model and reasoning picks, on mount and as they change. */
  onNewSessionChoicesChange?: (choices: NewSessionChoices) => void;
}

export type ThinkingLevelOption = "auto" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
type ConcreteThinkingLevel = Exclude<ThinkingLevelOption, "auto">;

/**
 * What a fresh composer was told to use instead of the automatic choice. The
 * bar above it moves the composer to another folder by remounting it; these
 * go along with the draft. (The tool preset needs no carrying: a pick is the
 * browser's preference, which every fresh composer starts from.)
 */
export interface NewSessionChoices {
  model: { provider: string; modelId: string } | null;
  thinkingLevel: ConcreteThinkingLevel | null;
}

function asConcreteThinkingLevel(value?: string | null): ConcreteThinkingLevel | null {
  if (!value || value === "auto") return null;
  return value as ConcreteThinkingLevel;
}

const EVENT_STREAM_READY_TIMEOUT_MS = 60_000;
const EVENT_STREAM_RECONNECT_DELAY_MS = 1_000;
// Retry temporary model-list failures without requiring a page refresh.
const MODELS_RETRY_DELAYS_MS = [2_000, 5_000, 10_000];
function createNoticeId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface ChatInputHandle {
  insertText: (text: string) => void;
  insertIfEmpty: (content: string) => void;
  prependText: (text: string) => void;
  addImages: (files: File[]) => void;
  rekeyDraft: (previousKey: string, nextKey: string) => void;
  restoreSubmission: (text: string, images?: Array<{ data: string; mimeType: string }>, targetDraftKey?: string) => void;
}

export interface AttachedImage {
  data: string;
  mimeType: string;
  previewUrl: string;
}

type SelectedModel = { provider: string; modelId: string };
type ModelEntry = { id: string; name: string; provider: string };
/** The catalog as this page holds it, read from either answer a deployment can give: see `lib/catalog-answer.ts`. */
type ModelsResponse = CatalogAnswer;

/**
 * The page's one catalog cache.
 *
 * The catalog is the deployment's own answer set — every selector on the page wants the same read — so it is held once
 * per page rather than once per composer, and it is keyed by the connection's scope, so a page that switched connection
 * reads the new connection's answer instead of the previous one's. The instance lives in `lib/models-cache.ts` rather
 * than here, because the surfaces that supersede its answer (Settings › Models, storing or removing a provider
 * credential) are not this hook's, and the cache a panel must drop is the one the composer reads through.
 */
function modelsCache(): ScopedCache<ModelsResponse> {
  return pageModelsCache<ModelsResponse>();
}

type SlashCommandsResponse = {
  commands?: SlashCommandInfo[];
};

export function useAgentSession(opts: UseAgentSessionOptions) {
  const {
    session, newSessionCwd, newSessionDraftKey, onAgentEnd, onSessionCreated, onSessionForked,
    onSystemPromptChange, onSystemToolsChange, onSystemInfoLoaderChange,
    onOpenSettings,
  } = opts;

  // The connection this composer belongs to. Every store this hook reaches - drafts, remembered views, staged turns -
  // is keyed by it, so two connections that happen to share a session id never read each other composer state.
  const scope = useWorkbenchScope();
  // Every conversation read, page, submission lookup and lease this composer makes is this connection's own request:
  // its origin, its credential and its disposal. A surface that called a global `fetch` would reach whatever origin the
  // page happens to be served from — the bundle's own, in the App — under no credential at all.
  const connection = useWorkbenchConnection();
  const { client, identity } = connection;
  // The conversation API of this connection: the Backend's own `/api/conversations…` vocabulary, assembled with the
  // connection. A caller below reads the contract rather than the retired Next BFF's paths.
  const api = connection.api;
  // The shell's one source per conversation, as the chat was handed it. A session joins it as a reader, so the
  // conversation on screen and a background watch of the same conversation read one stream instead of two.
  const subscribeAgentEvents = opts.subscribeAgentEvents;
  /**
   * This surface's conversation I/O: the stream reader it holds, its reads, its admissions, its lookups and its explicit
   * reload, all bound to this connection and this conversation identity. It is assembled once per connection (and per
   * source) because that is what its lifetime is; the React state the surface renders stays in this hook, and the fold
   * that orders what the I/O answers stays pure.
   */
  const conversation = useMemo(
    () => new ConversationSession({ api, ...(subscribeAgentEvents === undefined ? {} : { subscribe: subscribeAgentEvents }) }),
    [api, subscribeAgentEvents],
  );
  // The connection a read was started under, readable from its answer. A connection switch replaces the client **and**
  // its conversation API, so the session object a read began with is the connection's own identity: an answer that
  // arrives after the switch is one from a client the surface no longer shows, and it is refused whatever its
  // conversation id says. The conversation id alone is not a fence — two connections can hold the same id, and the
  // reads that matter here are exactly the ones answering with the same id from a replaced connection.
  const conversationRef = useRef(conversation);
  conversationRef.current = conversation;
  const apiRef = useRef(api);
  apiRef.current = api;
  /**
   * Whether an answer that has just arrived still belongs to the connection this surface is showing.
   *
   * It is asked at **every** point a read publishes — a snapshot, a `null`, a failure — because the switch that makes
   * the answer stale can land while the read is in flight, and a fence applied only before the first publish would let
   * the rest of that same answer through afterwards. The caller names the connection-owned object its read went
   * through — the conversation session or the connection API — and the identity of that object is the connection: a
   * switch replaces both, so a read through the replaced one is refused whatever its conversation id says.
   */
  const fromCurrentConnection = useCallback((readThrough: ConversationSession | ConversationApi) =>
    conversationRef.current === readThrough || apiRef.current === readThrough, []);
  // This connection's composer drafts. The store is the connection's own, so a promotion, a rekey or a refused
  // submission's restore can only touch entries of the connection the composer is showing.
  const drafts = connection.drafts;
  const isNew = session === null && newSessionCwd !== null;
  const initialChoices = isNew ? opts.initialNewSessionChoices ?? null : null;

  // The view this page remembers of the conversation, adopted as the mount's **initial** state rather than written
  // after the first statements have been folded. A window the conversation has already stated — by the stream this
  // mount joined, or by a read that landed first — is the conversation's current statement, and the remembered one is
  // an older statement of the same history: publishing it afterwards would put an older head and older beside facts
  // back on screen over what was accepted, and stamp the next page read with the older head. Adopted at mount, every
  // statement the fold accepts supersedes it, and the pages it brings back are the ones the reader had loaded.
  const remembered = useMemo(() => session?.id ? getSessionViewSnapshot(scope, session.id) : null, [scope, session?.id]);
  /**
   * The conversation's accepted readout (lib/conversation-readout.ts): the accepted window payload, the older pages the
   * reader loaded in front of it, and that window's own pagination claim. It is published by **one** place — the
   * accepted-facts receiver below — which is what makes a moving window and the prefix it keeps a single synchronous
   * decision instead of a render that catches up with the previous one.
   */
  const [readout, setReadout] = useState<AcceptedReadout>(() => remembered === null || session === null
    ? emptyReadout()
    : {
        session: sessionDataOf(remembered),
        prefix: prefixOf(remembered.prefixEntryIds, remembered.prefixMessages, remembered.prefixHistoryHead),
        hasMore: remembered.hasMore,
      });
  const readoutRef = useRef<AcceptedReadout>(readout);
  readoutRef.current = readout;
  // The accepted payload: metadata the window states (stats, the history token, the leaf, the failure, the queue) plus
  // the window itself. It is the readout's own session value, not a second copy of the transcript.
  const data = readout.session;
  // The conversation's lifecycle is one pure projection (lib/lifecycle-projection.ts), created once per composer or
  // conversation and kept across the promotion remount by lib/lifecycle-store.ts. The transcript, the pending overlay,
  // the answer interest and the native run are all read from it, so the surface decides nothing about a turn locally.
  const [step, setStep] = useState<Step>(() => {
    const key = session?.id ?? newSessionDraftKey;
    return (key === null ? null : readProjection(scope, key))
      ?? createProjection({ composerKey: session?.id ?? newSessionDraftKey ?? "composer", ...(session?.id ? { conversationId: session.id } : {}) });
  });
  const stepRef = useRef<Step>(step);
  stepRef.current = step;
  const view = step.view;
  // The client's own acquisition generations have one owner: the projection, which remembers the number it accepted.
  // A read or a stream takes its number from there as it begins — never when its answer arrives — so a response that
  // lands after a newer acquisition is fenced out, and a projection restored from page memory (already past the
  // generations of the mount that stored it) is not handed reads and streams numbered below its own.
  // What the fold asked for, performed by this hook: the fold opens nothing itself.
  const runEffectRef = useRef<((effect: Effect) => void) | null>(null);
  const announceRef = useRef<((notice: Notice) => void) | null>(null);

  const [error, setError] = useState<string | null>(null);
  /**
   * The conversation's own read failure, classified for a surface to state and offer a Retry for. It is deliberately not
   * the raw error: what a reader is shown is a sentence this build owns, and the Backend's diagnostics stay in `error`
   * and in the log. It is cleared by the read that succeeds, so the recovery panel is never a latch.
   */
  const [readFailure, setReadFailure] = useState<ReadFailure | null>(null);
  const [activeLeafId, setActiveLeafId] = useState<string | null>(remembered?.leafId ?? null);
  // The head marker the conversation most recently reported, so a page read records the facts it was loaded under.
  const historyHeadRef = useRef<string | null>(remembered?.historyHead ?? null);
  // This stream's own continuity, and nothing else: the native state the frames of the attachment now open are folded
  // onto, so a delta can be assembled from what this reader has already received. It is deliberately **not** the
  // surface's accepted window — a frame this stream can continue may still be refused as the conversation's current
  // statement, and the two decisions are separate — and it is reset by every new attachment, because a new attachment
  // is a new lifecycle clock for the same history.
  const streamHeldRef = useRef<SessionState<AgentMessage>>(emptyStreamState(""));
  // Whether older history exists, as the accepted window or the newest page stated it. It is the readout's own claim.
  const hasEarlierMessages = readout.hasMore;
  const [activeToolResults, setActiveToolResults] = useState<Map<string, ToolResultMessage>>(new Map());

  const [streamState, dispatch] = useReducer(streamReducer, INITIAL_STREAMING_STATE);
  // Native activity is the run's presence, read from the projection rather than tracked beside it.
  const agentRunning = view.activity !== null;
  const [modelNames, setModelNames] = useState<Record<string, string>>({});
  const [modelList, setModelList] = useState<ModelEntry[]>([]);
  const [modelError, setModelError] = useState<string | null>(null);
  // The framework's own failure for the newest terminal run, shown above the composer. It is not a chat entry and not a
  // client-side status machine: the backend projects it from the committed task record, so a reconnect and a backend
  // restart show the same failure, and the next run that settles replaces it.
  const [runFailure, setRunFailure] = useState<{ reason: string; message: string } | null>(null);
  const [modelScopeWarnings, setModelScopeWarnings] = useState<string[]>([]);
  const [modelThinkingLevels, setModelThinkingLevels] = useState<Record<string, string[]>>({});
  const [modelThinkingLevelMaps, setModelThinkingLevelMaps] = useState<Record<string, Record<string, string | null>>>({});
  const [newSessionModel, setNewSessionModel] = useState<SelectedModel | null>(() => initialChoices?.model ?? null);
  const [newSessionDefaultModel, setNewSessionDefaultModel] = useState<SelectedModel | null>(null);
  const [newSessionThinkingLevel, setNewSessionThinkingLevel] = useState<ConcreteThinkingLevel | null>(() => initialChoices?.thinkingLevel ?? null);
  const [newSessionDefaultThinkingLevel, setNewSessionDefaultThinkingLevel] = useState<ConcreteThinkingLevel | null>(null);
  const [currentThinkingOverride, setCurrentThinkingOverride] = useState<ConcreteThinkingLevel | null>(null);
  const [contextUsage, setContextUsage] = useState<{ percent: number | null; contextWindow: number; tokens: number | null } | null>(null);
  const contextUsageRequestIdRef = useRef(0);
  // Highest request id whose reply was applied. A reply applies only when it
  // is newer, so a failed newer read never discards an older good one.
  const contextUsageAppliedIdRef = useRef(0);
  const [systemPrompt, setSystemPrompt] = useState<string | null>(null);
  const [forkingEntryId, setForkingEntryId] = useState<string | null>(null);
  const [currentModelOverride, setCurrentModelOverride] = useState<{ provider: string; modelId: string } | null>(null);
  const [pendingModel, setPendingModel] = useState<{ provider: string; modelId: string } | null>(null);
  const [modelSwitching, setModelSwitching] = useState(false);
  const [agentPhase, setAgentPhase] = useState<AgentPhase>(null);
  // The status line's phase, stated by the projection and refined by the event stream: a turn this surface sent shows
  // `preparing` until the projection reports the run, and a live run is `waiting_model` until the stream names what it
  // is doing. The projection owns whether there is work in flight; this only names it, so no status can claim a run
  // that does not exist.
  const statusPhase: AgentPhase = view.phase === "preparation"
    ? { kind: "preparing" }
    : view.phase === "running"
      ? agentPhase ?? { kind: "waiting_model" }
      : null;
  /**
   * How many turns this surface itself has staged.
   *
   * It is the one fact the viewport needs from the conversation and cannot derive: a send of the reader's own owes their
   * prompt its place at the top of the viewport while the answer streams in. Everything else about the viewport —
   * following the tail, the scroll it performs, the spacer that makes the room — is the transcript presentation's own
   * (`hooks/useTranscriptPresentation.ts`), so no scroll ref or scroll decision lives in this hook (spec R4).
   */
  const [ownSends, setOwnSends] = useState(0);
  const [slashCommands, setSlashCommands] = useState<SlashCommandInfo[]>([]);
  const [slashCommandsLoading, setSlashCommandsLoading] = useState(false);
  /**
   * The notices the conversation stated, oldest first.
   *
   * It holds **facts** and nothing else: how long one is drawn, which is leaving and how many are on screen are the
   * shelf's own presentation, so this list neither schedules a timer nor marks an entry as exiting. A surface that stops
   * drawing (a connection handed over, a view unmounted) therefore leaves no clock running here (spec R3/R4).
   */
  const [notices, setNotices] = useState<readonly NoticeFact[]>([]);
  const [extensionStatuses, setExtensionStatuses] = useState<ExtensionStatusItem[]>([]);
  const [extensionWidgets, setExtensionWidgets] = useState<ExtensionWidgetItem[]>([]);
  const [queuedMessages, setQueuedMessages] = useState<QueuedMessages>({ steering: [], followUp: [] });
  // The same queue as items. It is published by the same accepted statements that publish the text lists, so a frame
  // the fold refused cannot leave item rows on screen beside a queue it did not state (spec D09).
  const [queuedItems, setQueuedItems] = useState<QueuedItems>([]);
  // The conversation's committed input control, read off the same frames the queue is: whether admission is held, and
  // the revision a control request names. It is what the composer's Continue and its "stopping" state read (spec D08).
  const [control, setControl] = useState<ControlState>({ state: "allowed", revision: 0 });

  const sessionIdRef = useRef<string | null>(session?.id ?? null);
  const sessionPropIdRef = useRef<string | null>(session?.id ?? null);
  // The visible refusal a `state_oversize` frame produced, held so a later state frame can clear exactly that
  // message and nothing else the surface may be showing.
  const oversizeRefusalRef = useRef<string | null>(null);
  // The stream's listener is installed once per join, and what it does is read from this ref on every frame. A render
  // therefore never resubscribes, and the handler below — which closes over this render's state writers — is the one a
  // frame reaches. It is deliberately **not** part of what this hook returns: a view has no transport callback to
  // overwrite, and a test drives the stream through the subscription seam instead of poking a handler.
  const handleAgentEventRef = useRef<((event: AgentEvent) => void) | null>(null);
  /** How one native state this stream holds becomes the surface's payload. Bound below, read by the join above. */
  const publishStreamStateRef = useRef<((conversationId: string, held: SessionState<AgentMessage>) => void) | null>(null);
  const ensuringNewSessionRef = useRef<Promise<string | null> | null>(null);
  // The command list as last loaded, and the get_commands request under way, if
  // any. A bare /mcp reads them to tell whose /mcp it is (handleBuiltinSlashCommand).
  // The generation moves on with every request and every clear, and only a request
  // still current writes its answer: one that a rebuilt session outdated (or a newer
  // request) would otherwise put back the list of a session that is no longer there.
  const slashCommandsRef = useRef<SlashCommandInfo[]>([]);
  const slashCommandsLoadRef = useRef<Promise<SlashCommandInfo[] | null> | null>(null);
  const slashCommandsGenerationRef = useRef(0);
  const newSessionPromotedRef = useRef(false);
  const newSessionModelOverrideRef = useRef<SelectedModel | null>(initialChoices?.model ?? null);
  const thinkingLevelOverrideRef = useRef<ConcreteThinkingLevel | null>(initialChoices?.thinkingLevel ?? null);
  const thinkingLevelPinsRef = useRef<Record<string, string>>({});
  const defaultThinkingLevelRef = useRef<ConcreteThinkingLevel | null>(null);
  // The conversation the projection is keyed by: its session once it has one, its provisional composer key until
  // then — the same keying its draft uses, so a promotion remount lands on the value it staged under.
  const pendingConversationRef = useRef<string | null>(session?.id ?? null);
  const modelSwitchPendingRef = useRef(false);
  const draftKeyAliasesRef = useRef(new Map<string, string>());
  const sessionHookMountedRef = useRef(true);
  // Latest settled view state, readable from the unmount cleanup without
  // re-subscribing it. Assigned every render like sessionPropIdRef below.
  const activeLeafIdRef = useRef<string | null>(null);

  sessionPropIdRef.current = session?.id ?? null;
  activeLeafIdRef.current = activeLeafId;

  const existingSessionId = session?.id;

  const onNewSessionChoicesChange = opts.onNewSessionChoicesChange;
  useEffect(() => {
    if (isNew) onNewSessionChoicesChange?.({ model: newSessionModel, thinkingLevel: newSessionThinkingLevel });
  }, [isNew, newSessionModel, newSessionThinkingLevel, onNewSessionChoicesChange]);

  // The conversation's own selected model and reasoning level, read from the **accepted** lifecycle facts rather than
  // from a second copy of them: the projection is the one place that decides whether a frame is this conversation's
  // current statement, so a read or a stream frame the fold refused cannot move the composer through a mirror of its
  // own. What is genuinely not a lifecycle fact stays beside it: the live agent-state read, a pending switch, and a
  // fresh composer's own picks.
  const currentModel = currentModelOverride ?? data?.context.model ?? pendingModel ?? null;
  const displayModel = isNew
    ? (newSessionModel ?? newSessionDefaultModel)
    : currentModel ?? (data?.context.messages.length === 0 ? newSessionDefaultModel : null);
  const contextThinkingLevel = asConcreteThinkingLevel(
    data?.context.thinkingLevel && data.context.thinkingLevel !== "off"
      ? data.context.thinkingLevel
      : null,
  );
  const currentThinkingLevel = currentThinkingOverride ?? contextThinkingLevel;
  const displayThinkingLevel = isNew
    ? (newSessionThinkingLevel ?? newSessionDefaultThinkingLevel)
    : currentThinkingLevel ?? (data?.context.messages.length === 0 ? newSessionDefaultThinkingLevel : null);
  const composerDraftKey = session?.id ?? newSessionDraftKey ?? undefined;

  /**
   * The accepted statement one read describes, captured as the read begins: the fold's own attachment identity with its
   * revision. Both are needed, and neither alone is enough — a revision is counted **per attachment instance**, so a
   * reconnect or a backend restart mints a new identity whose counter starts again, and comparing revisions across two
   * identities would read a small new revision as older than a large old one and let the old answer through.
   */
  const captureAcceptedStamp = useCallback((): { readonly identity: ProjectionId | null; readonly revision: number } => ({
    identity: stepRef.current.state.identity,
    revision: stepRef.current.state.revision,
  }), []);

  /**
   * One admission: the Backend's own submission route, under the request id this attempt was made with.
   *
   * An admission is one of three things, and the surface acts on which one it got. A value names the durable
   * submission. A refusal is the Backend saying no to this request, so the staged turn is settled as a refusal. A
   * response that never arrived may have committed, so it is rethrown and the caller's own unknown-outcome path keeps
   * the turn on screen and resolves it by request id — never by sending again.
   */
  const admit = useCallback(async (conversationId: string, requestId: string, text: string, images: readonly { type: "image"; data: string; mimeType: string }[] | undefined) => {
    return await conversation.send(conversationId, {
      requestId,
      text,
      ...(images === undefined || images.length === 0 ? {} : { images }),
    });
  }, [conversation]);

  /**
   * Apply one agent-state answer: the conversation's model and reasoning level, and its context usage.
   *
   * The agent-state query is an **independent read** with its own subject and its own ordering — it is not a projection
   * of the conversation's lifecycle, and the fold's decision about a window says nothing about whether the query should
   * run — so it is not gated on a snapshot's acceptance.
   *
   * What it *is* ordered against is what it describes, through the fence this hook already keeps for these answers. Two
   * existing owner values make it, and the read captures both as it begins:
   *
   * - the request id the read took from `contextUsageRequestIdRef` — the fence the context usage always used, so an
   *   older or already-applied `/state` answer refines nothing;
   * - the accepted statement the read observed — the fold's own attachment identity **with** its revision. An answer
   *   whose identity is not the accepted one describes another attachment, and one whose identity is the accepted one
   *   but whose revision is older describes a window that has already been replaced; neither refines anything.
   *
   * The identity is what makes the fence hold across a reconnect: a restart mints a new attachment whose revision
   * counter starts again, so a delayed answer from the previous attachment carries an identity the surface no longer
   * accepts and is refused even when its revision is numerically larger than the new attachment's.
   *
   * That fence is what keeps the accepted window the owner of the conversation's selected model and reasoning level.
   * Without it, a `/state` answer already in flight when a newer window landed would put the previous model and level
   * back on screen — the same rewinding the fold prevents for the window itself — and the composer would offer a model
   * the conversation no longer has.
   *
   * A field the state does not mention publishes nothing: absence is not a statement that the conversation has no
   * model, so the accepted window's own value stays.
   *
   * @returns whether this answer was the conversation's current one and its stated fields were published. A caller
   *   whose own action depends on the answer — resuming a run's phase, filling the prompt panel — reads this instead of
   *   comparing the stamp a second time, so the ordering rule lives here and nowhere else.
   */
  const applyAgentState = useCallback((state: AgentStateResponse | undefined, sid: string, requestId: number, stamp: { readonly identity: ProjectionId | null; readonly revision: number }): boolean => {
    if (!sessionHookMountedRef.current || sessionIdRef.current !== sid) return false;
    if (requestId <= contextUsageAppliedIdRef.current) return false;
    // The accepted statement has moved on since this read began: the read describes a conversation the surface no
    // longer shows, so it states nothing the current window has not already replaced. It is not a rejection and the
    // request id is still spent, so a later answer is ordered after it. A different identity is a different attachment
    // — a reconnect or a restart — and its own revision counter says nothing about this answer's age.
    if (stamp.identity !== stepRef.current.state.identity || stamp.revision < stepRef.current.state.revision) return false;
    contextUsageAppliedIdRef.current = requestId;
    if (state === undefined) return true;
    if (state.contextUsage !== undefined) setContextUsage(state.contextUsage ?? null);
    // The queue the runtime is holding is a fact of this answer exactly as the model and the reasoning level are, so it
    // is published here, under the same fence. A caller that published it from its own branch would clear a queue a
    // newer accepted statement had already stated while the transcript kept that newer one, showing an empty queue for
    // inputs that are still about to run.
    if (state.queuedMessages !== undefined) setQueuedMessages(normalizeQueuedMessages(state.queuedMessages));
    if (state.queuedItems !== undefined) setQueuedItems([...state.queuedItems]);
    if (state.control !== undefined) setControl({ ...state.control });
    // The composer's selected model and reasoning level are stated **beside** the accepted window, on the payload the
    // readout holds: they are refined here without touching the window or the prefix, which is what keeps the two
    // paths — a window a statement accepted, a selection an answer refined — from rewriting each other.
    setReadout((previous) => previous.session === null || previous.session.sessionId !== sid ? previous : {
      ...previous,
      session: {
        ...previous.session,
        context: {
          ...previous.session.context,
          ...(state.model === undefined ? {} : { model: { provider: state.model.provider, modelId: state.model.id } }),
          ...(state.thinkingLevel === undefined ? {} : { thinkingLevel: state.thinkingLevel }),
        },
      },
    });
    return true;
  }, []);

  /**
   * Publish one fold result. The projection decides; this puts its view on screen, keeps it for the promotion remount
   * and performs the I/O it requested — the fold owns no socket, timer or store of its own.
   */
  const applyStep = useCallback((next: Step) => {
    stepRef.current = next;
    const key = pendingConversationRef.current ?? sessionPropIdRef.current ?? newSessionDraftKey;
    if (key !== null && key !== undefined) saveProjection(scope, key, next);
    setStep(next);
    for (const effect of next.effects) runEffectRef.current?.(effect);
    for (const notice of next.notices) announceRef.current?.(notice);
  }, [newSessionDraftKey, scope]);

  /**
   * Fold one observation or intent into the conversation's lifecycle. The step is returned as well as published, so a
   * caller that has facts to state **beside** the projection — the revision, the head marker, the leaf, the run's
   * outcome — can obey the same acceptance decision instead of comparing revisions of its own.
   */
  const fold = useCallback((input: Input): Step => {
    const next = advance(stepRef.current.state, input);
    applyStep(next);
    return next;
  }, [applyStep]);

  /**
   * Receive one normalized statement from either transport through the one accepted-facts receiver: the statement is
   * folded, and the facts every transport carries beside the window are published **once, here** — the committed
   * transcript payload, the head marker, the active leaf, the run's outcome and the queue. The fold is asked first and
   * its answer is the only one that decides whether they are published, so neither transport keeps a revision
   * comparison or a second gate of its own.
   *
   * The **readout** is published here too, in the same step: the accepted window and the prefix it keeps are one
   * decision (`acceptSession`), so no render, effect or ref compares this window with the previous one afterwards.
   * What stays with the caller is only what is genuinely the transport's own: the HTTP read's tool loadout and failure
   * checkpoint, and the stream's live rendering. Those run under `receipt.accepted`, which is the receiver's decision
   * reported back rather than re-derived.
   */
  const receive = useCallback((statement: AcceptedStatement<SessionData>): StatementReceipt => {
    const receipt = receiveAccepted(stepRef.current, statement);
    applyStep(receipt.step);
    if (receipt.accepted && statement.facts !== null) {
      const facts = statement.facts;
      setReadout((previous) => acceptSession(previous, facts.session));
      // The head marker belongs to the **history**, not to the transport that last stated it: a native compaction
      // moves it on the stream, and a reader who then pages back before any read restates it is still loading pages
      // under the head that is current. Stamping them with the older one the last read left behind would make the next
      // same-head advance look like a compaction and throw the pages away.
      historyHeadRef.current = facts.historyHead;
      setActiveLeafId(facts.leafId);
      // A page load, a session switch or a post-settle reload reads the same failure the live stream reports, so a
      // missing model is visible without waiting for another turn.
      setRunFailure(facts.session.failure ?? null);
      // The stream's own frame states its queue; the HTTP read's arrives on the independent agent-state read, so an
      // absent one publishes nothing rather than clearing what the runtime last said.
      if (facts.queuedMessages !== undefined) setQueuedMessages({ steering: [...facts.queuedMessages.steering], followUp: [...facts.queuedMessages.followUp] });
      // The items ride the statement's own facts, beside the text lists and the control state they are projected from.
      if (facts.session.queuedItems !== undefined) setQueuedItems([...facts.session.queuedItems]);
      // The control rides the same statement the items do, so a frame cannot leave a held banner over a queue the
      // runtime has already released, or a Continue button on a conversation that is no longer held.
      if (facts.session.control !== undefined) setControl({ ...facts.session.control });
      // The conversation's own model and reasoning level travel with its accepted window, so they are read from the
      // transcript the projection holds instead of from a mirror a refused frame could move.
    }
    return receipt;
  }, [applyStep]);

  // The committed transcript and the staged overlay are the projection's, so nothing here decides what a turn is or
  // when it ended. Loading is that projection's readiness and not a second gate: the placeholder is shown only while
  // no complete projection has arrived and there is nothing to draw.
  const pendingSubmissions: readonly PendingTurn[] = view.pending;
  // The submissions this surface admitted and the conversation has not settled. Their entries are already in the
  // transcript, so the surface states their outcome there instead of drawing a turn of its own: the projection's
  // outstanding interest is the fact, and an interest whose outcome could not be established says so.
  const outstandingSubmissions = view.outstanding;
  // The placeholder is shown only while there is nothing at all to draw: no complete projection, no committed
  // message and no staged turn of this surface's own. A staged turn is on screen from the moment it is sent, so the
  // promotion that gives the composer its session cannot flash the placeholder over a turn the user just sent.
  const loading = !isNew && view.ready === "loading" && view.messages.length === 0 && view.pending.length === 0;

  /** The generation a callback arriving right now belongs to: the one the projection has accepted. */
  const currentAcquisition = useCallback((): Acquisition => stepRef.current.state.generation, []);

  /** Stamp a new acquisition: a read or a stream takes its number when it begins, never when its answer arrives. */
  const beginRead = useCallback((): Acquisition => {
    const acquisition = nextAcquisition(stepRef.current.state.generation);
    fold({ kind: "begin", acquisition });
    return acquisition;
  }, [fold]);

  const resolveComposerDraftKey = useCallback((key: string | undefined) => {
    if (!key) return undefined;
    let resolved = key;
    const visited = new Set<string>();
    while (!visited.has(resolved)) {
      visited.add(resolved);
      const next = draftKeyAliasesRef.current.get(resolved);
      if (!next) break;
      resolved = next;
    }
    return resolved;
  }, []);

  const restoreSubmission = useCallback((
    text: string,
    images: AttachedImage[] | undefined,
    targetDraftKey: string | undefined,
  ) => {
    const draftImages = images?.map(({ data, mimeType }) => ({ data, mimeType }));
    const destinationDraftKey = resolveComposerDraftKey(targetDraftKey);
    if (
      !sessionHookMountedRef.current
      && !newSessionPromotedRef.current
      && targetDraftKey === newSessionDraftKey
    ) return;
    const input = opts.chatInputRef?.current;
    if (input) {
      input.restoreSubmission(text, draftImages, destinationDraftKey);
    } else if (destinationDraftKey) {
      drafts.restoreSubmission(destinationDraftKey, text, draftImages);
    }
  }, [drafts, newSessionDraftKey, opts.chatInputRef, resolveComposerDraftKey]);

  /**
   * The transcript on screen: the accepted window (the projection's own committed transcript) with the reader's paged
   * prefix in front of it. Both halves are already decided — the prefix when the window was accepted, the window by the
   * fold — so this is a derivation with no rule left in it, and no effect that could apply a rule one render late.
   */
  const windowEntryIds = useMemo(() => view.data?.entries.map((entry) => entry.id) ?? [], [view.data]);
  const transcript = useMemo(
    () => transcriptOf(readout.prefix, { entryIds: windowEntryIds, messages: view.messages }),
    [readout.prefix, windowEntryIds, view.messages],
  );
  const messages = transcript.messages;
  const entryIds = transcript.entryIds;
  const historyCursor = transcript.cursor;

  const sessionStats = useMemo(() => {
    const fileStats = data?.stats;
    const stats = mergeSessionStats(fileStats, data?.context.messages ?? [], messages);
    if (stats.tokens.total === 0 && messages.length === 0 && !fileStats) return null;
    return {
      sessionId: sessionIdRef.current ?? session?.id ?? "",
      sessionName: session?.name,
      ...stats,
      ...(contextUsage ? { contextUsage } : {}),
    } satisfies SessionStatsInfo;
  }, [messages, contextUsage, data?.context.messages, data?.stats, session?.id, session?.name]);

  /** One usage-only agent-state read. It is the same answer shape and the same fence, so it uses the one writer. */
  /**
   * The composer state one accepted conversation read states, published through the same writer and fence as a state
   * answer would be.
   *
   * The read and the state query answer the same native snapshot, so a load that wants both asks for one. What makes
   * this safe is that the payload here is the one the fold **accepted**: its attachment identity and revision are the
   * conversation's current statement, so the fence accepts it exactly as it would accept the same payload arriving as a
   * state answer, and a read that was refused never reaches this.
   */
  const applyReadAgentState = useCallback((snapshot: NativeSnapshot, sid: string): { running: boolean; state: AgentStateResponse } | null => {
    const requestId = ++contextUsageRequestIdRef.current;
    const agentState = { running: snapshot.busy, state: agentStateOf(snapshot) };
    const liveState = agentState.state;
    const accepted = applyAgentState(liveState, sid, requestId, captureAcceptedStamp());
    if (!accepted) return null;
    if (liveState.systemPrompt !== undefined) setSystemPrompt(liveState.systemPrompt ?? null);
    if (liveState.extensionStatuses !== undefined) setExtensionStatuses(liveState.extensionStatuses ?? []);
    if (liveState.extensionWidgets !== undefined) setExtensionWidgets(liveState.extensionWidgets ?? []);
    return agentState;
  }, [applyAgentState, captureAcceptedStamp]);

  /**
   * Read one conversation. The read is a complete lifecycle frame — the transcript, the native run's inputs, the
   * outstanding submissions and the attachment's identity with its revision — so it feeds the projection exactly as
   * the stream's state frame does, stamped with the acquisition it began under. The tree, stats and settings the
   * projection does not carry are applied beside it; readiness is never gated on this read.
   */
  const loadSession = useCallback(async (sid: string, includeState = false, options?: { force?: boolean; acquisition?: Acquisition }): Promise<ConversationReadOutcome> => {
    const acquisition = options?.acquisition ?? beginRead();
    try {
      // The conversation's own read, through this surface's conversation session: the Backend's
      // `/api/conversations/:id/state`, which is the same native snapshot this surface projects and the same payload
      // the composer beside it is read from. `null` is the Backend's own `not_found`: the row is gone, so the view is.
      // Concurrent reads of one conversation are one request at that owner, so a mount, a stream settle and a reconcile
      // asking at the same moment do not race three answers; a forced read shares nothing.
      const snapshot = await conversation.read(sid, options?.force === true ? { force: true } : {});
      // The connection this read belongs to. A switch that landed while it was in flight makes every answer below one
      // from a client the surface no longer shows — including the `null` a not_found answers with — so each is checked
      // before it publishes, not once before the first of them.
      if (!fromCurrentConnection(conversation)) return { status: "superseded" };
      if (snapshot === null) {
        // The Backend's own `not_found`: the row is gone, so the view is — and a Retry cannot bring it back. The
        // surface says so instead of drawing an empty conversation that looks like a conversation with no messages.
        setReadout(emptyReadout());
        setActiveLeafId(null);
        setError(null);
        setReadFailure({ kind: "missing" });
        deleteSessionViewSnapshot(scope, sid);
        return { status: "missing" };
      }
      // The read answers the **native** snapshot, and the browser's one projection turns it into the shape the surface
      // renders. The lifecycle statement below is built from that same projected payload, so the transcript on screen
      // and the transcript the fold orders are one object rather than two mappings of one frame.
      const d = projectSession(snapshot);
      if (sessionIdRef.current !== sid) return { status: "superseded" };
      // The read is one statement about one conversation, so it goes through the one receiver: the fold decides first,
      // and its own decision is what the beside-view facts below obey — the read's window and the facts that travel with
      // it may not be published when the other is refused. The shared facts themselves (the transcript payload, the head
      // marker, the leaf, the failure and the queue) are published by the receiver, not here; what follows is only what
      // belongs to this transport's own read.
      let accepted = false;
      if (d.projectionId !== undefined) {
        // The read's own payload is what the receiver publishes, so the transcript it puts on screen is the object the
        // transport answered with rather than a rebuild of it field by field.
        accepted = receive(httpStatement({ ...d, sessionId: sid, projectionId: d.projectionId, revision: d.revision ?? 0, run: d.run ?? null, submissions: d.submissions ?? [], leafId: d.leafId, historyHead: d.historyHead ?? null }, acquisition)).accepted;
      } else {
        // A read with no projection identity is not a lifecycle statement at all, so no ordering is claimed for it —
        // but the window it carries is still the reader's transcript, and it is published through the same readout
        // (window, prefix and pagination claim in one decision) as a statement the fold accepted.
        setReadout((previous) => acceptSession(previous, d));
        setActiveLeafId(d.leafId);
        setRunFailure(d.failure ?? null);
        accepted = true;
      }
      // Everything else this read states belongs to the read's own path: the tool loadout, the model and thinking
      // overrides and the freshness checkpoint. A read the fold refused is an older window of the same conversation,
      // and none of those facts is any less derived from it than the transcript is. The prefix and the pagination claim
      // are not here: they were decided with the window they belong to, by the receiver.
      if (accepted) {
        // A read that landed settles the switch this surface was waiting for, so the override it set is dropped — but
        // only the current read may say so; an older one would drop an override a newer frame is still honouring.
        setCurrentModelOverride((current) => modelSwitchPendingRef.current ? current : null);
        setCurrentThinkingOverride(null);
        setError(null);
        // A read that landed is the recovery from the one that did not: the failure state is the read's, not a latch.
        setReadFailure(null);
      }
      // A caller that asked for composer state gets it from **this** answer, because this answer is the conversation's
      // own native snapshot: the conversation read and the state read are the same payload, so asking twice for one
      // load sends the same snapshot over the wire twice and then projects it twice. The transcript on screen and the
      // composer beside it are therefore one accepted snapshot, and no second request is made for it.
      //
      // What is *not* folded in is the case where this answer was refused: a read the fold called older describes a
      // window the surface has already replaced, so its composer fields are not this conversation's current ones and a
      // fresh read is the honest answer. That is the same reason a resync takes one.
      if (!includeState) return accepted ? { status: "accepted", agentState: null } : { status: "refused" };
      // A refused window is this read having established nothing about the conversation it describes, and that is the
      // answer whether or not the caller also asked for composer state. The agent-state query below is a read of its
      // own with its own ordering, but a caller that acted on its answer would resume a run, adopt a phase or claim a
      // reload from the very statement the fold rejected — the older window arriving by another route. So a refusal
      // ends the read here: no auxiliary request is made on behalf of a window nothing accepted.
      if (!accepted) return { status: "refused" };
      if (d.projectionId !== undefined) {
        const agentState = applyReadAgentState(snapshot, sid);
        return agentState === null ? { status: "refused" } : { status: "accepted", agentState };
      }

      try {
        // The id this read takes as it begins is the fence its answer is ordered by: an answer that lands after a
        // newer state read, or after a newer window that replaced what this one described, is not applied.
        const usageRequestId = ++contextUsageRequestIdRef.current;
        const acceptedStamp = captureAcceptedStamp();
        const stateSnapshot = await conversation.read(sid);
        if (!fromCurrentConnection(conversation)) return { status: "superseded" };
        if (stateSnapshot === null) throw new Error("This conversation no longer exists.");
        if (sessionIdRef.current !== sid) return { status: "superseded" };

        // The state read answers the conversation's own native snapshot too, so its composer-state fields are projected
        // by the browser from that same payload: the running flag this read acts on and the fields the writer publishes
        // come from one payload, not from two answers.
        const agentState = { running: stateSnapshot.busy, state: agentStateOf(stateSnapshot) };
        const liveState = agentState.state;
        // The state answer's own fields are published by its one writer, under its fence; what is left here is what
        // this read states beside it.
        const stateAccepted = applyAgentState(liveState, sid, usageRequestId, acceptedStamp);
        if (liveState && stateAccepted) {
          if (liveState.systemPrompt !== undefined) setSystemPrompt(liveState.systemPrompt ?? null);
          if (liveState.extensionStatuses !== undefined) setExtensionStatuses(liveState.extensionStatuses ?? []);
          if (liveState.extensionWidgets !== undefined) setExtensionWidgets(liveState.extensionWidgets ?? []);
        }
        // What the caller may act on is the accepted answer, not the answer it happened to receive: an answer the
        // fence refused describes a conversation the surface no longer shows, and acting on it — resuming a run's phase,
        // adopting its run flags — would put the older turn back on screen through the caller.
        return stateAccepted ? { status: "accepted", agentState } : { status: "refused" };
      } catch (e) {
        console.error("Failed to load agent state:", e);
        return { status: "failed", failure: classifyReadFailure(e) };
      }
    } catch (e) {
      // A read that failed is a state the projection can report — unread when there is no prior projection, the kept
      // view when there is — instead of an endless spinner or a fabricated outcome. One whose connection was replaced
      // while it was in flight reports nothing at all: its failure describes a client the surface no longer shows.
      if (!fromCurrentConnection(conversation)) return { status: "superseded" };
      const failure = classifyReadFailure(e);
      // A read the caller itself aborted is not a failure to report: it is the surface's own intent about an answer it
      // no longer wants, and folding it would put a transport issue over a conversation the reader just moved away from.
      if (failure.kind === "cancelled") return { status: "cancelled" };
      setError(String(e));
      setReadFailure(failure);
      fold(unavailableStatement(acquisition, failure.detail ?? failure.kind).input);
      return { status: "failed", failure };
    }
  }, [applyAgentState, applyReadAgentState, beginRead, captureAcceptedStamp, conversation, fold, fromCurrentConnection, receive]);

  /**
   * Read one page of older history. The route forwards the backend's own entries page, and the browser projects it —
   * the same projection that turns the conversation read's entries into the transcript — so a paged entry and a
   * streamed one are one shape. The page's own boundary and `hasMore` are the backend's; the model and reasoning level
   * are not restated here, because the accepted snapshot the surface holds already owns them.
   */
  const loadContext = useCallback(async (sid: string, leafId: string | null, before?: string | null, options?: {
    tail?: number;
    signal?: AbortSignal;
    /**
     * A page the read could not answer, reported to the caller that asked for it.
     *
     * A page read has two ways of establishing nothing and they are not the same fact: a conversation that
     * re-baselined under it makes the page describe history the surface has left (the answer is `undefined`, and the
     * caller should say nothing), while a read that failed establishes no page **yet**. The second is the one a
     * navigation has to report instead of claiming the entry is not in the branch, so it is named here rather than
     * collapsed into the same `undefined`.
     */
    onReadFailure?: (failure: ReadFailure) => void;
  }) => {
    // The context this page is read **from**, captured as the read begins. A page is not a lifecycle statement — it
    // states history, not a window — so it is ordered by the accepted context rather than by a publication revision:
    // an ordinary append advances the revision and must not discard a page the reader is waiting for, while a
    // re-baseline (a compaction or a reset) is exactly the event that makes the page describe a context the surface
    // has left. The head marker is that fact, and it is the accepted one — the same value the prefix rule decides on.
    const historyHead = historyHeadRef.current;
    // The connection this page is read through: a page that answers after a switch is one host's history, so it is
    // refused before it reaches the reader's prefix whatever its entries say.
    const readThrough = api;
    try {
      const params = new URLSearchParams();
      if (leafId) params.set("leafId", leafId);
      // Page upward: ask the server for the `tail` ancestors preceding `before`,
      // then prepend them. Omitting `before` fetches the most-recent `tail`.
      if (before) params.set("before", before);
      if (options?.tail) params.set("tail", String(options.tail));
      const page = projectContext(await api.historyPage(sid, {
        ...(leafId ? { leafId } : {}),
        ...(before ? { before } : {}),
        ...(options?.tail ? { tail: options.tail } : {}),
        ...(options?.signal ? { signal: options.signal } : {}),
      }) as NativeEntryPage);
      if (sessionIdRef.current !== sid || options?.signal?.aborted || !sessionHookMountedRef.current) return;
      if (!fromCurrentConnection(readThrough)) return;
      // The conversation re-baselined while this page was in flight: its entries belong to the context the surface has
      // left, so neither the prefix nor the pagination facts are published, and the caller is told no page was
      // established rather than being handed a cursor into history that is no longer on screen.
      if (historyHeadRef.current !== historyHead) return undefined;
      // A page read is older history the projection's own window does not carry: it is kept in front of that window, so
      // the transcript stays the projection's and the paged prefix is only ever prepended to it. The page's own
      // pagination claim is published with it, in the same update — a cursor and the entries it was read with are one
      // fact about one context.
      setReadout((prev) => (before
        ? prependOlderPage(prev, { sessionId: sid, entryIds: page.entryIds, messages: page.messages, historyHead, hasMore: page.hasMore })
        : claimEarlierHistory(clearPrefix(prev), page.hasMore)));
      return page;
    } catch (e) {
      if (options?.signal?.aborted || !fromCurrentConnection(readThrough)) return undefined;
      console.error("Failed to load context:", e);
      options?.onReadFailure?.(classifyReadFailure(e));
      return undefined;
    }
  }, [api, fromCurrentConnection]);

  /**
   * Land one bounded navigation target window in front of the projection's window.
   *
   * This is the history owner's half of a jump. The coordinator reads one window around one anchor (ticket 02's route);
   * the entries it carries join the reader's paged prefix through `landHistory` — ordered by the ids the Backend
   * issued, never twice, and **without** any entry the projection's own window is authoritative for. That last cut is
   * what keeps a landing from being a loss: a prefix that overlapped the window fails the prefix rule, which would drop
   * every page the reader had loaded.
   *
   * Nothing here decides where the reader is looking: the surface that owns the viewport scrolls once the target's DOM
   * exists, so a landing stays a fact about history rather than a side effect of an animation.
   */
  const landWindow = useCallback((sid: string, window: LandedWindow) => {
    if (window.entries.length === 0) return;
    const messages = projectMessages(window.entries as readonly { readonly message?: AgentMessage }[]);
    setReadout((held) => landHistory(held, {
      sessionId: sid,
      entryIds: window.entries.map((entry) => String(entry.id)),
      messages,
      windowEntryIds,
    }) ?? held);
  }, [windowEntryIds]);

  /**
   * Retry the conversation read this surface failed, and nothing else.
   *
   * The recovery a failed read gets is another read: the transcript, the run and the outstanding submissions are the
   * conversation's own statement, so asking again is the whole of it. What is deliberately **not** here is any resend —
   * a staged turn, a stop or an upload whose outcome was never established keeps its request id and goes back through
   * the submission lookup that owns it (ADR 0006), because a Retry that resent a mutation would be a second mutation.
   *
   * It is the same read a mount makes (`force`, so the single-flight does not hand back the answer that failed), under a
   * fresh acquisition, so an answer that lands after the reader has moved on is fenced like any other older one.
   */
  const retryRead = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (sid === null) return;
    // The failure is cleared by the read that succeeds, not here: a Retry that fails again must leave the panel it was
    // started from in place, or the surface would flicker through an empty transcript between two attempts.
    await loadSession(sid, true, { force: true });
  }, [loadSession]);

  /**
   * Drop the failure without retrying: the conversation is still on screen and the reader chose to keep reading.
   *
   * A named refusal is dismissed through the same action because it is the same kind of statement — the Backend could
   * not carry one frame, and the transcript it did carry is still there. Clearing it also drops the latch the refusal
   * keeps, so a later frame states its own refusal instead of being compared against one the reader already dismissed.
   */
  const dismissReadFailure = useCallback(() => {
    setReadFailure(null);
    oversizeRefusalRef.current = null;
    setError(null);
  }, []);

  const loadTools = useCallback(async (sid: string) => {
    // The connection this read goes through, captured as it begins: a switch that lands while it is in flight makes
    // its answer one host's tool list, so it is refused before the surface publishes it.
    const readThrough = api;
    try {
      const snapshot = await readThrough.read(sid);
      const tools = (snapshot?.toolNames ?? []).map((name) => ({ name, description: "Gateway " + name, active: true })) as ToolEntry[];
      if (!tools || !sessionHookMountedRef.current || sessionIdRef.current !== sid) return null;
      if (!fromCurrentConnection(readThrough)) return null;
      onSystemToolsChange?.(tools);
      return tools;
    } catch (e) {
      console.error("Failed to load tools:", e);
      return null;
    }
  }, [api, fromCurrentConnection, onSystemToolsChange]);

  const promoteNewSession = useCallback((messageCount = 0, firstMessage = "(no messages)") => {
    const sid = sessionIdRef.current;
    if (!isNew || !newSessionCwd || !sid || newSessionPromotedRef.current) return;
    newSessionPromotedRef.current = true;
    const provisionalDraftKey = newSessionDraftKey;
    if (!provisionalDraftKey) return;
    if (provisionalDraftKey !== sid) {
      draftKeyAliasesRef.current.set(provisionalDraftKey, sid);
      const input = opts.chatInputRef?.current;
      if (input) input.rekeyDraft(provisionalDraftKey, sid);
      else drafts.rekeyDraft(provisionalDraftKey, sid);
      // The pending turns follow the composer to its session the same way, so the remount that promotion causes reads
      // them back under the key the conversation now has.
      rekeyProjection(scope, provisionalDraftKey, sid);
      pendingConversationRef.current = sid;
    }
    onSessionCreated?.({
      id: sid,
      path: "",
      cwd: newSessionCwd,
      name: undefined,
      created: new Date().toISOString(),
      modified: new Date().toISOString(),
      messageCount,
      firstMessage,
      transient: true,
    }, provisionalDraftKey);
  }, [isNew, newSessionCwd, newSessionDraftKey, onSessionCreated, opts.chatInputRef]);

  const ensureNewSession = useCallback(async () => {
    if (sessionIdRef.current) return sessionIdRef.current;
    if (!isNew || !newSessionCwd) return sessionIdRef.current;
    if (ensuringNewSessionRef.current) return ensuringNewSessionRef.current;

    const promise = (async () => {
      // Only send explicit user overrides. The server resolves the current
      // enabledModels scope atomically with AgentSession construction.
      const selectedModel = newSessionModelOverrideRef.current;
      const selectedThinkingLevel = thinkingLevelOverrideRef.current;
      if (selectedModel) setPendingModel(selectedModel);
      // The create request carries the working directory and nothing else: a loadout the user picked is applied to the
      // conversation afterwards, as the settings update the Backend already serves, so the choice is in place before the
      // first prompt can be submitted under the runtime's defaults. No tool selection travels — this host serves no
      // command to change one, so the loadout is whatever the Backend resolves for the conversation (R9).
      const workspaceId = workspaceIdOfRoutingPath(newSessionCwd);
      const created = await api.create(workspaceId === null ? {} : { workspaceId });
      const realId = created.conversationId;
      sessionIdRef.current = realId;
      // A pick the user made is applied to the conversation it was made for, in one update, before the first prompt can
      // be submitted under the runtime's defaults. A composer that picked nothing sends nothing: the conversation's own
      // accepted snapshot states the level it was created under.
      const settings = selectedModel === null && selectedThinkingLevel === null ? null : {
        ...(selectedModel === null ? {} : { model: selectedModel }),
        ...(selectedThinkingLevel === null ? {} : { thinkingLevel: selectedThinkingLevel }),
      };
      if (settings === null) return realId;
      const applied = await api.updateSettings(realId, settings);
      if (applied.model !== null && newSessionModelOverrideRef.current === selectedModel) {
        setPendingModel(applied.model);
        if (!selectedModel) setNewSessionDefaultModel(applied.model);
      }
      if (applied.thinkingLevel && thinkingLevelOverrideRef.current === selectedThinkingLevel && !selectedThinkingLevel) {
        setNewSessionDefaultThinkingLevel(asConcreteThinkingLevel(applied.thinkingLevel as ThinkingLevelOption));
      }
      return realId;
    })();

    ensuringNewSessionRef.current = promise;
    try {
      return await promise;
    } finally {
      ensuringNewSessionRef.current = null;
    }
  }, [isNew, newSessionCwd]);

  // Opening the System or Tools panel may initialize an otherwise dormant
  // session. This is deliberately a non-prompt command: it creates no message
  // or model run, but lets users inspect the exact prompt before sending one.
  const loadSystemInfo = useCallback(async () => {
    const sid = sessionIdRef.current ?? await ensureNewSession();
    if (!sid) return;

    const requestId = ++contextUsageRequestIdRef.current;
    const acceptedStamp = captureAcceptedStamp();
    // `get_state` answers the conversation's own native snapshot; this surface reads the composer's fields out of it
    // through the browser's one projection, exactly as it reads them from the state read.
    const [snapshot] = await Promise.all([
      api.read(sid),
      loadTools(sid),
    ]);
    if (snapshot === null) return;
    if (!sessionHookMountedRef.current || sessionIdRef.current !== sid) return;
    const state = agentStateOf(snapshot);
    // The answer's own fields are published by its one writer, and this panel fills from the answer the writer
    // accepted: one it refused describes a conversation the surface no longer shows.
    if (!applyAgentState(state, sid, requestId, acceptedStamp)) return;
    setSystemPrompt(state.systemPrompt ?? "");
  }, [applyAgentState, captureAcceptedStamp, ensureNewSession, loadTools]);

  const replaceSlashCommands = useCallback((commands: SlashCommandInfo[]) => {
    slashCommandsRef.current = commands;
    setSlashCommands(commands);
  }, []);

  // The session's tools changed (a rebuilt session may be Chat only): forget the list
  // and the request under way, so the next reader asks the session as it is now.
  const clearSlashCommands = useCallback(() => {
    slashCommandsGenerationRef.current += 1;
    slashCommandsLoadRef.current = null;
    replaceSlashCommands([]);
  }, [replaceSlashCommands]);

  // Null when get_commands failed, which an empty list (a Chat-only session's) must not be mistaken for.
  const requestSlashCommands = useCallback((): Promise<SlashCommandInfo[] | null> => {
    const generation = ++slashCommandsGenerationRef.current;
    const current = () => slashCommandsGenerationRef.current === generation;
    const load = (async () => {
      const sid = sessionIdRef.current ?? await ensureNewSession();
      if (!sid) {
        if (current()) replaceSlashCommands([]);
        return [] as SlashCommandInfo[];
      }
      setSlashCommandsLoading(true);
      try {
        const data = await api.commands(sid);
        const commands = data.commands ?? [];
        if (current()) replaceSlashCommands(commands);
        return commands;
      } catch (e) {
        console.error("Failed to load slash commands:", e);
        if (current()) replaceSlashCommands([]);
        return null;
      } finally {
        // A newer request under way keeps the palette's "Loading" until it answers.
        if (current() || !slashCommandsLoadRef.current) setSlashCommandsLoading(false);
      }
    })();
    slashCommandsLoadRef.current = load;
    const settle = () => {
      if (slashCommandsLoadRef.current === load) slashCommandsLoadRef.current = null;
    };
    load.then(settle, settle);
    return load;
  }, [ensureNewSession, replaceSlashCommands]);

  const loadSlashCommands = useCallback(async () => (await requestSlashCommands()) ?? [], [requestSlashCommands]);

  // The list a bare /mcp is decided by: the request under way (the palette starts
  // one as "/mcp" is typed, often still unanswered at Enter), else the list already
  // loaded, else a new request. Null when it cannot be read: guessing would either
  // swallow another extension's /mcp or send one Settings should have taken.
  const slashCommandsForMcp = useCallback(async (): Promise<SlashCommandInfo[] | null> => {
    const pending = slashCommandsLoadRef.current;
    const known = slashCommandsRef.current;
    if (!pending && known.length > 0) return known;
    const loaded = await (pending ?? requestSlashCommands()).catch(() => null);
    return loaded ?? (known.length > 0 ? known : null);
  }, [requestSlashCommands]);

  /**
   * Join this conversation's stream through the surface's one conversation session. A join is idempotent at that owner,
   * so a reconnect is a deliberate act and not a side effect of rendering, and the session holds the reader's place —
   * this hook holds only what the frames mean.
   *
   * The join hands this reader where the stream already is: a conversation a background watch kept for a run still in
   * flight (or another reader of the same conversation) is already streaming, and the continuity is the state every
   * frame after this continues from. A state bound to another conversation, or to none, cannot fold a single frame of
   * this one, so it is bound to the conversation shown either way.
   */
  const joinEvents = useCallback((sid: string): StreamJoin => {
    const join = conversation.join(sid, (event) => handleAgentEventRef.current?.(event as AgentEvent));
    streamHeldRef.current = join.continuity ?? emptyStreamState(sid);
    // A stream already in flight is on screen at once, rather than after the read that would otherwise be the only
    // thing able to show it: the transcript and the live state are what this stream is holding right now.
    if (join.continuity !== null) publishStreamStateRef.current?.(sid, join.continuity);
    return join;
  }, [conversation]);

  /** Leave this conversation's stream. The conversation keeps it when the shell still has work to watch for. */
  const closeEvents = useCallback(() => {
    conversation.release();
  }, [conversation]);

  /** Drop and reopen this conversation's stream: a restarted backend is a new attachment, not a lost reader. */
  const reconnectEvents = useCallback((sid: string) => {
    conversation.reconnect(sid);
  }, [conversation]);

  const ensureEventsConnected = useCallback(async (sid: string) => {
    const join = joinEvents(sid);
    await join.ready();
  }, [joinEvents]);

  const onProjectionChange = opts.onProjectionChange;
  // The conversation on screen keeps its stream for as long as it has work in flight, and the projection is what says
  // so: no busy edge, no poll and no timer decides when the work is over. The handover is left standing when this
  // surface goes away — the shell keeps the stream for a conversation left with something in flight, and the watch that
  // inherits it continues from this very projection and releases itself once those turns settle. So leaving is a
  // handover, not a close, and what the surface was still waiting for is not lost on the way.
  useEffect(() => {
    const sid = sessionIdRef.current ?? session?.id ?? null;
    if (sid === null) return;
    onProjectionChange?.(sid, step);
  }, [onProjectionChange, session?.id, step]);

  // Keep the selected session warm even while its agent is idle. The SSE lease
  // is renewed separately below and expires if the browser disappears.
  useEffect(() => {
    const sid = session?.id;
    if (!sid) return;
    // React Strict Mode re-runs every effect after a simulated unmount, in
    // declaration order. The mount-only effect below flips this ref to false
    // in its cleanup and only restores it when it re-runs *after* this one,
    // so without re-asserting it here a Strict Mode remount would leave the
    // selected session without its stream.
    sessionHookMountedRef.current = true;
    joinEvents(sid);
    return () => {
      if (sessionIdRef.current === sid) closeEvents();
    };
  }, [closeEvents, joinEvents, session?.id]);

  /** State one notice fact. How it is drawn, and for how long, is not this owner's question. */
  const addNotice = useCallback((notice: { id?: string; message: string; type?: NoticeType }) => {
    const message = notice.message.trim();
    if (!message) return;
    const fact: NoticeFact = { id: notice.id ?? createNoticeId(), message, type: notice.type ?? "info" };
    // Stated once per id, so a repeated statement of the same fact does not queue a second toast for it.
    setNotices((held) => (held.some((drawn) => drawn.id === fact.id) ? held : [...held, fact]));
  }, []);

  /** The shelf is finished with a fact: it is dropped here, which is the only thing that removes a notice. */
  const dismissNotice = useCallback((id: string) => {
    setNotices((held) => (held.some((drawn) => drawn.id === id) ? held.filter((drawn) => drawn.id !== id) : held));
  }, []);

  /**
   * Act on the fold's notices. A completion notice is the only thing that reports a finished turn — one per answer, so a
   * steer group sounds once — and an unanswered one shows the reason the runtime gave without ever sounding. A refusal
   * puts the staged text back in the draft, which is what makes a resend the user's own act.
   *
   * A completion is first offered to the page's one registry, which is shared with the background watches: the first
   * owner to name an answer reports it, so a handover on selection and a second reader of the same stream cannot sound
   * one completion twice. A notice the registry has already seen is reported by whoever saw it first.
   *
   * Only an answered terminal fact is a completion. An aborted, failed or withdrawn run is not reported as one — it is
   * the user's own screen that shows its reason — and nothing else in the page turns one into a sound.
   */
  const onLiveSettlement = opts.onLiveSettlement;
  useEffect(() => {
    announceRef.current = (notice) => {
      const conversationId = sessionIdRef.current;
      if (notice.kind === "answered") {
        // The page's one registry is asked first: the first owner to name an answer reports it, so a completion the
        // registry already saw — this surface's own reconnect, or another owner that observed the same fact — is not
        // sounded twice, and a conversation the user is not looking at is reported by the watch that folded it.
        if (conversationId !== null && onLiveSettlement !== undefined) {
          if (!onLiveSettlement({ conversationId, answerKey: notice.answerId })) return;
        }
        onAgentEnd?.();
        return;
      }
      if (notice.kind === "unanswered") {
        // Never a success: the reason is shown and no tone is played for it.
        addNotice({ type: "error", message: notice.reason });
        return;
      }
      restoreSubmission(notice.restore.text, notice.restore.images?.map((image) => ({ ...image, previewUrl: "" })), composerDraftKey);
      addNotice({ type: "error", message: notice.reason });
    };
  }, [addNotice, composerDraftKey, onAgentEnd, onLiveSettlement, restoreSubmission]);

  /**
   * Resolve one turn whose outcome this surface could not establish. It asks the conversation for that exact submission
   * by the request id the browser generated — the fold's own requested effect, never an inference from a frame — and
   * feeds the durable record back. A lookup that found nothing is reported as unknown rather than turned into a
   * rejection, and the request is never resent (ADR 0006).
   */
  const lookupSubmission = useCallback(async (acquisition: Acquisition, sid: string, targetRequestId: string) => {
    let record: WireSubmission | null = null;
    try {
      record = await conversation.lookup(sid, targetRequestId) as WireSubmission | null;
    } catch {
      // Still unreachable: the turn stays unknown, which is the honest state, and a later reconnect retries the lookup.
      return;
    }
    if (sessionIdRef.current !== sid) return;
    fold({ kind: "lookup", conversationId: sid, acquisition, subject: { requestId: targetRequestId }, record });
  }, [conversation, fold]);

  /** Every effect the fold requests is I/O this hook performs; it is bound here, after the I/O it needs exists. */
  useEffect(() => {
    runEffectRef.current = (effect) => {
      const sid = sessionIdRef.current;
      if (sid === null) return;
      if (effect.kind === "lookup") {
        if ("requestId" in effect.subject) void lookupSubmission(effect.acquisition, sid, effect.subject.requestId);
        return;
      }
      // A snapshot from another attachment cannot rebase the accepted view, so the fold asks for a fresh acquisition:
      // re-open the stream, which selects the authoritative identity for its own generation.
      reconnectEvents(sid);
    };
  }, [lookupSubmission, reconnectEvents]);

  /**
   * Ask the conversation about every turn this surface is still waiting on. It replaces inferring a settlement from a
   * turn's absence in a frame: a frame can be missed, a stream can be reconnected, and the outstanding set says only
   * what is still in flight — so each unfinished turn is asked about by the request id it was sent under.
   */
  const recoverPendingTurns = useCallback((sid: string | null) => {
    if (sid === null) return;
    // The registry of unresolved turns is the fold's, so it enumerates them; each is then asked about by the identity
    // it was sent under, which is the effect this hook performs as real I/O.
    fold({ kind: "recover", acquisition: currentAcquisition() });
  }, [currentAcquisition, fold]);

  /** Whether the projection currently reports a live native run. */
  const runLive = useCallback(() => stepRef.current.view.activity !== null, []);

  /**
   * One native state this stream holds, as the surface's payload: projected from the state exactly as a read's payload
   * is — one projection owner, one shape — and published only through the fold's own acceptance decision. The queue
   * travels beside the window because it is a fact the **stream** states and the HTTP read does not, so it is read off
   * the same state rather than kept as a second copy of the conversation's.
   *
   * The transport's own rendering is read from that same state so it obeys the same decision: a state the fold refused
   * is not this conversation's current statement, and letting it end the streaming surface, name the tools or clear the
   * compaction flag would put the older turn back on screen through the rendering path.
   */
  const publishStreamState = useCallback((conversationId: string, held: SessionState<AgentMessage>) => {
    const next = projectSession(held);
    const live = projectLive(held);
    const accepted = receive(sseStatement({ ...next, sessionId: conversationId, run: next.run ?? null, queuedMessages: live.queuedMessages, queuedItems: live.queuedItems }, currentAcquisition())).accepted;
    if (!accepted) return;
    const running = live.liveTools.filter(tool => tool.status !== "done");
    setActiveToolResults(new Map(running.map(tool => [tool.callId, { role: "toolResult" as const, toolCallId: tool.callId, toolName: tool.name, content: [{ type: "text" as const, text: tool.output ?? "" }], details: tool.details }])));
    dispatch({ type: "end" });
    if (live.liveMessage) dispatch({ type: "snapshot", message: live.liveMessage });
    // A window the conversation itself stated is the recovery from a read that failed: the stream is the same statement
    // by another transport, so leaving the panel up over a transcript that has arrived would report a failure the
    // conversation has already answered.
    setReadFailure((current) => (current === null ? current : null));
    setAgentPhase(live.busy ? running.length ? { kind: "running_tools", tools: running.map(tool => ({ id: tool.callId, name: tool.name })) } : { kind: "waiting_model" } : null);
    // A window that did arrive is the recovery from a refusal that did not: the backend carried this one, so the
    // refusal it named earlier is no longer the state of this session. Only that exact message is cleared.
    const refusal = oversizeRefusalRef.current;
    if (refusal !== null) { oversizeRefusalRef.current = null; setError(current => current === refusal ? null : current); }
  }, [currentAcquisition, receive]);

  const handleAgentEvent = useCallback((event: AgentEvent) => {
    switch (event.type) {
      case "resync": {
        // A missed frame, announced by the backend itself: every turn still waiting is asked about by name.
        if (event.sessionId !== sessionIdRef.current) break;
        recoverPendingTurns(sessionIdRef.current);
        break;
      }
      case "oversize": {
        // The backend could not carry a frame and said so by name instead of writing one the transport would destroy.
        // It is a statement about a **read**, not about a turn: no submission is settled, no draft is restored and
        // nothing is resent — the outstanding set stays the projection's own authority. What the user gets is the
        // refusal, visibly, so a first load that cannot be bounded is not an empty screen that waits forever.
        if (event.sessionId !== sessionIdRef.current) break;
        const refusal = event as unknown as { reason?: unknown; entryId?: unknown; bytes?: unknown };
        const named = "This conversation could not be opened in one piece: " + (typeof refusal.reason === "string" ? refusal.reason : "frame_too_large") + (typeof refusal.entryId === "string" ? ", entry " + refusal.entryId : "") + (typeof refusal.bytes === "number" ? " (" + refusal.bytes + " bytes)" : "") + ". Its entries are still stored and readable by id.";
        oversizeRefusalRef.current = named;
        setError(named);
        break;
      }
      case "submission": {
        // One submission's lifecycle as the backend reported it, delivered live. A settlement is the only fact that
        // cannot ride the state frame — the settled submission is absent from the outstanding set — so this is where a
        // turn ends by name instead of by its absence.
        const conversationId = sessionIdRef.current;
        if (conversationId === null || event.sessionId !== conversationId) break;
        const frame = event as unknown as { submission?: WireSubmission };
        if (frame.submission === undefined) break;
        receive(submissionStatement({ sessionId: conversationId, submission: frame.submission }, currentAcquisition()));
        break;
      }
      case "frame": {
        // One **native** frame: a complete window, or an advance on the window this stream already holds. The fold is
        // the browser's own — reduceSseFrame, the same reducer the SDK's client uses — so a delta is assembled here
        // from what this stream has already received rather than from a whole window the Web host rebuilt per frame.
        //
        // Two stores, deliberately distinct. The **stream-local** state below is only this stream's continuity: it may
        // advance on a frame the conversation's projection then refuses, because continuing a stream and being the
        // conversation's current statement are different questions. The **global** accepted facts — the window the
        // surface renders, its prefix, its beside state and its cache — are published only through receive, which is
        // the fold's own acceptance decision and the only gate on them.
        const conversationId = sessionIdRef.current;
        if (conversationId === null || event.sessionId !== conversationId) break;
        const incoming = event.data as NativeFrame;
        // A frame for another conversation's window is not this stream's continuity: the reducer leaves a state it was
        // not told about untouched, and treating that as a folded frame would publish an empty window over the
        // surface's own. The guard is the conversation identity, which is the one thing every frame states.
        if (incoming.conversationId !== conversationId) break;
        const held = reduceSseFrame(streamHeldRef.current, String(event.event), incoming);
        streamHeldRef.current = held;
        if (held.resyncRequired === true) {
          // The frame could not continue this stream: the backend's own answer to that is a fresh bounded read, which
          // the resync path performs — nothing is inferred from what a later frame does not mention.
          recoverPendingTurns(conversationId);
          break;
        }
        publishStreamState(conversationId, held);
        break;
      }
      case "connected": {
        // A new attachment is a new lifecycle clock for the same history, so this stream's own continuity starts over:
        // the baseline frame that follows states the whole window, and folding it onto the previous attachment's state
        // would be continuing a stream that ended.
        streamHeldRef.current = emptyStreamState(sessionIdRef.current ?? "");
        dispatch({ type: "end" });
        // A stream that just opened may have missed a settlement while it was down, and the frame it opens with says
        // only what is outstanding now. Every turn still waiting is therefore asked about by the request id it was sent
        // under, so a turn that settled in between is settled by its own record instead of lingering or being guessed at.
        recoverPendingTurns(sessionIdRef.current);
        break;
      }
    }
  }, [publishStreamState, receive, recoverPendingTurns]);
  handleAgentEventRef.current = handleAgentEvent;
  publishStreamStateRef.current = publishStreamState;

  /**
   * The refusal every send path shares: a draft that asks for a shell command.
   *
   * It runs before any staging or dispatch, so nothing is folded, no request is sent and the turn never becomes a
   * pending submission — for an idle send, a steer and a follow-up alike, because all three reach the host through
   * here. The draft is left where it is: the composer keeps the text and its attachments and states the limit while
   * the draft is typed, so a refusal never has to put anything back.
   */
  const refuseShellCommandDraft = useCallback((message: string, images?: AttachedImage[]) => {
    if (!isShellCommandDraft(message.trim(), images?.length ?? 0)) return false;
    addNotice({
      type: "warning",
      message: "This host does not run shell commands from the composer. Ask the assistant to run the command instead — its bash tool still runs on the execution host.",
    });
    return true;
  }, [addNotice]);

  const handleSend = useCallback(async (message: string, images?: AttachedImage[]) => {
    const trimmedMessage = message.trim();
    if (!trimmedMessage && !images?.length) return;
    // The one refusal every send path shares, before anything is staged or dispatched.
    if (refuseShellCommandDraft(message, images)) return;
    if (runLive()) {
      restoreSubmission(message, images, composerDraftKey);
      return;
    }
    const isSlashCommandPrompt = !images?.length && trimmedMessage.startsWith("/");

    // The turn is staged in the projection from here, not appended to the transcript: the conversation's own committed
    // entry is what moves it into history. Its identity is the requestId this browser generated, so an identical text
    // sent twice is still two distinct turns.
    const requestId = createRequestId();
    fold({
      kind: "stage",
      requestId,
      content: { text: message, ...(images?.length ? { images: images.map((img) => ({ data: img.data, mimeType: img.mimeType })) } : {}) },
      whenBusy: "reject",
    });
    setAgentPhase(isSlashCommandPrompt ? { kind: "running_command" } : { kind: "waiting_model" });
    dispatch({ type: "start" });
    // A staged turn of this reader's own is the viewport's cue: its prompt is followed once the transcript holds it.
    setOwnSends((sent) => sent + 1);

    const piImages = images?.map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mimeType }));
    let sentSessionId: string | null = null;
    let promptRequestStarted = false;
    // The stream this send will be observed on is acquired before the prompt is dispatched, so its frames carry the
    // acquisition this send began under and a run that settles immediately is still ordered correctly.
    let acquisition = currentAcquisition();

    try {
      if (isNew && newSessionCwd) {
        const selectedModel = newSessionModel;
        const existingSid = sessionIdRef.current ?? await ensuringNewSessionRef.current;
        const sid = existingSid ?? await ensureNewSession();

        if (!sid) throw new Error("Unable to create a session for the prompt");
        sentSessionId = sid;
        // The turn now belongs to this conversation, named before the send so the promotion remount cannot mistake it
        // for a conversation switch and take the staged turn off the screen.
        pendingConversationRef.current = sid;
        fold({ kind: "promote", conversationId: sid });
        if (selectedModel) {
          setPendingModel(selectedModel);
          if (existingSid) {
            await api.updateSettings(sid, { model: { provider: selectedModel.provider, modelId: selectedModel.modelId } });
          }
        }
        acquisition = beginRead();
        await ensureEventsConnected(sid);
        promptRequestStarted = true;
        const admitted = await admit(sid, requestId, message, piImages);
        // The admission answer names the durable submission; the turn stays staged until its entry is committed.
        if (admitted?.submissionId !== undefined) fold({ kind: "receipt", conversationId: sid, requestId, submissionId: admitted.submissionId });
        promoteNewSession(1, message);
      } else if (session) {
        sentSessionId = session.id;
        pendingConversationRef.current = session.id;
        acquisition = beginRead();
        await ensureEventsConnected(session.id);
        promptRequestStarted = true;
        const admitted = await admit(session.id, requestId, message, piImages);
        if (admitted?.submissionId !== undefined) fold({ kind: "receipt", conversationId: session.id, requestId, submissionId: admitted.submissionId });
      } else {
        throw new Error("No active session for the prompt");
      }
    } catch (e) {
      console.error("Failed to send message:", e);
      const definitivelyRejected = !promptRequestStarted || isRefusal(e);
      // A transport/proxy failure after dispatch is ambiguous: the server may have accepted the prompt before the
      // response was lost. The outcome is unknown, not a rejection, so the turn stays on screen and is looked up by its
      // own request id; it is never resent and its text is not restored as if the backend had refused it.
      if (!definitivelyRejected && sentSessionId) {
        fold(unavailableStatement(acquisition, e instanceof Error ? e.message : String(e), requestId).input);
        return;
      }
      // A readable rejection is the backend's answer about this submission: the staged turn leaves the screen and its
      // text returns to the draft, so a resend is the user's deliberate act. A link that died before dispatch is not a
      // rejection, and that case returned above without reaching here. A send whose conversation could not be created
      // never dispatched anything, so its refusal names no conversation — the fold's own notice is still the one owner
      // of putting the staged text and images back, which is what settles the turn instead of leaving it on screen.
      fold({
        kind: "refusal",
        ...(sentSessionId === null ? {} : { conversationId: sentSessionId }),
        requestId,
        reason: e instanceof Error ? e.message : String(e),
      });
      // A refusal only describes this submission, so the stream stays: another tab or a missed frame may still have a
      // real run active for the same conversation.
      if (sentSessionId === null) {
        closeEvents();
        setAgentPhase(null);
        dispatch({ type: "end" });
      }
    }
  }, [addNotice, isNew, newSessionCwd, newSessionModel, session, ensureNewSession, ensureEventsConnected, promoteNewSession, beginRead, closeEvents, composerDraftKey, restoreSubmission, fold]);

  /**
   * The composer's Stop is the **user's own stop**, not the native abort.
   *
   * The two are different operations: an abort discards the queued inputs and ends the run, while a stop commits
   * `held` with the trusted user source, withdraws the inputs queued at that commit point, marks the ordinary live
   * tasks for abort, and leaves a late arrival — an automatic report — queued and editable instead of running it. Only
   * the user's own stop can be trusted as the reason admission is held, so the button that says "stop" is the one that
   * holds; the native abort stays reachable through the adapter for a caller that wants the queue discarded
   * (spec D07, D09).
   *
   * The request carries its own stable id, so a retry after a lost answer reads the durable receipt instead of
   * sweeping the items that arrived since.
   */
  const handleAbort = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    try {
      const stopped = await api.control(sid).stop(createRequestId());
      if (!stopped.ok) throw operationFailure(stopped);
    } catch (e) {
      console.error("Failed to stop:", e);
      addNotice({ type: "error", message: "Could not stop: " + (e instanceof Error ? e.message : String(e)) });
    }
  }, [addNotice]);

  const handleFork = useCallback(async (entryId: string) => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    setForkingEntryId(entryId);
    try {
      const forked = await api.control(sid).fork({ requestId: createRequestId(), ...(entryId ? { at: entryId } : {}) });
      if (!forked.ok) throw operationFailure(forked);
      onSessionForked?.(forked.value.conversationId);
    } catch (e) {
      console.error("Fork failed:", e);
      addNotice({ type: "error", message: e instanceof Error ? e.message : String(e) });
    } finally {
      setForkingEntryId(null);
    }
  }, [addNotice, onSessionForked]);

  const handleModelChange = useCallback(async (provider: string, modelId: string) => {
    if (isNew) {
      const selectedModel = { provider, modelId };
      newSessionModelOverrideRef.current = selectedModel;
      setNewSessionModel(selectedModel);
      setPendingModel(selectedModel);
      if (thinkingLevelOverrideRef.current === null) {
        const pinned = thinkingLevelPinsRef.current[`${provider}/${modelId}`];
        setNewSessionDefaultThinkingLevel(
          asConcreteThinkingLevel(pinned) ?? defaultThinkingLevelRef.current,
        );
      }
      const sid = sessionIdRef.current ?? await ensuringNewSessionRef.current;
      if (!sid) return;
      try {
        await api.updateSettings(sid, { model: { provider, modelId } });
      } catch (e) {
        console.error("Failed to set model:", e);
      }
      return;
    }
    const sid = sessionIdRef.current;
    if (!sid || modelSwitchPendingRef.current) return;
    const target = { provider, modelId };
    const previousOverride = currentModelOverride;
    modelSwitchPendingRef.current = true;
    setCurrentModelOverride(target);
    setModelSwitching(true);
    try {
      await api.updateSettings(sid, { model: { provider, modelId } });
      // Pi persists model_change synchronously. Reload the canonical session so
      // the model, thinking level, and active leaf all advance together.
      modelSwitchPendingRef.current = false;
      await loadSession(sid);
    } catch (e) {
      console.error("Failed to set model:", e);
      modelSwitchPendingRef.current = false;
      setCurrentModelOverride(previousOverride);
      addNotice({
        type: "error",
        message: `Failed to switch model: ${e instanceof Error ? e.message : String(e)}`,
      });
      // A failed response can still follow a server-side write (for example, a
      // dropped connection), so let the session file settle the displayed model.
      await loadSession(sid, true);
    } finally {
      modelSwitchPendingRef.current = false;
      setModelSwitching(false);
    }
  }, [addNotice, currentModelOverride, isNew, loadSession, setNewSessionModel]);

  const loadModels = useCallback(async (signal?: AbortSignal) => {
    const modelCwd = newSessionCwd ?? session?.cwd ?? "";
    const modelsUrl = modelCwd ? `/api/models?cwd=${encodeURIComponent(modelCwd)}` : "/api/models";
    let d: ModelsResponse;
    try {
      // The catalog is read through the connection — this Gateway's origin and this connection's credential — and held
      // in the page's one cache under the connection's own scope plus this folder. A switch therefore reads the new
      // connection's answer instead of the previous one's, and two selectors on one page share one read.
      //
      // The shared read belongs to the connection, so this consumer's `signal` is deliberately not attached to it: a
      // composer that goes away mid-read retires its own interest below instead of cancelling a read another composer is
      // waiting on. What the signal still fences is this consumer's state, which is why the read is re-checked before any
      // of it is written.
      // The cache holds the answer as the deployment stated it; what the composer below reads is the one shape
      // `readCatalogAnswer` produces from it. Reading the Backend's list as the retired BFF's name map is what made a
      // selector render a model object as a name.
      d = await modelsCache().load(modelsScopeOf(identity), modelCwd, async () =>
        readCatalogAnswer(await client.readJson<unknown>(modelsUrl)));
      signal?.throwIfAborted();
    } catch (e) {
      if (!signal?.aborted && !(e instanceof DOMException && e.name === "AbortError")) {
        setModelError(e instanceof Error ? e.message : String(e));
      }
      throw e;
    }
    setModelNames(d.models);
    setModelError(d.modelError ?? null);
    setModelScopeWarnings(d.modelScopeWarnings ?? []);
    setModelThinkingLevels(d.thinkingLevels ?? {});
    setModelThinkingLevelMaps(d.thinkingLevelMaps ?? {});
    const nextModelList = d.modelList;
    setModelList(nextModelList);
    const displayDefaultModel = d.defaultModel
      ? nextModelList.find((m) => m.id === d.defaultModel?.modelId && m.provider === d.defaultModel?.provider)
      : undefined;
    setNewSessionDefaultModel(displayDefaultModel
      ? { provider: displayDefaultModel.provider, modelId: displayDefaultModel.id }
      : null);
    thinkingLevelPinsRef.current = d.thinkingLevelPins ?? {};
    defaultThinkingLevelRef.current = asConcreteThinkingLevel(d.defaultThinkingLevel);
    if (isNew && !sessionIdRef.current) {
      // A picked model this folder does not offer (one carried over from the
      // composer this one replaced, or since scoped out) goes back to automatic.
      // An empty list offers nothing to compare with (a failed load answers
      // with one): the pick stays.
      const picked = newSessionModelOverrideRef.current;
      const kept = picked && (nextModelList.length === 0
        || nextModelList.some((m) => m.provider === picked.provider && m.id === picked.modelId));
      if (picked && !kept) {
        newSessionModelOverrideRef.current = null;
        setNewSessionModel(null);
      }
      // The first listed model is not necessarily the runtime's automatic choice.
      // An `enabledModels` pattern may pin a thinking level (`anthropic/*:high`).
      // Like pi, apply it to the model a new session starts with.
      const startModel = kept ? picked : displayDefaultModel && { provider: displayDefaultModel.provider, modelId: displayDefaultModel.id };
      const pinned = startModel && d.thinkingLevelPins?.[`${startModel.provider}/${startModel.modelId}`];
      if (thinkingLevelOverrideRef.current === null) {
        setNewSessionDefaultThinkingLevel(
          asConcreteThinkingLevel(pinned) ?? defaultThinkingLevelRef.current,
        );
      }
    }
  }, [client, identity, isNew, newSessionCwd, session?.cwd]);

  /**
   * The one reload this conversation has, whichever surface asked for it.
   *
   * Settings › General and the `/reload` command are the same operation: ask the Backend's own resource route, read the
   * conversation that picks the change up, and state what the **read** established. Having one owner is what makes the
   * two agree — a surface that reloaded and then asked this would ask twice, and a second implementation would be free
   * to report a different outcome for the same facts.
   *
   * The route's own rejection is answered here rather than left to a caller: a POST that never answered established
   * nothing, so it is a failure this operation reports like any other. Nothing is thrown out of this function, because
   * every caller is a surface that has already finished its own work by the time it asks.
   */
  const reloadResources = useCallback(async (sid: string): Promise<ReloadOutcome> => {
    let reloaded: { resources?: { pending?: boolean; skills?: number; prompts?: number } };
    try {
      reloaded = await conversation.reload(sid);
    } catch (e) {
      // The route belongs to the connection that asked for it. A rejection that lands after this surface was replaced
      // is one host's failure about a conversation nothing on screen shows — the same fence the read gets, applied
      // before the notice rather than after it — so the replaced connection's answer is not stated as the current one's.
      if (!fromCurrentConnection(conversation) || sessionIdRef.current !== sid) return { status: "superseded" };
      // A route that did not answer says nothing about the conversation, so the failure is the whole statement.
      const message = `Reload failed: ${e instanceof Error ? e.message : String(e)}`;
      addNotice({ type: "error", message });
      return { status: "failed", message };
    }
    // The read is what this operation claims: the route only changed the runtime's resources.
    const read = await loadSession(sid, true, { force: true });
    switch (read.status) {
      case "superseded":
        // Another connection or another conversation is on screen: this one's reload is no longer a fact about what the
        // surface shows, so it claims nothing rather than stating an outcome for a conversation nobody is looking at.
        return { status: "superseded" };
      case "refused":
        // The fold called this window older than the one it holds. The surface already states the newer window, and a
        // notice here would contradict the transcript beside it.
        return { status: "superseded" };
      case "cancelled": {
        const message = "Reloaded resources; the conversation could not be re-read";
        addNotice({ type: "error", message });
        return { status: "failed", message };
      }
      case "missing": {
        const message = "Reloaded resources; this conversation no longer exists";
        addNotice({ type: "error", message });
        return { status: "failed", message };
      }
      case "failed": {
        // Which failure it was is the read's own classification, so the sentence names the right recovery: a row that is
        // gone, a Backend that refused the read, and one that never answered are three different states.
        const message = read.failure.kind === "missing"
          ? "Reloaded resources; this conversation no longer exists"
          : read.failure.kind === "refused"
            ? "Reloaded resources; the conversation could not be re-read"
            : "Reloaded resources; the conversation could not be reached";
        addNotice({ type: "error", message });
        return { status: "failed", message };
      }
      case "accepted": {
        const resources = reloaded.resources;
        if (resources?.pending) {
          const message = "Reloaded resources; the new catalog applies to the next run";
          addNotice({ message });
          return { status: "reloaded", message };
        }
        const message = resources
          ? `Reloaded ${resources.skills ?? 0} skills and ${resources.prompts ?? 0} prompts`
          : "Reloaded session resources";
        addNotice({ message, type: "success" });
        return { status: "reloaded", message };
      }
    }
  }, [addNotice, conversation, fromCurrentConnection, loadSession]);

  const handleBuiltinSlashCommand = useCallback(async (text: string): Promise<BuiltinSlashCommandResult> => {
    if (!text.startsWith("/")) return { handled: false };
    const match = text.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/);
    if (!match) return { handled: false };

    const [, commandName, rawArgs = ""] = match;
    const args = rawArgs.trim();
    const sid = sessionIdRef.current ?? await ensureNewSession();
    const complete = (result: BuiltinSlashCommandResult): BuiltinSlashCommandResult => {
      if (!result.handled) return result;
      if (result.error) {
        addNotice({ type: "error", message: result.error });
      } else if (!result.action) {
        // A command that opens a panel says nothing: the panel is the answer.
        addNotice({ type: "success", message: result.message ?? "Command completed" });
      }
      return result;
    };

    try {
      switch (commandName) {
        case "reload": {
          if (!sid) return complete({ handled: true, error: "No active session to reload" });
          // The same operation Settings › General asks for, so the command and the panel cannot disagree about what a
          // reload established: one owner asks the route, performs the read and states the outcome. This surface only
          // adds the catalogue the command line also shows; a reload that failed says so and nothing here claims it.
          // The operation states the outcome, once, in the notice that is the surface's report of it. This case
          // therefore returns the result without asking `complete` to state it a second time: the command line's job
          // is the catalogue the command also shows, and `error` here only tells the composer not to clear its text.
          const outcome = await reloadResources(sid);
          if (outcome.status === "superseded") return { handled: true };
          if (outcome.status === "failed") return { handled: true, error: outcome.message };
          await Promise.all([loadTools(sid), loadSlashCommands(), loadModels()]);
          return { handled: true, message: outcome.message };
        }

        case "mcp": {
          // Only a bare /mcp, and only when pi's built-in MCP extension owns it or
          // nothing does (lib/mcp-command.ts): another extension's /mcp is sent as
          // before, and so is every subcommand, since `/mcp login`, `logout` and
          // `reconnect` act on this session's own connections. Returning before
          // onSend leaves no "/mcp" bubble and no sidebar row for a new chat; a
          // streaming run is not touched.
          if (args || !onOpenSettings) return { handled: false };
          const commands = await slashCommandsForMcp();
          if (!commands || !bareMcpOpensSettings(commands)) return { handled: false };
          onOpenSettings("mcp");
          return complete({ handled: true, action: "openSettings" });
        }

        default:
          return { handled: false };
      }
    } catch (e) {
      return complete({ handled: true, error: e instanceof Error ? e.message : String(e) });
    }
  }, [addNotice, conversation, ensureNewSession, loadModels, loadSlashCommands, loadTools, promoteNewSession, onOpenSettings, reloadResources, slashCommandsForMcp]);

  // Let AgentSession.prompt decide atomically whether to queue against the
  // current run or start a new turn if it settled while the request was in
  // flight. Direct steer/followUp calls can strand a message in an idle queue.
  const sendStreamingPrompt = useCallback(async (
    message: string,
    behavior: "steer" | "followUp",
    images?: AttachedImage[],
  ) => {
    // A queued turn is refused by the same rule as an idle one, and just as early: a steer or a follow-up never reaches
    // staging or the wire with a draft the host does not serve, whatever key the composer sent it from.
    if (refuseShellCommandDraft(message, images)) return;
    const sid = sessionIdRef.current;
    const restore = () => restoreSubmission(message, images, composerDraftKey);
    if (!sid) {
      restore();
      addNotice({ type: "error", message: "No active session for the queued message" });
      return;
    }
    const piImages = images?.map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mimeType }));
    // A turn sent while the conversation is busy is a submission like any other: it is queued rather than committed, so
    // it has no entry to be recognised by and its own requestId is what the surface and the backend both know it by.
    // Staging it here is what lets a later terminal frame — a recall, an abort, or the answer it eventually gets —
    // settle this turn by name instead of the surface watching it vanish from the outstanding set.
    const requestId = createRequestId();
    fold({
      kind: "stage",
      requestId,
      content: { text: message, ...(images?.length ? { images: images.map((img) => ({ data: img.data, mimeType: img.mimeType })) } : {}) },
      whenBusy: behavior,
    });
    const acquisition = beginRead();
    try {
      // The images go to the wire as well as into the staged turn: a draft is admitted with the content the user made
      // it of, so what the surface shows queued and what the conversation eventually places are the same submission.
      const queued = await conversation.send(sid, {
        requestId,
        text: message,
        queueOnly: true,
        whenBusy: behavior,
        ...(piImages === undefined || piImages.length === 0 ? {} : { images: piImages }),
      });
      if (queued.submissionId !== undefined) fold({ kind: "receipt", conversationId: sid, requestId, submissionId: queued.submissionId });
    } catch (e) {
      console.error("Failed to submit streaming prompt:", e);
      // A transport failure after dispatch is ambiguous: the server may have accepted the queued prompt before the
      // response was lost, so the turn stays and is looked up by its own request id rather than resent.
      if (isRefusal(e)) {
        // The refusal's own notice restores the staged text and images; restoring beside it is what duplicates them.
        fold({ kind: "refusal", conversationId: sid, requestId, reason: e instanceof Error ? e.message : String(e) });
      } else {
        fold(unavailableStatement(acquisition, e instanceof Error ? e.message : String(e), requestId).input);
      }
    }
  }, [addNotice, beginRead, composerDraftKey, fold, refuseShellCommandDraft, restoreSubmission]);


  const handleSteer = useCallback(async (message: string, images?: AttachedImage[]) => {
    await sendStreamingPrompt(message, "steer", images);
  }, [sendStreamingPrompt]);

  const handlePromptWithStreamingBehavior = useCallback(async (
    message: string,
    behavior: "steer" | "followUp",
    images?: AttachedImage[],
  ) => {
    await sendStreamingPrompt(message, behavior, images);
  }, [sendStreamingPrompt]);

  const handleFollowUp = useCallback(async (message: string, images?: AttachedImage[]) => {
    await sendStreamingPrompt(message, "followUp", images);
  }, [sendStreamingPrompt]);

  /**
   * Edit one queued item. The item's own content token travels with the request, so the backend refuses an edit whose
   * text revision is stale and answers with the **current** item: a conflict is shown as what the newer decision was
   * rather than as a bare failure, and the newer decision stands (spec D09, A11).
   *
   * The queue is not written locally. The answer's item and the frame that follows it are the only statements about
   * what the queue holds, so a refused edit cannot leave text on screen the host never stored.
   */
  const handleEditItem = useCallback(async (submissionId: string, contentToken: string, content: string): Promise<{ ok: true } | { ok: false; reason: string; code?: string; current?: QueuedItemProjection }> => {
    const sid = sessionIdRef.current;
    if (!sid) return { ok: false, reason: "No active session" };
    try {
      const edited = await api.control(sid).editItem(submissionId, { contentToken, content });
      if (!edited.ok) {
        // The conflict carries the current item, which the surface shows; every other refusal is stated as its reason.
        // The Backend's own code travels beside it, because the *kind* of refusal is what the surface acts on — an item
        // the runtime already placed reads differently from an edit that merely failed and can be retried.
        const current = (edited.kind === "refused" ? edited.body.item : undefined) as QueuedItemProjection | undefined;
        if (current !== undefined) setQueuedItems((previous) => previous.map((item) => item.submissionId === current.submissionId ? current : item));
        return { ok: false, reason: operationFailure(edited).message, ...(edited.kind === "refused" && edited.code !== "" ? { code: edited.code } : {}), ...(current === undefined ? {} : { current }) };
      }
      if (edited.value.item !== undefined) setQueuedItems((previous) => previous.map((item) => item.submissionId === edited.value.item!.submissionId ? edited.value.item! : item));
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : String(e) };
    }
  }, []);

  /**
   * Cancel one queued item through the backend's own native abort. A cancel is idempotent, so a retry after a lost
   * answer reports the same outcome; the queue the next frame states is what removes the row, not a local guess.
   */
  const handleCancelItem = useCallback(async (submissionId: string): Promise<{ ok: boolean; reason?: string; code?: string }> => {
    const sid = sessionIdRef.current;
    if (!sid) return { ok: false, reason: "No active session" };
    try {
      const cancelled = await api.control(sid).cancelItem(submissionId);
      if (!cancelled.ok) return { ok: false, reason: operationFailure(cancelled).message, ...(cancelled.kind === "refused" && cancelled.code !== "" ? { code: cancelled.code } : {}) };
      setQueuedItems((previous) => previous.filter((item) => item.submissionId !== submissionId));
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : String(e) };
    }
  }, []);

  /**
   * The user's explicit Continue. It is the one thing that ends their own stop, and it carries no input: an empty
   * continue consumes the held queue under the conversation's configured mode and appends no user message. A
   * `stopping` answer means the old stop's ordinary scope still drains, so the hold and every queued item stay and the
   * caller retries with a **new** request id — the previous one is a durable receipt that already recorded that answer.
   */
  const handleContinue = useCallback(async (): Promise<"resumed" | "stopping" | "allowed" | "failed"> => {
    const sid = sessionIdRef.current;
    if (!sid) return "failed";
    try {
      const result = await api.control(sid).continueRun(createRequestId());
      // A refusal is the Backend's own answer about this continue, so it reads as a failed resume rather than as one
      // of the three outcomes the hold can state.
      return result.ok && result.value.status !== "rejected" ? result.value.status : "failed";
    } catch (e) {
      console.error("Failed to continue:", e);
      addNotice({ type: "error", message: "Could not continue: " + (e instanceof Error ? e.message : String(e)) });
      return "failed";
    }
  }, [addNotice]);

  const handleRecallQueue = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    try {
      // The backend withdraws the queued inputs from the conversation's own inbox and returns their text. Only after
      // it answers is the local queue cleared: a refused recall leaves the messages queued on the host, so clearing
      // here first would show an empty queue while they are still about to run.
      const result = await api.control(sid).recallQueue();
      if (!result.ok) throw operationFailure(result);
      setQueuedMessages({ steering: [], followUp: [] });
      const texts = [...result.value.steering, ...result.value.followUp];
      if (texts.length > 0) {
        opts.chatInputRef?.current?.prependText(texts.join("\n\n"));
      }
    } catch (e) {
      console.error("Failed to recall queued messages:", e);
      // The reason, not just the fact: the queued messages are still queued, and a bare "failed" leaves the user
      // unable to tell that from an empty queue.
      addNotice({ type: "error", message: "Failed to recall queued messages: " + (e instanceof Error ? e.message : String(e)) });
    }
  }, [opts.chatInputRef, addNotice]);

  const handleThinkingLevelChange = useCallback(async (level: ThinkingLevelOption) => {
    if (level === "auto") {
      thinkingLevelOverrideRef.current = null;
      setNewSessionThinkingLevel(null);
      setCurrentThinkingOverride(null);
      return;
    }
    if (isNew) {
      thinkingLevelOverrideRef.current = level;
      setNewSessionThinkingLevel(level);
    } else {
      setCurrentThinkingOverride(level);
    }
    const sid = sessionIdRef.current ?? await ensuringNewSessionRef.current;
    if (!sid) return;
    try {
      await api.updateSettings(sid, { thinkingLevel: level });
      // The pick the user made stays the displayed override until the conversation's own accepted statement confirms it
      // (or until the read that follows a switch replaces it); clearing it here would fall back to the older window
      // before the runtime's answer had arrived.
    } catch (e) {
      console.error("Failed to set thinking level:", e);
      setCurrentThinkingOverride(null);
    }
  }, [isNew]);

  /**
   * Adopt the pending turns of the conversation now on screen. A send belongs to the conversation it was made in, so a
   * different conversation adopts its own set — normally empty — and never inherits another one's. A fresh composer
   * becomes a real session while the chat remounts, and that is the same conversation, so its staged turns are read
   * back from the store instead of being taken off the screen. The store is in memory only.
   */
  useEffect(() => {
    // The composer is addressed by its session once it has one and by its provisional draft key until then, the same
    // way its draft is; a remount during promotion therefore lands on the same key it sent under, so the staged turns
    // are read back from the store instead of being taken off the screen.
    const composerKey = session?.id ?? newSessionDraftKey;
    if (composerKey === null) return;
    pendingConversationRef.current = composerKey;
    const stored = readProjection(scope, composerKey);
    if (stored === null) return;
    stepRef.current = stored;
    setStep(stored);
  }, [scope, session?.id, newSessionDraftKey]);

  // Load the conversation, and re-load it when the connection is replaced.
  //
  // The dependency is the **connection**, not the conversation id: a switch replaces the client and its conversation API,
  // and the same conversation id in another connection is another conversation. Re-running on the connection is what
  // makes the surface read the conversation it is now showing rather than keep the window the replaced connection
  // answered with — and the read that runs is fenced against the connection that asked for it, so the replaced one's
  // answer cannot land on top of it.
  useEffect(() => {
    sessionHookMountedRef.current = true;
    // Usage reads started before a remount are stale.
    contextUsageAppliedIdRef.current = contextUsageRequestIdRef.current;

    if (session) {
      sessionIdRef.current = session.id;
      // The projection is the authority on readiness: a complete projection on either transport leaves Loading, and the
      // remembered view this mount adopted states the same value rather than a second gate. It is history only — no
      // streaming, queue or run state — and the read below replaces it with the conversation's own statement.
      const acquisition = beginRead();
      // Joining a conversation whose projection still has turns waiting asks about each of them by the identity it was
      // sent under. A stream this page already holds delivers no fresh connection event to a new reader, so joining is
      // its own reason to ask — and it is asked under this mount's own acquisition, because a read that begins after a
      // recovery would fence the recovery's answers as older callbacks.
      if (hasUnfinishedWork(stepRef.current.view)) fold({ kind: "recover", acquisition });
      loadSession(session.id, true, { force: true, acquisition }).then((read) => {
        // Only an accepted read states composer state: every other outcome is the fold's or the transport's own statement
        // about the conversation, and a mount resuming a run from one of those would act on an answer the surface refused.
        if (read.status !== "accepted" || read.agentState === null) return;
        const agentState = read.agentState;
        if (agentState.running) {
          loadTools(session.id);
          if (agentState.state.isStreaming || agentState.state.isPromptRunning) {
            setAgentPhase(agentState.state.isStreaming ? { kind: "waiting_model" } : { kind: "running_command" });
            dispatch({ type: "resume" });
          }
        }
        if (agentState.state.systemPrompt !== undefined) setSystemPrompt(agentState.state.systemPrompt ?? null);
        if (agentState.state.extensionStatuses !== undefined) setExtensionStatuses(agentState.state.extensionStatuses ?? []);
        if (agentState.state.extensionWidgets !== undefined) setExtensionWidgets(agentState.state.extensionWidgets ?? []);
      });
    }
    return () => {
      sessionHookMountedRef.current = false;
      // The composer's unsent text is not this cleanup's to delete. Leaving a fresh composer is a move the selection
      // performs — it parks the draft under the folder's own key — and a connection replacement or an unmount is not a
      // statement that the reader abandoned what they typed. Deleting here made both lose the text.
      // Persist the settled view of the outgoing session so switching back can
      // restore it instantly. Only when the cached window still covers every
      // entry the UI has loaded (paged-in history included).
      const sid = sessionIdRef.current;
      // The readout is the one value the last render published, so what is cached is exactly the window and the pages
      // it was showing — never a piece of state read through a ref that could be a render behind it.
      const current = readoutRef.current;
      const currentData = current.session;
      if (sid && currentData && currentData.sessionId === sid && currentData.snapshotRevision) {
        const settled = stepRef.current.view;
        const settledEntryIds = settled.data?.entries.map((entry) => entry.id) ?? [];
        setSessionViewSnapshot(scope, {
          sessionId: sid,
          revision: currentData.snapshotRevision,
          historyHead: currentData.historyHead ?? null,
          messages: [...settled.messages],
          entryIds: settledEntryIds,
          leafId: activeLeafIdRef.current,
          oldestEntryId: settledEntryIds[0] ?? null,
          hasMore: current.hasMore,
          thinkingLevel: currentData.context.thinkingLevel,
          model: currentData.context.model,
          stats: currentData.stats,
          loadedEntryIds: settledEntryIds,
          // The prefix is the half of the transcript the projection's own window does not carry, so it has to be stated
          // here or switching back loses the pages the reader had loaded.
          prefixEntryIds: [...(current.prefix?.entryIds ?? [])],
          prefixMessages: [...(current.prefix?.messages ?? [])],
          prefixHistoryHead: current.prefix?.historyHead ?? null,
        });
      }
      closeEvents();
    };
    // The mount reads once per connection. Everything else this effect holds — the session prop, the projection it
    // restored — is captured as it was on that mount, which is what a Strict Mode replay and a promotion remount both
    // rely on; the connection is the one input that makes a replay a different lifetime rather than the same one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversation]);

  useEffect(() => {
    onSystemPromptChange?.(systemPrompt);
  }, [systemPrompt, onSystemPromptChange]);

  useEffect(() => {
    onSystemInfoLoaderChange?.(loadSystemInfo);
    return () => onSystemInfoLoaderChange?.(null);
  }, [loadSystemInfo, onSystemInfoLoaderChange]);

  /**
   * This conversation's explicit reload, registered for the surfaces that ask for one without being the chat — Settings ›
   * General reloads the runtime's resources, and what follows is this conversation's own read.
   *
   * It is one operation rather than a remount: the surface asking does not know a session key, a mount counter or an
   * attachment, and nothing is rebuilt — the accepted window, the stream this surface holds and the reader's place in it
   * all stay. A reload during a run is deferred by the Backend, and its answer says so.
   *
   * It is the whole operation, so the Backend's reload route is asked **here** and nowhere else: the surface that
   * triggered it (Settings › General) states that the tools configuration changed, and this performs the reload, the read
   * and the notice. A caller that reloaded and then asked this would ask for the same reload twice.
   *
   * What the notice claims is what the **read** stated, not what the reload route answered. A read that answered and was
   * accepted is a reload this conversation has picked up, and the resources it names are the ones it named; a read that
   * failed is stated as a failure rather than dressed up as a success. A read the fold refused, or one whose answer was
   * superseded, publishes nothing here: the surface has moved on and claims nothing either.
   */
  const onConversationReloadChange = opts.onConversationReloadChange;
  const reloadConversation = useCallback(async (): Promise<ReloadOutcome> => {
    const sid = sessionIdRef.current;
    // A surface with no conversation on screen has nothing to reload, and says so rather than reporting a success.
    if (sid === null) return { status: "superseded" };
    // The same operation the command line asks for, and its outcome is passed through: the caller reads what the
    // operation established instead of inferring it from a promise that resolved.
    return await reloadResources(sid);
  }, [reloadResources]);
  useEffect(() => {
    onConversationReloadChange?.(reloadConversation);
    return () => onConversationReloadChange?.(null);
  }, [onConversationReloadChange, reloadConversation]);

  /**
   * This composer's catalog read with its bounded retry: one operation, so a mount, an explicit retry and a change this
   * page applied all ask the deployment the same way.
   *
   * The retry loop is not a second policy beside this read — it *is* this function, which is why a re-read retries on
   * the same delays the first read does. Each attempt ends on an answer, on the connection going away, or on the
   * caller's own controller; nothing here decides what the surface holds.
   */
  const readModels = useCallback(async (signal: AbortSignal) => {
    for (let attempt = 0; ; attempt++) {
      try {
        await loadModels(signal);
        return;
      } catch {
        // The read this loop waits on is the connection's, so the only aborts that end this load are this consumer's
        // own and the connection's own going away. Another consumer's exit retires nothing here, and the next ask may
        // still be answered.
        if (signal.aborted || client.disposed) return;
        if (attempt >= MODELS_RETRY_DELAYS_MS.length) return;
        await delay(MODELS_RETRY_DELAYS_MS[attempt]);
        if (signal.aborted || client.disposed) return;
      }
    }
  }, [client, loadModels]);

  /**
   * The read a mounted composer re-runs when a model-domain change says what it holds is old.
   *
   * It lives under the mount's own controller, so the same teardown that retires the first read retires a re-read too;
   * a composer that went away re-reads nothing, which is also what makes a change on a page with no mounted reader cost
   * no request. The re-read asks the deployment because the change invalidated the page's cache; what it must never do
   * is move the conversation onto another model, so nothing here writes a selection — the catalog arrives and the picker
   * offers what it now holds.
   */
  const catalogRefreshRef = useRef<() => void>(() => {});
  const retryModels = useCallback(() => catalogRefreshRef.current(), []);

  // Load the model list with bounded retries; loadModels exposes each failure.
  useEffect(() => {
    const controller = new AbortController();
    catalogRefreshRef.current = () => { void readModels(controller.signal); };
    void readModels(controller.signal);
    return () => {
      controller.abort();
      catalogRefreshRef.current = () => {};
    };
  }, [readModels]);

  // A `models.json` save the Backend applied, a stored or removed credential, and an `enabledModels` write each state
  // their change through the catalog's own rule; this is the reader half, so a composer on screen shows the list the
  // change produced instead of waiting for Settings to close.
  useEffect(() => subscribeModelCatalog(() => catalogRefreshRef.current()), []);

const thinkingLevel: ThinkingLevelOption = displayThinkingLevel ?? "auto";

  return {
    // State
    data, loading, error, readFailure, activeLeafId, messages, pendingSubmissions, outstandingSubmissions, activeToolResults, entryIds, historyCursor, hasEarlierMessages, streamState,
    agentRunning, modelNames, modelList, modelError, modelScopeWarnings, modelThinkingLevels, modelThinkingLevelMaps, newSessionModel, thinkingLevel, runFailure,
    contextUsage, systemPrompt, forkingEntryId,
    currentModel, displayModel, modelSwitching, sessionStats,
    slashCommands, slashCommandsLoading, queuedMessages, queuedItems, control,
    notices, extensionStatuses, extensionWidgets,
    isAutoModelSelection: isNew && newSessionModel === null,
    isAutoThinkingSelection: isNew && newSessionThinkingLevel === null,
    statusPhase,
    isNew,
    /** How many turns this surface itself staged: the viewport's one cue from the conversation (spec R4). */
    ownSends,
    // Refs
    sessionIdRef,
    // Actions
    handleSend, handleAbort, handleFork, handleModelChange,
    handleSteer, handleFollowUp, handlePromptWithStreamingBehavior,
    handleRecallQueue, handleEditItem, handleCancelItem, handleContinue,
    handleBuiltinSlashCommand,
    addNotice, dismissNotice,
    handleThinkingLevelChange, loadTools, loadSlashCommands, loadContext, landWindow,
    retryRead, dismissReadFailure,
    // The catalog's own recovery: re-read the deployment, changing no selection and resending nothing.
    retryModels,
  };
}
