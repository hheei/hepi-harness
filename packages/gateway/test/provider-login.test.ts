import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import lockfile from "proper-lockfile";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { createFauxCore, createProvider, type AuthEvent, type AuthPrompt, type OAuthCredential, type Provider } from "@earendil-works/pi-ai";
import type { ProviderLoginInfo, ProviderLoginRequest, ProviderLoginResult } from "@hepi/protocol/gateway";
import {
	agentDirOf,
	GatewayRpcServer,
	LocalGateway,
	MemoryLedger,
	PROVIDER_LOGIN_KEEP_MS,
	PROVIDER_LOGIN_TTL_MS,
	ProviderAuthService,
	ProviderLoginService,
	WorkspaceRegistry,
	type ProviderLoginClock,
} from "../src/index.ts";
import { LocalFilesystem } from "../src/filesystem.ts";

/**
 * Provider sign-in at the host seam: POST /v1/providers/login on a real gateway process, over an account directory of
 * its own.
 *
 * Ticket 03's claim is that the OAuth work is the SDK's and this repository contributes only the bridge — a queue of the
 * flow's questions, their deadline, who may answer them, and what a watcher may see. So every test here drives a
 * scripted provider registered beside the SDK's set: its login(interaction) calls interaction.notify and
 * interaction.prompt the way a real device-code or browser flow does, and nothing else about the path is a fake. The
 * credential it returns lands through the same CredentialStore a real sign-in writes — the account's auth.json.
 *
 * What is asserted is the bridge: a flow outlives the request that started it and its caller finds it again; a repeated
 * start is the same flow, not a second browser address; another admitted caller cannot answer, cancel, or even detect one;
 * cancel, the deadline and this service stopping each end it, and none of them stores anything; an answer is accepted only
 * by the question that is open; and no value a caller typed, no token a flow produced, and no credential-shaped word a
 * provider wrote reaches a client.
 */

const TOKEN = "gateway-token";
// Realistic shapes, not brace-wrapped placeholders: a masking rule that only ever sees an invented token proves nothing
// about a real one, and these are the forms upstream actually hands back.
const ACCESS = "ya29.a0b1c2d3e4f5g6h7i8j9k0l1m2n3o4p5q6r7s8t9";
const REFRESH = "1//0abcdefghijklmnopqrstuvwx1234567890ABCDEFGH";
const CODE = "GQV-GBNN";
const PASTED = "http://localhost:53692/callback?code=4tY4Kj7m2QsVbX&state=xyz";
const TYPED = "workspace-choice-acc-b";

const directories: string[] = [];
after(async () => { for (const directory of directories) await rm(directory, { recursive: true, force: true }); });

/** One step of a scripted flow, run in the order the fixture lists them. */
type Step =
	| { readonly kind: "notify"; readonly event: AuthEvent }
	| { readonly kind: "prompt"; readonly prompt: AuthPrompt }
	/** The provider withdraws its own question while waiting, as a loopback callback races a paste-back prompt. */
	| { readonly kind: "withdraw"; readonly prompt: AuthPrompt; readonly afterMs?: number }
	/** The flow waits on its own signal: a device poll, or an exchange a browser has not yet unblocked. */
	| { readonly kind: "wait"; readonly ms: number }
	| { readonly kind: "fail"; readonly error: unknown }
	| { readonly kind: "done" };

type Harness = {
	readonly origin: string;
	readonly authPath: string;
	readonly agentDir: string;
	/** The installation id the provider was handed, if this fixture asked for one. */
	deviceId(): string | undefined;
	/** What the scripted provider reached, in order — the fixture's own record of what this host drove it through. */
	reached(): string[];
	/** Every answer the bridge handed the provider, in the order it was given them. */
	answers(): string[];
	call(body: ProviderLoginRequest): Promise<{ status: number; body: ProviderLoginResult; text: string }>;
	close(): Promise<void>;
};

