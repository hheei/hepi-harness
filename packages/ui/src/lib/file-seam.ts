import { fileApiPath } from "./file-paths";
import type { WorkbenchClient } from "../client";
import { workspaceRoutingLocation, type FileIndexResponse, type FileListingResponse, type FileMetaResponse, type FilePreviewResponse, type GitFileDiffResponse, type GitStatusResponse, type UploadBatchResponse, type UploadConflictStrategy, type UploadInspectionResponse } from "@hepi/protocol/files";

/**
 * The file surface, as the workbench's own surfaces call it.
 *
 * The explorer, the viewer and the composer's `@` menu all ask for the same things, and what they may not do is
 * assemble an address. Two hosts share this tree, and one of them — a packaged App — is loaded from a bundle, so a
 * relative `/api/files/…` would ask the shell itself for a file it does not serve; the Web page's own cookie is not
 * the App's credential either. So every address here is resolved against the connection's origin and every request
 * carries the connection's credential, which is what the connection already owns.
 *
 * Nothing about the file vocabulary is declared here. A routing path is read by the protocol's own parser, the answers
 * are the protocol's own shapes, and the refusals are the file surface's own words: this is the client half of
 * `packages/gateway/src/files-surface.ts`, not a second implementation of it.
 *
 * Three things it deliberately does not do. It does not guess an address for a path that names no workspace — the
 * surfaces already know that a conversation without an execution workspace has no files. It does not collect a
 * download: a download is a browser navigation or a native save, and this only names the address for it. And it does
 * not hand out an address after the connection is gone, because a saved file from a closed connection is a file from
 * someone else's Gateway.
 *
 * Which address a connection has at all is the same decision as which bytes it can show: {@link FileSeam.url} answers
 * only where an element's own request carries the credential — a Web page's cookie — and a bearer connection's files
 * come through {@link FileSeam.bytes}. A surface that built an element address on the bearer path would be showing a
 * `401`, so the seam states that difference instead of letting each surface rediscover it.
 */

/** What one file request may name: the kind of answer, and the few parameters the surface reads. */
type FileKind = "list" | "read" | "meta" | "download" | "upload-check" | "upload";

/**
 * How one file's bytes reach a surface on this connection.
 *
 * Two hosts, two paths, and the difference is not a preference. A Web page is served from the same origin it calls, so
 * the browser's own request carries the httpOnly cookie: an `<img>`, a media element or a download navigation is the
 * whole answer, and the bytes stream with the range the element asks for. A packaged App's document is a bundle on
 * `tauri://localhost`, so no element of it can present the device bearer — a relative address would ask the shell for
 * a file it does not serve, and an absolute one would be refused for presenting nothing. Its bytes therefore come
 * through the connection into a leased blob, which is bounded by the lease's own budget and revoked when the surface
 * lets go.
 *
 * A download is the third case and is deliberately not an address on a bearer connection: streaming a large file to
 * disk is the App shell's native save ({@link ./file-save.ts}), not a browser navigation. Naming that difference is what
 * keeps a page from collecting a hundred megabytes into a blob and calling it a download.
 */
export type FileBytes =
  /** The browser's own element request carries this connection's credential. */
  | { readonly kind: "address"; readonly url: string }
  /** The connection fetched the bytes; the lease keeps them and its `release` drops them. */
  | { readonly kind: "lease"; readonly url: string; readonly release: () => void }
  /** This connection cannot put these bytes in a browser element, and why. */
  | { readonly kind: "unsupported"; readonly reason: string };

export interface FileSeam {
  /**
   * The absolute address a browser element may point at, or null when this connection has none.
   *
   * Only a Web page has one: its element's own request carries the httpOnly cookie, so an `<img>`, a media element or a
   * download navigation is the whole answer. A device bearer cannot ride an element, so an address for one would be a
   * request the Gateway answers `401` — {@link FileSeam.bytes} is that connection's path instead. The null is
   * therefore the connection's own statement, not a missing file.
   */
  url(routingPath: string, kind: FileKind): string | null;
  /**
   * One file's bytes as a surface may show them: the browser's own address on a cookie connection, a leased blob on a
   * bearer one. A refusal is a value, because a surface shows the reason instead of an empty frame.
   */
  bytes(routingPath: string, options?: { readonly signal?: AbortSignal }): Promise<FileBytes>;
  /**
   * Where a download navigation may go, or why there is nowhere: a cookie connection's browser saves the stream itself,
   * while an App's save path is its own shell's — `saveFile` in `./file-save.ts`, which reads through this same
   * connection and hands the bytes to the host.
   */
  download(routingPath: string): { readonly kind: "address"; readonly url: string } | { readonly kind: "unsupported"; readonly reason: string };
  /** One directory of the workspace, as the tree renders it. */
  list(routingDirectory: string): Promise<FileListingResponse>;
  /**
   * The text preview of one file: one bounded chunk of it, and the two numbers that say how much of the file that
   * chunk is. The host serves no continuation, so there is no offset to ask for — the viewer shows the bound.
   */
  read(routingPath: string): Promise<FilePreviewResponse>;
  /** One file's size, language and preview kind, before its content is asked for. */
  meta(routingPath: string): Promise<FileMetaResponse>;
  /** The names an upload would meet in one directory, answered before anything is written. */
  checkUpload(routingDirectory: string, fileNames: readonly string[]): Promise<UploadInspectionResponse>;
  /** The changed files of one workspace root. */
  changedFiles(routingCwd: string): Promise<GitStatusResponse>;
  /** One changed file's patch, or the surface's statement that it has none. */
  diff(routingCwd: string, routingPath: string): Promise<GitFileDiffResponse>;
  /** The `@` index: the whole flat listing, or the matches for one query. */
  index(routingCwd: string, query?: string): Promise<FileIndexResponse>;
}

