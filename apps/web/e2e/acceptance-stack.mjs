/**
 * The real system a client acceptance journey runs against, and nothing about the journey itself.
 *
 * Ticket 16's acceptance is about the combination — a production Web page, an App on its own origin, the client ingress
 * that admits both, the Backend that owns the records and one execution host that really runs the work — so the pieces
 * that must be real are started here on ports and state this run owns, and the driver above states what a person would
 * see. Everything this module creates lives under one temporary directory and is removed with the run unless --keep is
 * passed; no port, SQLite file or process is shared with a running deployment, and nothing here writes to one.
 *
 * What it starts:
 *
 * - the execution gateway (packages/gateway/src/main.ts) on a workspace root this run created, so a tool call that
 *   writes a file is a real write on a real host;
 * - the Backend (apps/server/src/main.ts) over its own SQLite files and its own device-credential store, so a
 *   revocation is a record this Backend keeps;
 * - the client ingress (packages/gateway/src/ingress/main.ts), the one origin a client is admitted by;
 * - one controlled OpenAI-completions endpoint that records every request and answers from the transcript it was
 *   given, so "the model was asked once" is an observation rather than a sleep;
 * - the production Vite builds: apps/web/dist for the Web page and apps/app/dist for the App.
 *
 * The page is served by the ingress and by nothing else. The driver asks the ingress for its shell and **fails** when it
 * does not answer, because the property the Web session depends on — an HttpOnly cookie attached same-origin, with `/api`
 * beside it on the one origin a cutover switches — is only real when one listener serves both. A host of this driver's
 * own that forwarded `/api` to the ingress would give the browser the same shape without testing the thing that ships,
 * and it would let a misconfigured `HEPI_INGRESS_STATIC_DIR` pass as the cutover. That fallback existed while the static
 * slice was still landing beside this driver; the slice is merged, so the fallback is gone.
 */
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import { createReadStream, createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { createServer as probeServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { releaseArtifacts } from "../../../scripts/lib/client-runtime.mjs";

const runShell = promisify(execFile);

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const webRoot = join(repoRoot, "apps", "web");
export const appRoot = join(repoRoot, "apps", "app");

/**
 * The paths of the checkout this run lives in, or the ones one published release supplies.
 *
 * A journey run against `apps/web/dist` and the TypeScript entrypoints is evidence about the **checkout**. A journey run
 * against `release-<id>/ingress.mjs`, `release-<id>/web/`, the release's own gateway tarball installed into a directory
 * the run created, and the release's recorded Backend **image** is evidence about the **artifact a cutover switches**.
 * The ticket's open half is the second kind, so this run names which one it is, on the release's own revision and image
 * id, and refuses a directory that is not a published release rather than falling back to the checkout — a silent
 * fallback would report the checkout as the artifact.
 *
 * Nothing here installs a toolchain or builds an image: an incomplete release is a failure that says what is missing.
 */
export function resolveArtifactSources(releaseDir) {
  if (releaseDir === undefined || releaseDir === "") {
    return { kind: "checkout", releaseDir: null, revision: null };
  }
  const release = releaseArtifacts(resolve(releaseDir));
  return {
    kind: "release",
    releaseDir: resolve(releaseDir),
    artifactId: release.artifactId,
    revision: release.revision,
    imageTag: release.imageTag,
    ingressEntry: release.bundle,
    staticDir: release.staticDir,
    gatewayTarball: release.gatewayTarball,
  };
}

/** The four materials, kept distinct exactly as a deployment keeps them. */
export const SERVICE_TOKEN = "t16-ingress-service-token";
export const WEB_LOGIN = "t16-web-login-material";
export const GATEWAY_TOKEN = "t16-gateway-token";
export const MODEL = "t16-controlled-1";

export function freePort(preferred) {
  return new Promise((resolvePort, reject) => {
    const probe = probeServer();
    probe.on("error", reject);
    probe.listen(preferred ?? 0, "127.0.0.1", () => {
      const address = probe.address();
      if (address === null || typeof address !== "object") { probe.close(); reject(new Error("no port")); return; }
      probe.close(() => resolvePort(address.port));
    });
  });
}

export async function waitForHttp(url, headers, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(2000) });
      if (response.status < 500) { await response.body?.cancel(); return true; }
    } catch { /* not up yet */ }
    await delay(150);
  }
  return false;
}

