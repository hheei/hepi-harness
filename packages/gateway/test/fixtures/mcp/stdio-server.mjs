// A minimal MCP server for tests: newline-delimited JSON-RPC over stdio with
// `initialize`, `tools/list` and `tools/call`. Its tools report what the server
// process sees, so tests can check the environment pi-web starts it with.
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

// The names in the environment it started with, for tests that check it without calling a tool.
if (process.env.PI_WEB_FIXTURE_ENV_FILE) {
  writeFileSync(process.env.PI_WEB_FIXTURE_ENV_FILE, JSON.stringify(Object.keys(process.env)));
}
// Its pid, for tests that check it exits once the client closes.
if (process.env.PI_WEB_FIXTURE_PID_FILE) writeFileSync(process.env.PI_WEB_FIXTURE_PID_FILE, String(process.pid));

// A server that cannot start: it says why on stderr and exits before answering.
if (process.env.PI_WEB_FIXTURE_FAIL) {
  process.stderr.write(`${process.env.PI_WEB_FIXTURE_FAIL}\n`);
  process.exit(1);
}

const STANDARD_TOOLS = [
  {
    name: "env_has",
    description: "Whether the server's environment defines a variable.",
    inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
    annotations: { readOnlyHint: true },
  },
  {
    name: "env_get",
    description: "The value of a variable in the server's environment, or null.",
    inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
    annotations: { readOnlyHint: true },
  },
  {
    name: "spawn_child",
    description: "Start a long-running child process and return its pid.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    // No annotations: a tool its server does not mark read-only, without side effects.
    name: "record",
    description: "Return the note it was given.",
    inputSchema: { type: "object", properties: { note: { type: "string" } } },
  },
];

// With PI_WEB_FIXTURE_ODD_TOOLS, tools whose fields other than `name` and
// `inputSchema` are not what the spec says (pi-mcp checks only those two), and
// names that are Object.prototype members.
const ODD_TOOLS = [
  // A tool the server listed without naming it: nothing a surface could show or a person could select.
  { name: " ", description: "A tool the server did not name.", inputSchema: { type: "object" } },
  { name: "numbered", description: 42, title: { text: "no" }, inputSchema: { type: "object" }, annotations: "read-only" },
  { name: "constructor", title: "Builds things\nsecond line", inputSchema: { type: "object" }, annotations: { title: 7, readOnlyHint: "yes" } },
  { name: "toString", description: null, inputSchema: { type: "object" }, annotations: null },
];
// With PI_WEB_FIXTURE_INVOKE_TOOLS, three more tools an invocation test needs: one that takes a
// while (so a deadline or a cancellation can land mid-call), one whose result is larger than a
// host's output bound, and one that reports a failure of its own. They are opt-in so the tool
// count every other fixture test asserts stays the four above (the listing tools below are opt-in
// for the same reason).
const INVOKE_TOOLS = [
  {
    name: "slow",
    description: "Wait, then report that it waited.",
    inputSchema: { type: "object", properties: { ms: { type: "number" } } },
  },
  {
    name: "big",
    description: "Return a single text block of the requested size.",
    inputSchema: { type: "object", properties: { bytes: { type: "number" } } },
  },
  {
    name: "fail",
    description: "Report a failure of its own.",
    inputSchema: { type: "object", properties: {} },
  },
];

// With PI_WEB_FIXTURE_LIST_TOOLS, the tools a listing test needs, and nothing an invocation test asserts: a tool that
// repeats an environment value it was given in the two fields a host has to mask, one whose only usable text is behind
// a blank first line, one described past any host bound, one whose schema is, one the server did not name at all, and
// ones that carry the shapes a host reads by type rather than by trust (a numeric description, a title where a
// description is missing, an `annotations` that is a string, a read-only hint that is not the boolean true).
// A description that has to *change* between two listings cannot come from an environment value: a host masks every
// value its configuration holds, so the same text a test varies would arrive as a redaction, and "the server said
// something else" would read identically both times. With PI_WEB_FIXTURE_LIST_ECHO_FILE the described text is read from
// a file this test writes — a path is masked, the words at the end of it are the server's own.
const LIST_ECHO_FILE = process.env.PI_WEB_FIXTURE_LIST_ECHO_FILE;
const LIST_ECHO = LIST_ECHO_FILE && existsSync(LIST_ECHO_FILE) ? readFileSync(LIST_ECHO_FILE, 'utf8').trim() : (process.env.PI_WEB_FIXTURE_LIST_ECHO || 'nothing');
const LISTING_TOOLS = [
  { name: process.env.PI_WEB_FIXTURE_LIST_TOOL_NAME || 'listed', description: 'Lists ' + LIST_ECHO, inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] }, annotations: { readOnlyHint: true } },
  { name: 'second-line', description: '  \n  The line a panel shows\nthe rest of it', inputSchema: { type: 'object' } },
  { name: 'long-description', description: 'd'.repeat(400), inputSchema: { type: 'object' } },
  { name: 'huge-schema', description: 'A schema larger than any host bound.', inputSchema: { type: 'object', properties: { blob: { type: 'string', default: 'y'.repeat(40_000) } } } },
  { name: 'numbered', description: 42, title: 'The title a panel shows instead', inputSchema: { type: 'object' }, annotations: 'read-only' },
  { name: 'hinted', description: 'A hint that is not a promise.', inputSchema: { type: 'object' }, annotations: { readOnlyHint: 'yes' } },
];

