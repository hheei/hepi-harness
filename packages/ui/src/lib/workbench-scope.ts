import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { ExecutionResources, ExecutionTarget } from "@hepi/session/execution-resources";
import type { ResourceReader } from "@hepi/session/resources";
import type { WorkbenchClient } from "../client";
import { connectionScopeKey, type ConnectionIdentity } from "./connection-scope";
import { createConversationApi, type ConversationApi } from "./conversation-api";
import { createDraftStore, type DraftStore } from "./draft-store";
import { createFileSeam, type FileSeam } from "./file/file-seam";

/**
 * The connection the mounted workbench is showing: the client that talks to it, the scope its stored state belongs to,
 * and the profile the host connected as.
 *
 * It is a context rather than a module global because the client is not one: a page has exactly one at a time, and the
 * only way to make sure every store and every caller agrees on *which* one is to state it once, above them, and have
 * them read it. A switch replaces the value, and the replacement is what makes a late answer land in a scope nothing
 * reads.
 */
export interface WorkbenchConnection {
  readonly client: WorkbenchClient;
  /** The opaque key every scoped store uses: this connection's profile, Backend and account. */
  readonly scope: string;
  readonly identity: ConnectionIdentity;
  /**
   * The file surface this connection serves.
   *
   * It is part of the connection because it is derived from it: every address resolves against this client's origin and
   * presents this client's credential. A surface that built one from a global fetch would be answering the same question
   * with a different transport, which is exactly what an App — whose document is a bundle — cannot do.
   */
  readonly files: FileSeam;
  /**
   * The conversation API of this connection, built once with it.
   *
   * The catalogue, the conversation reads and the control surface are one contract against one client, so they belong to
   * the connection rather than to each surface that reads them: six surfaces asking the same client for their own copy
   * assembled the same object six times, and nothing made them agree. A replaced connection is a replaced API, so a
   * surface that outlives its connection cannot write through the previous one.
   */
  readonly api: ConversationApi;
  /**
   * The composers this connection holds drafts for.
   *
   * It belongs to the connection because a draft key is only meaningful inside one: the entry's own name carries this
   * scope, so a composer rendered under this connection can write only here, and a tree the page already replaced
   * writes to entries nothing on screen reads. Stating it once, on the value every surface reads, is what replaced a
   * module-global scope a render installed.
   */
  readonly drafts: DraftStore;
}

/**
 * One connection, assembled in one place: the client, the scope its stored state is keyed by, the identity it was
 * admitted as, the file surface derived from it, and its conversation API.
 *
 * The workbench and every browser fixture state a connection this way, so a fixture cannot hand the surfaces a
 * connection that differs from the one the product builds — one client, one API, one file seam.
 */
export function workbenchConnection(client: WorkbenchClient, identity: ConnectionIdentity): WorkbenchConnection {
  return {
    client,
    scope: connectionScopeKey(identity),
    identity,
    files: createFileSeam(client),
    api: createConversationApi(client),
    drafts: createDraftStore(connectionScopeKey(identity)),
  };
}

const ConnectionContext = createContext<WorkbenchConnection | null>(null);

export const WorkbenchConnectionProvider = ConnectionContext.Provider;

/**
 * The connection the enclosing workbench is showing, or `null` when there is none.
 *
 * Only a surface that is also rendered on its own asks for this: a message body's markdown and a file preview, which
 * tests and standalone renderers mount with no workbench around them. Every surface that is part of the workbench — and
 * every browser fixture that mounts one — reads {@link useWorkbenchConnection} and fails loudly when it is not mounted in
 * a connection, rather than inventing a default one.
 */
export function useOptionalWorkbenchConnection(): WorkbenchConnection | null {
  return useContext(ConnectionContext);
}

/** The connection the enclosing workbench is showing. A surface outside one is a wiring error, not a default. */
export function useWorkbenchConnection(): WorkbenchConnection {
  const value = useOptionalWorkbenchConnection();
  if (value === null) throw new Error("The workbench is mounted outside a connection.");
  return value;
}

