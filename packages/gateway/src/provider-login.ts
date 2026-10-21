import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AuthContext, AuthEvent, AuthPrompt, Credential, Models, OAuthCredential, Provider } from "@earendil-works/pi-ai";
import type {
	ProviderAuthEvent,
	ProviderAuthPrompt,
	ProviderAuthStatus,
	ProviderLoginFailureCode,
	ProviderLoginForgetResult,
	ProviderLoginInfo,
	ProviderLoginPhase,
	ProviderLoginRequest,
	ProviderLoginResult,
} from "@hepi/protocol/gateway";
import { looksLikeSecretValue, SECRET_MASK } from "@hepi/protocol/mcp-secrets";
import { builtinProviderCatalog, ProviderAuthFileError, ProviderAuthLockError, type ProviderAuthService, type ProviderCatalogEntry } from "./provider-auth.ts";
import { ProviderFileCredentialStore } from "./provider-credential-store.ts";

/**
 * A provider sign-in, driven by the flows `@earendil-works/pi-ai` already implements.
 *
 * Nothing in this file is an OAuth engine. Upstream's own `models.login(providerId, "oauth", interaction)` runs a
 * provider's device-code, browser, copy-code and prompt/select steps; this service contributes the two things a headless
 * host needs to run one: an `interaction` whose `prompt()` waits for an answer that arrives later from a client, and a
 * credential store that is this host's `auth.json`. The protocol logic stays upstream — `provider-auth.ts` says the same
 * about API keys, and the reason a sign-in deserves its own file is that a flow is a *queue of questions with a lifetime*,
 * which the request-scoped listing does not have.
 *
 * A flow outlives the request that started it, deliberately: a person signs in in another browser, sometimes on another
 * machine, and the tab that started the flow can be gone by the time the credential lands. Its work therefore belongs to
 * this host, bounded by `ttlMs`, and is ended by an explicit cancel, by that deadline, or by this service stopping — not
 * by a socket closing. This is the one provider operation whose lifetime is not the caller's; the API-key path keeps the
 * request-bound behaviour, because a key that arrives in a body has no reason to outlive the request that carried it.
 *
 * What leaves this host is the flow's state: the question it is asking, the address it told a person to open, and at the
 * end the listing. An answer a caller typed is never returned to anyone, and every message this surface publishes is
 * masked against the answers that flow was given and the token it produced, because an upstream flow error can quote the
 * value it choked on. A finished flow's credential is in the file and is held nowhere here.
 */

/** How long one flow may keep asking. Long enough for a phone and a browser; nothing waits past this. */
export const PROVIDER_LOGIN_TTL_MS = 15 * 60_000;

/** How long an ended flow stays readable, so a poll that arrives late learns the outcome instead of a lost id. */
export const PROVIDER_LOGIN_KEEP_MS = 60_000;

/** Flows one host holds at once. A person starts a handful; a caller that cannot count is refused, not queued. */
export const PROVIDER_LOGIN_MAX_FLOWS = 32;

/** The longest answer a flow may be handed: a redirect address or a code, never a document. */
const MAX_ANSWER_CHARS = 8_192;

/** How many of a flow's own answers stay in the mask of what it publishes. */
const MAX_MASKED_ANSWERS = 8;

/**
 * How long `login-start` waits for the flow's first question before answering without one.
 *
 * A provider's first step is a network call, so a start request cannot honestly report a prompt it has not reached.
 * Waiting briefly makes the common case — an address or a device code within a few hundred milliseconds — one round trip,
 * while a slow provider is answered as still running and the caller polls: the same state the caller would have seen
 * without the wait, one second later.
 */
const FIRST_STEP_GRACE_MS = 1_500;

/** The name this installation introduces itself with, where a provider asks (OpenAI's agent hint). */
const AGENT_NAME = "hepi Web host";

/** The account directory's own mode, the same one the credential file is created under. */
const AGENT_DIR_MODE = 0o700;

/** Why a flow was ended by this host rather than by its provider. */
type EndReason = "cancelled" | "expired";

type Terminal = {
	readonly value?: readonly ProviderAuthStatus[];
	readonly storedType?: Credential["type"];
	readonly code?: ProviderLoginFailureCode;
	readonly message?: string;
};

type Pending = { readonly resolve: (answer: string) => void; readonly reject: (reason: unknown) => void };

type Flow = {
	readonly flowId: string;
	readonly providerId: string;
	readonly caller: string;
	readonly controller: AbortController;
	/** The handle this flow's own deadline was armed with, cleared when the flow settles first. */
	readonly deadline: unknown;
	/** Everything this flow was given or produced that a provider could echo back. Values, not descriptions. */
	readonly masked: string[];
	phase: ProviderLoginPhase;
	prompt?: ProviderAuthPrompt;
	event?: ProviderAuthEvent;
	expiresAt: number;
	pending?: Pending;
	ended?: EndReason;
	terminal?: Terminal;
	/** Lets `login-start` answer as soon as the flow has a step a caller can act on. */
	stepped?: { readonly promise: Promise<void>; readonly wake: () => void };
};

