/**
 * The facts a surface has to re-read because something outside it changed.
 *
 * A workbench has a few of these, and each is a statement about the workbench rather than a number one component keeps
 * for another. "A conversation was created, renamed, forked, deleted or finished" is what makes the sidebar's catalogue stale,
 * and "files under the workspace changed" is what makes a listing or a diff stale — the surface that *reads* the resource
 * is the one that decides to re-read it, and the surface that *observed* the change states the fact.
 *
 * It replaced the counters the shell threaded down as `refreshKey`: a number is a protocol only the two ends know, and
 * "which value of it means a read" is a rule nobody states. A signal has no value to compare — a subscriber is told that
 * the resource it reads changed, and nothing else.
 *
 * A signal is synchronous and has no replay: a subscriber that mounts after a change reads the resource as it is now,
 * which is the read it would have made anyway.
 */
export interface WorkbenchChange {
  /** State that the resource this signal names changed. */
  notify(): void;
  /** Hear about later changes; the returned function is the withdrawal. */
  subscribe(listener: () => void): () => void;
}

export function createChange(): WorkbenchChange {
  const listeners = new Set<() => void>();
  return {
    notify() {
      // Copied first: a listener may withdraw itself, and a set being iterated would skip the next one.
      for (const listener of [...listeners]) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** The changes a workbench's surfaces may be told about, stated once on the connection they belong to. */
export interface WorkbenchChanges {
  /** A conversation was created, renamed, forked, deleted or finished: the catalogue's rows are stale. */
  readonly catalogue: WorkbenchChange;
  /** Files under a workspace changed — an upload, or a run that wrote them: a listing and a diff are stale. */
  readonly files: WorkbenchChange;
}

export function createChanges(): WorkbenchChanges {
  return { catalogue: createChange(), files: createChange() };
}
