/**
 * Browser regression for ticket 03c: the conversation-scoped MCP tools shown inside Settings › Extensions.
 *
 * It bundles `ux-mcp-tool-states.fixture.tsx` with the workspace's own esbuild, serves the build from a temporary
 * directory outside the repository on 127.0.0.1:43135 (override with HEPI_UX03C_PORT), and drives it with the installed
 * Playwright. The fixture mounts the production `ExtensionsConfig` with only its network boundary replaced, so what is
 * asserted is the panel's own decision: which states it states, what it asks the host for and when, and what it writes.
 *
 * What it asserts:
 * - opening the panel asks **no** server for its tools: the only request is the conversation's own state read, and a
 *   server's tools appear only after that server's own press (ticket 03c's central rule);
 * - the four states are stated separately — a listed tool that was never selected reads exposed but not selected, a
 *   granted one reads selected and available, and the panel's own machine-readable state carries no credential, entry
 *   value or host path;
 * - one listing's refusal is that server's own named refusal (`needs-auth`), not an empty list and not another server's;
 * - a grant writes exactly one server's whole set through the seam, and a revocation writes the empty set, which asks
 *   nothing of a host;
 * - switching the extension above the block re-reads the conversation, so "currently available" cannot keep saying yes
 *   to a selection the person just removed, and restoring it makes the grants available again;
 * - switching **conversation** while a listing or a write is still in flight leaves nothing of the old conversation's
 *   answer on the new one - no listing, no refusal, no grant - and the next checkbox derives the new conversation's set;
 * - a conversation bound to no workspace states that limit before any server's.
 *
 * Usage: node apps/web/e2e/mcp-skills/ux-mcp-tool-states.ts [--keep]
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, "..", "..");

/**
 * The panel's own machine-readable projection, as this driver reads it off `data-mcp-state`.
 *
 * The component states it as a plain record (`mcpPanelState`), because it is the panel's own view and not a transport
 * contract; a driver that asserts on fields names those fields here, which is the shape its claims are about.
 */
/** One request the fixture recorded at its network boundary: the method, the address and the body it carried. */
interface Recorded {
  readonly method: string;
  readonly url: string;
  readonly body: unknown;
}

interface PanelToolRow {
  readonly server: string;
  readonly tool: string;
  readonly configured: boolean;
  readonly exposed: boolean;
  readonly selected: boolean;
  readonly available: boolean;
  readonly hidden?: boolean;
  readonly configUnknown?: boolean;
  readonly availableUnknown?: boolean;
  readonly limitedBy?: string;
}
interface PanelServer {
  readonly server: string;
  readonly enabled?: boolean;
  readonly configured?: boolean;
}
interface PanelGrant {
  readonly server: string;
  readonly tool: string;
}
interface PanelListing {
  readonly server: string;
  readonly carried: number;
  readonly total?: number;
}
interface PanelState {
  readonly conversationId: string;
  readonly extensionSelected: boolean;
  readonly workspaceBound: boolean;
  readonly serversKnown: boolean;
  readonly serversRefusal?: string;
  readonly tools: readonly PanelToolRow[];
  readonly servers: readonly PanelServer[];
  readonly grants: readonly PanelGrant[];
  readonly listings: readonly PanelListing[];
}
const keep = process.argv.includes("--keep");
const port = Number(process.env.HEPI_UX03C_PORT ?? 43135);

const failures: string[] = [];
function check(condition: boolean, message: string) {
  if (condition) { console.log("  ok  " + message); return; }
  failures.push(message);
  console.log("  FAIL " + message);
}

