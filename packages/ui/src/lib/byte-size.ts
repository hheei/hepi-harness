/**
 * One byte count as a file surface states it.
 *
 * The viewer's header and its preview-bound notice state the same file's two numbers, and a size that read differently
 * beside one file is a size that reads wrong. The spelling is the viewer's own — one decimal for KB and MB — so nothing
 * a person compared before changes.
 */
export function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
