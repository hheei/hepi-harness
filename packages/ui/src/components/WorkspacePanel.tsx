"use client";

import type { CSSProperties } from "react";
import { useI18n } from "../hooks/useI18n";
import type { ResizablePanel } from "../hooks/useResizablePanel";
import type { TerminalConnection } from "../lib/terminal-client";
import type { FanInSubscription } from "../lib/terminal-fan-in";
import type { TerminalFanIn } from "../lib/terminal-fan-in";
import { FileViewer } from "./FileViewer";
import { TabBar } from "./TabBar";
import { TerminalPanel } from "./TerminalPanel";
import {
  activeFilePanelTab,
  closePanelTab,
  panelTabs,
  restartTerminalTab,
  savePanelViewerState,
  terminalPanelClosed,
  terminalWorkspaceKnown,
  type PanelState,
} from "./panel-state";

const ICON_BUTTON_SIZE = 36;

interface Props {
  /** The tabs the panel holds and which one is on screen. The shell keeps it; this surface only reports transitions. */
  panel: PanelState;
  /** A transition of the panel, applied to the value it holds now — never to the one this render saw. */
  onChange: (transition: (state: PanelState) => PanelState) => void;
  open: boolean;
  /** Full width over the chat, which is what a reader expands a preview to. */
  fullWidth: boolean;
  onToggleFullWidth: () => void;
  onClose: () => void;
  /** The workspace the file panel reads: the folder in effect, and the path a reader is shown. */
  cwd: string | null;
  displayCwd: string | null;
  resizer: ResizablePanel;
  /** The page's one terminal stream, and the connection it presents. */
  terminalStream: ((tab: { id: string; cwd: string }, handlers: Parameters<TerminalFanIn["subscribe"]>[1]) => FanInSubscription) | null;
  terminalConnection: TerminalConnection;
  onMentionLines?: (relativePath: string, startLine: number, endLine: number) => void;
  onAtMention: (relativePath: string, isDir: boolean) => void;
  onOpenFile: (filePath: string, page?: number) => void;
}

/**
 * The panel beside the chat: the file and terminal tabs, and the one viewer on screen.
 *
 * It is one surface because it is one place: a file tab and a terminal tab share the bar, the resize handle and the
 * reader's attention, and only the active one is mounted — a file's lightweight state is restored when its tab is shown
 * again, while a terminal stays mounted for as long as its tab exists, because its shell is running.
 *
 * The panel owns no policy: every transition is a function of \`panel-state\` and is reported up as the next value, which is
 * what keeps the tab rules in one place instead of split between a close handler and a project-change cleanup.
 */
