"use client";

import { useI18n } from "../hooks/useI18n";
import { projectFolderRows } from "../lib/project-removal";
import type { ProjectRouting } from "../lib/project-routing";
import { TrashIcon } from "./SidebarIcons";

/**
 * Removing a Project, and unlinking one of its folders, as the Project's own menu asks for them.
 *
 * Three steps in one body: the folder list, the confirmation for a Project's removal, and the confirmation for one
 * folder's unlink — which asks for the replacement default first when the folder being unlinked is the default one and
 * the Project keeps another folder. Every step names what is removed (hepi's own metadata) and what is not (the
 * directory on disk, the conversations), before anything is sent; a refusal leaves the step where it was and shows the
 * reason the backend gave. The request itself belongs to the owner, which holds the project list this answer changes.
 */

/** Which step of a removal the menu's body is showing. */
export type ProjectRemovalStep =
  | { kind: "folders" }
  | { kind: "remove-project" }
  /** One folder's unlink, and the replacement default chosen for it, if any. */
  | { kind: "unlink"; folderId: string; replacementFolderId: string | null };

/** The body's own state: the step, a request in flight, and the reason the last one was refused. */
export interface ProjectRemovalBody {
  step: ProjectRemovalStep;
  busy: boolean;
  error: string | null;
}

export interface ProjectRemovalMenuProps {
  project: ProjectRouting;
  body: ProjectRemovalBody;
  /** Shown above the body; false on a phone, where the sheet's own title carries it. */
  heading?: boolean;
  onStep: (step: ProjectRemovalStep) => void;
  /** The confirmed unlink: the folder, and the replacement default when the step chose one. */
  onUnlink: (folderId: string, replacementFolderId?: string) => void;
  onRemoveProject: () => void;
  /** Leaves the body: back to the folder list from a confirmation, out of the menu from the list. */
  onCancel: () => void;
}

export function ProjectRemovalMenu({
  project,
  body,
  heading = true,
  onStep,
  onUnlink,
  onRemoveProject,
  onCancel,
}: ProjectRemovalMenuProps) {
  const { t } = useI18n();
  const rows = projectFolderRows(project);
  const step = body.step;
  const folder = step.kind === "unlink" ? rows.find(row => row.id === step.folderId) : undefined;
  // A confirmation is a question about the folder list it came from: its Cancel goes back there.
  const back = step.kind === "folders" ? onCancel : () => onStep({ kind: "folders" });
  const headingText = step.kind === "folders"
    ? t("sidebar.projectFoldersHeading", { name: project.name })
    : step.kind === "remove-project"
      ? t("sidebar.removeProjectHeading", { name: project.name })
      : t("sidebar.unlinkFolderHeading", { path: folder?.root ?? "" });
  return (
    <div className="project-removal">
      {heading && <div className="sidebar-menu-header">{headingText}</div>}
      {step.kind === "folders" ? (
        <ul className="project-removal-folders">
          {rows.map(row => (
            <li key={row.id} className="project-removal-folder">
              <span className="project-removal-path" title={row.root}>{row.root}</span>
              {row.default && <span className="project-removal-note">{t("sidebar.defaultFolder")}</span>}
              <button
                type="button"
                className="project-removal-unlink"
                aria-label={t("sidebar.unlinkFolder", { path: row.root })}
                title={t("sidebar.unlinkFolder", { path: row.root })}
                disabled={body.busy}
                onClick={() => onStep({ kind: "unlink", folderId: row.id, replacementFolderId: null })}
              >
                <TrashIcon size={12} />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <>
          {/* What the action removes and what it leaves alone, said before it is taken. */}
          <div className="project-removal-message">{t("sidebar.removalMetadataOnly")}</div>
          {step.kind === "remove-project" && <div className="project-removal-message">{t("sidebar.removalConversationsKept")}</div>}
          {folder?.removesProject && <div className="project-removal-message">{t("sidebar.removalLastFolder")}</div>}
          {step.kind === "unlink" && folder?.needsReplacement && (
            <div className="project-removal-replacement" role="radiogroup" aria-label={t("sidebar.replacementDefault")}>
              <div className="project-removal-replacement-label">{t("sidebar.replacementDefault")}</div>
              {rows.filter(row => row.id !== step.folderId).map(row => (
                <button
                  key={row.id}
                  type="button"
                  role="radio"
                  aria-checked={step.replacementFolderId === row.id}
                  className={step.replacementFolderId === row.id ? "project-removal-choice is-chosen" : "project-removal-choice"}
                  title={row.root}
                  disabled={body.busy}
                  onClick={() => onStep({ ...step, replacementFolderId: row.id })}
                >
                  {row.root}
                </button>
              ))}
            </div>
          )}
        </>
      )}
      <div className="project-removal-buttons">
        {step.kind === "folders" ? (
          <button type="button" className="project-removal-remove-project" disabled={body.busy} onClick={onRemoveProject}>
            {t("sidebar.removeProject")}…
          </button>
        ) : (
          <button
            type="button"
            className="project-removal-confirm"
            disabled={body.busy || (folder?.needsReplacement === true && step.kind === "unlink" && step.replacementFolderId === null)}
            onClick={() => {
              if (step.kind === "remove-project") { onRemoveProject(); return; }
              if (step.kind === "unlink") onUnlink(step.folderId, step.replacementFolderId ?? undefined);
            }}
          >
            {step.kind === "remove-project" ? t("sidebar.removeProject") : t("sidebar.unlink")}
          </button>
        )}
        <button type="button" className="project-removal-cancel" data-sidebar-menu-autofocus="" onClick={back}>
          {t("sidebar.cancel")}
        </button>
      </div>
      {body.error && <div className="project-removal-error" role="alert">{body.error}</div>}
    </div>
  );
}
