import { useEffect } from 'react';

/** The product name, spelled once. `index.html` ships it as the document's
 * starting title, and every screen appends itself in front of it. */
const PRODUCT = 'Auto-MB';

/**
 * Names the browser tab after the screen that is open.
 *
 * The workspace is a single document whose fragment is its address, so
 * without this the tab said "Auto-MB" from sign-in to a cancelled challan
 * and every entry in the history menu was the same word. An operator with
 * three tenants open in three tabs — the reason the tenant switch exists —
 * had no way to tell them apart, and back-button history was a list of
 * identical rows. WCAG 2.4.2 asks for a title that describes the page; a
 * constant string does not.
 *
 * The title is built from parts, most specific first, so the tab is legible
 * truncated to the ~20 characters a browser actually shows: the screen, then
 * the organisation, then the product. Empty parts are dropped rather than
 * leaving a hanging separator.
 *
 * `null` means "this component is not the one naming the page" — the shell
 * defers to nothing, but `App` defers to the workspace whenever the
 * workspace is mounted, because two components writing `document.title`
 * would race on effect order.
 */
export function useDocumentTitle(parts: readonly (string | null)[] | null): void {
  const title =
    parts === null
      ? null
      : [
          ...parts.filter((part): part is string => part !== null && part !== ''),
          PRODUCT,
        ].join(' · ');
  useEffect(() => {
    if (title === null) return;
    document.title = title;
  }, [title]);
}
