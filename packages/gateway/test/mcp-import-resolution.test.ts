import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fillMcpImportFields, parseMcpImport } from "@hepi/ui/lib/mcp-import.ts";
import { redactorFor, resolveConnectionValues } from "../src/mcp/connection.ts";

/**
 * The two halves of one rule, at the seam they really meet.
 *
 * An imported configuration is foreign text, so a value that looks like a reference — a leading `!` or a `$NAME` — must
 * arrive as the literal a person pasted rather than as something this host runs or expands. The importer escapes it
 * (`$@hepi/ui/lib/mcp-import`), and the host's own resolution (`../src/mcp/connection.ts`) is what reads the escaped
 * form. Each half has its own test; this one is the contract between them, because escaping that the resolver does not
 * undo is a value the user never typed, and a resolver that runs what the importer left unescaped is a command the user
 * never asked for.
 *
 * The marker file is the only way a value could execute here: a literal that ran would create it.
 */

const directories: string[] = [];
after(async () => { for (const directory of directories) await rm(directory, { recursive: true, force: true }); });
const marker = async (): Promise<string> => {
	const directory = await mkdtemp(join(tmpdir(), "hepi-mcp-import-"));
	directories.push(directory);
	return join(directory, "ran");
};

test("a foreign value is escaped by the importer and read back as text by this host, never run", async () => {
	const ran = await marker();
	const parsed = parseMcpImport(JSON.stringify({ mcpServers: { docs: { url: "https://docs.example.com/mcp", headers: { Authorization: "Bearer YOUR_TOKEN" } } } }));
	assert.equal(parsed.ok, true);
	const source = parsed.servers[0]!;

	// The text a person pasted, in the two shapes this host would otherwise resolve: a command, and an expansion.
	const typed = fillMcpImportFields(source, { "headers.Authorization": `!touch ${ran}; echo a$b` });
	assert.equal(typed.ok, true);
	const config = typed.config as { headers: Record<string, string> };
	const pasted = `Bearer !touch ${ran}; echo a$b`;
	assert.notEqual(config.headers.Authorization, pasted, "the importer left a resolvable reference in a literal field");

	// What the host resolves is exactly what was typed — and nothing ran.
	const resolved = await resolveConnectionValues({ headers: config.headers }, redactorFor({}));
	assert.equal(resolved.headers.Authorization, pasted);
	assert.equal(existsSync(ran), false, "an imported literal was executed by this host");

	// A reference the user chose deliberately still resolves, which is what makes the escaping a rule about literals
	// rather than a refusal of the feature.
	const referenced = fillMcpImportFields(source, { "headers.Authorization": { reference: "DOCS_TOKEN" } });
	assert.equal(referenced.ok, true);
	process.env.DOCS_TOKEN = "abc";
	try {
		const expanded = await resolveConnectionValues({ headers: (referenced.config as { headers: Record<string, string> }).headers }, redactorFor({}));
		assert.equal(expanded.headers.Authorization, "Bearer abc");
	} finally {
		delete process.env.DOCS_TOKEN;
	}
});
