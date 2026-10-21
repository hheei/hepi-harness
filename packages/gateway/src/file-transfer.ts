import type { FileInfo } from "@earendil-works/pi-durable/env";
import { MAX_FILE_BYTES, type FileRequest, type FilesystemServer } from "./filesystem.ts";

/**
 * The file payload routes: one file in, or one file out, as bytes.
 *
 * The file RPC on `/v1/files` carries content inside a JSON request, and its reader caps that request at 1 MiB — about
 * 768 KiB of file once base64 has inflated it — against a file policy of `MAX_FILE_BYTES`. These routes move the same
 * files as a body instead: the bytes are streamed in bounded chunks, so a file larger than one JSON request arrives
 * whole, no hop holds a whole file it does not have to, and the ceiling that applies to one payload is unchanged.
 *
 * The host work is the file RPC's own: every read and every write below is one `execute` call on the filesystem the
 * gateway already serves, so a local workspace and an SSH workspace apply one set of rules and the same confinement.
 */

/** The most one uploaded file may be: the same ceiling the file RPC applies to one payload. */
export const MAX_UPLOAD_BYTES = MAX_FILE_BYTES;
/** How much of a request body is held at once while an upload is written to the host. */
export const UPLOAD_CHUNK_BYTES = 512 * 1024;
/** How much of a file is held at once while a download is streamed back. */
export const DOWNLOAD_CHUNK_BYTES = 512 * 1024;

export const UPLOAD_CONFLICT_STRATEGIES = ["error", "overwrite", "skip"] as const;
export type UploadConflictStrategy = typeof UPLOAD_CONFLICT_STRATEGIES[number];

/** The strategy a request asked for, or null when it named one this surface does not serve. */
export function parseUploadConflict(value: string | null): UploadConflictStrategy | null {
  const candidate = value ?? "error";
  return (UPLOAD_CONFLICT_STRATEGIES as readonly string[]).includes(candidate) ? candidate as UploadConflictStrategy : null;
}

type Failure = { ok: false; error: { code: string; message: string } };
type Result<T> = { ok: true; value: T } | Failure;

function failure(code: string, message: string): Failure {
  return { ok: false, error: { code, message } };
}

/** One `execute` call on the host's filesystem, in this module's result shape. */
async function call<T>(files: FilesystemServer, request: FileRequest): Promise<Result<T>> {
  return await files.execute(request) as Result<T>;
}

/** A name a caller may write into a directory: no separators, and never the directory itself or its parent. */
function plainName(name: string): boolean {
  return name !== "" && name !== "." && name !== ".." && !name.includes("/") && !name.includes("\\") && !name.includes("\0");
}

/** The workspace path a directory and a file name make, or undefined when the name is not one file's own name. */
export function uploadPath(directory: string, name: string): string | undefined {
  if (!plainName(name)) return undefined;
  if (directory === "" || directory === "/") return "/" + name;
  return directory.replace(/\/+$/, "") + "/" + name;
}

/** A file's own name inside a workspace path, or undefined when the path names no file. */
export function fileNameOf(path: string): string | undefined {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return plainName(name) ? name : undefined;
}

export type UploadInspection = { conflicts: string[]; nonReplaceable: string[] };

/**
 * Which of these names already exist in the directory, and which of those are not a regular file or are a symbolic
 * link — the two questions the copied upload library asks of its own local directory, asked here of the host that
 * holds the directory. The host's own `fileInfo` reports a link as a link, so a name that is a link is never treated
 * as the file it points at.
 */
export async function inspectUpload(files: FilesystemServer, workspaceId: string, directory: string, names: readonly string[]): Promise<Result<UploadInspection>> {
  const conflicts: string[] = [];
  const nonReplaceable: string[] = [];
  for (const name of names) {
    const path = uploadPath(directory, name);
    if (path === undefined) return failure("invalid_request", "a file name must be one name, without a path: " + name);
    const info = await call<FileInfo>(files, { workspaceId, method: "fileInfo", path });
    if (!info.ok) {
      if (info.error.code === "not_found") continue;
      return info;
    }
    conflicts.push(name);
    if (info.value.kind !== "file") nonReplaceable.push(name);
  }
  return { ok: true, value: { conflicts, nonReplaceable } };
}

export type UploadOutcome = { path: string; size: number; skipped: boolean };
export type UploadConflict = { conflicts: string[]; nonReplaceable: string[] };

/**
 * One file from a request body to the host, with the conflict rules the copied upload route enforced on its own
 * directory: `error` refuses the whole request before anything is written, `skip` leaves an existing name alone, and
 * `overwrite` replaces a regular file — but never a directory or a symbolic link, whose contents are not this file's
 * to replace.
 *
 * The bytes land in a temporary file the host creates and are renamed over the target only once the whole body
 * arrived, so a refused or interrupted upload leaves no partial file, and the ceiling is enforced while streaming
 * rather than after the fact. A replacement keeps the target's own permissions: the staging file is private, and a
 * file that was executable must not come back without its mode.
 */
