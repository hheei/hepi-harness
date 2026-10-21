"use client";

import { useMemo, type ComponentProps, type MouseEvent } from "react";
import ReactMarkdown from "react-markdown";
import { useFileBytes } from "../hooks/useFileBytes";
import { parsePdfPageFragment, resolveLocalFileHref, shouldOpenLocalFileInApp } from "../lib/file/file-links";
import { parseFrontmatter } from "../lib/frontmatter";
import { markdownPreviewRehypePlugins, markdownPreviewRemarkPlugins, markdownUrlTransform, normalizeDisplayMath } from "../lib/markdown";
import { CodeBlock, MermaidBlock } from "./MermaidBlock";
import { FrontmatterCard } from "./FrontmatterCard";

/**
 * One image inside a markdown preview.
 *
 * A local image is a file of the same workspace, so it is read the way every other image on the page is: on a cookie
 * page the element's own request carries the credential, and on an App the connection reads it into a lease. A remote
 * image belongs to no connection here, so its own address is left as it was.
 */
function MarkdownImage({ filePath, src, ...props }: ComponentProps<"img"> & { filePath: string | null }) {
  const bytes = useFileBytes(filePath);
  const resolved = filePath === null ? src : bytes.url ?? undefined;
  if (resolved === undefined) return null;
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={resolved} {...props} />;
}

/**
 * A markdown file rendered as the document it is.
 *
 * What a link to another workspace file does belongs here rather than in the viewer: a local link opens that file in
 * this workbench, and a local image is read through the connection. Both are resolved against the markdown file's own
 * folder, so a relative path in the document means what the author meant.
 */
export function MarkdownFilePreview({ content, directory, cwd, onOpenFile }: {
  content: string;
  /** The folder the document itself lives in: what its relative links resolve against. */
  directory: string;
  cwd?: string;
  onOpenFile?: (filePath: string, page?: number) => void;
}) {
  // The document is parsed and its display math normalised once per body: a re-render of the view — a panel opening,
  // the selection moving — is not a second parse of the same markdown.
  const { frontmatter, rendered } = useMemo(
    () => ({ frontmatter: parseFrontmatter(content), rendered: normalizeDisplayMath(content) }),
    [content],
  );
  return (
    <div
      className="markdown-body markdown-file-preview"
      style={{ padding: "24px 32px" }}
    >
      {frontmatter.data && <FrontmatterCard data={frontmatter.data} />}
      <ReactMarkdown
        remarkPlugins={markdownPreviewRemarkPlugins}
        rehypePlugins={markdownPreviewRehypePlugins}
        urlTransform={onOpenFile ? markdownUrlTransform : undefined}
        components={{
          code({ className, children, ...props }) {
            const lang = className?.replace("language-", "").toLowerCase() ?? "";
            const raw = String(children);
            const isBlock = className?.includes("language-") || raw.includes("\n");
            if (isBlock) {
              if (lang === "mermaid") {
                return <MermaidBlock code={raw.replace(/\n$/, "")} defaultPreview />;
              }
              return <CodeBlock code={raw.replace(/\n$/, "")} lang={lang} />;
            }
            return (
              <code className={className} {...props}>
                {children}
              </code>
            );
          },
          pre({ children }) {
            // Render the code block directly — CodeBlock provides its own wrapping.
            // For non-mermaid blocks, pass through to default pre rendering.
            return <>{children}</>;
          },
          a({ href, children, ...props }) {
            delete props.node;
            const linkedFile = onOpenFile
              ? resolveLocalFileHref(href, directory, cwd ?? directory)
              : null;
            if (!linkedFile || !onOpenFile) {
              return <a href={href} {...props}>{children}</a>;
            }

            const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
              if (!shouldOpenLocalFileInApp(event)) return;
              event.preventDefault();
              onOpenFile(linkedFile, parsePdfPageFragment(href) ?? undefined);
            };

            return <a href={href} {...props} onClick={handleClick}>{children}</a>;
          },
          img({ src, alt, ...props }) {
            delete props.node;
            const imagePath = typeof src === "string"
              ? resolveLocalFileHref(src, directory, cwd ?? directory)
              : null;
            return <MarkdownImage filePath={imagePath} alt={alt ?? ""} loading="lazy" {...props} />;
          },
        }}
      >
        {rendered}
      </ReactMarkdown>
    </div>
  );
}
