import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import type { SshRunner, SshRunnerRequest } from "../src/index.ts";
import { REMOTE_INSTALL_SCRIPT, sameDigests } from "../src/install.ts";

/**
 * A stand-in execution host for the installation capability.
 *
 * The gateway never installs a skill itself: it sends `REMOTE_INSTALL_SCRIPT` to the host as one base64 program and
 * reads one JSON answer per helper call. `REMOTE_INSTALL_SCRIPT` is the only producer of those answers, so a test that
 * stands in for a host has to answer as that program would. This file is that program's rules — scope confinement,
 * slug and path validation, staging, the pinned-digest replacement, backups, the lock document and the frontmatter
 * edit — executed directly against this process's filesystem, which is what lets an installation test run without a
 * process, a network, a poll or a sleep.
 *
 * It is deliberately not the production implementation and never runs in it: the production remote path stays the
 * Python program, and the tests that own that path keep running it through `pythonSshRunner`
 * (`apps/server/test/skill-install.test.ts`, `packages/gateway/test/ssh-resources.test.ts`, and the rest).
 * `packages/gateway/test/install.test.ts` compares this stand-in's answer with the local host's on every frontmatter
 * shape and both scopes, which is what keeps the two from drifting.
 *
 * Two host behaviours are modelled rather than reproduced: the account is a parameter instead of a `pwd` lookup, and
 * the per-destination `flock` guards are not files here — a stand-in answers one call at a time, and the one
 * concurrency the tests exercise (concurrent lock records) is serialized explicitly below.
 */

const BACKUP_SUFFIX = ".bak";

/** One named refusal, in the shape the helper's own `fail` emits. */
export type RemoteInstallFailure = { readonly ok: false; readonly error: { readonly code: string; readonly message: string } };

/** The helper's own answer for one call: what `REMOTE_INSTALL_SCRIPT` writes to stdout. */
export type RemoteInstallAnswer = { readonly ok: true; readonly value?: unknown } | RemoteInstallFailure;

/** One refusal, thrown so a nested check can end the call where the program's own `fail` does. */
class Refusal extends Error {
  readonly answer: RemoteInstallFailure;
  constructor(answer: RemoteInstallFailure) { super(answer.error.message); this.answer = answer; }
}

function fail(code: string, message: string): never { throw new Refusal({ ok: false, error: { code, message } }); }

function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error); }

function sha256(value: string | Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }

function present(path: string): boolean {
  try { lstatSync(path); return true; } catch { return false; }
}

function isLink(path: string): boolean {
  try { return lstatSync(path).isSymbolicLink(); } catch { return false; }
}

function within(parent: string, child: string): boolean {
  return child === parent || child.startsWith(parent.replace(/[\\/]+$/, "") + sep);
}

function digestFile(path: string): string { return sha256(readFileSync(path)); }

/** Every entry of one directory: a file's sha256, a link's target digest, or the fact that it is neither. */
function directoryDigests(base: string): Record<string, string> {
  const entries: Record<string, string> = {};
  const walk = (current: string): void => {
    for (const name of readdirSync(current).sort()) {
      const path = join(current, name);
      const key = relative(base, path).split(sep).join("/");
      const info = lstatSync(path);
      if (info.isSymbolicLink()) entries[key] = "link:" + sha256(readlinkSync(path));
      else if (info.isDirectory()) walk(path);
      else if (info.isFile()) entries[key] = digestFile(path);
      else entries[key] = "other";
    }
  };
  walk(base);
  return entries;
}

function folderHash(entries: Readonly<Record<string, string>>): string {
  const hash = createHash("sha256");
  for (const path of Object.keys(entries).sort()) hash.update(path + "\u0000" + entries[path] + "\n");
  return hash.digest("hex");
}

/** One frontmatter line: its text without the line break, and its span in the head, break included in `end`. */
type Line = { readonly text: string; readonly start: number; readonly end: number };

const KEY = "disable-model-invocation";
const OPENING = /^\uFEFF?---[ \t]*(\r\n|\n|\r)/;
const CLOSING = /(?:^|(\r\n|\n|\r))---/;
const KEY_LINE = /^([ \t]*)((?:"disable-model-invocation"|'disable-model-invocation'|disable-model-invocation)[ \t]*:)([^\r\n]*)$/;
const ANY_KEY = /^[ \t]*(?:[^ \t:\r\n]+|"[^"\r\n]+"|'[^'\r\n]+')[ \t]*:/;
const indentation = (text: string): number => /^[ \t]*/.exec(text)![0].length;

