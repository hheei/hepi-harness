/**
 * The production artifact test: install the package, start it, and make it talk to a Gateway.
 *
 * This file is the operational entry point and nothing more: it resolves the flags and the default artifact, calls the
 * one concrete verification operation, prints the summary it always printed and owns the process exit. What the run
 * asserts — and the private display, credential store and packaged process groups it does that under — lives in
 * verify-artifacts.operation.mjs.
 *
 * The exit is explicit because the launched App's own process group can outlive the assertions, and a report that exists
 * but never returns is not a check anyone can run. Importing this file runs nothing.
 *
 * Usage: node apps/app/scripts/verify-artifacts.mjs [--artifact-dir=<dir>] [--log-dir=<dir>]
 */
import path from "node:path";
import process from "node:process";
import { newestArtifactDir, runArtifactVerification } from "./verify-artifacts.operation.mjs";

const args = process.argv.slice(2);
const arg = (name, fallback) => args.find(a => a.startsWith("--" + name + "="))?.split("=").slice(1).join("=") ?? fallback;

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const artifactDir = path.resolve(arg("artifact-dir", null) ?? await newestArtifactDir());
const logDir = path.resolve(arg("log-dir", path.join(artifactDir, "verify-" + stamp)));

const report = await runArtifactVerification({ artifactDir, logDir });
console.log(JSON.stringify({ logDir, passed: report.passed, failed: report.failed }, null, 2));
process.exit(report.failed.length === 0 ? 0 : 1);
