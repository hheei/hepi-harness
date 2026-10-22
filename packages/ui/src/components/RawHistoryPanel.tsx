"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "../hooks/useI18n";
import { createRequestId, operationFailure } from "../lib/conversation-api";
import { useWorkbenchConnection } from "../lib/workbench-scope";
import { forkAttemptKey, forkRequestId, forkSettled } from "../lib/fork-attempt";
import { ImagePreview } from "./ImagePreview";
import { ReferenceSurface } from "./ReferencePanel";
import { errorText } from "@hepi/protocol/error-text";

/**
 * The raw history behind the transcript's window, as the backend's own bounded read states it.
 *
 * The window a conversation streams is the *active* range: a compaction's dropped prefix and a fork's inherited prefix
 * are not in it. This panel reads them through `GET /api/sessions/:id/read`, which is the same operation a model's
 * `agent_read` calls, so a person and an agent are answered by one history and one membership rule.
 *
 * It holds no copy of that history: a page is fetched, its entries and their block inventory are listed, and a block's
 * text or bytes are fetched only when the reader asks for that block. A compaction's summary is therefore visible as
 * the entry it is, and an image or a tool result that contributed no line is still addressable — the entry inventory
 * names every block, including the ones a page returned no line for.
 *
 * Forking from here is the transcript's own operation: the chosen entry is the branch point, the source is only read,
 * and the branch is a conversation of its own that keeps this one as its display parent (spec D14, D15).
 */

/** One block of one entry, as the read's inventory names it: where its lines are, or what the image is. */
type BlockRef = {
  readonly blockIndex: number;
  readonly type: "text" | "thinking" | "image" | "toolCall";
  readonly startLine?: number;
  readonly endLine?: number;
  readonly mimeType?: string;
  readonly bytes?: number;
  readonly name?: string;
};

type EntryRef = {
  readonly entryId: string;
  readonly kind: string;
  readonly role: string | null;
  readonly blocks: readonly BlockRef[];
};

type ReadDetails = {
  readonly tail: string | null;
  readonly offset: number;
  readonly limit: number;
  readonly outputLines: number;
  readonly truncated: boolean;
  readonly hasMore: boolean;
  readonly entries: readonly EntryRef[];
  readonly next?: unknown;
};

type ReadAnswer = {
  readonly output: readonly ({ readonly type: "text"; readonly text: string } | { readonly type: "image"; readonly data: string; readonly mimeType: string })[];
  readonly details: ReadDetails;
  readonly diagnostics: readonly { readonly severity: string; readonly code: string; readonly message: string }[];
  readonly code?: string;
  readonly error?: string;
};

interface Props {
  sessionId: string;
  /** An entry this panel must position on, when a reference named one the transcript's window does not carry. */
  focusEntryId?: string | null;
  /** `focus` asks the target to open its raw history positioned on the entry, which the window cannot show. */
  onOpenSession?: (sessionId: string, entryId?: string, options?: { rawHistoryFocus?: boolean }) => void;
  onForked?: (newSessionId: string) => void;
}