async function harness(options: {
	readonly steps?: Step[];
	readonly providerId?: string;
	/**
	 * Have the scripted provider ask the host for its installation id before anything else, the way OpenAI's flow does.
	 *
	 * That call is the only thing a sign-in does to the account directory *before* a credential exists, so it is how a fresh
	 * host's directory-creation path gets exercised rather than assumed.
	 */
	readonly asksForDeviceId?: boolean;
	readonly ttlMs?: number;
	readonly keepMs?: number;
	readonly maxFlows?: number;
	/** Serve no sign-in service at all: the route must answer the deployment's own named limit. */
	readonly serveLogins?: boolean;
	/**
	 * This host's clock, so a deadline test advances time instead of sleeping past a real one.
	 *
	 * The bound a deployment enforces is unchanged: the same ttl and the same readable window, read from a clock the test
	 * moves. What is saved is the wall time of waiting it out.
	 */
	readonly clock?: ProviderLoginClock;
	/**
	 * How long a start waits for the flow's first step, where that wait is not what the case is about.
	 *
	 * A case that holds a flow at a step the provider never reports — a device poll, an exchange nobody answered — would
	 * otherwise spend the production grace on every start. The bound a deployment uses is unchanged; this only says the
	 * grace is not the behaviour under test.
	 */
	readonly graceMs?: number;
}): Promise<Harness> {
	const base = await mkdtemp(join(tmpdir(), "hepi-provider-login-"));
	directories.push(base);
	const home = join(base, "home");
	await mkdir(home, { recursive: true });
	const agentDir = agentDirOf(home);
	const registry = new WorkspaceRegistry([{ id: "local", root: home }]);
	const gateway = new LocalGateway({ id: "workstation", token: TOKEN, workspaces: registry, allowedCommands: ["bash"] }, new MemoryLedger());
	const providerId = options.providerId ?? "scripted";
	let deviceId: string | undefined;
	// One catalog for both surfaces, as a deployment has one: a sign-in writes a provider the listing must know,
	// or a flow that succeeded would report a store this host says it does not serve.
	const catalog = async () => [{ id: providerId, name: "Scripted Provider", hasApiKey: true, hasOAuth: true }];
	const auth = new ProviderAuthService({ agentDir, context: { env: async () => undefined, fileExists: async () => false }, catalog });
	const reached: string[] = [];
	const answers: string[] = [];
	const steps = options.steps ?? [{ kind: "done" }];
	const credential = (): OAuthCredential => ({ type: "oauth", access: ACCESS, refresh: REFRESH, expires: Date.now() + 3_600_000 });

	// The SDK's own scripted model provider, with this fixture's auth semantics: a test of the bridge never needs a
	// stream, and `Models` requires a provider that has one, so the flow is the only part that is invented here.
	const core = createFauxCore({ provider: providerId });
	const provider: Provider = createProvider({
		id: providerId,
		name: "Scripted Provider",
		auth: {
			apiKey: { name: "Scripted API key", resolve: async () => undefined },
			oauth: {
				name: "Scripted subscription",
				isSubscription: true,
				login: async (interaction, loginOptions) => {
					reached.push("login");
					if (options.asksForDeviceId === true) deviceId = loginOptions?.getDeviceId?.();
					// One await on the flow's own signal, so "this host ended the flow" reaches the provider the way a real
					// device poll or exchange sees it — a test can then assert the abort hit the work, not just the map.
					const aborted = new Promise<never>((_resolve, reject) => {
						const stop = (): void => reject(interaction.signal.reason);
						if (interaction.signal.aborted) stop();
						else interaction.signal.addEventListener("abort", stop, { once: true });
					});
					// A flow with no await in it (one that returns a credential at once) never races this, and the host
					// aborts the signal as it ends — which would report a fixture's own unused promise as an unhandled
					// rejection. Its real consumers still race it below; this only says the fixture is not awaiting it.
					aborted.catch(() => {});
					for (const step of steps) {
						switch (step.kind) {
							case "notify":
								reached.push("notify:" + step.event.type);
								interaction.notify(step.event);
								break;
							case "prompt": {
								reached.push("prompt:" + step.prompt.type);
								answers.push(await Promise.race([interaction.prompt(step.prompt), aborted]));
								reached.push("answered");
								break;
							}
							case "withdraw": {
								const controller = new AbortController();
								reached.push("prompt:" + step.prompt.type);
								const waiting = interaction.prompt({ ...step.prompt, signal: controller.signal });
								// The fixture's own race, not the host's deadline: it must not be a reason this run stays alive.
								setTimeout(() => controller.abort(new Error("the callback arrived")), step.afterMs ?? 40).unref();
								try {
									answers.push(await Promise.race([waiting, aborted]));
									reached.push("answered");
								} catch {
									reached.push("withdrawn");
								}
								break;
							}
							case "wait":
								reached.push("wait");
								await Promise.race([new Promise((resolve) => setTimeout(resolve, step.ms).unref()), aborted]);
								reached.push("waited");
								break;
							case "fail":
								reached.push("fail");
								throw step.error;
							case "done":
								reached.push("done");
								return credential();
						}
					}
					reached.push("done");
					return credential();
				},
				refresh: async (stored) => stored,
				toAuth: async () => ({ headers: { authorization: "Bearer scripted" } }),
			},
		},
	models: core.models,
	api: { stream: core.stream, streamSimple: core.streamSimple },
});

	const logins = options.serveLogins === false
		? undefined
		: new ProviderLoginService({
				agentDir,
				context: { env: async () => undefined, fileExists: async () => false },
				auth,
				catalog,
				extraProviders: [provider],
				...(options.ttlMs === undefined ? {} : { ttlMs: options.ttlMs }),
				...(options.keepMs === undefined ? {} : { keepMs: options.keepMs }),
				...(options.maxFlows === undefined ? {} : { maxFlows: options.maxFlows }),
				...(options.clock === undefined ? {} : { clock: options.clock }),
				...(options.graceMs === undefined ? {} : { graceMs: options.graceMs }),
			});
	const server = new GatewayRpcServer(gateway, undefined, new LocalFilesystem(registry), undefined, undefined, undefined, undefined, undefined, auth, logins);
	await new Promise<void>((resolve) => server.server.listen(0, "127.0.0.1", resolve));
	const address = server.server.address();
	assert.ok(address !== null && typeof address === "object");
	const origin = "http://127.0.0.1:" + address.port;
	return {
		origin,
		agentDir,
		authPath: join(agentDir, "auth.json"),
		deviceId: () => deviceId,
		reached: () => reached.slice(),
		answers: () => answers.slice(),
		call: async (body) => {
			const response = await fetch(origin + "/v1/providers/login", { method: "POST", headers: { authorization: "Bearer " + TOKEN, "content-type": "application/json" }, body: JSON.stringify(body) });
			const text = await response.text();
			return { status: response.status, body: JSON.parse(text) as ProviderLoginResult, text };
		},
		close: async () => { server.server.closeAllConnections(); await server.close(); },
	};
}

