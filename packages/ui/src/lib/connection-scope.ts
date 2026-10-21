/**
 * The identity a page's drafts, cached views and remembered navigation belong to.
 *
 * A connection is not just an origin: the same Gateway can front more than one Backend, and one Backend can serve more
 * than one account scope. Two of those can hold a conversation with the *same* id — the durable ids are only unique
 * within one Backend — and a draft, a cached view or a remembered session is about one of them. Keying any of that by
 * session id alone is therefore what makes one connection's data appear in another's page.
 *
 * The scope is derived from the connection descriptor the server confirmed (its backend id, account scope and build)
 * plus the profile the client connected as, and it is an opaque string: nothing parses it, and a client that changes
 * any of its parts is a different scope. A page starts a new scope from empty — there is no import from an older one,
 * because the values a previous scope held describe a conversation this one may not even have.
 *
 * Deliberately **not** part of this identity: the connection generation. That counter is a fence for in-flight reads of
 * one connection, not a name for data; a re-connect to the same Backend and account is the same scope, and its drafts
 * should still be there.
 */
import { connectionScopeOf, type ScopedDescriptor as SettingsDescriptor } from "@hepi/session/settings";

export interface ConnectionIdentity {
  /** The profile the host connected as, as the host states it (a Web page's own origin, or an App's profile name). */
  readonly profile: string;
  /** The Backend the descriptor named. */
  readonly backendId: string;
  /** The account scope the descriptor named. */
  readonly accountScope: string;
}

/** The part of the connection descriptor the scope is read from, as the ingress answers it. */
export type ScopedDescriptor = SettingsDescriptor;

/**
 * The connection's identity, from the descriptor the Backend itself answered plus the profile the host connected as.
 *
 * The `backendId`/`accountScope` pair is not decided here: `@hepi/session/settings`'s `connectionScopeOf` owns that rule,
 * because it is the same question — whose catalog, whose settings — that every scoped store asks, including the settings
 * cache. Reading the two facts from the same fields through the same function is what keeps drafts, remembered views and
 * a cached catalog from disagreeing about whose connection they belong to; this adds only the profile the host stated,
 * which is the one part of the identity a Backend cannot know.
 *
 * A descriptor that names no Backend, or no account scope, is refused rather than defaulted. Collapsing an unstated
 * identity into one shared scope is precisely how two connections would start reading each other's drafts.
 */
export function connectionIdentityOf(profile: string, descriptor: ScopedDescriptor): ConnectionIdentity {
  return { profile, ...connectionScopeOf(descriptor) };
}

/**
 * The one string every scoped store keys by.
 *
 * It is built from the parts in a fixed order with a separator no part may contain, so two different identities cannot
 * produce one string and one identity cannot produce two. A part is percent-encoded for the same reason: an id that
 * contains the separator would otherwise be able to impersonate a different scope.
 */
export function connectionScopeKey(identity: ConnectionIdentity): string {
  return [identity.profile, identity.backendId, identity.accountScope].map(encodeURIComponent).join("|");
}

/**
 * One store key inside a scope.
 *
 * The scope is the prefix, so a key from another connection is not the same key: `getDraft` on a new scope reads
 * nothing rather than the previous connection's unsent text, and a stale write lands under a scope nothing reads.
 */
export function scopedKey(scope: string, key: string): string {
  return scope + "/" + key;
}
