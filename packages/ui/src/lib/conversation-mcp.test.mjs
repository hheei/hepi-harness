import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * A conversation's MCP tool states at the browser's own seam (ticket 03c).
 *
 * The Backend owns the grants, the offer and the host's answers (03b), and the Gateway owns the listing (03a). What
 * this file is answerable for is the one thing the browser adds: **the four states kept apart** — configured, exposed,
 * selected, currently available — each read from the single fact that states it, with discovery asked for one named
 * server by a person and never derived from a render, and with revocation going through 03b's existing write.
 *
 * The hostile body below is deliberate: the seam's answer is also where a host's configuration read arrives, so the
 * projection is asserted to carry only the fields a browser may hold, rather than trusting that no caller copied
 * another one.
 */

const jiti = createJiti(import.meta.url);
const {
  MCP_EXTENSION,
  MCP_SEAM_REFUSAL_KEYS,
  MCP_TOOL_PREFIX,
  availabilityLimit,
  grantedTools,
  listingOf,
  mcpGrantAddBody,
  mcpGrantBody,
  mcpGrantRemoveBody,
  mcpListingRoute,
  mcpPanelState,
  mcpServerBlocks,
  mcpRefusalIsNamed,
  mcpRefusalKey,
  mcpSelectionRoute,
  mcpServerStates,
  mcpToolRows,
  readConversationMcp,
  readMcpListing,
  withListing,
  withHeldListings,
  appliedWrite,
} = await jiti.import("./conversation-mcp.ts");

/** One conversation's state as 03b's seam answers it: host `docs` configured, nothing granted, nothing asked. */
const base = (overrides = {}) => ({
  protocol: "hepi.v1",
  conversationId: "42",
  extensions: [MCP_EXTENSION],
  toolNames: [],
  mcp: {
    conversationId: "42",
    workspaceId: "local",
    gatewayId: "workstation",
    selected: true,
    servers: [{ server: "docs", scope: "global", enabled: true, exposure: "direct" }],
    grants: [],
    offered: [],
    ...overrides.mcp,
  },
  ...overrides.top,
});

const listing = (overrides = {}) => ({
  scope: "global",
  server: "docs",
  tools: [{ name: "search", description: "Search the docs", exposure: "direct", inputSchema: { type: "object", properties: { q: { type: "string" } } } }],
  total: 1,
  truncated: false,
  pages: 1,
  durationMs: 41,
  listedAt: 1_792_400_000_000,
  ...overrides,
});

const rows = (view, server = "docs", listingValue = listingOf(view, server)) => mcpToolRows(view, server, listingValue);
const readView = (body) => {
  const read = readConversationMcp("42", body);
  assert.equal(read.ok, true, JSON.stringify(read));
  return read.view;
};

