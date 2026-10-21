import { GatewayHostTransport, type HostBinding, type HostFetch } from "./host-client.ts";
import { controlCapability, type GatewayControl } from "./control.ts";
import { createProcessCapability, type ProcessCapability } from "./process.ts";
import { filesCapability, type GatewayFilesCapability } from "./host-files.ts";
import { terminalCapability, type GatewayTerminalCapability } from "./host-terminal.ts";

/**
 * What a client is built from: the resolved binding, an optional injected fetch, an optional default bound, and the
 * workspace the binding serves when a capability's own route names it out of band rather than in its request body.
 */
export type GatewayHostClientOptions = HostBinding & { readonly fetch?: HostFetch; readonly timeoutMs?: number; readonly workspaceId?: string };

/**
 * One gateway host, as the capabilities this backend uses see it. It is built once from a resolved binding and owns the
 * transport those capabilities share: an execution and the abort that stops it, a workspace registration and the
 * checkout created from it, a file written into a workspace and a terminal opened in it all reach the same origin with
 * the same token and the same classification of a lost answer.
 *
 * The namespaces are deliberately small. A capability does not construct a URL, a header or an abort signal itself, and
 * nothing here retries: a call whose answer was lost is reported as an unknown outcome for that capability's domain.
 */
export class GatewayHostClient {
	readonly process: ProcessCapability;
	readonly control: GatewayControl;
	readonly files: GatewayFilesCapability;
	readonly terminal: GatewayTerminalCapability;

	constructor(options: GatewayHostClientOptions) {
		const transport = new GatewayHostTransport(options);
		this.process = createProcessCapability(transport);
		// The control namespace carries the binding's workspace because an installation names its destination there, not
		// in the request: the route derives it from the binding, so the client states it once instead of per call.
		this.control = controlCapability(transport, options.workspaceId === undefined ? {} : { workspaceId: options.workspaceId });
		this.files = filesCapability(transport);
		this.terminal = terminalCapability(transport);
	}
}