/**
 * A clock a test moves by hand, with the timers a flow armed along the way.
 *
 * A deadline is a bound on a real flow, so the host is handed a clock rather than a shorter bound: `advance` moves "now"
 * forward and fires the deadlines that fell due, in the order they were armed, and the host's own `expiresInMs` reads the
 * same clock. Nothing here sleeps, and nothing here changes what a deployment waits for.
 */
function virtualClock(start = 1_760_000_000_000): ProviderLoginClock & { advance(ms: number): void } {
	let now = start;
	let next = 0;
	const armed = new Map<number, { at: number; callback: () => void }>();
	return {
		now: () => now,
		setTimeout: (callback, ms) => {
			const handle = ++next;
			armed.set(handle, { at: now + ms, callback });
			return handle;
		},
		clearTimeout: (handle) => { armed.delete(handle as number); },
		advance: (ms) => {
			now += ms;
			for (const [handle, timer] of [...armed].sort((left, right) => left[1].at - right[1].at)) {
				if (timer.at > now) continue;
				armed.delete(handle);
				timer.callback();
			}
		},
	};
}

const CALLER = "device:credential-1";
const OTHER = "device:credential-2";

function flow(result: ProviderLoginResult): ProviderLoginInfo {
	assert.ok(result.ok, "the host refused: " + JSON.stringify(result));
	return result.value as ProviderLoginInfo;
}

function refused(result: ProviderLoginResult): { code: string; message: string } {
	assert.ok(!result.ok, "the host answered a flow: " + JSON.stringify(result));
	return { code: result.code, message: result.message };
}

/**
 * Follow a flow until this host reports it ended, or until the wait itself becomes the finding.
 *
 * A submit answers the step a flow had reached when it stopped waiting on it, which for a provider that notifies
 * before it finishes is a working flow — the same state a panel sees, and the same reason a panel polls. A test that
 * wants the ending follows it, which is what that panel does.
 */
