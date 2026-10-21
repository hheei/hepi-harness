"use client";
import { useEffect, useRef, useState } from "react";
import {
  NOTICE_EXIT_ANIMATION_MS,
  NOTICE_VISIBLE_MS,
  remainingAfter,
  shelfOf,
  type NoticeFact,
} from "../lib/notice-shelf";

// Toast 整体高度上限；文本区高度上限 = 整体上限 - 上下 padding(14*2) - 上下边框(1*2)
const NOTICE_MAX_HEIGHT_PX = 500;
const NOTICE_TEXT_MAX_HEIGHT_PX = NOTICE_MAX_HEIGHT_PX - 30;

/**
 * The notice shelf: the presentation owner of the notices the conversation states.
 *
 * The session hands over **facts** and takes them away again; every clock is here. That is the half that was in the
 * wrong place: a toast's countdown, its pause while the reader hovers or focuses it, and its exit animation are things a
 * surface that is on screen does, and a conversation session kept in the background must not hold a timer for a toast
 * nobody is drawing (spec R3/R4, acceptance C7).
 *
 * The rules themselves are `lib/notice-shelf.ts`, so what is left here is one effect: the oldest notice is drawn for
 * its stated time, a notice the reader is on keeps its remaining time instead of restarting, an over-full shelf retires
 * its oldest to make room, and a retired fact is handed back so the session stops holding it.
 */
export function NoticeShelf({ facts, onRetire, floating = false }: {
  readonly facts: readonly NoticeFact[];
  /** The shelf is finished with this fact: the session drops it, and the notices waiting behind it move up. */
  onRetire: (id: string) => void;
  readonly floating?: boolean;
}) {
  const { visible, overCapacity } = shelfOf(facts);
  /** The notice the reader's pointer or focus is on. While it is set, the countdown does not run. */
  const [heldId, setHeldId] = useState<string | null>(null);
  /** The notice playing its leave animation: it is still drawn, and it is no longer counting down. */
  const [exitingId, setExitingId] = useState<string | null>(null);
  /** What the oldest notice's countdown has left, and when the run it is in began. */
  const remainingRef = useRef(NOTICE_VISIBLE_MS);
  const startedAtRef = useRef<number | null>(null);
  const oldestIdRef = useRef<string | null>(null);
  const oldestId = visible[0]?.id ?? null;
  const held = heldId !== null && visible.some((notice) => notice.id === heldId);

  useEffect(() => {
    if (oldestId === null) {
      oldestIdRef.current = null;
      return;
    }
    if (exitingId !== null) {
      const timer = setTimeout(() => {
        setExitingId(null);
        onRetire(exitingId);
      }, NOTICE_EXIT_ANIMATION_MS);
      return () => clearTimeout(timer);
    }
    // More facts than the shelf draws: the oldest one leaves at once, which is what brings the next one up. It is the
    // same retirement its own expiry performs, so it is the same path rather than a second queue.
    if (overCapacity) {
      setExitingId(oldestId);
      return;
    }
    // A different notice is the oldest now, so its countdown starts over rather than inheriting the last one's clock.
    if (oldestIdRef.current !== oldestId) {
      oldestIdRef.current = oldestId;
      remainingRef.current = NOTICE_VISIBLE_MS;
    }
    if (held) return;
    startedAtRef.current = Date.now();
    const timer = setTimeout(() => setExitingId(oldestId), remainingRef.current);
    return () => {
      clearTimeout(timer);
      // The run is over — a pause, a newer oldest, or an unmount — so what it consumed is taken off the remaining
      // time. A resume therefore continues the notice instead of restarting it.
      remainingRef.current = remainingAfter(remainingRef.current, startedAtRef.current, Date.now());
      startedAtRef.current = null;
    };
  }, [exitingId, held, oldestId, onRetire, overCapacity]);

  if (visible.length === 0) return null;
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        // Right-anchored: every toast's right edge aligns here, widths extend leftward
        alignItems: "flex-end",
        marginBottom: floating ? 0 : 10,
      }}
    >
      {visible.map((notice, index) => {
        const color = notice.type === "error"
          ? "#ef4444"
          : notice.type === "warning"
            ? "#d97706"
            : notice.type === "success"
              ? "#10b981"
              : "var(--accent)";
        return (
          <div
            key={notice.id}
            className="notice-shelf-item"
            onMouseEnter={() => setHeldId(notice.id)}
            onMouseLeave={(event) => {
              if (!event.currentTarget.contains(document.activeElement)) setHeldId(null);
            }}
            onFocus={() => setHeldId(notice.id)}
            onBlur={(event) => {
              if (!event.currentTarget.matches(":hover")) setHeldId(null);
            }}
            style={{
              display: "flex",
              // Top-align children so the type dot sits by the first line on multi-line toasts
              alignItems: "flex-start",
              gap: 10,
              minHeight: 60,
              height: "auto",
              // 整体高度上限：超出后由文本区内部滚动承担（见下方 span 的 overflowY），
              // 容器自身保持 hidden，小圆点固定在顶部不随文本滚动
              maxHeight: NOTICE_MAX_HEIGHT_PX,
              // The floating wrapper is pointerEvents:"none" (click-through by design),
              // so the toast itself must opt back into interactivity or hover events never reach it
              pointerEvents: "auto",
              marginBottom: index === visible.length - 1 ? 0 : 6,
              overflow: "hidden",
              borderRadius: 14,
              border: "1px solid color-mix(in srgb, var(--border) 70%, transparent)",
              background: "var(--bg)",
              color: "var(--text-muted)",
              width: "fit-content",
              maxWidth: "min(100%, 620px)",
              boxShadow: floating
                ? "0 1px 2px rgba(15,23,42,0.05), 0 10px 28px -14px rgba(15,23,42,0.24)"
                : "0 1px 2px rgba(15,23,42,0.04), 0 8px 24px -12px rgba(15,23,42,0.10)",
              fontSize: 14,
              lineHeight: 1.5,
              transformOrigin: "top right",
              // Use backwards fill for the entrance animation so height styles return to
              // inline styles once it finishes; otherwise the keyframe's fixed 60px would
              // stick around in fill mode and permanently clamp the expanded toast
              animation: notice.id === exitingId
                ? "notice-shelf-out 0.18s ease-in forwards"
                : "notice-shelf-in 0.18s ease-out backwards",
              padding: "0 12px",
            }}
          >
            <span
              style={{
                width: 7,
                height: 7,
                borderRadius: "50%",
                background: color,
                flexShrink: 0,
                // Align with the optical center of the first text line: 14px vertical
                // padding + (21px line box - 7px dot) / 2
                marginTop: 21,
              }}
            />
            {/* Full text by default: pre-line preserves 
 (nowrap/normal collapse
                newlines into spaces) and long lines wrap instead of truncating;
                content taller than the cap scrolls inside the text area */}
            <span
              tabIndex={0}
              style={{ padding: "14px 0", minWidth: 0, maxWidth: "100%", maxHeight: NOTICE_TEXT_MAX_HEIGHT_PX, overflowY: "auto", scrollbarWidth: "thin", whiteSpace: "pre-line", wordBreak: "break-word" }}
            >
              {notice.message}
            </span>
          </div>
        );
      })}
    </div>
  );
}
