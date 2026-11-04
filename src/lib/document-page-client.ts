/** One authenticated request returns both the requested image and its page count. */
export async function fetchDocumentPage(reference: string, page: number, token: string | null, signal: AbortSignal) {
  if (!token) throw new Error('Please sign in to view this lecture.');
  if (!/^\/api\/documents\/[A-Za-z0-9_-]+$/.test(reference)) {
    throw new Error('Reopen this lecture from the Lectures page to load its protected viewer.');
  }
  let pageNumber = Number.isSafeInteger(page) && page > 0 ? page : 1;
  const request = (number: number) => fetch(`${reference}/pages/${number}`, {
    signal, cache: 'no-store', credentials: 'same-origin', headers: { Authorization: `Bearer ${token}` },
  });
  let response = await request(pageNumber);
  const count = (value: Response) => Number(value.headers.get('X-Document-Total-Pages'));
  // A stale slide reference may point past a replaced/shorter PDF. Recover once.
  const available = count(response);
  if (response.status === 404 && Number.isInteger(available) && available > 0 && pageNumber > available) {
    await response.body?.cancel();
    pageNumber = available; response = await request(pageNumber);
  }
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.error || 'This page could not be loaded. Please retry.');
  }
  const totalPages = count(response);
  if (!Number.isInteger(totalPages) || totalPages < pageNumber || response.headers.get('content-type')?.split(';')[0] !== 'image/webp') {
    throw new Error('Invalid page preview. Please retry.');
  }
  return { blob: await response.blob(), totalPages, pageNumber };
}