/** A refusal raised inside a flow's own work, so the code reaches the answer rather than a generic failure. */
class LoginRefusal extends Error {
	readonly code: ProviderLoginFailureCode;
	constructor(code: ProviderLoginFailureCode, text: string) {
		super(text);
		this.name = "LoginRefusal";
		this.code = code;
	}
}

export class ProviderLoginService {
	readonly #agentDir: string;
	readonly #context: AuthContext;
	readonly #auth: ProviderAuthService;
	readonly #catalog: () => Promise<readonly ProviderCatalogEntry[]>;
	readonly #ttlMs: number;
	readonly #keepMs: number;
	readonly #maxFlows: number;
	/** This host's clock: a test states its own so a deadline is advanced rather than waited out. */
	readonly #clock: ProviderLoginClock;
	/** How long a start or an answer waits for the flow's next step before answering without one. */
	readonly #graceMs: number;
	readonly #store: ProviderFileCredentialStore;
	/** The collection a flow runs on. Absent is the SDK's built-in set over this host's store; a test states its own. */
	readonly #extraProviders: readonly Provider[];
	readonly #flows = new Map<string, Flow>();
	#collection: Promise<Models> | undefined;
	#catalogOnce: Promise<readonly ProviderCatalogEntry[]> | undefined;

	constructor(options: {
		/** The agent directory whose `auth.json` a finished flow writes, and whose installation id a provider may ask for. */
		readonly agentDir: string;
		/** This host's environment and files, as a provider's own resolution reads them. */
		readonly context: AuthContext;
		/** The provider-auth surface, asked for the listing a finished flow answers with. */
		readonly auth: ProviderAuthService;
		readonly catalog?: () => Promise<readonly ProviderCatalogEntry[]>;
		readonly ttlMs?: number;
		readonly keepMs?: number;
		readonly maxFlows?: number;
		/** This host's clock, for a deadline a test advances instead of waiting out. Defaults to this machine's. */
		readonly clock?: ProviderLoginClock;
		/** How long a start or an answer waits for a step before reporting the flow as still running. */
		readonly graceMs?: number;
		/**
		 * Providers this host serves besides the SDK's built-in set, registered on the same collection and the same store.
		 *
		 * A test states a scripted flow here. It is a provider, not a replacement of the login machinery: the sign-in still
		 * runs through `Models.login`, the credential still lands through this host's store, and only the flow's steps are
		 * the fixture's — which is what makes a test of a fake provider a test of this bridge rather than of itself.
		 */
		readonly extraProviders?: readonly Provider[];
	}) {
		this.#agentDir = options.agentDir;
		this.#context = options.context;
		this.#auth = options.auth;
		this.#catalog = options.catalog ?? builtinProviderCatalog;
		this.#ttlMs = options.ttlMs ?? PROVIDER_LOGIN_TTL_MS;
		this.#keepMs = options.keepMs ?? PROVIDER_LOGIN_KEEP_MS;
		this.#maxFlows = options.maxFlows ?? PROVIDER_LOGIN_MAX_FLOWS;
		this.#clock = options.clock ?? SYSTEM_CLOCK;
		this.#graceMs = options.graceMs ?? FIRST_STEP_GRACE_MS;
		// The same handle the listing and the API-key path use, so a finished flow writes through the one lock this host
		// already keeps for that file rather than a second handle on the same path.
		this.#store = new ProviderFileCredentialStore(options.auth.credentialFile);
		this.#extraProviders = options.extraProviders ?? [];
	}

	/**
	 * One sign-in operation.
	 *
	 * `caller` is the identity the client ingress admitted the request as — stated there, never read from a client body —
	 * and a caller is never the flow's lifetime: an operation on an open flow answers its state whether or not the caller
	 * that started it is still connected, because the sign-in happens in another window and the tab that opened it is
	 * expected to go away. A start whose response was lost is recovered by `login-status`, which finds the caller's open
	 * flow for that provider — so nothing here needs to watch a socket.
	 */
	async execute(request: ProviderLoginRequest): Promise<ProviderLoginResult> {
		try {
			switch (request.operation) {
				case "login-start":
					return await this.#start(request.caller, request.providerId);
				case "login-poll":
					return this.#answer(this.#owned(request.caller, request.flowId));
				case "login-status":
					return this.#status(request.caller, request.providerId);
				case "login-submit":
					return await this.#submit(this.#owned(request.caller, request.flowId), request.answer);
				case "login-cancel":
					return this.#cancel(this.#owned(request.caller, request.flowId));
				case "login-forget":
					return this.#forget(request.caller);
				default:
					return refusedWith("unsupported_operation", "this gateway does not serve that provider sign-in operation");
			}
		} catch (error) {
			return this.#failure(error);
		}
	}

