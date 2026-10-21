import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createJiti } from "jiti";

const source = (name: string): string => readFileSync(new URL(name, import.meta.url), "utf8");
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });

/** One locale's messages, as the plugin the module exports states them. */
function messagesOf(module: Record<string, unknown>, locale: string): Record<string, string> {
  const plugin = Object.values(module).find((value): value is { messages: Record<string, string> } =>
    typeof value === "object" && value !== null && "messages" in value);
  assert.ok(plugin, locale + " exports a locale plugin with its messages");
  return plugin.messages;
}

/**
 * The subtree control surface's structural promises, checked where they are made.
 *
 * The browser journey proves the behaviour; what belongs in a node check is the shape the journey cannot see from the
 * outside: which module is allowed to reach the subtree routes at all, that a control never costs a connection per row,
 * and that a surface in one language does not show a raw key the other two never got.
 */

const SURFACE = "./SubtreeControlPanel.tsx";
const TREE = "./AgentSessionPanel.tsx";

test("only the subtree surface reaches the subtree routes, and the global sidebar never does", () => {
  assert.match(source(SURFACE), /subtreeControlFrom|subtreeReadFrom/, "the control panel asks the subtree seam");
  // The child tree lists conversations; it is not the thing that controls them.
  for (const [file, text] of [[TREE, source(TREE)], ["./SessionSidebar.tsx", source("./SessionSidebar.tsx")], ["./SessionTree.tsx", source("./SessionTree.tsx")]] as const) {
    assert.equal(/subtree/i.test(text), false, file + " controls no subtree: it is navigation");
  }
  // The dock-level entry is mounted by the shell alone, and only beside the tree it names.
  const shell = source("./AppShell.tsx");
  assert.equal((shell.match(/<SubtreeControlPanel/g) ?? []).length, 1, "one subtree surface, mounted where the child tree is");
  assert.match(shell, /activeTopPanel === "agents"[\s\S]*<AgentSessionPanel[\s\S]*<SubtreeControlPanel/, "it sits below the tree, not instead of it");
});