/** A child runs from an allowlist, so no ambient HEPI_/PI_ value of the developer's shell reaches it. */
export function childEnv(home, extra) {
  return { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, TMPDIR: tmpdir(), ...extra };
}

/**
 * The one controlled OpenAI-completions endpoint.
 *
 * It answers from the transcript it is handed rather than from a queue, so a parent, a tool round and a second turn
 * cannot consume each other's script. A request is recorded with the time it arrived and the text it carried, which is
 * what "one submission reached the model once" and the request count are measured from. hold() closes a gate for one
 * matching turn so a run is genuinely in flight while the driver does something else, and the driver releases it rather
 * than waiting for a sleep.
 *
 * `respond` is for the journeys that need the model to **decide** something the default answer cannot say — a tool call
 * by name, an answer that depends on the transcript. It is given the request body and answers an OpenAI-completions
 * `choice` descriptor: `{ content }` for a plain turn or `{ toolCall: { id, name, arguments } }` for one tool call.
 * Absent, this endpoint answers exactly as it always has, so no existing journey changes behaviour.
 */
export async function startControlledModel({ respond = undefined } = {}) {
  const requests = [];
  const startedAt = Date.now();
  let gate = null;
  const hold = (match) => { gate = { match, closed: true, waiters: [] }; };
  const release = () => { if (gate === null) return; const open = gate; gate = null; for (const resolveWaiter of open.waiters.splice(0)) resolveWaiter(); };
  const server = createHttpServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      if (request.method !== "POST" || request.url !== "/v1/chat/completions") { response.writeHead(404).end(); return; }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const text = JSON.stringify(body.messages ?? []);
      requests.push({ at: Date.now() - startedAt, text, body });
      const frame = (payload) => "data: " + JSON.stringify(payload) + "\n\n";
      const base = { id: "chatcmpl-t16", object: "chat.completion.chunk", created: 1, model: MODEL };
      const answer = async () => {
        const armed = gate;
        if (armed !== null && armed.closed && text.includes(armed.match)) await new Promise((resolveWait) => armed.waiters.push(resolveWait));
        response.writeHead(200, { "content-type": "text/event-stream" });
        const decided = respond === undefined ? undefined : await respond(body);
        if (decided !== undefined) {
          const usage = { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 };
          const call = decided.toolCall;
          if (call === undefined) {
            response.write(frame({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: decided.content ?? "" }, finish_reason: null }] }));
            response.write(frame({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage }));
          } else {
            response.write(frame({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: null, tool_calls: [{ index: 0, id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments ?? {}) } }] }, finish_reason: null }] }));
            response.write(frame({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage }));
          }
          response.end("data: [DONE]\n\n");
          return;
        }
        const userTurns = (body.messages ?? []).filter((message) => message.role === "user").length;
        response.write(frame({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "answer to " + userTurns + " user turns" }, finish_reason: null }] }));
        response.write(frame({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } }));
        response.end("data: [DONE]\n\n");
      };
      void answer().catch(() => response.destroy());
    });
  });
  await new Promise((resolveListen, rejectListen) => { server.once("error", rejectListen); server.listen(0, "127.0.0.1", resolveListen); });
  const address = server.address();
  return {
    origin: "http://127.0.0.1:" + address.port,
    requests,
    hold,
    release,
    close: () => new Promise((done) => { server.closeAllConnections(); server.close(() => done()); }),
  };
}

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json", ".webmanifest": "application/manifest+json",
  ".png": "image/png", ".svg": "image/svg+xml", ".jpg": "image/jpeg", ".webp": "image/webp", ".ico": "image/x-icon",
  ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".wasm": "application/wasm", ".txt": "text/plain; charset=utf-8",
};

/**
 * One directory of built files, with /api forwarded to the ingress.
 *
 * This serves the **App bundle** only: a native shell loads its files from a bundle and reaches the ingress it was
 * configured with, so the browser-emulated App needs an origin of its own that is not the ingress's. Deliberately the
 * smallest thing that can be one: a path lookup under one root and a transparent proxy. A path whose last segment has no
 * extension is a route the page owns and is answered with the shell; a path that names a file is that file or a 404 — the
 * same two rules the ingress states, so a page that works here does not depend on a behaviour the ingress will not have.
 */
