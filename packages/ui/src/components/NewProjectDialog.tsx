"use client";

import { type CSSProperties, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { DirectoryPicker } from "./DirectoryPicker";
import { useI18n } from "../hooks/useI18n";
import { useWorkspaceApi } from "../lib/workspace-api";
import { errorText } from "@hepi/protocol/error-text";

/**
 * A project as the backend recorded it: its identity and name, the host its folders are on, and each folder with the
 * `/workspace/<id>` routing its conversations bind. Exactly one folder is the default, and that is the one a new
 * conversation starts in; the others are metadata and are never a tool root or an injected prompt.
 */
export interface CreatedProjectFolder {
  id: string;
  workspaceId: string;
  root: string;
  cwd: string;
  default: boolean;
}

export interface CreatedProject {
  id: string;
  name: string;
  hostId: string;
  defaultFolderId: string;
  folders: CreatedProjectFolder[];
  createdAt?: string;
}

/** The chosen target: the deployment's own stated host, or one configured remote profile. */
type ProjectTarget = { kind: "local" } | { kind: "remote"; gatewayId: string; profileId: string };

interface Props {
  onCancel: () => void;
  onCreated: (project: CreatedProject) => void;
}

const panelSurfaceStyle: CSSProperties = {
  overflow: "hidden",
  background: "var(--bg)",
  border: "1px solid var(--border)",
  borderRadius: 10,
  boxShadow: "0 8px 32px rgba(0,0,0,0.18)",
};

const textInputStyle: CSSProperties = {
  height: 36,
  padding: "0 10px",
  border: "1px solid var(--border)",
  borderRadius: 6,
  outline: "none",
  background: "var(--bg-panel)",
  color: "var(--text)",
  fontFamily: "var(--font-mono)",
  fontSize: 12,
};

const actionButtonStyle: CSSProperties = {
  padding: "6px 16px",
  borderRadius: 6,
  fontSize: 13,
};

const primaryActionStyle: CSSProperties = {
  ...actionButtonStyle,
  border: 0,
  background: "var(--accent)",
  color: "var(--accent-contrast)",
  fontWeight: 600,
};

const secondaryActionStyle: CSSProperties = {
  ...actionButtonStyle,
  border: "1px solid var(--border)",
  background: "none",
  color: "var(--text-muted)",
};

/**
 * Create Project: a display-only name and one or more existing folders on one execution host. Nothing here creates
 * or renames a directory — the folder picker only navigates, and the backend asks that host's gateway to validate and
 * register each chosen folder before any project is recorded.
 *
 * Which computer that is comes from the backend, not from this browser or the Web process: the panel names the
 * execution account the target host itself reports, and a deployment that has not named its Web host reports that
 * instead of silently offering another computer's directories. A configured remote host is offered explicitly as a
 * target, so a project on another computer is chosen rather than guessed.
 */
export function NewProjectDialog({ onCancel, onCreated }: Props) {
  const { t } = useI18n();
  // Every read and write here belongs to the connection: which computer a folder is chosen on comes from the
  // deployment's stated host or from a target the backend itself listed, never from the document's own origin.
  const workspaceApi = useWorkspaceApi();
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);
  const [name, setName] = useState("");
  // The folders chosen on this computer, in the order they were added. A recorded project holds several existing
  // folders and exactly one default; adding one the list already has is refused here, before the backend sees it.
  const [folders, setFolders] = useState<readonly string[]>([]);
  const [defaultFolder, setDefaultFolder] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [host, setHost] = useState<{ user: string; home: string } | null>(null);
  const [hostError, setHostError] = useState<string | null>(null);
  // The execution target the folders are chosen on: this Web origin's own host by default, or one of the configured
  // remote profiles. The account shown is always the one the target's host itself reports.
  const [target, setTarget] = useState<ProjectTarget>({ kind: "local" });
  const [remotes, setRemotes] = useState<readonly { gatewayId: string; profileId: string; host: string; user?: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => { setPortalTarget(document.body); }, []);

  useEffect(() => {
    let cancelled = false;
    // The configured execution targets. A gateway that serves remote profiles is offered beside the deployment's own
    // host; a listing that cannot be read leaves the local target, which is what a local deployment has.
    workspaceApi.hosts()
      .then((hosts) => {
        if (cancelled) return;
        setRemotes(hosts.flatMap(entry => (entry.profiles ?? []).map(profile => ({ gatewayId: entry.id, profileId: profile.id, host: profile.host, ...(profile.user === undefined ? {} : { user: profile.user }) }))));
      })
      .catch(() => { /* the local target stays */ });
    return () => { cancelled = true; };
  }, [workspaceApi]);

  useEffect(() => {
    let cancelled = false;
    setHost(null);
    setHostError(null);
    // One host's own listing names the account its tools run as, which is what the dialog shows. The target names a
    // remote computer; without one the deployment's stated host answers.
    workspaceApi.browse(target.kind === "remote" ? { hostId: target.gatewayId, profileId: target.profileId } : undefined)
      .then((data) => { if (!cancelled) setHost(data.host ?? null); })
      .catch((cause: unknown) => { if (!cancelled) setHostError(errorText(cause)); });
    return () => { cancelled = true; };
  }, [target, workspaceApi]);

  const chosenDefault = defaultFolder ?? folders[0] ?? null;
  const addFolder = (path: string) => {
    setPicking(false);
    setError(null);
    if (folders.includes(path)) { setError(t("newProject.folderAlreadyAdded")); return; }
    setFolders((current) => [...current, path]);
    setDefaultFolder((current) => current ?? path);
  };
  const removeFolder = (path: string) => {
    setFolders((current) => current.filter(item => item !== path));
    setDefaultFolder((current) => (current === path ? null : current));
  };
  const create = async () => {
    const projectName = name.trim();
    if (!projectName) { setError(t("newProject.nameRequired")); return; }
    if (folders.length === 0 || chosenDefault === null) { setError(t("newProject.folderRequired")); return; }
    setCreating(true);
    setError(null);
    try {
      const project = await workspaceApi.createProject({
        name: projectName,
        folders: folders.map(folder => ({ root: folder, default: folder === chosenDefault })),
        ...(target.kind === "remote" ? { target: { hostId: target.gatewayId, profileId: target.profileId } } : {}),
      });
      onCreated(project as CreatedProject);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setCreating(false);
    }
  };

  if (!portalTarget) return null;

  return createPortal(
    <div
      className="new-project-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={t("newProject.title")}
      onClick={(event) => { if (event.target === event.currentTarget && !creating) onCancel(); }}
      onKeyDown={(event) => { if (event.key === "Escape" && !creating) onCancel(); }}
      style={{ position: "fixed", inset: 0, zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.35)" }}
    >
      <div className="new-project-panel" style={{ ...panelSurfaceStyle, width: 480, maxWidth: "calc(100vw - 16px)", display: "flex", flexDirection: "column" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 18px", borderBottom: "1px solid var(--border)" }}>
          <div style={{ color: "var(--text)", fontWeight: 700, fontSize: 15 }}>{t("newProject.title")}</div>
          <button
            type="button"
            onClick={onCancel}
            disabled={creating}
            title={t("i18n.close")}
            aria-label={t("i18n.close")}
            style={{ padding: "2px 6px", border: 0, background: "none", color: "var(--text-muted)", fontSize: 20, lineHeight: 1, cursor: creating ? "default" : "pointer", opacity: creating ? 0.5 : 1 }}
          >
            ×
          </button>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 14, padding: "14px 18px" }}>
          <div>
            <label htmlFor="new-project-name" style={{ display: "block", marginBottom: 6, color: "var(--text-muted)", fontSize: 11 }}>{t("newProject.name")}</label>
            <input
              id="new-project-name"
              value={name}
              autoFocus
              autoComplete="off"
              spellCheck={false}
              placeholder={t("newProject.namePlaceholder")}
              disabled={creating}
              onChange={(event) => { setName(event.target.value); setError(null); }}
              className="new-project-name"
              style={{ ...textInputStyle, width: "100%", boxSizing: "border-box", fontFamily: "inherit" }}
            />
          </div>

          {remotes.length > 0 && (
            <div>
              <label htmlFor="new-project-target" style={{ display: "block", marginBottom: 6, color: "var(--text-muted)", fontSize: 11 }}>{t("newProject.target")}</label>
              <select
                id="new-project-target"
                className="new-project-target"
                disabled={creating}
                value={target.kind === "remote" ? target.gatewayId + "\u0000" + target.profileId : ""}
                onChange={(event) => {
                  const value = event.target.value;
                  if (value === "") { setTarget({ kind: "local" }); return; }
                  const [gatewayId, profileId] = value.split("\u0000");
                  if (gatewayId !== undefined && profileId !== undefined) setTarget({ kind: "remote", gatewayId, profileId });
                }}
                style={{ ...textInputStyle, width: "100%", boxSizing: "border-box", fontFamily: "inherit" }}
              >
                <option value="">{t("newProject.targetLocal")}</option>
                {remotes.map(remote => (
                  <option key={remote.gatewayId + "\u0000" + remote.profileId} value={remote.gatewayId + "\u0000" + remote.profileId}>
                    {t("newProject.targetRemote", { host: remote.host, profile: remote.profileId })}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div>
            <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 6 }}>
              <span style={{ color: "var(--text-muted)", fontSize: 11 }}>{t("newProject.folder")}</span>
              <span className="new-project-host" style={{ color: "var(--text-dim)", fontSize: 11 }}>
                {hostError ?? (host ? (target.kind === "remote" ? t("newProject.remoteHost", { user: host.user, home: host.home, profile: target.profileId }) : t("newProject.host", { user: host.user, home: host.home })) : t("newProject.checkingHost"))}
              </span>
            </div>
            <div className="new-project-folders" role="radiogroup" aria-label={t("newProject.folder")} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {folders.length === 0 && <span className="new-project-folder" style={{ padding: "8px 10px", border: "1px dashed var(--border)", borderRadius: 6, color: "var(--text-dim)", fontSize: 11 }}>{t("newProject.noFolder")}</span>}
              {folders.map((folder) => (
                <div key={folder} className="new-project-folder-row" style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <input
                    type="radio"
                    name="new-project-default-folder"
                    className="new-project-default"
                    aria-label={t("newProject.defaultFolder", { path: folder })}
                    checked={chosenDefault === folder}
                    disabled={creating}
                    onChange={() => { setDefaultFolder(folder); setError(null); }}
                  />
                  <span className="new-project-folder" title={folder} style={{ flex: 1, minWidth: 0, fontFamily: "var(--font-mono)", fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{folder}</span>
                  <button
                    className="new-project-remove-folder"
                    type="button"
                    onClick={() => removeFolder(folder)}
                    disabled={creating}
                    title={t("newProject.removeFolder")}
                    aria-label={t("newProject.removeFolderNamed", { path: folder })}
                    style={{ ...secondaryActionStyle, padding: "2px 8px", flexShrink: 0, cursor: creating ? "default" : "pointer" }}
                  >
                    ×
                  </button>
                </div>
              ))}
              <button
                className="new-project-add-folder"
                type="button"
                onClick={() => setPicking(true)}
                disabled={creating || host === null}
                style={{ ...secondaryActionStyle, alignSelf: "flex-start", opacity: creating || host === null ? 0.6 : 1, cursor: creating || host === null ? "default" : "pointer" }}
              >
                {t("newProject.addFolder")}
              </button>
              {folders.length > 1 && <span className="new-project-default-hint" style={{ color: "var(--text-dim)", fontSize: 11 }}>{t("newProject.defaultHint")}</span>}
            </div>
          </div>

          {error && <div className="new-project-error" style={{ color: "#dc2626", fontSize: 11, lineHeight: 1.35 }}>{error}</div>}
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, padding: "10px 18px", borderTop: "1px solid var(--border)" }}>
          <button className="new-project-cancel" type="button" onClick={onCancel} disabled={creating} style={{ ...secondaryActionStyle, cursor: creating ? "default" : "pointer" }}>{t("i18n.cancel")}</button>
          <button
            className="new-project-create"
            type="button"
            onClick={() => void create()}
            disabled={creating || host === null}
            style={{ ...primaryActionStyle, opacity: creating || host === null ? 0.6 : 1, cursor: creating || host === null ? "default" : "pointer" }}
          >
            {creating ? t("i18n.checking") : t("newProject.create")}
          </button>
        </div>
      </div>

      {picking && (
        <DirectoryPicker
          initialPath={folders[0]}
          target={target.kind === "remote" ? { hostId: target.gatewayId, profileId: target.profileId } : undefined}
          onCancel={() => setPicking(false)}
          onSelect={addFolder}
        />
      )}
    </div>,
    portalTarget,
  );
}
