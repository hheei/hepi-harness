/**
 * The client-runtime release: what a cutover to the shared client actually deploys, and how it is named.
 *
 * Three artifacts, one immutable release, because they are one contract:
 *
 * - **the Backend image**, which still runs the agent loop and owns the durable databases (unchanged mechanism);
 * - **the client ingress bundle**, a single ESM file built from `packages/gateway/src/ingress/main.ts` and run by the
 *   same Node the execution gateway runs, so the ingress needs no install step of its own;
 * - **the Vite build** of `apps/web`, which the ingress serves from `HEPI_INGRESS_STATIC_DIR` on its own origin.
 *
 * The ingress bundle exists because the ingress is not the execution gateway: `@hepi/client`'s published entry starts
 * `gateway` (the internal listener), and the client surface is a different bind with different configuration. Bundling
 * the ingress entry directly keeps that separation instead of teaching the execution entrypoint a second mode.
 *
 * Everything here is a naming and layout decision, so it is testable without building anything. The build itself lives
 * in `scripts/build-client-runtime.mjs`; where this module and that script disagree, this one is the contract.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** The artifact id a release directory is named by: the commit, short, as every earlier deployment named it. */
export function artifactIdOf(sha) {
	return String(sha).slice(0, 7);
}

/**
 * The release directory name on the deployment host. It is never edited in place: a change is a new id.
 *
 * One function for the builder and the deployment plan, because a plan that names a directory the build does not
 * produce is a cutover pointed at nothing.
 */
export function releaseDirName(artifactId) {
	return "release-" + artifactId;
}

/** The release directory a commit's build publishes: the short commit, named the one way this repository names it. */
export function releaseNameForRevision(sha) {
	return releaseDirName(artifactIdOf(sha));
}

/**
 * Why a release may not be published into `releaseDir`, or `undefined` when publishing is allowed.
 *
 * A release directory is immutable: it is the thing a unit runs and the thing `SHA256SUMS` describes. Rebuilding the
 * same revision therefore cannot "refresh" it — a build that removed and renamed over it would delete a directory an
 * ingress may be serving, and the gap between the delete and the rename is a window where the page 404s. A second
 * build of an already-published revision is refused instead; the existing directory is left exactly as it is.
 */
export function releaseConflictMessage(releaseDir) {
	return releaseDir + " already exists: a published release is immutable, so this revision will not be built over it (build a new revision, or remove that directory deliberately)";
}

/**
 * Publish a finished staging directory as `releaseDir` with one rename, and never over a published one.
 *
 * `rename` gives the no-clobber behavior without a second step: it replaces an existing directory only when that
 * directory is empty, and fails with `ENOTEMPTY` when one holds a release. So two builds of the same revision racing
 * to publish cannot delete each other's output — the loser's rename fails, its staging directory is discarded, and the
 * winner's release stays exactly as it was. The existence check before the rename is what refuses the ordinary
 * same-revision rebuild early, with a message instead of a build; this is what holds if that check was stale.
 */
export async function publishRelease({ staging, releaseDir, rename, exists }) {
	if (exists(releaseDir)) throw new Error(releaseConflictMessage(releaseDir));
	try {
		await rename(staging, releaseDir);
	} catch (error) {
		if (error?.code === "ENOTEMPTY" || error?.code === "EEXIST" || error?.code === "ENOTDIR") throw new Error(releaseConflictMessage(releaseDir));
		throw error;
	}
}

/**
 * The three things a run of a published release uses, or a refusal naming what is missing.
 *
 * This exists so an acceptance run can be pointed at the artifact a cutover switches instead of at the checkout: the
 * ingress entry it starts is `release-<id>/ingress.mjs`, the page it serves is `release-<id>/web/`, and the execution
 * gateway it starts is the `release-<id>/gateway/*.tgz` installed into a directory of the run's own. Reading the
 * directory rather than assuming a layout is what makes the refusal real — a partially promoted release, or a
 * `partial-<id>` measurement directory, is not something a run may call the artifact.
 * A run of the release also needs the Backend image it records: the tag is read from `provenance.json`, because a
 * caller that guesses it from the directory name would be naming an image the build may never have produced.
 */
