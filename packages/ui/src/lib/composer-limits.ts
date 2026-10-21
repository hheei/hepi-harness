/**
 * The composer draft this host refuses before it sends anything.
 *
 * A draft that starts with `!` asks for a shell command, and the durable runtime serves no such command: sending it
 * would reach a Web host that answers 501 and report a failure the user could not have avoided. The rule lives here so
 * the composer that states the limit while the draft is being typed and the send that refuses it agree on which drafts
 * are meant, and so a prompt that merely begins with an exclamation mark beside an attachment is still an ordinary
 * prompt rather than a command nobody can run.
 */
export function isShellCommandDraft(draft: string, attachedImageCount: number): boolean {
  return attachedImageCount === 0 && draft.trimStart().startsWith("!");
}
