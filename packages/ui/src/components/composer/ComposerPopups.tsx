/**
 * The three popups the composer opens above the textarea: the input history, the `/` palette and the `@` file list.
 *
 * They are drawn from one projection the menu hook produces, so the keyboard's highlighted index and the row that shows
 * as active are the same number rather than two decisions that have to agree. Nothing here reads the draft, the session
 * or the connection: a popup states rows and reports the one the user picked.
 */
import React from "react";
import { FolderIcon, getFileIcon } from "../FileIcons";
import { useI18n } from "../../hooks/useI18n";
import { getSlashDescription, isDormantSkillCommand, SLASH_SOURCE_GROUP_LABEL_KEYS, type SlashCommandPaletteItem } from "./commands";
import type { ComposerMenus } from "./useComposerMenus";

const POPUP_STYLE: React.CSSProperties = {
  position: "absolute",
  left: 0,
  right: 0,
  bottom: "calc(100% + 8px)",
  zIndex: 120,
  background: "var(--bg)",
  border: "1px solid var(--border)",
  borderRadius: 8,
  boxShadow: "0 -6px 20px rgba(0,0,0,0.12)",
  overflow: "hidden",
};

const POPUP_HEADER_STYLE: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 8,
  padding: "8px 10px",
  borderBottom: "1px solid var(--border)",
  fontSize: 11,
  color: "var(--text-dim)",
  flexShrink: 0,
};

