/**
 * The third-party notice that has to travel inside a built page.
 *
 * `@hepi/ui` is what puts a third-party reader into a shipped chunk: the Word document preview
 * (`src/lib/docx-preview.ts`) dynamically imports `mammoth`, which this package declares as a production dependency, so
 * every host that builds this workbench embeds it. esbuild keeps only `@license`/`@preserve` comments and `mammoth`'s
 * browser build carries neither, so the bundle states no copyright of its own — the notice has to be a file inside the
 * artifact, not a line in the repository that built it.
 *
 * So the notice is owned here, beside the manifest that declares the dependency (`packages/ui/THIRD_PARTY_NOTICES.md`),
 * and each host's build copies it into the directory it distributes: `apps/web/dist`, which the client ingress serves,
 * and `apps/app/dist`, which the Tauri shell embeds through `build.frontendDist`. One owner and one copy per artifact
 * beats a file in each host's public directory that a host can forget to keep in step. The content is asserted against
 * the installed package in `src/lib/third-party-notices.test.ts`; the copy is asserted below and by each host's build.
 */
import { copyFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The notice this package owns. */
export const THIRD_PARTY_NOTICES = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "THIRD_PARTY_NOTICES.md");

/**
 * Place the notice inside a build output directory.
 *
 * A build that cannot put it there reports failure rather than success: an artifact that ships bundled third-party code
 * without the copyright line that licence requires is the thing this exists to prevent, and a page quietly missing it is
 * precisely what no later check would notice.
 */
export async function copyThirdPartyNotices(
  outDir: string,
  notice = THIRD_PARTY_NOTICES,
): Promise<{ path: string; bytes: number }> {
  const target = join(outDir, "THIRD_PARTY_NOTICES.md");
  await copyFile(notice, target);
  return { path: target, bytes: (await stat(target)).size };
}

/**
 * The build hook that puts the notice where the distribution carries it.
 *
 * `closeBundle`, which Vite calls after it has emptied and written `build.outDir`, so the copy survives `emptyOutDir`
 * instead of being one of the files it deletes. The shape is stated structurally and never imported from "vite": this
 * package declares no bundler, the two hosts that do pass this object straight into `plugins`, and a host whose build
 * did not run the hook would fail its own `vite build`.
 */
export function thirdPartyNoticesPlugin(): {
  name: string;
  apply: "build";
  configResolved(config: { root: string; build: { outDir: string } }): void;
  closeBundle(): Promise<void>;
} {
  let outDir = "";
  return {
    name: "hepi:third-party-notices",
    apply: "build",
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    async closeBundle() {
      const copied = await copyThirdPartyNotices(outDir);
      process.stdout.write(
        "hepi: third-party notice -> " + copied.path + " (" + copied.bytes + " bytes)" + String.fromCharCode(10),
      );
    },
  };
}