export function releaseArtifacts(releaseDir) {
	const bundle = join(releaseDir, RELEASE_LAYOUT.bundle);
	const staticDir = join(releaseDir, RELEASE_LAYOUT.staticDir);
	const marker = join(releaseDir, RELEASE_LAYOUT.marker);
	const gatewayDir = join(releaseDir, RELEASE_LAYOUT.gatewayDir);
	const provenanceFile = join(releaseDir, RELEASE_LAYOUT.provenance);
	const missing = [];
	if (!existsSync(bundle)) missing.push(RELEASE_LAYOUT.bundle);
	if (!existsSync(join(staticDir, "index.html"))) missing.push(RELEASE_LAYOUT.staticDir + "/index.html");
	if (!existsSync(marker)) missing.push(RELEASE_LAYOUT.marker);
	const tarballs = existsSync(gatewayDir) ? readdirSync(gatewayDir).filter((name) => name.endsWith(".tgz")).sort() : [];
	if (tarballs.length === 0) missing.push(RELEASE_LAYOUT.gatewayDir + "/*.tgz");
	if (missing.length > 0) {
		throw new Error(releaseDir + " is not a published release: it has no " + missing.join(", ") + " (a release carries the ingress bundle, the static Web page, the gateway tarball and its SOURCE_COMMIT)");
	}
	let provenance = null;
	try {
		provenance = JSON.parse(readFileSync(provenanceFile, "utf8"));
	} catch {
		throw new Error(provenanceFile + " is not a readable provenance record, so this release cannot name the Backend image a run of it starts");
	}
	if (typeof provenance?.image?.tag !== "string" || provenance.image.tag === "") {
		throw new Error(provenanceFile + " records no Backend image tag, so this release cannot name the Backend image a run of it starts");
	}
	return {
		bundle,
		staticDir,
		gatewayTarball: join(gatewayDir, tarballs[0]),
		imageTag: provenance.image.tag,
		artifactId: provenance.artifactId ?? artifactIdOf(readFileSync(marker, "utf8").trim()),
		revision: readFileSync(marker, "utf8").trim(),
	};
}

/**
 * The layout inside one release directory.
 *
 * `ingress.js` sits beside `web/` because they are one deployment: the page's origin is the API's origin, and a
 * release that moved one without the other would serve a build whose `/api` calls reach a different process.
 */
export const RELEASE_LAYOUT = {
	// The execution gateway's packed tarball, installed on the deployment host as `release-<id>`. It is not a second
	// client surface: it is the internal `/v1` listener the Backend calls and the ingress's MCP calls reach.
	gatewayDir: "gateway",
	// `.mjs`, not `.js`: the bundle is an ES module, and Node would otherwise reparse a typeless `.js` on every start
	// (the release directory carries no package.json of its own, and adding one would put a second manifest in a
	// directory that is meant to be nothing but artifacts).
	bundle: "ingress.mjs",
	staticDir: "web",
	marker: "SOURCE_COMMIT",
	sums: "SHA256SUMS",
	provenance: "provenance.json",
	notices: "THIRD_PARTY_NOTICES.md",
	license: "LICENSE",
};

/**
 * The backend image tag a release pins.
 *
 * The existing deployment tags the backend image by the commit and the host it was built for
 * (`hepi-backend:56ff08f-workstation`); a release keeps that convention rather than inventing a second one, because the
 * unit that runs it and the record that names it both already read it.
 */
export function backendImageTag(artifactId, hostLabel = "workstation") {
	return "hepi-backend:" + artifactId + "-" + hostLabel;
}

/** The platform the build host produces. Never inferred from a running container. */
export function buildPlatform(arch = process.arch) {
	return arch === "x64" ? "linux/amd64" : arch === "arm64" ? "linux/arm64" : "linux/" + arch;
}

/**
 * The environment the ingress process needs, as variable *names* with the role each plays.
 *
 * Deliberately no values: this table is what a template and a guide render, and a value here would be a secret in the
 * repository. `required` is what the process refuses to start without; `optional` is what changes behavior when
 * stated. `HEPI_INGRESS_STATIC_DIR` is listed as required *for a Web origin*, because a release that ships a page but
 * does not point at it is the one failure this packaging exists to prevent.
 */
export const INGRESS_ENVIRONMENT = [
	{ name: "HEPI_INGRESS_BACKEND", required: true, role: "the Backend origin this ingress fronts" },
	{ name: "HEPI_INGRESS_SERVICE_TOKEN", required: true, secret: true, role: "the credential the ingress presents to the Backend (outbound only)" },
	{ name: "HEPI_WEB_LOGIN_TOKEN", required: false, secret: true, role: "the Web login material a browser exchanges for the session cookie" },
	{ name: "HEPI_INGRESS_HOST", required: false, role: "the bind address (a non-loopback bind requires the login material)" },
	{ name: "HEPI_INGRESS_PORT", required: false, role: "the port the Web origin is served on (30141 in the current deployment)" },
	{ name: "HEPI_INGRESS_STATIC_DIR", required: false, role: "the Vite build this origin serves; unset serves no page" },
	{ name: "HEPI_APP_ORIGINS", required: false, role: "comma-separated App origins answered cross-origin" },
	{ name: "HEPI_INGRESS_DEFAULT_HOST", required: false, role: "the execution host (gateway id) this origin serves" },
	{ name: "HEPI_INGRESS_MCP_GATEWAY_URL", required: false, role: "this host's MCP service origin" },
	{ name: "HEPI_INGRESS_MCP_GATEWAY_TOKEN", required: false, secret: true, role: "that service's token (outbound only)" },
	{ name: "HEPI_INGRESS_MCP_GATEWAY_ID", required: false, role: "that service's name in the Backend's vocabulary" },
	{ name: "HEPI_REVOCATION_CHECK_MS", required: false, role: "the revocation re-check interval for attached responses" },
	{ name: "HEPI_UPLOAD_BATCH_BYTES", required: false, role: "the largest one browser upload may carry" },
];

