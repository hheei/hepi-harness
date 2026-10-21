import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { GatewayRpcServer, LocalGateway, type InstallRequest, type InstallResult, type InstallServer } from "@hepi/gateway";
import { LocalFilesystem } from "../../../packages/gateway/src/filesystem.ts";
import { LocalInstallServer } from "../../../packages/gateway/src/install.ts";
import { createInstaller, type InstallerOptions } from "../src/skill-install.ts";
import type { MarketFetch, SkillMarket } from "../src/skill-repository.ts";
import type { WorkspaceResourceState, WorkspaceResources } from "../src/workspace-resources.ts";
import { WorkspaceRegistry } from "../../../packages/gateway/src/workspaces.ts";

/**
 * The bulk toggle's host round trips. One directory is one request to the execution host, whether that host is a local
 * process or an SSH peer, so a group of N is N sequential network waits in the current loop and the panel's bulk switch
 * waits for all of them. The benchmark injects a fixed latency on the installation surface and reads the peak number of
 * requests this process allowed to be in flight at once: the serial loop can only ever reach one, and independent
 * directories have no reason to wait for each other because the gateway already serializes per directory.
 *
 * The injected cost is a single event-loop yield rather than a timer, so the assertion is on how many requests overlap
 * rather than on a wall-clock number a busy machine could distort: a serial caller still resumes and finishes one
 * request before starting the next, while independent callers all sit at that yield at the same time.
 */
const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function instrumented(inner: InstallServer) {
	const state = { inFlight: 0, peak: 0, total: 0, byOperation: new Map<string, number>() };
	const server: InstallServer = {
		execute: async (request: InstallRequest): Promise<InstallResult> => {
			state.inFlight += 1;
			state.peak = Math.max(state.peak, state.inFlight);
			state.total += 1;
			state.byOperation.set(request.operation, (state.byOperation.get(request.operation) ?? 0) + 1);
			try {
				await yieldToEventLoop();
				return await inner.execute(request);
			} finally {
				state.inFlight -= 1;
			}
		},
	};
	return { server, state };
}

/** The market is never reached by a toggle or by an installation with no repository provenance; it only has to exist. */
const offlineMarket = (): SkillMarket => ({ versions: async () => [] } as unknown as SkillMarket);

type OperatorFixture = {
	readonly origin: string;
	readonly installer: ReturnType<typeof createInstaller>;
	readonly home: string;
	readonly state: ReturnType<typeof instrumented>["state"];
	readonly close: () => Promise<void>;
};

