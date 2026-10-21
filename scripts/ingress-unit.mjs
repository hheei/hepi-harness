/**
 * `ingress:unit` — print the systemd user unit and the environment template a client-ingress release runs with.
 *
 * The unit is not checked in: it names an absolute release directory and a private env file, which are host facts. What
 * is checked in is the rule that produces it (`scripts/lib/client-runtime.mjs`), so the unit a host runs and the unit
 * this repository describes cannot drift, and no secret has anywhere to be written down.
 *
 * The shapes follow the units this deployment already runs (`hepi-gateway.service`): a pinned interpreter, the
 * environment from a 0600 file rather than the unit or a command line, `Restart=always`, and no change to any state
 * path. The ingress replaces the Web origin's port, so it also has to be the only process bound to it — that ordering is
 * the operator's, in the cutover, and is not something a unit can enforce without blocking the switch itself.
 *
 * Usage: node scripts/ingress-unit.mjs --release-dir=<dir> [--env-file=<path>] [--node=<path>] [--documentation=<url>]
 *        node scripts/ingress-unit.mjs --env-template
 */
import { isMain, parseCli } from "./lib/cli.mjs";
import { INGRESS_ENVIRONMENT, SECRET_VARIABLES, ingressEnvTemplate, ingressUnit, RELEASE_LAYOUT } from "./lib/client-runtime.mjs";

const USAGE = `
Usage: node scripts/ingress-unit.mjs --release-dir=<dir> [--env-file=<path>] [--node=<path>]
       node scripts/ingress-unit.mjs --env-template
       node scripts/ingress-unit.mjs --check

  --release-dir=<dir>   the promoted release directory (holds ${RELEASE_LAYOUT.bundle} and ${RELEASE_LAYOUT.staticDir}/)
  --env-file=<path>     the private env file (default: %h/.config/hepi/ingress.env)
  --node=<path>         the pinned interpreter (default: /usr/bin/node)
  --documentation=<url> a Documentation= line for the unit
  --env-template        print the environment template instead of the unit
  --check               print the variable inventory as JSON (names and roles, never values)
  -h, --help            print this usage and exit
`;

function main(argv) {
	const { flags, exitCode } = parseCli(argv, { usage: USAGE, values: ["release-dir", "env-file", "node", "documentation"], switches: ["env-template", "check"] });
	if (exitCode !== undefined) return exitCode;
	if (flags["env-template"] === "true") {
		process.stdout.write(ingressEnvTemplate());
		return 0;
	}
	if (flags.check === "true") {
		process.stdout.write(JSON.stringify({
			variables: INGRESS_ENVIRONMENT,
			secrets: SECRET_VARIABLES,
			releaseLayout: RELEASE_LAYOUT,
		}, null, 2) + "\n");
		return 0;
	}
	if (flags["release-dir"] === undefined) {
		process.stderr.write("--release-dir is required (or use --env-template / --check)\n");
		process.stderr.write(USAGE.trim() + "\n");
		return 2;
	}
	process.stdout.write(ingressUnit({
		releaseDir: flags["release-dir"].replace(/\/+$/, ""),
		envFile: flags["env-file"] ?? "%h/.config/hepi/ingress.env",
		...(flags.node === undefined ? {} : { node: flags.node }),
		...(flags.documentation === undefined ? {} : { documentation: flags.documentation }),
	}));
	return 0;
}

if (isMain(import.meta.url)) process.exit(main(process.argv.slice(2)));
