/**
 * The shell's own commands, and nothing else.
 *
 * The App is a WebView inside a Rust process, so the two facts a page cannot obtain for itself come from there: what this
 * binary was built from, and the connection the install was configured with (stored in the OS credential store). Both are
 * read-only here; configuring or forgetting a connection restarts the process, because the Gateway origin has to be in the
 * window's policy before the window exists.
 *
 * A page running outside the shell has no `__TAURI_INTERNALS__`; every call below then reports that plainly instead of
 * pretending to have stored something.
 */
import { invoke } from "@tauri-apps/api/core";
import type { ConnectionReadout } from "@hepi/ui/workbench";

/** What the packaged binary reports about itself. */
export interface ShellBuild {
  readonly version: string;
  readonly client_revision: string;
  readonly shell_revision: string;
  readonly target: string;
}

/**
 * What a packaged run sees, as the shell's stdout line names it.
 *
 * `connecting` is the state between the surfaces a person can act on: the document mounted inside the shell and the first
 * read of its Gateway has not settled yet, so nothing about the connection is true to report. `refused` is the workbench
 * stating a descriptor read the deployment would not admit — a different thing from `configure`, which is the install
 * having no connection to read at all.
 */
export type ReportedSurface = "configure" | "connecting" | "workbench" | "refused";

/** The arguments the shell's `app_ready` command takes, in the order it names them. */
type ReadyReport = {
  readonly surface: ReportedSurface;
  readonly backend: string;
  readonly scope: string;
  readonly client: string;
  readonly profile: string;
  readonly reason: string;
};

export function inShell(): boolean {
  return typeof (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ === "object";
}

export function readBuild(): Promise<ShellBuild> {
  return invoke<ShellBuild>("app_build");
}

/**
 * Send one readiness report to the shell, and never to a person's console.
 *
 * A packaged run's only channel out of the WebView is the process's stdout, which the shell owns; a failed IPC is not a
 * reason to break the page the person is looking at.
 */
function reportReady(report: ReadyReport): void {
  void invoke("app_ready", { ...report }).catch(() => undefined);
}

/**
 * Tell the shell which surface this document mounted, with no connection stated.
 *
 * This is the only report made before a Gateway answers: a document that has not read anything has nothing true to say
 * about a Backend, and stating blanks is what lets a packaged run tell "nothing was read" apart from "the read was
 * admitted", instead of inferring the second from a process being alive.
 */
export function reportSurface(surface: "configure" | "connecting"): void {
  reportReady({ surface, backend: "", scope: "", client: "", profile: "", reason: "" });
}

/**
 * Tell the shell what its own descriptor read settled to.
 *
 * The admitted fields come from the deployment's own answer — which Backend, which account scope, which client identity
 * the ingress admitted for this bearer — so a `workbench` line cannot be printed for a connection the Gateway refused.
 * `client` is the identity the deployment **named**, never the credential: an id, not the bearer.
 */
export function reportConnection(readout: ConnectionReadout): void {
  if (readout.kind === "admitted") {
    reportReady({ surface: "workbench", backend: readout.backendId, scope: readout.accountScope, client: readout.client, profile: readout.profile, reason: "" });
    return;
  }
  reportReady({ surface: "refused", backend: "", scope: "", client: "", profile: "", reason: readout.reason });
}

/**
 * Store a connection and restart into it.
 *
 * The device bearer is passed to the shell as a value and never into a URL, a log or the bundle; the shell keeps it in the
 * OS credential store and hands it back to the document at startup.
 */
export function configureConnection(connection: { profile: string; origin: string; token: string }): Promise<void> {
  return invoke<void>("app_configure", { ...connection });
}

export function forgetConnection(): Promise<void> {
  return invoke<void>("app_forget");
}