function frontmatterLines(head: string): Line[] {
  const lines: Line[] = [];
  let start = 0;
  for (let index = 0; index < head.length; index += 1) {
    const char = head[index];
    if (char === "\n") { lines.push({ text: head.slice(start, index), start, end: index + 1 }); start = index + 1; continue; }
    if (char !== "\r") continue;
    const end = head[index + 1] === "\n" ? index + 2 : index + 1;
    lines.push({ text: head.slice(start, index), start, end });
    index = end - 1;
    start = end;
  }
  if (start < head.length) lines.push({ text: head.slice(start), start, end: head.length });
  return lines;
}

/** The block's own key level and the key's own line, or nothing when no top-level key can exist there. */
function blockShape(lines: readonly Line[]): { readonly base: number; readonly own: readonly Line[] } | undefined {
  const filled = lines.filter((line) => line.text.trim() !== "" && !line.text.trim().startsWith("#"));
  if (filled.length === 0) return { base: 0, own: [] };
  const keys = filled.filter((line) => ANY_KEY.test(line.text));
  if (keys.length === 0) return undefined;
  const base = Math.min(...keys.map((line) => indentation(line.text)));
  const atBase = filled.filter((line) => indentation(line.text) === base);
  // A line at the block's own level that names no key is a sequence entry, a flow mapping or a scalar: a key written
  // there would not be a sibling of the mapping.
  if (atBase.some((line) => !ANY_KEY.test(line.text))) return undefined;
  const own = atBase.filter((line) => KEY_LINE.test(line.text));
  if (own.length > 1) return undefined;
  return { base, own };
}

/** The document with the key set to `disable`: the same surgical edit `src/skill-frontmatter.ts` makes. */
function setFrontmatterKey(content: string, disable: boolean): string {
  const opening = OPENING.exec(content);
  if (opening === null) {
    if (!disable) return content;
    const bom = content.startsWith("\uFEFF") ? "\uFEFF" : "";
    const body = bom === "" ? content : content.slice(1);
    if (body.startsWith("---")) fail("invalid", "the skill document's frontmatter cannot be edited");
    return bom + "---\n" + KEY + ": true\n---\n" + body;
  }
  const rest = content.slice(opening[0].length);
  const closing = CLOSING.exec(rest);
  if (closing === null) fail("invalid", "the skill document's frontmatter cannot be edited");
  const openingEnd = opening[0].length;
  const head = content.slice(openingEnd, openingEnd + closing.index + (closing[1]?.length ?? 0));
  const shape = blockShape(frontmatterLines(head));
  if (shape === undefined) fail("invalid", "the skill document's frontmatter cannot be edited");
  if (shape.own.length === 0) {
    if (!disable) return content;
    return content.slice(0, openingEnd) + " ".repeat(shape.base) + KEY + ": true" + opening[1] + content.slice(openingEnd);
  }
  const own = shape.own[0]!;
  // The line break that ended the key line travels with its span, so it is carried over explicitly and the next line
  // keeps exactly one break in front of it, as the local host's edit does.
  const replacement = disable ? own.text.replace(KEY_LINE, "$1$2 true") + head.slice(own.start + own.text.length, own.end) : "";
  return content.slice(0, openingEnd) + head.slice(0, own.start) + replacement + head.slice(own.end) + content.slice(openingEnd + head.length);
}

/** One turn of the event loop, so two interleaved helper calls really interleave rather than nesting. */
const turn = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve));

const queues = new Map<string, Promise<unknown>>();

/** One host-side critical section per key, the way the helper's `flock` serializes writers of one path. */
function serialized<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  const next = previous.then(work, work);
  queues.set(key, next.then(() => undefined, () => undefined));
  return next;
}

export type RemoteInstallOptions = {
  /** The account the stand-in host serves: `global` scope installs under its home. */
  readonly home: string;
  /** The profile's root, which the gateway sends as the helper's own confinement root. */
  readonly root: string;
  readonly mode: string;
  readonly args: readonly string[];
};

/** One helper call, answered the way the host's own program answers it. */
export async function remoteInstall(options: RemoteInstallOptions): Promise<RemoteInstallAnswer> {
  try {
    return await run(options);
  } catch (error) {
    if (error instanceof Refusal) return error.answer;
    // The program's own two handlers: an `OSError` is an unknown host failure, a `ValueError` an invalid request.
    if (typeof (error as { code?: unknown }).code === "string") return { ok: false, error: { code: "unknown", message: messageOf(error) } };
    if (error instanceof SyntaxError) return { ok: false, error: { code: "invalid", message: messageOf(error) } };
    throw error;
  }
}

