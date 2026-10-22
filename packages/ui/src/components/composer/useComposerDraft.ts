/**
 * The composer's live draft: the text on screen, its pictures, and the one path each takes to and from the connection's
 * draft store.
 *
 * The rule this module exists for is that a draft is written **once, from one place**. Before, a rekey, a restored
 * submission, a promotion and the per-keystroke save each wrote the store from their own callback, and every one of them
 * had to remember which of the others might run first. Here the live value is the draft's only authority: the save
 * effect writes it, the imperative operations replace it and let the same effect persist the result, and nothing else
 * writes at all.
 *
 * Adoption is the one exception, and it is deliberately not a write: a composer that has not read its stored draft yet
 * holds an empty value that is not the user's text, so it must adopt before it may save. `adoptedKey` is state, not a
 * ref, so the save effect is rebuilt exactly once the draft it is about to save has been read.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  mergeRestoredSubmissionDraft,
  mergeRestoredSubmissionText,
  type ChatDraftImage,
  type DraftStore,
} from "../../lib/draft-store";
import { MAX_ATTACHED_IMAGES, selectImageFiles, type ImageFileRejection } from "../../lib/image-attachments";
import {
  compressImageFile,
  draftImagesToAttachedImages,
  imageToDraftImage,
  revokeImagePreview,
  type AttachedImage,
} from "./attachments";
import { replaceTextareaRange } from "./editor-text";

/** The imperative operations a surrounding surface performs on the textarea. */
export interface ComposerEditorHandle {
  insertText: (text: string) => void;
  insertIfEmpty: (text: string) => void;
  prependText: (text: string) => void;
  addImages: (files: File[]) => void;
  rekeyDraft: (previousKey: string, nextKey: string) => void;
  restoreSubmission: (text: string, images?: ChatDraftImage[], targetDraftKey?: string) => void;
}

export interface ComposerDraftState {
  /** The text exactly as typed. */
  value: string;
  /** The same value, readable at the moment a dispatch or a rekey happens. */
  valueRef: { current: string };
  images: AttachedImage[];
  imagesRef: { current: AttachedImage[] };
  textareaRef: { current: HTMLTextAreaElement | null };
  /** The key whose stored draft this composer has adopted, or `undefined` before it has read one. */
  adoptedDraftKey: string | undefined;
  /** The browser's own reason for refusing to keep this draft, stated while the draft is on screen. */
  storageIssue: string | null;
  dismissStorageIssue(): void;
  /** The imperative operations, for the surface that holds the ref and for the menus that complete into it. */
  handle: ComposerEditorHandle;
  setValue(next: string): void;
  /** Replace the draft from a non-typing source (a recalled queue, a built-in's own text), resetting the menus. */
  replaceValue(next: string, options?: { focus?: boolean; selectEnd?: boolean }): void;
  addImages(files: File[]): void;
  removeImage(index: number): void;
  clearInput(): void;
  /** Grow the textarea to its content, up to the composer's own cap. */
  resize(): void;
}

export interface ComposerDraftOptions {
  drafts: DraftStore;
  draftKey: string | undefined;
  /** The pictures this surface can attach: a compact quote box carries none. */
  attachmentsEnabled: boolean;
  /** What the textarea's measured height depends on besides its text: a font change re-measures it. */
  measureKey: string;
  /** Where the surface keeps the imperative handle: the same object {@link ComposerDraftState.handle} returns. */
  handleRef?: { current: ComposerEditorHandle | null };
  /** Reports a paste of pictures; the surface states refusals. */
  onImageRejections?(rejections: readonly ImageFileRejection[]): void;
  /** Every menu closes when the draft is replaced from outside the textarea. */
  onDraftReplaced?(): void;
  pendingImages: { current: number };
}

const TEXTAREA_MAX_HEIGHT = 200;