export async function startStaticHost(directory, upstream, port) {
  const asked = [];
  const server = createHttpServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://host");
    asked.push((request.method ?? "GET") + " " + url.pathname);
    if (upstream !== "" && (url.pathname === "/api" || url.pathname.startsWith("/api/"))) {
      const forwarded = httpRequest(upstream + request.url, { method: request.method, headers: request.headers }, (upstreamResponse) => {
        response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
        // A hop that loses its upstream ends the caller's response too, which is what a real proxy does and what a
        // browser's stream sees as a closed stream. Leaving it open would make this stand-in kinder than the ingress and
        // would hide the reconnect the page performs.
        upstreamResponse.on("aborted", () => response.destroy());
        upstreamResponse.on("error", () => response.destroy());
        upstreamResponse.pipe(response);
      });
      forwarded.on("error", () => { if (!response.headersSent) response.writeHead(502); response.destroy(); });
      response.on("close", () => { if (!response.writableEnded) forwarded.destroy(); });
      request.pipe(forwarded);
      return;
    }
    const name = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname).replace(/^\//, "");
    const file = join(directory, name);
    const type = CONTENT_TYPES[extname(name)];
    if (resolve(file).startsWith(resolve(directory)) && existsSync(file)) {
      response.writeHead(200, { "content-type": type ?? "application/octet-stream", "cache-control": "no-cache" });
      createReadStream(file).pipe(response);
      return;
    }
    if (type === undefined && existsSync(join(directory, "index.html"))) {
      response.writeHead(200, { "content-type": CONTENT_TYPES[".html"], "cache-control": "no-cache" });
      createReadStream(join(directory, "index.html")).pipe(response);
      return;
    }
    response.writeHead(404, { "content-type": "text/plain" }).end("not found");
  });
  await new Promise((resolveListen, rejectListen) => { server.once("error", rejectListen); server.listen(port, "127.0.0.1", resolveListen); });
  return { origin: "http://127.0.0.1:" + port, asked, close: () => new Promise((done) => { server.closeAllConnections(); server.close(() => done()); }) };
}

/**
 * The whole stack, on this run's own ports and state.
 *
 * webDist is served by the ingress itself; appDist is served by a host of its own, because an App is loaded from a
 * bundle and reaches the ingress cross-origin under a device bearer — which is the difference the ingress's origin list
 * exists for.
 *
 * `piConfigSource` is the Backend's own configuration mode, and it is stated rather than inherited because it decides a
 * claim about credentials (docs/pi-config.md). The default — unset — is the environment source: the Backend's account is
 * the deployment's own variables and an in-memory credential store, so a credential the Gateway stores in this run's
 * agent directory is deliberately not that account's. `"pi"` points the Backend at the *same* agent directory the
 * Gateway owns (`agentDir`), which is the one mode where a stored credential and the Backend's model availability are
 * facts about one account. The Gateway's account directory is returned either way, because "this host stored it" and
 * "this runtime can use it" are two observations and a run that reports them together has to be able to read both.
 */
