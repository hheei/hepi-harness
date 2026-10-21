/**
 * The file vocabulary a workbench shares across its halves.
 *
 * Four things used to be declared once per process: the browser's routing path (`/workspace/<id>/...`), the MIME and
 * preview-kind table a viewer picks a renderer from, the `@` file index a composer ranks, and the upload's own rules
 * about names and conflict strategies. Every one of them is a fact about a **file surface**, not about the process that
 * happens to hold a copy: the ingress answers a browser's file routes, the Backend resolves the workspace they name, and
 * the React surfaces render the answer. Declared here, they cannot disagree — and the routing parser in particular is
 * the one place the browser's vocabulary is read, so a path cannot mean two things on its way through.
 *
 * Nothing here imports a runtime: the protocol package is consumed by the browser as well as by every Node process.
 */

// ---------------------------------------------------------------------------
// Routing paths
// ---------------------------------------------------------------------------

/** The path prefix the browser workspace vocabulary is built on. */
export const WORKSPACE_ROUTING_PREFIX = "/workspace/";

/**
 * One path, read once: the workspace it names and the path inside that workspace.
 *
 * This is the only parser of the browser's workspace vocabulary — the file surfaces, the terminal surface and the
 * Backend's relays all take their answer from here, so none of them can disagree about what a path names. A routing
 * path is how a client **reaches** a folder, never what the folder is: the host's own root stays with the host.
 */
export function workspaceRoutingLocation(path: string): { workspaceId: string; relativePath: string } | null {
	if (!path.startsWith(WORKSPACE_ROUTING_PREFIX)) return null;
	const rest = path.slice(WORKSPACE_ROUTING_PREFIX.length);
	const slash = rest.indexOf("/");
	const workspaceId = slash === -1 ? rest : rest.slice(0, slash);
	if (workspaceId === "") return null;
	return { workspaceId, relativePath: slash === -1 ? "" : rest.slice(slash + 1) };
}

/** The routing path of one workspace folder: what a client addresses, never what the host calls it. */
export function workspaceRoutingPath(workspaceId: string, relativePath = ""): string {
	return WORKSPACE_ROUTING_PREFIX + workspaceId + (relativePath === "" ? "" : "/" + relativePath);
}

// ---------------------------------------------------------------------------
// File kinds
// ---------------------------------------------------------------------------

/** How much of a text file a preview serves. The host enforces it; a viewer only has to know the bound. */
export const TEXT_PREVIEW_MAX_BYTES = 256 * 1024;
export const IMAGE_PREVIEW_MAX_BYTES = 10 * 1024 * 1024;
export const DOCX_PREVIEW_MAX_BYTES = 10 * 1024 * 1024;

export type DocumentPreviewKind = "pdf" | "docx";

export const IMAGE_EXT_TO_MIME: Readonly<Record<string, string>> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	svg: "image/svg+xml",
	bmp: "image/bmp",
	ico: "image/x-icon",
	avif: "image/avif",
};

export const AUDIO_EXT_TO_MIME: Readonly<Record<string, string>> = {
	mp3: "audio/mpeg",
	wav: "audio/wav",
	ogg: "audio/ogg",
	oga: "audio/ogg",
	opus: "audio/ogg",
	m4a: "audio/mp4",
	aac: "audio/aac",
	flac: "audio/flac",
	weba: "audio/webm",
};

export const VIDEO_EXT_TO_MIME: Readonly<Record<string, string>> = {
	mp4: "video/mp4",
	m4v: "video/mp4",
	webm: "video/webm",
	mov: "video/quicktime",
	ogv: "video/ogg",
};

