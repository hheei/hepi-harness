import type { ChildRecoveryFacts, ConversationControlState, ControlReceipt, ConversationInfo, ConversationReference, QueuedItemProjection, ResolvedReference } from "@hepi/protocol";

/**
 * The named control, queue, fork and relation operations one conversation offers, over the client ingress.
 *
 * This is the caller's interface, not a transport: it decides nothing about a conversation. Every durable fact — the
 * control revision, the receipt a request id names, the queued item, the branch, the reference, the tombstone — is the
 * Backend's, and each operation is one request to it. Nothing here keeps a second copy of that state, schedules a
 * retry, or infers "busy" from an answer: a surface reads the conversation's own frames and this module only performs
 * the request the user made.
 *
 * The one decision this module does own is the difference between an answer it has and one it does not. A definitive
 * refusal carries the Backend's own status and code. A response that never arrived — a dropped connection, a timeout, a
 * 5xx from the hop in front of the Backend, a body this build cannot read — is `unknown`, with the request id the
 * attempt was made under, and it is **never retried here**: a lost write may have committed, and the only honest
 * resolution is to ask the conversation about that request id, which `control(requestId)` does. That is the same rule
 * a pending submission already follows, so one conversation does not have two vocabularies for a lost answer.
 */

/** What one operation's answer is: a value, a refusal the Backend stated, or an outcome this caller cannot establish. */
export type OperationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly kind: "refused"; readonly status: number; readonly code: string; readonly message: string; readonly body: Record<string, unknown> }
  | { readonly ok: false; readonly kind: "unknown"; readonly requestId: string; readonly reason: string };

/** The stop answer: the outcome, whether the ordinary scope still drains, and the durable receipt it committed. */
export type StopAnswer = {
  readonly status: "accepted" | "held" | "rejected";
  readonly reason?: string;
  readonly drain: "idle" | "stopping";
  readonly control: ConversationControlState;
  readonly receipt: ControlReceipt;
};

/** The resume answer; `stopping` keeps the hold and every queued input, and the caller retries with a new request id. */
export type ContinueAnswer = {
  readonly status: "resumed" | "stopping" | "allowed" | "rejected";
  readonly reason?: string;
  readonly control: ConversationControlState;
  readonly receipt: ControlReceipt;
  readonly submissionId?: string;
};

/** One conversation's control record, and the receipt of one request id when there is one. */
export type ControlAnswer = { readonly control: ConversationControlState; readonly receipt: ControlReceipt | null };

/** One admission: the submission it was made as, the control it was admitted under, and a resume answer when there was one. */
export type SendAnswer = {
  readonly submissionId?: string;
  readonly control: ConversationControlState;
  readonly status?: "resumed" | "stopping" | "allowed" | "rejected";
  readonly reason?: string;
};

/** A branch: the new conversation's identity and its catalogue row, as the Backend stated them. */
export type ForkAnswer = { readonly conversationId: string; readonly conversation: { readonly id: string } & Record<string, unknown> };

/**
 * One delegation, as the Backend answered it. It is one operation with two outcomes, and they answer different
 * identities: a quick create names the **child** it made, while a dispatch to a conversation that already exists names
 * that **target**, because nothing was created. `conversationId` is the conversation the task is for in both cases and
 * `childConversationId` is present only when this request created one — which is exactly what `created` states, and
 * what a retry reads to tell the child it made from the child an earlier attempt made.
 */
export type DelegateAnswer = {
  /** The conversation the task is for: the child this request created, or the existing target a dispatch addressed. */
  readonly conversationId: string;
  readonly childConversationId?: string;
  readonly dispatchId: string;
  readonly requestId: string;
  readonly created: boolean;
  /** The admission a dispatch made into its target; absent when this request created the child it names. */
  readonly submissionId?: string;
  readonly definition?: string;
  readonly displayParentId?: string;
  readonly conversation?: { readonly id: string } & Record<string, unknown>;
};