test("the four states are four facts, each read from the one that states it", () => {
  // Nothing is exposed by a plain read of the seam: `configured` comes from the host's own files, which the read
  // answered, and no listing was asked for, so exposure is an unread question rather than a "no".
  const configured = readView(base());
  assert.deepEqual(configured.servers.map((entry) => entry.server), ["docs"], "the host's read states what is configured");
  assert.deepEqual(configured.listings, [], "the state read answered no listing, because it asked none");
  assert.deepEqual(rows(configured).map((row) => [row.tool, row.configured, row.exposed, row.selected, row.available]),
    [], "a server with no grant and no listing has no tool rows to claim anything about");

  // A listing exposes a tool to this conversation's reading, and grants nothing: `selected` stays false and the
  // descriptor a person can read is the host's own masked text.
  const exposed = readView(base({ mcp: { listed: listing() } }));
  assert.equal(exposed.servers.length, 1, "listing does not change what the host configures");
  const [search] = rows(exposed);
  assert.deepEqual([search.configured, search.exposed, search.selected, search.available], [true, true, false, false],
    "exposed is not selected, and selected is not exposed");
  assert.equal(search.description, "Search the docs", "the host's own words are what a person reads");

  // A grant is the person's act, and it makes the tool available: the conversation selects the extension, is bound to a
  // workspace whose gateway resolves, the entry is switched on and not hidden, and the host listed the tool.
  const granted = readView(base({
    mcp: {
      offered: ["read", MCP_TOOL_PREFIX + "workstation__docs__search"],
      grants: [{ gatewayId: "workstation", scope: "global", server: "docs", tool: "search", description: "Search the docs", inputSchema: { type: "object" }, listedAt: 1_792_400_000_000 }],
      listed: listing(),
    },
  }));
  const [grantedRow] = rows(granted);
  assert.deepEqual([grantedRow.configured, grantedRow.exposed, grantedRow.selected, grantedRow.available], [true, true, true, true],
    "all four met is the only case that reads as currently available");
  assert.deepEqual(granted.offered, [MCP_TOOL_PREFIX + "workstation__docs__search"],
    "the runtime's own offer is shown verbatim and never re-derived from the grant");

  // A grant of a tool no listing names is a row, not a disappearance: the person chose it, and exposure is then an
  // unasked question rather than a "no" — nobody pressed List, so the host was never asked what it holds.
  const stale = readView(base({ mcp: { grants: [{ gatewayId: "workstation", scope: "global", server: "docs", tool: "gone", listedAt: 1 }] } }));
  const [gone] = rows(stale);
  assert.deepEqual([gone.exposed, gone.selected, gone.available], [false, true, true],
    "selection is the person's grant; exposure is a question nobody asked, and availability is not withheld for it");
  assert.equal(gone.exposureUnknown, true, "no listing was asked, so exposure is a question");
  assert.equal(stale.grants.length, 1, "and it stays in the state, because it is a durable fact about the conversation");
});

test("discovery is one named server per request, asked by a person, and never a side effect of a read", () => {
  assert.equal(mcpSelectionRoute("42"), "/api/conversations/42/extensions", "the seam is 03b's route, not a new one");
  assert.equal(mcpListingRoute("42", "docs"), "/api/conversations/42/extensions?mcp=docs", "a listing is the same route with one server named");
  assert.equal(mcpListingRoute("42", "a b"), "/api/conversations/42/extensions?mcp=a+b", "a name is carried as a query parameter, never spliced into a path");
  // There is no route that lists several servers, because a fan-out would start several processes to answer a question
  // nobody asked (research §7 Q6, rejected for 03a and unchanged here).
  assert.equal(Object.getOwnPropertyNames({ mcpListingRoute }).length, 1, "one listing route exists");
});

test("a listing's own bounds and refusals are named, and never collapse into an empty list", () => {
  const empty = readMcpListing("docs", base({ mcp: { listed: listing({ tools: [], total: 0 }) } }));
  assert.equal(empty.ok, true);
  assert.equal(empty.listing.tools.length, 0, "an empty listing is an empty listing");

  const cut = readMcpListing("docs", base({ mcp: { listed: listing({ tools: [{ name: "a" }], total: 300, truncated: true }) } }));
  assert.equal(cut.listing.truncated, true, "a cut answer says it was cut rather than reading as the server's whole list");

  for (const code of ["needs-auth", "server-disabled", "project-untrusted", "server-missing", "unknown-workspace", "timeout"]) {
    const refused = readMcpListing("docs", { code, error: "the host's own masked words" }, 409);
    assert.equal(refused.ok, false, code + " is not a listing");
    assert.equal(refused.refusal.code, code, "the host's own name for the refusal survives");
    assert.equal(mcpRefusalIsNamed(refused.refusal), true, code + " is the host answering, not a failure to answer");
  }
  // An unreachable host and a broken answer are faults to retry, not refusals of what a person asked for — the panel
  // must not tell them apart from a named limit by accident.
  assert.equal(mcpRefusalIsNamed({ code: "gateway_offline", error: "", status: 503 }), false);
  assert.equal(mcpRefusalIsNamed({ code: "protocol_error", error: "", status: 502 }), false);

  // Every code 03a and 03b can answer with has a key, so the panel adds no second status vocabulary.
  const seamCodes = [
    "needs-auth", "not-authorized", "server-disabled", "server-missing", "server-invalid", "project-untrusted",
    "trust-unreadable", "unknown-workspace", "not_listed", "offer_unavailable", "host_unavailable",
    "unavailable_extension", "gateway_offline", "gateway_error", "mcp_unavailable", "mcp_unreachable",
    "invalid_request", "cancelled", "timeout", "protocol_error", "operation_failed", "unsupported",
  ];
  for (const code of seamCodes) assert.ok(code in MCP_SEAM_REFUSAL_KEYS, code + " is named");
  assert.equal(mcpRefusalKey("something_new"), "mcpTools.refusal.operation-failed", "an unknown code is a failure, not a limit");

  // A body that is not the seam's answer is refused as a protocol fault rather than read as "no servers configured".
  const unreadable = readConversationMcp("42", { extensions: [] }, 200);
  assert.equal(unreadable.ok, false);
  assert.equal(unreadable.refusal.code, "protocol_error");
  const refused = readConversationMcp("42", { code: "host_unavailable", error: "no workspace" }, 409);
  assert.equal(refused.refusal.code, "host_unavailable", "a read refusal keeps the seam's own name for itself");
});

