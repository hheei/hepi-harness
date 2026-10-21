# Third-party notices for the workbench page

This file belongs to `packages/ui`, the package that declares the reader below, and every host that builds this
workbench distributes it inside its own artifact: `apps/web/vite.config.ts` and `apps/app/vite.config.ts` both pass
`thirdPartyNoticesPlugin()` (`packages/ui/src/lib/third-party-notices.ts`), whose `closeBundle` hook copies this file
into the build's `outDir`. For `@hepi/web` that directory is what the client ingress serves, so the built page carries
it at `/THIRD_PARTY_NOTICES.md`; for `@hepi/app` it is `apps/app/dist`, which the Tauri shell embeds through
`build.frontendDist`, so the packaged App carries it too.

The notice has to be inside the artifact rather than only in the repository that built it: a bundled page contains
third-party code, and the build's own module output does not carry those headers (esbuild keeps only
`@license`/`@preserve` comments, and `mammoth`'s browser build has none). One owner and one copy per artifact beats a
file in each host's public directory that a host can forget to keep in step.

## mammoth

Used by the Word document preview (`packages/ui/src/lib/docx-preview.ts`), which reads a workspace `.docx` in the
browser and is dynamically imported, so a page that never opens a document never loads it. Bundled from the package's
own `browser` field mappings; the library is not forked or patched.

- Package: `mammoth` 1.13.0 (declared as `^1.12.0` by `packages/ui`, in `dependencies`)
- License: BSD-2-Clause ("BSD 2-Clause Simplified License")
- Copyright (c) 2013, Michael Williamson. All rights reserved.
- Source: https://github.com/mwilliamson/mammoth.js

Redistribution and use in source and binary forms, with or without modification, are permitted provided that the
following conditions are met: redistributions of source code must retain the above copyright notice, this list of
conditions and the following disclaimer; redistributions in binary form must reproduce the above copyright notice,
this list of conditions and the following disclaimer in the documentation and/or other materials provided with the
distribution. THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR
IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A
PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT,
INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN
ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

The upstream `LICENSE` text is reproduced above from the installed package (`node_modules/.pnpm/mammoth@1.13.0`);
`docs/upstream-sources.md` records the pin and the license reading, and
`packages/ui/src/lib/third-party-notices.test.mjs` asserts this file against the installed package's own `LICENSE` and
version, that each host's build copies it into its output directory, and that no host keeps a second copy of it.