const NOT_A_WORKSPACE = "Only a configured /workspace/<id> path names files this connection can serve";

/**
 * Why an element cannot be the download address on this connection.
 *
 * It is not "this client cannot save": a bearer connection saves through the App shell's native save, which reads this
 * same connection and writes bounded slices. What it cannot do is hand a browser element an address, because no element
 * of a bundle can present the device bearer.
 */
export const NATIVE_SAVE_REQUIRED = "This host saves through the App shell's native save; an element cannot carry this connection's credential";

/** The routing path one answer is about, or the refusal that says it is not one. */
function routingOf(path: string): string {
  if (workspaceRoutingLocation(path) === null) throw new Error(NOT_A_WORKSPACE);
  return path;
}

/** The routing directory an upload or a listing is about. */
function directoryOf(path: string): string {
  const location = workspaceRoutingLocation(path);
  if (location === null) throw new Error(NOT_A_WORKSPACE);
  // A directory's address is its own routing path with no trailing separator, so an upload to a workspace root and one
  // to a folder inside it are two addresses rather than two spellings of one.
  return path.replace(/\/+$/, "");
}

/** The absolute form of one path on this connection, as an element's own attribute needs it. */
function absolute(client: WorkbenchClient, path: string): string {
  return client.origin + path;
}

export function createFileSeam(client: WorkbenchClient): FileSeam {
  return {
    url(routingPath, kind) {
      // A closed connection has no address to give: the next connection is a different Gateway, and an element that
      // saved from it would be saving a file its reader never asked for. Neither has a bearer connection: the address
      // would be one no element can authenticate, which is the request a surface answers 401 for.
      if (client.disposed || client.credential.kind !== "cookie" || workspaceRoutingLocation(routingPath) === null) return null;
      return absolute(client, fileApiPath(routingPath, kind));
    },
    async bytes(routingPath, options) {
      const path = fileApiPath(routingOf(routingPath), "read");
      // A Web page is served from the origin it calls, so the element's own request is authenticated by the browser
      // itself: no fetch here, no blob to keep alive, and the element streams with its own range.
      if (client.credential.kind === "cookie") {
        const url = client.disposed ? null : absolute(client, path);
        return url === null ? { kind: "unsupported", reason: "The connection this file belonged to is closed." } : { kind: "address", url };
      }
      // A device bearer cannot ride an element, so the connection reads the bytes into a leased blob. The lease is the
      // connection's own resource scope: it is bounded, and disposing the connection revokes it.
      const read = await client.resources.image(path, options?.signal === undefined ? {} : { signal: options.signal });
      if (!read.ok) return { kind: "unsupported", reason: BYTES_REFUSAL[read.reason] };
      return { kind: "lease", url: read.value.url, release: read.value.release };
    },
    download(routingPath) {
      if (client.credential.kind !== "cookie") return { kind: "unsupported", reason: NATIVE_SAVE_REQUIRED };
      const url = this.url(routingPath, "download");
      return url === null
        ? { kind: "unsupported", reason: "The connection this file belonged to is closed." }
        : { kind: "address", url };
    },
    async list(routingDirectory) {
      return await client.readJson<FileListingResponse>(fileApiPath(directoryOf(routingDirectory), "list"));
    },
    async read(routingPath) {
      return await client.readJson<FilePreviewResponse>(fileApiPath(routingOf(routingPath), "read"));
    },
    async meta(routingPath) {
      return await client.readJson<FileMetaResponse>(fileApiPath(routingOf(routingPath), "meta"));
    },
    async checkUpload(routingDirectory, fileNames) {
      const answer = await client.readJson<UploadInspectionResponse>(fileApiPath(directoryOf(routingDirectory), "upload-check"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fileNames: [...fileNames] }),
      });
      return { conflicts: answer.conflicts ?? [], nonReplaceable: answer.nonReplaceable ?? [] };
    },
    async changedFiles(routingCwd) {
      const cwd = directoryOf(routingCwd);
      return await client.readJson<GitStatusResponse>("/api/git/status?" + new URLSearchParams({ cwd }).toString());
    },
    async diff(routingCwd, routingPath) {
      const cwd = directoryOf(routingCwd);
      const path = routingOf(routingPath);
      const location = workspaceRoutingLocation(cwd);
      const file = workspaceRoutingLocation(path);
      if (location === null || file === null || location.workspaceId !== file.workspaceId) throw new Error("a diff names one file inside the workspace it is asked about");
      return await client.readJson<GitFileDiffResponse>("/api/git/diff?" + new URLSearchParams({ cwd, path }).toString());
    },
    async index(routingCwd, query) {
      const cwd = directoryOf(routingCwd);
      const search = new URLSearchParams({ cwd });
      if (query !== undefined && query.trim() !== "") search.set("q", query);
      return await client.readJson<FileIndexResponse>("/api/file-index?" + search.toString());
    },
  };
}