test("grant and revocation go through 03b's write, state one server's whole set, and hold no wildcard", () => {
  assert.equal(mcpGrantBody("docs", ["search", "search"]), JSON.stringify({ mcp: { server: "docs", tools: ["search"] } }),
    "one name stated twice is one name stated");
  // The backend replaces the set, so a panel that wants one more tool has to send the ones it already holds: dropping
  // them would be a silent revocation inside a grant.
  const view = readView(base({ mcp: { grants: [{ gatewayId: "workstation", scope: "global", server: "docs", tool: "read", listedAt: 1 }] } }));
  assert.deepEqual(grantedTools(view, "docs"), ["read"]);
  assert.deepEqual(JSON.parse(mcpGrantAddBody(view, "docs", "search")).mcp, { server: "docs", tools: ["read", "search"] });
  assert.deepEqual(JSON.parse(mcpGrantRemoveBody(view, "docs", "read")).mcp, { server: "docs", tools: [] },
    "taking the last grant away states an empty set, which is 03b's revocation");
  assert.equal(JSON.parse(mcpGrantBody("docs", [])).mcp.tools.length, 0, "revoking asks nothing of a host, so it works offline");
  // Another server's grants are not this write's business, and a body carries no configuration key by construction.
  const other = readView(base({ mcp: { grants: [{ gatewayId: "workstation", scope: "global", server: "other", tool: "x", listedAt: 1 }] } }));
  assert.equal(JSON.parse(mcpGrantAddBody(other, "docs", "search")).mcp.tools.length, 1);
  for (const key of ["command", "args", "env", "url", "headers", "auth", "config", "cwd", "workspaceId", "token"]) {
    assert.ok(!JSON.stringify(JSON.parse(mcpGrantAddBody(view, "docs", "search"))).includes('"' + key + '"'), key + " never travels");
  }
});

test("a refusal of a grant leaves the conversation's state as it was and names itself", () => {
  const refused = readConversationMcp("42", { code: "not_listed", error: "the host lists no tool gone" }, 409);
  assert.equal(refused.ok, false, "a write refusal is not a state");
  assert.equal(refused.refusal.code, "not_listed");
  // An offer this process could not register writes nothing (03b's `offer_unavailable`), and the panel says so rather
  // than showing a grant the model was never offered.
  assert.equal(mcpRefusalKey("offer_unavailable"), "mcpTools.refusal.offer-unavailable");
});

test("the conversation's own limits are stated before any server's", () => {
  const unselected = readView(base({ mcp: { selected: false, grants: [{ gatewayId: "workstation", scope: "global", server: "docs", tool: "search", listedAt: 1 }] } }));
  assert.equal(availabilityLimit(unselected), "extension-not-selected");
  assert.equal(rows(unselected)[0].available, false, "a granted tool is not available while the extension is not selected");
  assert.equal(rows(unselected)[0].limitedBy, "extension-not-selected", "and the row names whose limit it is");

  const unbound = readView(base({ mcp: { workspaceId: "" } }));
  assert.equal(availabilityLimit(unbound), "no-workspace", "a conversation bound to no folder has no host to run on");
  const noGateway = readView(base({ mcp: { gatewayId: undefined } }));
  assert.equal(availabilityLimit(noGateway), "no-gateway");

  // Selecting the extension and having a host is still not exposing anything: the host's own entry decides.
  const off = readView(base({ mcp: { servers: [{ server: "docs", scope: "global", enabled: false }], grants: [{ gatewayId: "workstation", scope: "global", server: "docs", tool: "search", listedAt: 1 }] } }));
  assert.equal(rows(off)[0].available, false, "a switched-off entry is not currently available");
  assert.equal(rows(off)[0].switchedOff, true, "and the row says the host switched it off");
  const hidden = readView(base({ mcp: { servers: [], grants: [{ gatewayId: "workstation", scope: "global", server: "docs", tool: "search", listedAt: 1 }], listed: listing({ tools: [{ name: "search", exposure: "hidden" }] }) } }));
  assert.equal(rows(hidden)[0].hidden, true, "a hidden tool is shown, not silently dropped");
  assert.equal(rows(hidden)[0].available, false, "and a call for it is refused by the host");
});

