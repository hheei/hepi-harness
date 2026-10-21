import { contentText, type Message } from "@earendil-works/pi-ai";
import type { Op } from "@earendil-works/chord/delta";
import { MAX_TOOL_RESULT_IMAGE_BYTES, TOOL_RESULT_IMAGE_MIMES } from "@hepi/protocol";

/**
 * The bounded history window: how much of a conversation's active transcript one read, one page or one frame
 * carries. Every rule here is a pure function of the entries and their sizes, so the baseline read, an older page
 * and the stream's first frame cannot disagree about what a window is.
 *
 * The count rule is the copied app's, because it exists for a measured reason: counting raw entries starves user
 * messages out of the window in agent-heavy sessions, where one turn can append hundreds of tool results
 * (upstream pi-web `lib/session-reader.ts`, `sliceActiveBranch`; the Web copy was retired in ticket 04).
 */

/** Visible messages one window holds — the same number the render window already uses, so a first load renders in one page. */
export const VISIBLE_WINDOW = 50;
/** Raw-entry floor for one window, so a span of tool traffic with few visible anchors cannot balloon the payload. */
export const MIN_RAW_WINDOW_ENTRIES = 200;
/** The raw-entry cap of a window: scaled with the visible count, floored at the constant above. */
export const rawWindowCap = (visible: number): number => Math.max(MIN_RAW_WINDOW_ENTRIES, visible * 6);
/**
 * The soft frame target. The only hard bound is the transport's own: `send()` destroys a connection above 1 MiB of
 * queued bytes, and this design does not move it. The target mirrors the browser stream's existing high-water mark.
 */
export const FRAME_TARGET_BYTES = 512 * 1024;
/**
 * The transport's own hard bound, and the one this design does not move: \`send()\` destroys a connection whose queued
 * bytes pass it (\`server.ts\`, the 1 MiB guard). A frame is measured against it **before** it is written, so a read
 * that cannot be carried answers an actionable reason instead of destroying a socket the client would reconnect to
 * and immediately re-request — the loop this margin exists to prevent.
 */
export const FRAME_LIMIT_BYTES = 1024 * 1024 - 64 * 1024;

/**
 * One raw active entry, as the window rule reads it: its identity, its kind, the messages it contributes, and — for
 * an entry that starts a new context — the head marker it carries. It is a structural view of the runtime's own
 * \`EntryRecord\`, so a caller passes the view's entries without copying them.
 */
export type WindowEntry = { readonly id: string | number; readonly kind: string; readonly model?: readonly Message[]; readonly head?: string | number };

/** The entry kinds that consume the visible budget: user input, assistant output and a compaction summary. */
const VISIBLE_KINDS = new Set(["pi.user", "pi.assistant", "pi.compaction"]);

/** True when this entry is a visible message rather than tool traffic or bookkeeping. */
export function countsTowardWindow(kind: string): boolean {
  return VISIBLE_KINDS.has(kind);
}

/**
 * The index the window starts at: the newest entries, capped at {@link VISIBLE_WINDOW} visible messages and at the
 * raw cap, always including the newest entry. `0` means the whole transcript fits.
 */
export function windowStart(entries: readonly WindowEntry[], visible = VISIBLE_WINDOW): number {
  const rawCap = rawWindowCap(visible);
  let seen = 0;
  let start = entries.length;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entries.length - index > rawCap) break;
    if (countsTowardWindow(entries[index]!.kind) && ++seen > visible) break;
    start = index;
  }
  return start;
}

/**
 * Shrink a window until its serialized size fits `target`, dropping **whole entries from the oldest end** and never
 * the newest one. Returns the new start index; a window that already fits is returned unchanged, and a single
 * oversized newest entry is still carried whole rather than split or dropped.
 */
export function shrinkToBudget(sizes: readonly number[], start: number, target: number): number {
  let total = 0;
  for (let index = start; index < sizes.length; index += 1) total += sizes[index]!;
  let next = start;
  while (next < sizes.length - 1 && total > target) { total -= sizes[next]!; next += 1; }
  return next;
}

