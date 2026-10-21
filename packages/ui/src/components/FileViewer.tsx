"use client";

import {
  isAudioPath,
  isDocumentPreviewPath,
  isImagePath,
  isVideoPath,
} from "@hepi/protocol/files";
import { ImageFilePreview } from "./ImageFilePreview";
import { MediaFilePreview } from "./MediaFilePreview";
import { DocumentFilePreview } from "./DocumentFilePreview";
import { TextFilePreview, type TextFilePreviewProps } from "./TextFilePreview";
import type { FileViewerState } from "../lib/file/file-viewer-state";

export type { FileViewerState } from "../lib/file/file-viewer-state";

interface Props extends TextFilePreviewProps {
  /** PDF page to open on first render (`#page=N` from a markdown link). */
  initialPage?: number;
}

/**
 * One file of the workspace, shown by whichever preview owns its format.
 *
 * A file's format is decided once, here: an image, a recording, a document and a text file each answer a different
 * question about the same workspace — one read of bytes, one framed document, one bounded chunk with its Git patch — so
 * each is its own leaf and this component is only the choice between them. What the leaves share is the seam they read
 * through, and none of them assembles a file address or opens a watcher of its own.
 */
export function FileViewer({ filePath, cwd, displayCwd, initialPage, ...text }: Props) {
  if (isImagePath(filePath)) {
    return <ImageFilePreview filePath={filePath} cwd={cwd} displayCwd={displayCwd} />;
  }
  if (isAudioPath(filePath)) {
    return <MediaFilePreview filePath={filePath} cwd={cwd} displayCwd={displayCwd} kind="audio" />;
  }
  if (isVideoPath(filePath)) {
    return <MediaFilePreview filePath={filePath} cwd={cwd} displayCwd={displayCwd} kind="video" />;
  }
  if (isDocumentPreviewPath(filePath)) {
    return <DocumentFilePreview filePath={filePath} cwd={cwd} displayCwd={displayCwd} initialPage={initialPage} />;
  }
  return <TextFilePreview filePath={filePath} cwd={cwd} displayCwd={displayCwd} {...text} />;
}
