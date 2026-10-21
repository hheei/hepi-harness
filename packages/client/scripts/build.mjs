#!/usr/bin/env node
/**
 * Bundle the CLI into dist/ with esbuild.
 *
 * The published package ships only dist/, so every module the CLI imports at runtime has to be in the bundle: the
 * gateway sources, the upstream runtime packages and the workbench helper. Anything resolved from node_modules is
 * bundled; node: builtins stay external. Third-party license comments are kept at the end of each output file.
 *
 * esbuild is the package's own development dependency, installed by pnpm.
 *
 * The upstream packages carry no license comment in their build output, so the notices the MIT license requires are
 * appended to the entry file here. They also ship as THIRD_PARTY_NOTICES.md.
 */
import * as esbuild from "esbuild";
import { appendFile, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The version the CLI prints has to be the version the tarball carries; a drift would be published silently. */
async function checkVersion() {
  const manifest = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8"));
  const source = await readFile(join(packageDir, "src", "version.ts"), "utf8");
  const declared = /export const VERSION = "([^"]+)"/.exec(source)?.[1];
  if (declared !== manifest.version) {
    throw new Error("src/version.ts (" + declared + ") must equal package.json version (" + manifest.version + ")");
  }
  return manifest.version;
}

const version = await checkVersion();
await esbuild.build({
  entryPoints: { cli: join(packageDir, "src", "cli.ts") },
  outdir: join(packageDir, "dist"),
  bundle: true,
  splitting: true,
  format: "esm",
  platform: "node",
  target: "node24",
  chunkNames: "chunks/[name]-[hash]",
  entryNames: "[name]",
  legalComments: "eof",
  logLevel: "warning",
  define: { HEPI_CLIENT_VERSION: JSON.stringify(version) },
  // The MCP client is CommonJS and reaches node builtins through `require`, which an ES module has no
  // binding for. The banner gives the bundled CJS its own `require`, so the gateway's MCP capability
  // travels in the published bundle instead of failing at the first connection.
  banner: { js: "import { createRequire as __hepiCreateRequire } from 'node:module'; const require = __hepiCreateRequire(import.meta.url);" },
});
/**
 * The MIT license requires its copyright and permission notice to travel with the copies. The bundled upstream
 * packages do not emit one, so the notice is appended to the entry file, which is what `bin` runs.
 */
const NOTICE = [
  "",
  "/*",
  " * @hepi/client is UNLICENSED; see LICENSE. It bundles the packages below, each under the MIT license:",
  " *",
  " *   @earendil-works/pi-durable 1.3.0  Copyright (c) 2025 Mario Zechner  https://github.com/earendil-works/pi",
  " *   pi-coding-agent adaptations 1.1.0  Copyright (c) 2025 Mario Zechner  https://github.com/earendil-works/pi",
  " *   @earendil-works/pi-mcp   1.1.0  Earendil Works                  https://github.com/earendil-works/pi",
  " *     its OAuth client adapts the Model Context Protocol TypeScript SDK v1.29.0:",
  " *   Model Context Protocol TypeScript SDK  Copyright (c) 2024 Anthropic, PBC",
  " *                                     https://github.com/modelcontextprotocol/typescript-sdk",
  " *   pi-gui workbench adaptations  Copyright (c) 2026 Matthew Lam",
  " *   pi-web skill-frontmatter adaptation  Copyright (c) 2026 agegr  https://github.com/agegr/pi-web",
  " *   pi-web MCP masking rules    Copyright (c) 2026 agegr  https://github.com/agegr/pi-web",
  " *   @earendil-works/chord      1.3.0  Earendil Works                  https://github.com/earendil-works/pi",
  " *   @earendil-works/pi-ai      1.3.0  Copyright (c) 2025 Mario Zechner  https://github.com/earendil-works/pi",
  " *     its provider definitions and credential shapes are what the gateway's provider-auth surface reads:",
  " *   proper-lockfile            4.1.2  Copyright (c) 2018 Made With MOXY Lda",
  " *                                     https://github.com/moxystudio/node-proper-lockfile",
  " *   ignore                     7.0.5  Copyright (c) 2013 Kael Zhang and contributors",
  " *                                     https://github.com/kaelzhang/node-ignore",
  " *     its matching engine is ported to Python inside the gateway's remote helper:",
  " *   node-ignore 7.0.5 port     Copyright (c) 2013 Kael Zhang and contributors",
  " *",
  " * Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated",
  " * documentation files (the \"Software\"), to deal in the Software without restriction, including without limitation",
  " * the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and",
  " * to permit persons to whom the Software is furnished to do so, subject to the following conditions:",
  " *",
  " * The above copyright notice and this permission notice shall be included in all copies or substantial portions of",
  " * the Software.",
  " *",
  " * THE SOFTWARE IS PROVIDED \"AS IS\", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO",
  " * THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE",
  " * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF",
  " * CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER",
  " * DEALINGS IN THE SOFTWARE.",
  " */",
  "",
].join("\n");
await appendFile(join(packageDir, "dist", "cli.js"), NOTICE);
process.stdout.write("built @hepi/client " + version + " into dist/\n");