/**
 * One delegation answer, read from the wire into the shape above.
 *
 * The two outcomes state their identity under different names — a create answers `childConversationId`, a dispatch
 * answers `conversationId` — so this is where the difference is read once instead of being left for every caller to
 * guess. An answer that names neither is no delegation identity at all: the write may have committed and this caller
 * cannot say what it committed, so it is reported as an unknown outcome for its own request id rather than as a value
 * with a missing field.
 */
function readDelegateAnswer(body: Record<string, unknown>, requestId: string): OperationResult<DelegateAnswer> {
  const dispatchId = body.dispatchId;
  const named = typeof body.childConversationId === "string" ? body.childConversationId : typeof body.conversationId === "string" ? body.conversationId : undefined;
  if (typeof dispatchId !== "string" || named === undefined) {
    return { ok: false, kind: "unknown", requestId, reason: "the Backend answered no delegation identity" };
  }
  return {
    ok: true,
    value: {
      conversationId: named,
      ...(typeof body.childConversationId === "string" ? { childConversationId: body.childConversationId } : {}),
      dispatchId,
      requestId: typeof body.requestId === "string" ? body.requestId : requestId,
      created: body.created === true,
      ...(typeof body.submissionId === "string" ? { submissionId: body.submissionId } : {}),
      ...(typeof body.definition === "string" ? { definition: body.definition } : {}),
      ...(typeof body.displayParentId === "string" ? { displayParentId: body.displayParentId } : {}),
      ...(typeof body.conversation === "object" && body.conversation !== null ? { conversation: body.conversation as { readonly id: string } & Record<string, unknown> } : {}),
    },
  };
}

/**
 * One child's recovery facts, read from the wire into the protocol's shape.
 *
 * Only the identity is required: `requestId` is the dispatch identity and one of the two values a preparation retry
 * takes, so an answer that names none states nothing a caller could ask about again and is reported as an outcome this
 * caller does not have. Every other field is passed through **as the Backend stated it** — the runtime's own phase and
 * delivery words, its own reason strings — rather than narrowed to a union this build happens to know, because a state
 * the runtime adds is a fact to show, not a reason to lose the rest of the answer.
 */
function readRecoveryFacts(value: unknown): ChildRecoveryFacts | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const body = value as Record<string, unknown>;
  if (typeof body.requestId !== "string" || body.requestId === "") return undefined;
  const text = (key: string): string | undefined => (typeof body[key] === "string" ? body[key] as string : undefined);
  return {
    requestId: body.requestId as string,
    ...(text("definition") === undefined ? {} : { definition: text("definition") }),
    ...(text("anchorTaskId") === undefined ? {} : { anchorTaskId: text("anchorTaskId") }),
    ...(text("reporterTaskId") === undefined ? {} : { reporterTaskId: text("reporterTaskId") }),
    ...(text("preparationStrategy") === undefined ? {} : { preparationStrategy: text("preparationStrategy") }),
    ...(text("preparation") === undefined ? {} : { preparation: text("preparation") as ChildRecoveryFacts["preparation"] }),
    ...(text("preparationFailedTaskId") === undefined ? {} : { preparationFailedTaskId: text("preparationFailedTaskId") }),
    ...(text("preparationRetriedTaskId") === undefined ? {} : { preparationRetriedTaskId: text("preparationRetriedTaskId") }),
    ...(text("preparationError") === undefined ? {} : { preparationError: text("preparationError") }),
    ...(text("preparationOutcome") === undefined ? {} : { preparationOutcome: text("preparationOutcome") }),
    ...(text("anchorPhase") === undefined ? {} : { anchorPhase: text("anchorPhase") as ChildRecoveryFacts["anchorPhase"] }),
    ...(text("delivery") === undefined ? {} : { delivery: text("delivery") as ChildRecoveryFacts["delivery"] }),
    ...(text("childSubmissionStatus") === undefined ? {} : { childSubmissionStatus: text("childSubmissionStatus") as ChildRecoveryFacts["childSubmissionStatus"] }),
    ...(text("childSubmissionReason") === undefined ? {} : { childSubmissionReason: text("childSubmissionReason") }),
  };
}