async function operatorFixture(skillCount: number): Promise<OperatorFixture> {
	const base = await mkdtemp(join(tmpdir(), "hepi-toggle-perf-"));
	const home = join(base, "home");
	const root = join(base, "repo", "app");
	await mkdir(home, { recursive: true });
	await mkdir(root, { recursive: true });
	const workspaces = new WorkspaceRegistry([{ id: "local", root }]);
	const files = new LocalFilesystem(workspaces, { identity: { user: "operator", home } });
	const real = new LocalInstallServer(workspaces, { identity: { user: "operator", home } });
	const { server, state } = instrumented(real);
	const gateway = new GatewayRpcServer({
		gateway: new LocalGateway({ id: "workstation", token: "gateway-token", workspaces, allowedCommands: ["bash"] }),
		files,
		installs: server,
	});
	await new Promise<void>((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
	const address = gateway.server.address();
	assert.ok(address !== null && typeof address === "object");
	const binding = { id: "local", gatewayId: "workstation", gatewayOrigin: "http://127.0.0.1:" + address.port, gatewayToken: "gateway-token" };

	// The host's own installed directories, written straight into the account's skills root: the toggle edits the
	// document the loader reads and needs no lock entry to do it.
	const skillsRoot = join(home, ".agents", "skills");
	const directories: string[] = [];
	for (let index = 0; index < skillCount; index += 1) {
		const directory = "skill-" + string_of_index(index);
		directories.push(directory);
		await mkdir(join(skillsRoot, directory), { recursive: true });
		await writeFile(join(skillsRoot, directory, "SKILL.md"), "---\nname: " + directory + "\ndescription: Fixture skill\n---\n# " + directory + "\n");
	}
	// A discovery answer over those same N skills, so the inventory's per-skill host reads can be counted without
	// standing up the whole resource loader: the installer's loop is what is under test, not the walker.
	const loaded: WorkspaceResourceState = {
		status: "loaded", user: "operator", home, workspaceRoot: root, roots: [skillsRoot],
		contextFiles: [], loadedAtMs: 0,
		catalog: directories.map((directory) => ({ kind: "skill" as const, name: directory, description: "Fixture skill", location: join(skillsRoot, directory, "SKILL.md"), baseDir: join(skillsRoot, directory), scope: "global" as const })),
		prefix: "",
	};
	const resources: WorkspaceResources = {
		discover: async () => loaded,
		reload: async () => loaded,
		extension: undefined,
	} as unknown as WorkspaceResources;
	// Provenance for every directory, so the inventory has to inspect each one rather than short-circuit on "unmanaged".
	// The lock lives where the gateway reads it: beside the skills root, under the account's .agents directory.
	const lock: Record<string, unknown> = {};
	for (const directory of directories) {
		lock[directory] = { source: "local:fixture", sourceType: "local", skillPath: join(skillsRoot, directory), scope: "global", installedAtMs: 0, contentHash: "0".repeat(64), files: { "SKILL.md": "1".repeat(64) } };
	}
	await writeFile(join(home, ".agents", ".skill-lock.json"), JSON.stringify({ version: 1, skills: lock }));

	const options: InstallerOptions = {
		market: offlineMarket(),
		workspaces: () => [binding],
		boundWorkspace: async () => undefined,
		conversation: () => undefined,
		resources,
	};
	const installer = createInstaller(options);
	return { origin: binding.gatewayOrigin, installer, home, state, close: () => gateway.close() };
}

/** A stable lowercase slug for an index, independent of String.prototype padding quirks. */
function string_of_index(index: number): string {
	return index.toString(36);
}

test("a bulk toggle does not wait for each directory in turn", { timeout: 30000 }, async (t) => {
	const count = 12;
	const fixture = await operatorFixture(count);
	t.after(() => fixture.close());
	const directories = Array.from({ length: count }, (_value, index) => "skill-" + string_of_index(index));

	const response = await fixture.installer.toggle({ workspaceId: "local", scope: "global", directories, disableModelInvocation: true });
	assert.equal(response.status, 200, JSON.stringify(response.body));
	if (response.status !== 200) return;
	assert.deepEqual(response.body.results.map((result) => result.directory), directories, "every directory is still answered, in the order asked");
	assert.ok(response.body.results.every((result) => result.changed === true), JSON.stringify(response.body.results));
	// The whole batch is one round trip per directory; the question is only whether this process made them at once.
	assert.equal(fixture.state.byOperation.get("toggleSkill"), count);
	assert.ok(fixture.state.peak > 1, "independent directories ran one at a time: peak in-flight was " + fixture.state.peak);
});

test("a bulk toggle keeps per-directory isolation while overlapping", { timeout: 30000 }, async (t) => {
	const fixture = await operatorFixture(4);
	t.after(() => fixture.close());
	// A refused directory and an unknown one sit beside the two that change: the batch is not all-or-nothing, and the
	// isolation the serial loop provided is kept.
	const response = await fixture.installer.toggle({ workspaceId: "local", scope: "global", directories: ["skill-0", "NOT-A-SLUG", "skill-1", "does-not-exist"], disableModelInvocation: true });
	assert.equal(response.status, 200, JSON.stringify(response.body));
	if (response.status !== 200) return;
	const byDirectory = new Map(response.body.results.map((result) => [result.directory, result]));
	assert.equal(byDirectory.get("skill-0")?.changed, true);
	assert.equal(byDirectory.get("skill-1")?.changed, true);
	assert.equal(byDirectory.get("NOT-A-SLUG")?.error?.code, "invalid");
	assert.equal(byDirectory.get("does-not-exist")?.error?.code, "not_found");
	assert.equal(response.body.results.length, 4);
});

test("reading the inventory does not inspect each skill in turn", { timeout: 30000 }, async (t) => {
	const count = 12;
	const fixture = await operatorFixture(count);
	t.after(() => fixture.close());
	const listed = await fixture.installer.inventory({ workspaceId: "local" });
	assert.equal(listed.status, 200, JSON.stringify(listed.body));
	if (listed.status !== 200) return;
	assert.equal(listed.body.skills.length, count);
	assert.equal(fixture.state.byOperation.get("inspectDirectory"), count);
	assert.ok(fixture.state.peak > 1, "skills were inspected one at a time: peak in-flight was " + fixture.state.peak);
});
