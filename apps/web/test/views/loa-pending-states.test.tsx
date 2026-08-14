// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ReviewLoa } from '../../src/views/ReviewLoa.js';
import { Works } from '../../src/views/Works.js';
import { DOC_ID, ORG_ID, REVIEW_DOCUMENT, stubApi } from './helpers.js';

/**
 * The states pack P18 made reachable, held to the screen.
 *
 * Since P18 an upload answers before the letter has been read, so a
 * document sits in `pending` (then `processing`) with no extraction
 * payload for as long as the reading takes. Both of those are ordinary,
 * and the product has to say so plainly — the P8 conventions allow a
 * stated wait and forbid an invented spinner.
 *
 * The review of this pack found the opposite shipping: the payload-less
 * branch of the review screen told the reader that extraction had FAILED
 * and to upload a clearer copy. It is reachable — the duplicate-refusal
 * card offers to open the document, and any deep link does — and acting on
 * its advice would be refused as a duplicate. These tests are what stop
 * that returning.
 */

const PENDING_DOCUMENT = {
  ...REVIEW_DOCUMENT,
  extractionStatus: 'pending' as const,
  extractionPayload: undefined,
};

describe('a letter that has not been read yet', () => {
  it.each([['pending'], ['processing']] as const)(
    'says the %s letter is still being read, and never that it failed',
    async (status) => {
      const api = stubApi({
        getLoaDocument: vi
          .fn()
          .mockResolvedValue({ ...PENDING_DOCUMENT, extractionStatus: status }),
      });

      render(
        <ReviewLoa
          api={api}
          organisationId={ORG_ID}
          documentId={DOC_ID}
          canModify
          onBack={vi.fn()}
          onConfirmed={vi.fn()}
          onDiscarded={vi.fn()}
        />,
      );

      // Twice, on purpose: once in the sr-only live region that announces
      // the arrival, and once as the visible copy. A screen-reader user and
      // a sighted user are told the same thing.
      const stated = await screen.findAllByText(/still being read/i);
      expect(stated).toHaveLength(2);
      expect(screen.getByRole('button', { name: 'Back to Works' })).toBeTruthy();

      // The failure copy and its impossible advice must be absent: the
      // letter is fine, and re-uploading it would be refused as a
      // duplicate of itself.
      expect(screen.queryByText(/did not produce reviewable content/i)).toBeNull();
      expect(screen.queryByText(/clearer copy/i)).toBeNull();
    },
  );

  it('still says extraction failed for a letter that really was read and yielded nothing', async () => {
    // The other side of the same branch. Narrowing the pending case must
    // not swallow the genuine failure, which keeps its persistent alert
    // and its remedy.
    const api = stubApi({
      getLoaDocument: vi.fn().mockResolvedValue({
        ...PENDING_DOCUMENT,
        extractionStatus: 'failed' as const,
      }),
    });

    render(
      <ReviewLoa
        api={api}
        organisationId={ORG_ID}
        documentId={DOC_ID}
        canModify
        onBack={vi.fn()}
        onConfirmed={vi.fn()}
        onDiscarded={vi.fn()}
      />,
    );

    expect(await screen.findByText(/did not produce reviewable content/i)).toBeTruthy();
    expect(screen.queryByText(/still being read/i)).toBeNull();
  });

  it('shows the letter in the register as Pending rather than hiding it', async () => {
    // The upload answered, so the document exists and must be visible
    // immediately — an upload that appears to have vanished for a minute
    // is worse than one that says what it is doing.
    const api = stubApi({
      listLoaDocuments: vi.fn().mockResolvedValue([PENDING_DOCUMENT]),
    });

    render(
      <Works
        api={api}
        organisationId={ORG_ID}
        canModify
        onUpload={vi.fn()}
        onReview={vi.fn()}
        onOpenWork={vi.fn()}
      />,
    );

    expect(await screen.findByText('Pending')).toBeTruthy();
    expect(screen.getByText('loa-letter.pdf')).toBeTruthy();
  });
});