test("a changed descriptor and an unknown exposure are named, not smoothed over", () => {
  const granted = readView(base({
    mcp: {
      grants: [{ gatewayId: "workstation", scope: "global", server: "docs", tool: "search", description: "Search the docs", inputSchema: { type: "object" }, listedAt: 1 }],
      listed: listing({ tools: [{ name: "search", description: "Search the docs again", inputSchema: { type: "object" } }] }),
    },
  }));
  assert.equal(rows(granted)[0].descriptorChanged, true, "the host's newest words differ from the grant's snapshot");
  // A grant whose schema the host withheld is offered with an empty argument object and says so; it is still the tool a
  // person chose.
  const withheld = readView(base({
    mcp: { grants: [{ gatewayId: "workstation", scope: "global", server: "docs", tool: "search", schemaOmitted: true, listedAt: 1 }], listed: listing({ tools: [{ name: "search" }] }) },
  }));
  assert.equal(rows(withheld)[0].schemaOmitted, true);
  assert.equal(rows(withheld)[0].available, true, "a withheld schema is not a reason a tool is unavailable");
  // `readOnly` is the server's own claim and only ever the boolean true; an absent annotation is unknown, not safe.
  assert.equal(rows(readView(base({ mcp: { listed: listing({ tools: [{ name: "search", readOnly: true }] }) } })))[0].readOnly, true);
  assert.equal(rows(readView(base({ mcp: { listed: listing() } })))[0].readOnly, undefined);
});

test("the panel's own state holds no credential, no resolved value and no host path", () => {
  // The seam's answer is also where a host's configuration read arrives, so the hostile fields are put where a caller
  // could copy them and the projection is asserted not to have copied them.
  const view = readConversationMcp("42", {
    protocol: "hepi.v1",
    conversationId: "42",
    extensions: [MCP_EXTENSION],
    toolNames: [],
    mcp: {
      conversationId: "42",
      workspaceId: "local",
      gatewayId: "workstation",
      selected: true,
      servers: [{
        server: "docs", scope: "global", enabled: true, exposure: "direct",
        sourcePath: "/home/operator/.pi/agent/mcp.json",
        command: "node", args: ["/srv/mcp/index.js", "--token", "SUPERSECRET"],
        url: "https://mcp.example/?key=SUPERSECRET", env: { API_KEY: "SUPERSECRET" },
        headerNames: ["authorization"], auth: { clientSecret: "SUPERSECRET" }, token: "SUPERSECRET",
      }],
      grants: [{
        gatewayId: "workstation", scope: "global", server: "docs", tool: "search",
        description: "Search the docs", inputSchema: { type: "object" },
        cwd: "/home/operator/project", env: { API_KEY: "SUPERSECRET" }, listedAt: 1,
      }],
      offered: [MCP_TOOL_PREFIX + "workstation__docs__search"],
      listed: listing({ server: "docs", tools: [{ name: "search", description: "Search the docs", inputSchema: { type: "object" } }] }),
    },
  });
  assert.equal(view.ok, true);
  const state = JSON.stringify(mcpPanelState(view.view));
  for (const forbidden of ["SUPERSECRET", "sourcePath", "/home/operator", "mcp.json", "command", "API_KEY", "clientSecret", "authorization", "inputSchema", "cwd"]) {
    assert.ok(!state.includes(forbidden), "browser state must not carry " + forbidden + ": " + state);
  }
  // What it does carry is the four states, per tool, plus the runtime's own offer.
  const parsed = mcpPanelState(view.view);
  assert.deepEqual(parsed.tools, [{
    server: "docs", scope: "global", tool: "search", configured: true, exposed: true, selected: true, available: true,
  }]);
  assert.deepEqual(parsed.grants, [{ server: "docs", tool: "search", scope: "global", listedAt: 1 }]);
  assert.deepEqual(parsed.servers, [{ server: "docs", scope: "global", configured: true, enabled: true }]);
  assert.deepEqual(parsed.listings, [{ server: "docs", total: 1, carried: 1, truncated: false, listedAt: 1_792_400_000_000 }]);
  assert.equal(parsed.offered.length, 1);
});