const contentTypes: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
const buildDir = await mkdtemp(join(tmpdir(), "hepi-ux03c-"));
const { build } = await import("esbuild");
await build({
  entryPoints: [join(here, "ux-mcp-tool-states.fixture.tsx")],
  outdir: buildDir,
  bundle: true,
  format: "esm",
  jsx: "automatic",
  tsconfig: join(webRoot, "tsconfig.json"),
  define: { "process.env.NODE_ENV": "\"production\"" },
  logLevel: "warning",
});
await writeFile(join(buildDir, "index.html"), [
  "<!doctype html>",
  "<html lang=\"en\"><head><meta charset=\"utf-8\"><title>ux-03c</title>",
  "<link rel=\"stylesheet\" href=\"./ux-mcp-tool-states.fixture.css\">",
  "</head><body><div id=\"root\"></div>",
  "<script type=\"module\" src=\"./ux-mcp-tool-states.fixture.js\"></script>",
  "</body></html>",
].join("\n"));

const server = createServer((request, response) => {
  const path = (request.url ?? "/").split("?")[0];
  const name = path === "/" ? "index.html" : path.replace(/^\//, "");
  const type = name.includes("/") || name.includes("..") ? undefined : contentTypes[extname(name)];
  if (!type) { response.writeHead(404).end("not found"); return; }
  readFile(join(buildDir, name)).then(
    (body) => { response.writeHead(200, { "content-type": type, "cache-control": "no-store" }); response.end(body); },
    () => { response.writeHead(404).end("not found"); },
  );
});
await new Promise<void>((resolveListen, rejectListen) => {
  server.once("error", rejectListen);
  server.listen(port, "127.0.0.1", resolveListen);
});
const origin = "http://127.0.0.1:" + port;

let exitCode = 1;
try {
  console.log("== fixture " + origin + " (build " + buildDir + ")");
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  const requests = async (): Promise<Recorded[]> => await page.evaluate(() => window.__ux03c!.requests);
  // Moving the panel to another conversation is an ordinary act, so it is driven that way: the host re-renders the panel
  // with the other conversation's id while whatever is in flight still belongs to the first.
  const switchTo = async (id: string): Promise<void> => page.evaluate((conversationId) => window.__ux03c!.switchTo(conversationId), id);
  const holdFor = async (ms: number): Promise<void> => page.evaluate((delay) => window.__ux03c!.setDelay(delay), ms);
  // The panel's own projection names the conversation it was read for, so waiting for that id is waiting for the read
  // that answered the new conversation rather than for a paint.
  const stateOf = async (conversationId: string): Promise<PanelState> => {
    await page.waitForFunction((id) => {
      const text = document.querySelector(".mcp-conversation-tools")?.getAttribute("data-mcp-state") ?? "";
      return text.includes('"conversationId":"' + id + '"');
    }, conversationId, { timeout: 30000 });
    return await panelState();
  };
  // The panel states what it holds as one machine-readable attribute, so waiting for that attribute to carry a state is
  // waiting for the read that answered it — not for a paint.
  const panelState = async (): Promise<PanelState> => {
    await page.waitForFunction(() => {
      const text = document.querySelector(".mcp-conversation-tools")?.getAttribute("data-mcp-state") ?? "";
      return text.length > 0;
    }, { timeout: 30000 });
    return JSON.parse((await page.locator(".mcp-conversation-tools").getAttribute("data-mcp-state")) ?? "{}") as PanelState;
  };
  const listingRequests = async (): Promise<Recorded[]> => (await requests()).filter((entry) => entry.url.includes("?mcp="));
  const serverBlock = (server: string) => page.locator(`.mcp-conversation-server[data-server="${server}"]`);
  const toolRow = (server: string, tool: string) => serverBlock(server).locator(`.mcp-conversation-tool[data-tool="${tool}"]`);

  await page.goto(origin + "/", { waitUntil: "load" });
  await page.getByRole("button", { name: "hepi.mcp", exact: true }).waitFor({ timeout: 30000 });
  // The panel opens on the deployment default, where no conversation's grants exist, so nothing MCP-specific is shown.
  check((await page.locator(".mcp-conversation-tools").count()) === 0, "the default scope shows no conversation's MCP tools");
  check((await listingRequests()).length === 0, "and opening the panel asked no host to list anything");

  // The conversation scope is where one conversation's own grants live.
  await page.getByRole("button", { name: "This conversation", exact: true }).click();
  await page.locator(".mcp-conversation-tools").waitFor({ timeout: 30000 });

  // Discovery is explicit: the state read answered the grants and the host's configured servers, and not one server was
  // asked for its tools until a person pressed that server's own button.
  check((await listingRequests()).length === 0, "opening the conversation scope listed no server: " + JSON.stringify((await listingRequests()).map((entry) => entry.url)));
  const read = (await requests()).filter((entry) => entry.url === "/api/conversations/conversation-1/extensions");
  check(read.length === 1 && read[0].method === "GET", "one read of the conversation's own seam answered the state");
  // Configured, exposed, selected and available are four different answers about the same server.
  const unlisted = await panelState();
  check(/exposed not asked/.test(await page.locator(".mcp-conversation-tools").innerText()), "an unasked exposure reads as a question, not as a no");
  check(unlisted.tools.some((row) => row.tool === "search" && row.configured === true && row.exposed === false && row.selected === true && row.available === true),
    "a grant with no listing reads configured and selected and available, with exposure unasked: " + JSON.stringify(unlisted.tools));
  check(unlisted.servers.length === 2 && unlisted.servers.every((entry) => entry.enabled === true), "both configured servers are stated, neither listed");
  check(unlisted.listings.length === 0, "no listing is claimed before one was asked for");

  // One press, one server: the request names `docs` and the answer's tools appear, and `locked` was not asked at all.
  await serverBlock("docs").getByRole("button", { name: "List tools", exact: true }).click();
  await toolRow("docs", "fetch").waitFor({ timeout: 30000 });
  const listed = await listingRequests();
  check(listed.length === 1 && listed[0].url === "/api/conversations/conversation-1/extensions?mcp=docs", "one press asked exactly that one server: " + JSON.stringify(listed.map((entry) => entry.url)));
  check((await serverBlock("locked").locator(".mcp-conversation-tool").count()) === 0, "the other configured server was not listed as a side effect");
  const afterListing = await panelState();
  const fetchRow = afterListing.tools.find((row) => row.tool === "fetch");
  check(fetchRow !== undefined && fetchRow.exposed === true && fetchRow.selected === false && fetchRow.available === false,
    "a listed tool nobody chose reads exposed but not selected and not available: " + JSON.stringify(fetchRow));
  const searchRow = afterListing.tools.find((row) => row.tool === "search");
  check(searchRow !== undefined && searchRow.exposed === true && searchRow.selected === true && searchRow.available === true,
    "the granted tool reads all four states: " + JSON.stringify(searchRow));
  // A tool the host hides is shown and named as hidden rather than dropped: a person must be able to see that a call
  // for it would be refused.
  const hiddenRow = afterListing.tools.find((row) => row.tool === "secret");
  check(hiddenRow !== undefined && hiddenRow.hidden === true && hiddenRow.available === false, "a hidden tool is stated as hidden and unavailable: " + JSON.stringify(hiddenRow));
  check(afterListing.listings.length === 1 && afterListing.listings[0].server === "docs" && afterListing.listings[0].carried === 3,
    "the listing is held for that one server, with its own count: " + JSON.stringify(afterListing.listings));

  // Nothing in the panel's state is a credential, a resolved entry value or a host path.
  const stateText = JSON.stringify(afterListing);
  for (const forbidden of ["SUPERSECRET", "sourcePath", "/home/", "mcp.json", "command", "API_KEY", "clientSecret", "inputSchema", "cwd", "authorization"]) {
    check(!stateText.includes(forbidden), "browser state carries no " + forbidden);
  }

  // A grant writes exactly one server's whole set: the tool already chosen plus the one just chosen, in one request.
  const beforeGrant = (await requests()).length;
  await toolRow("docs", "fetch").getByRole("checkbox").click();
  await page.waitForFunction(() => window.__ux03c!.requests.length > 0 && window.__ux03c!.requests.some((entry) => entry.method === "PATCH"));
  await page.waitForFunction(() => {
    const state = JSON.parse(document.querySelector(".mcp-conversation-tools")?.getAttribute("data-mcp-state") ?? "{}");
    return (state.tools ?? []).some((row: { tool: string; selected: boolean }) => row.tool === "fetch" && row.selected === true);
  }, { timeout: 30000 });
  const grants = (await requests()).slice(beforeGrant).filter((entry) => entry.method === "PATCH");
  check(grants.length === 1, "one grant is one request: " + JSON.stringify(grants.map((entry) => entry.url)));
  check(grants[0].url === "/api/conversations/conversation-1/extensions", "the grant is written on 03b's own seam");
  check(JSON.stringify(grants[0].body) === JSON.stringify({ mcp: { server: "docs", tools: ["search", "fetch"] } }),
    "the write states that one server's whole set, keeping the tool already chosen: " + JSON.stringify(grants[0].body));
  check((await panelState()).tools.find((row) => row.tool === "fetch")?.selected === true, "the panel shows the grant the backend answered with");

  // The extension switch lives above this block and writes the same conversation, so the block cannot keep its own
  // snapshot of that selection: switching it off must take availability away, and a selection is not a loss of grants.
  const beforeToggle = (await requests()).length;
  await page.getByRole("switch", { name: "Disable hepi.mcp", exact: true }).click();
  await page.waitForFunction(() => {
    const projected = JSON.parse(document.querySelector(".mcp-conversation-tools")?.getAttribute("data-mcp-state") ?? "{}");
    return projected.extensionSelected === false;
  }, { timeout: 30000 });
  const deselected = await panelState();
  check(deselected.grants.length > 0, "deselecting the extension deletes no grant: " + JSON.stringify(deselected.grants));
  check(deselected.tools.every((row) => row.available === false), "and nothing stays currently available while the extension is off: " + JSON.stringify(deselected.tools));
  check(deselected.tools.filter((row) => row.selected).every((row) => row.limitedBy === "extension-not-selected"),
    "every granted row names the selection as the reason: " + JSON.stringify(deselected.tools));
  check(/not selected for this conversation/.test(await page.locator(".mcp-conversation-tools").innerText()), "and the panel says it in words");
  check((await requests()).slice(beforeToggle).some((entry) => entry.method === "GET" && entry.url === "/api/conversations/conversation-1/extensions"),
    "the block re-read the conversation rather than guess what its new offer is");
  await page.getByRole("switch", { name: "Enable hepi.mcp", exact: true }).click();
  await page.waitForFunction(() => {
    const projected = JSON.parse(document.querySelector(".mcp-conversation-tools")?.getAttribute("data-mcp-state") ?? "{}");
    return (projected.tools ?? []).some((row: { tool: string; available: boolean }) => row.tool === "fetch" && row.available === true);
  }, { timeout: 30000 });
  const reselected = await panelState();
  check(reselected.extensionSelected === true && reselected.tools.filter((row) => row.selected).every((row) => row.available),
    "restoring the selection makes the grants available again: " + JSON.stringify(reselected.tools));

  // A revocation writes the empty set, which the backend answers without asking a host anything.
  const beforeRevoke = (await requests()).length;
  await toolRow("docs", "fetch").getByRole("checkbox").click();
  await page.waitForFunction(() => {
    const state = JSON.parse(document.querySelector(".mcp-conversation-tools")?.getAttribute("data-mcp-state") ?? "{}");
    return (state.tools ?? []).some((row: { tool: string; selected: boolean }) => row.tool === "fetch" && row.selected === false);
  }, { timeout: 30000 });
  const revokes = (await requests()).slice(beforeRevoke).filter((entry) => entry.method === "PATCH");
  check(revokes.length === 1 && JSON.stringify(revokes[0].body) === JSON.stringify({ mcp: { server: "docs", tools: ["search"] } }),
    "one revocation states the set without that tool: " + JSON.stringify(revokes.map((entry) => entry.body)));

  // A named refusal is that server's own, kept as the host's own code and shown as a limit rather than as an empty list.
  await serverBlock("locked").getByRole("button", { name: "List tools", exact: true }).click();
  await serverBlock("locked").getByText(/The host refused to list this server/).waitFor({ timeout: 30000 });
  const refusedText = await serverBlock("locked").innerText();
  check(/needs a sign-in/.test(refusedText), "the refusal keeps the host's own reason: " + JSON.stringify(refusedText));
  check(!/listed no tools/i.test(refusedText), "a refusal is never shown as an empty listing");
  check((await serverBlock("docs").innerText()).includes("fetch"), "one server's refusal does not empty another's listing");
  // Revoking everything is one write for that server, and it works even though the last listing named tools: a
  // revocation asks a host nothing.
  const beforeRevokeAll = (await requests()).length;
  await serverBlock("docs").getByRole("button", { name: "Revoke every grant of this server", exact: true }).click();
  await page.waitForFunction(() => {
    const state = JSON.parse(document.querySelector(".mcp-conversation-tools")?.getAttribute("data-mcp-state") ?? "{}");
    return (state.grants ?? []).length === 0;
  }, { timeout: 30000 });
  const revokeAll = (await requests()).slice(beforeRevokeAll).filter((entry) => entry.method === "PATCH");
  check(revokeAll.length === 1 && JSON.stringify(revokeAll[0].body) === JSON.stringify({ mcp: { server: "docs", tools: [] } }),
    "revoking every grant of a server is one empty set: " + JSON.stringify(revokeAll.map((entry) => entry.body)));

  // The seam answers a **whole conversation** per request, so switching conversations is where one document's answer
  // could be painted over another's. Both cases below hold the old answer open past the switch, which is what happens
  // on a slow host while a person clicks the next conversation in the sidebar.
  await holdFor(600);
  await serverBlock("docs").getByRole("button", { name: "List tools", exact: true }).click();
  await page.waitForFunction(() => window.__ux03c!.pending() > 0 && window.__ux03c!.requests.length > 0, null, { timeout: 30000 });
  await switchTo("conversation-2");
  const moved = await stateOf("conversation-2");
  check(moved.conversationId === "conversation-2", "the panel now states the conversation it was switched to: " + moved.conversationId);
  check(moved.grants.map((entry) => entry.tool).sort().join() === "fetch,translate",
    "with that conversation's own grants and none of the previous one's: " + JSON.stringify(moved.grants));
  check(moved.listings.length === 0 && !moved.tools.some((row) => row.tool === "search"),
    "and it holds no listing until this conversation is asked for one: " + JSON.stringify(moved));
  await page.waitForFunction(() => window.__ux03c!.pending() === 0, null, { timeout: 30000 });
  const afterLateListing = await panelState();
  check(afterLateListing.conversationId === "conversation-2" && afterLateListing.listings.length === 0
    && afterLateListing.tools.every((row) => row.exposed === false),
    "the listing that was in flight for the previous conversation is dropped when it lands: " + JSON.stringify(afterLateListing.tools));

  // The same for a write: the person pressed it on one conversation, and its answer is that conversation's state.
  await holdFor(600);
  const beforeLateWrite = (await requests()).length;
  await toolRow("docs", "translate").getByRole("checkbox").click();
  await page.waitForFunction((from) => window.__ux03c!.requests.slice(from).some((entry) => entry.method === "PATCH"), beforeLateWrite, { timeout: 30000 });
  await page.waitForFunction(() => window.__ux03c!.pending() > 0, null, { timeout: 30000 });
  await switchTo("conversation-1");
  const backAgain = await stateOf("conversation-1");
  check(backAgain.conversationId === "conversation-1" && backAgain.grants.length === 0,
    "the conversation switched back to states its own empty grant set: " + JSON.stringify(backAgain.grants));
  await page.waitForFunction(() => window.__ux03c!.pending() === 0, null, { timeout: 30000 });
  const afterLateWrite = await panelState();
  check(afterLateWrite.conversationId === "conversation-1" && afterLateWrite.grants.length === 0
    && !afterLateWrite.tools.some((row) => row.tool === "translate"),
    "and the write made for the other conversation does not restripe this one when it lands: " + JSON.stringify(afterLateWrite.grants));
  // The write itself did happen, so the read that answered this conversation before it may now be older than the
  // document: the panel re-reads instead of trusting the view it kept, and that read is what a person's next choice is
  // derived from.
  const all = await requests();
  const latePatch = all.map((entry) => entry.method + " " + entry.url)
    .lastIndexOf("PATCH /api/conversations/conversation-2/extensions");
  const reReadAfter = all.slice(latePatch + 1).filter((entry) => entry.method === "GET" && entry.url === "/api/conversations/conversation-1/extensions");
  check(latePatch >= 0 && reReadAfter.length === 1,
    "the panel re-read the conversation it shows once that write landed: " + JSON.stringify(all.slice(latePatch + 1).map((entry) => entry.method + " " + entry.url)));

  // The next checkbox derives its body from the set **this** conversation holds, not from the one the late write
  // answered for: an empty set plus one tool is exactly one tool, and a leaked grant would show up as two.
  await holdFor(0);
  await serverBlock("docs").getByRole("button", { name: "List tools", exact: true }).click();
  await toolRow("docs", "search").waitFor({ timeout: 30000 });
  const beforeNextGrant = (await requests()).length;
  await toolRow("docs", "fetch").getByRole("checkbox").click();
  await page.waitForFunction(() => window.__ux03c!.requests.some((entry) => entry.method === "PATCH"
    && JSON.stringify(entry.body) === "{\"mcp\":{\"server\":\"docs\",\"tools\":[\"fetch\"]}}"), null, { timeout: 30000 });
  const nextGrant = (await requests()).slice(beforeNextGrant).filter((entry) => entry.method === "PATCH");
  check(nextGrant.length === 1 && JSON.stringify(nextGrant[0].body) === JSON.stringify({ mcp: { server: "docs", tools: ["fetch"] } }),
    "the grant after a switch derives this conversation's own set: " + JSON.stringify(nextGrant.map((entry) => entry.body)));
  await page.waitForFunction(() => {
    const projected = JSON.parse(document.querySelector(".mcp-conversation-tools")?.getAttribute("data-mcp-state") ?? "{}");
    return (projected.grants ?? []).length === 1 && projected.grants[0].tool === "fetch";
  }, null, { timeout: 30000 });
  const afterSwitchGrant = await panelState();
  check(afterSwitchGrant.grants.length === 1 && afterSwitchGrant.grants[0].tool === "fetch"
    && !afterSwitchGrant.tools.some((row) => row.tool === "translate"),
    "and the panel shows that one grant, with no tool of the other conversation in it: " + JSON.stringify(afterSwitchGrant.grants));

  // The host is offline but the conversation still holds grants (03b keeps them). Its configured state is unknown,
  // never a "no": the grants stay visible, the grant checkboxes stay operable, and revoking needs no host at all.
  await page.goto(origin + "/?host=offline", { waitUntil: "load" });
  await page.getByRole("button", { name: "This conversation", exact: true }).click();
  await page.waitForFunction(() => (document.querySelector(".mcp-conversation-tools")?.getAttribute("data-mcp-state") ?? "").includes('"serversKnown":false'), null, { timeout: 30000 });
  const offline = await panelState();
  check(offline.serversKnown === false && offline.serversRefusal === "gateway_offline",
    "the panel states that the host configuration was not read, in the seam's own code: " + JSON.stringify(offline.serversRefusal));
  const offlineBlock = serverBlock("docs");
  await offlineBlock.waitFor({ timeout: 30000 });
  check((await offlineBlock.locator(".mcp-conversation-tool").count()) >= 1,
    "a server only a grant names is still listed while the host is away: " + (await offlineBlock.innerText()));
  const offlineRow = offline.tools.find((row) => row.tool === "search");
  check(offlineRow !== undefined && offlineRow.selected === true && offlineRow.configured === false && offlineRow.configUnknown === true,
    "its row shows the grant and says the configuration is unknown: " + JSON.stringify(offlineRow));
  check(offlineRow?.available === false && offlineRow?.availableUnknown === true,
    "and its availability is unknown rather than a claim either way: " + JSON.stringify(offlineRow));
  check(/host configuration not read/.test(await offlineBlock.innerText()) && /availability unknown/.test(await offlineBlock.innerText()),
    "and both are said in words on the panel: " + (await offlineBlock.innerText()));
  check(/could not be read/.test(await page.locator(".mcp-conversation-tools").innerText()),
    "and the panel says the configuration was not read rather than that the host configures nothing");
  check(!/configures no MCP server/i.test(await page.locator(".mcp-conversation-tools").innerText()),
    "it does not claim the host configures nothing");
  // A listing needs the host, so it is refused with the host's own code — and the grant the panel shows survives it.
  await serverBlock("docs").getByRole("button", { name: "List tools", exact: true }).click();
  await page.getByText(/The host could not be asked to list this server/).waitFor({ timeout: 30000 });
  check((await panelState()).tools.some((row) => row.tool === "search"),
    "a refused listing leaves the grant in place rather than emptying the panel");
  const beforeOfflineRevoke = (await requests()).length;
  await serverBlock("docs").getByRole("button", { name: "Revoke every grant of this server", exact: true }).click();
  await page.waitForFunction(() => {
    const state = JSON.parse(document.querySelector(".mcp-conversation-tools")?.getAttribute("data-mcp-state") ?? "{}");
    return (state.grants ?? []).length === 0;
  }, { timeout: 30000 });
  const offlineRevokes = (await requests()).slice(beforeOfflineRevoke).filter((entry) => entry.method === "PATCH");
  check(offlineRevokes.length === 1 && JSON.stringify(offlineRevokes[0].body) === JSON.stringify({ mcp: { server: "docs", tools: [] } }),
    "and revoking still writes one empty set, with no listing asked of the host: " + JSON.stringify(offlineRevokes.map((entry) => entry.body)));
  check((await listingRequests()).length === 1, "the only listing asked was the refused one, so the revocation connected no server");

  // A conversation bound to no workspace has no host, and that limit is stated before any server's.
  await page.goto(origin + "/?scope=no-workspace", { waitUntil: "load" });
  await page.getByRole("button", { name: "This conversation", exact: true }).click();
  const unbound = await panelState();
  check(/bound to no execution workspace/.test(await page.locator(".mcp-conversation-tools").innerText()), "an unbound conversation states its own limit");
  check(unbound.workspaceBound === false, "the state says the conversation is bound to no workspace: " + JSON.stringify(unbound));
  check(unbound.tools.every((row) => row.available === false && row.limitedBy === "no-workspace"), "and every tool row names that limit: " + JSON.stringify(unbound.tools));

  check(pageErrors.length === 0, "no page error occurred" + (pageErrors.length === 0 ? "" : ": " + pageErrors.join(" | ")));
  await browser.close();
  exitCode = failures.length === 0 ? 0 : 1;
} catch (error) {
  failures.push("the fixture threw: " + (error instanceof Error ? error.stack ?? error.message : String(error)));
  console.log("  FAIL the fixture threw: " + (error instanceof Error ? error.message : String(error)));
} finally {
  await new Promise((resolveClose) => server.close(resolveClose));
  if (!keep) await rm(buildDir, { recursive: true, force: true });
  else console.log("build kept at " + buildDir);
}

console.log("== result: " + (failures.length === 0 ? "PASS" : failures.length + " FAILED CHECK(S)"));
for (const failure of failures) console.log("   - " + failure);
process.exit(exitCode);