export async function startAcceptanceStack({ label = "t16", keep = false, ports = {}, log = () => {}, extraAppOrigins = [], releaseDir = "", piConfigSource = "", extraGatewayEnv = {}, piModels = undefined } = {}) {
  const artifact = resolveArtifactSources(releaseDir);
  const artifacts = mkdtempSync(join(tmpdir(), "hepi-" + label + "-"));
  const dataDir = join(artifacts, "data");
  const workspaceRoot = join(artifacts, "workspace");
  // The execution account's pi agent directory. The Gateway writes its credentials here (`agentDirOf(home)` of the home
  // its own process runs as); in Pi mode the Backend is pointed at the same directory, so one run states both halves.
  const gatewayHome = join(artifacts, "gateway-home");
  const agentDir = join(gatewayHome, ".pi", "agent");
  mkdirSync(dataDir, { recursive: true });
  // A Pi-mode run's own `models.json`, written before either process starts: the Backend reads that file when it builds
  // its registry, so a file written after the boot would be a catalog no process had loaded. The Gateway never writes it.
  if (piModels !== undefined) {
    // The account's own directory, at the mode the credential store keeps it in: a run that created it group-readable and
    // then asserted 0700 would be measuring its own fixture rather than the store.
    mkdirSync(agentDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(agentDir, "models.json"), JSON.stringify(piModels, null, 2) + "\n", { mode: 0o600 });
  }
  // One file, not one empty directory: the host's listing is of a workspace's *files*, so an empty root would list
  // nothing and a driver check built on it would pass without saying anything about the host.
  mkdirSync(join(workspaceRoot, "notes"), { recursive: true });
  writeFileSync(join(workspaceRoot, "notes", "first.md"), "a file on the execution host\n");
  const childrenLog = createWriteStream(join(artifacts, "children.log"), { flags: "a" });
  const children = [];
  const servers = [];
  const logs = new Map();
  const containers = [];

  // Each process gets its own buffer, so a restarted role's log is the log of the process that answered — not of every
  // process that ever ran under that name.
  const capture = (name, child) => {
    const chunks = [];
    for (const stream of [child.stdout, child.stderr]) stream?.on("data", (chunk) => { chunks.push(chunk.toString()); childrenLog.write(name + ": " + chunk); });
    logs.set(name, () => chunks.join(""));
    return () => chunks.join("");
  };
  // Which process currently serves each role, so a measurement names the process it measured instead of an index in a
  // list a restart reorders. In release mode the Backend role is a container, whose host pid the driver reads below.
  const roles = {};
  const spawnChild = (name, script, env, args = []) => {
    const child = spawn(process.execPath, [script, ...args], { cwd: repoRoot, env, stdio: ["ignore", "pipe", "pipe"] });
    children.push(child);
    roles[name] = child;
    capture(name, child);
    return child;
  };
  const stopChild = async (child) => {
    if (child === undefined || child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    await Promise.race([exited, delay(10_000).then(() => child.kill("SIGKILL"))]);
    await Promise.race([exited, delay(5_000)]);
  };

  let model;
  let closed = false;
  const stack = { artifacts, dataDir, workspaceRoot, logs, keep, children, artifact };
  /**
   * The pid whose memory a measurement should read for one role.
   *
   * A container's `docker run` client is a few megabytes of CLI, so reading its peak would report the wrong process for
   * the Backend in release mode. `docker inspect` names the host pid of the container's own main process, which is the
   * process the image's Node actually is, and its `/proc/<pid>/status` is readable from here. A role that exited has no
   * pid to ask, and the caller records that rather than a number from a stale process.
   */
  stack.pidOf = async (role) => {
    if (role === "backend" && stack.backendContainerRunning !== undefined) {
      const out = await runShell("docker", ["inspect", "--format", "{{.State.Pid}}", stack.backendContainerRunning]).catch(() => null);
      const pid = Number(String(out?.stdout ?? "").trim());
      return Number.isFinite(pid) && pid > 0 ? pid : null;
    }
    return roles[role]?.pid ?? null;
  };
  const close = async () => {
    if (closed) return;
    closed = true;
    for (const container of containers) {
      // A container this run started belongs to this run: `docker rm -f` releases the name and the port. Ignored
      // failures are a container that is already gone, which is the outcome the run wanted anyway.
      await runShell("docker", ["rm", "-f", container]).catch(() => {});
    }
    for (const server of servers.reverse()) await server.close().catch(() => {});
    for (const child of children.reverse()) await stopChild(child).catch(() => {});
    childrenLog.end();
    if (model !== undefined) await model.close().catch(() => {});
    if (!keep) rmSync(artifacts, { recursive: true, force: true });
  };
  stack.close = close;

  try {
    model = await startControlledModel();
    stack.model = model;

    const gatewayPort = await freePort(ports.gateway);
    stack.gatewayOrigin = "http://127.0.0.1:" + gatewayPort;
    stack.gatewayHome = gatewayHome;
    stack.agentDir = agentDir;
    stack.gatewayEnv = childEnv(gatewayHome, {
      HEPI_GATEWAY_PORT: String(gatewayPort), HEPI_GATEWAY_TOKEN: GATEWAY_TOKEN, HEPI_GATEWAY_ID: "workstation",
      HEPI_GATEWAY_DATA: dataDir, HEPI_WORKSPACE_ID: "local", HEPI_WORKSPACE_ROOT: workspaceRoot, HEPI_ALLOWED_COMMANDS: "bash",
      // What a caller states for the host service itself: a provider whose OAuth endpoint is a run's own stand-in reads
      // its address from this process's environment, so the run states it here rather than in the driver's own shell.
      ...extraGatewayEnv,
    });
    // The execution gateway is either this checkout's TypeScript entry or the release's **installed tarball**, started
    // through the package's own `gateway` command. Installing is not decoration: `@hepi/client` is what a deployment host
    // runs, and the release half of this journey must not quietly run the source tree and call it the artifact.
    stack.gatewayEntry = null;
    if (artifact.kind === "release") {
      const installDir = join(artifacts, "gateway-install");
      mkdirSync(installDir, { recursive: true });
      writeFileSync(join(installDir, "package.json"), JSON.stringify({ name: "hepi-" + label + "-gateway-install", private: true, version: "1.0.0" }, null, 2) + "\n");
      await runShell("npm", ["install", "--no-audit", "--no-fund", "--no-package-lock", artifact.gatewayTarball], { cwd: installDir, maxBuffer: 64 * 1024 * 1024 });
      stack.gatewayEntry = join(installDir, "node_modules", "@hepi", "client", "dist", "cli.js");
      if (!existsSync(stack.gatewayEntry)) throw new Error("the installed gateway bundle has no dist/cli.js: " + stack.gatewayEntry);
    }
    stack.spawnGateway = () => (stack.gatewayEntry === null
      ? spawnChild("gateway", join(repoRoot, "packages", "gateway", "src", "main.ts"), stack.gatewayEnv)
      : spawnChild("gateway", stack.gatewayEntry, stack.gatewayEnv, ["gateway"]));
    stack.spawnGateway();
    if (!await waitForHttp(stack.gatewayOrigin + "/v1/files", {}, 90_000)) throw new Error("the execution gateway did not start: " + logs.get("gateway")().slice(-1200));
    /**
     * Stop the execution host, and start it again on the same port and the same state.
     *
     * An MCP journey needs both halves of one fact: a host that is away is a named limit at the operations that must ask
     * it, and a revoked grant is answered while it is away. The gateway is the role this stops, so nothing else in the
     * stack moves and a driver reads the same ports afterwards.
     */
    stack.stopGateway = async () => {
      const running = roles.gateway;
      if (running !== undefined) children.splice(children.indexOf(running), 1);
      await stopChild(running);
    };
    stack.restartGateway = async () => {
      stack.spawnGateway();
      if (!await waitForHttp(stack.gatewayOrigin + "/v1/files", {}, 90_000)) throw new Error("the restarted execution gateway did not answer: " + logs.get("gateway")().slice(-1200));
    };

    const backendPort = await freePort(ports.backend);
    stack.backendOrigin = "http://127.0.0.1:" + backendPort;
    stack.backendHeaders = { authorization: "Bearer " + SERVICE_TOKEN, "content-type": "application/json" };
    stack.backendEnv = childEnv(join(artifacts, "backend-home"), {
      PORT: String(backendPort), HEPI_BIND_HOST: "127.0.0.1", HEPI_AUTH_TOKEN: SERVICE_TOKEN,
      HEPI_DB: join(dataDir, "conversations.sqlite"),
      HEPI_SKILL_REPOSITORY: join(dataDir, "skill-repository.sqlite"),
      HEPI_PROJECTS: join(dataDir, "projects.sqlite"),
      HEPI_DEVICE_CREDENTIALS: join(dataDir, "device-credentials.sqlite"),
      HEPI_WORKSPACE_ID: "local", HEPI_GATEWAY_ID: "workstation",
      HEPI_GATEWAY_URL: stack.gatewayOrigin, HEPI_GATEWAY_TOKEN: GATEWAY_TOKEN,
      // Pi mode is the one mode whose account is this run's agent directory rather than the deployment's own variables,
      // so the environment-owned base provider is stated only where that account is the environment's.
      ...(piConfigSource === "pi"
        ? { HEPI_CONFIG_SOURCE: "pi", PI_CODING_AGENT_DIR: agentDir }
        : { HEPI_PROVIDER: "t16", HEPI_MODEL: MODEL, HEPI_PROVIDER_BASE_URL: model.origin + "/v1", HEPI_PROVIDER_API_KEY: "t16-controlled-key" }),
    });
    // The Backend is either this checkout's `apps/server` source or the release's recorded **image**, run over a state
    // directory this run owns. In image mode the databases live in the container's `/var/lib/hepi`, a bind mount of
    // `backendStateDir`, so the restart below reads the same files back from disk. The materials travel in a 0600
    // `--env-file`, so no token reaches a process list, exactly as the deployment's unit does, and `--network host`
    // because every port this run picked is a loopback port on this machine.
    stack.backendStateDir = join(artifacts, "backend-state");
    let backendChild;
    let backendRunIndex = 0;
    if (artifact.kind === "release") {
      mkdirSync(stack.backendStateDir, { recursive: true });
      const envFile = join(artifacts, "backend.env");
      const containerEnv = { ...stack.backendEnv };
      containerEnv.HEPI_DB = "/var/lib/hepi/conversations.sqlite";
      containerEnv.HEPI_SKILL_REPOSITORY = "/var/lib/hepi/skill-repository.sqlite";
      containerEnv.HEPI_PROJECTS = "/var/lib/hepi/projects.sqlite";
      containerEnv.HEPI_DEVICE_CREDENTIALS = "/var/lib/hepi/device-credentials.sqlite";
      writeFileSync(envFile, Object.entries(containerEnv).map(([name, value]) => name + "=" + value).join("\n") + "\n", { mode: 0o600 });
      stack.spawnBackendContainer = () => {
        backendRunIndex += 1;
        const containerName = label + "-backend-" + process.pid + "-" + backendRunIndex;
        containers.push(containerName);
        const child = spawn("docker", ["run", "--rm", "--name", containerName, "--network", "host",
          "--user", String(process.getuid?.() ?? 0) + ":" + String(process.getgid?.() ?? 0),
          "--env-file", envFile, "--mount", "type=bind,src=" + stack.backendStateDir + ",dst=/var/lib/hepi", artifact.imageTag],
          { stdio: ["ignore", "pipe", "pipe"] });
        child.containerName = containerName;
        stack.backendContainerRunning = containerName;
        children.push(child);
        capture("backend", child);
        return child;
      };
    }
    /**
     * Release one Backend, in whichever shape this run started it.
     *
     * A container is removed by name rather than by killing the `docker run` client, because a client that is not
     * attached to a terminal does not forward a signal into the container: killing it would leave the FIRST Backend
     * running and holding the port, which is a "restart" that restarted nothing and durable state that was never
     * re-read. The wait until the name is gone is what makes the next start bind its own port.
     */
    stack.stopBackend = async (child) => {
      const name = child?.containerName ?? "";
      if (name === "") { await stopChild(child); return; }
      stack.backendContainerRunning = undefined;
      await runShell("docker", ["rm", "-f", name]).catch(() => {});
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        const listed = await runShell("docker", ["ps", "--all", "--filter", "name=" + name, "--format", "{{.Names}}"]).catch(() => ({ stdout: "" }));
        if (listed.stdout.trim() === "") break;
        await delay(250);
      }
      // The `docker run` client usually exits on its own once its container is removed, and `once` only ever resolves
      // for an event that has not happened yet — awaiting it on a process that already exited hangs the run. The exit
      // check is what the driver's other stop path (`stopChild`) applies for the same reason.
      if (child !== undefined && child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await Promise.race([once(child, "exit"), delay(10_000)]);
      }
    };
    stack.spawnBackend = () => {
      backendChild = stack.spawnBackendContainer !== undefined
        ? stack.spawnBackendContainer()
        : spawnChild("backend", join(repoRoot, "apps", "server", "src", "main.ts"), stack.backendEnv);
      return backendChild;
    };
    /**
     * Stop the Backend and start it again on the same port and the same SQLite files.
     *
     * It waits for the process to be gone before the replacement starts, because a second process that could not bind
     * would leave the first one answering — a "restart" that restarted nothing, and durable state that was never read
     * back from disk. The replacement is only reported ready once it answers on its own port.
     */
    stack.restartBackend = async () => {
      const previous = backendChild;
      await stack.stopBackend(previous);
      if (previous !== undefined) children.splice(children.indexOf(previous), 1);
      stack.spawnBackend();
      if (!await waitForHttp(stack.backendOrigin + "/api/workspaces", stack.backendHeaders, 120_000)) throw new Error("the restarted Backend did not answer: " + logs.get("backend")().slice(-1600));
    };
    stack.spawnBackend();
    if (!await waitForHttp(stack.backendOrigin + "/api/workspaces", stack.backendHeaders, 120_000)) throw new Error("the Backend did not start: " + logs.get("backend")().slice(-1600));

    // The App's own origin is decided before the ingress starts: the ingress answers a declared origin and refuses an
    // undeclared one, so an origin added afterwards would be a different deployment.
    const appPort = await freePort(ports.app);
    stack.appOrigin = "http://127.0.0.1:" + appPort;

    const ingressPort = await freePort(ports.ingress);
    stack.ingressOrigin = "http://127.0.0.1:" + ingressPort;
    // In release mode the ingress process IS the release's `ingress.mjs`: one ESM file, run by the same Node the
    // deployment's unit names. Running the TypeScript entry instead would report this checkout as the artifact.
    const ingressEntry = artifact.ingressEntry ?? join(repoRoot, "packages", "gateway", "src", "ingress", "main.ts");
    stack.ingressEntry = ingressEntry;
    stack.spawnIngress = () => spawnChild("ingress", ingressEntry, childEnv(join(artifacts, "ingress-home"), {
      HEPI_INGRESS_BACKEND: stack.backendOrigin, HEPI_INGRESS_SERVICE_TOKEN: SERVICE_TOKEN, HEPI_WEB_LOGIN_TOKEN: WEB_LOGIN,
      HEPI_INGRESS_DEFAULT_HOST: "workstation", HEPI_INGRESS_HOST: "127.0.0.1", HEPI_INGRESS_PORT: String(ingressPort),
      // The App's own origin, plus any a caller states: a native shell's document origin is the one the WebView gives
      // it (`tauri://localhost`), which no port this run picks could ever be.
      HEPI_APP_ORIGINS: [stack.appOrigin, ...extraAppOrigins].join(","),
      HEPI_INGRESS_STATIC_DIR: artifact.staticDir ?? join(webRoot, "dist"),
      HEPI_REVOCATION_CHECK_MS: "400",
      // The MCP host service of the computer this ingress runs on: the same execution gateway the deployment already
      // starts, named by the id the Backend binds its workspace to. With it the ingress answers /api/mcp from that
      // host's own `POST /v1/mcp` — the deployed shape — instead of reporting that this origin serves no MCP.
      HEPI_INGRESS_MCP_GATEWAY_URL: stack.gatewayOrigin, HEPI_INGRESS_MCP_GATEWAY_TOKEN: GATEWAY_TOKEN, HEPI_INGRESS_MCP_GATEWAY_ID: "workstation",
    }));
    stack.spawnIngress();
    if (!await waitForHttp(stack.ingressOrigin + "/api/web-auth", {}, 90_000)) throw new Error("the client ingress did not start: " + logs.get("ingress")().slice(-1600));

    // The ingress must serve the Web shell on its own origin. Asked plainly, and the run fails on any other answer.
    const shellProbe = await fetch(stack.ingressOrigin + "/", { signal: AbortSignal.timeout(5000) }).catch(() => null);
    const shellBytes = shellProbe === null ? "" : await shellProbe.text().catch(() => "");
    if (shellProbe === null || shellProbe.status !== 200 || !(shellProbe.headers.get("content-type") ?? "").includes("text/html") || !shellBytes.includes("<")) {
      throw new Error("the client ingress does not serve the static Web shell on / (" + (shellProbe === null ? "no answer" : shellProbe.status + " " + (shellProbe.headers.get("content-type") ?? "no content-type")) + "). Point HEPI_INGRESS_STATIC_DIR at apps/web/dist; this driver has no fallback host to substitute for the surface under test");
    }
    stack.webOrigin = stack.ingressOrigin;
    // The App is loaded at its own origin and asks the ingress directly, so this host serves its bundle and forwards
    // nothing the App should not have to ask its configured origin for.
    stack.appStatic = await startStaticHost(join(appRoot, "dist"), stack.ingressOrigin, appPort);
    servers.push(stack.appStatic);
    // A recorded Project over the workspace this run created: the sidebar lists it as a group, and a client opens it by
    // picking the folder the deployment recorded — the same path a person takes on a first visit.
    stack.projectRoot = join(workspaceRoot, "notes");
    const project = await fetch(stack.backendOrigin + "/api/projects", {
      method: "POST",
      headers: stack.backendHeaders,
      body: JSON.stringify({ hostId: "workstation", name: "Notes", folders: [{ root: stack.projectRoot, default: true }] }),
    });
    if (project.status !== 201) throw new Error("the recorded project was not created: " + project.status + " " + await project.text());
    await project.body?.cancel();
    stack.appDist = join(appRoot, "dist");
    stack.webDist = artifact.staticDir ?? join(webRoot, "dist");
    stack.piConfigSource = piConfigSource === "pi" ? "pi" : "env";
    log("static surface: ingress (page at " + stack.webOrigin + ", app at " + stack.appOrigin + ")");
    log(artifact.kind === "release"
      ? "artifact: release-" + artifact.artifactId + " at " + artifact.releaseDir + " (revision " + artifact.revision + ", backend image " + artifact.imageTag + "); the App bundle is this checkout's " + stack.appDist + ", which no client-runtime release carries"
      : "artifact: checkout (source entrypoints and " + join(webRoot, "dist") + ")");
    return stack;
  } catch (error) {
    await close();
    throw error;
  }
}