test("listings are held per server and a write keeps the ones it did not ask about", () => {
  const listed = readView(base({ mcp: { listed: listing() } }));
  assert.equal(listingOf(listed, "docs").server, "docs");
  assert.equal(listingOf(listed, "other"), undefined, "nothing was asked of that server, so nothing is claimed about it");
  // 03b answers a grant write with a fresh listing of the written server; a revocation asks nothing of a host and the
  // panel keeps the reading it already had rather than losing it.
  const revoked = withListing(listed, listing({ tools: [], total: 0, listedAt: 2 }));
  assert.equal(listingOf(revoked, "docs").listedAt, 2, "the newest reading replaces the older one for that server");
  assert.equal(revoked.servers.length, 1);
  const states = mcpServerStates(revoked, "docs", listingOf(revoked, "docs"));
  assert.deepEqual([states.configured, states.listed, states.exposed], [true, true, 0], "a re-listed empty server is still configured");
});

test("a write that states no listing keeps the one the panel was already given", () => {
  // The journey found this the hard way: a revocation asks no host, so its answer carries no listing, and a panel that
  // read "no listing in this answer" as "no listing" dropped every tool of that server the moment one grant was
  // written — the person's own tick made the rows they were choosing from disappear.
  const listed = readView(base({ mcp: { listed: listing() } }));
  const grantedBody = base({ mcp: { grants: [{ gatewayId: "workstation", scope: "global", server: "docs", tool: "search", listedAt: 1 }], offered: [MCP_TOOL_PREFIX + "workstation__docs__search"] } });
  const applied = appliedWrite(listed, grantedBody);
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.equal(listingOf(applied.view, "docs").listedAt, listing().listedAt, "the held reading survives a write that states none");
  assert.deepEqual(mcpPanelState(applied.view).tools.map((row) => row.tool), ["search"], "so the rows a person was choosing from are still there");
  assert.equal(applied.view.offered.length, 1, "and the write's own facts are the ones now shown");
  // The answer that does state one is still the newer reading of that server, and only that one.
  const fresh = appliedWrite(listed, base({ mcp: { listed: listing({ listedAt: 9 }) } }));
  assert.equal(listingOf(fresh.view, "docs").listedAt, 9);
  // A refusal is a refusal: nothing of the held view is painted over with it.
  const refused = appliedWrite(listed, { code: "not_listed", error: "the host lists no tool gone" }, 409);
  assert.deepEqual([refused.ok, refused.refusal.code], [false, "not_listed"]);
});

test("a read keeps the listings it did not ask about, and its own answer wins where the two overlap", () => {
  // A state read is one request that asks no host to connect a server, so it says nothing about what any server holds:
  // the rows a person already pressed for are still the newest reading of those servers. Re-reading after a refused
  // listing is the case that needs both at once — the refusal and the tools that were on screen when it happened.
  const listed = readView(base({ mcp: { listed: listing() } }));
  const reread = withHeldListings(readView(base()), listed);
  assert.equal(listingOf(reread, "docs").listedAt, listing().listedAt, "the read's silence is not an empty server");
  assert.deepEqual(mcpPanelState(reread).tools.map((row) => row.tool), ["search"]);
  // An answer that states its own listing is the newer reading, and is not doubled with the older one.
  const fresher = withHeldListings(readView(base({ mcp: { listed: listing({ listedAt: 9 }) } })), listed);
  assert.equal(listingOf(fresher, "docs").listedAt, 9);
  assert.equal(fresher.listings.length, 1, "one server has one listing, whichever answer is newer");
  // Another conversation's readings are never carried over.
  assert.deepEqual(withHeldListings(readView(base()), { ...listed, conversationId: "elsewhere" }).listings, []);
});

