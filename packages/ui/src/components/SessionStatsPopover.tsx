"use client";

import { useI18n } from "../hooks/useI18n";
import type { SessionStatsInfo } from "../lib/pi-types";
import type { SessionInfo } from "../lib/types";

/** The fields of a conversation's own identity the reader can copy. */
export type SessionCopyField = "file" | "id" | "projectDir" | "gitBranch" | "gitWorktree";

interface Props {
  stats: SessionStatsInfo | null;
  session: SessionInfo | null;
  /** The context window this conversation is filling, as its own surface last stated it. */
  contextUsage: { percent: number | null; contextWindow: number; tokens: number | null } | null;
  /** Which field was copied a moment ago, so its own button says so. */
  copiedField: SessionCopyField | null;
  onCopy: (field: SessionCopyField, value: string) => void;
  /** The narrow layout states one column of the same facts. */
  mobile: boolean;
}

/**
 * The conversation's own facts: which conversation this is, which project it runs in, how many messages it has, what it
 * has spent, and how much of its window is left.
 *
 * It is the popover behind the top bar's stat readout, and it is read-only by construction: nothing here writes to the
 * conversation, and its one action is copying a field the reader may want elsewhere. What it shows is what the chat's own
 * surface stated — the stats and the context usage arrive from the conversation, never from a read of this panel's own.
 */
