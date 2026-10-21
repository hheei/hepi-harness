import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { McpExposure } from "@earendil-works/pi-coding-agent";
import type {
  CodemodeMode,
  McpCodemodePreference,
  McpScope,
  McpServerInfo,
  ProjectTrustStatus,
} from "@hepi/protocol/mcp-ui";
import { getLastSettingsSelection, setLastSettingsSelection } from "../lib/settings-navigation";
import type { FetchLike, McpActionResult } from "./mcp-config-helpers";
import type { McpAddActionRequest } from "./McpAddServer";
import { McpWorkflow, idleMcpWorkflowSnapshot, type McpWorkflowSnapshot } from "./mcp-workflow";
import { projectTrustReloadKey } from "./settings-ui-helpers";

/**
 * The one React binding of the MCP workflow (components/mcp-workflow.ts).
 *
 * It creates one `McpWorkflow` per connection and folder, states its snapshot
 * through `useSyncExternalStore`, and disposes it when this panel goes away.
 * The workflow is created by the effect and held in state rather than
 * memoized, for the reason `useTerminalFanIn` states: both hosts render their
 * roots in `StrictMode`, whose replay runs an effect's cleanup and then the
 * effect again, and a memoized instance would be handed back already disposed.
 *
 * The two inputs a workflow is keyed by are the parts of it that can change
 * under a mounted panel: the folder it lists and the connection's own request
 * function. The callbacks are read through a ref, so a host that writes them
 * inline — every host does — does not replace a sign-in that is being polled.
 */
export interface McpWorkflowActions {
  select(key: string | null): void;
  /** Reads the overview again; a load already on its way is dropped when this one answers. */
  refresh(): void;
  /** The Add pane took the list's place: the notices about the last Add go. */
  prepareAdd(): void;
  saveCodemodePreference(preference: McpCodemodePreference): void;
  saveCodemodeMode(mode: CodemodeMode): void;
  saveCodemodeInlineBudget(budget: number | null): void;
  setServerEnabled(server: McpServerInfo, enabled: boolean): Promise<McpActionResult | undefined>;
  setServerExposure(server: McpServerInfo, exposure: McpExposure): Promise<McpActionResult | undefined>;
  setGroupEnabled(scope: McpScope, servers: readonly McpServerInfo[], enabled: boolean): Promise<McpActionResult | undefined>;
  removeServer(server: McpServerInfo): Promise<McpActionResult | undefined>;
  undoRemoval(): Promise<McpActionResult | undefined>;
  /** Adds a server, then selects and tests what it wrote; the answer is the view's to read. */
  add(request: McpAddActionRequest): Promise<McpActionResult | undefined>;
  test(server: McpServerInfo): void;
  signIn(server: McpServerInfo): void;
  signOut(server: McpServerInfo): Promise<McpActionResult | undefined>;
  pasteSignIn(server: McpServerInfo, flowId: string, value: string): void;
  cancelSignIn(server: McpServerInfo, flowId: string): void;
}

export interface McpWorkflowHandle {
  /** Everything the panel shows; the idle value until the effect has created the workflow. */
  readonly snapshot: McpWorkflowSnapshot;
  readonly actions: McpWorkflowActions;
}

/** The subscription of a panel whose workflow does not exist yet: nothing can change before it does. */
const noSubscription = () => () => {};

export function useMcpWorkflow({ cwd, send, trust, onProjectTrustChanged }: {
  cwd: string | null;
  /** This connection's own request function; the panel's routes resolve against it. */
  send: FetchLike;
  /** The page's trust status for `cwd`; a new decision reloads the panel in place. */
  trust?: ProjectTrustStatus | null;
  /** Hands the page `cwd`'s trust after an Add wrote to its `.pi/mcp.json`. */
  onProjectTrustChanged?: (cwd: string, status: ProjectTrustStatus) => void;
}): McpWorkflowHandle {
  const [instance, setInstance] = useState<{ readonly workflow: McpWorkflow } | null>(null);
  const trustHandler = useRef(onProjectTrustChanged);
  trustHandler.current = onProjectTrustChanged;

  useEffect(() => {
    const workflow = new McpWorkflow({
      cwd,
      send,
      initialSelection: getLastSettingsSelection("mcp", cwd),
      onProjectTrustChanged: (folder, status) => trustHandler.current?.(folder, status),
    });
    setInstance({ workflow });
    return () => {
      workflow.dispose();
      setInstance((current) => (current?.workflow === workflow ? null : current));
    };
  }, [cwd, send]);

  // The first read, and the read after the folder's decision changed: the page
  // read a decision the host recorded, or a project write made one, and the
  // project's servers and notices follow it while the selection stays.
  const trustKey = projectTrustReloadKey(trust);
  useEffect(() => {
    if (instance) void instance.workflow.refresh();
  }, [instance, trustKey]);

  const workflow = instance?.workflow ?? null;
  const snapshot = useSyncExternalStore(
    workflow ? workflow.subscribe : noSubscription,
    workflow ? workflow.getSnapshot : idleMcpWorkflowSnapshot,
    idleMcpWorkflowSnapshot,
  );

  // The remembered row, for this section and folder, or the first server a read lists.
  useEffect(() => {
    if (snapshot.selected) setLastSettingsSelection("mcp", snapshot.selected, cwd);
  }, [cwd, snapshot.selected]);

  const actions = useMemo<McpWorkflowActions>(() => ({
    select: (key) => workflow?.select(key),
    refresh: () => void workflow?.refresh(),
    prepareAdd: () => workflow?.prepareAdd(),
    saveCodemodePreference: (preference) => void workflow?.saveCodemodePreference(preference),
    saveCodemodeMode: (mode) => void workflow?.saveCodemodeMode(mode),
    saveCodemodeInlineBudget: (budget) => void workflow?.saveCodemodeInlineBudget(budget),
    setServerEnabled: async (server, enabled) => await workflow?.setServerEnabled(server, enabled),
    setServerExposure: async (server, exposure) => await workflow?.setServerExposure(server, exposure),
    setGroupEnabled: async (scope, servers, enabled) => await workflow?.setGroupEnabled(scope, servers, enabled),
    removeServer: async (server) => await workflow?.removeServer(server),
    undoRemoval: async () => await workflow?.undoRemoval(),
    add: async (request) => await workflow?.add(request),
    test: (server) => void workflow?.test(server),
    signIn: (server) => void workflow?.signIn(server),
    signOut: async (server) => await workflow?.signOut(server),
    pasteSignIn: (server, flowId, value) => void workflow?.pasteSignIn(server, flowId, value),
    cancelSignIn: (server, flowId) => void workflow?.cancelSignIn(server, flowId),
  }), [workflow]);

  return { snapshot, actions };
}
