import type { ResourceReader } from "@hepi/session/resources";
import { readResourceText } from "./resource-read";
import type { TextContent } from "./types";

/**
 * The read block behind one deferred history text.
 *
 * A heavy text block — a large paste, answer or tool output — reaches the browser as a bounded preview that names the
 * read block restoring it, exactly as a deferred thinking block does. This module is that read: one loader, so the rule
 * lives in one place instead of at each surface that renders a text block.
 *
 * Two facts about the interface are the whole point, and a caller depends on both:
 *
 * - **A load happens only when a caller asks for it.** Nothing here runs on mount, on reconnect, on scroll or while
 *   rendering; a caller calls {@link loadDeferredText} from an explicit expand, from an explicit copy, or from the edit
 *   handler that needs the message itself. Opening a conversation therefore costs nothing for the messages it does not
 *   read.
 * - **A load is all-or-nothing and never a preview.** The resolved value is the entry's own text; a failure is a
 *   rejection, so a caller that must not act on a preview (copy, edit) can refuse rather than silently use one.
 *
 * The reader is the connection's own (`WorkbenchClient.resources`), so the address resolves against the Gateway this
 * page was admitted to and the answer carries that connection's credential. It also owns the bounded cache and the
 * named refusals, which is why this module holds neither: asking twice for one block is served by the reader, and a
 * surface that is not inside a workbench has no reader to ask — it states the reader's `unavailable` refusal rather
 * than falling back to a relative `fetch` against the document's own origin.
 */

/** Whether a block is a deferred text: a preview that names the read block restoring what it replaced. */
export function isDeferredTextBlock(block: unknown): block is TextContent & { textUrl: string } {
  if (typeof block !== "object" || block === null || Array.isArray(block)) return false;
  const value = block as { type?: unknown; deferred?: unknown; textUrl?: unknown };
  return value.type === "text" && value.deferred === true && typeof value.textUrl === "string" && value.textUrl !== "";
}

/**
 * The full text behind one preview, from the read block the block itself names.
 *
 * The URL is the block's own, because a tool result has no entry id at render time and a text-only prompt is stored as
 * a plain string: only the projection that deferred the content knows which entry and which block index it named. The
 * reader follows the block's bounded pages and answers the whole text, so a caller never sees a preview or a partial
 * answer.
 */
export function loadDeferredText(reader: ResourceReader | null, textUrl: string): Promise<string> {
  return readResourceText(reader, textUrl);
}

/**
 * The original text of each given text block, in order, with every deferred one read through the connection's reader.
 *
 * This is the one seam a full-text action crosses: a copy and an edit both need the **whole** text rather than the
 * previews the frame carried, and a message can hold several text blocks beside images, so the caller gets one answer
 * per block instead of a joined string it would have to re-split. All-or-nothing on purpose — an action that must use
 * the original cannot do half of it with one block restored and another still a preview.
 */
export function loadTextBlockOriginals(reader: ResourceReader | null, blocks: readonly TextContent[]): Promise<string[]> {
  return Promise.all(blocks.map((block) => (isDeferredTextBlock(block) ? loadDeferredText(reader, block.textUrl) : Promise.resolve(block.text))));
}