test("a selection the panel above this block just stored is the newer statement of it", () => {
  // The extension switch is the same conversation's other half, so a flip is a fact the panel must read from the prop
  // rather than from the read that answered a moment earlier: overriding it keeps every grant and takes availability
  // away, which is the projection the block renders and the one a person acts on before the re-read lands.
  const view = readView(base({ mcp: { grants: [{ gatewayId: "workstation", scope: "global", server: "docs", tool: "search", listedAt: 1 }] } }));
  assert.equal(mcpPanelState(view).tools[0].available, true);
  const off = mcpPanelState({ ...view, extensionSelected: false });
  assert.equal(off.grants.length, 1, "deselecting the extension deletes no grant");
  assert.equal(off.tools[0].selected, true, "the tool is still this conversation's choice");
  assert.equal(off.tools[0].available, false, "but a call for it is not offered while the extension is off");
  assert.equal(off.tools[0].limitedBy, "extension-not-selected", "and the row names the selection as the reason");
  assert.equal(off.extensionSelected, false, "the projection states the selection it was given, not the one it read");
});

test("a host that could not be read states an unknown configuration, never an absent one", () => {
  // 03b keeps a conversation's grants when the host cannot be read, so the panel must not turn that silence into "this
  // host configures no server": the union of configured and granted identities is shown, with the configured state
  // unknown and the grant still selected — which is what keeps a revocation possible while the host is away.
  const offline = readView(base({
    mcp: {
      servers: [],
      serversKnown: false,
      serversRefusal: { code: "gateway_offline", error: "the gateway workstation is not configured" },
      grants: [{ gatewayId: "workstation", scope: "global", server: "docs", tool: "search", description: "Search the docs", listedAt: 1 }],
    },
  }));
  assert.equal(offline.serversKnown, false);
  assert.equal(offline.serversRefusal.code, "gateway_offline", "the seam's own code is kept, not a made-up status");
  const blocks = mcpServerBlocks(offline);
  assert.deepEqual(blocks.map((block) => block.server), ["docs"], "a granted server the host does not name is still shown");
  assert.deepEqual([blocks[0].configured, blocks[0].configUnknown, blocks[0].selected], [false, true, 1]);
  const [row] = rows(offline);
  assert.equal(row.selected, true, "the grant is this conversation's own fact and stays stated");
  assert.equal(row.configured, false);
  assert.equal(row.configUnknown, true, "configured is unknown, not the host's own no");
  assert.equal(row.available, false);
  assert.equal(row.availableUnknown, true, "and availability is unknown rather than a claim either way");
  assert.equal(mcpPanelState(offline).serversKnown, false, "the projection says the read answered nothing");
  assert.deepEqual(mcpPanelState(offline).servers, [{ server: "docs", scope: "global", configured: false, configUnknown: true }]);

  // The same empty list with `serversKnown: true` is the host's own answer: nothing is configured, so a grant of a
  // server it no longer names reads as configured no rather than as unknown, and the revocation control stays.
  const absent = readView(base({
    mcp: { servers: [], serversKnown: true, grants: [{ gatewayId: "workstation", scope: "global", server: "docs", tool: "search", listedAt: 1 }] },
  }));
  const [gone] = rows(absent);
  assert.equal(gone.configUnknown, undefined, "a host that answered states an absence rather than a question");
  assert.equal(gone.available, false, "a server the host no longer configures cannot be run");
  assert.equal(gone.availableUnknown, undefined, "and that is an answer, not an unknown");
  assert.equal(mcpServerBlocks(absent)[0].selected, 1, "the grant is still shown, so it can still be revoked");

  // A configured server and a granted one are the union, in the host's own order first.
  const both = readView(base({ mcp: { grants: [{ gatewayId: "workstation", scope: "global", server: "other", tool: "ping", listedAt: 1 }] } }));
  assert.deepEqual(mcpServerBlocks(both).map((block) => [block.server, block.configured, block.selected]), [["docs", true, 0], ["other", false, 1]]);
});