/**
 * One upload's own answer, in the browser's vocabulary.
 *
 * It is separate from {@link FileSeam} because it is a different transport and a different reason: a browser reports
 * upload progress only from `XMLHttpRequest`, and the body is a form the page builds itself. Everything else — the
 * address, the credential, the routing path — is the connection's, so it is stated here and nowhere else.
 */
export type UploadOutcome = { readonly status: number; readonly data: UploadBatchResponse };

/** One file of an upload that did not land, as the surface named it. */
export type UploadError = { name: string; error: string };

/**
 * Upload files into one directory of the workspace.
 *
 * The body is a `FormData` of the caller's own `File`s, which is what makes this path portable: WebKitGTK refuses a
 * `ReadableStream` request body, so an App cannot stream an upload from the page at all, while a `Blob` body is
 * accepted everywhere the browser is. The batch bound the file surface enforces is what keeps what the page hands over
 * bounded; the bytes are not collected a second time here.
 *
 * @param client The connection this upload belongs to
 * @param routingDirectory The routing directory the files are written to
 * @param files The files, written under their own names
 * @param strategy What the surface does with a name that already exists
 * @param onProgress Upload progress in percent, when the browser reports it
 */
export function uploadFiles(
  client: WorkbenchClient,
  routingDirectory: string,
  files: File[],
  strategy: UploadConflictStrategy,
  onProgress?: (progress: number) => void,
): Promise<UploadOutcome> {
  return new Promise((resolve, reject) => {
    if (client.disposed) { reject(new Error("The connection this upload belonged to is closed.")); return; }
    const directory = directoryOf(routingDirectory);
    const formData = new FormData();
    files.forEach((file) => formData.append("files", file, file.name));

    const xhr = new XMLHttpRequest();
    xhr.open("POST", absolute(client, fileApiPath(directory, "upload") + "&conflict=" + strategy));
    // The credential is the connection's: a Web page's httpOnly cookie goes by itself, and an App's device bearer is
    // the one header this page may set. It is never a service token, and it never appears in the address.
    const credential = client.credential;
    if (credential.kind === "bearer") xhr.setRequestHeader("authorization", "Bearer " + credential.token);
    xhr.upload.onprogress = (event) => {
      if (onProgress && event.lengthComputable && event.total > 0) {
        onProgress(Math.round((event.loaded / event.total) * 100));
      }
    };
    xhr.onerror = () => reject(new Error("Network error while uploading files"));
    xhr.onabort = () => reject(new Error("Upload cancelled"));
    xhr.onload = () => {
      let data: UploadBatchResponse = {};
      try {
        data = JSON.parse(xhr.responseText) as UploadBatchResponse;
      } catch {
        if (xhr.responseText) data.error = xhr.responseText;
      }
      resolve({ status: xhr.status, data });
    };
    xhr.send(formData);
  });
}

/** Why a leased read was refused, in the words a surface can show. */
const BYTES_REFUSAL: Readonly<Record<string, string>> = {
  unauthorized: "This connection is not accepted by the Gateway any more.",
  forbidden: "The Gateway refused this file for this identity.",
  not_found: "The Gateway has no such file.",
  oversize: "This file is larger than this client holds in memory, so it cannot be shown here.",
  unavailable: "The Gateway could not be reached for this file.",
  disposed: "The connection this file belonged to is closed.",
};