// // With PI_WEB_FIXTURE_LIST_BULK, that many tools whose schema is well over a kilobyte each: enough for one server's
// own list to pass a host's bound on the bytes one answer may cost before it passes its bound on how many tools one
// answer describes.
const BULK = Number(process.env.PI_WEB_FIXTURE_LIST_BULK || 0);
const BULK_TOOLS = Array.from({ length: BULK }, (_unused, index) => ({
  name: 'bulk-' + index,
  description: 'Bulk tool ' + index,
  inputSchema: { type: 'object', properties: { text: { type: 'string', default: 'x'.repeat(1500) } } },
}));

// `tools/list` answers the ordinary set plus these, so one server can be a listing test and an invocation test.
const LIST_TOOLS = [
  ...(process.env.PI_WEB_FIXTURE_LIST_TOOLS ? LISTING_TOOLS : []),
  ...BULK_TOOLS,
];

// With PI_WEB_FIXTURE_PAGE_CURSOR, `tools/list` answers two tiny tools per page and a cursor that never runs out (the
// configured prefix and a page count). A client that follows every cursor it is given would hold this server for as
// long as it liked, which is exactly what a host's own page bound exists to stop.
const PAGE_TOOLS = [
  { name: 'page-a', description: 'One of a server that paginates.', inputSchema: { type: 'object' } },
  { name: 'page-b', description: 'The other one.', inputSchema: { type: 'object' } },
];
let pageAnswers = 0;

const TOOLS = [
  ...(process.env.PI_WEB_FIXTURE_ODD_TOOLS ? ODD_TOOLS : STANDARD_TOOLS),
  ...(process.env.PI_WEB_FIXTURE_INVOKE_TOOLS ? INVOKE_TOOLS : []),
].concat(LIST_TOOLS);

// With PI_WEB_FIXTURE_INIT_ERROR, `initialize` fails with that text repeated
// until the message is over 100,000 characters, as a server's oversized error.
const INIT_ERROR = process.env.PI_WEB_FIXTURE_INIT_ERROR;

function send(message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
}

function toolResult(structuredContent) {
  return { content: [{ type: "text", text: JSON.stringify(structuredContent) }], structuredContent };
}

async function callTool(name, args = {}) {
  switch (name) {
    case "slow": {
      // The file is the evidence that the call reached this server: a test that cancels or times
      // out can then say the server was running when the end arrived, not merely that it answered.
      if (process.env.PI_WEB_FIXTURE_SLOW_FILE) writeFileSync(process.env.PI_WEB_FIXTURE_SLOW_FILE, JSON.stringify(args));
      await new Promise((resolve) => setTimeout(resolve, typeof args.ms === "number" ? args.ms : 5_000));
      return toolResult({ slept: true });
    }
    case "big": {
      const size = typeof args.bytes === "number" ? args.bytes : 400_000;
      return { content: [{ type: "text", text: "x".repeat(size) }] };
    }
    case "fail":
      return { content: [{ type: "text", text: "the tool refused this call" }], isError: true };
    case "env_has":
      return toolResult({ has: Object.hasOwn(process.env, args.name) });
    case "env_get":
      return toolResult({ value: process.env[args.name] ?? null });
    case "record":
      return toolResult({ recorded: args.note ?? null });
    case "list_echo":
      return toolResult({ echoed: process.env.PI_WEB_FIXTURE_LIST_ECHO ?? null });
    case "list_second":
      return toolResult({ second: true });
    case "list_long":
      return toolResult({ long: true });
    case "list_huge":
      return toolResult({ huge: true });
    case "list_cursor":
      return toolResult({ cursor: true });
    case "spawn_child": {
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
      child.unref();
      return toolResult({ pid: child.pid });
    }
    default:
      return undefined;
  }
}

async function answer(method, params) {
  switch (method) {
    case "initialize":
      return {
        protocolVersion: params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "pi-web-env-fixture", version: "1.0.0" },
      };
    case "ping":
      return {};
    case "tools/list": {
      // With PI_WEB_FIXTURE_LIST_DELAY_MS, and a file named by PI_WEB_FIXTURE_SLOW_FILE, the
      // listing waits: enough for a test to end the request that asked for it.
      if (process.env.PI_WEB_FIXTURE_LIST_DELAY_MS) {
        if (process.env.PI_WEB_FIXTURE_SLOW_FILE) writeFileSync(process.env.PI_WEB_FIXTURE_SLOW_FILE, JSON.stringify({ listed: true }));
        await new Promise((resolve) => setTimeout(resolve, Number(process.env.PI_WEB_FIXTURE_LIST_DELAY_MS)));
      }
      const cursor = params && params.cursor;
      if (typeof cursor === "string") return { tools: PAGE_TOOLS, nextCursor: process.env.PI_WEB_FIXTURE_PAGE_CURSOR + "-" + ++pageAnswers };
      pageAnswers = 0;
      if (process.env.PI_WEB_FIXTURE_PAGE_CURSOR) return { tools: PAGE_TOOLS, nextCursor: process.env.PI_WEB_FIXTURE_PAGE_CURSOR + "-0" };
      return { tools: TOOLS };
    }
    case "tools/call":
      return await callTool(params.name, params.arguments);
    default:
      return undefined;
  }
}

async function handle({ id, method, params = {} }) {
  if (id === undefined) return; // notifications need no answer
  if (INIT_ERROR && method === "initialize") {
    send({ id, error: { code: -32603, message: INIT_ERROR.repeat(Math.ceil(100_000 / INIT_ERROR.length)) } });
    return;
  }
  const result = await answer(method, params);
  if (result) send({ id, result });
  else send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
}

const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  if (line.trim()) void handle(JSON.parse(line));
});
// MCP stdio shutdown: the client closes stdin and the server exits.
input.on("close", () => process.exit(0));
