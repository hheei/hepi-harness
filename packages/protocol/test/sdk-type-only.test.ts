import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const SDK = "@earendil-works/pi-coding-agent";

// Protocol may share SDK declarations, but its emitted modules must not load the CLI runtime.
test("no protocol module imports the SDK at run time", async () => {
	const dir = new URL("../src/", import.meta.url);
	const files = (await readdir(dir, { recursive: true })).filter((name) => name.endsWith(".ts"));
	assert.ok(files.length > 0, "no protocol sources were read");
	for (const file of files) {
		const source = await readFile(new URL(file, dir), "utf8");
		const { outputText } = ts.transpileModule(source, {
			compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ESNext, verbatimModuleSyntax: true },
		});
		const emitted = ts.createSourceFile(file + ".js", outputText, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
		function visit(node: ts.Node): void {
			let specifier: ts.Node | undefined;
			if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) specifier = node.moduleSpecifier;
			if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
				|| (ts.isIdentifier(node.expression) && node.expression.text === "require"))) specifier = node.arguments[0];
			if (specifier !== undefined && ts.isStringLiteralLike(specifier)) {
				assert.notEqual(specifier.text, SDK, file + " imports the SDK at run time");
			}
			ts.forEachChild(node, visit);
		}
		visit(emitted);
	}
});
