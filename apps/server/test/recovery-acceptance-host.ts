/**
 * The execution host and the request witness ticket 04 measures a lost mutation against.
 *
 * Gap G3 is a claim about the **deployment's** loss: a gateway process that died while a delegated child's command was
 * running, and a call journal that outlives it. So the host here is the real entrypoint
 * (`packages/gateway/src/main.ts`) in its own process over its own SQLite journal, started the way `pnpm dev` and the
 * browser drivers start it, and ended with `SIGKILL` — no drain, no close, no answer.
 *
 * The one thing this fixture adds is a transparent hop in front of that process, recording the execution request the
 * environment actually sent. That record is what lets the caller replay the call under its **exact** identity and
 * arguments after the restart, which is the only replay attempt the ledger's own rule speaks to: a hand-built request
 * could differ in a field nobody thought of, and a refused call would then prove nothing.
 *
 * The hop forwards bytes both ways and decides nothing. When the host dies, its response ends with no result frame and
 * the hop destroys the body: classifying that stays the code under test.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The repo root, so the gateway entrypoint is run the way every other driver of it runs it. */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** One free loopback port, claimed by a probe socket that is closed before the port is used. */
export function freePort(): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    const probe = createNetServer();
    probe.on("error", rejectPort);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address === null || typeof address !== "object") { probe.close(() => rejectPort(new Error("no free port"))); return; }
      probe.close(() => resolvePort(address.port));
    });
  });
}

export type GatewayHostOptions = {
  /** The same identity the composed in-process file host states, so the workspace binding is one identity, not two. */
  readonly token: string;
  readonly gatewayId: string;
  readonly workspaceId: string;
  readonly workspaceRoot: string;
  readonly allowedCommands: readonly string[];
  /** The journal is the durable identity record: a restarted host is pointed at the same file, not a new one. */
  readonly journalPath: string;
  /** The host account's own home, where its agent directory lives. */
  readonly home: string;
  /** Where the host's pid is written, so the process that owns the window can end it. */
  readonly pidPath?: string;
};

export type GatewayHost = {
  readonly origin: string;
  readonly pid: number;
  /** Resolves with how the process ended: the signal that killed it, or its exit code when it ended by itself. */
  readonly ended: Promise<{ signal: string | null; code: number | null }>;
  /** The host's own output, for a failure message that has to say why it went away. */
  output(): string;
  kill(): void;
};

/**
 * Start the gateway as the deployment runs it: its entrypoint, its process, its journal.
 *
 * It is ready when it answers one of its own routes. The caller ends it with `kill()`, which leaves a call in flight
 * exactly as the audit describes it: a row this process can no longer answer, and no answer that says it did not run.
 */
export async function startGatewayHost(options: GatewayHostOptions): Promise<GatewayHost> {
  const port = await freePort();
  const child = spawn(process.execPath, [join(REPO_ROOT, "packages", "gateway", "src", "main.ts")], {
    cwd: REPO_ROOT,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: options.home,
      TMPDIR: tmpdir(),
      HEPI_GATEWAY_TOKEN: options.token,
      HEPI_GATEWAY_ID: options.gatewayId,
      HEPI_GATEWAY_PORT: String(port),
      HEPI_GATEWAY_DB: options.journalPath,
      HEPI_WORKSPACE_ID: options.workspaceId,
      HEPI_WORKSPACE_ROOT: options.workspaceRoot,
      HEPI_ALLOWED_COMMANDS: options.allowedCommands.join(","),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.ok(child.pid !== undefined, "the gateway host has a pid");
  if (options.pidPath !== undefined) {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(options.pidPath, String(child.pid));
  }
  const reported: string[] = [];
  child.stdout.on("data", (chunk: Buffer) => { reported.push(chunk.toString()); });
  child.stderr.on("data", (chunk: Buffer) => { reported.push(chunk.toString()); });
  const ended = new Promise<{ signal: string | null; code: number | null }>((resolveEnded) => { child.on("exit", (code, exitSignal) => resolveEnded({ signal: exitSignal, code })); });
  const origin = "http://127.0.0.1:" + port;
  const deadline = Date.now() + 60_000;
  for (;;) {
    const up = await fetch(origin + "/v1/workspaces", { headers: { authorization: "Bearer " + options.token } })
      .then(response => response.status < 500)
      .catch(() => false);
    if (up) return {
      origin,
      pid: child.pid,
      ended,
      output: () => reported.join(""),
      kill: () => { child.kill("SIGKILL"); },
    };
    if (child.exitCode !== null) throw new Error("the gateway host exited with " + String(child.exitCode) + ": " + reported.join(""));
    if (Date.now() > deadline) { child.kill("SIGKILL"); throw new Error("the gateway host never served: " + reported.join("")); }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 50));
  }
}

export type RequestWitness = {
  readonly origin: string;
  /** Every `/v1/execute` body this hop forwarded, in order and exactly as the environment sent it. */
  requests(): string[];
  close(): Promise<void>;
};

/**
 * A transparent hop that records the execution requests passing through it to a gateway host.
 *
 * Only the request is captured; the answer is streamed on untouched, so a host that dies mid-call still leaves its
 * caller with a body that ends with no result. The hop produces no outcome of its own.
 */
export async function startRequestWitness(gatewayOrigin: string, token: string): Promise<RequestWitness> {
  const seen: string[] = [];
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => { chunks.push(chunk); });
    request.on("end", () => {
      const body = Buffer.concat(chunks);
      if (request.url === "/v1/execute") seen.push(body.toString("utf8"));
      const controller = new AbortController();
      response.on("close", () => { controller.abort(); });
      void fetch(gatewayOrigin + String(request.url ?? "/"), {
        method: request.method ?? "POST",
        headers: { authorization: "Bearer " + token, "content-type": String(request.headers["content-type"] ?? "application/json") },
        ...(body.byteLength === 0 ? {} : { body, duplex: "half" as const }),
        signal: controller.signal,
      }).then(async (upstream) => {
        response.writeHead(upstream.status, { "content-type": String(upstream.headers.get("content-type") ?? "application/json") });
        if (upstream.body === null) { response.end(); return; }
        const reader = upstream.body.getReader();
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          response.write(Buffer.from(next.value));
        }
        response.end();
      }).catch(() => {
        // The host went away mid-response, so the body ends with no answer: the loss is the caller's to classify.
        if (!response.headersSent) response.writeHead(502, { "content-type": "application/json" });
        response.destroy();
      });
    });
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  return {
    origin: "http://127.0.0.1:" + address.port,
    requests: () => [...seen],
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    },
  };
}

/**
 * One execution call on the gateway's own wire, for the restarted host.
 *
 * The protocol is newline-delimited frames ending in exactly one result frame, so the answer is the last frame the
 * host wrote — including for a call the journal already refuses.
 */
export async function executeRequest(origin: string, token: string, body: string): Promise<Record<string, unknown>> {
  const answer = await fetch(origin + "/v1/execute", { method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" }, body });
  const text = await answer.text();
  const frames = text.split("\n").filter(line => line.trim() !== "").map(line => JSON.parse(line) as { result?: Record<string, unknown> });
  const result = frames.at(-1)?.result;
  assert.ok(result !== undefined, "the restarted host sent no result frame: " + text);
  return result;
}

/** The last line a stage printed: the facts it read at its own kill point. */
export function requireFacts(stdout: string, stderr: string): Record<string, unknown> {
  const line = stdout.trim().split("\n").at(-1);
  assert.ok(line !== undefined && line.startsWith("{"), "the stage printed no facts: " + stderr + stdout);
  return JSON.parse(line) as Record<string, unknown>;
}