export function RawHistoryPanel({ sessionId, focusEntryId = null, onOpenSession, onForked }: Props) {
  const { t } = useI18n();
  // Taken each render: a replaced connection is a different client, and a callback holding the old one would use it.
  const { api } = useWorkbenchConnection();
  const [pages, setPages] = useState<readonly ReadAnswer[]>([]);
  const [next, setNext] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openBlock, setOpenBlock] = useState<{ entryId: string; blockIndex: number } | null>(null);
  const [blockAnswer, setBlockAnswer] = useState<ReadAnswer | null>(null);
  const [blockError, setBlockError] = useState<string | null>(null);
  const [forking, setForking] = useState<string | null>(null);
  const requestRef = useRef(0);
  // Whichever block request answers last used to land; a generation makes the newest own the body, and retiring it on a
  // session, connection or unmount change is the same rule.
  const blockReadRef = useRef(0);
  /**
   * The fork attempts whose **answer** this panel never received, and the identity each one keeps.
   *
   * A retry after a dropped response must carry the identity of the attempt it repeats, or the backend sees a second
   * fork and makes a second branch. The identity is therefore held per branch point for as long as the attempt is
   * unanswered, and released the moment it is answered — a failure keeps it, because that failure is what is retried.
   */
  const forkAttemptsRef = useRef<Map<string, string>>(new Map());
  /** The entry this panel was asked to position on, and the container the position is scrolled within. */
  const [focusEntry, setFocusEntry] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  /** One walk at a time: a second one started while the first is paging would ask for the same continuation twice. */
  const walkingRef = useRef(false);

  /**
   * One page of the read: the first, or the continuation the previous page named. The page is also **returned**, so a
   * caller that must reach a particular entry can walk the continuation itself instead of guessing when the state it
   * set has landed.
   */
  const load = useCallback(async (cursor: unknown | null): Promise<ReadAnswer | null> => {
    const generation = requestRef.current + 1;
    requestRef.current = generation;
    setLoading(true);
    setError(null);
    try {
      const query = cursor === null ? "?limit=200" : "?cursor=" + encodeURIComponent(JSON.stringify(cursor));
      const body = await api.rawRead<ReadAnswer>(sessionId, query);
      if (requestRef.current !== generation) return null;
      setPages((current) => cursor === null ? [body] : [...current, body]);
      setNext(body.details.next ?? null);
      return body;
    } catch (cause) {
      if (requestRef.current === generation) setError(errorText(cause));
      return null;
    } finally {
      if (requestRef.current === generation) setLoading(false);
    }
  }, [sessionId, api]);

  // The entries already listed and the continuation the read named, as refs as well as state: the walk below reads
  // them to decide whether the entry it wants is in hand, and it must read the page it just received rather than wait
  // for a render.
  const entriesRef = useRef<readonly EntryRef[]>([]);
  const nextRef = useRef<unknown | null>(null);
  entriesRef.current = pages.flatMap((page) => page.details.entries);
  nextRef.current = next;

  // A session or connection change is a history asked a different way; `load` carries both, so it says so here.
  useEffect(() => {
    requestRef.current += 1;
    blockReadRef.current += 1;
    setPages([]);
    setNext(null);
    setOpenBlock(null);
    setBlockAnswer(null);
    setBlockError(null);
    entriesRef.current = [];
    nextRef.current = null;
    void load(null);
    // A closed panel, like a replaced connection, has nothing left for an in-flight block read to land on.
    return () => { blockReadRef.current += 1; };
  }, [sessionId, load]);

  /**
   * Position on one entry: walk the read's own continuation until that entry is listed, or the history runs out.
   *
   * A reference can name an entry the first page did not reach — and one the transcript's window does not carry at all
   * — so "show me that entry" is answered by the surface that holds the whole history rather than by the window. The
   * walk is bounded by the read's own `next`, which is absent at the end of the history, and by progress: a
   * continuation that does not advance would otherwise be requested forever.
   */
  const walkTo = useCallback(async (entryId: string) => {
    if (walkingRef.current) return;
    if (entriesRef.current.some((entry) => entry.entryId === entryId)) return;
    walkingRef.current = true;
    try {
      let cursor = nextRef.current;
      while (cursor !== null) {
        const body = await load(cursor);
        if (body === null) return;
        if (body.details.entries.some((entry) => entry.entryId === entryId)) return;
        const following = body.details.next ?? null;
        if (following === null || JSON.stringify(following) === JSON.stringify(cursor)) return;
        cursor = following;
      }
    } finally {
      walkingRef.current = false;
    }
  }, [load]);

  // A focus request positions on its entry as soon as that entry is listed. The effect re-runs as pages arrive,
  // because the entry a reference names may only be on a later page; `walkTo` itself does nothing once the entry is
  // in hand, so this is a request that stops being one the moment it is met.
  useEffect(() => { setFocusEntry(focusEntryId); }, [focusEntryId, sessionId]);
  useEffect(() => {
    if (focusEntry === null) return;
    if (entriesRef.current.some((entry) => entry.entryId === focusEntry)) return;
    if (nextRef.current === null) return;
    void walkTo(focusEntry);
  }, [focusEntry, sessionId, pages.length, walkTo]);
  useEffect(() => {
    if (focusEntry === null) return;
    containerRef.current?.querySelector<HTMLElement>('[data-raw-entry="' + CSS.escape(focusEntry) + '"]')?.scrollIntoView({ block: "center" });
  }, [focusEntry, pages.length]);

  /** One block of one entry: an image comes back as bytes, a text or thinking block as its own lines. */
  const readBlock = useCallback(async (entryId: string, blockIndex: number) => {
    const generation = blockReadRef.current + 1;
    blockReadRef.current = generation;
    setOpenBlock({ entryId, blockIndex });
    setBlockAnswer(null);
    setBlockError(null);
    try {
      const answer = await api.rawRead<ReadAnswer>(sessionId, "?entryId=" + encodeURIComponent(entryId) + "&blockIndex=" + blockIndex);
      if (blockReadRef.current !== generation) return;
      setBlockAnswer(answer);
    } catch (cause) {
      // A current failure is kept: it is what the reader retries from. Only an older request's answer is dropped.
      if (blockReadRef.current !== generation) return;
      setBlockError(errorText(cause));
    }
  }, [sessionId, api]);

  const forkAt = useCallback(async (entryId: string) => {
    setForking(entryId);
    const key = forkAttemptKey(sessionId, entryId);
    // The identity is taken before the request and kept until the answer arrives, so a retry of this same branch
    // point — a dropped response, a reload, a second click — is answered with the branch the first attempt created
    // instead of creating a second one (spec D14, A19).
    const requestId = forkRequestId(forkAttemptsRef.current, key, createRequestId);
    try {
      const answered = await api.control(sessionId).fork({ at: entryId, requestId });
      if (!answered.ok) {
        const refusal = operationFailure(answered);
        setError(refusal.message);
        return;
      }
      // Answered: the attempt is over, so the next fork of this entry is a new branch rather than a replay.
      forkSettled(forkAttemptsRef.current, key);
      onForked?.(answered.value.conversationId);
    } catch (cause) {
      // The identity is deliberately kept: the retry of this attempt is what the user is about to make.
      setError(errorText(cause));
    } finally {
      setForking(null);
    }
  }, [sessionId, api, onForked]);

  const entries = entriesRef.current;
  const diagnostics = pages.flatMap((page) => page.diagnostics);
  // The history itself, as the read stated it: the page's own lines, in the read's order. A block the read did not
  // return as text — an image, or a text block the byte budget deferred — is what the entry inventory below addresses.
  const history = pages.flatMap((page) => page.output.filter((output): output is { type: "text"; text: string } => output.type === "text").map((output) => output.text)).join("\n");
  const text = blockAnswer?.output.filter((output): output is { type: "text"; text: string } => output.type === "text").map((output) => output.text).join("\n") ?? "";
  const image = blockAnswer?.output.find((output) => output.type === "image");

  return (
    <div ref={containerRef} data-raw-history={sessionId} style={{ background: "var(--bg-panel)", borderBottom: "1px solid var(--border)", boxShadow: "0 10px 28px rgba(0,0,0,0.10)", padding: "12px 16px", display: "flex", flexDirection: "column", gap: 10, maxHeight: "70dvh", overflowY: "auto" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <strong style={{ fontSize: 12, flex: 1 }} title={t("history.rawDescription")}>{t("history.raw")}</strong>
        <button type="button" onClick={() => void load(null)} disabled={loading} style={{ fontSize: 11, background: "none", border: "1px solid var(--border)", borderRadius: 4, color: "var(--text-muted)", cursor: "pointer", padding: "2px 8px" }}>
          {loading ? t("history.reading") : t("history.reload")}
        </button>
      </div>
      {error !== null && <div role="alert" data-raw-history-error style={{ fontSize: 12, color: "#dc2626" }}>{error}</div>}

      {/* The conversation's references and the one action that creates them. The list, its named outcomes and the
          follow are the reference surface's own (cross-session references ticket 02): this panel only places it, and it
          reads and writes through the same owner the read blocks above use. */}
      <ReferenceSurface sessionId={sessionId} api={api} onOpenSession={onOpenSession} />

      {entries.length === 0 && !loading && error === null && <span style={{ fontSize: 12, color: "var(--text-dim)" }}>{t("history.empty")}</span>}

      {history !== "" && (
        <pre data-raw-history-text style={{ margin: 0, fontSize: 12, whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontFamily: "var(--font-mono)", color: "var(--text)", maxHeight: "30dvh", overflowY: "auto", border: "1px solid var(--border)", borderRadius: 4, padding: "6px 8px" }}>{history}</pre>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {entries.map((entry) => (
          <div
            key={entry.entryId}
            data-raw-entry={entry.entryId}
            // The entry a reference asked for, named so a reader — and the journey that drives this — can see that the
            // navigation really landed rather than merely having opened the panel.
            {...(entry.entryId === focusEntry ? { "data-raw-focus": entry.entryId } : {})}
            style={{ border: "1px solid var(--border)", borderRadius: 4, padding: "6px 8px", display: "flex", flexDirection: "column", gap: 4 }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--text-dim)" }}>
              <span style={{ fontFamily: "var(--font-mono)" }}>{entry.entryId}</span>
              <span style={{ flex: 1 }}>{entry.kind}{entry.role === null ? "" : " · " + entry.role}</span>
              <button type="button" disabled={forking === entry.entryId} onClick={() => void forkAt(entry.entryId)} style={{ fontSize: 11, background: "none", border: "1px solid var(--border)", borderRadius: 4, color: "var(--text-muted)", cursor: "pointer", padding: "1px 6px" }}>
                {forking === entry.entryId ? t("history.forking") : t("history.forkHere")}
              </button>
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
              {entry.blocks.map((block) => (
                <button
                  key={block.blockIndex}
                  type="button"
                  data-raw-block={entry.entryId + ":" + block.blockIndex}
                  onClick={() => void readBlock(entry.entryId, block.blockIndex)}
                  style={{ fontSize: 11, background: "none", border: "1px solid var(--border)", borderRadius: 4, color: "var(--text-muted)", cursor: "pointer", padding: "1px 6px" }}
                >
                  {block.type === "toolCall" ? "call " + (block.name ?? "") : block.type}
                  {block.startLine === undefined ? "" : " " + block.startLine + "–" + block.endLine}
                  {block.bytes === undefined ? "" : " · " + block.bytes + "B"}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>

      {next !== null && (
        <button type="button" onClick={() => void load(next)} disabled={loading} style={{ alignSelf: "flex-start", fontSize: 11, background: "none", border: "1px solid var(--border)", borderRadius: 4, color: "var(--text-muted)", cursor: "pointer", padding: "2px 8px" }}>
          {t("history.loadOlder")}
        </button>
      )}

      {openBlock !== null && (
        <div data-raw-block-body={openBlock.entryId + ":" + openBlock.blockIndex} style={{ borderTop: "1px solid var(--border)", paddingTop: 8, display: "flex", flexDirection: "column", gap: 6 }}>
          {blockError !== null && <div role="alert" style={{ fontSize: 12, color: "#dc2626" }}>{blockError}</div>}
          {image !== undefined && (
            <ImagePreview src={"data:" + image.mimeType + ";base64," + image.data} alt={t("history.entry") + " " + openBlock.entryId}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={"data:" + image.mimeType + ";base64," + image.data} alt="" style={{ maxWidth: 240, maxHeight: 240, borderRadius: 6, objectFit: "contain", display: "block", border: "1px solid var(--border)" }} />
            </ImagePreview>
          )}
          {text !== "" && (
            <pre style={{ margin: 0, fontSize: 12, whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontFamily: "var(--font-mono)", color: "var(--text)" }}>{text}</pre>
          )}
        </div>
      )}

      {diagnostics.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          {diagnostics.map((diagnostic) => (
            <span key={diagnostic.code + diagnostic.message} style={{ fontSize: 11, color: diagnostic.severity === "error" ? "#dc2626" : "var(--text-dim)" }}>{diagnostic.code}: {diagnostic.message}</span>
          ))}
        </div>
      )}
    </div>
  );
}
