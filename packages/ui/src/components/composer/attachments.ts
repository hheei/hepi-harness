/**
 * The composer's attachments: which files it accepts, how a large photo is shrunk before it is sent, and the two shapes
 * a picture takes in this surface — one with a preview URL for the screen, one without for the draft that outlives it.
 *
 * The limits are the protocol's, not the composer's: `selectImageFiles` is the one admission rule, so a paste, a drop
 * and the file picker cannot disagree about what fits. What lives here is the browser half — decoding, scaling and
 * revoking the previews — which is why it is separate from the editor's text rules.
 */
import {
  MAX_ATTACHED_IMAGES,
  isBase64ImageWithinLimits,
  selectImageFiles,
  type ImageFileRejection,
} from "../../lib/image-attachments";
import type { ChatDraftImage } from "../../lib/draft-store";

export type { ImageFileRejection };
export { MAX_ATTACHED_IMAGES, selectImageFiles };

/** A picture the composer is holding: the bytes it will send and the URL it previews them with. */
export interface AttachedImage {
  data: string; // base64, no prefix
  mimeType: string;
  previewUrl: string; // object URL for display
}

const CLIENT_IMAGE_COMPRESSION_THRESHOLD_BYTES = 1024 * 1024;
const CLIENT_MAX_IMAGE_SIDE = 1024;
const CLIENT_JPEG_QUALITY = 0.85;

export function shouldCompressImageFile(file: Pick<File, "size" | "type">): boolean {
  return file.size > CLIENT_IMAGE_COMPRESSION_THRESHOLD_BYTES && file.type !== "image/gif";
}

function readImageFile(file: Blob, mimeType: string): Promise<{ data: string; mimeType: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const data = typeof reader.result === "string" ? reader.result.split(",")[1] : undefined;
      if (!data) {
        reject(new Error("Failed to read image"));
        return;
      }
      resolve({ data, mimeType });
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/**
 * A picture's bytes as the wire takes them, scaled down when it is large enough that sending it as captured would cost
 * more than the reader meant to spend. A compression that produces a larger payload than the original is discarded: the
 * smaller answer is the one that gets sent.
 */
export async function compressImageFile(file: File): Promise<{ data: string; mimeType: string }> {
  const original = () => readImageFile(file, file.type);
  if (!shouldCompressImageFile(file) || typeof createImageBitmap !== "function") return original();

  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) return original();

  try {
    const scale = Math.min(1, CLIENT_MAX_IMAGE_SIDE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) return original();
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const data = canvas.toDataURL("image/jpeg", CLIENT_JPEG_QUALITY).split(",")[1];
    return data && data.length < Math.ceil(file.size / 3) * 4
      ? { data, mimeType: "image/jpeg" }
      : original();
  } catch {
    return original();
  } finally {
    bitmap.close();
  }
}

/** The draft shape of a picture the screen is showing: a draft stores no preview URL, because none survives a reload. */
export function imageToDraftImage(image: AttachedImage): ChatDraftImage {
  return { data: image.data, mimeType: image.mimeType };
}

/**
 * A stored picture as the screen shows it. A draft's bytes are its own preview: the browser can render a data URL, so
 * nothing here needs the object URL a freshly pasted file had.
 */
export function draftImageToAttachedImage(image: ChatDraftImage): AttachedImage {
  return {
    ...image,
    previewUrl: `data:${image.mimeType};base64,${image.data}`,
  };
}

/** The pictures of a stored draft that this surface may attach, capped the way an attachment list is. */
export function draftImagesToAttachedImages(images: ChatDraftImage[] | undefined): AttachedImage[] {
  return (images ?? [])
    .filter(isBase64ImageWithinLimits)
    .slice(0, MAX_ATTACHED_IMAGES)
    .map(draftImageToAttachedImage);
}

/** Release the object URL a pasted picture previewed through; a data URL is the browser's own and is left alone. */
export function revokeImagePreview(image: AttachedImage): void {
  if (image.previewUrl.startsWith("blob:")) {
    URL.revokeObjectURL(image.previewUrl);
  }
}
