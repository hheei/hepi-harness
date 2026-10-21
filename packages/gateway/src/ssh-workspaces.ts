import { isAbsolute } from "node:path";
import type { SshProfile, SshRunner, SshRunnerResult } from "./index.ts";
import type { ExecutionHostIdentity } from "./filesystem.ts";
import type { WorkspaceListing, WorkspaceProfile, WorkspaceRegistration, WorkspaceRegistry, WorkspaceRequest, WorkspaceResult } from "./workspaces.ts";

/** One remote workspace request may run this long before the runner gives up with an unknown outcome. */
export const SSH_WORKSPACE_TIMEOUT_MS = 30_000;

/**
 * The remote program the workspace surface runs over the existing SSH runner. It is deliberately small and has one
 * job: list the directories of a path on the host, canonicalize a path that is an existing directory, or report the
 * account the host itself resolves. It never creates, renames or writes anything, and it needs nothing on the host
 * but the standard library's Python 3 — the same requirement the file and installation helpers already have.
 */
const REMOTE_WORKSPACE_SCRIPT = [
  "import json, os, pwd, sys",
  "def emit(value): print(json.dumps(value))",
  "def fail(code, message): emit({\"ok\": False, \"error\": {\"code\": code, \"message\": message}})",
  "mode = sys.argv[1]",
  "try:",
  "    if mode == \"host\":",
  "        entry = pwd.getpwuid(os.getuid())",
  "        emit({\"ok\": True, \"value\": {\"user\": entry.pw_name, \"home\": os.path.realpath(entry.pw_dir)}})",
  "    elif mode == \"browse\":",
  "        requested = sys.argv[2]",
  "        if not os.path.isabs(requested): fail(\"invalid_request\", \"an absolute path is required\")",
  "        elif not os.path.exists(requested): fail(\"not_found\", requested)",
  "        elif not os.path.isdir(requested): fail(\"not_a_directory\", requested)",
  "        else:",
  "            real = os.path.realpath(requested)",
  "            names = []",
  "            for name in sorted(os.listdir(real)):",
  "                entry = os.path.join(real, name)",
  "                if os.path.isdir(entry): names.append({\"name\": name, \"path\": entry})",
  "            parent = os.path.dirname(real)",
  "            emit({\"ok\": True, \"value\": {\"path\": real, \"parentPath\": None if parent == real else parent, \"directories\": names}})",
  "    elif mode == \"register\":",
  "        requested = sys.argv[2]",
  "        if not os.path.isabs(requested): fail(\"invalid_root\", \"an absolute path is required\")",
  "        elif not os.path.isdir(requested): fail(\"invalid_root\", requested)",
  "        else: emit({\"ok\": True, \"value\": {\"root\": os.path.realpath(requested)}})",
  "    else: fail(\"not_supported\", \"unknown remote workspace operation: \" + mode)",
  "except OSError as error:",
  "    emit({\"ok\": False, \"error\": {\"code\": \"permission_denied\" if error.errno in (1, 13) else \"operation_failed\", \"message\": str(error)}})",
  "",
].join("\n");

const REMOTE_WORKSPACE_BASE64 = Buffer.from(REMOTE_WORKSPACE_SCRIPT, "utf8").toString("base64");
const REMOTE_BOOTSTRAP = "import base64,sys;src=base64.b64decode(sys.argv[1]);sys.argv=[sys.argv[0]]+sys.argv[2:];exec(compile(src,'hepi-workspaces','exec'))";

export type SshWorkspaceOptions = {
	/** The configured SSH profiles this gateway serves, by id. */
	readonly profiles: readonly SshProfile[];
	readonly runner: SshRunner;
};

/**
 * The workspace management surface of an SSH gateway, served on the same \`/v1/workspaces\` route the local gateway
 * already answers. It resolves every id through the shared registry, so a folder the backend registered is served by
 * execution, files and installation at the same time, and it resolves a root on the host rather than on this machine:
 * a path is canonicalized and confirmed by the remote helper, and nothing here reads, creates or renames a directory.
 *
 * A host that cannot answer reports its own state — \`unreachable\` or \`not_supported\` when Python 3 is absent — and
 * never falls back to a local directory, the gateway process account, or another profile.
 */
export class SshWorkspaceServer {
	readonly #registry: WorkspaceRegistry;
	readonly #profiles: ReadonlyMap<string, SshProfile>;
	readonly #runner: SshRunner;

	constructor(registry: WorkspaceRegistry, options: SshWorkspaceOptions) {
		this.#registry = registry;
		this.#profiles = new Map(options.profiles.map(profile => [profile.id, profile]));
		this.#runner = options.runner;
	}

