/** Render a thrown value as text without redacting or shortening it. */
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
