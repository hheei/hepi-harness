"use client";

import { useMemo } from "react";
import {
  Prism as SyntaxHighlighter,
  createElement as renderSyntaxNode,
  type SyntaxHighlighterProps,
} from "react-syntax-highlighter";
import { vs } from "react-syntax-highlighter/dist/cjs/styles/prism";
import { useTheme } from "../hooks/useTheme";
import { FILE_CODE_STYLE, FILE_LINE_NUMBER_STYLE, FILE_SOURCE_DARK_THEME } from "./file-preview-styles";

/** Past this many lines the view states the text instead of building a token element for every word of it. */
const SOURCE_HIGHLIGHT_MAX_LINES = 1_000;

type SourceCodeRendererProps = Parameters<NonNullable<SyntaxHighlighterProps["renderer"]>>[0] & {
  wrapLines: boolean;
};

function SourceCodeRenderer({ rows, stylesheet, useInlineStyles, wrapLines }: SourceCodeRendererProps) {
  return rows.map((row, lineIndex) => {
    const children = row.children ?? [];
    const firstChildClasses = children[0]?.properties?.className;
    const hasLineNumber = Array.isArray(firstChildClasses)
      && firstChildClasses.includes("react-syntax-highlighter-line-number");
    const lineNumberNode = hasLineNumber ? children[0] : null;
    const contentNodes = hasLineNumber ? children.slice(1) : children;

    return (
      <span
        className="file-source-line"
        data-line-number={lineIndex + 1}
        key={`source-line-${lineIndex}`}
        style={{ display: "flex", minWidth: "100%" }}
      >
        {lineNumberNode && renderSyntaxNode({
          node: lineNumberNode,
          stylesheet,
          useInlineStyles,
          key: `source-line-number-${lineIndex}`,
        })}
        <span
          className="file-source-line-content"
          style={{
            flex: "1 1 auto",
            minWidth: 0,
            overflowWrap: wrapLines ? "anywhere" : "normal",
            whiteSpace: wrapLines ? "pre-wrap" : "pre",
          }}
        >
          {contentNodes.map((node, tokenIndex) => renderSyntaxNode({
            node,
            stylesheet,
            useInlineStyles,
            key: `source-token-${lineIndex}-${tokenIndex}`,
          }))}
        </span>
      </span>
    );
  });
}

/**
 * One text file's own bytes, as source.
 *
 * react-syntax-highlighter rebuilds every token element on each render, which costs hundreds of milliseconds on large
 * files, so a file past {@link SOURCE_HIGHLIGHT_MAX_LINES} states its lines as text instead. Below that bound the
 * rendered trees are memoised, so an unrelated re-render — a panel opening, the selection moving — reuses them as-is.
 */
export function SourceFilePreview({ content, language, wrapLines }: {
  content: string;
  language: string;
  wrapLines: boolean;
}) {
  const { isDark } = useTheme();
  const sourceLines = useMemo(() => content.split("\n"), [content]);

  const highlightedSource = useMemo(
    () => (
      <SyntaxHighlighter
        className={wrapLines ? "file-source-view is-wrapped" : "file-source-view"}
        language={language === "text" ? "plaintext" : language}
        style={isDark ? FILE_SOURCE_DARK_THEME : vs}
        showLineNumbers
        lineNumberStyle={{
          ...FILE_LINE_NUMBER_STYLE,
        }}
        customStyle={{
          margin: 0,
          padding: 0,
          border: 0,
          backgroundColor: "var(--bg)",
          ...FILE_CODE_STYLE,
          width: wrapLines ? "100%" : "max-content",
          minWidth: "100%",
          minHeight: "100%",
          overflow: "visible",
        }}
        codeTagProps={{
          style: {
            fontFamily: "var(--font-mono)",
            fontWeight: "var(--font-mono-weight)",
            overflowWrap: wrapLines ? "anywhere" : "normal",
          },
        }}
        renderer={(rendererProps) => (
          <SourceCodeRenderer {...rendererProps} wrapLines={wrapLines} />
        )}
        wrapLongLines={wrapLines}
      >
        {content}
      </SyntaxHighlighter>
    ),
    [isDark, language, content, wrapLines],
  );

  if (sourceLines.length <= SOURCE_HIGHLIGHT_MAX_LINES) return highlightedSource;

  return (
    <div
      className="file-source-view is-lightweight"
      style={{
        width: wrapLines ? "100%" : "max-content",
        minWidth: "100%",
        minHeight: "100%",
        background: "var(--bg)",
        ...FILE_CODE_STYLE,
      }}
    >
      {sourceLines.map((line, lineIndex) => (
        <span
          className="file-source-line"
          data-line-number={lineIndex + 1}
          key={`source-line-${lineIndex}`}
          style={{ display: "flex", minWidth: "100%" }}
        >
          <span aria-hidden="true" style={FILE_LINE_NUMBER_STYLE}>
            {lineIndex + 1}
          </span>
          <span
            className="file-source-line-content"
            style={{
              flex: "1 1 auto",
              minWidth: 0,
              overflowWrap: wrapLines ? "anywhere" : "normal",
              whiteSpace: wrapLines ? "pre-wrap" : "pre",
            }}
          >
            {line}
          </span>
        </span>
      ))}
    </div>
  );
}
