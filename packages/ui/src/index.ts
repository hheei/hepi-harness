/**
 * The shared workbench's public surface.
 *
 * The two hosts mount `Workbench` and state their own router, origin and credential; nothing else here is a host's
 * business. Everything below the composition root — the session hook, the projections, the scoped stores and the client —
 * is an implementation of one workbench, so it is reached through the tree rather than imported by a host.
 */
export { Workbench, type WorkbenchConfig, type ConnectionReadout } from "./workbench";
export { createClient, WorkbenchRequestError, type WorkbenchClient } from "./client";
export { connectionScopeKey, type ConnectionIdentity } from "./lib/connection-scope";
export type { WorkbenchHost, WorkbenchLocation, WorkbenchNavigation } from "./lib/navigation";
export type { WorkbenchConnection } from "./lib/workbench-scope";