/**
 * The entries one native view advance **appended**, read from the ops the runtime published, or `undefined` when the
 * advance is anything else — a head marker, a truncation, a replacement, a reorder.
 *
 * This is the translation layer between the runtime's commit vocabulary and this server's: the ops are read for the
 * one structural fact they carry (entries were appended at the growing end), and they are never forwarded, re-encoded
 * or stored. A document op says nothing about entries and is passed over; any entries op that is not a pure append is
 * the re-baseline the design states, so the window and the token are recomputed from the view instead of adjusted.
 *
 * Reading this instead of comparing two entry arrays is what makes an ordinary advance cost what it appended rather
 * than what the transcript holds: no pass over the active range, and no projection of entries the client already has.
 */
export function appendedEntries<E extends WindowEntry>(ops: readonly Op[], previousLength: number): readonly E[] | undefined {
  const appended: E[] = [];
  let next = previousLength;
  for (const op of ops as readonly (readonly unknown[])[]) {
    const kind = op[0];
    const path = kind === "r" ? undefined : op[1];
    const targetsEntries = kind === "r" || (Array.isArray(path) && path[0] === "entries");
    if (!targetsEntries) continue;
    // Only `p` at the end of the array is an append: `p` at 0 with a delete count is a head marker, and every other
    // entries op (a set, a delete, a truncate, a reorder, a root replacement) restates the range.
    if (kind !== "p" || !Array.isArray(path) || path.length !== 1 || op[3] !== 0 || op[2] !== next || !Array.isArray(op[4])) return undefined;
    next += op[4].length;
    appended.push(...(op[4] as E[]));
  }
  return appended;
}

/**
 * One projected window entry as the projector holds it: the identity the window is keyed by, its serialized size, and
 * the wire entry itself. The size is carried beside the entry so the byte budget never has to re-serialize an entry it
 * has already measured.
 */
export type WindowItem = { readonly id: string | number; readonly bytes: number };

/** One bounded window as every surface publishes it: the projected entries, and the facts that say what the window is. */
export type ProjectedWindow<T> = { readonly items: readonly T[]; readonly hasMore: boolean; readonly oldestEntryId: string | null };

/**
 * The bounded window of one attachment, kept current **incrementally**.
 *
 * A window is a suffix of the active range, so an advance that appends only ever grows it at the newest end: the
 * projector keeps the window's raw entries and their projections, projects **only** the entries an advance appended,
 * and then drops whole entries from the oldest end until the count rule and the byte budget hold again. An advance it
 * cannot continue — a head marker, a truncation, a replacement, or the first read of an attachment — recomputes the
 * window from the view.
 *
 * What that buys is the reason the class exists: turn 200 projects what turn 200 appended, not the 300 raw entries the
 * window happens to carry, and the projection of an entry (including the redaction and the deferral) happens once per
 * entry rather than once per publication. The state is bounded by the window itself, so a long conversation costs no
 * more memory than a short one.
 */
