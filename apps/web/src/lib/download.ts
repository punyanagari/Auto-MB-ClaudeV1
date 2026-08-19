/**
 * Hands a fetched file to the browser as a download.
 *
 * The sibling of `openPdf`, and the difference is what the operator wants
 * to do with the bytes. A rendered challan is READ, so it is opened in a
 * tab; a workbook and a Tally import file are FED TO ANOTHER PROGRAM, so
 * they are saved. Opening an .xlsx in a tab shows a browser's apology, and
 * a Tally envelope shows raw XML.
 *
 * No popup dance is needed here for the same reason: an anchor with a
 * `download` attribute is a save rather than a navigation, and blockers do
 * not intercept one. The tenant header travels on every scoped request, so
 * the file is fetched rather than linked — `api.ts`'s `downloadBlob` — and
 * this receives the blob.
 *
 * Rejects with the fetch's own error, so callers keep running it inside
 * their `act` error surface and a 403 arrives as the server's sentence.
 */
export async function downloadFile(
  fetchBlob: () => Promise<Blob>,
  filename: string,
): Promise<void> {
  const blob = await fetchBlob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  // Long enough for the save to have read the blob, matching `openPdf`.
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 60_000);
}
