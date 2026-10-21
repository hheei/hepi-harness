#!/usr/bin/env node
/**
 * A stand-in for the external `docker` CLI, so a test can drive the probe without a Docker
 * daemon: it parses the subcommand and evaluates the `--format` Go-template against its own
 * small state, and refuses a template that names a field it does not have.
 *
 * It models docker's interface; it does not establish compatibility with a real docker. A
 * canned line would let the probe's parser and the probe's command line drift apart unnoticed,
 * because both sides would be written to the same invention - this fixture is modelled on the
 * documented command line and output shape instead, which makes that drift *possible to
 * notice* in a test. Whether a real docker prints exactly this remains a question only a run
 * against a real docker answers.
 *
 * The `--format` evaluation covers the subset the probe uses and refuses anything else: `.Path`
 * field access under docker's `missingkey=error` (a path the record does not have is an error),
 * the `index` function (which returns the zero value for a key the map does not have), and
 * `if`/`with`/`else`/`end` blocks.
 *
 * Every invocation is appended to `FAKE_DOCKER_LOG` as one JSON line, which is how a test
 * proves the probe asked for read-only commands and never for `up`, `build`, `pull`, `exec`,
 * `rm` or `compose`. An unknown subcommand is an error rather than a silent success.
 *
 * State comes from `FAKE_DOCKER_STATE` (a JSON file) or the default below. Nothing is written
 * anywhere except the log.
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

const DEFAULT_STATE = {
  images: [
    { Id: "sha256:" + "a1".repeat(32), Repository: "hepi-backend", Tag: "f3652d269697", Architecture: "arm64", Size: "412MB" },
    { Id: "sha256:" + "b2".repeat(32), Repository: "hepi-web", Tag: "f3652d269697", Architecture: "amd64", Size: "233MB" },
    { Id: "sha256:" + "c3".repeat(32), Repository: "<none>", Tag: "<none>", Architecture: "arm64", Size: "0B" },
  ],
  containers: [
    {
      Id: "9f1c0de4".repeat(8),
      Names: "hepi-backend-1",
      Image: "hepi-backend:f3652d269697",
      Status: "Up 3 hours",
      Name: "/hepi-backend-1",
      RestartCount: 0,
      StartedAt: "2026-10-11T00:00:00.123456789Z",
      Config: { Image: "hepi-backend:f3652d269697" },
      State: { StartedAt: "2026-10-11T00:00:00.123456789Z", Health: { Status: "healthy" } },
    },
    // A container with no `HEALTHCHECK` has no `State.Health` at all, which is the state a real
    // docker host is in for most of its containers. A `--format` template that names that path
    // fails for every container, not just this one, so a fixture without such a container could
    // not tell a tolerant read from a broken one.
    {
      Id: "7d5e2b91".repeat(8),
      Names: "hepi-redis-1",
      Image: "redis:7-alpine",
      Status: "Up 3 weeks",
      Name: "/hepi-redis-1",
      RestartCount: 0,
      StartedAt: "2026-09-20T17:55:05.012560868Z",
      Config: { Image: "redis:7-alpine" },
      State: { StartedAt: "2026-09-20T17:55:05.012560868Z" },
    },
  ],
};

const argv = process.argv.slice(2);
if (process.env.FAKE_DOCKER_LOG) {
  mkdirSync(dirname(process.env.FAKE_DOCKER_LOG), { recursive: true });
  appendFileSync(process.env.FAKE_DOCKER_LOG, JSON.stringify(argv) + "\n");
}

const fail = (message) => {
  process.stderr.write("docker: " + message + "\n");
  process.exit(1);
};

const statePath = process.env.FAKE_DOCKER_STATE;
const state = statePath ? JSON.parse(readFileSync(statePath, "utf8")) : DEFAULT_STATE;

const flags = new Set(argv.filter((arg) => arg.startsWith("-")));
const words = argv.filter((arg) => !arg.startsWith("-"));
const formatIndex = argv.indexOf("--format");
const template = formatIndex === -1 ? null : argv[formatIndex + 1];
const quiet = flags.has("-q") || flags.has("--quiet");

/** Split a template into text runs and `{{...}}` tags. */
function tokenize(text) {
  const tokens = [];
  let last = 0;
  for (const match of text.matchAll(/\{\{([^{}]*)\}\}/g)) {
    if (match.index > last) tokens.push({ text: text.slice(last, match.index) });
    tokens.push({ tag: match[1].trim() });
    last = match.index + match[0].length;
  }
  if (last < text.length) tokens.push({ text: text.slice(last) });
  return tokens;
}

