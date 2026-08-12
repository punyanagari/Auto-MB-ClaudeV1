/**
 * Opens a fetched PDF in a new tab without tripping popup blockers.
 *
 * The tab must be claimed synchronously, inside the click gesture — the
 * seven per-view copies this replaces all called window.open AFTER
 * awaiting the download, which popup blockers treat as an unsolicited
 * window. So the blank tab is opened first and pointed at the blob once
 * it exists. 'noopener' cannot be passed to window.open here: the spec
 * makes it return null instead of the handle the navigation needs, so
 * the opener link is severed by hand. When the popup is blocked anyway,
 * the blob is handed over as a plain download through an anchor, which
 * blockers do not intercept.
 *
 * Rejects with the fetch's own error (after closing the claimed tab), so
 * callers keep running it inside their act/tryAct error surface.
 */
export async function openPdf(fetchPdf: () => Promise<Blob>): Promise<void> {
  const tab = window.open('', '_blank') ?? null;
  if (tab !== null) tab.opener = null;
  let blob: Blob;
  try {
    blob = await fetchPdf();
  } catch (cause) {
    tab?.close();
    throw cause;
  }
  const url = URL.createObjectURL(blob);
  if (tab !== null) {
    tab.location.href = url;
  } else {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'document.pdf';
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
  }
  // Give the new tab (or the download) time to read the blob before the
  // URL is revoked.
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 60_000);
}
