/**
 * The chunk groups both hosts' builds split the workbench into.
 *
 * One owner, because the Web page and the App bundle the same tree: a group only one host declared would make the two
 * artifacts cut the same code differently. These are cache boundaries, not deferred loading — every import named here is
 * static and still fetched for the first paint. The one demand-loaded path is the one that already was: `MermaidBlock`
 * calls `import("mermaid")`, so mermaid is left out of these groups; capturing it would merge its own split diagram
 * definitions back into one chunk. `maxSize` is a size budget, used only where a group's members are separable (Prism's
 * grammars, the independent Settings panels) and set below Vite's 500 kB warning.
 */

/** The subset of rolldown's `CodeSplittingGroup` these groups use. Declared here so this file needs no bundler types. */
interface ChunkGroup {
  name: string;
  test: RegExp;
  priority: number;
  maxSize?: number;
}

const NODE_MODULES = String.raw`node_modules[\\/]`;
const UI_COMPONENTS = String.raw`packages[\\/]ui[\\/]src[\\/]components[\\/]`;

/** A package family, matched at the `node_modules` boundary so a nested copy is still captured. */
function packages(names: string): RegExp {
  return new RegExp(`${NODE_MODULES}(${names})[\\\\/]`);
}

/** A set of the workbench's own components, named by the file that owns the surface. */
function components(names: string): RegExp {
  return new RegExp(`${UI_COMPONENTS}(${names})`);
}

export const chunkGroups: ChunkGroup[] = [
  { name: "react", test: packages(String.raw`react|react-dom|scheduler`), priority: 4 },
  { name: "router", test: packages(String.raw`react-router|@remix-run|cookie|set-cookie-parser|turbo-stream`), priority: 3 },
  { name: "xterm", test: packages(String.raw`@xterm`), priority: 3 },
  { name: "katex", test: packages(String.raw`katex`), priority: 3 },
  {
    name: "highlighter-lang",
    test: new RegExp(`${NODE_MODULES}refractor[\\\\/]lang[\\\\/]`),
    priority: 3,
    maxSize: 400 * 1024,
  },
  { name: "highlighter", test: packages(String.raw`react-syntax-highlighter|refractor|prismjs|lowlight|highlight\.js`), priority: 2 },
  {
    name: "markdown",
    test: packages(
      String.raw`react-markdown|rehype-[^\\/]+|remark-[^\\/]+|mdast-[^\\/]+|micromark[^\\/]*|unified|unist-[^\\/]+|vfile[^\\/]*|hast-[^\\/]+`,
    ),
    priority: 2,
  },

  // The workbench's own surfaces, cut where the application itself is cut: each is a screen a reader opens on its own.
  {
    name: "settings-ui",
    test: components(
      String.raw`(SettingsPanel|SettingsUi|ModelsConfig|McpConfig|SkillsConfig|AgentsConfig|ExtensionsConfig|FontSettings|EnabledModelsSection|ProviderIcon|ProviderUsageSummary|OAuthDetail|OAuthPastePanel|McpAddServer|McpSignIn|McpConversationTools|ThemeIcon|settings-ui-helpers|models-config-helpers|mcp-config-helpers|mcp-add-helpers|mcp-sign-in-helpers|mcp-workflow|useMcpWorkflow|enabled-models-helpers)\.tsx?`,
    ),
    priority: 1,
    maxSize: 400 * 1024,
  },
  {
    name: "chat-ui",
    test: components(
      String.raw`(ChatWindow|ChatInput|ChatMinimap|MarkdownBody|MarkdownFilePreview|MermaidBlock|SourceFilePreview|ImagePreview|FrontmatterCard|composer[\\/])`,
    ),
    priority: 1,
  },
  {
    name: "shell-ui",
    test: components(
      String.raw`(AppShell|SessionSidebar|SessionTree|ShellTopBar|ShellTopPanel|WorkspacePanel|FileExplorer|SidebarMenu|ChatArea|SessionStatsPopover)\.tsx?`,
    ),
    priority: 1,
  },
];