export function WorkspacePanel({
  panel, onChange, open, fullWidth, onToggleFullWidth, onClose, cwd, displayCwd, resizer,
  terminalStream, terminalConnection, onMentionLines, onAtMention, onOpenFile,
}: Props) {
  const { t } = useI18n();
  const fileTab = activeFilePanelTab(panel);
  const terminalShowing = panel.terminalTabs.some((tab) => tab.id === panel.activeTabId);

  return (
    <>
      <div
        aria-hidden="true"
        className={`right-panel-overlay-backdrop${open ? " is-open" : ""}`}
        onClick={onClose}
      />
      {open && (
        <div
          {...resizer.separatorProps}
          inert={fullWidth}
          aria-controls="file-panel"
          className={`panel-resize-handle right-panel-resize-handle${resizer.isResizing ? " is-resizing" : ""}`}
          data-resize-handle="right-panel"
          title={`${t("layout.resizeFilePanel")}: ${t("layout.resizeHint")}`}
        />
      )}
      {/* Always mounted, width animated via CSS: the tabs a reader had stay where they left them. */}
      <div
        ref={resizer.panelRef}
        id="file-panel"
        className={`right-panel-container${open ? " right-panel-open" : " right-panel-closed"}${fullWidth ? " right-panel-full-width" : ""}${resizer.isResizing ? " right-panel-resizing" : ""}`}
        style={{
          "--right-panel-width": `${resizer.width}px`,
          display: "flex",
          flexDirection: "column",
          borderLeft: "1px solid var(--border)",
          background: "var(--bg)",
        } as CSSProperties}
      >
        <div style={{
          display: "flex",
          alignItems: "center",
          flexShrink: 0,
          height: "calc(36px + env(safe-area-inset-top))",
          paddingTop: "env(safe-area-inset-top)",
          background: "var(--bg-panel)",
          borderBottom: "1px solid var(--border)",
        }}>
          <div style={{ flex: 1, overflow: "hidden" }}>
            <TabBar
              tabs={panelTabs(panel)}
              activeTabId={panel.activeTabId ?? ""}
              onSelectTab={(tabId) => onChange((state) => ({ ...state, activeTabId: tabId }))}
              onCloseTab={(tabId) => onChange((state) => closePanelTab(state, tabId).state)}
            />
          </div>
          <button
            type="button"
            className="file-panel-expand-button"
            onClick={onToggleFullWidth}
            aria-controls="file-panel"
            aria-pressed={fullWidth}
            title={t(fullWidth ? "files.restorePanelWidth" : "files.expandPanel")}
            aria-label={t(fullWidth ? "files.restorePanelWidth" : "files.expandPanel")}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d={fullWidth
                ? "M9 3v6H3m12-6v6h6M9 21v-6H3m12 6v-6h6M3 3l6 6m12-6-6 6M3 21l6-6m12 6-6-6"
                : "M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5M3 3l6 6m12-6-6 6M3 21l6-6m12 6-6-6"} />
            </svg>
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-controls="file-panel"
            aria-expanded={open}
            title={t("files.hidePanel")}
            aria-label={t("files.hidePanel")}
            style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              width: ICON_BUTTON_SIZE, height: ICON_BUTTON_SIZE, padding: 0,
              background: "var(--bg-selected)", border: "none", borderLeft: "1px solid var(--border)",
              color: "var(--text)", cursor: "pointer", flexShrink: 0, transition: "color 0.12s",
            }}
            onMouseEnter={(event) => { event.currentTarget.style.color = "var(--accent)"; }}
            onMouseLeave={(event) => { event.currentTarget.style.color = "var(--text)"; }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="3" y="3" width="18" height="18" rx="2" /><line x1="15" y1="3" x2="15" y2="21" />
            </svg>
          </button>
        </div>

        {/* Only the active viewer is mounted. Lightweight per-tab state is restored on activation. */}
        <div style={{ flex: 1, minHeight: 0, overflow: "hidden", paddingBottom: "env(safe-area-inset-bottom)" }}>
          {fileTab?.filePath ? (
            <FileViewer
              key={`${fileTab.id}:${fileTab.viewerRevision ?? 0}`}
              filePath={fileTab.filePath}
              cwd={cwd ?? undefined}
              displayCwd={displayCwd}
              onClose={() => onChange((state) => closePanelTab(state, fileTab.id).state)}
              initialDisplayMode={fileTab.initialDisplayMode}
              initialPage={fileTab.page}
              initialState={fileTab.viewerState}
              onStateChange={(viewerState) => onChange((state) => savePanelViewerState(state, fileTab.id, fileTab.viewerRevision ?? 0, viewerState))}
              onMentionLines={open ? onMentionLines : undefined}
              onAtMention={onAtMention}
              onOpenFile={onOpenFile}
            />
          ) : !terminalShowing ? (
            <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-dim)", fontSize: 12 }}>
              {t("files.noneOpen")}
            </div>
          ) : null}
          {panel.terminalTabs.map((tab) => (
            <div key={tab.id} hidden={tab.id !== panel.activeTabId} style={{ width: "100%", height: "100%" }}>
              <TerminalPanel
                tab={tab}
                displayCwd={tab.displayCwd ?? displayCwd}
                active={open && tab.id === panel.activeTabId}
                stream={terminalStream}
                connection={terminalConnection}
                onRestart={() => onChange((state) => restartTerminalTab(state, tab.id))}
                onClosed={() => onChange((state) => terminalPanelClosed(state, tab.id, tab.closing === "restart" ? "restart" : "close").state)}
                onCwdKnown={(known) => onChange((state) => terminalWorkspaceKnown(state, tab.id, known))}
              />
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