/** The opaque scope key, for a store that only needs to name its own entries. */
export function useWorkbenchScope(): string {
  return useWorkbenchConnection().scope;
}

/**
 * This connection's composer drafts — the one store every composer of this connection reads and writes.
 *
 * A surface reads it from the connection rather than from a module: the store *is* the connection's, so the previous
 * question ("is the installed scope still mine?") has no state to be wrong about.
 */
export function useComposerDrafts(): DraftStore {
  return useWorkbenchConnection().drafts;
}

/**
 * This connection's read-block reader — the deferred texts, thinking blocks and history images — or `null` when the
 * surface is mounted outside a workbench.
 *
 * A surface reads it here rather than reaching for `fetch` because the address and the credential are the
 * connection's: a Web page's relative path with its own cookie, an App's configured Gateway with its device bearer. A
 * relative `fetch` inside the shared tree would ask the App bundle for conversation history, which is the failure this
 * seam exists to prevent. A surface that gets `null` states the reader's `unavailable` refusal instead of asking the
 * document's own origin; that is a fixture mounted without a connection, not a production tree.
 */
export function useOptionalResourceReader(): ResourceReader | null {
  return useOptionalWorkbenchConnection()?.client.resources ?? null;
}

/**
 * The execution-side resources of this connection: the repository reads and the `select()`ed execution targets.
 *
 * A surface reads them from the connection rather than from `fetch` because the address and the credential are the
 * connection's: a Web page's relative path and its own cookie, an App's configured Gateway and its device bearer. A
 * relative `fetch` inside the shared tree would ask the App bundle for a host's skills, which is the failure this seam
 * exists to prevent.
 */
export function useExecutionResources(): ExecutionResources {
  return useWorkbenchConnection().client.execution;
}

/**
 * One selected execution target, held for as long as this surface is showing that workspace.
 *
 * Selecting is what retires the previous target: when the workspace changes, the old target is disposed, and an answer
 * that arrives for it afterwards is refused as `disposed` rather than published into the new host's view. A surface
 * therefore never needs a request counter to keep one host's inventory out of another's — the scope is the fence.
 *
 * The target is created by the effect and held in state rather than memoized, because disposing it is what the effect's
 * cleanup does: a memoized instance would survive a cleanup and be handed back on the replay, already disposed, so
 * every later read of the surface would be refused. Creating it under the effect lifecycle means a replay gets a live
 * target and a real unmount still retires the one that was shown. The value is only returned for the workspace that is
 * selected now, so the frame between a selection change and the new target never hands a caller the old host's scope.
 */
export function useExecutionTarget(workspaceId: string | null): ExecutionTarget | null {
  const execution = useExecutionResources();
  const [target, setTarget] = useState<ExecutionTarget | null>(null);
  useEffect(() => {
    if (workspaceId === null) return;
    const selected = execution.select(workspaceId);
    setTarget(selected);
    return () => {
      selected.dispose();
      setTarget((current) => (current === selected ? null : current));
    };
  }, [execution, workspaceId]);
  return target !== null && target.workspaceId === workspaceId ? target : null;
}

/**
 * Whether an answer still belongs to the execution target this surface is showing.
 *
 * A read outlives the selection that asked for it: the user switches folder, and the previous target's answer — or its
 * failure — arrives afterwards. The connection refuses a *disposed* target's answer, but the frames between a selection
 * change and its new target are not a disposed target yet, so a surface that only checked the refusal could still write
 * one host's list, or one host's error, onto another. This is the identity check that closes that window: the target the
 * read was handed is the target on screen now, or nothing of that read is written.
 */
export function useTargetFence(shown: ExecutionTarget | null): (candidate: ExecutionTarget) => boolean {
  // Written during render, not in an effect: the answer this refuses may arrive before effects flush, and the frame
  // that showed the new selection is already the truth about which target is on screen.
  const current = useRef(shown);
  current.current = shown;
  return useCallback((candidate: ExecutionTarget) => current.current === candidate, []);
}