async function settled(h: Harness, flowId: string, caller = CALLER): Promise<ProviderLoginInfo> {
	for (let attempt = 0; attempt < 80; attempt += 1) {
		const answer = (await h.call({ operation: "login-poll", flowId, caller })).body;
		if (answer.ok) {
			if (!("phase" in answer.value)) continue;
			const info = answer.value;
			if (info.phase === "succeeded" || info.phase === "failed" || info.phase === "cancelled" || info.phase === "expired") return info;
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error("this flow never ended: " + caller + " " + flowId);
}

/** Nothing this host publishes may carry a value a caller typed or a credential a flow produced. */
/** The account file as it stands: absent is an empty store, which is pi's own reading of a missing file. */
function stored(file: string): Record<string, unknown> {
	try { return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>; } catch { return {}; }
}

function assertNoSecrets(text: string, values: readonly string[]): void {
	for (const value of values) assert.equal(text.includes(value), false, "an answer published " + value.slice(0, 8) + "…");
}

test("a browser sign-in's question and address reach the caller, its credential lands here, and nothing returns it", async () => {
	const h = await harness({ steps: [
		{ kind: "notify", event: { type: "auth_url", url: "https://claude.ai/oauth/authorize?code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&state=abc", instructions: "Approve the sign-in in the browser" } },
		{ kind: "prompt", prompt: { type: "manual_code", message: "Paste the redirect address", placeholder: "http://localhost:53692/callback?code=…" } },
		{ kind: "done" },
	] });
	try {
		const started = flow((await h.call({ operation: "login-start", providerId: "scripted", caller: CALLER })).body);
		assert.equal(started.providerId, "scripted");
		assert.equal(started.phase, "waiting_for_input");
		assert.deepEqual(started.waitingFor, ["browser", "input"], "the panel was told to offer neither, or the wrong one");
		assert.equal(started.prompt?.type, "manual_code");
		assert.equal(started.event?.type, "auth_url");
		assert.ok(started.expiresInMs > 0, "a waiting flow reported no deadline");
		assert.ok(started.flowId.length >= 36, "a flow id was not unguessable: " + started.flowId);
		// The address a person has to open stays whole: its code_challenge is a PKCE verifier, not a credential this host
		// holds, and a mask here would break the sign-in the flow is asking for.
		assert.match((started.event as { url?: string }).url ?? "", /code_challenge=E9Melhoa/, "the authorization address was damaged");

		// A second start of the same provider by the same caller is the same flow: two browser addresses for one account and
		// two credentials racing one file entry is worse than answering with the work already running.
		const again = flow((await h.call({ operation: "login-start", providerId: "scripted", caller: CALLER })).body);
		assert.equal(again.flowId, started.flowId, "a repeated start opened a second flow");

		const answered = await h.call({ operation: "login-submit", flowId: started.flowId, caller: CALLER, answer: PASTED });
		assert.equal(answered.body.ok, true, answered.text);
		assert.deepEqual(h.answers(), [PASTED], "the answer did not go to the provider that asked for it");
		assertNoSecrets(answered.text, [PASTED]);
		const done = await settled(h, started.flowId);
		assert.equal(done.storedType, "oauth");
		assert.deepEqual(done.waitingFor, [], "a finished flow still offered a field");
		assert.ok(done.value !== undefined, "a successful flow answered no listing");
		assert.equal(done.expiresInMs, 0);

		// The credential is this account's own file's, in pi's shape, under the modes this host keeps.
		const file = stored(h.authPath) as Record<string, Record<string, unknown>>;
		assert.deepEqual(Object.keys(file), ["scripted"]);
		assert.equal(file.scripted.type, "oauth");
		assert.equal(file.scripted.access, ACCESS);
		assert.equal(file.scripted.refresh, REFRESH);
		assert.equal(statSync(h.authPath).mode & 0o777, 0o600, "the credential file is readable by others");

		// The listing beside it reports the provider configured and shows no token of it.
		const listed = await (await fetch(h.origin + "/v1/providers/auth", { method: "POST", headers: { authorization: "Bearer " + TOKEN, "content-type": "application/json" }, body: JSON.stringify({ operation: "list" }) })).text();
		assertNoSecrets(listed, [ACCESS, REFRESH, PASTED]);
		const row = ((JSON.parse(listed) as { value: Record<string, unknown>[] }).value).find((item) => item.providerId === "scripted");
		assert.equal(row?.storedType, "oauth");
		assert.equal(row?.configured, true);

		// Repeated operations store one credential: the same flow was answered twice, and the file holds one entry.
		const repeat = await h.call({ operation: "login-submit", flowId: started.flowId, caller: CALLER, answer: PASTED });
		assert.equal(refused(repeat.body).code, "flow_not_waiting");
		assert.deepEqual(Object.keys(stored(h.authPath)), ["scripted"], "a repeated answer wrote a second entry");
	} finally { await h.close(); }
});

test("a device flow shows its code; a cancel ends it, reaches the provider's wait, and stores nothing", async () => {
	const h = await harness({ steps: [
		{ kind: "notify", event: { type: "device_code", userCode: CODE, verificationUri: "https://openai.com/device", intervalSeconds: 5, expiresInSeconds: 900 } },
		{ kind: "wait", ms: 60_000 },
	] });
	try {
		const started = flow((await h.call({ operation: "login-start", providerId: "scripted", caller: CALLER })).body);
		assert.equal(started.phase, "waiting_for_browser");
		assert.deepEqual(started.waitingFor, ["browser"], "a device flow asked for an answer it does not take");
		const event = started.event as { userCode?: string; verificationUri?: string; intervalSeconds?: number };
		// A device code is shown on purpose: it is only useful beside the URI and dies with the flow. Masking it would be
		// the bug, not the protection — and RFC 8628's short uppercase pair does not read as a stored secret.
		assert.equal(event.userCode, CODE, "the code a person has to type was masked out of their own screen");
		assert.equal(event.verificationUri, "https://openai.com/device");
		assert.equal(event.intervalSeconds, 5);

		const cancelled = flow((await h.call({ operation: "login-cancel", flowId: started.flowId, caller: CALLER })).body);
		assert.equal(cancelled.phase, "cancelled");
		assert.equal(cancelled.message, "this sign-in was cancelled");
		assert.equal(h.reached().includes("waited"), false, "the provider's own wait outlived its cancel");
		assert.deepEqual(stored(h.authPath), {}, "a cancelled sign-in stored a credential");

		// The ended flow stays readable with the phase it settled into, so a poll arriving late learns what happened.
		assert.equal(flow((await h.call({ operation: "login-poll", flowId: started.flowId, caller: CALLER })).body).phase, "cancelled");
	} finally { await h.close(); }
});

test("the deadline is the host's own bound, and an expired flow stores nothing", async () => {
	// The host's own bound, read from a clock the test moves: fifteen minutes of deadline is asserted by advancing to it,
	// not by waiting it out, and the timer that fires is the same one a deployment arms.
	const clock = virtualClock();
	const h = await harness({ ttlMs: PROVIDER_LOGIN_TTL_MS, keepMs: 40, graceMs: 25, steps: [{ kind: "wait", ms: 60_000 }], clock });
	try {
		const started = flow((await h.call({ operation: "login-start", providerId: "scripted", caller: CALLER })).body);
		assert.equal(started.phase, "running", "a flow with no step yet was reported as something else");
		// What a start reports is what is left of the host's own deadline, the grace it spent waiting already taken
		// off: a caller cannot read one number here and be told to wait a second, longer one there.
		assert.ok(started.expiresInMs > 0 && started.expiresInMs <= PROVIDER_LOGIN_TTL_MS, "the deadline was not the host's bound: " + started.expiresInMs);
		// Nothing has expired yet: the deadline is a bound, not a countdown that fires early.
		assert.equal(flow((await h.call({ operation: "login-poll", flowId: started.flowId, caller: CALLER })).body).phase, "running");
		clock.advance(PROVIDER_LOGIN_TTL_MS);
		// The deadline fired: the flow is ended by this host, and it says so while its readable window is still open.
		const ended = flow((await h.call({ operation: "login-poll", flowId: started.flowId, caller: CALLER })).body);
		assert.equal(ended.phase, "expired", "the host's own deadline did not end the flow");
		assert.equal(ended.expiresInMs, 0, "an ended flow still counted down");
		// Past the readable window there is nothing to follow: the same answer an id that never existed gets, because a
		// caller cannot act on either and has the same next action — start again.
		clock.advance(41);
		const polled = await h.call({ operation: "login-poll", flowId: started.flowId, caller: CALLER });
		assert.equal(polled.body.ok, false, polled.text);
		assert.equal(refused(polled.body).code, "flow_unknown");
		assert.deepEqual(stored(h.authPath), {}, "an expired sign-in stored a credential");
		assert.equal(h.reached().includes("waited"), false, "the provider's wait outlived the host's deadline");
	} finally { await h.close(); }
});

test("a flow answers only the caller that started it, and a stranger is told nothing", async () => {
	const h = await harness({ steps: [
		{ kind: "prompt", prompt: { type: "select", message: "Choose a workspace", options: [{ id: "acc-a", label: "Account A" }, { id: "acc-b", label: "Account B", description: "personal" }] } },
		{ kind: "done" },
	] });
	try {
		const started = flow((await h.call({ operation: "login-start", providerId: "scripted", caller: CALLER })).body);
		assert.equal(started.prompt?.type, "select");
		assert.deepEqual((started.prompt?.options ?? []).map((option) => option.id), ["acc-a", "acc-b"], "a provider's choices were not passed through");

		// With one host bearer shared by every client of an ingress, a guessed id must not be a way into someone else's
		// sign-in — and the refusal must be indistinguishable from an id that never existed, or the guess is confirmed.
		const stranger = await h.call({ operation: "login-poll", flowId: started.flowId, caller: OTHER });
		const unknown = await h.call({ operation: "login-poll", flowId: "00000000-0000-4000-8000-000000000000", caller: OTHER });
		assert.equal(stranger.status, unknown.status, "another caller's flow and no flow at all were told apart");
		assert.equal(stranger.text, unknown.text, "the two refusals differed, so one of them confirms an id");
		assert.equal(stranger.body.ok, false, stranger.text);
		assert.equal(refused(stranger.body).code, "flow_unknown");
		const strangerSubmit = await h.call({ operation: "login-submit", flowId: started.flowId, caller: OTHER, answer: "acc-a" });
		assert.equal(refused(strangerSubmit.body).code, "flow_unknown");
		assert.deepEqual(h.answers(), [], "a stranger's answer reached the provider");

		// The question takes one of its own ids and nothing else: a panel cannot invent a choice a provider did not offer.
		const wrongOption = await h.call({ operation: "login-submit", flowId: started.flowId, caller: CALLER, answer: "acc-c" });
		assert.equal(wrongOption.body.ok, false, wrongOption.text);
		assert.equal(refused(wrongOption.body).code, "answer_invalid");
		const blank = await h.call({ operation: "login-submit", flowId: started.flowId, caller: CALLER, answer: "   " });
		assert.equal(refused(blank.body).code, "answer_invalid");
		const oversized = await h.call({ operation: "login-submit", flowId: started.flowId, caller: CALLER, answer: "a".repeat(9_000) });
		assert.equal(refused(oversized.body).code, "answer_invalid");

		const chosen = flow((await h.call({ operation: "login-submit", flowId: started.flowId, caller: CALLER, answer: "acc-b" })).body);
		assert.equal(chosen.phase, "succeeded");
		assert.equal(chosen.storedType, "oauth");
		assert.deepEqual(h.answers(), ["acc-b"]);

		// An answer to a flow that is not asking is refused as the state it is in, not swallowed.
		const late = await h.call({ operation: "login-submit", flowId: started.flowId, caller: CALLER, answer: "acc-a" });
		assert.equal(late.body.ok, false, late.text);
		assert.equal(refused(late.body).code, "flow_not_waiting");

		// The flow one caller has open is readable by provider, which is how a reloaded panel resumes instead of starting a
		// second sign-in for one account.
		const status = flow((await h.call({ operation: "login-status", providerId: "scripted", caller: CALLER })).body);
		assert.equal(status.phase, "succeeded");
		assert.equal((await h.call({ operation: "login-status", providerId: "scripted", caller: OTHER })).body.ok, false);
	} finally { await h.close(); }
});

test("a provider that withdraws its own question leaves no field open and does not fail the flow", async () => {
	const h = await harness({ steps: [
		{ kind: "notify", event: { type: "auth_url", url: "https://claude.ai/oauth/authorize?state=abc" } },
		{ kind: "withdraw", prompt: { type: "manual_code", message: "Or paste the redirect address" }, afterMs: 60 },
		{ kind: "done" },
	] });
	try {
		const started = flow((await h.call({ operation: "login-start", providerId: "scripted", caller: CALLER })).body);
		assert.equal(started.prompt?.type, "manual_code", "the paste-back question was never offered");
		await new Promise((resolve) => setTimeout(resolve, 250));
		const settled = flow((await h.call({ operation: "login-poll", flowId: started.flowId, caller: CALLER })).body);
		assert.equal(settled.phase, "succeeded", "the provider winning its own race failed the sign-in");
		assert.equal(settled.prompt, undefined, "a withdrawn question stayed offered");
		assert.deepEqual(settled.waitingFor, [], "a withdrawn question left the panel waiting");
		assert.equal(h.reached().includes("withdrawn"), true, "the provider's own abort never reached the bridge");
	} finally { await h.close(); }
});

test("a provider that writes a credential into its own messages is masked, and its error is not forwarded", async () => {
	// Upstream's flows notify progress text and throw messages that can quote a code or a token. Three rules hold here:
	// what this caller typed and what the flow produced are masked by value, anything credential-shaped inside a
	// provider's text is masked by detector, and the provider's own sentence is never published at all.
	const h = await harness({ steps: [
		{ kind: "prompt", prompt: { type: "text", message: "Enter the code shown in your browser" } },
		{ kind: "notify", event: { type: "progress", message: "Waiting on " + TYPED + ", then exchanging " + ACCESS + " for " + REFRESH } },
		{ kind: "fail", error: new Error("token exchange rejected " + TYPED + "; the access token was " + ACCESS) },
	] });
	try {
		const started = flow((await h.call({ operation: "login-start", providerId: "scripted", caller: CALLER })).body);
		const answered = await h.call({ operation: "login-submit", flowId: started.flowId, caller: CALLER, answer: TYPED });
		assertNoSecrets(answered.text, [TYPED]);
		const failed = await settled(h, started.flowId);
		assert.equal(failed.phase, "failed");
		assert.equal(failed.code, "operation_failed");
		// The host's own sentence, not the provider's.
		assert.equal(failed.message, "the provider sign-in failed on this host");
		const published = JSON.stringify(failed);
		assertNoSecrets(published, [TYPED, ACCESS, REFRESH]);
		// A masked value says masking ran, rather than the text having quietly lost it.
		assert.equal(published.includes("•••"), true, "nothing was masked, so a provider's message went out whole");
		assert.deepEqual(stored(h.authPath), {}, "a failed exchange stored a credential");
	} finally { await h.close(); }
});

test("an answer is never published back, not to the caller that gave it", async () => {
	// The one prompt whose answer a person pastes twice is the secret-shaped one: a panel must show that the flow moved on,
	// and never echo what was typed into it — a stored value in an answer is a value a browser keeps.
	const h = await harness({ steps: [
		{ kind: "prompt", prompt: { type: "secret", message: "Enter your API key to finish" } },
		{ kind: "notify", event: { type: "info", message: "Still working", links: [{ url: "https://provider.example/docs", label: "Why this is needed" }] } },
		{ kind: "done" },
	] });
	try {
		const started = flow((await h.call({ operation: "login-start", providerId: "scripted", caller: CALLER })).body);
		assert.equal(started.prompt?.type, "secret");
		const pasted = "sk-" + "a1b2c3d4e5f6g7h8i9j0k1l2";
		const answered = await h.call({ operation: "login-submit", flowId: started.flowId, caller: CALLER, answer: pasted });
		assertNoSecrets(answered.text, [pasted]);
		const done = await settled(h, started.flowId);
		// The flow's own info event, with its link, travels intact: nothing about it is a credential.
		assert.equal((done.event as { links?: { url: string }[] }).links?.[0]?.url, "https://provider.example/docs");
		assert.equal(statSync(h.authPath).mode & 0o777, 0o600);
	} finally { await h.close(); }
});

test("a revoked caller's open flows are dropped, and no other caller's are", async () => {
	const h = await harness({ ttlMs: 60_000, graceMs: 25, steps: [{ kind: "wait", ms: 60_000 }] });
	try {
		const first = flow((await h.call({ operation: "login-start", providerId: "scripted", caller: CALLER })).body);
		// This is what a client ingress issues when the device credential it admitted a caller with stops being valid: the
		// caller can no longer cancel its own flow, and a detached flow nobody can act on can still store a credential.
		const dropped = await h.call({ operation: "login-forget", caller: CALLER });
		assert.equal(dropped.body.ok, true, dropped.text);
		assert.deepEqual((dropped.body as { value?: { dropped?: number } }).value, { dropped: 1 });
		assert.equal((await h.call({ operation: "login-status", providerId: "scripted", caller: CALLER })).body.ok, false, "a revoked caller's flow stayed readable");
		assert.deepEqual(stored(h.authPath), {}, "a revoked caller's flow stored a credential");

		// One caller's revocation says nothing about another's: the operation names a caller, never the host.
		const other = flow((await h.call({ operation: "login-start", providerId: "scripted", caller: OTHER })).body);
		assert.equal((await h.call({ operation: "login-forget", caller: CALLER })).body.ok, true);
		assert.equal(flow((await h.call({ operation: "login-poll", flowId: other.flowId, caller: OTHER })).body).phase, "running");
		assert.equal((await h.call({ operation: "login-poll", flowId: first.flowId, caller: CALLER })).body.ok, false);
	} finally { await h.close(); }
});

test("a host at its limit refuses another flow rather than queueing one nobody waits for", async () => {
	const h = await harness({ maxFlows: 1, graceMs: 25, steps: [{ kind: "wait", ms: 60_000 }] });
	try {
		const first = flow((await h.call({ operation: "login-start", providerId: "scripted", caller: CALLER })).body);
		const second = await h.call({ operation: "login-start", providerId: "scripted", caller: OTHER });
		assert.equal(second.body.ok, false, second.text);
		assert.equal(refused(second.body).code, "too_many_flows");
		assert.equal(h.reached().filter((step) => step === "login").length, 1, "the refused start still ran a provider flow");
		// The refused call created nothing: the first flow is untouched and still answerable.
		assert.equal(flow((await h.call({ operation: "login-poll", flowId: first.flowId, caller: CALLER })).body).phase, "running");
	} finally { await h.close(); }
});

test("a provider this host does not serve, or that declares no flow, is refused before anything runs", async () => {
	const h = await harness({ steps: [{ kind: "done" }] });
	try {
		const unknown = await h.call({ operation: "login-start", providerId: "no-such-provider", caller: CALLER });
		assert.equal(unknown.body.ok, false, unknown.text);
		assert.equal(refused(unknown.body).code, "unknown_provider");
		assert.deepEqual(h.reached(), [], "an unknown provider reached a flow");
		assert.deepEqual(stored(h.authPath), {}, "a refused start wrote the file");

		const blank = await h.call({ operation: "login-start", providerId: "   ", caller: CALLER });
		assert.equal(blank.body.ok, false, blank.text);
		assert.equal((await h.call({ operation: "login-start", providerId: "scripted", caller: "" })).body.ok, false);
		assert.equal((await h.call({ operation: "login-poll", flowId: "", caller: CALLER })).body.ok, false);
		// A body the route validator rejects never reaches a service: no operation, no flow, no write.
		const malformed = await fetch(h.origin + "/v1/providers/login", { method: "POST", headers: { authorization: "Bearer " + TOKEN, "content-type": "application/json" }, body: JSON.stringify({ providerId: "scripted", caller: CALLER }) });
		assert.equal(malformed.status, 400, "an operation-less body was accepted");
		const unauthenticated = await fetch(h.origin + "/v1/providers/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ operation: "login-start", providerId: "scripted", caller: CALLER }) });
		assert.equal(unauthenticated.status, 401);
	} finally { await h.close(); }
});

test("a gateway that serves no sign-in capability states the deployment's limit, not a retryable fault", async () => {
	// An SSH gateway, or one composed without the service, answers unsupported_operation: the same named limit every other
	// unserved capability gets, so a caller withholds the control instead of offering a button that can only fail.
	const h = await harness({ serveLogins: false, steps: [{ kind: "done" }] });
	try {
		const started = await h.call({ operation: "login-start", providerId: "scripted", caller: CALLER });
		assert.equal(started.status, 200, started.text);
		assert.equal(refused(started.body).code, "unsupported_operation");
		assert.match(refused(started.body).message, /no provider sign-in capability/);
		// The listing surface beside it still answers, so the limit is the flow and not the provider account.
		const listed = await fetch(h.origin + "/v1/providers/auth", { method: "POST", headers: { authorization: "Bearer " + TOKEN, "content-type": "application/json" }, body: JSON.stringify({ operation: "list" }) });
		assert.equal(listed.status, 200);
	} finally { await h.close(); }
});

/**
 * Reading a caller's provider by name, rather than by the id it last saw.
 *
 * An ended flow stays readable so a late poll learns what happened to it, and a caller can start a fresh sign-in while
 * that record is still held — the dedup on a start only joins a flow that is still open. So the provider read has to
 * prefer the open one, or a panel that came back for its flow would be shown the outcome of the previous attempt and
 * never follow the live one. Where nothing is open, the record that ended most recently is the outcome worth reporting.
 */
test("a provider read answers the flow that is open, and only reports an ended one when none is", async () => {
	const h = await harness({ graceMs: 25, steps: [{ kind: "wait", ms: 60_000 }] });
	try {
		const first = flow((await h.call({ operation: "login-start", providerId: "scripted", caller: CALLER })).body);
		const cancelled = flow((await h.call({ operation: "login-cancel", flowId: first.flowId, caller: CALLER })).body);
		assert.equal(cancelled.phase, "cancelled");
		// The readable window, stated first: an ended flow is still reportable by provider.
		assert.equal(flow((await h.call({ operation: "login-status", providerId: "scripted", caller: CALLER })).body).flowId, first.flowId);

		const second = flow((await h.call({ operation: "login-start", providerId: "scripted", caller: CALLER })).body);
		assert.notEqual(second.flowId, first.flowId, "a start after an ended flow joined the record instead of opening a sign-in");
		const reopened = flow((await h.call({ operation: "login-status", providerId: "scripted", caller: CALLER })).body);
		assert.equal(reopened.flowId, second.flowId, "the open flow was hidden by the older ended record");
		assert.equal(reopened.phase, "running", "the flow this caller has open was reported as over");
		// A repeated start while that one is open is still the same flow, not a third browser address.
		assert.equal(flow((await h.call({ operation: "login-start", providerId: "scripted", caller: CALLER })).body).flowId, second.flowId);

		// With both ended, the most recent outcome is the one worth reporting: a caller that comes back late asks what its
		// last sign-in did, not what an attempt it already saw settled into long ago.
		assert.equal(flow((await h.call({ operation: "login-cancel", flowId: second.flowId, caller: CALLER })).body).phase, "cancelled");
		assert.equal(flow((await h.call({ operation: "login-status", providerId: "scripted", caller: CALLER })).body).flowId, second.flowId);
	} finally { await h.close(); }
});

/**
 * The account directory a sign-in is the first to touch.
 *
 * A provider asks for this installation's id while it builds the authorization it sends — before any credential exists —
 * so on a host that has never signed in that write is the agent directory's first write, and it happens ahead of the
 * credential file's own step, which creates the directory only inside its lock. Getting this wrong is not a naming
 * detail: an OpenAI-shaped flow fails on a fresh account before it produces anything.
 */
test("a sign-in that asks for the installation id creates the agent directory before it stores anything", async () => {
	const h = await harness({ asksForDeviceId: true, steps: [{ kind: "done" }] });
	try {
		const started = flow((await h.call({ operation: "login-start", providerId: "scripted", caller: CALLER })).body);
		assert.equal(started.phase, "succeeded", JSON.stringify(started));
		const id = h.deviceId();
		assert.match(id ?? "", /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, "the provider was handed no usable installation id");
		const path = join(h.agentDir, "installation-id");
		assert.equal(readFileSync(path, "utf8").trim(), id, "the id the provider was given is not the one this host recorded");
		assert.equal(statSync(path).mode & 0o777, 0o600, "the installation id was written readable by others");
		assert.equal(statSync(h.agentDir).mode & 0o777, 0o700, "a directory this host created holds an account credential, so it is restricted");
	} finally { await h.close(); }
});

test("a sign-in adopts the pi id this account already has instead of naming a second installation", async () => {
	const h = await harness({ asksForDeviceId: true, steps: [{ kind: "done" }] });
	try {
		const first = flow((await h.call({ operation: "login-start", providerId: "scripted", caller: CALLER })).body);
		assert.equal(first.phase, "succeeded", JSON.stringify(first));
		const mine = h.deviceId();
		assert.ok(mine !== undefined, "the first sign-in was handed no installation id");
		// The CLI's document appears between two sign-ins, as it does on an account that runs both.
		await writeFile(join(h.agentDir, "settings.json"), JSON.stringify({ deviceId: "0f0f0f0f-1111-4111-8111-222222222222" }), "utf8");
		const second = flow((await h.call({ operation: "login-start", providerId: "scripted", caller: OTHER })).body);
		assert.equal(second.phase, "succeeded", JSON.stringify(second));
		assert.equal(h.deviceId(), "0f0f0f0f-1111-4111-8111-222222222222", "a host holding the CLI's id named a second installation");
		assert.equal(readFileSync(join(h.agentDir, "installation-id"), "utf8").trim(), mine, "the id this host recorded was rewritten");
	} finally { await h.close(); }
});

test("stopping this host ends every flow it holds, each with its own provider abort", async () => {
	const h = await harness({ graceMs: 25, steps: [{ kind: "wait", ms: 60_000 }] });
	const first = flow((await h.call({ operation: "login-start", providerId: "scripted", caller: CALLER })).body);
	const second = flow((await h.call({ operation: "login-start", providerId: "scripted", caller: OTHER })).body);
	assert.notEqual(first.flowId, second.flowId, "two callers shared one flow");
	await h.close();
	// The provider's own await saw the abort for both, which is what a real device poll needs in order to stop.
	assert.deepEqual(stored(h.authPath), {}, "a stopped host stored a credential");
	// And nothing is left listening: the process would stay alive on a flow the shutdown did not end.
	assert.ok(PROVIDER_LOGIN_KEEP_MS > 0);
});
