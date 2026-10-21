/**
 * The real system ticket 05's acceptance journey runs against: one conversation long enough that its rail must page, a
 * user message the compaction dropped from the active window, and a fork that inherits the long conversation's
 * committed history — over one SQLite store, one real Backend and the real client ingress, which serves the production
 * Web build on its own origin.
 *
 * The seed runs **before** the Backend opens the file, because the Backend attaches every conversation at boot and a
 * second writer on the same store would be a second session rather than a fixture. Every entry is written through the
 * runtime's own public transaction seam, the fork is the same creation seam a user's branch goes through, and the
 * compaction is the runtime's own head marker. Nothing here fabricates a conversation record or patches the engine.
 *
 * The model endpoint is the driver's own controlled server, named in `HEPI_HN05_ENDPOINT`: the one run this fixture
 * serves is the driver's, and a turn the driver sends is answered by it rather than by a paid provider.
 *
 * Usage: node scripts/history-navigation-acceptance-fixture.ts   (driven by apps/web/e2e/history/ux-history-navigation-acceptance.ts)
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AssistantEntry, CompactionEntry, UserEntry, type EntryId } from "@earendil-works/pi-durable";
import { createClientIngress } from "@hepi/gateway/ingress";
import { createBackendServer } from "../src/server.ts";
import { customProviderFromEnv } from "../src/provider-config.ts";
import { createConversationOperations, WorkspaceDoc } from "../src/conversation-operations.ts";
import { openServerHarness } from "../src/harness.ts";

const base = process.env.HEPI_HN05_FIXTURE ?? "";
const dbPath = process.env.HEPI_HN05_DB ?? "";
const backendPort = Number(process.env.HEPI_HN05_BACKEND_PORT ?? 44251);
const ingressPort = Number(process.env.HEPI_HN05_INGRESS_PORT ?? 44252);
const token = process.env.HEPI_HN05_AUTH ?? "ux-history-navigation-token";
const webLogin = process.env.HEPI_HN05_WEB_LOGIN ?? "ux-history-navigation-login";
const model = process.env.HEPI_HN05_MODEL ?? "controlled-history-1";
const endpoint = process.env.HEPI_HN05_ENDPOINT ?? "";
const staticDir = process.env.HEPI_HN05_WEB ?? "";
if (!base || !dbPath || !endpoint) throw new Error("Set HEPI_HN05_FIXTURE, HEPI_HN05_DB and HEPI_HN05_ENDPOINT");

/**
 * Turns of the long conversation. Two entries each, far past the fifty-message window, and **more user anchors than
 * one outline page holds** (the contract's default is 100): a history that fitted in a single page would leave the
 * rail's own continuation — and the one-read-per-activation rule that governs it — unexercised against a real store.
 */
const TURNS = 130;
/**
 * The turn the compaction's head marker keeps. Everything committed before it stays a committed anchor — spec decision
 * 2's whole point — while the active window is led by the summary below it, so a rail that read the window would lose
 * those anchors and a rail that reads history still lists them.
 */
const KEPT_TURN = 20;
/** The turn the fork branches at, deep enough that the branch inherits anchors the window does not carry. */
const FORK_TURN = 40;

const home = join(base, "backend-home");
const root = join(base, "workspace");
await mkdir(home, { recursive: true });
await mkdir(root, { recursive: true });

const custom = customProviderFromEnv({ HEPI_PROVIDER: "magpie", HEPI_MODEL: model, HEPI_PROVIDER_BASE_URL: endpoint + "/v1", HEPI_PROVIDER_API_KEY: "controlled-key" });
if (custom === undefined) throw new Error("the controlled provider configuration was rejected");

const assistantMessage = (text: string) => ({
  role: "assistant" as const, content: [{ type: "text" as const, text }], api: "magpie" as const, provider: "magpie", model,
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  stopReason: "stop" as const, timestamp: 0,
});

/** What the driver reads back: the identities it opens and the entry ids it expects the rail to list. */
type Seed = {
  longId: string;
  forkId: string;
  /** The oldest user entry: the one the compaction hides from the active window. */
  compactedEntryId: string;
  summaryEntryId: string;
  /** The user entry the fork branches at. */
  forkPointEntryId: string;
  /** The unique phrase the oldest (compacted) turn carries, so a landing can be read off the screen. */
  compactedText: string;
  /** The unique phrase the fork point's turn carries. */
  forkPointText: string;
  /** Every committed user entry of the long conversation, oldest first — the anchors the rail must list. */
  userEntryIds: string[];
};