test("controlling a subtree costs no connection per child and reads no per-row state", () => {
  const text = source(SURFACE);
  assert.equal(/new EventSource|\/events/.test(text), false, "no stream is opened for a row");
  assert.equal(/\/state/.test(text), false, "no per-conversation state read");
  // The refresh a lost race is settled with is the Backend's durable record, not a poll this surface started.
  assert.equal(/setInterval|setTimeout\(/.test(text), false, "no scheduler of its own");
  assert.match(text, /subtreeReadFrom/, "the refresh reads the request back by its id");
});

test("nothing is written before the user confirms, and a lost answer is read back rather than re-sent", () => {
  const text = source(SURFACE);
  const confirm = text.slice(text.indexOf("const confirm = ()"), text.indexOf("const toggle ="));
  assert.match(confirm, /subtreeConfirm\(attemptsRef\.current/, "the attempt is minted only from the confirmation");
  assert.match(confirm, /run\(subtreeConfirm\(/, "and the write is reachable only from it");
  assert.equal(/onAction|useEffect\([^)]*run\(/.test(text), false, "no effect and no prop fires a subtree control on its own");
  // A cancelled confirmation and a refused request both leave the durable state exactly as it was.
  assert.match(text, /setPhase\(\{ step: "idle" \}\)/, "cancel returns to the idle surface");
  assert.match(text, /data-subtree-lost/, "and an answer that never arrived is stated as such");
  // The two columns are the two facts: what the request recorded, and what the child is doing now.
  assert.match(text, /subtree\.col\.requested/, "the recorded outcome has its own column");
  assert.match(text, /subtree\.col\.now/, "the current row has its own");
});

test("a retry speaks for the confirmed decision, never for the listing shown now", () => {
  // The seam that makes this true is that a send and a read both take the whole attempt: nothing in the panel can hand
  // them a selection re-derived from the current `descendants` prop, which is the race that silently widened a narrowed
  // subtree when an answer was lost and the poll moved underneath it.
  const seam = source("../lib/subtree-control.ts");
  assert.match(seam, /subtreeControlFrom\(client: WorkbenchClient, attempt: SubtreeAttempt\)/, "a send takes an attempt, not a request the caller assembles");
  assert.match(seam, /subtreeReadFrom\(client: WorkbenchClient, attempt: SubtreeAttempt\)/, "so does its read-back");

  const text = source(SURFACE);
  // `selected` is derived from the live listing; it may appear at the confirmation and in the confirmation's own
  // rendering, and nowhere that a retry or a read reaches.
  const uses = [...text.matchAll(/\bselected\b/g)].length;
  assert.ok(uses > 0, "the panel still derives a proposal from the listing");
  const run = text.slice(text.indexOf("const run = useCallback"), text.indexOf("const confirm = ()"));
  assert.equal(/\bselected\b/.test(run), false, "no send, read or release consults the selection shown now");
  assert.match(run, /subtreeControlFrom\(client, attempt\)/, "the write carries the frozen attempt");
  assert.match(run, /subtreeReadFrom\(client, attempt\)/, "and the read resolves that same attempt");
  // A resume is offered from the attempt the phase holds — with no second confirmation, which was already given. Both
  // places that offer one read it from the attempt, never from a fresh confirmation.
  assert.match(text, /void run\(phase\.attempt\)/, "a lost answer resumes the attempt it was made under");
  assert.match(text, /void run\(shown\.attempt\)/, "and so does one an unfinished read left standing");
  assert.equal((text.match(/data-subtree-resume/g) ?? []).length, (text.match(/void run\((?:phase|shown)\.attempt\)/g) ?? []).length, "every resume button runs an attempt");
});

test("a settled attempt is released on both paths that can settle it", () => {
  // A request ends two ways: the write answered, or a **read-back** states completion — which is where a lost race
  // actually settles, with no write of ours ever answering. A release wired to only the first leaves a finished capture
  // held, and the next identical decision is then answered from that old capture: children shown as controlled while
  // nothing was reached.
  const text = source(SURFACE);
  const run = text.slice(text.indexOf("const run = useCallback"), text.indexOf("/**", text.indexOf("const run = useCallback")));
  const read = text.slice(text.indexOf("const readBack = useCallback"), text.indexOf("const confirm = ()"));
  assert.match(run, /view\.status === "completed"\) release\(attempt\)/, "the write path releases a completed attempt");
  assert.match(read, /view\.status === "completed"\) release\(attempt\)/, "and so does the read-back that states completion");
  assert.equal(/status !== "completed"[\s\S]{0,400}release\(/.test(read), false, "an unfinished read keeps the attempt");
  const seam = source("../lib/subtree-control.ts");
  assert.match(seam, /export function subtreeRelease\(attempts: SubtreeAttempts, attempt: SubtreeAttempt\)/, "one helper, keyed by the attempt itself");
  assert.match(seam, /subtreeSettled\(attempts, attempt\.key\)/, "releasing is the key the decision was recorded under");
});

test("every subtree word the surface asks for exists in every locale", async () => {
  const texts = ["./SubtreeControlPanel.tsx", "../lib/subtree-control.ts"].map(source).join("\n");
  const asked = [...texts.matchAll(/"subtree\.[a-zA-Z.]+"/g)].map((match) => match[0].replace(/"/g, ""));
  const keys = new Set(asked.filter((key) => !key.endsWith(".")));
  assert.ok(keys.size >= 20, "the surface asks for a real vocabulary, found " + keys.size);

  const locales = { en: "../lib/i18n/messages/en.ts", "zh-CN": "../lib/i18n/messages/zh-CN.ts", "zh-TW": "../lib/i18n/messages/zh-TW.ts" };
  const held: Record<string, Set<string>> = {};
  const byLocale: Record<string, string[]> = {};
  for (const [locale, path] of Object.entries(locales)) {
    const module = await jiti.import<Record<string, unknown>>(path);
    byLocale[locale] = Object.keys(messagesOf(module, locale));
    held[locale] = new Set(byLocale[locale]);
  }
  for (const locale of Object.keys(locales)) {
    const missing = [...keys].filter((key) => !held[locale].has(key));
    assert.deepEqual(missing, [], locale + " states every subtree word the surface asks for");
  }
  // Every outcome the Backend can record has a word in every locale, and the surface reaches them by name rather than
  // mapping one onto a neighbour: an outcome with no word is passed through as the Backend states it.
  assert.match(texts, /"subtree\.outcome\." \+ status/, "an outcome is looked up by the Backend's own name");
  assert.match(texts, /word === key \? status : word/, "and an unknown one keeps that name instead of a nearby word");
  const STATUSES = ["accepted", "already-settled", "conflict", "held", "not-found", "pending", "refused", "stopping"];
  for (const locale of Object.keys(locales)) {
    const outcomes = byLocale[locale].filter((key) => key.startsWith("subtree.outcome.")).map((key) => key.slice("subtree.outcome.".length)).sort();
    assert.deepEqual(outcomes, [...STATUSES].sort(), locale + " names every outcome the Backend can record");
  }
  // Both actions are named wherever the surface states one, so a confirmation never says "undefined".
  assert.equal((texts.match(/subtree\.action\." \+ (?:phase|view)\.action/g) ?? []).length, 3, "both actions are named in every place the surface states them");
});