export async function uploadFile(
  files: FilesystemServer,
  workspaceId: string,
  path: string,
  strategy: UploadConflictStrategy,
  body: AsyncIterable<Uint8Array>,
): Promise<Result<UploadOutcome> | { ok: false; error: { code: "conflict"; message: string }; conflict: UploadConflict }> {
  const name = fileNameOf(path);
  if (name === undefined || !path.startsWith("/")) return failure("invalid_request", "an upload names one file inside the workspace: " + path);
  const directory = path.slice(0, path.length - name.length - 1) === "" ? "/" : path.slice(0, path.length - name.length - 1);

  const parent = await call<FileInfo>(files, { workspaceId, method: "fileInfo", path: directory });
  if (!parent.ok) return parent.error.code === "not_found" ? failure("unknown_directory", "no such directory in this workspace: " + directory) : parent;
  if (parent.value.kind !== "directory") return failure("unknown_directory", "not a directory in this workspace: " + directory);

  const existing = await call<FileInfo>(files, { workspaceId, method: "fileInfo", path });
  const present = existing.ok ? existing.value : undefined;
  if (existing.ok === false && existing.error.code !== "not_found") return existing;
  if (present !== undefined) {
    const replaceable = present.kind === "file";
    if (strategy === "error") {
      return { ok: false, error: { code: "conflict", message: "the file already exists" }, conflict: { conflicts: [path], nonReplaceable: replaceable ? [] : [path] } };
    }
    if (strategy === "skip") return { ok: true, value: { path, size: present.size, skipped: true } };
    if (!replaceable) return failure("not_replaceable", "cannot replace " + (present.kind === "directory" ? "a directory" : "a symbolic link") + ": " + path);
  }

  const temporary = await call<string>(files, { workspaceId, method: "createTempFile", prefix: ".hepi-upload-", suffix: ".tmp" });
  if (!temporary.ok) return temporary;
  const staged = temporary.value;

  let size = 0;
  let pending: Uint8Array[] = [];
  let pendingBytes = 0;
  let committed = false;
  const flush = async (): Promise<Failure | undefined> => {
    if (pendingBytes === 0) return undefined;
    const chunk = Buffer.concat(pending, pendingBytes);
    pending = [];
    pendingBytes = 0;
    const written = await call(files, { workspaceId, method: "appendFile", path: staged, content: chunk.toString("base64"), encoding: "base64" });
    return written.ok ? undefined : { ok: false, error: { code: written.error.code, message: written.error.message } };
  };

  try {
    for await (const piece of body) {
      if (piece.byteLength === 0) continue;
      size += piece.byteLength;
      if (size > MAX_UPLOAD_BYTES) return failure("file_too_large", "a file may be at most " + MAX_UPLOAD_BYTES + " bytes");
      pending.push(piece);
      pendingBytes += piece.byteLength;
      if (pendingBytes >= UPLOAD_CHUNK_BYTES) {
        const failed = await flush();
        if (failed !== undefined) return failed;
      }
    }
    const flushed = await flush();
    if (flushed !== undefined) return flushed;

    const renamed = await call(files, { workspaceId, method: "renameFile", path: staged, destinationPath: path, options: { preserveMode: present !== undefined } });
    if (!renamed.ok) return { ok: false, error: { code: renamed.error.code, message: renamed.error.message } };
    committed = true;
    return { ok: true, value: { path, size, skipped: false } };
  } finally {
    // Every way out above, and the body's own throw: a refused request, a body that dies mid-flight and a transport
    // that goes away all leave the staging file this request created, and only this request may leave it behind.
    if (!committed) await call(files, { workspaceId, method: "remove", path: staged, options: { force: true } });
  }
}

export type DownloadRange = { offset: number; length: number };
export type DownloadRangeResult = { ok: true; range: DownloadRange } | { ok: false; code: "invalid_range" | "unsatisfiable_range"; message: string };

/**
 * The one range a request asked for, clamped to the file it names. No header is the whole file; a suffix range counts
 * back from the end; an end past the file is clamped, as HTTP requires. More than one range is refused rather than
 * half-served, and a range that starts at or past the end is unsatisfiable.
 */
