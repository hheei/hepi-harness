/**
 * Shared helpers for the audit performance probes.
 *
 * Research-only: these scripts never write business code, never touch the production store, and every probe owns its
 * own temp directory, SQLite file and (when it needs one) port. Runtime output — logs, result JSON, temp stores — goes
 * under the git-ignored `.dev/research-performance/`; only the scripts and the report are versionable.
 *
 * Module resolution: the repository root has no `node_modules` (pnpm workspaces install into `apps/*`), so a script
 * under `.scratch/` cannot resolve `@hepi/*` by walking up. `lib/register.mjs` installs a resolve hook that retries
 * a failed bare specifier from `apps/server`'s package context — no symlink, no absolute local path in any artifact.
 * Run every probe as: `node --import ./lib/register.mjs <probe>.mjs`.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

/** Repository root, derived from this file's own location (`<root>/.scratch/development-audit/perf-probes/lib`). */
export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
/** Git-ignored home of every runtime artifact these probes produce. */
export const outputRoot = join(repoRoot, ".dev", "research-performance");
const require = createRequire(join(repoRoot, "apps", "server", "package.json"));

/** Absolute path of one installed package's file, resolved from `apps/server`'s dependency tree. */
export function packageFile(specifier, relative) {
  return join(dirname(require.resolve(specifier + "/package.json")), relative);
}

export const round = (value) => Math.round(value * 100) / 100;
export const kib = (bytes) => round(bytes / 1024);
export const mib = (bytes) => round(bytes / (1024 * 1024));

/** Time one async call, in milliseconds. */
export async function timed(fn) {
  const started = performance.now();
  const value = await fn();
  return { value, ms: round(performance.now() - started) };
}

/** A temp directory this probe owns, under the git-ignored output root; removed unless HEPI_PROBE_KEEP=1. */
export async function scratchDir(prefix) {
  mkdirSync(outputRoot, { recursive: true });
  const dir = await mkdtemp(join(outputRoot, "tmp-" + prefix));
  return { dir, cleanup: async () => { if (process.env.HEPI_PROBE_KEEP !== "1") await rm(dir, { recursive: true, force: true }); } };
}

export const headers = (token) => ({ authorization: "Bearer " + token, "content-type": "application/json" });

/** One HTTP read with its status, the byte length of the body, and the wall time. */
export async function readJson(url, token) {
  const started = performance.now();
  const response = await fetch(url, { headers: headers(token) });
  const text = await response.text();
  const ms = round(performance.now() - started);
  let body;
  try { body = JSON.parse(text); } catch { body = undefined; }
  return { status: response.status, bytes: Buffer.byteLength(text), ms, body, text };
}

/** Write one probe's raw result beside its log, under the git-ignored output root. */
export function report(file, payload) {
  const dir = join(outputRoot, "results");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, file);
  writeFileSync(path, JSON.stringify(payload, null, 2) + "\n");
  return path;
}

/**
 * Submit one turn through the real route and wait for an **observed** settlement, never a fixed sleep.
 *
 * Settlement is read from the contract itself: the backend's state carries the submission projections, so a
 * projection for this requestId that reached `done` (with the answer entry it settled by) or `unanswered` is the
 * fact that the turn ended. The returned record names what was observed, so a probe never interprets a merely
 * accepted submission as a settled turn.
 */
export async function submitAndSettle(origin, token, conversationId, requestId, text, options = {}) {
  const deadlineMs = options.deadlineMs ?? 30_000;
  const started = performance.now();
  // The baseline is read **before** the submission, so "the transcript advanced" is an observation and not a guess:
  // a newest entry that was not there at accept time, with the run no longer busy, is the settlement fact. A window
  // is bounded, so the submitted entry itself may never be inside it. A fast scripted provider can finish the whole
  // turn before the first poll, so the baseline must be taken before the POST, not after it.
  const before = await readJson(origin + "/api/conversations/" + conversationId + "/state", token);
  const baselineNewestId = before.status === 200 ? before.body.entries?.at(-1)?.id ?? null : null;
  const baselineRevision = before.status === 200 ? before.body.revision ?? null : null;
  const accepted = await fetch(origin + "/api/conversations/" + conversationId + "/messages", {
    method: "POST", headers: headers(token), body: JSON.stringify({ protocol: "hepi.v1", type: "conversation.submit", requestId, text }),
  });
  const acceptedBody = await accepted.text();
  const observations = [];
  let settled = null;
  let state;
  let sawBusy = false;
  let askedId;
  while (performance.now() - started < deadlineMs) {
    state = await readJson(origin + "/api/conversations/" + conversationId + "/state", token);
    const projections = state.status === 200 && Array.isArray(state.body.submissions) ? state.body.submissions : [];
    const mine = projections.find((entry) => entry.requestId === requestId || entry.submissionId === requestId);
    // A settlement removes its projection ("its committed entry represents it"), so the observed facts are the
    // committed user entry for this text, a run that is no longer busy, and an assistant entry appended after it.
    const entries = state.status === 200 ? state.body.entries ?? [] : [];
    const asked = entries.find((entry) => entry.role === "user" && entry.text === text);
    const newest = entries.at(-1);
    if (state.status === 200 && state.body.busy === true) sawBusy = true;
    askedId = asked?.id ?? mine?.entryId ?? askedId;
    // The window is bounded, so the submitted entry can be outside it; the run having been observed live and then
    // ended with an assistant answer is the settlement fact that does not depend on the window carrying it.
    const advanced = newest !== undefined && String(newest.id) !== String(baselineNewestId ?? "");
    const answered = state.status === 200 && state.body.busy === false && advanced && (newest.role === "assistant" || sawBusy);
    observations.push({ busy: state.status === 200 ? state.body.busy : undefined, projectionStatus: mine?.status, askedEntryId: asked?.id ?? mine?.entryId, newestEntryId: newest?.id, newestRole: newest?.role });
    if (answered) { settled = { kind: "answered", entryId: askedId ?? null, answerId: newest.id, sawBusy, baselineNewestId, baselineRevision, revision: state.body.revision ?? null }; break; }
    if (mine !== undefined && mine.status === "unanswered") { settled = { kind: "unanswered", entryId: mine.entryId, reason: mine.reason }; break; }
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  return { acceptedStatus: accepted.status, acceptedBytes: Buffer.byteLength(acceptedBody), settled, observations: observations.length, observationTail: observations.slice(-8), waitedMs: round(performance.now() - started), lastObservation: observations.at(-1) };
}

/** The conversation's own active entries as the runtime holds them, read from a paused harness on the same store. */
export async function scanActive(openServerHarness, dbPath, conversationId, model, context) {
  const harness = await openServerHarness(dbPath, model, undefined, undefined, { startPaused: true });
  try {
    const view = await harness.harness.commit((tx) => tx.scanEntries({ conversationId: Number(conversationId) }, 10_000, undefined), context);
    return view.items.map((entry) => ({ id: String(entry.id), kind: entry.kind, role: entry.model?.[0]?.role, textBytes: Buffer.byteLength(JSON.stringify(entry.model?.[0]?.content ?? "")) }));
  } finally {
    await harness.close();
  }
}

/** `{port, origin, close}` for one ephemeral listener owned by this probe. */
export async function listen(server) {
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  return { port: address.port, origin: "http://127.0.0.1:" + address.port };
}
