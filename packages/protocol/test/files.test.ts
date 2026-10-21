import assert from "node:assert/strict";
import test from "node:test";
import {
	DOCX_PREVIEW_MAX_BYTES,
	byteServedMime,
	documentPreviewKind,
	isDocumentPreviewPath,
	servesBytes,
} from "../src/files.ts";

/**
 * Which files a browser shows from their own bytes, and how large a document preview it will attempt.
 *
 * `servesBytes` is the single declaration the file surface asks before it chooses between a host text preview and a
 * byte answer, so the row for a Word document is a wire contract rather than a viewer detail: a `.docx` that went to
 * the workbench would come back as the placeholder "binary content not displayed", which is a 200 KiB answer that
 * says nothing about the document. The bound under which the browser reads it is checked against the host's own read
 * policy here too, because a preview bound the host cannot serve is a refusal the user always sees.
 */
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

test("a Word document is served as its own bytes, with its own MIME", () => {
	assert.equal(servesBytes("/workspace/ws/report.docx"), true, "a docx was not byte-served: the host would preview it as binary");
	assert.equal(documentPreviewKind("/workspace/ws/report.docx"), "docx");
	assert.equal(byteServedMime("/workspace/ws/report.docx"), DOCX_MIME, "a byte-served docx needs the MIME the page reads it as");
	assert.equal(servesBytes("/workspace/ws/report.pdf"), true, "a pdf is byte-served by the same declaration");
});

test("the preview bound is the number one declaration, shared by the viewer and the surface", () => {
	// The viewer refuses a document over this size before asking for it; the gateway owns the read policy the bound sits
	// under, and `packages/gateway/test/files-surface.test.ts` pins that relationship where the policy lives.
	assert.equal(DOCX_PREVIEW_MAX_BYTES, 10 * 1024 * 1024);
	assert.equal(isDocumentPreviewPath("report.docx"), true);
	assert.equal(servesBytes("notes.txt"), false, "a text file still comes from the workbench preview");
});
