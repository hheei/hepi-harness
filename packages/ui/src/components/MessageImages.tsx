"use client";

import { useEffect, useState, type CSSProperties } from "react";
import { ImagePreview } from "./ImagePreview";
import { useI18n } from "../hooks/useI18n";
import { openResourceImage, resourceRefusalKey, type ResourceImageState } from "../lib/resource-read";
import { useOptionalResourceReader } from "../lib/workbench-scope";
import type { ImageContent, TextContent } from "../lib/types";

/** The inline bytes one image block carries, or `""` when it names a read block instead. */
function inlineImageSource(img: ImageContent): string {
  const flat = img as unknown as { data?: string; mimeType?: string };
  if (img.source) {
    return img.source.type === "base64" && typeof img.source.data === "string"
      ? `data:${img.source.media_type};base64,${img.source.data}`
      : "";
  }
  return flat.data ? `data:${flat.mimeType};base64,${flat.data}` : "";
}

/** The read block a deferred history image names, or `""` when the block carries its own bytes. */
function imageReadBlock(img: ImageContent): string {
  if ((img as unknown as { data?: string }).data) return "";
  return img.source?.type === "url" && typeof img.source.url === "string" ? img.source.url : "";
}

/**
 * One history image: inline bytes render directly, a deferred one is fetched as a lease through this connection's
 * reader.
 *
 * A deferred image is an address rather than bytes, and the address belongs to the connection the page was admitted to.
 * Rendering it as a plain `<img src>` would make the browser ask the document's own origin — the App bundle on a
 * native shell — and would carry no device bearer. The lease is held for as long as this component is mounted and
 * released on unmount or when the address or connection changes, so one connection's screenshot never survives into the
 * next one's view.
 */
function ResourceImage({ address, alt = "", loading, style }: { address: string; alt?: string; loading?: "eager" | "lazy"; style?: CSSProperties }) {
  const { t } = useI18n();
  const reader = useOptionalResourceReader();
  const [state, setState] = useState<ResourceImageState>({ status: "loading" });
  useEffect(() => {
    const controller = new AbortController();
    const release = openResourceImage(reader, address, setState, { signal: controller.signal });
    return () => {
      controller.abort();
      release();
    };
  }, [reader, address]);
  if (state.status === "refused") {
    return <span data-resource-image={state.reason} style={style}>{t(resourceRefusalKey(state.reason))}</span>;
  }
  if (state.status === "loading") return null;
  return (
    <ImagePreview src={state.url} alt={alt}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={state.url} alt={alt} loading={loading} style={style} />
    </ImagePreview>
  );
}

/** One image block of any message: inline bytes, or the read block a deferred history image names. */
export function MessageImage({ image, alt = "", loading, style }: { image: ImageContent; alt?: string; loading?: "eager" | "lazy"; style?: CSSProperties }) {
  const inline = inlineImageSource(image);
  if (inline) {
    return (
      <ImagePreview src={inline} alt={alt}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={inline} alt={alt} loading={loading} style={style} />
      </ImagePreview>
    );
  }
  const address = imageReadBlock(image);
  return address === "" ? null : <ResourceImage address={address} alt={alt} loading={loading} style={style} />;
}

/** The image blocks a message's own content carries, in order. */
export function getMessageImages(content: string | readonly (TextContent | ImageContent)[]): ImageContent[] {
  if (typeof content === "string") return [];
  return content.filter((block): block is ImageContent => block.type === "image");
}