/**
 * One child of a subtree request, as the Backend answered it.
 *
 * The halves state two different facts about the same conversation and neither is the other: `status` (with the
 * runtime's own `reason`) is the **durable outcome** the request recorded when it reached that child, `control` is the
 * child's committed control now, and `session` is the child's **current** catalogue row — the same row
 * `GET /api/conversations` lists for it. A surface that showed only the first would keep saying `stopping` after the
 * child drained; one that showed only the last would hide what the request actually did.
 *
 * The outcome name is passed through as the Backend states it: a status this build has no word for is a new outcome,
 * not a reason to lose the answer of a child that really did answer.
 */
export type SubtreeChildAnswer = {
  readonly conversationId: string;
  readonly status: string;
  readonly reason?: string;
  readonly control: ConversationControlState;
  /**
   * The child's own catalogue entry, absent exactly when the Backend states none: a removed child, or one this process
   * holds no attachment for, has no row any surface could show, and inventing one would claim a state nobody read.
   */
  readonly session?: { readonly id: string } & Record<string, unknown>;
};

/** The two explicit subtree actions. Neither escalates into the other, and neither is a conversation's own stop. */
export type SubtreeControlAction = "stop" | "interrupt";

/**
 * One subtree request, as the Backend states it: the set it captured, what each governed child answered, and whether
 * every child has an outcome yet. `pending` is not a failure — it is the state a replay resumes from.
 */
export type SubtreeAnswer = {
  readonly requestId: string;
  readonly action: SubtreeControlAction;
  readonly status: "completed" | "pending";
  /** The captured descendant ids, in the order the first request discovered them. */
  readonly scope: readonly string[];
  /** The selected subset, or `null` when the request governs the whole capture. */
  readonly selected: readonly string[] | null;
  readonly outcomes: readonly SubtreeChildAnswer[];
  /** True when at least one child did not simply end up controlled. */
  readonly partial: boolean;
};

/**
 * One subtree answer read off the wire.
 *
 * The identity a caller has to be able to ask about again is required, and so are the per-child outcomes — a flattened
 * answer would hide exactly the partial failure this operation exists to show. An answer missing either states nothing
 * about what its write committed, so it is reported as an unknown outcome under the attempt's own id rather than as a
 * value with a missing field.
 */
function readSubtreeAnswer(body: Record<string, unknown>, requestId: string): OperationResult<SubtreeAnswer> {
  const unknown = (reason: string): OperationResult<SubtreeAnswer> => ({ ok: false, kind: "unknown", requestId, reason });
  if (typeof body.requestId !== "string" || body.requestId === "") return unknown("the Backend answered no subtree request id");
  if (body.action !== "stop" && body.action !== "interrupt") return unknown("the Backend answered an unknown subtree action");
  if (!Array.isArray(body.outcomes)) return unknown("the Backend answered no per-child outcomes");
  const outcomes: SubtreeChildAnswer[] = [];
  for (const entry of body.outcomes as unknown[]) {
    const child = entry as Partial<SubtreeChildAnswer> | null;
    if (child === null || typeof child.conversationId !== "string" || typeof child.status !== "string") return unknown("a child outcome arrived unreadable");
    const control = child.control;
    if (control === undefined || typeof control.revision !== "number") return unknown("a child outcome stated no committed control");
    outcomes.push({
      conversationId: child.conversationId,
      status: child.status,
      ...(typeof child.reason === "string" ? { reason: child.reason } : {}),
      control,
      ...(typeof child.session === "object" && child.session !== null ? { session: child.session as { readonly id: string } & Record<string, unknown> } : {}),
    });
  }
  return {
    ok: true,
    value: {
      requestId: body.requestId,
      action: body.action,
      status: body.status === "pending" ? "pending" : "completed",
      scope: Array.isArray(body.scope) ? (body.scope as readonly string[]) : [],
      selected: Array.isArray(body.selected) ? (body.selected as readonly string[]) : null,
      outcomes,
      partial: body.partial === true,
    },
  };
}