export const DOCUMENT_EXT_TO_MIME: Readonly<Record<DocumentPreviewKind, string>> = {
	pdf: "application/pdf",
	docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

function baseNameOf(filePath: string): string {
	return filePath.replace(/\\/g, "/").split("/").pop() ?? "";
}

/** A path's extension, lower-cased, without its dot. */
export function fileExtensionOf(filePath: string): string {
	return baseNameOf(filePath).toLowerCase().split(".").pop() ?? "";
}

export function getImageMime(filePath: string): string | null {
	return IMAGE_EXT_TO_MIME[fileExtensionOf(filePath)] ?? null;
}

export function getAudioMime(filePath: string): string | null {
	return AUDIO_EXT_TO_MIME[fileExtensionOf(filePath)] ?? null;
}

export function getVideoMime(filePath: string): string | null {
	return VIDEO_EXT_TO_MIME[fileExtensionOf(filePath)] ?? null;
}

export function getDocumentMime(filePath: string): string | null {
	return DOCUMENT_EXT_TO_MIME[fileExtensionOf(filePath) as DocumentPreviewKind] ?? null;
}

export function documentPreviewKind(filePath: string): DocumentPreviewKind | null {
	const extension = fileExtensionOf(filePath);
	return extension === "pdf" || extension === "docx" ? extension : null;
}

export const isImagePath = (filePath: string): boolean => getImageMime(filePath) !== null;
export const isAudioPath = (filePath: string): boolean => getAudioMime(filePath) !== null;
export const isVideoPath = (filePath: string): boolean => getVideoMime(filePath) !== null;
export const isDocumentPreviewPath = (filePath: string): boolean => documentPreviewKind(filePath) !== null;

/**
 * The MIME a byte-served file is answered with: the one its extension names, or null when the host's own answer is the
 * right one. A browser renders an image, a recording or a PDF from this; everything else is octet-stream.
 */
export function byteServedMime(filePath: string): string | null {
	return getImageMime(filePath) ?? getAudioMime(filePath) ?? getVideoMime(filePath) ?? getDocumentMime(filePath);
}

/**
 * Whether this path is served as its own bytes rather than as a text preview.
 *
 * A docx is here because its preview is not a preview of text the host can decode: the file is a package, so the
 * browser is handed the document itself and reads it. That is why a docx preview is bounded by
 * {@link DOCX_PREVIEW_MAX_BYTES}, which sits under the gateway's 16 MiB read policy — a document the preview will take
 * is a document the byte route will answer on either host.
 */
export function servesBytes(filePath: string): boolean {
	return isImagePath(filePath) || isAudioPath(filePath) || isVideoPath(filePath) || isDocumentPreviewPath(filePath);
}

// ---------------------------------------------------------------------------
// The `@` file index
// ---------------------------------------------------------------------------

/** One entry of the `@` index: a path relative to the workspace, and whether it is a directory. */
export type FileIndexEntry = { path: string; isDir: boolean };

const pathDepth = (path: string): number => path.split("/").length - 1;

/**
 * Build the entry list from the host's flat file list, deriving directory entries from file paths — the index reports
 * files, and a composer that offered only files could not be used to drill into a folder. Base order is shallow-first
 * then alphabetical, which is what an empty `@` query shows.
 */
export function buildEntriesFromFiles(files: readonly string[]): FileIndexEntry[] {
	const directories = new Set<string>();
	for (const file of files) {
		let index = file.indexOf("/");
		while (index !== -1) {
			directories.add(file.slice(0, index));
			index = file.indexOf("/", index + 1);
		}
	}
	const entries: FileIndexEntry[] = [];
	for (const directory of directories) entries.push({ path: directory, isDir: true });
	for (const file of files) if (file !== "") entries.push({ path: file, isDir: false });
	entries.sort((left, right) => pathDepth(left.path) - pathDepth(right.path) || left.path.localeCompare(right.path));
	return entries;
}

function isSubsequence(needle: string, haystack: string): boolean {
	if (needle === "") return true;
	let matched = 0;
	for (let index = 0; index < haystack.length && matched < needle.length; index += 1) {
		if (haystack[index] === needle[matched]) matched += 1;
	}
	return matched === needle.length;
}

/**
 * The TUI's `scoreEntry` ladder — exact 100, prefix 80, substring 50, path substring 30, directories +10 — plus a
 * low-weight subsequence fallback, so a genuinely fuzzy query still finds the file. A query containing `/` ranks
 * against the whole relative path, which is what makes drill-down work: after `@src/`, the query prefix-matches
 * everything inside `src/` and excludes the directory itself.
 */
function scoreEntry(entry: FileIndexEntry, lowerQuery: string): number {
	const lowerPath = entry.path.toLowerCase();
	let score = 0;
	if (lowerQuery.includes("/")) {
		if (lowerPath === lowerQuery) score = 100;
		else if (lowerPath.startsWith(lowerQuery)) score = 80;
		else if (lowerPath.includes(lowerQuery)) score = 50;
		else if (isSubsequence(lowerQuery, lowerPath)) score = 10;
	} else {
		const slash = lowerPath.lastIndexOf("/");
		const lowerName = slash === -1 ? lowerPath : lowerPath.slice(slash + 1);
		if (lowerName === lowerQuery) score = 100;
		else if (lowerName.startsWith(lowerQuery)) score = 80;
		else if (lowerName.includes(lowerQuery)) score = 50;
		else if (lowerPath.includes(lowerQuery)) score = 30;
		else if (isSubsequence(lowerQuery, lowerPath)) score = 10;
	}
	if (entry.isDir && score > 0) score += 10;
	return score;
}

/** How many ranked entries one `@` answer carries. */
export const AT_RESULT_LIMIT = 20;

export function filterFileEntries(entries: readonly FileIndexEntry[], query: string, limit: number = AT_RESULT_LIMIT): FileIndexEntry[] {
	const lowerQuery = query.toLowerCase();
	if (lowerQuery === "") return entries.slice(0, limit);
	const scored: { entry: FileIndexEntry; score: number }[] = [];
	for (const entry of entries) {
		const score = scoreEntry(entry, lowerQuery);
		if (score > 0) scored.push({ entry, score });
	}
	scored.sort((left, right) => right.score - left.score || pathDepth(left.entry.path) - pathDepth(right.entry.path) || left.entry.path.localeCompare(right.entry.path));
	return scored.slice(0, limit).map(scored => scored.entry);
}

// ---------------------------------------------------------------------------
// Upload rules
// ---------------------------------------------------------------------------

export const UPLOAD_CONFLICT_STRATEGIES = ["error", "overwrite", "skip"] as const;
export type UploadConflictStrategy = typeof UPLOAD_CONFLICT_STRATEGIES[number];

/** The strategy a request asked for, or null when it named one this surface does not serve. */
export function parseUploadConflictStrategy(value: string | null): UploadConflictStrategy | null {
	const candidate = value ?? "error";
	return (UPLOAD_CONFLICT_STRATEGIES as readonly string[]).includes(candidate) ? candidate as UploadConflictStrategy : null;
}

/**
 * Why these names cannot be an upload, or null when they can. A name is one file's own name: no separator, no parent
 * directory, and no repeat, because two parts writing one target would make the batch's own answer ambiguous.
 */
export function validateUploadFileNames(fileNames: readonly string[]): string | null {
	if (fileNames.length === 0) return "No files selected";
	const seen = new Set<string>();
	for (const fileName of fileNames) {
		if (fileName === "" || fileName === "." || fileName === ".." || fileName.includes("\0")) return "Invalid file name: " + (fileName === "" ? "(empty)" : fileName);
		if (fileName.includes("/") || fileName.includes("\\")) return "File names must not contain a path: " + fileName;
		if (seen.has(fileName)) return "Duplicate file name in upload: " + fileName;
		seen.add(fileName);
	}
	return null;
}

// ---------------------------------------------------------------------------
// What the browser's file surface answers
// ---------------------------------------------------------------------------

export type GitFileStatusKind = "modified" | "added" | "deleted" | "renamed" | "untracked" | "conflict";

export type GitFileStatus = {
	filePath: string;
	status: GitFileStatusKind;
	code: "M" | "A" | "D" | "R" | "U" | "C";
	indexStatus: string;
	worktreeStatus: string;
};

export type GitStatusResponse = {
	isGitRepository: boolean;
	repositoryRoot: string | null;
	files: GitFileStatus[];
	additions: number;
	deletions: number;
};

export type GitFileDiffResponse = { supported: boolean; status?: GitFileStatusKind; patch?: string };

/** One directory as the tree renders it. The host's listing reports names only, so size and time stay zero. */
export type FileListingEntry = { name: string; isDir: boolean; size: number; modified: string };
export type FileListingResponse = { entries: FileListingEntry[]; path: string };

/**
 * A text preview as `?type=read` answers it: one bounded chunk of the file, and what it does and does not cover.
 *
 * `shownBytes` is the number of the file's bytes this answer holds and `size` is the file's whole size as the host
 * stated it, or `null` when the host could not say. A truncated answer therefore has two honest numbers — how much is
 * shown, and how much there is — and a viewer never has to invent a denominator. `previewOnly` says the host serves one
 * chunk and no continuation: there is no offset to follow, so no "load more" a viewer could offer truthfully.
 */
export type FilePreviewResponse = {
	content: string;
	language: string;
	shownBytes: number;
	size: number | null;
	truncated: boolean;
	previewOnly: true;
};

/** What `?type=meta` answers, for a viewer that has to pick a renderer before it fetches anything. */
export type FileMetaResponse = { size: number; language: string; mime: string; previewKind: DocumentPreviewKind | null };

/** The names an upload would meet, answered by the host that holds the directory. */
export type UploadInspectionResponse = { conflicts: string[]; nonReplaceable: string[] };

/** One upload's answer: what was written, what was left alone, and what failed, per name. */
export type UploadBatchResponse = {
	uploaded?: string[];
	skipped?: string[];
	errors?: { name: string; error: string }[];
	conflicts?: string[];
	nonReplaceable?: string[];
	error?: string;
};

/** One `@` index answer: the ranked matches, or the flat list the client ranks itself. */
export type FileIndexResponse = { matches: FileIndexEntry[] } | { files: string[]; truncated: boolean };
