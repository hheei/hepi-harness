import { posix } from "node:path";
import type { Context } from "@earendil-works/chord";
import { ExecutionError, FileError, type BinaryReader, type ExecutionEnv, type FileInfo, type Result, type ShellExecOptions } from "@earendil-works/pi-durable/env";
import { GatewayHostClient } from "./client.ts";
import type { ExecuteRequest } from "./execution.ts";
import type { ExecutionHost, FileRequest, ResourceSnapshot } from "./filesystem.ts";

export type EnvironmentBinding = { id: string; gatewayId: string; gatewayOrigin: string; gatewayToken: string };

/** The identity of one tool call: what an execution scope is opened for. */
export type ExecutionIdentity = { readonly conversationId: string; readonly taskId: string; readonly callId: string };

/**
 * An `ExecutionEnv` whose host can be resolved. The extra methods are what make the account, home, and resource roots
 * of the machine behind the environment available to the runtime, instead of guessing them from the backend process.
 */
export type ExecutionHostEnv = ExecutionEnv & {
  executionHost(context: Context): Promise<Result<ExecutionHost, FileError>>;
  /**
   * The whole execution-side resource scope set in one request (ADR 0002): one discovery is one round trip, never one
   * per root, kind or file.
   */
  resourceSnapshot(context: Context): Promise<Result<ResourceSnapshot, FileError>>;
  /**
   * One execution scope per tool call. A tool call executes a command at a time, and a tool that runs several commands
   * means several executions, so the scope gives each of them its own identity: the n-th `exec` runs as
   * `<conversation>:<task>:<call>#n`. A repeated network request for one of those identities is still answered from
   * the gateway ledger without running the command again.
   *
   * The identity is not promised to repeat across attempts: a later attempt of the same intent gets a new scope, and a
   * caller that reuses a base gets the ordinals of the scope it opened.
   */
  forCall(identity: ExecutionIdentity): ExecutionHostEnv;
  /**
   * The restricted agent definition surface: reads, listings and atomic mutations inside the two agent definition
   * directories of this host — the project's \`<workspace>/.pi/agents\` and the account's \`<agent dir>/agents\`. A
   * request on this surface names the capability the gateway enforces, so the definition API cannot reach any other
   * host path, and it is the only way the backend reads or writes a definition.
   */
  readonly agentDefinitions: {
    listDir(path: string, context: Context): Promise<Result<FileInfo[], FileError>>;
    readTextFile(path: string, context: Context): Promise<Result<string, FileError>>;
    writeFile(path: string, content: string, context: Context): Promise<Result<void, FileError>>;
    createDir(path: string, context: Context): Promise<Result<void, FileError>>;
    renameFile(source: string, destination: string, context: Context): Promise<Result<void, FileError>>;
    remove(path: string, context: Context): Promise<Result<void, FileError>>;
    exists(path: string, context: Context): Promise<Result<boolean, FileError>>;
  };
};
export function gatewayEnvironment(binding: EnvironmentBinding, cwd = "/", scope?: { readonly base: string }): ExecutionHostEnv {
  // One client per environment: executions and the abort that stops them share one origin, token and classification.
  const client = new GatewayHostClient({ gatewayOrigin: binding.gatewayOrigin, gatewayToken: binding.gatewayToken });
  // The file RPC is the client's: this environment names the method and the path and reads the filesystem's own result,
  // while the route, the bearer header, cancellation and the meaning of a lost answer stay in one place.
  const rpc = async <T>(request: Omit<FileRequest, "workspaceId">, context: Context): Promise<Result<T, FileError>> =>
    await client.files.rpc<T>({ ...request, workspaceId: binding.id }, { ...(context.abortSignal === undefined ? {} : { signal: context.abortSignal }) });
  const absolute = (path: string) => posix.resolve(cwd, path);
  // The ordinal of this environment instance's own scope: lexical, so two scopes cannot share it, and per instance,
  // so each `exec` on the scope it belongs to is a distinct execution.
  let ordinal = 0;
  const supported = {
    forCall: (identity: ExecutionIdentity) => gatewayEnvironment(binding, cwd, { base: identity.conversationId + ":" + identity.taskId + ":" + identity.callId }),
    id: binding.gatewayId + ":" + binding.id, cwd,
    absolutePath: async (path: string) => ({ ok: true as const, value: absolute(path) }),
    joinPath: async (parts: string[]) => ({ ok: true as const, value: posix.join(...parts) }),
    /**
     * The execution account, its home, and the execution-side resource roots of the workspace this environment serves
     * (ADR 0002). The gateway resolves them on the host it executes on, so the backend never guesses a home path.
     */
    executionHost: (context: Context) => rpc<ExecutionHost>({ method: "executionHost" }, context),
    resourceSnapshot: (context: Context) => rpc<ResourceSnapshot>({ method: "resourceSnapshot" }, context),
    agentDefinitions: {
      listDir: (path: string, context: Context) => rpc<FileInfo[]>({ method: "listDir", path: absolute(path), resource: "agent-definitions" }, context),
      readTextFile: (path: string, context: Context) => rpc<string>({ method: "readTextFile", path: absolute(path), resource: "agent-definitions" }, context),
      writeFile: (path: string, content: string, context: Context) => rpc<void>({ method: "writeFile", path: absolute(path), content, encoding: "utf8", resource: "agent-definitions" }, context),
      createDir: (path: string, context: Context) => rpc<void>({ method: "createDir", path: absolute(path), options: { recursive: true }, resource: "agent-definitions" }, context),
      renameFile: (source: string, destination: string, context: Context) => rpc<void>({ method: "renameFile", path: absolute(source), destinationPath: absolute(destination), resource: "agent-definitions" }, context),
      remove: (path: string, context: Context) => rpc<void>({ method: "remove", path: absolute(path), resource: "agent-definitions" }, context),
      exists: (path: string, context: Context) => rpc<boolean>({ method: "exists", path: absolute(path), resource: "agent-definitions" }, context),
    },
    canonicalPath: (path: string, context: Context) => rpc({ method: "canonicalPath", path: absolute(path) }, context),
    readTextFile: (path: string, context: Context) => rpc({ method: "readTextFile", path: absolute(path) }, context),
    readBinaryFile: async (path: string, context: Context) => { const result = await rpc<string>({ method: "readBinaryFile", path: absolute(path) }, context); return result.ok ? { ok: true as const, value: Buffer.from(result.value, "base64") } : result; },
    writeFile: (path: string, content: string | Uint8Array, context: Context) => rpc({ method: "writeFile", path: absolute(path), content: typeof content === "string" ? content : Buffer.from(content).toString("base64"), encoding: typeof content === "string" ? "utf8" : "base64" }, context),
    appendFile: (path: string, content: string | Uint8Array, context: Context) => rpc({ method: "appendFile", path: absolute(path), content: typeof content === "string" ? content : Buffer.from(content).toString("base64"), encoding: typeof content === "string" ? "utf8" : "base64" }, context),
    truncateFile: (path: string, size: number, context: Context) => rpc({ method: "truncateFile", path: absolute(path), size }, context),
    flushFile: (path: string, context: Context) => rpc({ method: "flushFile", path: absolute(path) }, context),
    renameFile: (source: string, destination: string, context: Context) => rpc({ method: "renameFile", path: absolute(source), destinationPath: absolute(destination) }, context),
    remove: (path: string, options: { recursive?: boolean; force?: boolean } | undefined, context: Context) => rpc({ method: "remove", path: absolute(path), options }, context),
    createTempDir: (prefix: string | undefined, context: Context) => rpc({ method: "createTempDir", prefix }, context),
    createTempFile: (options: { prefix?: string; suffix?: string } | undefined, context: Context) => rpc({ method: "createTempFile", ...options }, context),
    createDir: (path: string, options: { recursive?: boolean } | undefined, context: Context) => rpc({ method: "createDir", path: absolute(path), options }, context),
    exists: (path: string, context: Context) => rpc({ method: "exists", path: absolute(path) }, context),
    fileInfo: (path: string, context: Context) => rpc({ method: "fileInfo", path: absolute(path) }, context),
    listDir: (path: string, context: Context) => rpc({ method: "listDir", path: absolute(path) }, context),
    async openBinaryReader(path: string, options: { noFollow?: boolean } | undefined, context: Context) {
      const opened = await rpc<string>({ method: "openBinaryReader", path: absolute(path), options }, context);
      if (!opened.ok) return opened;
      const handle = opened.value;
      const reader: BinaryReader = {
        info: context => rpc({ method: "reader.info", handle }, context),
        read: async (offset, length, context) => { const value = await rpc<string>({ method: "reader.read", handle, offset, length }, context); return value.ok ? { ok: true, value: Buffer.from(value.value, "base64") } : value; },
        scanLines: (options, context) => rpc({ method: "reader.scanLines", handle, options }, context),
        close: async context => { await rpc({ method: "reader.close", handle }, context); },
      };
      return { ok: true as const, value: reader };
    },
    async exec(command: string | readonly string[], options: ShellExecOptions | undefined, context: Context) {
      const callId = scope === undefined ? crypto.randomUUID() : scope.base + "#" + ++ordinal;
      const request: ExecuteRequest = {
        gatewayId: binding.gatewayId,
        workspaceId: binding.id,
        callId,
        command: typeof command === "string" ? ["/bin/bash", "-c", command] : command,
        cwd: absolute(options?.cwd ?? cwd),
        env: options?.env,
        timeoutMs: options?.timeout === undefined ? undefined : options.timeout * 1000,
        ...(options?.spill === undefined ? {} : { spill: options.spill }),
        ...(options?.window === undefined ? {} : { window: options.window }),
      };
      // A lost abort answer is not a second abort: an abort whose outcome is unknown is dropped, and the call's own
      // result reports what happened to the command.
      const abort = () => { void client.process.abort(callId).catch(() => {}); };
      // An abort before dispatch is refused by the gateway as well: the call ID is remembered, so a request that
      // arrives late is answered "aborted" instead of being run and then killed.
      if (context.abortSignal?.aborted) return { ok: false as const, error: new ExecutionError("aborted", "aborted before dispatch") };
      context.abortSignal?.addEventListener("abort", abort, { once: true });
      try {
        // Output is awaited: a caller that commits progress holds the next frame back, so the gateway cannot outrun it.
        const result = await client.process.execute(request, async (chunk) => { await options?.onOutput?.(chunk.text, context, { stream: chunk.stream, ...(chunk.skipped === undefined ? {} : { skipped: chunk.skipped }) }); }, { ...(context.abortSignal === undefined ? {} : { signal: context.abortSignal }) });
        if (!result.ok) {
          // `timeout` and `aborted` are what they name, and a definitive refusal stays the gateway's own answer. Only a
          // lost answer is restated: upstream's `ExecutionError` codes are a closed set with no unknown-outcome member,
          // and this message is all the tool result and the model get, so the may-have-run distinction and the spent call
          // ID it can be resolved under travel in the text instead of flattening into one generic failure (ADR 0006).
          const error = result.code === "outcome-unknown"
            ? new ExecutionError("unknown", "outcome_unknown: the command may have run and its outcome is not established; this call is never replayed (" + (result.message ?? "the gateway answered outcome-unknown") + (result.callId === undefined ? "" : ", call " + result.callId) + ")")
            : new ExecutionError(result.code === "timeout" || result.code === "aborted" ? result.code : "unknown", result.message ?? result.code);
          if (result.spillPath !== undefined) error.spillPath = result.spillPath;
          return { ok: false as const, error };
        }
        if (result.truncated || result.spillUnsupported) await options?.onOutput?.("\n[gateway: " + (result.truncated ? "retained output was truncated; " : "") + (result.spillUnsupported ? "full-output spill is unavailable on this transport" : "") + "]\n", context, { stream: "stderr" });
        return { ok: true as const, value: { exitCode: result.exitCode, ...(result.spillPath === undefined ? {} : { spillPath: result.spillPath }) } };
      } finally { context.abortSignal?.removeEventListener("abort", abort); }
    },
    cleanup: async () => {},
  };
  return new Proxy(supported, { get(target, property) { if (property === "then") return undefined; if (property in target) return Reflect.get(target, property); return async () => ({ ok: false, error: new FileError("not_supported", String(property) + " is not enabled by gateway") }); } }) as unknown as ExecutionHostEnv;
}
