/**
 * The published package version. The build script fails before bundling when this drifts from package.json, and
 * `test/cli.test.ts` checks the same pair, so the version the CLI reports is the version the tarball carries.
 */
export const VERSION = "0.1.0";
