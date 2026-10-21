export const MAX_ATTACHED_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_ATTACHED_IMAGES = 10;

export interface Base64ImageAttachment {
  data: string;
  mimeType: string;
}

function isBase64DataChar(code: number): boolean {
  return (code >= 0x41 && code <= 0x5a)
    || (code >= 0x61 && code <= 0x7a)
    || (code >= 0x30 && code <= 0x39)
    || code === 0x2b
    || code === 0x2f;
}

export type ImageFileLike = { name: string; type: string; size: number };
export type ImageFileRejection = { name: string; reason: "unsupported" | "too-large" | "too-many" };

/**
 * The composer's own admission rule, kept beside the protocol's limits so both sides refuse the same input. Every
 * refused file is reported instead of being dropped without a word, and the accepted list is capped by the remaining
 * attachment slots the caller passes in.
 */
export function selectImageFiles<T extends ImageFileLike>(files: readonly T[], remaining: number): { accepted: T[]; rejected: ImageFileRejection[] } {
  const capacity = Math.max(0, Math.floor(remaining));
  const accepted: T[] = [];
  const rejected: ImageFileRejection[] = [];
  for (const file of files) {
    if (!file.type.startsWith("image/")) rejected.push({ name: file.name, reason: "unsupported" });
    else if (file.size > MAX_ATTACHED_IMAGE_BYTES) rejected.push({ name: file.name, reason: "too-large" });
    else if (accepted.length >= capacity) rejected.push({ name: file.name, reason: "too-many" });
    else accepted.push(file);
  }
  return { accepted, rejected };
}

export function getBase64DecodedByteLength(data: string): number | null {
  if (!data || data.length % 4 !== 0) return null;
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  const dataEnd = data.length - padding;
  for (let index = 0; index < dataEnd; index += 1) {
    if (!isBase64DataChar(data.charCodeAt(index))) return null;
  }
  for (let index = dataEnd; index < data.length; index += 1) {
    if (data[index] !== "=") return null;
  }
  return (data.length / 4) * 3 - padding;
}

export function isBase64ImageWithinLimits(value: unknown): value is Base64ImageAttachment {
  if (!value || typeof value !== "object") return false;
  const image = value as Partial<Base64ImageAttachment>;
  if (typeof image.data !== "string" || typeof image.mimeType !== "string" || !image.mimeType.startsWith("image/")) {
    return false;
  }
  const bytes = getBase64DecodedByteLength(image.data);
  return bytes !== null && bytes <= MAX_ATTACHED_IMAGE_BYTES;
}

/** Return an API-safe error for prompt, steering, and follow-up image arrays. */
export function validateAgentImages(value: unknown): string | null {
  if (value === undefined) return null;
  if (!Array.isArray(value)) return "images must be an array";
  if (value.length > MAX_ATTACHED_IMAGES) {
    return `A message can include at most ${MAX_ATTACHED_IMAGES} images`;
  }
  for (const image of value) {
    if (!image || typeof image !== "object" || (image as { type?: unknown }).type !== "image") {
      return "Each attachment must be an image";
    }
    if (!isBase64ImageWithinLimits(image)) {
      return `Each image must be valid base64 image data of ${MAX_ATTACHED_IMAGE_BYTES / (1024 * 1024)}MB or smaller`;
    }
  }
  return null;
}
