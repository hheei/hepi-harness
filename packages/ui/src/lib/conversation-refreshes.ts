/**
 * The conversation reads a Settings surface may ask for, as one operation per conversation.
 *
 * A Settings section changes a resource the open conversation runs with — the runtime's tool configuration, an agent
 * definition — and that conversation then has to pick the change up. The pick-up is the conversation's own operation:
 * the Backend's reload route, the read that states it, and the notice that reports what the read established. It is not
 * a remount, so a shell that rebuilt its chat tree for one lost the reader's place, its stream and its paging. The chat
 * publishes the operation here, on the connection it belongs to, and a panel asks this connection for the conversation
 * it just changed.
 *
 * Two properties are the reason this is a registry rather than a callback prop threaded up to the shell:
 *
 * - **The conversation is the address.** A panel names the conversation its write landed on; an operation registered
 *   for another conversation is never called, so a write to one conversation cannot reload another, and nothing here
 *   has to know which conversation the chat is showing.
 * - **Only the conversation on screen answers.** The mounted chat is the only one that holds a refresh, and it is gone
 *   the moment its identity changes. A panel asking about a conversation that is not the mounted one is told
 *   `not_open` — it has nothing to re-read, and a surface that claimed a reload there would be claiming something
 *   nothing did.
 *
 * The registry belongs to a connection, exactly as the files seam and the conversation API do: a replaced connection
 * holds no refresh, so a panel that outlived its connection asks a registry nothing published into.
 */

import type { ReloadOutcome } from "../hooks/useAgentSession";

/**
 * What asking for one conversation's refresh established.
 *
 * The chat's own `ReloadOutcome` is passed through rather than restated, so a panel reports the sentence the read
 * established and this boundary owns no second vocabulary for the same operation: `reloaded` is what the read
 * accepted, `failed` is what it failed with, and `superseded` is another connection or a newer window being what the
 * surface shows. `not_open` is this boundary's own answer: no chat holds that conversation here, so no operation was
 * performed at all.
 */
export type ConversationRefreshOutcome = ReloadOutcome | { readonly status: "not_open" };

/**
 * One conversation's refresh, as the chat that owns it publishes it.
 *
 * It reports its own failure rather than throwing, so the surface that asked cannot mistake a rejection for an outcome
 * it never received. It may answer `not_open` itself: the operation a shell publishes is the chat's own while one is
 * mounted, and nothing once it is gone.
 */
export type ConversationRefresh = () => Promise<ConversationRefreshOutcome>;

export type ConversationRefreshes = {
  /** The mounted chat of `conversationId` publishes its own refresh, replacing whatever was held for that id. */
  hold(conversationId: string, refresh: ConversationRefresh): void;
  /** That same chat is going away. A refresh another chat published for the id is left alone. */
  release(conversationId: string, refresh: ConversationRefresh): void;
  /** Ask the conversation `conversationId` to pick up a change. Nothing mounted for it is `not_open`. */
  refresh(conversationId: string | null): Promise<ConversationRefreshOutcome>;
};

export function createConversationRefreshes(): ConversationRefreshes {
  const held = new Map<string, ConversationRefresh>();
  return {
    hold(conversationId, refresh) {
      held.set(conversationId, refresh);
    },
    release(conversationId, refresh) {
      // Only the chat that published this operation may withdraw it: a StrictMode replay's cleanup runs after the next
      // holder may already have published, and it must not take that holder's registration with it.
      if (held.get(conversationId) === refresh) held.delete(conversationId);
    },
    async refresh(conversationId) {
      const refresh = conversationId === null ? undefined : held.get(conversationId);
      return refresh === undefined ? { status: "not_open" } : await refresh();
    },
  };
}