export type ConversationControlOptions = {
  readonly conversationId: string;
  /** The ingress's conversation path: `<origin>/api/conversations`. */
  readonly basePath: string;
  /** The one fetch this client performs its requests with. It carries the caller's identity; this module never does. */
  readonly fetch: (input: string, init?: RequestInit) => Promise<Response>;
};

/** The operation surface of one conversation. */
export type ConversationControl = {
  stop(requestId: string, options?: { readonly expectedControlRevision?: number }): Promise<OperationResult<StopAnswer>>;
  continueRun(requestId: string, options?: { readonly expectedControlRevision?: number; readonly text?: string; readonly whenBusy?: "steer" | "followUp" }): Promise<OperationResult<ContinueAnswer>>;
  /** The committed control, and the durable receipt of one request id — the read that resolves a lost answer. */
  control(requestId?: string): Promise<OperationResult<ControlAnswer>>;
  /**
   * One admission under the conversation's own control rule. `queueOnly` enqueues without resuming a held conversation.
   * `images` travel as the protocol's own native content blocks beside the text, exactly as the submission route reads
   * them, so an image submission is one admission with one request id and not a second write — on a queue-only steer or
   * follow-up as much as on an ordinary send, because both are the same admission of the same content.
   */
  send(requestId: string, text: string, options?: { readonly whenBusy?: "steer" | "followUp"; readonly queueOnly?: boolean; readonly images?: readonly { readonly type: "image"; readonly data: string; readonly mimeType: string }[] }): Promise<OperationResult<SendAnswer>>;
  /** Withdraw every queued input and hand its text back, in queue order, for the composer to edit. */
  recallQueue(): Promise<OperationResult<{ readonly steering: readonly string[]; readonly followUp: readonly string[] }>>;
  /** The pending queue item by item: identity, mode, text, source and the token an edit is validated against. */
  items(): Promise<OperationResult<{ readonly items: readonly QueuedItemProjection[] }>>;
  /** Edit one queued item, conditional on the token the caller read. */
  editItem(submissionId: string, edit: { readonly contentToken: string; readonly content: string }): Promise<OperationResult<{ readonly status: string; readonly item?: QueuedItemProjection }>>;
  /** Cancel one queued item. `cancelled` and `already_cancelled` are both the same outcome asked for twice. */
  cancelItem(submissionId: string): Promise<OperationResult<{ readonly status: string }>>;
  /** Branch this conversation at an entry, under an identity a retry repeats. */
  fork(options: { readonly at?: string; readonly requestId: string }): Promise<OperationResult<ForkAnswer>>;
  /**
   * Delegate a task to an Agent Definition, or give a conversation that already exists one more task. The definition
   * decides the child's configuration and its context strategy; the request carries neither, so a quick create cannot
   * override that policy. The attempt identity is the caller's, so a retry after a lost answer is answered with the
   * child the first attempt made instead of a second one.
   */
  delegate(given: { readonly name: string; readonly task: string; readonly requestId: string; readonly conversationId?: string }): Promise<OperationResult<DelegateAnswer>>;
  /**
   * Stop or interrupt one conversation's **captured** descendant subtree — the explicit decision a conversation's own
   * stop never is, because a parent's stop stays local and reaches no child (spec decision 1).
   *
   * The Backend computes the descendant set from durable relations and captures it under this request id, so a retry is
   * answered from that capture and a child created since is never implicitly included. `selected` narrows the request to
   * a subset of the same capture and is refused whole when it names anything outside it; omitting it governs the whole
   * subtree. Nothing here truncates history, deletes a relation or cascades a removal, and each child answers its own
   * outcome so a partial result stays visible instead of being flattened into one status (spec decisions 3-5).
   */
  subtreeControl(given: { readonly requestId: string; readonly action: SubtreeControlAction; readonly selected?: readonly string[] }): Promise<OperationResult<SubtreeAnswer>>;
  /**
   * The durable record of one subtree request, read back under the id it was made under.
   *
   * This is the read that resolves a lost answer and the one that refreshes a race the caller lost: the recorded
   * outcomes do not move, and each child's current control and row state what it is doing now. It controls nothing and
   * records nothing. `null` is the Backend's own `unknown_request` — no request under that id captured anything — while
   * a conversation that does not exist or was removed stays a refusal, because those are statements about the
   * conversation rather than about the record.
   */
  subtreeRequest(requestId: string): Promise<OperationResult<SubtreeAnswer | null>>;
  /**
   * One delegated child's recovery facts, **per durable object**: the dispatch's preparation state, the anchor's phase
   * and where this dispatch's report stands (the audit's G2).
   *
   * It says nothing about the child's run — that is the catalogue row's `runStatus`, which this does not replace — and
   * `null` is the honest answer for a conversation that is no delegation's child: an ordinary conversation, or a branch
   * a user took from a child, whose own anchor carries no dispatch identity (spec D14).
   */
  recovery(): Promise<OperationResult<ChildRecoveryFacts | null>>;
  /**
   * Ask a delegated child's **failed context preparation** to be prepared again, under the identities this child's own
   * recovery read stated (the audit's G6).
   *
   * This is the retry the delegation seam already performs for a caller that replays its own delegation request: the
   * write names the existing dispatch/request identity and the failed attempt's own task id, so the parked anchor
   * prepares once more over the **same** child and the same dispatch, with no second admission, no fresh identity and no
   * fallback to a fresh context (spec D11, A14). Nothing is retried by itself and nothing running is aborted: a request
   * that names a different attempt than the record states is refused by name, and a failure already asked about answers
   * `already_retried`, which is asking twice as asking once.
   */
  retryPreparation(given: { readonly requestId: string; readonly failedTaskId: string }): Promise<OperationResult<ChildRecoveryFacts | null>>;
  /**
   * Record a structured reference from this conversation to another, idempotently by target plus entry.
   *
   * The Backend validates the target and the optional entry against the target's visible committed fork-aware history,
   * and a reference that could not be followed is refused with its named outcome — `target-missing`,
   * `target-unavailable`, `entry-missing` or `entry-out-of-scope` — as the refusal's own code, so a surface renders
   * the state it already knows rather than translating a message. Nothing is stored by a refused creation.
   */
  addReference(reference: ConversationReference): Promise<OperationResult<{ readonly references: readonly ResolvedReference[] }>>;
  /** One conversation's identity: relations, native record edges, references and effective configuration. */
  info(): Promise<OperationResult<ConversationInfo & { readonly conversation?: unknown }>>;
  /** Remove this conversation: the Backend writes its tombstone and its records stay readable. */
  remove(): Promise<OperationResult<{ readonly removed: boolean }>>;
  /** Rename this conversation. */
  rename(name: string): Promise<OperationResult<{ readonly name: string }>>;
};