export function useComposerDraft(options: ComposerDraftOptions): ComposerDraftState {
  const { drafts, draftKey, attachmentsEnabled, measureKey, pendingImages, onImageRejections, handleRef } = options;
  // The composer starts empty and adopts its draft in a layout effect below, before the first paint. Reading the
  // stored draft during the first render would make the client tree differ from the server HTML the tab hydrated,
  // because the store this draft now lives in does not exist on the server.
  const [value, setValueState] = useState("");
  const [images, setImages] = useState<AttachedImage[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const valueRef = useRef(value);
  const imagesRef = useRef(images);
  const draftKeyRef = useRef(draftKey);
  /** Whether this composer has read its stored draft once; a first mount adopts before it may write anything back. */
  const adoptedDraftRef = useRef(false);
  /**
   * The key whose stored draft this composer has put on screen. Nothing is written back before it matches: the first
   * commit's live value is empty, and saving it would replace the very draft being restored. It is state rather than a
   * ref, so the persistence effect is rebuilt once the draft has been adopted.
   */
  const [adoptedDraftKey, setAdoptedDraftKey] = useState<string | undefined>(undefined);
  const [storageIssue, setStorageIssue] = useState<string | null>(null);
  const { onDraftReplaced } = options;

  valueRef.current = value;
  imagesRef.current = images;

  const resize = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    if (ta.value) ta.style.height = `${Math.min(ta.scrollHeight, TEXTAREA_MAX_HEIGHT)}px`;
  }, []);

  const setValue = useCallback((next: string) => {
    valueRef.current = next;
    setValueState(next);
  }, []);

  const adoptImages = useCallback((next: AttachedImage[]) => {
    imagesRef.current = next;
    setImages((previous) => {
      previous.forEach(revokeImagePreview);
      return next;
    });
  }, []);

  const replaceValue = useCallback((next: string, focusOptions?: { focus?: boolean; selectEnd?: boolean }) => {
    setValue(next);
    onDraftReplaced?.();
    if (!focusOptions) {
      requestAnimationFrame(resize);
      return;
    }
    requestAnimationFrame(() => {
      const ta = textareaRef.current;
      if (!ta) return;
      if (focusOptions.focus !== false) ta.focus();
      if (focusOptions.selectEnd) ta.setSelectionRange(next.length, next.length);
      resize();
    });
  }, [onDraftReplaced, resize, setValue]);

  const processImageFiles = useCallback(async (files: File[]) => {
    if (!attachmentsEnabled) return;
    const remaining = Math.max(0, MAX_ATTACHED_IMAGES - imagesRef.current.length - pendingImages.current);
    // Every refused file is named to the user; an unsupported type, an oversized image and a full attachment list are
    // three different problems and none of them may disappear silently.
    const { accepted: imageFiles, rejected } = selectImageFiles(files, remaining);
    onImageRejections?.(rejected);
    if (!imageFiles.length) return;
    pendingImages.current += imageFiles.length;
    try {
      const added = await Promise.all(imageFiles.map(async (file) => ({
        ...await compressImageFile(file),
        previewUrl: URL.createObjectURL(file),
      })));
      const accepted = added.slice(0, Math.max(0, MAX_ATTACHED_IMAGES - imagesRef.current.length));
      added.slice(accepted.length).forEach(revokeImagePreview);
      if (accepted.length === 0) return;
      const next = [...imagesRef.current, ...accepted];
      imagesRef.current = next;
      setImages(next);
    } finally {
      pendingImages.current -= imageFiles.length;
    }
  }, [attachmentsEnabled, onImageRejections, pendingImages]);

  const addImages = useCallback((files: File[]) => { void processImageFiles(files); }, [processImageFiles]);

  const removeImage = useCallback((index: number) => {
    const next = [...imagesRef.current];
    const [removed] = next.splice(index, 1);
    if (removed) revokeImagePreview(removed);
    imagesRef.current = next;
    setImages(next);
  }, []);

  const clearInput = useCallback(() => {
    valueRef.current = "";
    setValueState("");
    onDraftReplaced?.();
    if (draftKey) drafts.clearDraft(draftKey);
    if (draftKeyRef.current && draftKeyRef.current !== draftKey) drafts.clearDraft(draftKeyRef.current);
    imagesRef.current.forEach(revokeImagePreview);
    imagesRef.current = [];
    setImages((previous) => {
      previous.forEach(revokeImagePreview);
      return [];
    });
    if (textareaRef.current) textareaRef.current.style.height = "auto";
  }, [draftKey, drafts, onDraftReplaced]);

  // ── draft persistence ────────────────────────────────────────────────────
  // One write, from the live value. A composer that has not adopted its stored draft yet owns no draft to save: the
  // empty live value it is holding is not the user's text, and writing it first would replace the draft it is about to
  // read.
  useEffect(() => {
    if (!draftKey || adoptedDraftKey !== draftKey) return;
    drafts.setDraft(draftKey, { value, images: images.map(imageToDraftImage) });
  }, [adoptedDraftKey, drafts, draftKey, images, value]);

  useEffect(() => {
    if (!draftKey) {
      setStorageIssue(null);
      return undefined;
    }
    const read = () => setStorageIssue(drafts.getDraftStorageIssue(draftKey));
    read();
    return drafts.subscribeDraftStorageIssue(read);
  }, [draftKey, drafts]);

  useLayoutEffect(() => {
    const previousDraftKey = draftKeyRef.current;
    const first = !adoptedDraftRef.current;
    if (!first && previousDraftKey === draftKey) return;
    // The first run adopts; it must not write back first, because this composer has not read its draft yet and the
    // empty live value it is holding would replace the very text and images being restored.
    if (!first && previousDraftKey) {
      drafts.setDraft(previousDraftKey, {
        value: valueRef.current,
        images: imagesRef.current.map(imageToDraftImage),
      });
    }
    adoptedDraftRef.current = true;
    setAdoptedDraftKey(draftKey);

    const stored = draftKey ? drafts.getDraft(draftKey) : null;
    draftKeyRef.current = draftKey;
    const nextValue = stored?.value ?? "";
    const nextImages = draftImagesToAttachedImages(stored?.images);
    valueRef.current = nextValue;
    imagesRef.current = nextImages;
    setValueState(nextValue);
    onDraftReplaced?.();
    setImages((previous) => {
      previous.forEach(revokeImagePreview);
      return nextImages;
    });
  }, [draftKey, drafts, onDraftReplaced]);

  useLayoutEffect(resize, [measureKey, resize, value]);

  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    let previousWidth = -1;
    const observer = new ResizeObserver(([entry]) => {
      // Height updates also notify the observer; only remeasure on width changes.
      if (entry.contentRect.width === previousWidth) return;
      previousWidth = entry.contentRect.width;
      resize();
    });
    observer.observe(ta);
    return () => observer.disconnect();
  }, [resize]);

  useEffect(() => () => {
    imagesRef.current.forEach(revokeImagePreview);
  }, []);

  const handle = useMemo<ComposerEditorHandle>(() => ({
    insertIfEmpty(text: string) {
      const ta = textareaRef.current;
      const current = ta ? ta.value : valueRef.current;
      if (current.trim()) return;
      replaceValue(text, { selectEnd: false });
    },
    prependText(text: string) {
      if (!text.trim()) return;
      const ta = textareaRef.current;
      const current = ta ? ta.value : valueRef.current;
      // Mirrors the TUI's queue restore: queued text first, then whatever the user already typed, separated by a blank
      // line.
      const combined = [text, current].filter((part) => part.trim()).join("\n\n");
      replaceValue(combined, { selectEnd: true });
    },
    rekeyDraft(previousKey: string, nextKey: string) {
      if (previousKey === nextKey) return;
      if (draftKeyRef.current !== previousKey) {
        drafts.rekeyDraft(previousKey, nextKey);
        return;
      }

      const currentDraft = {
        value: valueRef.current,
        images: imagesRef.current.map(imageToDraftImage),
      };
      const moved = drafts.rekeyDraft(previousKey, nextKey, currentDraft) ?? { value: "", images: [] };
      draftKeyRef.current = nextKey;
      const unchanged = moved.value === currentDraft.value
        && moved.images.length === currentDraft.images.length
        && moved.images.every((image, index) => (
          image.data === currentDraft.images[index]?.data
          && image.mimeType === currentDraft.images[index]?.mimeType
        ));
      if (unchanged) return;

      const movedImages = draftImagesToAttachedImages(moved.images);
      replaceValue(moved.value);
      imagesRef.current = movedImages;
      setImages((previous) => {
        previous.forEach(revokeImagePreview);
        return movedImages;
      });
    },
    restoreSubmission(text: string, images?: ChatDraftImage[], targetDraftKey?: string) {
      if (!text.trim() && !images?.length) return;

      // clearInput is queued before the submission handler runs. Compose with that queued state so a fast rejection
      // cannot observe stale DOM text and then get overwritten by the clear.
      const currentDraftKey = draftKeyRef.current;
      const destinationDraftKey = targetDraftKey ?? currentDraftKey;
      const targetsCurrentComposer = destinationDraftKey === currentDraftKey;
      const storedDraft = !targetsCurrentComposer && destinationDraftKey
        ? drafts.getDraft(destinationDraftKey)
        : null;
      const restoredDraft = mergeRestoredSubmissionDraft(
        text,
        images,
        targetsCurrentComposer ? valueRef.current : (storedDraft?.value ?? ""),
        targetsCurrentComposer
          ? imagesRef.current.map(imageToDraftImage)
          : (storedDraft?.images ?? []),
      );
      // The first optimistic message switches the window out of its empty-state layout and remounts this component.
      // Persist synchronously so recovery is not lost if this instance is the one being unmounted.
      if (destinationDraftKey) drafts.setDraft(destinationDraftKey, restoredDraft);
      if (!targetsCurrentComposer) return;
      const restoredImages = images?.length
        ? [
            ...draftImagesToAttachedImages(images).slice(
              0,
              Math.max(0, MAX_ATTACHED_IMAGES - imagesRef.current.length),
            ),
            ...imagesRef.current,
          ].slice(0, MAX_ATTACHED_IMAGES)
        : imagesRef.current;
      // Session promotion can rekey this composer before React flushes the functional updates below, so update the
      // imperative snapshot first.
      valueRef.current = mergeRestoredSubmissionText(text, valueRef.current);
      imagesRef.current = restoredImages;
      replaceValue(valueRef.current, { selectEnd: true });
      setImages(restoredImages);
    },
    insertText(text: string) {
      const ta = textareaRef.current;
      if (!ta) {
        setValue(valueRef.current + (valueRef.current ? " " : "") + text);
        onDraftReplaced?.();
        return;
      }
      const start = ta.selectionStart ?? ta.value.length;
      const end = ta.selectionEnd ?? ta.value.length;
      const before = ta.value.slice(0, start);
      const sep = before.length > 0 && !before.endsWith(" ") ? " " : "";
      replaceTextareaRange(ta, start, end, sep + text);
      onDraftReplaced?.();
    },
    addImages(files: File[]) {
      void processImageFiles(files);
    },
  }), [drafts, onDraftReplaced, processImageFiles, replaceValue, setValue]);

  // The surface and the menus both call this handle from event handlers, so it is published after the frame that
  // built it rather than during render.
  useLayoutEffect(() => {
    if (handleRef !== undefined) handleRef.current = handle;
  }, [handle, handleRef]);

  return {
    value,
    valueRef,
    images,
    imagesRef,
    textareaRef,
    adoptedDraftKey,
    storageIssue,
    dismissStorageIssue: () => setStorageIssue(null),
    handle,
    setValue,
    replaceValue,
    addImages,
    removeImage,
    clearInput,
    resize,
  };
}