/** Parse tags into text, expression and block nodes, refusing a construct it does not know. */
function parse(tokens, start = 0, stops = []) {
  const nodes = [];
  let index = start;
  while (index < tokens.length) {
    const token = tokens[index];
    if (token.text !== undefined) {
      nodes.push(token);
      index += 1;
      continue;
    }
    const [head] = token.tag.split(/\s+/);
    if (stops.includes(head)) return { nodes, next: index };
    if (head === "if" || head === "with") {
      const body = parse(tokens, index + 1, ["else", "end"]);
      let alternative = { nodes: [], next: body.next };
      let next = body.next;
      if (tokens[next]?.tag === "else") {
        alternative = parse(tokens, next + 1, ["end"]);
        next = alternative.next;
      }
      if (tokens[next]?.tag !== "end") fail("unterminated {{" + head + "}} in the format template");
      nodes.push({ block: head, expr: token.tag.slice(head.length).trim(), body: body.nodes, alternative: alternative.nodes });
      index = next + 1;
      continue;
    }
    nodes.push({ expr: token.tag });
    index += 1;
  }
  return { nodes, next: index };
}

/**
 * Evaluate one expression against the current scope. `.Path` is docker's field access and
 * fails on a key the record does not have (docker runs its template with `missingkey=error`);
 * `index` is the function that returns the zero value instead, which is how a template reads a
 * field only some records carry.
 */
function evaluate(expr, scope, label) {
  if (expr.startsWith(".")) {
    // docker spells the image id `.ID` in `image ls` and `.Id` in inspect JSON; the state
    // keeps one spelling and the fixture honours both, the way docker does.
    const requested = expr.slice(1);
    let value = scope;
    for (const key of (requested === "ID" ? "Id" : requested).split(".")) {
      if (value === undefined || value === null || !(key in value)) {
        fail("template asked for " + expr + ", which " + label + " does not have");
      }
      value = value[key];
    }
    return value;
  }
  const indexed = /^index\s+(\S+)\s+"([^"]*)"$/.exec(expr);
  if (indexed) {
    const container = evaluate(indexed[1], scope, label);
    return container === undefined || container === null ? undefined : container[indexed[2]];
  }
  fail("template expression the fixture cannot evaluate: {{" + expr + "}}");
}

/** Go template truth: a zero value - a missing map, an empty string - is false. */
const truthy = (value) =>
  !(
    value === undefined || value === null || value === false || value === 0 || value === "" ||
    (Array.isArray(value) && value.length === 0) ||
    (typeof value === "object" && Object.keys(value).length === 0)
  );

const stringify = (value) => (value === undefined || value === null ? "<no value>" : String(value));

function renderNodes(nodes, scope, label) {
  let out = "";
  for (const node of nodes) {
    if (node.text !== undefined) {
      out += node.text;
      continue;
    }
    if (node.block === undefined) {
      out += stringify(evaluate(node.expr, scope, label));
      continue;
    }
    const value = evaluate(node.expr, scope, label);
    // `with` rebinds `.` to its value; `if` does not. Both take their alternative when false.
    out += truthy(value)
      ? renderNodes(node.body, node.block === "with" ? value : scope, label)
      : renderNodes(node.alternative, scope, label);
  }
  return out;
}

/** Evaluate the `--format` template against one record, refusing an unknown field. */
function render(record, label) {
  if (template === null) return "";
  return renderNodes(parse(tokenize(template)).nodes, record, label);
}

const subcommand = words.slice(0, 2).join(" ");
const print = (records, label) => {
  for (const record of records) process.stdout.write(render(record, label) + "\n");
};

if (subcommand === "image ls") {
  if (quiet) for (const image of state.images) process.stdout.write(image.Id + "\n");
  else print(state.images, "the image");
} else if (subcommand === "image inspect") {
  const wanted = words.slice(2);
  const chosen = state.images.filter((image) => wanted.includes(image.Id));
  if (chosen.length === 0) fail("no such image");
  print(chosen, "the image");
} else if (words[0] === "ps") {
  if (quiet) for (const container of state.containers) process.stdout.write(container.Id + "\n");
  else print(state.containers, "the container");
} else if (words[0] === "inspect") {
  const wanted = words.slice(1);
  const chosen = state.containers.filter((container) => wanted.includes(container.Id));
  if (chosen.length === 0) fail("no such container");
  print(chosen, "the container");
} else {
  // Anything else - `up`, `build`, `buildx`, `pull`, `exec`, `rm`, `compose` - is not
  // implemented, so a probe that asks for one fails loudly instead of mutating a host.
  fail("unsupported subcommand: " + (words.join(" ") || "(none)"));
}
