# Third-party notices

`@hepi/client` is published as `UNLICENSED` (see LICENSE). It bundles the code below, which keeps its own license and
copyright. Each bundled file carries its license comments at the end, because the build emits them
(`legalComments: "eof"`); this file records the packages the bundle draws on.

## Code from this repository

The bundle includes the workspace package `packages/gateway` (local and SSH execution, filesystem RPC, workbench,
installation) and the gateway's own adaptations of upstream sources recorded in `docs/upstream-sources.md` and
`docs/workbench.md` of the repository. Those parts are covered by the same `UNLICENSED` terms as the client, except
where the upstream notices below apply.

## Bundled third-party packages

| Package | Version | License | Copyright / source |
| --- | --- | --- | --- |
| @earendil-works/pi-durable | 1.3.0 | MIT | Copyright (c) 2025 Mario Zechner — https://github.com/earendil-works/pi |
| @earendil-works/pi-mcp | 1.1.0 | MIT | Earendil Works — https://github.com/earendil-works/pi (its OAuth client adapts the MIT-licensed Model Context Protocol TypeScript SDK v1.29.0, whose license it carries under `LICENSES/`) |
| @earendil-works/chord | 1.3.0 | MIT | Earendil Works — https://github.com/earendil-works/pi |
| @earendil-works/pi-ai | 1.3.0 | MIT | Copyright (c) 2025 Mario Zechner — https://github.com/earendil-works/pi (the gateway's provider-auth surface reads its provider set and stores credentials in its `Credential` shapes) |
| proper-lockfile | 4.1.2 | MIT | Copyright (c) 2018 Made With MOXY Lda — https://github.com/moxystudio/node-proper-lockfile (serializes this host's writes to `auth.json` beside pi's own) |
| ignore | 7.0.5 | MIT | Copyright (c) 2013 Kael Zhang and contributors — https://github.com/kaelzhang/node-ignore |
| node-ignore 7.0.5 matching engine, ported to Python | Port of the 7.0.5 sources; the port is copied into `packages/gateway/src/ssh-filesystem.ts` (LICENSE kept verbatim in `packages/gateway/src/node-ignore.LICENSE`) | MIT | Copyright (c) 2013 Kael Zhang and contributors — https://github.com/kaelzhang/node-ignore |
| pi-gui workbench adaptations | Pinned snapshots in packages/gateway/vendor/pi-gui | MIT | Copyright (c) 2026 Matthew Lam |
| pi-web skill-frontmatter adaptation | Pinned snapshot in packages/gateway/vendor/pi-web (76bdc57027172eb381a216d647225a6d24f23360) | MIT | Copyright (c) 2026 agegr — https://github.com/agegr/pi-web |
| pi-web MCP masking rules | Same pinned snapshot; copied byte-identically into packages/protocol/src/mcp-secrets.ts, consumed by the gateway as `@hepi/protocol/mcp-secrets` (LICENSE in packages/gateway/vendor/pi-web) | MIT | Copyright (c) 2026 agegr — https://github.com/agegr/pi-web |
| pi-coding-agent filesystem and worktree-shadow adaptations | 1.1.0 | MIT | Copyright (c) 2025 Mario Zechner — https://github.com/earendil-works/pi |

The MIT license text that applies to each of them:

```
MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Upstream code preserved in the repository

The bundle includes the gateway's Python port of the `node-ignore` 7.0.5 matching engine
(`packages/gateway/src/ssh-filesystem.ts`, embedded in the remote helper the gateway sends over SSH), its pi-gui
workspace-path, file and diff adaptations, its pi-coding-agent filesystem
and worktree-shadow adaptations, and its skill-frontmatter adaptation of pi-web (`packages/gateway/src/skill-frontmatter.ts`,
reached from the gateway through ticket 11 and therefore present in `dist/cli.js` even though the CLI does not call it). Their copyright notices are listed above and share the full MIT permission text
in this file; the build also appends these notices to the executable bundle. The original snapshots and exact
source revisions remain in the repository under `packages/gateway/vendor/` and `docs/upstream-sources.md`.
The server's prompt-template snapshot is not bundled in the client.

## License scope

This repository has no root license grant, so no permission to use the client's own code is granted by publication.
Choosing a project license is an operator decision; if one is chosen, update LICENSE, this file and
`packages/client/package.json` together.