/** The secret variables, named so a report can say which ones it never printed. */
export const SECRET_VARIABLES = INGRESS_ENVIRONMENT.filter((entry) => entry.secret).map((entry) => entry.name);

/**
 * A systemd user unit for the ingress, from a release directory and a private env file.
 *
 * It follows the units this deployment already runs: `Type=simple`, a pinned interpreter, the environment from a
 * 0600 file rather than the unit or a command line, `Restart=always`, and the state paths untouched. The one thing it
 * does not do is depend on a unit it replaces — the ingress takes over the Web origin's port, so the unit that used to
 * bind it has to be stopped first, and that is an operator step in the cutover, not something a `Requisite=` can
 * express without also blocking the switch.
 */
export function ingressUnit({ releaseDir, envFile, node = "/usr/bin/node", documentation }) {
	return [
		"[Unit]",
		"Description=Hepi client ingress (Web origin + client API)",
		...(documentation === undefined ? [] : ["Documentation=" + documentation]),
		"After=network-online.target",
		"Wants=network-online.target",
		"",
		"[Service]",
		"Type=simple",
		"# The token and the Backend origin live in this 0600 file, never in the unit and never on the command line.",
		"EnvironmentFile=" + envFile,
		"# The interpreter is pinned: the bundle imports node:sqlite and needs Node 22+, and `env node` would resolve",
		"# through the manager's PATH, where an older install may come first on this host.",
		"ExecStart=" + node + " " + releaseDir + "/" + RELEASE_LAYOUT.bundle,
		"WorkingDirectory=" + releaseDir,
		"Restart=always",
		"RestartSec=2",
		"NoNewPrivileges=true",
		"PrivateTmp=false",
		"",
		"[Install]",
		"WantedBy=default.target",
		"",
	].join("\n");
}

/**
 * The variables that are absent until an operator states them, and so must stay absent in a template.
 *
 * Every one of them changes behavior when set, and the process parses them when set: an empty
 * `HEPI_REVOCATION_CHECK_MS=` is not "unset" to that parser, it is `Number("") === 0`, which the ingress refuses at
 * start. A template that writes them with an empty value therefore produces a file that fails to start the moment the
 * required materials are filled in. They are printed commented out instead, so the file names them and still starts.
 */
export const OPTIONAL_INGRESS_VARIABLES = [
	"HEPI_INGRESS_STATIC_DIR",
	"HEPI_APP_ORIGINS",
	"HEPI_INGRESS_DEFAULT_HOST",
	"HEPI_INGRESS_MCP_GATEWAY_URL",
	"HEPI_INGRESS_MCP_GATEWAY_TOKEN",
	"HEPI_INGRESS_MCP_GATEWAY_ID",
	"HEPI_REVOCATION_CHECK_MS",
	"HEPI_UPLOAD_BATCH_BYTES",
];

/**
 * An env template: every variable the process reads, in the order the process reads it.
 *
 * The secrets stay empty — a placeholder that looks like a token is a token someone eventually ships — and the required
 * lines are the ones an operator fills in. Everything else is either a documented deployment default (`HEPI_INGRESS_HOST`,
 * `HEPI_INGRESS_PORT`, both harmless to state) or commented out, because a stated empty value is a configuration
 * decision the ingress refuses (`OPTIONAL_INGRESS_VARIABLES`).
 */
export function ingressEnvTemplate() {
	const defaults = {
		HEPI_INGRESS_HOST: "127.0.0.1",
		HEPI_INGRESS_PORT: "30141",
	};
	const lines = [
		"# Hepi client ingress environment. Copy to a private path, fill in the values, and chmod 0600.",
		"# No value in this file is committed, printed or recorded: the tokens are materials, not configuration.",
		"# Commented lines are unset, not empty: uncomment one and give it a value only when this deployment states it.",
	];
	for (const entry of INGRESS_ENVIRONMENT) {
		lines.push("");
		lines.push("# " + entry.role + (entry.required ? " (required)" : ""));
		const omitted = OPTIONAL_INGRESS_VARIABLES.includes(entry.name);
		lines.push((omitted ? "# " : "") + entry.name + "=" + (omitted || entry.secret ? "" : defaults[entry.name] ?? ""));
	}
	return lines.join("\n") + "\n";
}

/**
 * What a release's provenance must state for the artifact to be addressable: a record that omits any of these cannot
 * answer "what is running, and is it the thing I built?", which is the only question a cutover has.
 */
export function provenanceProblems(provenance) {
	const required = ["kind", "artifactId", "revision", "dirty", "builtAt", "host", "arch", "platform", "toolchain", "artifacts"];
	const missing = required.filter((field) => provenance?.[field] === undefined);
	const problems = missing.map((field) => "missing field: " + field);
	if (provenance?.dirty === true) problems.push("the tree was dirty: the revision does not name what was built");
	if (Array.isArray(provenance?.artifacts) && provenance.artifacts.length === 0) problems.push("no artifacts recorded");
	return problems;
}
