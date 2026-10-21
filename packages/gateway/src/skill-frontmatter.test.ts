import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { setDisableModelInvocation } from "./skill-frontmatter.ts";

/**
 * The execution-side frontmatter edit. The cases are the vendored upstream helper's own
 * (`apps/web/lib/skill-frontmatter.test.mjs`, from pi-web lib/skill-frontmatter.ts, MIT), because a document this
 * gateway edits must still load as the same skill afterwards: the point of the surgical line edit is that every
 * other field, its formatting and the body are left exactly as they were.
 */
describe("setDisableModelInvocation", () => {
  const withFrontmatter = "---\nname: my-skill\ndescription: Does things\n---\n\nBody text.\n";

  it("adds the key after the opening fence when absent", () => {
    assert.equal(
      setDisableModelInvocation(withFrontmatter, true),
      "---\ndisable-model-invocation: true\nname: my-skill\ndescription: Does things\n---\n\nBody text.\n",
    );
  });

  it("creates a frontmatter block when the file has none", () => {
    assert.equal(
      setDisableModelInvocation("Just a body.\n", true),
      "---\ndisable-model-invocation: true\n---\nJust a body.\n",
    );
    assert.equal(setDisableModelInvocation("Just a body.\n", false), "Just a body.\n");
  });

  it("replaces an explicit false value instead of adding a duplicate key", () => {
    const content = "---\nname: my-skill\ndisable-model-invocation: false\ndescription: Does things\n---\n\nBody text.\n";
    const updated = setDisableModelInvocation(content, true);
    assert.equal(updated.match(/^disable-model-invocation[^\n]*/gm)?.length, 1, "must not emit a duplicate key");
    assert.equal(setDisableModelInvocation(updated, true), updated, "an already-true key keeps its bytes");
  });

  it("updates and removes indented quoted keys, which YAML reads at the mapping's own level", () => {
    for (const quote of ['"', "'"]) {
      const content = `---\n  name: my-skill\n  ${quote}disable-model-invocation${quote}: false\n---\nBody text.\n`;
      const updated = setDisableModelInvocation(content, true);
      assert.equal(
        updated,
        `---\n  name: my-skill\n  ${quote}disable-model-invocation${quote}: true\n---\nBody text.\n`,
        quote,
      );
      assert.equal(setDisableModelInvocation(updated, false), `---\n  name: my-skill\n---\nBody text.\n`);
    }
  });

  it("removes the key when it is the last frontmatter line before the closing fence", () => {
    const content = "---\nname: my-skill\ndescription: Does things\ndisable-model-invocation: true\n---\n\nBody text.\n";
    assert.equal(setDisableModelInvocation(content, false), withFrontmatter);
  });

  it("is a no-op when disabling is off and the key is absent", () => {
    assert.equal(setDisableModelInvocation(withFrontmatter, false), withFrontmatter);
  });

  it("preserves unrelated frontmatter formatting and body lines that mention the key", () => {
    const content = "---\nname: my-skill\n# comment\nallowed-tools: [ read, write ]\ndisable-model-invocation: false\n---\nUse `disable-model-invocation: true` to hide me.\n";
    const updated = setDisableModelInvocation(content, true);
    assert.match(updated, /# comment/);
    assert.match(updated, /allowed-tools: \[ read, write \]/);
    assert.match(updated, /^disable-model-invocation: true$/m);
    assert.equal(updated.match(/^disable-model-invocation[^\n]*/gm)?.length, 1);
    assert.match(updated, /Use `disable-model-invocation: true` to hide me\./);
  });

  it("preserves CRLF line endings, a BOM and the SDK's fence variants byte for byte", () => {
    // The round trip is asserted from a document that does not carry the key: enabling adds it, clearing removes it,
    // and the two others around it are the same bytes. A document that already carries an explicit `false` is
    // replaced in place instead (above), which is what upstream does and why clearing still ends at the input only
    // when the input was keyless.
    const cases: [string, string][] = [
      ["---\r\nname: my-skill\r\ndescription: Does things\r\n---\r\nBody text.\r\n", "---\r\ndisable-model-invocation: true\r\nname: my-skill\r\ndescription: Does things\r\n---\r\nBody text.\r\n"],
      ["\uFEFF---\nname: my-skill\ndescription: Does things\n---\nBody text.\n", "\uFEFF---\ndisable-model-invocation: true\nname: my-skill\ndescription: Does things\n---\nBody text.\n"],
      ["---  \t\nname: my-skill\ndescription: Does things\n---\nBody text.\n", "---  \t\ndisable-model-invocation: true\nname: my-skill\ndescription: Does things\n---\nBody text.\n"],
      ["---\rname: my-skill\rdescription: Does things\r---\rBody text.\r", "---\rdisable-model-invocation: true\rname: my-skill\rdescription: Does things\r---\rBody text.\r"],
    ];
    for (const [content, enabled] of cases) {
      assert.equal(setDisableModelInvocation(content, true), enabled, JSON.stringify(content));
      assert.equal(setDisableModelInvocation(enabled, false), content, JSON.stringify(content));
    }
  });

  it("leaves a key nested under another mapping alone, and adds the document's own key instead", () => {
    // A nested key is a fact about that mapping, not about the document: the loader does not read it as the skill's
    // own, so editing it in place would leave the skill enabled while claiming it changed. The document's own key is
    // added, and the nested one is untouched.
    const nested = "---\nmetadata:\n  disable-model-invocation: false\n---\nBody.\n";
    assert.equal(setDisableModelInvocation(nested, true), "---\ndisable-model-invocation: true\nmetadata:\n  disable-model-invocation: false\n---\nBody.\n");
    const nestedTrue = "---\nmetadata:\n  disable-model-invocation: true\n---\nBody.\n";
    assert.equal(setDisableModelInvocation(nestedTrue, false), nestedTrue, "nothing to clear is a no-op");
  });

  it("refuses a shape no top-level key can be added to, and a fence that never closes", () => {
    // A flow mapping, a sequence and a scalar are not mappings a key can be a sibling of; writing one would corrupt
    // the document, so it is refused. A file that opens a fence it never closes is a truncated document.
    assert.throws(() => setDisableModelInvocation("---\n{ disable-model-invocation: false, name: my-skill }\n---\nBody text.\n", true), /unsupported frontmatter formatting/);
    assert.throws(() => setDisableModelInvocation("---\n- one\n- two\n---\nBody.\n", true), /unsupported frontmatter formatting/);
    // A fence that opens and never closes is a document this edit cannot address in either direction: there is no
    // block to read, and the file as a whole is not one the loader accepts. A body-only file is a different fact — a
    // skill whose document simply has no frontmatter — so clearing the key there is a no-op.
    assert.throws(() => setDisableModelInvocation("---\nname: my-skill\n", true), /unsupported frontmatter formatting/);
    assert.throws(() => setDisableModelInvocation("---\nname: my-skill\n", false), /unsupported frontmatter formatting/);
    assert.equal(setDisableModelInvocation("Just a body.\n", false), "Just a body.\n");
  });
});