async function run(options: RemoteInstallOptions): Promise<RemoteInstallAnswer> {
  const root = realpathSync(options.root);
  const mode = options.mode;
  const args = options.args;

  const accountHome = (): string => {
    const resolved = existsSync(options.home) ? realpathSync(options.home) : "";
    if (resolved === "") fail("unknown", "the remote host reported an incomplete execution account");
    return resolved;
  };

  const authorizedRoot = (scope: string): string => {
    if (scope === "global") return accountHome();
    if (scope === "workspace") return root;
    return fail("invalid", "unknown installation scope: " + scope);
  };

  const confinedScope = (scope: string): string => {
    const base = authorizedRoot(scope);
    let current = base;
    for (const part of [".agents", "skills"]) {
      const next = join(current, part);
      if (!present(next)) { mkdirSync(next, { recursive: true }); current = realpathSync(next); continue; }
      const real = realpathSync(next);
      if (!within(base, real)) fail("permission_denied", "the installation scope resolves outside " + base);
      current = real;
    }
    return current;
  };

  const lockPath = (scope: string): string => join(dirname(confinedScope(scope)), ".skill-lock.json");

  const moveToBackup = (scopeRoot: string, destination: string, directory: string): string => {
    const parent = dirname(scopeRoot);
    const realParent = realpathSync(parent);
    if (realParent !== parent) fail("permission_denied", "the backup location resolves outside " + parent);
    let target = join(parent, directory + BACKUP_SUFFIX);
    let counter = 1;
    while (present(target)) { target = join(realParent, directory + "." + counter + BACKUP_SUFFIX); counter += 1; }
    try {
      renameSync(destination, target);
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") fail("conflict", "the installed directory was replaced by another request");
      throw error;
    }
    return target;
  };

  const slug = (value: string, what: string): string => {
    if (value === "" || value.length > 64 || !/^[a-z0-9][a-z0-9-]*$/.test(value)) fail("invalid", "a skill " + what + " is a lowercase slug");
    return value;
  };

  const relParts = (path: string): string[] => {
    if (path === "" || path.length > 256 || path.startsWith("/") || path.includes("\\") || path.endsWith("/")) fail("invalid", "bundle file paths stay inside the skill directory: " + path);
    const parts = path.split("/");
    if (parts.some((part) => part === "" || part === "." || part === "..")) fail("invalid", "bundle file paths stay inside the skill directory: " + path);
    const last = parts[parts.length - 1]!;
    if ((last === "SKILL.md" && parts.length !== 1) || (last !== "SKILL.md" && last.toLowerCase() === "skill.md")) fail("invalid", "bundle file paths stay inside the skill directory: " + path);
    return parts;
  };

  const knownStaging = (staging: string): string => {
    const real = realpathSync(staging);
    if (!basename(real).startsWith(".hepi-install-") || !statSync(real).isDirectory()) fail("invalid", "unknown install staging directory");
    for (const scope of ["global", "workspace"]) if (dirname(real) === confinedScope(scope)) return real;
    return fail("invalid", "unknown install staging directory");
  };

  const validEntry = (entry: unknown): boolean => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return false;
    const record = entry as Record<string, unknown>;
    if (typeof record.source !== "string" || record.source === "") return false;
    if (record.sourceType !== "repository" && record.sourceType !== "github" && record.sourceType !== "local") return false;
    if (typeof record.skillPath !== "string" || !record.skillPath.startsWith("/")) return false;
    if (record.scope !== "global" && record.scope !== "workspace") return false;
    if (typeof record.installedAtMs !== "number" || !Number.isFinite(record.installedAtMs)) return false;
    if (!/^[0-9a-f]{64}$/.test(String(record.contentHash))) return false;
    const files = record.files;
    if (files === null || typeof files !== "object" || Array.isArray(files)) return false;
    const entries = Object.entries(files as Record<string, unknown>);
    if (entries.length === 0) return false;
    for (const [path, value] of entries) {
      if (!/^[0-9a-f]{64}$/.test(String(value))) return false;
      try { relParts(path); } catch (error) { if (error instanceof Refusal) return false; throw error; }
    }
    return true;
  };

  const lockFile = (scope: string): string => {
    const path = lockPath(scope);
    if (isLink(path) || (present(path) && !statSync(path).isFile())) fail("invalid", "the install lock at " + path + " is not a regular file");
    return path;
  };

  const readLock = (scope: string): { version: 1; skills: Record<string, unknown> } | null => {
    const path = lockFile(scope);
    if (!existsSync(path)) return null;
    let document: unknown;
    try {
      document = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      fail("invalid", "the install lock at " + path + " is not a lock document this gateway can extend");
    }
    const candidate = document as { version?: unknown; skills?: unknown } | null;
    if (candidate === null || typeof candidate !== "object" || candidate.version !== 1 || candidate.skills === null || typeof candidate.skills !== "object" || Array.isArray(candidate.skills)) {
      fail("invalid", "the install lock at " + path + " is not a lock document this gateway can extend");
    }
    for (const [name, entry] of Object.entries(candidate.skills as Record<string, unknown>)) {
      if (!/^[a-z0-9][a-z0-9-]*$/.test(name) || !validEntry(entry)) fail("invalid", "the install lock at " + path + " holds an entry this gateway cannot extend");
    }
    return candidate as { version: 1; skills: Record<string, unknown> };
  };

  const decode = (value: string): Buffer => {
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value)) fail("invalid", "the helper was handed bytes it cannot decode");
    return Buffer.from(value, "base64");
  };

  const expectOf = (value: string | undefined): Record<string, string> | undefined =>
    value === undefined || value === "" ? undefined : JSON.parse(Buffer.from(value, "base64").toString("utf8")) as Record<string, string>;

  const toggleDocument = (scope: string, directory: string, disable: boolean): { changed: boolean } => {
    const realScope = confinedScope(scope);
    const path = join(realScope, directory);
    if (!present(path)) fail("not_found", "no installed directory at " + path);
    if (isLink(path) || !statSync(path).isDirectory()) fail("permission_denied", "the installed directory is not a directory this host can edit");
    const document = join(path, "SKILL.md");
    if (!present(document)) fail("not_found", "no skill document at " + document);
    if (isLink(document) || !statSync(document).isFile()) fail("permission_denied", "the skill document is not a regular file this host can edit");
    const content = readFileSync(document, "utf8");
    const updated = setFrontmatterKey(content, disable);
    // A document already in the requested state is not written at all: its mtime, and its inode, stay as they were.
    if (updated === content) return { changed: false };
    const temporary = join(path, ".SKILL-" + randomUUID() + ".tmp");
    writeFileSync(temporary, updated, { encoding: "utf8", mode: statSync(document).mode & 0o777 });
    renameSync(temporary, document);
    return { changed: true };
  };

  switch (mode) {
    case "publish_begin": {
      const scope = args[0]!;
      const directory = slug(args[1]!, "directory name");
      const overwrite = args[2] === "1";
      const realScope = confinedScope(scope);
      const destination = join(realScope, directory);
      if (present(destination) && !overwrite) fail("conflict", "a skill directory already exists at " + destination);
      const staging = mkdtempSync(join(realScope, ".hepi-install-"));
      return { ok: true, value: { staging, destination } };
    }
    case "publish_file": {
      const staging = knownStaging(args[0]!);
      const parts = relParts(args[1]!);
      const data = decode(args[2]!);
      let current = staging;
      for (const part of parts.slice(0, -1)) {
        current = join(current, part);
        if (isLink(current)) fail("permission_denied", "refusing to write through a symbolic link");
        mkdirSync(current, { recursive: true });
      }
      const target = join(current, parts[parts.length - 1]!);
      if (isLink(target)) fail("permission_denied", "refusing to write through a symbolic link");
      writeFileSync(target, data, { flag: args[3] === "1" ? "a" : "w" });
      const real = realpathSync(target);
      if (real !== staging && !within(staging, real)) fail("permission_denied", "the staged file did not stay inside the staging directory");
      return { ok: true };
    }
    case "publish_commit": {
      const staging = knownStaging(args[0]!);
      const scope = args[1]!;
      const directory = slug(args[2]!, "directory name");
      const expect = expectOf(args[3]);
      const realScope = confinedScope(scope);
      const destination = join(realScope, directory);
      let backup: string | null = null;
      // The destination is re-read here, immediately before it is replaced, so an edit that arrived while this request
      // was staging is refused instead of being silently discarded.
      if (present(destination)) {
        if (expect !== undefined) {
          if (isLink(destination) || !statSync(destination).isDirectory()) fail("conflict", "the installed directory is no longer a directory that can be replaced");
          if (!sameDigests(directoryDigests(destination), expect)) fail("conflict", "the installed directory changed since it was inspected");
        }
        backup = moveToBackup(realScope, destination, directory);
      }
      try {
        renameSync(staging, destination);
      } catch (error) {
        if (backup !== null && !present(destination)) renameSync(backup, destination);
        throw error;
      }
      const real = realpathSync(destination);
      if (dirname(real) !== realScope || isLink(destination)) fail("permission_denied", "the published directory did not stay inside " + realScope);
      return { ok: true, value: { path: real, backup } };
    }
    case "publish_abort":
      rmSync(knownStaging(args[0]!), { recursive: true, force: true });
      return { ok: true };
    case "inspect": {
      const scope = args[0]!;
      const directory = slug(args[1]!, "directory name");
      const path = join(confinedScope(scope), directory);
      if (!present(path)) fail("not_found", "no installed directory at " + path);
      if (isLink(path) || !statSync(path).isDirectory()) fail("permission_denied", "the installed directory is not a directory this host can inspect");
      const entries = directoryDigests(path);
      return { ok: true, value: { path: realpathSync(path), files: entries, contentHash: folderHash(entries) } };
    }
    case "toggle":
      return { ok: true, value: toggleDocument(args[0]!, slug(args[1]!, "directory name"), args[2] === "1") };
    case "lock_read":
      return { ok: true, value: readLock(args[0]!) };
    case "lock_record": {
      const scope = args[0]!;
      const name = slug(args[1]!, "name");
      const entry = JSON.parse(Buffer.from(args[2]!, "base64").toString("utf8"));
      if (!validEntry(entry)) fail("invalid", "the install record is not a lock entry");
      const path = lockFile(scope);
      mkdirSync(dirname(path), { recursive: true });
      // One writer at a time per lock path, which is what the host's own `flock` gives: two interleaved read-merge-write
      // cycles would otherwise each write a document that lacks the other's entry.
      return await serialized<RemoteInstallAnswer>(path, async () => {
        await turn();
        const document = readLock(scope) ?? { version: 1 as const, skills: {} as Record<string, unknown> };
        document.skills[name] = entry;
        const temporary = join(dirname(path), ".skill-lock-" + randomUUID() + ".tmp");
        writeFileSync(temporary, JSON.stringify(document, null, 2) + "\n", { mode: 0o600 });
        renameSync(temporary, path);
        return { ok: true, value: document };
      });
    }
    default:
      return fail("not_supported", "unknown installation operation: " + mode);
  }
}

