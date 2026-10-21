/** Public types for the offline-install helper consumed by the App tests. */

/** The database the host itself reads and writes. */
export declare const HOST_STATUS_FILE: string;

/** Whether this host can run a real transaction, and the reason when it cannot. */
export declare function installSupport(facts: { hasDpkg: boolean; hasBwrap: boolean; unprivilegedUserns: boolean }): {
  readonly supported: boolean;
  readonly reason: string;
};

/** The `dpkg` argv of one offline install. */
export declare function offlineInstallArgs(install: { root: string; deb: string; logFile: string }): string[];

/** The `dpkg -V <package>` argv that asks dpkg whether the files it installed are still its own. */
export declare function offlineVerifyArgs(verify: { root: string; packageName: string; logFile: string }): string[];

/** The status text a seeded root may carry, from the host's own. */
export declare function seedStatus(hostStatusText: string): string;

/** What the host's own database says about one package, as a comparable string. */
export declare function hostPackageRecord(hostStatusText: string, packageName: string): {
  readonly readable: boolean;
  readonly present: boolean;
  readonly record: string;
};

/** The host's statement about one package, or an explicit unreadable instead of a silent "absent". */
export declare function readHostPackageRecord(hostStatusFile: string, packageName: string): {
  readonly readable: boolean;
  readonly present: boolean | null;
  readonly record: string;
};

/** One throwaway root with dpkg's own directories and a seeded database. */
export declare function prepareInstallRoot(options?: { prefix?: string; hostStatusFile?: string }): {
  readonly root: string;
  readonly logFile: string;
  readonly seeded: boolean;
};

/** One offline install's answer: dpkg's own results, as fields rather than as a throw. */
export declare function runOfflineInstall(options?: { deb: string; packageName?: string; hostStatusFile?: string; timeoutMs?: number }): Promise<{
  readonly root: string;
  readonly logFile: string;
  readonly seeded: boolean;
  readonly hostBefore: { readonly readable: boolean; readonly present: boolean | null; readonly record: string };
  readonly hostAfter: { readonly readable: boolean; readonly present: boolean | null; readonly record: string };
  readonly installExit: number | null;
  readonly installOutput: string;
  readonly verifyExit: number | null;
  readonly verifyOutput: string;
  readonly state: string;
  readonly installed: boolean;
  readonly payload: string;
}>;

/** Remove one offline-install root, including a tree dpkg left mid-transaction. */
export declare function cleanupInstallRoot(root: string): void;
