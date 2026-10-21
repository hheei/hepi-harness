import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDoc, type JsonObject, type Session } from "@earendil-works/pi-durable";

/**
 * The global default extension selection: hepi application state, one document per backend deployment. It is what a
 * conversation created after a change selects, and it never rewrites a conversation that already exists.
 *
 * The runtime's own `HarnessSettings.extensions` cannot be the default on its own: the framework reads it at every
 * resolution and never copies it, so a conversation that never made a choice would move under a change to it. The
 * default is therefore hepi-owned and the choice is written into each conversation when it is created.
 *
 * `extensions` absent is the untouched default — every installed extension — and is not the same state as `[]`,
 * which is a user who selected none. The storage-level version is the framework's, and a document written by a newer
 * backend is refused by typed access rather than silently misread.
 */
export type ExtensionSelectionDocumentState = JsonObject & { version: number; extensions?: string[] };

export const ExtensionSelectionDoc = defineDoc<ExtensionSelectionDocumentState>({
  kind: "hepi.extension-selection",
  version: 1,
  scope: "session",
  initial: () => ({ version: 1 }),
});

/** The names the user chose, or undefined while the default was never changed. A read, not a write. */
export async function readDefaultSelection(session: Session): Promise<readonly string[] | undefined> {
  return (await session.snapshot(ExtensionSelectionDoc, BACKGROUND_CONTEXT))?.extensions;
}

/** One change per request writes the whole selection, so a bulk toggle is one write. The answer is what was stored. */
export async function writeDefaultSelection(session: Session, names: readonly string[]): Promise<readonly string[]> {
  const stored = [...new Set(names)];
  await session.commit(async tx => {
    const document = await tx.doc(ExtensionSelectionDoc);
    document.version = 1;
    document.extensions = stored;
  }, BACKGROUND_CONTEXT);
  return stored;
}

/** One installed extension as the reporting side needs it: its name, the tools it offers and which of them are deferred. */
export type InstalledExtension = { readonly name: string; readonly tools: readonly string[]; readonly deferred?: readonly string[] };

/** A conversation's stored `pi.agent.extensions`, in the framework's own two shapes. */
export type StoredAgentExtensions = string[] | { add?: string[]; remove?: string[] } | undefined;

/**
 * What one conversation currently selects and is offered, from its committed `pi.agent.extensions`, the registry's
 * installed set and its committed `pi.agent.modelTools`. This is the framework's own selection rule applied to the same
 * committed documents, for reporting only: the tools a request is actually offered come from the runtime resolving those
 * documents, and this states the same thing so a client's answer and a request's behaviour cannot disagree. An array of
 * extensions is exactly those names; an object edits the installed set; absent is every installed extension, in registry
 * order.
 *
 * The tool list then follows the runtime's own two filters, in the runtime's own order (`resolveAgent`:
 * `filterTools(enabled, state.tools)` and then `offeredTools(modelCallable, state.modelTools)`):
 *
 * - `tools` is the **enabled** set, and an exact array states exactly those names. A child delegated from a definition
 *   carries one, which is why a report that read only the extensions would claim every tool of them: a definition that
 *   enables `read` is not offered `bash`, and no report may say otherwise.
 * - `modelTools` is the offer inside the enabled set: a tool is offered unless it is registered deferred and
 *   `modelTools` does not name it, and an exact `modelTools` array replaces the whole offer the way the runtime reads
 *   it. Before ticket 03b no MCP tool was deferred, so this input never changed an answer; now it is what makes a report
 *   about a grant and the turn that runs on it the same statement.
 *
 * Both are applied here because a report is a claim about what a request would meet. Without the first, a
 * definition-restricted child would be told it holds tools its own filter drops — and a grant written for it would look
 * like it offered nothing.
 */
export function reportedSelection(
  installed: readonly InstalledExtension[],
  stored: StoredAgentExtensions,
  modelTools?: StoredModelTools,
  tools?: StoredAgentTools,
): { extensions: string[]; tools: string[] } {
  const byName = new Map(installed.map(extension => [extension.name, extension]));
  let selected: string[];
  if (Array.isArray(stored)) selected = [...new Set(stored)];
  else {
    const removed = new Set(stored?.remove ?? []);
    selected = [...new Set([...installed.map(extension => extension.name).filter(name => !removed.has(name)), ...(stored?.add ?? [])])];
  }
  const extensions = selected.filter(name => byName.has(name));
  const available = extensions.flatMap(name => [...byName.get(name)!.tools]);
  // The runtime narrows to the enabled set before it decides the offer, so a name the conversation's own `tools` filter
  // leaves out cannot be reported as offered — and cannot be loaded by a grant either, which is the same fact stated the
  // other way round.
  const enabled = Array.isArray(tools) ? [...new Set(tools)].flatMap(name => (available.includes(name) ? [name] : [])) : available;
  const deferred = new Set(extensions.flatMap(name => byName.get(name)!.deferred ?? []));
  return { extensions, tools: offeredTools(enabled, deferred, modelTools) };
}

/** A conversation's stored `pi.agent.tools`, in the framework's own two shapes. */
export type StoredAgentTools = string[] | { remove: string[] } | undefined;

/** A conversation's stored `pi.agent.modelTools`, in the framework's own shapes. */
export type StoredModelTools = string[] | { add?: string[]; remove?: string[] } | undefined;

/**
 * The offer `pi.agent.modelTools` describes, as the runtime computes it: an array is exactly those names, in that order;
 * otherwise every tool except the deferred ones and those `remove` names, followed by the deferred names in `add` that
 * `remove` does not also name, in `add` order.
 */
function offeredTools(tools: readonly string[], deferred: ReadonlySet<string>, filter: StoredModelTools): string[] {
  if (Array.isArray(filter)) return [...new Set(filter)].flatMap(name => (tools.includes(name) ? [name] : []));
  const removed = new Set(filter?.remove ?? []);
  const kept = tools.filter(name => !deferred.has(name) && !removed.has(name));
  const byName = new Set(tools);
  const loaded = [...new Set(filter?.add ?? [])].filter(name => deferred.has(name) && !removed.has(name) && byName.has(name));
  return [...kept, ...loaded];
}

/** A selection a request asked for: an array of non-empty names, each named once, or undefined when it is not one. */
export function extensionNameList(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || !value.every(name => typeof name === "string" && name.trim() !== "")) return undefined;
  return [...new Set(value as string[])];
}

/**
 * What a stored selection still means against what is installed: a name that is no longer installed is dropped rather
 * than reported as selected. `stored === undefined` is the untouched default, which is every installed extension in
 * the registry's own order — not an order this module decides.
 */
export function resolveDefaultSelection(installed: readonly string[], stored: readonly string[] | undefined): string[] {
  const known = new Set(installed);
  return [...new Set(stored ?? installed)].filter(name => known.has(name));
}

/**
 * What one conversation selects when it is created: the resolved global default, less the extensions this conversation
 * has no use for — a coding tool without an execution environment has nothing to run in. The result is written into the
 * conversation's own `pi.agent.extensions` as an explicit list, which is what the framework reads for every later
 * resolution, so a later change to the default cannot move it.
 */
export function materializeSelection(installed: readonly string[], stored: readonly string[] | undefined, withheld: readonly string[] = []): string[] {
  const excluded = new Set(withheld);
  return resolveDefaultSelection(installed, stored).filter(name => !excluded.has(name));
}