	async execute(request: WorkspaceRequest): Promise<WorkspaceResult> {
		if (request.operation === "list") return { ok: true, value: this.#registry.list() };
		if (request.operation === "profiles") return await this.#listProfiles();
		if (request.operation === "browse") {
			const profile = this.#profiles.get(request.profileId ?? "");
			if (profile === undefined) return { ok: false, code: "invalid_request" };
			return await this.#browse(profile, request.path);
		}
		if (request.operation === "register") {
			if (typeof request.workspaceId !== "string" || typeof request.root !== "string") return { ok: false, code: "invalid_request" };
			const profile = this.#profiles.get(request.profileId ?? "");
			if (profile === undefined) return { ok: false, code: "invalid_request" };
			return await this.#register(profile, request.workspaceId, request.root);
		}
		return { ok: false, code: "invalid_request" };
	}

	/** Every target this gateway offers, with the account the host itself reports. A host that cannot answer keeps its configured identity. */
	async #listProfiles(): Promise<WorkspaceResult> {
		const profiles: WorkspaceProfile[] = [];
		for (const profile of this.#profiles.values()) {
			const answer = await this.#call(profile, ["host"]);
			profiles.push(answer.ok
				? { id: profile.id, host: profile.host, root: profile.remoteRoot, user: (answer.value as ExecutionHostIdentity).user, home: (answer.value as ExecutionHostIdentity).home }
				: { id: profile.id, host: profile.host, root: profile.remoteRoot, error: answer.message });
		}
		return { ok: true, value: profiles };
	}

	async #browse(profile: SshProfile, path?: string): Promise<WorkspaceResult> {
		const requested = path === undefined || path.trim() === "" ? profile.remoteRoot : path;
		if (!isAbsolute(requested)) return { ok: false, code: "invalid_request" };
		const answer = await this.#call(profile, ["browse", requested]);
		if (!answer.ok) return { ok: false, code: answer.code };
		const listed = answer.value as { path: string; parentPath: string | null; directories: { name: string; path: string }[] };
		const account = await this.#call(profile, ["host"]);
		// The account travels with the listing, exactly as it does on the local workspace surface: a picker can name
		// the computer the folders are on. A host that listed the directories but cannot report its account is a
		// failure of its own, never a substituted identity.
		if (!account.ok) return { ok: false, code: account.code };
		const value: WorkspaceListing = { path: listed.path, parentPath: listed.parentPath, directories: listed.directories, host: account.value as ExecutionHostIdentity };
		return { ok: true, value };
	}

	/**
	 * Record an existing remote directory under an opaque id. The host canonicalizes and confirms the path; the root
	 * is never validated against this machine's filesystem, and the profile is stored with it so the id resolves back
	 * to this profile from execution, files and installation alike.
	 */
	async #register(profile: SshProfile, workspaceId: string, root: string): Promise<WorkspaceResult> {
		if (!isAbsolute(root)) return { ok: false, code: "invalid_root" };
		const answer = await this.#call(profile, ["register", root]);
		if (!answer.ok) return { ok: false, code: answer.code === "invalid_root" || answer.code === "permission_denied" ? "invalid_root" : answer.code };
		const canonical = (answer.value as { root: string }).root;
		const registered: WorkspaceRegistration = this.#registry.registerResolved(workspaceId, canonical, profile.id);
		return registered.ok ? registered : { ok: false, code: registered.code };
	}

	/** One helper call. A transport failure is reported as such and is never retried or replaced with a local answer. */
	async #call(profile: SshProfile, argv: readonly string[]): Promise<{ ok: true; value: unknown } | { ok: false; code: "not_found" | "not_a_directory" | "invalid_root" | "invalid_request" | "permission_denied" | "not_supported" | "unreachable" | "operation_failed"; message: string }> {
		let result: SshRunnerResult;
		try {
			result = await this.#runner.execute({ profile: profile.id, host: profile.host, cwd: profile.remoteRoot, root: profile.remoteRoot, port: profile.port, identityFile: profile.identityFile, knownHostsFile: profile.knownHostsFile, command: ["python3", "-c", REMOTE_BOOTSTRAP, REMOTE_WORKSPACE_BASE64, ...argv], timeoutMs: SSH_WORKSPACE_TIMEOUT_MS, signal: AbortSignal.timeout(SSH_WORKSPACE_TIMEOUT_MS) });
		} catch (error) {
			const code = (error as { code?: string }).code;
			return code === "unreachable"
				? { ok: false, code: "unreachable", message: "the SSH host is unreachable" }
				: { ok: false, code: "operation_failed", message: error instanceof Error ? error.message : String(error) };
		}
		if (result.exitCode === 127 || /python3: (command )?not found/i.test(result.stderr)) return { ok: false, code: "not_supported", message: "the SSH host needs Python 3 on PATH for gateway workspace operations" };
		let parsed: unknown;
		try { parsed = JSON.parse(result.stdout); } catch { return { ok: false, code: "operation_failed", message: "the remote host returned no workspace result" }; }
		const payload = parsed as { ok?: boolean; value?: unknown; error?: { code?: string; message?: string } };
		if (payload.ok === true) return { ok: true, value: payload.value };
		const code = payload.error?.code;
		const known = ["not_found", "not_a_directory", "invalid_root", "invalid_request", "permission_denied", "not_supported"];
		return { ok: false, code: (known.includes(code ?? "") ? code : "operation_failed") as "not_found", message: payload.error?.message ?? "remote workspace operation failed" };
	}
}
