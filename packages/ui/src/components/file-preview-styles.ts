import type { CSSProperties } from "react";
import { vscDarkPlus } from "react-syntax-highlighter/dist/cjs/styles/prism";

/** The monospace vocabulary the source and diff views share, so the two formats read as one surface. */
export const FILE_CODE_STYLE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontWeight: "var(--font-mono-weight)",
  fontSize: 13,
  lineHeight: 1.6,
};

/** One gutter cell: a source line number, and a diff row's own number, in the same column. */
export const FILE_LINE_NUMBER_STYLE: CSSProperties = {
  width: 48,
  minWidth: 48,
  padding: "0 10px",
  textAlign: "right",
  color: "var(--text-dim)",
  background: "var(--bg-panel)",
  borderRight: "1px solid var(--border)",
  fontFamily: "var(--font-mono)",
  fontWeight: "var(--font-mono-weight)",
  fontSize: 11,
  fontStyle: "normal",
  fontVariantNumeric: "tabular-nums",
  lineHeight: "20.8px",
  userSelect: "none",
  flexShrink: 0,
  verticalAlign: "top",
};

// Prism's light theme colors <pre> with backgroundColor, its dark theme with
// the background shorthand. The source view sets backgroundColor itself and the
// dark theme's shorthand is dropped, as CodeBlock does: a theme switch then never
// makes React remove one beside the other (it warned, and the view lost its
// background).
const sourceDarkTheme = {
  ...vscDarkPlus,
  'pre[class*="language-"]': {
    ...vscDarkPlus['pre[class*="language-"]'],
  },
};
delete sourceDarkTheme['pre[class*="language-"]'].background;
export const FILE_SOURCE_DARK_THEME = sourceDarkTheme;
