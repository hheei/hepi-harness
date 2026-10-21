/** Public types for the Cargo build helper consumed by the App tests. */

/** The profiles a caller may select. */
export declare const PROFILES: readonly string[];

/** How many crates `cargo` may compile at once. */
export declare const CARGO_JOBS: number;

/** The repository a checkout belongs to: the main checkout's root, shared by every worktree of it. */
export declare function sharedRepoRoot(root: string): string;

/** The one target directory every build of this repository shares. */
export declare function sharedCargoTargetDir(root: string): string;

/** The environment a Rust build of the App runs under, as the script states it. */
export declare function cargoBuildEnvironment(root: string, profile?: string): Record<string, string>;

/** Where a build of this profile leaves the executable and its bundles. */
export declare function cargoOutputPaths(root: string, profile?: string): {
  readonly targetDir: string;
  readonly profileDir: string;
  readonly binary: string;
  readonly bundleDir: string;
};

/** One cache generation this project owns. */
export type CacheGeneration = {
  readonly directory: string;
  readonly name: string;
  readonly bytes: number | null;
  readonly modified: number;
};

/** The cache generations this project owns, newest first. */
export declare function cacheGenerations(root: string): CacheGeneration[];

/** Keep at most `keep` generations of this project's cache. */
export declare function pruneCacheGenerations(root: string, keep?: number): { readonly kept: string[]; readonly removed: string[] };
