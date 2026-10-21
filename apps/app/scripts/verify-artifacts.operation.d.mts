/**
 * The types of the artifact verification operation's callable interface.
 *
 * Only the seam a caller or a test crosses is declared: the operation, what it hands back, and the two pure helpers a
 * test asserts. The rest of the report is the operation's own evidence, stated by the run rather than pinned here, and
 * the internal helpers (display, fixture ingress, packaged launches, cleanup) are not exported at all.
 */

/** One assertion a run recorded: its name, its outcome, and a bounded detail. */
export interface ArtifactAssertion {
  name: string;
  ok: boolean;
  detail: string;
}

/**
 * The report a completed run writes beside its logs and returns.
 *
 * The counts and the failure names are what a caller reads; the remaining evidence fields are the artifact's own record
 * and are not pinned to a shape here, so adding an observation does not mean editing this file.
 */
export interface ArtifactReport {
  kind: string;
  artifactDir: string;
  logDir: string;
  passed: number;
  failed: string[];
  [evidence: string]: unknown;
}

/** Verify one prebuilt App artifact; resolves with the completed report after teardown. */
export declare function runArtifactVerification(options: { artifactDir: string; logDir: string }): Promise<ArtifactReport>;

/** The newest artifact directory this checkout built under `.dev/artifacts`. */
export declare function newestArtifactDir(): Promise<string>;

/** A recorder for one run's assertions, in the order they were made. */
export declare function createAssertions(): {
  entries: ArtifactAssertion[];
  assert: (name: string, ok: unknown, detail?: unknown) => boolean;
};

/** How many assertions passed, and which failed, by name. */
export declare function summarize(assertions: ArtifactAssertion[]): { passed: number; failed: string[] };