export class WindowProjector<E extends WindowEntry, T extends WindowItem> {
  readonly #project: (entry: E) => T | undefined;
  readonly #visible: number;
  readonly #target: number;
  #raw: E[] = [];
  #items: (T | undefined)[] = [];
  /** Visible messages inside the window, so the count rule is answered without counting the window again. */
  #seen = 0;
  /** Entries inside the window that project to a message, so the byte budget knows whether a drop could lose content. */
  #projectable = 0;
  /** The serialized bytes of the projected entries inside the window, so the byte budget needs no pass over them. */
  #bytes = 0;
  /** The window's first entry's index in the active range, which is what `hasMore` is read from. */
  #start = 0;
  /** Entries this projector dropped from the newest end's opposite side because a bound asked it to. */
  #dropped = 0;
  constructor(project: (entry: E) => T | undefined, visible = VISIBLE_WINDOW, target = FRAME_TARGET_BYTES) {
    this.#project = project;
    this.#visible = visible;
    this.#target = target;
  }
  /**
   * The window after one advance: `appended` when the advance only appended entries (an empty array is a frame with
   * nothing appended), and `undefined` when the window must be recomputed from `entries`.
   */
  advance(entries: readonly E[], appended?: readonly E[]): ProjectedWindow<T> {
    if (appended === undefined) this.#reset(entries);
    else for (const entry of appended) this.#push(entry);
    // The count bounds — the raw cap and the visible cap — are answered by dropping the oldest entry, and both fall as
    // one is dropped, so one loop reaches the shortest suffix that satisfies them. The newest entry is never dropped:
    // an entry is never split, and one oversized entry ships whole.
    const cap = rawWindowCap(this.#visible);
    // The byte budget is a **target**, and it may only drop an entry that projects to no message. Dropping a
    // projectable one would move the window's boundary past content no caller has received, and the page that reaches
    // back for it would slice from that boundary, drop the same entry again and hand back the same boundary — the loop
    // that silently loses a message while still saying more exists. A window that still exceeds the target once only
    // bookkeeping entries are left is therefore carried whole, and the transport's own hard bound answers its named
    // refusal instead of this loop deciding which message to lose.
    while (this.#raw.length > 1 && (this.#raw.length > cap || this.#seen > this.#visible || (this.#bytes > this.#target && (this.#projectable > 1 || this.#items[0] === undefined)))) this.#drop();
    // A count bound can leave a window whose entries all project to nothing: a suffix of bookkeeping entries, which
    // carries no cursor for a caller to page from. Such a window is widened back to the nearest entry that projects to
    // a message — that entry is then the boundary — and a range that holds no such entry is the whole range and states
    // no boundary, which is the honest answer to "nothing older is reachable".
    if (this.#projectable === 0) this.#widenToProjectable(entries);
    const items = this.#items.filter((item): item is T => item !== undefined);
    // `hasMore` is about the transcript, not about this array: an entry that contributes no message was never in the
    // window, while an entry the range or a bound left behind is one a caller can still page to.
    const hasMore = this.#start > 0 || this.#dropped > 0;
    return { items, hasMore, oldestEntryId: hasMore && items[0] !== undefined ? String(items[0].id) : null };
  }
  #reset(entries: readonly E[]): void {
    this.#start = windowStart(entries, this.#visible);
    this.#dropped = 0;
    this.#raw = entries.slice(this.#start);
    this.#items = this.#raw.map(entry => this.#project(entry));
    this.#seen = this.#raw.reduce((count, entry) => count + (countsTowardWindow(entry.kind) ? 1 : 0), 0);
    this.#bytes = this.#items.reduce((total, item) => total + (item?.bytes ?? 0), 0);
    this.#projectable = this.#items.reduce((count, item) => count + (item === undefined ? 0 : 1), 0);
  }
  #push(entry: E): void {
    this.#raw.push(entry);
    const item = this.#project(entry);
    this.#items.push(item);
    this.#bytes += item?.bytes ?? 0;
    if (item !== undefined) this.#projectable += 1;
    if (countsTowardWindow(entry.kind)) this.#seen += 1;
  }
  /** Drop the oldest entry, keeping the running totals in step with the window they describe. */
  #drop(): void {
    const dropped = this.#raw.shift()!;
    const item = this.#items.shift();
    if (item !== undefined) this.#projectable -= 1;
    this.#bytes -= item?.bytes ?? 0;
    if (countsTowardWindow(dropped.kind)) this.#seen -= 1;
    this.#start += 1;
    this.#dropped += 1;
  }
  /**
   * Widen a window that projects to nothing back to the nearest entry that projects to a message, so its boundary is
   * one a caller can page from. Only a count bound can empty a window of projectable entries — the byte budget never
   * drops the last one — so this is the re-baseline that keeps a page's cursor usable, not a second size policy.
   */
  #widenToProjectable(entries: readonly E[]): void {
    while (this.#start > 0) {
      this.#start -= 1;
      const entry = entries[this.#start]!;
      const item = this.#project(entry);
      this.#raw.unshift(entry);
      this.#items.unshift(item);
      this.#bytes += item?.bytes ?? 0;
      if (countsTowardWindow(entry.kind)) this.#seen += 1;
      if (item !== undefined) { this.#projectable += 1; break; }
    }
    // The window now reaches the entries the count bound had left behind, so what it dropped is no longer behind it:
    // the boundary alone says whether older entries exist.
    this.#dropped = 0;
  }
}

/**
 * The two committed, immutable facts the history token names: the newest head marker, and the newest visible entry.
 */
export type HistoryFacts = { readonly head: string | null; readonly tail: string | null };

/** The facts of one view's active range. Read from the array the attachment already holds; no storage call. */
export function historyFacts(entries: readonly WindowEntry[]): HistoryFacts {
  return { head: headMarkerId(entries), tail: entries.length === 0 ? null : String(entries[entries.length - 1]!.id) };
}

/**
 * The facts after one append-only advance: the tail moves to the newest appended entry, and the head marker is
 * unchanged because a head marker is never an append (it is published at the front of the range, so it takes the
 * recompute path). An advance with nothing appended states the same facts, which is what makes two reads with no commit
 * agree without a scan.
 */
export function advanceHistoryFacts(facts: HistoryFacts, appended: readonly WindowEntry[]): HistoryFacts {
  const marker = appended.find(entry => entry.head !== undefined && entry.head !== null);
  return { head: marker === undefined ? facts.head : String(marker.id), tail: appended.length === 0 ? facts.tail : String(appended[appended.length - 1]!.id) };
}

/**
 * The thinking preview a deferred block carries: the first line, capped, without the surrounding whitespace. The
 * copied app's own rule, kept here so the server's deferred shape and the browser's rendering agree.
 */
export function thinkingPreview(thinking: string): string {
  return thinking.trimStart().match(/^[^\r\n]{0,240}/u)?.[0].trimEnd() ?? "";
}

/**
 * How much of a deferred **text** block a history frame carries. It is a character count rather than a byte count
 * because the wire cost of a preview is not what this bounds: what it bounds is how much a frame carries before the
 * read block is asked for the rest, and 2,000 characters is one screen of text for every script this server serves.
 *
 * The number is deliberately small. A preview that is large enough to be useful is large enough to be the reason the
 * frame cannot be carried, and the read block — not a bigger preview — is what makes the full text reachable.
 */
export const TEXT_PREVIEW_CHARS = 2000;

/**
 * How large a text block must be, in UTF-8 bytes, before a history frame replaces it with its preview and a read block.
 *
 * It is deliberately **separate** from {@link TEXT_PREVIEW_CHARS} and much larger, because the two numbers answer
 * different questions. The threshold answers "would carrying this whole cost the frame its budget?" — and the ordinary
 * case that must stay untouched is the framework's own: a tool result is already bounded to ~50 KiB upstream, and an
 * ordinary answer, diff or code block is a few KiB. Deferring those would trade a real reading experience for a click
 * the user did not need, so the threshold sits above them at 64 KiB, where a frame that carried several such entries
 * would be the frame the transport refuses.
 *
 * The preview length answers "how much of it does the frame show instead?", and it is small on purpose: a preview big
 * enough to be useful is big enough to be the reason the frame cannot be carried, and the read block — not a larger
 * preview — is what makes the whole text reachable.
 */
export const TEXT_DEFER_BYTES = 64 * 1024;

/**
 * The UTF-8 byte length of one text block, measured once at the place that decides whether to defer it.
 *
 * Bytes rather than characters, and measured rather than estimated, because the budget this threshold protects is a
 * byte budget on the wire: 2,000 characters of CJK text is several times the bytes of 2,000 ASCII ones, and a frame
 * must not be refused by a size the projection believed was small.
 */
export function textBytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/**
 * The preview a deferred text block carries: the leading {@link TEXT_PREVIEW_CHARS} characters, verbatim.
 *
 * Verbatim, and not marked with an ellipsis, because the same string is what a caller renders **and** what a caller
 * copies: a marker would be a character the entry does not contain, and the entry's own read block is what states that
 * more text exists. An empty text is returned unchanged rather than becoming a marker.
 */
export function textPreview(text: string): string {
  return text.length <= TEXT_PREVIEW_CHARS ? text : text.slice(0, TEXT_PREVIEW_CHARS);
}

/** The bytes of a base64 image block, and its mime, as the policy reads them. */
function base64ImageInfo(block: unknown): { bytes: number; mime?: string } | null {
  if (typeof block !== "object" || block === null || Array.isArray(block)) return null;
  const value = block as Record<string, unknown>;
  if (value.type !== "image") return null;
  const data = typeof value.data === "string" ? value.data : typeof value.source === "object" && value.source !== null && (value.source as Record<string, unknown>).type === "base64" && typeof (value.source as Record<string, unknown>).data === "string" ? (value.source as Record<string, string>).data : undefined;
  if (data === undefined) return null;
  const mime = typeof value.mimeType === "string" ? value.mimeType : typeof value.source === "object" && value.source !== null && typeof (value.source as Record<string, unknown>).media_type === "string" ? (value.source as Record<string, string>).media_type : undefined;
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return { bytes: Math.max(0, Math.floor(data.length * 3 / 4) - padding), mime };
}

/** The notice the copied app appends for an image the policy will not defer. */
export function toolResultImageNotice(count: number, mimes: readonly string[], bytes: number): string {
  const mimeText = mimes.length > 0 ? ": " + mimes.join(", ") : "";
  return "[" + count + " tool result image" + (count === 1 ? "" : "s") + " omitted from initial history payload" + mimeText + ", ~" + bytes + " bytes]";
}

/**
 * Defer the heavy content of one **history** entry: a thinking block becomes a preview and loses the provider's
 * opaque `thinkingSignature`, and a tool-result image inside the policy becomes the URL of the read block that
 * serves it. Both are lossless — the read blocks restore exactly what was removed — and both are applied
 * unconditionally rather than only when a frame is over budget, because the UI already collapses them and a
 * conditional shape would depend on a size the client cannot predict.
 *
 * The live partial is never passed through here: deferral is for history, and a streaming message stays exact.
 *
 * An image is deferred by **the message that carries it, whatever its role**: a tool result's screenshot and a user's
 * own accepted attachment are the same wire value, so they go behind the same read block under the same policy. A
 * user's prompt is the one attachment a person sends, and a frame that carried it inline would refuse the very read
 * the sender makes next — the size policy would be enforcing itself on everyone but the sender.
 *
 * A **text** block is deferred by the same policy, and it is the class that most needs it: it is the one heavy content
 * the copied app has no read block for upstream, so a large accepted prompt, answer or tool output used to ship whole
 * — twice, once as the entry's own `text` and once inside its message — and a frame that could not carry it answered
 * the transport's refusal with no way for a browser to reach the content. It is deferred above {@link TEXT_DEFER_BYTES}
 * so the framework's own ~50 KiB tool bound and an ordinary answer stay inline, its preview is bounded by
 * {@link TEXT_PREVIEW_CHARS}, and its read block restores exactly what the preview replaced, so the same losslessness
 * the other two classes have now holds for text. A text-only prompt is stored as a plain string rather than as an
 * array of blocks; it is deferred to the block shape so one preview shape and one read block serve both.
 *
 * `urlFor` and `textUrlFor` are the read blocks for one image block and one text block; the caller supplies them
 * because only the caller knows which session and entry it is projecting.
 */
export function deferHistoryMessage(message: Message, urlFor: (blockIndex: number) => string, textUrlFor: (blockIndex: number) => string): Message {
  if (message.role === "assistant") {
    const content = message.content.map((block, blockIndex) => {
      if (block.type === "thinking") return { type: "thinking" as const, thinking: thinkingPreview(block.thinking), deferred: true };
      // A text block is deferred by the same rule and for the same reason as a thinking block: the frame carries a
      // bounded preview and the read block restores exactly what the preview replaced. Text is the one heavy content
      // the copied app has no read block for, so the preview is what makes a large accepted prompt, answer or tool
      // output reachable at all rather than a frame the transport refuses.
      if (block.type === "text" && textBytes(block.text) > TEXT_DEFER_BYTES) return { type: "text" as const, text: textPreview(block.text), deferred: true, textUrl: textUrlFor(blockIndex) };
      return block;
    });
    return { ...message, content } as Message;
  }
  // A user's prompt and a tool result are the two roles whose content carries an image block; anything else is
  // returned untouched, including a system message's text-only content.
  if (message.role !== "user" && message.role !== "toolResult") return message;
  const source = message.content;
  // A text-only prompt is the copied app's own shape for one: its text is a plain string rather than an array. It is
  // deferred to the block shape an array's text block gets, so a caller has one preview shape to render and one read
  // block to expand, and the entry's own text is restored by that read rather than by a second code path.
  if (typeof source === "string") {
    if (textBytes(source) <= TEXT_DEFER_BYTES) return message;
    // The block shape is the wire value this module deliberately builds (a text block carrying its own read-block URL,
    // which pi-ai's own `TextContent` does not describe), so it is cast once, here, as the image block above is.
    return { ...message, content: [{ type: "text", text: textPreview(source), deferred: true, textUrl: textUrlFor(0) }] } as unknown as Message;
  }
  if (!Array.isArray(source)) return message;
  let omitted = 0;
  let bytes = 0;
  const mimes = new Set<string>();
  // The deferred block is the copied app's own URL shape (an image whose \`source\` is a URL rather than inline base64),
  // which is what its browser half already renders and what its own reader produces. pi-ai's \`ImageContent\` models
  // only the inline shape, so the block is stated as the wire value it is.
  const content: unknown[] = [];
  for (const [blockIndex, block] of source.entries()) {
    // A text block in an array is deferred exactly as an assistant message's is: the policy is the message's content,
    // not its role's, because the frame that carries the content is the same frame either way.
    const text = typeof block === "object" && block !== null && !Array.isArray(block) && (block as { type?: unknown }).type === "text" && typeof (block as { text?: unknown }).text === "string" ? (block as { text: string }).text : undefined;
    if (text !== undefined && textBytes(text) > TEXT_DEFER_BYTES) { content.push({ type: "text", text: textPreview(text), deferred: true, textUrl: textUrlFor(blockIndex) }); continue; }
    const image = base64ImageInfo(block);
    if (image === null) { content.push(block); continue; }
    if (image.mime !== undefined && TOOL_RESULT_IMAGE_MIMES.has(image.mime) && image.bytes > 0 && image.bytes <= MAX_TOOL_RESULT_IMAGE_BYTES) {
      content.push({ type: "image", source: { type: "url", media_type: image.mime, url: urlFor(blockIndex) } });
      continue;
    }
    omitted += 1;
    bytes += image.bytes;
    if (image.mime !== undefined) mimes.add(image.mime);
  }
  // The assembled content is the wire value this module deliberately builds — a URL block pi-ai's own model does not
  // describe — so it is cast once, here, rather than at every call site.
  if (omitted === 0) return { ...message, content } as Message;
  content.push({ type: "text", text: toolResultImageNotice(omitted, [...mimes], bytes) });
  return { ...message, content } as Message;
}

/**
 * The actionable answer to a frame that cannot be carried, or undefined when the frame fits.
 *
 * The transport's own limit is the only hard bound: the stream's `send()` destroys a connection whose queued
 * bytes pass it. A read that cannot be brought inside that limit therefore answers a **named reason** with the entry
 * that caused it, and that entry stays readable through its own read block — the caller is told the read could not be
 * bounded rather than being handed a body that claims to be a page or a transcript. Every surface that returns a
 * window asks this one question, so a size is one statement wherever it is hit: on the stream it rides
 * `state_oversize` instead of a frame, and the connection stays open, which is why a size never produces
 * `resync_required`.
 */
export function oversizeFrame(value: unknown, newestEntryId: string | null): { entryId: string | null; bytes: number } | undefined {
  const bytes = Buffer.byteLength(JSON.stringify(value));
  return bytes > FRAME_LIMIT_BYTES ? { entryId: newestEntryId, bytes } : undefined;
}

/** The catalogue facts a session list row states: how many messages the conversation has, and its first user text. */
export type CatalogueStats = { readonly count: number; readonly firstMessage: string };

/** The role a window entry projects, or undefined for an entry that contributes no message. */
function projectedRole(entry: WindowEntry): string | undefined {
  return entry.model?.[0]?.role;
}

/** Count the messages a conversation's active entries carry, and its first user text, in one pass. */
export function catalogueStats(entries: readonly WindowEntry[]): CatalogueStats {
  let count = 0;
  let firstMessage = "";
  for (const entry of entries) {
    const role = projectedRole(entry);
    if (role !== "user" && role !== "assistant" && role !== "toolResult") continue;
    count += 1;
    if (firstMessage === "" && role === "user") firstMessage = contentText(entry.model![0]!.content);
  }
  return { count, firstMessage };
}

/**
 * Keep a running catalogue count current from one view advance. When the advance only appended entries — the
 * ordinary case — the count is incremented by what was appended instead of re-reading the transcript, which is what
 * keeps a catalogue read independent of conversation length. A head marker moves the active range, so the count is
 * recomputed from the new view rather than adjusted.
 */
export function advanceCatalogueStats(previous: CatalogueStats, before: readonly WindowEntry[], after: readonly WindowEntry[]): CatalogueStats {
  const appended = after.length >= before.length && before.every((entry, index) => entry === after[index]);
  if (!appended) return catalogueStats(after);
  let count = previous.count;
  let firstMessage = previous.firstMessage;
  for (let index = before.length; index < after.length; index += 1) {
    const entry = after[index]!;
    const role = projectedRole(entry);
    if (role !== "user" && role !== "assistant" && role !== "toolResult") continue;
    count += 1;
    if (firstMessage === "" && role === "user") firstMessage = contentText(entry.model![0]!.content);
  }
  return { count, firstMessage };
}

/**
 * The window a client already holds, as the advancing-frame rule reads it: the revision the frame was stamped with,
 * its entries, and the head marker the window was cut under.
 */
export type HeldWindow = { readonly revision: number; readonly entries: readonly { readonly id: string | number }[]; readonly head: string | null };

/**
 * Where one advancing window continues the window a client already holds, or `-1` when it does not.
 *
 * A window is a **suffix** of the active range, so it only ever moves forward at the newest end: the previous
 * window's newest entry is still in this one unless the active context restarted. An unchanged head marker plus that
 * entry still being present is therefore the whole test for "this advance continues what the client holds" — and it
 * is a test on the two windows, never on a client, which is why the server keeps no per-client cursor, buffer or ack.
 *
 * A head-marker move (a compaction or a reset) is the one event that ends a loaded window: the transcript then
 * matches what the model can see, so the whole window is restated instead of being continued, and the client never
 * has to reason about a truncation and an append atomically.
 */
export function continuationIndex(previous: HeldWindow | null, next: { readonly head: string | null; readonly entries: readonly { readonly id: string | number }[] }): number {
  if (previous === null || previous.head !== next.head) return -1;
  const newest = previous.entries[previous.entries.length - 1];
  return newest === undefined ? -1 : next.entries.findIndex(entry => String(entry.id) === String(newest.id));
}

/**
 * The id of the newest head marker in a view's active entries, or null when the range has none.
 *
 * A head marker is an entry that starts a new context (a compaction summary, or a reset); the native view keeps it
 * first and the non-head entries from its head after it (\`pi-durable\`, \`ConversationView.entries\`). It is read from
 * the in-memory view the caller already holds — **no storage read**, at the cost of one pass over that array — and
 * it is an immutable committed fact, which is what makes it usable in a token that must survive a backend restart.
 */
export function headMarkerId(entries: readonly WindowEntry[]): string | null {
  for (const entry of entries) if (entry.head !== undefined && entry.head !== null) return String(entry.id);
  return null;
}

/**
 * The history token: an opaque function of two committed, immutable facts of one conversation — its newest head
 * marker and its newest visible entry. Two reads with no commit agree; an append moves the tail; a head marker moves
 * the head; two attachments of the same conversation agree because neither attachment is an input; and a backend
 * restart on the same store agrees because the facts it names are durable.
 *
 * The conversation id is part of it because entry ids are **inherited**: a fork holds the same entry ids as its
 * parent, so entry ids alone do not identify a history. Nothing is minted, hashed or stored — the token is a
 * comparison, not a record.
 *
 * Cost, stated rather than claimed: this is a comparison over the attachment's own active-entry array, so it is CPU
 * proportional to the active range on every publication and **no** storage read. That array is the one the window is
 * cut from and the runtime already holds it, so nothing here reads a transcript — but "no storage read" is not
 * "constant time", and a conversation whose active range is very large pays for it per frame. Recorded as a limit in
 * `docs/chat.md`; not optimized here.
 */
export function historyToken(conversationId: string, entries: readonly WindowEntry[]): string {
  return tokenFromFacts(conversationId, historyFacts(entries));
}

/** The token one attachment's **kept** facts state, so a publication after an append costs nothing to derive. */
export function tokenFromFacts(conversationId: string, facts: HistoryFacts): string {
  return conversationId + "|" + (facts.head ?? "-") + "|" + (facts.tail ?? "-");
}

/**
 * The scope part of the same token: the conversation and its newest head marker, with the entry fact dropped.
 *
 * It is the one history fact an append cannot move, so it is what a long-lived navigation identity may be stamped
 * with: a rail's anchors keep their identity across every turn that follows them, while a compaction or a reset — the
 * head marker moving, which is already the event that ends a loaded window — retires the coordinates issued against
 * the scope. Declared beside {@link tokenFromFacts} because both spellings of one identity belong to the module that
 * owns that identity, and a second place that builds it is a second rule for when history moved.
 */
export function scopeFromFacts(conversationId: string, facts: HistoryFacts): string {
  return conversationId + "|" + (facts.head ?? "-");
}