/** The helper call one gateway request carries, checked against the program the capability actually sends. */
export function helperCall(request: SshRunnerRequest): { readonly mode: string; readonly args: readonly string[] } {
  assert.equal(request.command[0], "python3", "an installation call runs the host's Python 3");
  assert.equal(request.command[1], "-c");
  assert.equal(Buffer.from(request.command[3]!, "base64").toString("utf8"), REMOTE_INSTALL_SCRIPT, "the request carries the installation helper program");
  assert.equal(request.command[4], request.root, "the helper is pinned to the profile's root");
  const [mode, ...args] = request.command.slice(5);
  return { mode: mode!, args };
}

export type FakeInstallHostOptions = {
  readonly home: string;
  readonly root: string;
  /** Answer one helper call with a lost response instead of the host's own answer, for the unknown-outcome path. */
  readonly loseResponse?: (mode: string) => boolean;
};

export type FakeInstallHost = {
  readonly runner: SshRunner;
  /** Every request the transport was handed, so a test can assert what the gateway sent. */
  readonly requests: SshRunnerRequest[];
  /** The helper mode of every call the transport answered, in order. */
  readonly modes: string[];
};

/**
 * A controlled SSH transport whose host is the stand-in above: the gateway's own request shape, the gateway's own
 * helper program, and an answer from the host's own rules, with no process and no network in between.
 */
export function fakeInstallHost(options: FakeInstallHostOptions): FakeInstallHost {
  const requests: SshRunnerRequest[] = [];
  const modes: string[] = [];
  const runner: SshRunner = {
    execute: async (request) => {
      requests.push(request);
      const call = helperCall(request);
      modes.push(call.mode);
      if (options.loseResponse?.(call.mode) === true) throw Object.assign(new Error("lost"), { code: "outcome_unknown" });
      const answer = await remoteInstall({ home: options.home, root: options.root, mode: call.mode, args: call.args });
      return { stdout: JSON.stringify(answer), stderr: "", exitCode: 0 };
    },
  };
  return { runner, requests, modes };
}