/** The input history: what this conversation was already asked, recalled into the draft. */
function HistoryPopup({ menus }: { menus: ComposerMenus }) {
  const { t } = useI18n();
  return (
    <div
      ref={menus.historyMenuRef}
      style={{ ...POPUP_STYLE, maxHeight: "min(44vh, 360px)" }}
    >
      <div title={t("chat.inputHistory")} style={{ ...POPUP_HEADER_STYLE, height: 30, padding: "0 10px" }}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M3 12a9 9 0 1 0 3-6.7" />
          <path d="M3 4v5h5" />
          <path d="M12 7v5l3 2" />
        </svg>
      </div>
      <div style={{ maxHeight: "calc(min(44vh, 360px) - 31px)", overflowY: "auto", padding: 4 }}>
        {menus.historyItems.map((item, index) => {
          const active = index === menus.historyActiveIndex;
          return (
            <button
              key={`${index}:${item}`}
              ref={(node) => { menus.historyItemRefs.current[index] = node; }}
              type="button"
              onMouseDown={(event) => {
                event.preventDefault();
                menus.applyHistoryInput(item);
              }}
              onMouseEnter={() => menus.setHistoryActiveIndex(index)}
              style={{
                width: "100%", display: "flex", alignItems: "flex-start", gap: 8, padding: "7px 8px",
                border: "none", borderRadius: 6, background: active ? "var(--bg-selected)" : "none",
                color: "var(--text)", cursor: "pointer", textAlign: "left", fontSize: 12.5, lineHeight: 1.45,
              }}
            >
              <span style={{ flexShrink: 0, fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-dim)", paddingTop: 1 }}>
                {index + 1}
              </span>
              <span style={{ minWidth: 0, display: "-webkit-box", WebkitBoxOrient: "vertical", WebkitLineClamp: 2, overflow: "hidden", overflowWrap: "anywhere" }}>
                {item}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

const SLASH_POPUP_HEADER_STYLE: React.CSSProperties = {
  ...POPUP_HEADER_STYLE,
};

/** The `/` palette: this deployment's built-in, every extension/prompt/skill command, grouped by where it came from. */
function SlashPopup({ menus, loading }: { menus: ComposerMenus; loading: boolean }) {
  const { t } = useI18n();
  const label = menus.slashMatches.length === 1
    ? t(menus.slashQuery ? "chat.match" : "chat.command")
    : t(menus.slashQuery ? "chat.matches" : "chat.commands", { count: menus.slashMatches.length });
  return (
    <div
      ref={menus.slashMenuRef}
      style={{
        ...POPUP_STYLE,
        boxSizing: "border-box",
        display: "flex",
        flexDirection: "column",
        maxHeight: menus.slashMenuMaxHeight === null
          ? "min(72.8vh, 598px)"
          : `min(72.8vh, 598px, ${menus.slashMenuMaxHeight}px)`,
      }}
    >
      <div style={SLASH_POPUP_HEADER_STYLE}>
        <span>{loading ? t("chat.loadingCommands") : t("chat.slashCommands", { label })}</span>
        <span style={{ fontFamily: "var(--font-mono)" }}>{t("chat.tabEnter")}</span>
      </div>
      <div style={{ flex: "1 1 auto", minHeight: 0, overflowY: "auto", padding: 10 }}>
        {!loading && menus.slashMatches.length === 0 ? (
          <div style={{ padding: "2px 2px 4px", fontSize: 12, color: "var(--text-dim)" }}>{t("chat.noCommands")}</div>
        ) : (
          menus.groupedSlashCommands.map((group) => (
            <section key={group.source} style={{ marginBottom: 12 }}>
              <div style={{
                position: "sticky", top: -10, zIndex: 1, display: "flex", alignItems: "center",
                justifyContent: "space-between", gap: 8, padding: "4px 0 6px", background: "var(--bg)",
                color: "var(--text-dim)", fontSize: 10, fontWeight: 600, textTransform: "uppercase",
              }}>
                <span>{t(SLASH_SOURCE_GROUP_LABEL_KEYS[group.source])}</span>
                <span style={{ fontFamily: "var(--font-mono)", fontWeight: 500 }}>{group.items.length}</span>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 8 }}>
                {group.items.map(({ command, index }) => {
                  const active = index === menus.slashActiveIndex;
                  const dormant = isDormantSkillCommand(command, menus.skillDormancy);
                  return (
                    <button
                      key={`${command.source}:${command.name}`}
                      ref={(node) => { menus.slashItemRefs.current[index] = node; }}
                      type="button"
                      onMouseDown={(event) => {
                        event.preventDefault();
                        menus.completeSlashCommand(command);
                      }}
                      onMouseEnter={() => menus.setSlashActiveIndex(index)}
                      style={{
                        width: "100%", minWidth: 0, minHeight: 58, display: "flex", flexDirection: "column",
                        gap: 4, justifyContent: "center", padding: "9px 10px",
                        border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
                        borderRadius: 7, background: active ? "var(--bg-selected)" : "var(--bg-panel)",
                        color: "var(--text)", cursor: "pointer", textAlign: "left",
                        boxShadow: active ? "0 0 0 1px color-mix(in srgb, var(--accent) 28%, transparent)" : "none",
                      }}
                    >
                      <span style={{
                        fontSize: 13, fontFamily: "var(--font-mono)", overflowWrap: "anywhere", wordBreak: "break-word",
                        color: dormant ? "var(--text-dim)" : undefined,
                      }}>
                        /{command.name}
                        {dormant && (
                          <span style={{
                            marginLeft: 6, padding: "0 4px", border: "1px solid var(--border)", borderRadius: 3,
                            fontSize: 9, color: "var(--text-dim)", whiteSpace: "nowrap",
                          }}>
                            {t("chat.dormant")}
                          </span>
                        )}
                      </span>
                      {command.description && (
                        <span style={{
                          display: "-webkit-box", WebkitBoxOrient: "vertical", WebkitLineClamp: 2,
                          overflow: "hidden", fontSize: 11, lineHeight: 1.35, color: "var(--text-dim)",
                        }}>
                          {getSlashDescription(command, t)}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </section>
          ))
        )}
      </div>
    </div>
  );
}

/** The `@` file list: the workspace's own index, with a server-ranked answer replacing the local one when truncated. */
function FilePopup({ menus }: { menus: ComposerMenus }) {
  const { t } = useI18n();
  const query = menus.atQuery?.query ?? "";
  // With a truncated index, local results are provisional — the debounced server search over the full listing replaces
  // them.
  const truncatedHint = menus.atTruncated && !menus.atServerResultActive
    ? (query ? t("chat.searchingAll") : t("chat.indexTruncated"))
    : "";
  const matchLabel = menus.atMatches.length === 1 ? t("chat.match") : t("chat.matches", { count: menus.atMatches.length });
  return (
    <div
      ref={menus.atMenuRef}
      style={{
        ...POPUP_STYLE,
        boxSizing: "border-box",
        display: "flex",
        flexDirection: "column",
        maxHeight: menus.atMenuMaxHeight === null
          ? "min(48vh, 400px)"
          : `min(48vh, 400px, ${menus.atMenuMaxHeight}px)`,
      }}
    >
      <div style={POPUP_HEADER_STYLE}>
        <span>{menus.atIndexLoading ? t("chat.loadingFiles") : t("chat.files", { label: matchLabel, hint: truncatedHint })}</span>
        <span style={{ fontFamily: "var(--font-mono)" }}>{t("chat.tabEnter")}</span>
      </div>
      <div style={{ flex: "1 1 auto", minHeight: 0, overflowY: "auto", padding: 4 }}>
        {!menus.atIndexLoading && menus.atMatches.length === 0 ? (
          <div style={{ padding: "6px 8px", fontSize: 12, color: "var(--text-dim)" }}>
            {menus.atServerSearchPending ? t("chat.searching") : t("chat.noMatchingFiles")}
          </div>
        ) : (
          menus.atMatches.map((entry, index) => {
            const active = index === menus.atActiveIndex;
            const name = entry.path.split("/").pop() ?? entry.path;
            const dirPrefix = entry.path.slice(0, entry.path.length - name.length);
            return (
              <button
                key={`${entry.isDir ? "d" : "f"}:${entry.path}`}
                ref={(node) => { menus.atItemRefs.current[index] = node; }}
                type="button"
                onMouseDown={(event) => {
                  event.preventDefault();
                  menus.completeFile(entry);
                }}
                onMouseEnter={() => menus.setAtActiveIndex(index)}
                style={{
                  width: "100%", display: "flex", alignItems: "center", gap: 8, padding: "6px 8px",
                  border: "none", borderRadius: 6, background: active ? "var(--bg-selected)" : "none",
                  color: "var(--text)", cursor: "pointer", textAlign: "left", fontSize: 12.5,
                  fontFamily: "var(--font-mono)",
                }}
              >
                <span style={{ flexShrink: 0, display: "flex", alignItems: "center" }}>
                  {entry.isDir ? <FolderIcon size={14} /> : getFileIcon(name, 14)}
                </span>
                <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {dirPrefix && <span style={{ color: "var(--text-dim)" }}>{dirPrefix}</span>}
                  {name}
                  {entry.isDir && <span style={{ color: "var(--text-dim)" }}>/</span>}
                </span>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}

/** Whichever popup is open, in the order the composer opens them. */
export function ComposerPopups({ menus, slashCommandsLoading }: { menus: ComposerMenus; slashCommandsLoading: boolean }) {
  return (
    <>
      {menus.historyMenuOpen && menus.historyItems.length > 0 && <HistoryPopup menus={menus} />}
      {menus.slashMenuOpen && menus.slashQuery !== null && <SlashPopup menus={menus} loading={slashCommandsLoading} />}
      {menus.atMenuOpen && menus.atQuery !== null && <FilePopup menus={menus} />}
    </>
  );
}