/** One device credential, issued the way an operator issues one: an authenticated management call on the Backend. */
export async function issueDevice(stack, label) {
  const response = await fetch(stack.backendOrigin + "/api/device-credentials", { method: "POST", headers: stack.backendHeaders, body: JSON.stringify({ label }) });
  if (response.status !== 201) throw new Error("a device credential was not issued: " + response.status + " " + await response.text());
  return await response.json();
}

/**
 * The Web session's cookie, obtained the way the page's own form obtains it: one same-origin POST from the page's origin.
 *
 * It goes to the page's origin rather than to the ingress's address directly, because the ingress checks the write's
 * origin against the origin it was addressed at — a request aimed at the ingress's own port from a page origin is
 * exactly the cross-origin cookie write that check exists to refuse.
 */
export async function webLogin(stack) {
  const response = await fetch(stack.webOrigin + "/api/web-login", {
    method: "POST",
    headers: { "content-type": "application/json", origin: stack.webOrigin },
    body: JSON.stringify({ token: WEB_LOGIN }),
  });
  if (response.status !== 200) throw new Error("the Web login was refused: " + response.status + " " + await response.text());
  await response.body?.cancel();
  return response.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
}

/** One Backend read with the deployment's service credential: what the record really says, beside what a page shows. */
export async function backendJson(stack, path, init) {
  const response = await fetch(stack.backendOrigin + path, { headers: stack.backendHeaders, ...init });
  const text = await response.text();
  if (!response.ok) throw new Error("backend " + path + " -> " + response.status + " " + text.slice(0, 400));
  return JSON.parse(text);
}

/** The production builds this driver measures, as their own files state them. */
export function buildFacts({ webDir = join(webRoot, "dist"), appDir = join(appRoot, "dist") } = {}) {
  const read = (path) => existsSync(path) ? readFileSync(path, "utf8") : null;
  const scriptOf = (index) => index === null ? null : (index.match(/src="([^"]+\.js)"/) ?? [])[1] ?? null;
  const webIndex = read(join(webDir, "index.html"));
  const webScript = scriptOf(webIndex);
  const webAsset = webScript === null ? null : read(join(webDir, webScript.replace(/^\.\//, "")));
  const appIndex = read(join(appDir, "index.html"));
  const appScript = scriptOf(appIndex);
  const appAsset = appScript === null ? null : read(join(appDir, appScript.replace(/^\.\//, "")));
  return {
    web: { script: webScript, indexBytes: Buffer.byteLength(webIndex ?? ""), scriptBytes: webAsset === null ? 0 : Buffer.byteLength(webAsset) },
    app: { script: appScript, indexBytes: Buffer.byteLength(appIndex ?? ""), scriptBytes: appAsset === null ? 0 : Buffer.byteLength(appAsset) },
  };
}