	/**
	 * Stop this service: end every flow it holds.
	 *
	 * A gateway that is shutting down has no host left to finish a sign-in on, so a flow must not sit out its deadline with
	 * a provider's exchange half-running; each is ended the way a caller's own cancel would have ended it.
	 */
	stop(): void {
		for (const flow of [...this.#flows.values()]) this.#end(flow, "cancelled");
		this.#flows.clear();
	}

	async #start(caller: unknown, providerId: unknown): Promise<ProviderLoginResult> {
		if (typeof caller !== "string" || caller === "") return refusal("invalid_request", "the request names no caller");
		const known = await this.#knownProvider(providerId);
		if (typeof known !== "string") return known;
		this.#sweep();
		// The same person starting the same provider twice is one flow: a second browser address for one account, and two
		// credentials racing for one file entry, is worse than answering with the flow already running. A retried click is
		// therefore harmless, which is what a panel that re-submits after a lost response needs.
		const running = [...this.#flows.values()].find((flow) => flow.caller === caller && flow.providerId === known && flow.terminal === undefined);
		if (running !== undefined) return { ok: true, value: this.#info(running) };
		if (this.#flows.size >= this.#maxFlows) return refusal("too_many_flows", "this host already has " + this.#maxFlows + " provider sign-ins open; cancel one before starting another");
		const entry = (await this.#catalogList()).find((item) => item.id === known);
		if (entry?.hasOAuth !== true) return refusal("unsupported_operation", "that provider has no sign-in flow on this host: it is authenticated with an API key or an ambient credential");

		const flow: Flow = {
			flowId: randomUUID(),
			providerId: known,
			caller,
			controller: new AbortController(),
			// Unref'd: a host's flow deadline must not be the reason its process stays alive once nothing else is.
			deadline: this.#clock.setTimeout(() => this.#end(flow, "expired"), this.#ttlMs),
			masked: [],
			phase: "running",
			expiresAt: this.#clock.now() + this.#ttlMs,
		};
		// Armed before the flow is handed to the provider: the wake it produces is the only reason a start or an
		// answer can return a step instead of an empty "running".
		const stepped = this.#gate(flow);
		this.#flows.set(flow.flowId, flow);
		// The flow runs detached from this request; whatever answers, the work continues and is read back by a later poll.
		void this.#run(flow);
		// One grace, not a wait for the flow to finish: the answer is whatever step the flow has reached, and the caller
		// polls from there. A provider whose first step is slow is answered as running, which is the truth.
		await Promise.race([stepped, sleep(this.#graceMs)]);
		return { ok: true, value: this.#info(flow) };
	}

	/**
	 * Say that this flow reached a step a caller can act on, and arm the gate for the next one.
	 *
	 * A start and an answer each wait briefly on this, so the common case — a provider whose first step produces an
	 * address, or whose last one stores a credential — is one round trip instead of a poll cycle. The gate is one-shot and
	 * replaced on every wake: a flow's state is read from the flow object, so nothing here is a queue a slow caller could
	 * fill, and a caller that is not waiting simply polls the same state later.
	 */
	#wake(flow: Flow): void {
		flow.stepped?.wake();
		this.#gate(flow);
	}

	/** The next gate a wake will settle, installed before the work that may wake it is handed off. */
	#gate(flow: Flow): Promise<void> {
		let wake = () => {};
		flow.stepped = { promise: new Promise<void>((resolve) => { wake = resolve; }), wake };
		return flow.stepped.promise;
	}

	/** The provider's own flow, driven by the SDK, with this host's file as its only door. */
	async #run(flow: Flow): Promise<void> {
		const interaction = {
			signal: flow.controller.signal,
			prompt: (prompt: AuthPrompt) => this.#ask(flow, prompt),
			notify: (event: AuthEvent) => this.#notify(flow, event),
		};
		try {
			const models = await this.#modelsOnce();
			const credential: Credential = await models.login(flow.providerId, "oauth", interaction, { getDeviceId: () => this.#deviceId(), agentName: AGENT_NAME });
			for (const value of maskedCredentialValues(credential)) flow.masked.push(value);
			if (flow.terminal !== undefined) return; // this host already ended it (a cancel or the deadline)
			flow.terminal = { value: await this.#listing(), storedType: credential.type };
			flow.phase = "succeeded";
		} catch (error) {
			if (flow.terminal === undefined) {
				const settled = this.#settled(flow, error);
				flow.terminal = settled.terminal;
				flow.phase = settled.phase;
			}
		} finally {
			this.#clock.clearTimeout(flow.deadline);
			flow.prompt = undefined;
			this.#settlePending(flow, flow.controller.signal.reason ?? new Error("the sign-in ended"));
			flow.expiresAt = this.#clock.now() + this.#keepMs;
			flow.controller.abort(new Error("this sign-in has ended"));
			this.#wake(flow);
		}
	}

	/**
	 * The question a provider is asking, held until a caller answers it.
	 *
	 * One question at a time: a second prompt before the first was answered is refused as the host bug it would be, not
	 * queued silently. Two things withdraw a question. This host ending the flow (a cancel, a deadline, an abandoned
	 * create) rejects it and fails the flow. The provider's *own* per-prompt signal rejects it without failing anything:
	 * that is upstream's race between a loopback callback and a paste-back question, where the callback winning means the
	 * question must simply disappear from the panel.
	 *
	 * The answer is resolved into the provider and dropped. It is never stored, never echoed back to any caller, and kept
	 * only as a mask value so that a later provider message cannot repeat it.
	 */
	#ask(flow: Flow, prompt: AuthPrompt): Promise<string> {
		if (flow.terminal !== undefined) return Promise.reject(new Error("this sign-in has ended"));
		if (flow.pending !== undefined) return Promise.reject(new LoginRefusal("operation_failed", "this provider sign-in asked a second question before the first was answered"));
		const shown = narrowPrompt(prompt);
		return new Promise<string>((resolve, reject) => {
			let settled = false;
			const withdraw = (reason: unknown) => {
				if (settled) return;
				settled = true;
				flow.prompt = undefined;
				flow.pending = undefined;
				// Withdrawn while the flow still runs: whatever it does next is its own business, and a poll must not
				// keep offering a field nothing is waiting for.
				if (flow.terminal === undefined) flow.phase = "running";
				reject(reason);
			};
			flow.prompt = shown;
			flow.phase = "waiting_for_input";
			flow.pending = {
				resolve: (answer: string) => { if (settled) return; settled = true; flow.prompt = undefined; flow.pending = undefined; resolve(answer); },
				reject: withdraw,
			};
			// The provider withdrew its own question (a callback arrived first): the panel stops showing a field nothing
			// waits for, and the flow continues.
			prompt.signal?.addEventListener("abort", () => withdraw(prompt.signal?.reason ?? new Error("the sign-in withdrew this question")), { once: true });
			this.#wake(flow);
		});
	}

	#notify(flow: Flow, event: AuthEvent): void {
		flow.event = this.#maskEvent(flow, event);
		// A flow that has produced an address is waiting on a browser. If a question is open beside it (paste-back), both
		// are reported and the panel offers both, which is what upstream's own flow can legitimately do.
		if (flow.phase === "running") flow.phase = "waiting_for_browser";
		this.#wake(flow);
	}

	async #submit(flow: Flow, answer: unknown): Promise<ProviderLoginResult> {
		this.#sweep();
		const prompt = flow.prompt;
		const pending = flow.pending;
		if (prompt === undefined || pending === undefined) {
			return refusal("flow_not_waiting", "this sign-in is not waiting for an answer" + (flow.phase === "running" ? ": it is already working" : " (it is " + flow.phase + ")"));
		}
		const checked = checkedAnswer(prompt, answer);
		if (checked === undefined) return refusal("answer_invalid", "that is not an answer this question accepts");
		flow.masked.push(checked);
		if (flow.masked.length > MAX_MASKED_ANSWERS) flow.masked.shift();
		// Handed to the provider, then waited on for the same brief grace a start waits: the answer a caller gets back is
		// the step the flow reached, not the instant before it moved. A flow that needs longer is answered as running and
		// polled, which is the same state, one round trip later.
		const stepped = this.#gate(flow);
		pending.resolve(checked);
		flow.phase = "running";
		await Promise.race([stepped, sleep(this.#graceMs)]);
		return { ok: true, value: this.#info(flow) };
	}

	#cancel(flow: Flow): ProviderLoginResult {
		if (flow.terminal === undefined) this.#end(flow, "cancelled");
		return { ok: true, value: this.#info(flow) };
	}

	/**
	 * End a flow from this host's side, and say which way.
	 *
	 * The controller's reason is what the provider's awaits see, so a half-finished exchange stops where it is. A flow that
	 * had already written its credential is not unwritten by a cancel that arrived afterwards — the file's owner is the step
	 * that completed it, not this map — which is why `#run` checks for an existing terminal state before overwriting one.
	 */
	#end(flow: Flow, reason: EndReason): void {
		if (flow.terminal !== undefined) return;
		flow.ended = reason;
		flow.terminal = { message: reason === "cancelled" ? "this sign-in was cancelled" : "this sign-in stopped waiting: this host ends a flow after " + Math.round(this.#ttlMs / 60_000) + " minutes" };
		flow.phase = reason;
		flow.prompt = undefined;
		flow.expiresAt = this.#clock.now() + this.#keepMs;
		this.#clock.clearTimeout(flow.deadline);
		this.#settlePending(flow, new Error(flow.terminal.message));
		flow.controller.abort(new Error(flow.terminal.message));
		this.#wake(flow);
	}

	#settlePending(flow: Flow, reason: unknown): void {
		const pending = flow.pending;
		flow.pending = undefined;
		pending?.reject(reason);
	}

	/**
	 * The one flow this caller has open for one provider, if it has any.
	 *
	 * This is what lets a panel that lost its address — reloaded, reopened in another tab, reconnected after a drop —
	 * resume the sign-in it already started instead of starting a second one. An open flow that ended is reported as the
	 * terminal state it settled into, so a caller that comes back a minute later learns it succeeded rather than that its
	 * flow is gone; past that window there is nothing to follow and the answer is the same name for both.
	 *
	 * An ended flow stays readable, and a caller can start a fresh one while that record is still held — the dedup above only
	 * joins a flow that is still open — so an open flow wins here: reading a caller's provider must never report the older
	 * ended record and leave the live one unfollowable. Where nothing is open, the record that ended most recently answers,
	 * which is the outcome the caller came back for.
	 */
	#status(caller: unknown, providerId: unknown): ProviderLoginResult {
		this.#sweep();
		if (typeof caller !== "string" || caller === "" || typeof providerId !== "string" || providerId.trim() === "") {
			return refusal("flow_unknown", "no sign-in is open for this client and provider: it ended, or this host service restarted");
		}
		const id = providerId.trim();
		const own = [...this.#flows.values()].filter((item) => item.caller === caller && item.providerId === id);
		const flow = own.find((item) => item.terminal === undefined) ?? own.reduce<Flow | undefined>((latest, item) => (latest === undefined || item.expiresAt > latest.expiresAt ? item : latest), undefined);
		if (flow === undefined) return refusal("flow_unknown", "no sign-in is open for this client and provider: it ended, or this host service restarted");
		return { ok: true, value: this.#info(flow) };
	}

	/**
	 * Drop everything one caller has open, without asking any of it first.
	 *
	 * A client ingress issues this when the device credential a caller was admitted with stops being valid. That caller can
	 * no longer reach a flow — its next request is refused at the entrance — so a flow left running would be one nobody can
	 * answer or cancel, yet which can still finish and store a credential: revocation has to reach a detached flow or the
	 * word means nothing for it, the same rule MCP applies to a server a test started.
	 *
	 * The flows are removed rather than left readable, because the only caller that could read them is now refused; keeping
	 * their outcome would be holding one person's sign-in record for nobody.
	 */
	#forget(caller: unknown): ProviderLoginForgetResult {
		if (typeof caller !== "string" || caller === "") return refusal("invalid_request", "the request names no caller");
		let dropped = 0;
		for (const [flowId, flow] of [...this.#flows]) {
			if (flow.caller !== caller) continue;
			if (flow.terminal === undefined) this.#end(flow, "cancelled");
			this.#flows.delete(flowId);
			dropped += 1;
		}
		return { ok: true, value: { dropped } };
	}

	/** The flow this caller may act on, or the refusal that says it has none. */
	#owned(caller: unknown, flowId: unknown): Flow {
		this.#sweep();
		if (typeof caller !== "string" || caller === "" || typeof flowId !== "string" || flowId === "") {
			throw new LoginRefusal("flow_unknown", "no sign-in has that id: it ended, it belongs to another client, or this host service restarted");
		}
		const flow = this.#flows.get(flowId);
		// A flow that is not this caller's is refused in exactly the words an unknown id gets: with one host bearer shared by
		// every client of an ingress, a guessable id would otherwise be a way to answer someone else's browser sign-in.
		if (flow === undefined || flow.caller !== caller) {
			throw new LoginRefusal("flow_unknown", "no sign-in has that id: it ended, it belongs to another client, or this host service restarted");
		}
		return flow;
	}

	#answer(flow: Flow): ProviderLoginResult {
		return { ok: true, value: this.#info(flow) };
	}

	#info(flow: Flow): ProviderLoginInfo {
		// Browser first, then input: the order a copy-code flow actually asks them in (open this address, then paste what
		// you landed on). A fixed order is what lets a panel diff two polls rather than re-render on a reshuffle.
		const waitingFor: ("browser" | "input")[] = [];
		if (flow.event !== undefined && flow.terminal === undefined) waitingFor.push("browser");
		if (flow.prompt !== undefined) waitingFor.push("input");
		const terminal = flow.terminal ?? {};
		return {
			flowId: flow.flowId,
			providerId: flow.providerId,
			phase: flow.phase,
			waitingFor,
			...(flow.prompt === undefined ? {} : { prompt: flow.prompt }),
			...(flow.event === undefined ? {} : { event: flow.event }),
			// A terminal phase holds nothing open, so it counts down from nothing: a caller reads this as "stop
			// polling", while the readable window behind it is this host's own housekeeping.
			expiresInMs: flow.terminal === undefined ? Math.max(0, flow.expiresAt - this.#clock.now()) : 0,
			...(terminal.value === undefined ? {} : { value: terminal.value }),
			...(terminal.storedType === undefined ? {} : { storedType: terminal.storedType }),
			...(terminal.code === undefined ? {} : { code: terminal.code }),
			...(terminal.message === undefined ? {} : { message: this.#maskText(flow, terminal.message) }),
		};
	}

	/** Drop the flows whose readable window closed. Every entry point sweeps, so a host cannot be filled by dead flows. */
	#sweep(): void {
		const now = this.#clock.now();
		for (const [flowId, flow] of [...this.#flows]) if (flow.terminal !== undefined && flow.expiresAt <= now) this.#flows.delete(flowId);
	}

	/**
	 * Why a flow failed, in this surface's own vocabulary.
	 *
	 * Upstream's text is not forwarded: an OAuth exchange error can quote the code or token it was handed, and there is no
	 * way here to know which part of a provider's message is a credential. The code comes from the SDK's own error classes;
	 * the text is this service's sentence, then masked against everything this flow was given.
	 */
	#settled(flow: Flow, error: unknown): { readonly phase: ProviderLoginPhase; readonly terminal: Terminal } {
		if (flow.ended !== undefined) {
			// This host ended the flow and the provider reported the abort afterwards: the reason is the one already set.
			return { phase: flow.ended, terminal: { message: flow.ended === "cancelled" ? "this sign-in was cancelled" : "this sign-in stopped waiting" } };
		}
		const code = loginFailureCode(error);
		return { phase: "failed", terminal: { code, message: this.#maskText(flow, loginMessage(code)) } };
	}

	/**
	 * What a flow publishes, with every credential taken out of it.
	 *
	 * Three rules, in order of who knows the value. (1) Anything this caller handed the flow, and anything the flow has
	 * produced, is masked by exact value: those are the strings this host actually holds. (2) Anything *credential-shaped*
	 * inside a provider's own text is masked by the same detector the MCP surface uses, because a provider's progress
	 * message can name a token long before the flow returns it and this host has no way to know which part of its sentence
	 * is a secret. (3) A device code and an authorization address survive: they are shown on purpose (RFC 8628 hands the
	 * person a code to type, and a code_challenge is not a credential), and neither reads as a stored value.
	 */
	#maskText(flow: Flow, value: string): string {
		let text = value;
		for (const secret of flow.masked) if (secret !== "") text = text.split(secret).join(SECRET_MASK);
		// Runs, not words: a URL carries colons and query separators a token never does, so splitting here is what keeps
		// rule (2) from masking the one thing a person has to open.
		return text.split(/(\s+)/).map((run) => (looksLikeSecretValue(run) ? SECRET_MASK : run)).join("");
	}

	#maskEvent(flow: Flow, event: AuthEvent): ProviderAuthEvent {
		switch (event.type) {
			case "auth_url":
				return { type: "auth_url", url: this.#maskText(flow, event.url), ...(event.instructions === undefined ? {} : { instructions: this.#maskText(flow, event.instructions) }) };
			case "device_code":
				return {
					type: "device_code",
					userCode: this.#maskText(flow, event.userCode),
					verificationUri: this.#maskText(flow, event.verificationUri),
					...(event.intervalSeconds === undefined ? {} : { intervalSeconds: event.intervalSeconds }),
					...(event.expiresInSeconds === undefined ? {} : { expiresInSeconds: event.expiresInSeconds }),
				};
			case "info":
				return {
					type: "info",
					message: this.#maskText(flow, event.message),
					...(event.links === undefined ? {} : { links: event.links.map((link) => ({ url: this.#maskText(flow, link.url), ...(link.label === undefined ? {} : { label: this.#maskText(flow, link.label) }) })) }),
				};
			default:
				return { type: "progress", message: this.#maskText(flow, event.message) };
		}
	}

	async #listing(): Promise<readonly ProviderAuthStatus[]> {
		const answer = await this.#auth.execute({ operation: "list" });
		if (answer.ok === false) throw new LoginRefusal(answer.code, answer.message);
		return answer.value;
	}

	async #knownProvider(providerId: unknown): Promise<string | ProviderLoginResult> {
		if (typeof providerId !== "string" || providerId.trim() === "") return refusal("invalid_request", "the request names no provider");
		const id = providerId.trim();
		return (await this.#catalogList()).some((entry) => entry.id === id) ? id : refusal("unknown_provider", "this host serves no provider with that id");
	}

	#catalogList(): Promise<readonly ProviderCatalogEntry[]> {
		this.#catalogOnce ??= this.#catalog();
		return this.#catalogOnce;
	}

	/**
	 * The `Models` collection this host signs providers up through.
	 *
	 * The SDK's built-in provider set, loaded on first use, over this host's credential store and this host's auth context:
	 * every provider's flow, prompt shape and token exchange is upstream's own code. The only thing this repository adds to
	 * a sign-in is where its credential is written.
	 */
	#modelsOnce(): Promise<Models> {
		this.#collection ??= this.#builtModels();
		return this.#collection;
	}

	/**
	 * The SDK's own collection: every built-in provider, this host's credential store, this host's auth context.
	 *
	 * A test states its own `models` instead, which is how a scripted provider flow reaches this service through
	 * the same `Models.login` path a real one drives.
	 */
	async #builtModels(): Promise<Models> {
		const { builtinModels } = await import("@earendil-works/pi-ai/providers/all");
		const models = builtinModels({ credentials: this.#store, authContext: this.#context });
		for (const provider of this.#extraProviders) models.setProvider(provider);
		return models;
	}

	/**
	 * This installation's stable id, for the providers that ask one (OpenAI names an agent host by it).
	 *
	 * The pi CLI's own id is used when this account already has one in `settings.json`, so a sign-in from here does not
	 * register a second installation for an account pi already named. Where it has none, this host keeps its own small file
	 * rather than writing `settings.json`: that document is the CLI's, has a schema of its own, and a gateway editing it
	 * would be a second writer of a file it does not own.
	 *
	 * The provider asks for this *before* any credential is stored, so on an account that has never signed in it is the first
	 * writer of the agent directory. The credential file's own step creates that directory, but inside its lock and later than
	 * this call, so a plain write here would answer ENOENT on a fresh host and the sign-in would fail as a storage error
	 * before it produced anything. The directory is therefore created the way the credential file creates it — recursive, and
	 * restricted to the account — before the id is written.
	 */
	#deviceId(): string {
		const fromSettings = readSettingsDeviceId(join(this.#agentDir, "settings.json"));
		if (fromSettings !== undefined) return fromSettings;
		const path = join(this.#agentDir, "installation-id");
		try {
			const stored = readFileSync(path, "utf8").trim();
			if (isUuid(stored)) return stored;
		} catch { /* nothing recorded yet */ }
		const created = randomUUID();
		try {
			mkdirSync(dirname(path), { recursive: true, mode: AGENT_DIR_MODE });
			writeFileSync(path, created + "\n", { encoding: "utf8", flag: "wx", mode: 0o600 });
		} catch (error) {
			// A file that exists already is the answer rather than a failure: two processes starting at once both end up
			// naming themselves by the id the first wrote, which is the only property a stable installation id needs.
			if ((error as { code?: string }).code !== "EEXIST") throw error;
			try {
				const raced = readFileSync(path, "utf8").trim();
				if (isUuid(raced)) return raced;
			} catch { /* an unreadable id file falls back to this process's own */ }
		}
		return created;
	}

	#failure(error: unknown): ProviderLoginResult {
		if (error instanceof LoginRefusal) return refusal(error.code, error.message);
		if (error instanceof ProviderAuthLockError) return refusal("lock_unavailable", "another writer is holding auth.json; nothing was changed");
		if (error instanceof ProviderAuthFileError) return refusal("auth_file_unreadable", "auth.json on this host could not be used; nothing was changed");
		const code = String((error as { code?: unknown } | undefined)?.code ?? "");
		if (code === "EACCES" || code === "EPERM") return refusal("permission_denied", "this host refused access to its agent directory; nothing was changed");
		return refusal("operation_failed", "the provider sign-in failed on this host");
	}
}

/** One answer, or a refusal, in this surface's own type. */
/** An answer, or a refusal of either shape: the caller narrows it by the operation it sent. */
function refusal<T>(code: ProviderLoginFailureCode, message: string): T {
	return { ok: false, code, message } as T;
}

/** A sign-in refusal, in the shape every flow-following operation answers. */
function refusedWith(code: ProviderLoginFailureCode, message: string): ProviderLoginResult {
	return refusal<ProviderLoginResult>(code, message);
}

/** A prompt as it may be shown: the SDK's own fields, and nothing the flow kept for itself (its signal stays here). */
function narrowPrompt(prompt: AuthPrompt): ProviderAuthPrompt {
	switch (prompt.type) {
		case "select":
			return { type: "select", message: prompt.message, options: prompt.options.map((option) => ({ id: option.id, label: option.label, ...(option.description === undefined ? {} : { description: option.description }) })) };
		case "manual_code":
			return { type: "manual_code", message: prompt.message, ...(prompt.placeholder === undefined ? {} : { placeholder: prompt.placeholder }) };
		default:
			return { type: prompt.type, message: prompt.message, ...(prompt.placeholder === undefined ? {} : { placeholder: prompt.placeholder }) };
	}
}

/**
 * Whether an answer is one the open question could take.
 *
 * A `select` is answered by one of its own ids and nothing else — a panel cannot invent a choice a provider did not
 * offer. Any other question takes one bounded run of text with no control characters: a device confirmation is typed in
 * the browser, so what arrives here is a pasted code or redirect address. An empty answer is refused, because a flow that
 * is waiting wants something to continue with.
 */
function checkedAnswer(prompt: ProviderAuthPrompt, answer: unknown): string | undefined {
	if (typeof answer !== "string") return undefined;
	if (prompt.type === "select") return prompt.options.some((option) => option.id === answer) ? answer : undefined;
	const value = answer.trim();
	if (value === "" || value.length > MAX_ANSWER_CHARS || /[\u0000-\u001f\u007f]/.test(value)) return undefined;
	return value;
}

/** The code a flow's failure is reported as, from the SDK's own error vocabulary. */
function loginFailureCode(error: unknown): ProviderLoginFailureCode {
	const code = String((error as { code?: unknown } | undefined)?.code ?? "");
	const message = error instanceof Error ? error.message : String(error);
	if (code === "provider") return "unknown_provider";
	if (/does not support .* login/.test(message)) return "unsupported_operation";
	// Upstream refuses a browser sign-in whose loopback port is already taken, which is another sign-in holding it.
	if (/is in use/.test(message)) return "lock_unavailable";
	if (code === "auth" || code === "oauth") return "operation_failed";
	return "operation_failed";
}

/** This surface's own sentence for a failure — never the provider's, which can quote a value it was handed. */
function loginMessage(code: ProviderLoginFailureCode): string {
	switch (code) {
		case "unknown_provider": return "this host serves no provider with that id";
		case "unsupported_operation": return "this provider has no sign-in flow this host can serve";
		case "lock_unavailable": return "another sign-in holds the loopback address this flow needs; cancel it and try again";
		case "auth_file_unreadable": return "auth.json on this host could not be used; nothing was changed";
		case "permission_denied": return "this host refused access to its agent directory; nothing was changed";
		default: return "the provider sign-in failed on this host";
	}
}

/**
 * The values of a produced credential, for masking only.
 *
 * A provider's own error can name the token it just received; these strings are added to the flow's mask the moment the
 * flow returns, which is what keeps an access token, a refresh token or a key out of every later answer this host gives.
 */
function maskedCredentialValues(credential: Credential): readonly string[] {
	if (credential.type === "api_key") return [typeof credential.key === "string" ? credential.key : ""];
	const oauth = credential as OAuthCredential;
	return [oauth.access, oauth.refresh].filter((value): value is string => typeof value === "string" && value !== "");
}

function isUuid(value: string): boolean {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function readSettingsDeviceId(path: string): string | undefined {
	if (!existsSync(path)) return undefined;
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as { deviceId?: unknown };
		return typeof parsed.deviceId === "string" && isUuid(parsed.deviceId) ? parsed.deviceId : undefined;
	} catch {
		// A settings file this host cannot parse is no reason to refuse a sign-in, and no reason to write one either.
		return undefined;
	}
}

/**
 * The two clock facts a flow needs: when "now" is, and how a deadline is armed and dropped.
 *
 * Production states the machine's own clock. A test states one it advances, so a fifteen-minute deadline and the readable
 * window after it are asserted by moving time forward rather than by waiting it out — the deadline a host enforces is
 * unchanged either way.
 */
export type ProviderLoginClock = {
	now(): number;
	setTimeout(callback: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
};

/** This machine's clock, with a flow deadline that never keeps the process alive on its own. */
const SYSTEM_CLOCK: ProviderLoginClock = {
	now: () => Date.now(),
	setTimeout: (callback, ms) => {
		const timer = setTimeout(callback, ms);
		// A flow's own work is what a run waits for; the bound that would end it must not be.
		timer.unref?.();
		return timer;
	},
	clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

/** A promise that never resolves but keeps `Promise.race` honest about a wait, unrefused by anything else. */
function sleep(ms: number): Promise<never> {
	return new Promise<never>((resolve) => { const timer = setTimeout(() => resolve(undefined as never), ms); timer.unref?.(); });
}

