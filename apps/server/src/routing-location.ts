/**
 * The browser's routing vocabulary, as the backend's relays read it.
 *
 * The parse itself is the protocol's (`@hepi/protocol/files`), because the client ingress, this backend and the Web
 * origin all read the same vocabulary: a path that meant two things on its way through would be a routing bug no caller
 * could see. This module is only the name the relays here import it under.
 */
export { workspaceRoutingLocation as routingLocation } from "@hepi/protocol/files";
