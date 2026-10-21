import { buildAtMentionText } from "./file-fuzzy";

/**
 * How a chat drop becomes text and files, with no address of its own.
 *
 * The upload itself is not here. It is one file answer among many, so it belongs to the file seam that resolves the
 * connection's origin and credential — see `file-seam.ts`, which owns the form, the progress a browser reports and the
 * batch the surface enforces. What stays here is what a drop *means*: which items are images, which are files, and the
 * `@` mentions they become.
 */

/** One file or folder dropped onto the chat. */
export type DroppedItem = { kind: "file"; file: File } | { kind: "folder"; name: string };

/**
 * Sorts a chat drop: images are attached to the prompt as before, other files
 * are uploaded into the working directory and mentioned, and folders are left
 * out because the upload surface takes files only.
 * @param items The dropped items, in drop order
 * @returns The images, the files to upload, and the names of skipped folders
 */
export function splitDroppedItems(items: DroppedItem[]): { images: File[]; files: File[]; folders: string[] } {
  const images: File[] = [];
  const files: File[] = [];
  const folders: string[] = [];
  for (const item of items) {
    if (item.kind === "folder") folders.push(item.name);
    else if (item.file.type.startsWith("image/")) images.push(item.file);
    else files.push(item.file);
  }
  return { images, files, folders };
}

/**
 * The `@` mentions for files now in the working directory, in drop order.
 * @param files The dropped files
 * @param present Names the upload reports as written or already there
 * @returns Mentions ready to insert, or an empty string
 */
export function dropMentionText(files: File[], present: string[]): string {
  const names = new Set(present);
  return files
    .filter((file) => names.has(file.name))
    .map((file) => buildAtMentionText(file.name, false))
    .join("");
}