export function SessionStatsPopover({ stats, session, contextUsage, copiedField, onCopy, mobile }: Props) {
  const { locale, t: translate } = useI18n();
  return (
      <div className="session-info-popover" style={{
        background: "var(--bg-panel)",
        borderBottom: "1px solid var(--border)",
        boxShadow: "0 10px 28px rgba(0,0,0,0.10)",
        padding: "12px 16px",
      }}>
        {stats ? (() => {
          const ws = session;
          const sessionRows = [
             ...(stats.sessionName ? [{ label: translate("session.name"), value: stats.sessionName, copyField: null }] : []),
             { label: translate("session.id"), value: stats.sessionId, copyField: "id" as const },
          ];
          const projectRows = [
            ...(ws ? [{ label: translate("session.projectDir"), value: ws.projectDisplayRoot ?? ws.projectRoot ?? ws.cwd, copyField: "projectDir" as const }] : []),
            ...(ws?.branch ? [{ label: translate("session.gitBranch"), value: ws.branch, copyField: "gitBranch" as const }] : []),
            ...(ws?.isWorktree ? [{ label: translate("session.gitWorktree"), value: ws.cwd, copyField: "gitWorktree" as const }] : []),
          ];
          const messageRows = [
             [translate("session.user"), stats.userMessages.toLocaleString(locale)],
             [translate("session.assistant"), stats.assistantMessages.toLocaleString(locale)],
             [translate("session.toolCalls"), stats.toolCalls.toLocaleString(locale)],
             [translate("session.toolResults"), stats.toolResults.toLocaleString(locale)],
             [translate("session.total"), stats.totalMessages.toLocaleString(locale)],
          ];
          const tokenRows = [
             [translate("session.input"), stats.tokens.input.toLocaleString(locale)],
             [translate("session.output"), stats.tokens.output.toLocaleString(locale)],
             ...(stats.tokens.cacheRead > 0 ? [[translate("session.cacheRead"), stats.tokens.cacheRead.toLocaleString(locale)]] : []),
             ...(stats.tokens.cacheWrite > 0 ? [[translate("session.cacheWrite"), stats.tokens.cacheWrite.toLocaleString(locale)]] : []),
             [translate("session.total"), stats.tokens.total.toLocaleString(locale)],
          ];
          const ctx = contextUsage ?? stats.contextUsage;
          const formatCompact = (n: number) => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(0)}k` : String(n);
          const extraTokenRows = [
             ...(stats.cost > 0 ? [[translate("session.cost"), `$${stats.cost.toFixed(4)}`]] : []),
             ...(ctx?.contextWindow ? [[translate("session.context"), `${ctx.percent !== null ? `${ctx.percent.toFixed(1)}%` : "?"} / ${formatCompact(ctx.contextWindow)}`]] : []),
             // Cache hit rate = cache reads / (input + cache writes + cache reads) — the denominator covers all input-class tokens.
             ...(stats.tokens.cacheRead + stats.tokens.cacheWrite > 0 && stats.tokens.cacheRead + stats.tokens.cacheWrite + stats.tokens.input > 0
               ? [[translate("session.cacheHitRate"), `${(stats.tokens.cacheRead / (stats.tokens.cacheRead + stats.tokens.cacheWrite + stats.tokens.input) * 100).toFixed(1)}%`]]
               : []),
          ];
          const section = (
            title: string,
            sectionRows: string[][],
            valueAlign: "left" | "right" = "left",
            compact = false,
          ) => (
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text)", marginBottom: 6 }}>{title}</div>
                <div style={{
                  display: "grid",
                  gridTemplateColumns: compact ? "max-content max-content" : "auto minmax(0, 1fr)",
                  columnGap: compact ? 14 : 12,
                  rowGap: 4,
                  justifyContent: compact ? "start" : undefined,
                }}>
                  {sectionRows.map(([label, value]) => (
                    <div key={`${title}:${label}`} style={{ display: "contents" }}>
                      <div style={{ color: "var(--text-dim)", whiteSpace: "nowrap" }}>{label}</div>
                      <div style={{
                        color: "var(--text-muted)",
                        minWidth: 0,
                        overflowWrap: compact ? "normal" : "anywhere",
                        textAlign: valueAlign,
                        whiteSpace: valueAlign === "right" ? "nowrap" : "normal",
                      }}>{value}</div>
                    </div>
                  ))}
                </div>
              </div>
            );
          const copyTitleKey: Record<SessionCopyField, string> = {
            file: "session.copyFile",
            id: "session.copyId",
            projectDir: "session.copyProjectDir",
            gitBranch: "session.copyGitBranch",
            gitWorktree: "session.copyGitWorktree",
          };
          const copyButton = (field: SessionCopyField, value: string) => {
            const copied = copiedField === field;
            return (
              <button
                type="button"
                title={copied ? translate("session.copied") : translate(copyTitleKey[field])}
                onClick={() => onCopy(field, value)}
                style={{
                  alignSelf: "start",
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: 22,
                  height: 22,
                  marginTop: -2,
                  color: copied ? "var(--accent)" : "var(--text-dim)",
                  background: "transparent",
                  border: "1px solid var(--border)",
                  borderRadius: 4,
                  cursor: "pointer",
                  flex: "0 0 auto",
                  transition: "color 0.12s, border-color 0.12s, background 0.12s",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.color = "var(--accent)";
                  e.currentTarget.style.borderColor = "var(--accent)";
                  e.currentTarget.style.background = "var(--bg-hover)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.color = copied ? "var(--accent)" : "var(--text-dim)";
                  e.currentTarget.style.borderColor = "var(--border)";
                  e.currentTarget.style.background = "transparent";
                }}
              >
                {copied ? (
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                ) : (
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                  </svg>
                )}
              </button>
            );
          };
          const sessionInfoSection = (
            <div style={{ minWidth: 0 }}>
               <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text)", marginBottom: 6 }}>{translate("session.infoSection")}</div>
              <div style={{ display: "grid", gridTemplateColumns: "auto minmax(0, 1fr) auto", columnGap: 12, rowGap: 8, alignItems: "start" }}>
                {sessionRows.map((row) => (
                  <div key={`session-info:${row.label}`} style={{ display: "contents" }}>
                    <div style={{ color: "var(--text-dim)", whiteSpace: "nowrap" }}>{row.label}</div>
                    <div style={{
                      color: "var(--text-muted)",
                      minWidth: 0,
                      overflowWrap: "anywhere",
                      wordBreak: "break-word",
                      whiteSpace: "normal",
                    }}>{row.value}</div>
                    <div>{row.copyField ? copyButton(row.copyField, row.value) : null}</div>
                  </div>
                ))}
              </div>
            </div>
          );
          const projectInfoSection = projectRows.length > 0 ? (
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text)", marginBottom: 6 }}>{translate("session.projectSection")}</div>
              <div style={{ display: "grid", gridTemplateColumns: "auto minmax(0, 1fr) auto", columnGap: 12, rowGap: 8, alignItems: "start" }}>
                {projectRows.map((row) => (
                  <div key={`project-info:${row.label}`} style={{ display: "contents" }}>
                    <div style={{ color: "var(--text-dim)", whiteSpace: "nowrap" }}>{row.label}</div>
                    <div style={{
                      color: "var(--text-muted)",
                      minWidth: 0,
                      overflowWrap: "anywhere",
                      wordBreak: "break-word",
                      whiteSpace: "normal",
                    }}>{row.value}</div>
                    <div>{row.copyField ? copyButton(row.copyField, row.value) : null}</div>
                  </div>
                ))}
              </div>
            </div>
          ) : null;

          return (
            <div style={{
              display: "grid",
              gridTemplateColumns: mobile
                ? "1fr"
                : "minmax(360px, 1.7fr) minmax(140px, 0.55fr) minmax(190px, 0.75fr)",
              gap: mobile ? 16 : 24,
              fontSize: 12,
              lineHeight: 1.5,
              fontFamily: "var(--font-mono)",
            }}>
              <div style={{ display: "flex", flexDirection: "column", gap: mobile ? 16 : 20 }}>
                {sessionInfoSection}
                {projectInfoSection}
              </div>
               {section(translate("session.messages"), messageRows)}
               {section(translate("session.tokens"), [...tokenRows, ...extraTokenRows], "right", true)}
            </div>
          );
        })() : (
          <div style={{ fontSize: 12, color: "var(--text-muted)", fontStyle: "italic" }}>
             {translate("session.load")}
          </div>
        )}
      </div>
  );
}