/**
 * A status that states a refusal rather than a lost answer. A 4xx is the Backend saying no to this request; anything
 * else on a write may have committed, and a read that failed is not an outcome of a write at all.
 */
const refused = (status: number): boolean => status >= 400 && status < 500;

function messageOf(body: Record<string, unknown>, status: number): string {
  for (const key of ["error", "message"]) {
    const value = body[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return "the Backend answered " + status;
}

/** One request: an answer read as a value, a refusal the Backend stated, or an outcome this caller does not have. */
async function request<T>(
  options: ConversationControlOptions,
  path: string,
  init: { readonly method: string; readonly body?: unknown; readonly requestId?: string },
): Promise<OperationResult<T>> {
  let response: Response;
  try {
    response = await options.fetch(options.basePath + "/" + encodeURIComponent(options.conversationId) + path, {
      method: init.method,
      ...(init.body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(init.body) }),
    });
  } catch (error) {
    // The request never produced an answer. For a write that is exactly the state a retry must not resolve by
    // repeating it, so the caller is handed the request id it can ask about instead.
    return { ok: false, kind: "unknown", requestId: init.requestId ?? "", reason: error instanceof Error ? error.message : String(error) };
  }
  let body: Record<string, unknown> = {};
  try {
    const text = await response.text();
    body = text === "" ? {} : JSON.parse(text) as Record<string, unknown>;
  } catch (error) {
    // A body this build cannot read is an answer it does not have: a truncated or mangled write answer says nothing
    // about whether the write committed, so it is unknown rather than a refusal.
    return { ok: false, kind: "unknown", requestId: init.requestId ?? "", reason: error instanceof Error ? error.message : String(error) };
  }
  if (response.ok) return { ok: true, value: body as T };
  if (refused(response.status)) {
    // The refusal's own name is the Backend's vocabulary, whichever field it stated it in: a route that refuses with a
    // wire `code` and one that refuses with the `reason` its durable receipt recorded are both the reason this caller
    // reads, and neither is translated into a second name here.
    const code = typeof body.code === "string" && body.code !== "" ? body.code : typeof body.reason === "string" ? body.reason : "";
    return { ok: false, kind: "refused", status: response.status, code, message: messageOf(body, response.status), body };
  }
  return { ok: false, kind: "unknown", requestId: init.requestId ?? "", reason: messageOf(body, response.status) };
}

/** The operations of one conversation, over the caller's own fetch. */
export function createConversationControl(options: ConversationControlOptions): ConversationControl {
  return {
    stop: (requestId, given = {}) => request<StopAnswer>(options, "/stop", {
      method: "POST",
      requestId,
      body: { requestId, ...(given.expectedControlRevision === undefined ? {} : { expectedControlRevision: given.expectedControlRevision }) },
    }),
    continueRun: (requestId, given = {}) => request<ContinueAnswer>(options, "/continue", {
      method: "POST",
      requestId,
      body: {
        requestId,
        ...(given.expectedControlRevision === undefined ? {} : { expectedControlRevision: given.expectedControlRevision }),
        ...(given.text === undefined ? {} : { text: given.text }),
        ...(given.whenBusy === undefined ? {} : { whenBusy: given.whenBusy }),
      },
    }),
    control: (requestId) => request<ControlAnswer>(options, "/control" + (requestId === undefined ? "" : "?requestId=" + encodeURIComponent(requestId)), { method: "GET" }),
    // A queue-only admission is the composer's steer or follow-up: it enqueues and starts no run, and it never resumes
    // a held conversation, because staging a draft is not the user's decision to continue. It carries the same text and
    // images an ordinary send carries: the route decides what a busy conversation does with them, and this side never
    // drops an attachment the user made because of where it was queued.
    send: (requestId, text, given = {}) => given.queueOnly === true
      ? request<SendAnswer>(options, "/busy", { method: "POST", requestId, body: { requestId, text, mode: given.whenBusy === "steer" ? "steer" : "follow-up", ...(given.images === undefined || given.images.length === 0 ? {} : { images: given.images }) } })
      : request<SendAnswer>(options, "/messages", {
        method: "POST",
        requestId,
        body: {
          protocol: "hepi.v1",
          type: "conversation.submit",
          requestId,
          text,
          ...(given.whenBusy === undefined ? {} : { whenBusy: given.whenBusy }),
          ...(given.images === undefined || given.images.length === 0 ? {} : { images: given.images }),
        },
      }),
    recallQueue: () => request<{ readonly steering: readonly string[]; readonly followUp: readonly string[] }>(options, "/recall-queue", { method: "POST" }),
    items: () => request<{ readonly items: readonly QueuedItemProjection[] }>(options, "/items", { method: "GET" }),
    editItem: (submissionId, edit) => request<{ readonly status: string; readonly item?: QueuedItemProjection }>(options, "/items/" + encodeURIComponent(submissionId), { method: "PATCH", body: edit }),
    cancelItem: (submissionId) => request<{ readonly status: string }>(options, "/items/" + encodeURIComponent(submissionId), { method: "DELETE" }),
    fork: (given) => request<ForkAnswer>(options, "/fork", { method: "POST", requestId: given.requestId, body: { ...(given.at === undefined ? {} : { at: given.at }), requestId: given.requestId } }),
    // The answer's own shape decides what this operation returns, so a dispatch and a quick create are read at one seam
    // and neither leaves a caller to guess which identity it was handed.
    delegate: async (given) => {
      const answered = await request<Record<string, unknown>>(options, "/delegate", {
        method: "POST",
        requestId: given.requestId,
        body: {
          name: given.name,
          task: given.task,
          requestId: given.requestId,
          ...(given.conversationId === undefined ? {} : { conversationId: given.conversationId }),
        },
      });
      return answered.ok ? readDelegateAnswer(answered.value, given.requestId) : answered;
    },
    subtreeControl: async (given) => {
      const answered = await request<Record<string, unknown>>(options, "/subtree-control", {
        method: "POST",
        requestId: given.requestId,
        body: {
          requestId: given.requestId,
          action: given.action,
          ...(given.selected === undefined ? {} : { selected: [...given.selected] }),
        },
      });
      // A partial result is not a failure of the request: 202 carries every child's own outcome, so the answer is read
      // from the body rather than inferred from the status code.
      return answered.ok ? readSubtreeAnswer(answered.value, given.requestId) : answered;
    },
    subtreeRequest: async (requestId) => {
      const answered = await request<Record<string, unknown>>(options, "/subtree-control?requestId=" + encodeURIComponent(requestId), { method: "GET" });
      if (!answered.ok) {
        // The Backend's 404 with this code answers the question that was asked — no request under that id captured
        // anything — and says nothing went wrong reading it. Every other refusal, including an unknown or removed
        // conversation, stays a refusal, because those are statements about the conversation rather than about the
        // record.
        if (answered.kind === "refused" && answered.status === 404 && answered.code === "unknown_request") return { ok: true, value: null };
        return answered;
      }
      return readSubtreeAnswer(answered.value, requestId);
    },
    recovery: async () => {
      const answered = await request<Record<string, unknown>>(options, "/recovery", { method: "GET" });
      if (!answered.ok) return answered;
      // `null` is the Backend's own answer to the question: this conversation is no delegation's child. Anything else
      // that names no identity states nothing a caller could act on, so it stays an outcome rather than a value.
      if (answered.value.recovery === null) return { ok: true, value: null };
      const facts = readRecoveryFacts(answered.value.recovery);
      return facts === undefined ? { ok: false, kind: "unknown", requestId: "", reason: "the Backend answered no recovery identity" } : { ok: true, value: facts };
    },
    retryPreparation: async (given) => {
      const answered = await request<Record<string, unknown>>(options, "/recovery", {
        method: "POST",
        requestId: given.requestId,
        body: { requestId: given.requestId, failedTaskId: given.failedTaskId },
      });
      if (!answered.ok) return answered;
      const facts = readRecoveryFacts(answered.value.recovery);
      return facts === undefined ? { ok: false, kind: "unknown", requestId: given.requestId, reason: "the Backend answered no recovery identity" } : { ok: true, value: facts };
    },
    addReference: (reference) => request<{ readonly references: readonly ResolvedReference[] }>(options, "/references", { method: "POST", body: reference }),
    info: () => request<ConversationInfo & { readonly conversation?: unknown }>(options, "", { method: "GET" }),
    remove: () => request<{ readonly removed: boolean }>(options, "", { method: "DELETE" }),
    rename: (name) => request<{ readonly name: string }>(options, "", { method: "PATCH", body: { name } }),
  };
}
