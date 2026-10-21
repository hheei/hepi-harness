/**
 * The queue above the composer: what is waiting to reach the model, and the two controls the user has over one item.
 *
 * The rows render the queue the host stated — never a local copy — so a refused edit puts the host's own current text
 * back on screen and a consumed item disappears with the frame that consumed it. The held banner is the user's own stop:
 * while it stands nothing the queue holds will run, and Continue is the one thing that ends it.
 *
 * Everything here reads a projection and calls a command. The queue's truth is the conversation's, so this module keeps
 * no queue state of its own beyond the text a row is being edited against.
 */
import { useEffect, useState } from "react";
import type { QueuedItemProjection } from "@hepi/protocol";
import { useI18n } from "../../hooks/useI18n";

/** The queue's text-only form: the two lists a caller with no per-item projection can still state. */
export interface QueuedMessagesView {
  steering: string[];
  followUp: string[];
}

/** One queued item, with what editing and cancelling it needs. */
export interface QueuedItemCommands {
  edit(submissionId: string, contentToken: string, content: string): Promise<
    { ok: true } | { ok: false; reason: string; code?: string; current?: QueuedItemProjection }
  >;
  cancel(submissionId: string): Promise<{ ok: boolean; reason?: string; code?: string }>;
}

function QueuedItemRow({ item, busy, commands, onOpenConversation }: {
  item: QueuedItemProjection;
  busy: boolean;
  /** The two controls, or nothing on a surface that may read the queue but not change it. */
  commands?: QueuedItemCommands;
  onOpenConversation?: (conversationId: string) => void;
}) {
  const { t } = useI18n();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item.content);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  // A row that is re-rendered from a newer frame adopts that text: the host's statement is the truth about the item,
  // and keeping a draft across it would show text the queue no longer holds.
  useEffect(() => { setDraft(item.content); setNotice(null); }, [item.content, item.contentToken]);
  const report = item.source.kind === "report" ? item.source : undefined;
  const save = async () => {
    if (pending || commands === undefined) return;
    setPending(true);
    const result = await commands.edit(item.submissionId, item.contentToken, draft);
    setPending(false);
    if (result.ok) { setEditing(false); setNotice(null); return; }
    // A conflict is shown as what the newer decision was, beside the current text the host stated; an item the
    // runtime already placed is its own fact, not a generic failure, because no retry of the same edit will land.
    if (result.current !== undefined) setNotice(t("chat.itemConflict"));
    else if (result.code === "not_queued") setNotice(t("chat.itemPlaced"));
    else setNotice(t("chat.itemEditFailed", { reason: result.reason }));
  };
  const cancel = async () => {
    if (pending || commands === undefined) return;
    setPending(true);
    const result = await commands.cancel(item.submissionId);
    setPending(false);
    if (result.ok) return;
    if (result.code === "item_placed" || result.code === "not_found") setNotice(t("chat.itemPlaced"));
    else setNotice(t("chat.itemCancelFailed", { reason: result.reason ?? "" }));
  };
  return (
    <div data-queued-item={item.submissionId} style={{ padding: "3px 10px", fontSize: 12, color: "var(--text-muted)", minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
        <span
          style={{
            flexShrink: 0, fontSize: 10, fontFamily: "var(--font-mono)", padding: "1px 7px", borderRadius: 999,
            border: `1px solid ${item.mode === "steer" ? "color-mix(in srgb, var(--accent) 45%, transparent)" : "var(--border)"}`,
            color: item.mode === "steer" ? "var(--accent)" : "var(--text-dim)",
          }}
        >
          {item.mode === "steer" ? "steer" : "follow-up"}
        </span>
        {report !== undefined && (
          <span
            title={report.childConversationId}
            style={{ flexShrink: 0, fontSize: 10, fontFamily: "var(--font-mono)", padding: "1px 7px", borderRadius: 999, border: "1px solid var(--border)", color: "var(--text-dim)" }}
          >
            {t("chat.itemReport")}
          </span>
        )}
        {!editing && (
          <span title={item.content} style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>{item.content}</span>
        )}
        {report !== undefined && onOpenConversation !== undefined && !editing && (
          <button
            type="button"
            onClick={() => onOpenConversation(report.childConversationId)}
            title={t("chat.itemShowOriginal")}
            style={{ flexShrink: 0, background: "transparent", border: "none", color: "var(--text-dim)", cursor: "pointer", fontSize: 11, padding: "2px 4px" }}
          >
            {t("chat.itemFrom", { id: report.childConversationId })}
          </button>
        )}
        {commands !== undefined && !editing && (
          <button type="button" onClick={() => setEditing(true)} style={{ flexShrink: 0, background: "transparent", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text)", cursor: "pointer", fontSize: 11, padding: "2px 8px" }}>
            {t("chat.itemEdit")}
          </button>
        )}
        {commands !== undefined && !editing && (
          <button type="button" onClick={() => void cancel()} disabled={pending} style={{ flexShrink: 0, background: "transparent", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text)", cursor: "pointer", fontSize: 11, padding: "2px 8px" }}>
            {t("chat.itemCancel")}
          </button>
        )}
      </div>
      {editing && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 6 }}>
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            rows={Math.min(6, Math.max(2, draft.split("\n").length))}
            style={{ width: "100%", resize: "vertical", background: "var(--bg)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 6, padding: "5px 7px", fontSize: 12, fontFamily: "inherit" }}
          />
          <div style={{ display: "flex", gap: 6 }}>
            <button type="button" onClick={() => void save()} disabled={pending || busy} style={{ background: "transparent", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text)", cursor: "pointer", fontSize: 11, padding: "2px 10px" }}>
              {t("chat.itemSave")}
            </button>
            <button type="button" onClick={() => { setEditing(false); setDraft(item.content); setNotice(null); }} style={{ background: "transparent", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text-dim)", cursor: "pointer", fontSize: 11, padding: "2px 10px" }}>
              {t("chat.itemEditCancel")}
            </button>
          </div>
        </div>
      )}
      {notice !== null && <div style={{ marginTop: 4, fontSize: 11, color: "var(--warning, #d97706)" }}>{notice}</div>}
    </div>
  );
}

function QueuedMessageRow({ kind, text }: { kind: "steer" | "follow-up"; text: string }) {
  return (
    <div
      title={text}
      style={{ display: "flex", alignItems: "center", gap: 8, padding: "3px 10px", fontSize: 12, color: "var(--text-muted)", minWidth: 0 }}
    >
      <span
        style={{
          flexShrink: 0, fontSize: 10, fontFamily: "var(--font-mono)", padding: "1px 7px", borderRadius: 999,
          border: `1px solid ${kind === "steer" ? "color-mix(in srgb, var(--accent) 45%, transparent)" : "var(--border)"}`,
          color: kind === "steer" ? "var(--accent)" : "var(--text-dim)",
        }}
      >
        {kind}
      </span>
      <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{text}</span>
    </div>
  );
}

export interface ComposerQueueProps {
  /** The queue as items, with the source and token each per-item control needs. It is the authoritative list. */
  items?: readonly QueuedItemProjection[] | null;
  /** The same queue as text lists, for the count and for a caller that has no items. */
  messages?: QueuedMessagesView | null;
  busy: boolean;
  commands?: QueuedItemCommands;
  onRecall?: () => void;
  onOpenConversation?: (conversationId: string) => void;
}

/** The queue itself. Renders nothing when there is no queued work. */
export function ComposerQueue({ items, messages, busy, commands, onRecall, onOpenConversation }: ComposerQueueProps) {
  const { t } = useI18n();
  const count = (messages?.steering.length ?? 0) + (messages?.followUp.length ?? 0) + (items?.length ?? 0);
  if (count === 0) return null;
  return (
    <div style={{ marginBottom: 8, border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg-panel)", padding: "5px 0" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "2px 8px 4px 10px" }}>
        <span style={{ fontSize: 10, fontFamily: "var(--font-mono)", color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: 0.4 }}>
          {t("chat.queued", { count: (items?.length ?? 0) > 0 ? (items?.length ?? 0) : count })}
        </span>
        {onRecall && (
          <button
            onClick={onRecall}
            title={t("chat.recallTitle")}
            style={{
              display: "flex", alignItems: "center", gap: 6, padding: "4px 12px", fontSize: 12, color: "var(--text)",
              background: "transparent", border: "1px solid var(--border)", borderRadius: 7, cursor: "pointer",
              transition: "background 0.12s, border-color 0.12s", whiteSpace: "nowrap",
            }}
            onMouseEnter={(event) => {
              event.currentTarget.style.background = "var(--bg-hover)";
              event.currentTarget.style.borderColor = "color-mix(in srgb, var(--accent) 45%, var(--border))";
            }}
            onMouseLeave={(event) => {
              event.currentTarget.style.background = "transparent";
              event.currentTarget.style.borderColor = "var(--border)";
            }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="9 14 4 9 9 4" />
              <path d="M20 20v-7a4 4 0 0 0-4-4H4" />
            </svg>
            {t("chat.recall")}
          </button>
        )}
      </div>
      {/* The items are the rows when the frame stated them, because they are the same queue with the identity and the
          token each control needs. A caller that only has the text lists still gets the plain rows. */}
      {(items ?? []).length > 0
        ? (items ?? []).map((item) => (
          <QueuedItemRow
            key={item.submissionId}
            item={item}
            busy={busy}
            {...(commands === undefined ? {} : { commands })}
            {...(onOpenConversation === undefined ? {} : { onOpenConversation })}
          />
        ))
        : (
          <>
            {messages?.steering.map((text, index) => (
              <QueuedMessageRow key={`steer-${index}`} kind="steer" text={text} />
            ))}
            {messages?.followUp.map((text, index) => (
              <QueuedMessageRow key={`followup-${index}`} kind="follow-up" text={text} />
            ))}
          </>
        )}
    </div>
  );
}

/**
 * The user's own stop. While it is held nothing the queue holds will run, so the surface says so and offers the one
 * control that ends it. A `stopping` answer from Continue means the old stop's ordinary scope still drains: the button
 * stays and says so rather than pretending the queue moved.
 */
export function HeldBanner({ phase, onContinue }: {
  phase: null | "pending" | "stopping";
  onContinue?: () => void;
}) {
  const { t } = useI18n();
  return (
    <div data-held-banner style={{ marginBottom: 8, border: "1px solid rgba(239,68,68,0.35)", borderRadius: 6, background: "rgba(239,68,68,0.06)", padding: "7px 10px", display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
      <span style={{ fontSize: 11, fontWeight: 600, color: "#ef4444", textTransform: "uppercase", letterSpacing: 0.4 }}>{t("chat.heldTitle")}</span>
      <span style={{ fontSize: 12, color: "var(--text-muted)", flex: 1, minWidth: 180 }}>
        {phase === "stopping" ? t("chat.stopping") : t("chat.heldBody")}
      </span>
      {onContinue !== undefined && (
        <button
          type="button"
          data-continue
          onClick={onContinue}
          disabled={phase === "pending"}
          style={{ background: "transparent", border: "1px solid var(--border)", borderRadius: 7, color: "var(--text)", cursor: phase === null ? "pointer" : "default", fontSize: 12, padding: "4px 12px", whiteSpace: "nowrap" }}
        >
          {phase === "pending" ? t("chat.continuing") : t("chat.continue")}
        </button>
      )}
    </div>
  );
}
