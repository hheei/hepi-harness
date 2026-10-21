/**
 * One page of a conversation listing, paged by conversation id.
 *
 * Both listing surfaces — the HTTP catalogue route and the optional subagent extension's own listing — project the same
 * committed rows and page them the same way, so the paging rule lives here once. A caller continues after the last id
 * of the page it received; a cursor beyond every row is an **exhausted** listing and answers an empty page, because
 * restarting from the beginning would hand a client that keeps following `nextCursor` the first page forever.
 */
export function conversationPage<T extends { readonly id: string }>(
  rows: readonly T[],
  limit: number | undefined,
  cursor: string | undefined,
): { readonly window: readonly T[]; readonly nextCursor?: string } {
  const start = cursor === undefined ? 0 : rows.findIndex((row) => Number(row.id) > Number(cursor));
  if (start === -1) return { window: [] };
  const window = limit === undefined ? rows.slice(start) : rows.slice(start, start + limit);
  const nextCursor = limit !== undefined && start + window.length < rows.length ? window.at(-1)?.id : undefined;
  return { window, ...(nextCursor === undefined ? {} : { nextCursor }) };
}