export function parseDownloadRange(value: string | null, size: number): DownloadRangeResult {
  if (value === null || value.trim() === "") return { ok: true, range: { offset: 0, length: size } };
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (match === null) return { ok: false, code: "invalid_range", message: "one byte range is served, as bytes=start-end" };
  const [, startText, endText] = match;
  if (startText === "" && endText === "") return { ok: false, code: "invalid_range", message: "a byte range names a start or a length" };
  if (startText === "") {
    const suffix = Number(endText);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return { ok: false, code: "invalid_range", message: "a suffix range needs a positive length" };
    const length = Math.min(suffix, size);
    return { ok: true, range: { offset: size - length, length } };
  }
  const offset = Number(startText);
  if (!Number.isSafeInteger(offset) || offset < 0) return { ok: false, code: "invalid_range", message: "a byte range starts at a non-negative offset" };
  if (offset >= size) return { ok: false, code: "unsatisfiable_range", message: "the range starts past the end of the file" };
  const end = endText === "" ? size - 1 : Number(endText);
  if (!Number.isSafeInteger(end) || end < offset) return { ok: false, code: "invalid_range", message: "a byte range ends at or after its start" };
  return { ok: true, range: { offset, length: Math.min(end, size - 1) - offset + 1 } };
}

/**
 * One host refusal, as the browser's payload route answers it.
 *
 * The status and the code are the host's own and stay untouched — they are what a caller classifies. The words are not
 * always safe to repeat. A failure the host found on disk carries the host's *filesystem* path, in its message and in
 * its `path` field: the temporary directory a local workspace was registered with, or the remote root a profile points
 * at. Every hop above this one passes the message on as it arrived, so that path reaches the browser. The caller named
 * the file it asked for, so the answer that reaches it says what went wrong about *that* path, in the workspace's own
 * vocabulary — never where the workspace lives on its host.
 *
 * Two things decide whether a message is rewritten at all. Only a code from the host's own failure vocabulary can have
 * come from its disk — this module's refusals (`file_too_large`, `not_replaceable`, `unknown_directory`,
 * `invalid_request`, `not_a_file`, the two range codes) are worded here, already speak in workspace paths, and pass
 * through untouched. And a host failure whose words name no absolute path (a byte limit, a link it will not follow, a
 * path outside the workspace it refused without naming it) is the host's own reason and is passed through as it is.
 *
 * The general `/v1/files` surface keeps reporting real host paths, because the execution tools that call it act on
 * them (ADR 0002). This is the browser-facing payload route, where a host path is nothing a caller can use.
 */
const HOST_PATH = /[\s:=,"'](\/[^\s"',]+)/;

/** The failure codes only a host answer carries; the rest of this module's refusals are worded here. */
const HOST_CODES: ReadonlySet<string> = new Set(["aborted", "not_found", "permission_denied", "not_directory", "is_directory", "invalid", "not_supported", "unknown"]);

/** Whether this host answer states a path on the host's own filesystem. */
function namesHostPath(error: { code: string; message: string; path?: string }): boolean {
  if (!HOST_CODES.has(error.code)) return false;
  return (error.path !== undefined && error.path.startsWith("/")) || HOST_PATH.test(error.message);
}

/** What the host's refusal means about the file the caller named. */
function publicReason(code: string, path: string): string {
  switch (code) {
    case "not_found": return "no such file in this workspace: " + path;
    case "not_directory": return "not a directory in this workspace: " + path;
    case "is_directory": case "not_a_file": return "not a regular file in this workspace: " + path;
    case "aborted": return "the file operation was cancelled";
    case "not_supported": return "this host does not support that file operation";
    case "unknown": return "the host could not answer for this file";
    default: return "the host refused this file";
  }
}

/**
 * A host's refusal adopted as this route's own answer: the host's code, and words that state no host filesystem path.
 * `named` is the path the caller asked about, which is the only path its answer may speak of.
 */
export function hostFailure<T extends { code: string; message: string; path?: string }>(error: T, named: string): { code: string; message: string } {
  if (!namesHostPath(error)) return { code: error.code, message: error.message };
  return { code: error.code, message: publicReason(error.code, named) };
}

export type Download = { handle: string; size: number; offset: number; length: number };

/**
 * Open one file for streaming: its size, the range that will be served, and the host's own reader handle. A file over
 * the ceiling is refused with a named limit instead of being streamed unbounded, and a directory or a link is refused
 * before a reader is opened for it.
 */
export async function openDownload(files: FilesystemServer, workspaceId: string, path: string, range: string | null): Promise<Result<Download> | { ok: false; error: { code: "invalid_range" | "unsatisfiable_range"; message: string } }> {
  const info = await call<FileInfo>(files, { workspaceId, method: "fileInfo", path });
  if (!info.ok) return info;
  if (info.value.kind !== "file") return failure("not_a_file", "not a regular file in this workspace: " + path);
  if (info.value.size > MAX_UPLOAD_BYTES) return failure("file_too_large", "a file may be at most " + MAX_UPLOAD_BYTES + " bytes");
  const parsed = parseDownloadRange(range, info.value.size);
  if (!parsed.ok) return { ok: false, error: { code: parsed.code, message: parsed.message } };
  const opened = await call<string>(files, { workspaceId, method: "openBinaryReader", path, options: { noFollow: true } });
  if (!opened.ok) return opened;
  return { ok: true, value: { handle: opened.value, size: info.value.size, offset: parsed.range.offset, length: parsed.range.length } };
}