async function seed(): Promise<Seed> {
  const seeding = await openServerHarness(dbPath, custom!.defaultModel, custom!.models, undefined, { startPaused: true });
  const operations = createConversationOperations(seeding.harness);
  const harness = seeding.harness;

  const long = await operations.spawn({ requestId: "seed-long", ownership: { kind: "ownerless" }, workspaceId: "local", ...(custom!.defaultModel === undefined ? {} : { agent: { model: custom!.defaultModel } }) });
  const longId = String(long.conversationId);
  await harness.commit(async (tx) => { (await tx.doc(WorkspaceDoc, long.conversation.id)).workspaceId = "local"; }, BACKGROUND_CONTEXT);

  const userEntryIds: string[] = [];
  let kept: { id: EntryId } | undefined;
  let forkPoint: string | undefined;
  const compactedText = "the compacted opening question, which only the committed history still carries";
  const forkPointText = "the question the branch was taken at";
  for (let turn = 1; turn <= TURNS; turn += 1) {
    const text = turn === 1 ? compactedText : turn === FORK_TURN ? forkPointText : "turn " + turn + " of the long conversation";
    const user = await harness.commit(tx => tx.appendEntry(UserEntry, long.conversation.id, { model: [{ role: "user", content: text, timestamp: 0 }] }), BACKGROUND_CONTEXT);
    userEntryIds.push(String(user.id));
    const answer = await harness.commit(tx => tx.appendEntry(AssistantEntry, long.conversation.id, { model: [assistantMessage("answer " + turn + ": the workspace was read and the question answered")] }), BACKGROUND_CONTEXT);
    if (turn === KEPT_TURN) kept = { id: answer.id as EntryId };
    if (turn === FORK_TURN) forkPoint = String(user.id);
  }
  if (kept === undefined || forkPoint === undefined) throw new Error("the seed did not reach the kept turn and the fork point");

  // The compaction: a real head marker over the kept entry. The summary is a user message the user never wrote, which
  // is exactly the traffic the outline must not turn into an anchor (spec decision 1).
  const summary = await harness.commit(tx => tx.appendEntry(CompactionEntry, long.conversation.id, {
    head: kept!.id, model: [{ role: "user", content: "summary of the compacted prefix", timestamp: 0 }], data: { reason: "manual" },
  }), BACKGROUND_CONTEXT);

  // The fork, through the one creation seam: it inherits the source's committed history up to the chosen entry.
  const forked = await operations.spawn({
    requestId: "seed-fork",
    ownership: { kind: "ownerless" },
    source: { conversationId: longId, entryId: forkPoint },
    workspaceId: "local",
    ...(custom!.defaultModel === undefined ? {} : { agent: { model: custom!.defaultModel } }),
  });
  await harness.commit(async (tx) => { (await tx.doc(WorkspaceDoc, forked.conversation.id)).workspaceId = "local"; }, BACKGROUND_CONTEXT);
  await seeding.close();

  const seed: Seed = {
    longId, forkId: String(forked.conversationId),
    compactedEntryId: userEntryIds[0]!, summaryEntryId: String(summary.id),
    forkPointEntryId: forkPoint, compactedText, forkPointText, userEntryIds,
  };
  console.log("HEPI_HN05_SEED " + JSON.stringify(seed));
  return seed;
}

await seed();

const backend = await createBackendServer({ dbPath, authToken: token, models: custom.models, defaultModel: custom.defaultModel });
await new Promise<void>((resolveListen) => backend.server.listen(backendPort, "127.0.0.1", resolveListen));
const ingress = createClientIngress({
  backend: { origin: "http://127.0.0.1:" + backendPort, serviceToken: token },
  webLoginToken: webLogin,
  ...(staticDir === "" ? {} : { staticDir }),
});
await new Promise<void>((resolveListen) => ingress.server.listen(ingressPort, "127.0.0.1", resolveListen));
console.log("hepi history-navigation fixture: backend http://127.0.0.1:" + backendPort + ", ingress http://127.0.0.1:" + ingressPort);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => { void ingress.close().then(() => backend.close()).then(() => process.exit(0)); });
}
