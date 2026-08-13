// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ConfirmWorkRequest, LoaDocumentDetail } from '@auto-mb/contracts';
import { RequestFailedError } from '../../src/api.js';
import { ReviewLoa } from '../../src/views/ReviewLoa.js';
import { UploadLoa } from '../../src/views/UploadLoa.js';
import { Works } from '../../src/views/Works.js';
import {
  stubApi,
  ORG_ID,
  DOC_ID,
  WORK_ID,
  REVIEW_PAYLOAD,
  REVIEW_DOCUMENT,
} from './helpers.js';

describe('Works', () => {
  it('lists Works and review-ready documents, and routes the actions', async () => {
    const api = stubApi({
      listWorks: vi.fn().mockResolvedValue([
        {
          id: WORK_ID,
          workCode: 'PL270-CRB',
          letterNumber: 'L-42/2025',
          letterDate: '2025-06-01',
          title: 'Supply of switchboards',
          advertisedValue: '1000.00',
          contractValue: '900.00',
          pricingShape: 'letter_percentage',
          letterPercentage: '10.000',
          letterPercentageDirection: 'below',
          status: 'active',
          createdAt: '2026-08-08T00:00:00.000Z',
        },
      ]),
      listLoaDocuments: vi
        .fn()
        .mockResolvedValue([{ ...REVIEW_DOCUMENT, extractionPayload: undefined }]),
    });
    const onReview = vi.fn();
    const onOpenWork = vi.fn();
    render(
      <Works
        api={api}
        organisationId={ORG_ID}
        canModify
        onUpload={vi.fn()}
        onReview={onReview}
        onOpenWork={onOpenWork}
      />,
    );

    // Register rows are real links (finding 28): the href works in a new
    // tab, a left click routes in-app through the callback.
    const review = await screen.findByRole('link', { name: 'Review' });
    expect(review.getAttribute('href')).toBe(`#/loa/${DOC_ID}`);
    fireEvent.click(review);
    expect(onReview).toHaveBeenCalledWith(DOC_ID);

    const workLink = screen.getByRole('link', { name: 'PL270-CRB' });
    expect(workLink.getAttribute('href')).toBe(`#/works/${WORK_ID}`);
    fireEvent.click(workLink);
    expect(onOpenWork).toHaveBeenCalledWith(WORK_ID);
  });

  it('hides the upload action from read-only roles', async () => {
    const api = stubApi();
    render(
      <Works
        api={api}
        organisationId={ORG_ID}
        canModify={false}
        onUpload={vi.fn()}
        onReview={vi.fn()}
        onOpenWork={vi.fn()}
      />,
    );
    await screen.findByText(/No Works yet/);
    expect(screen.queryByRole('button', { name: 'Upload LOA' })).toBeNull();
  });

  it('discards a wrong upload after one confirmation and drops it from the list', async () => {
    const discardLoaDocument = vi.fn().mockResolvedValue({
      document: { ...REVIEW_DOCUMENT, extractionStatus: 'discarded' },
      discardedSupportingDocumentIds: [],
    });
    const api = stubApi({
      listLoaDocuments: vi
        .fn()
        .mockResolvedValue([{ ...REVIEW_DOCUMENT, extractionPayload: undefined }]),
      discardLoaDocument,
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

    fireEvent.click(
      await screen.findByRole('button', { name: 'Discard loa-letter.pdf' }),
    );
    // It asks once — the only way back is uploading the file again.
    expect(screen.getByText(/stays on record for retention/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm discard' }));

    await waitFor(() => {
      expect(discardLoaDocument).toHaveBeenCalledWith(ORG_ID, DOC_ID);
    });
    await waitFor(() => {
      expect(screen.queryByText('loa-letter.pdf')).toBeNull();
    });
  });

  it('offers no discard for a document already confirmed into a Work', async () => {
    const api = stubApi({
      listLoaDocuments: vi.fn().mockResolvedValue([
        {
          ...REVIEW_DOCUMENT,
          extractionPayload: undefined,
          extractionStatus: 'confirmed',
          confirmedWorkId: WORK_ID,
        },
      ]),
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

    await screen.findByRole('link', { name: 'Open Work' });
    expect(screen.queryByRole('button', { name: /^Discard/ })).toBeNull();
  });
});

describe('UploadLoa', () => {
  it('requires a chosen file before uploading', async () => {
    const api = stubApi();
    render(
      <UploadLoa
        api={api}
        organisationId={ORG_ID}
        onUploaded={vi.fn()}
        onOpenDocument={vi.fn()}
        onOpenWork={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    fireEvent.submit(
      screen.getByRole('button', { name: 'Upload and analyse' }).closest('form') ??
        (() => {
          throw new Error('form missing');
        })(),
    );
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Choose the Letter of Acceptance PDF');
    expect(api.uploadLoa).not.toHaveBeenCalled();
  });

  /** A duplicate-file refusal names the document already holding these
   * bytes. Naming a record the operator then has to go and hunt for is
   * the dead end pack P8 removed: the id is rendered as the control that
   * opens it. */
  it('opens the document a duplicate refusal names', async () => {
    const uploadLoa = vi
      .fn()
      .mockRejectedValue(
        new RequestFailedError(
          409,
          'LOA_DOCUMENT_DUPLICATE',
          'This is the same file as letter.pdf, uploaded on 2026-08-01 and awaiting review.',
          { existingRecordId: DOC_ID, confirmedWorkId: null },
        ),
      );
    const onOpenDocument = vi.fn();
    render(
      <UploadLoa
        api={stubApi({ uploadLoa })}
        organisationId={ORG_ID}
        onUploaded={vi.fn()}
        onOpenDocument={onOpenDocument}
        onOpenWork={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    const input = screen.getByLabelText('LOA PDF');
    fireEvent.change(input, {
      target: {
        files: [new File(['%PDF-1.7'], 'letter.pdf', { type: 'application/pdf' })],
      },
    });
    fireEvent.submit(
      screen.getByRole('button', { name: 'Upload and analyse' }).closest('form') ??
        (() => {
          throw new Error('form missing');
        })(),
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Open that document' }));
    expect(onOpenDocument).toHaveBeenCalledWith(DOC_ID);
  });

  it('opens the Work a confirmed duplicate became', async () => {
    const uploadLoa = vi.fn().mockRejectedValue(
      new RequestFailedError(409, 'LOA_DOCUMENT_DUPLICATE', 'Already confirmed.', {
        existingRecordId: DOC_ID,
        confirmedWorkId: WORK_ID,
      }),
    );
    const onOpenWork = vi.fn();
    render(
      <UploadLoa
        api={stubApi({ uploadLoa })}
        organisationId={ORG_ID}
        onUploaded={vi.fn()}
        onOpenDocument={vi.fn()}
        onOpenWork={onOpenWork}
        onCancel={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText('LOA PDF'), {
      target: {
        files: [new File(['%PDF-1.7'], 'letter.pdf', { type: 'application/pdf' })],
      },
    });
    fireEvent.submit(
      screen.getByRole('button', { name: 'Upload and analyse' }).closest('form') ??
        (() => {
          throw new Error('form missing');
        })(),
    );

    fireEvent.click(
      await screen.findByRole('button', { name: 'Open the Work it became' }),
    );
    expect(onOpenWork).toHaveBeenCalledWith(WORK_ID);
  });
});

describe('ReviewLoa', () => {
  it('shows extracted values as read-only facts, keeps the flagged hole editable, and confirms', async () => {
    const confirmLoa = vi.fn().mockResolvedValue({
      work: { id: WORK_ID },
      schedules: [],
    });
    const api = stubApi({
      getLoaDocument: vi.fn().mockResolvedValue(REVIEW_DOCUMENT),
      confirmLoa,
    });
    const onConfirmed = vi.fn();
    render(
      <ReviewLoa
        api={api}
        organisationId={ORG_ID}
        documentId={DOC_ID}
        canModify
        onConfirmed={onConfirmed}
        onBack={vi.fn()}
        onDiscarded={vi.fn()}
      />,
    );

    // The letter's own values are text, not fields: there is no control to
    // type a different letter number, date, percentage or rate into.
    expect((await screen.findByTestId('fact-letter-number')).textContent).toBe(
      'L-42/2025',
    );
    expect(screen.getByTestId('fact-letter-date').textContent).toBe('01 Jun 2025');
    expect(screen.getByTestId('fact-advertised-value').textContent).toBe('₹1000.00');
    expect(screen.getByTestId('fact-contract-value').textContent).toBe('₹900.00');
    expect(screen.getByTestId('fact-letter-percentage').textContent).toBe('10.000%');
    expect(screen.getByTestId('fact-percentage-direction').textContent).toBe('Below');
    expect(screen.queryByRole('textbox', { name: 'Letter number' })).toBeNull();
    expect(screen.queryByRole('spinbutton', { name: 'Letter date' })).toBeNull();

    // Numbers keep the product's mono, tabular figures.
    expect(screen.getByTestId('fact-contract-value').className).toContain('font-mono');
    expect(screen.getByTestId('fact-contract-value').className).toContain(
      'tabular-nums',
    );

    // The rule and its remedy are stated where the reviewer will look.
    const note = screen.getByTestId('extracted-lock-note');
    expect(note.textContent).toContain('Extracted values are read-only');
    expect(note.textContent).toContain(
      'Discard this letter and upload a corrected one',
    );

    expect(
      screen.getByRole('heading', { name: '1 review issue needs attention' }),
    ).toBeTruthy();
    expect(screen.getByText('The printed unit could not be resolved.')).toBeTruthy();

    // The parsed row's quantity and rate are read-only; only the unit the
    // parser could not resolve is still a field, and it carries the flag.
    const rate = screen.getByLabelText('Rate for row 1 in schedule A');
    expect(rate.tagName).toBe('SPAN');
    expect(rate.textContent).toBe('450');
    expect(screen.getByLabelText('Quantity for row 1 in schedule A').tagName).toBe(
      'SPAN',
    );
    const unit = screen.getByLabelText<HTMLInputElement>(
      'Unit for row 1 in schedule A',
    );
    expect(unit.tagName).toBe('INPUT');
    expect(screen.getAllByText('unresolved_unit').length).toBeGreaterThan(0);

    fireEvent.change(screen.getByLabelText('Work code (your reference)'), {
      target: { value: 'PL270-CRB' },
    });
    fireEvent.change(unit, { target: { value: 'ROUTE_KILOMETRE' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm and create Work' }));

    await waitFor(() => {
      expect(onConfirmed).toHaveBeenCalledOnce();
    });
    const [orgArg, docArg, requestArg] = confirmLoa.mock.calls[0] as [
      string,
      string,
      ConfirmWorkRequest,
    ];
    expect(orgArg).toBe(ORG_ID);
    expect(docArg).toBe(DOC_ID);
    expect(requestArg.workCode).toBe('PL270-CRB');
    // Every extracted value is submitted exactly as the parser read it —
    // the server compares each one against the stored parse and refuses a
    // mismatch by name.
    expect(requestArg.letterNumber).toBe('L-42/2025');
    expect(requestArg.letterDate).toBe('2025-06-01');
    expect(requestArg.letterPercentage).toBe('10.000');
    expect(requestArg.letterPercentageDirection).toBe('below');
    expect(requestArg.schedules).toHaveLength(1);
    expect(requestArg.schedules[0]?.items[0]).toMatchObject({
      itemNumber: 'A/1',
      awardedQuantity: '2',
      effectiveRate: '450',
      unitCode: 'ROUTE_KILOMETRE',
      sourceRef: { scheduleId: 'A', itemSno: '1' },
    });
  });

  it('discards the letter from the review screen and returns to the register', async () => {
    const discardLoaDocument = vi.fn().mockResolvedValue({
      document: { ...REVIEW_DOCUMENT, extractionStatus: 'discarded' },
      discardedSupportingDocumentIds: [],
    });
    const onBack = vi.fn();
    const onDiscarded = vi.fn();
    const api = stubApi({
      getLoaDocument: vi.fn().mockResolvedValue(REVIEW_DOCUMENT),
      discardLoaDocument,
    });
    render(
      <ReviewLoa
        api={api}
        organisationId={ORG_ID}
        documentId={DOC_ID}
        canModify
        onConfirmed={vi.fn()}
        onBack={onBack}
        onDiscarded={onDiscarded}
      />,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Discard this letter' }));
    // It asks once: the way back is uploading the corrected letter.
    expect(screen.getByText(/Upload the corrected letter to start again/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm discard' }));

    await waitFor(() => {
      expect(discardLoaDocument).toHaveBeenCalledWith(ORG_ID, DOC_ID);
    });
    // The withdrawal exit, not the plain one: the shell must leave without
    // asking about corrections the reviewer has just thrown away.
    await waitFor(() => {
      expect(onDiscarded).toHaveBeenCalledOnce();
    });
    expect(onBack).not.toHaveBeenCalled();
  });

  it('keeps the letter, and its values, when the reviewer backs out of the discard', async () => {
    const discardLoaDocument = vi.fn();
    const api = stubApi({
      getLoaDocument: vi.fn().mockResolvedValue(REVIEW_DOCUMENT),
      discardLoaDocument,
    });
    render(
      <ReviewLoa
        api={api}
        organisationId={ORG_ID}
        documentId={DOC_ID}
        canModify
        onConfirmed={vi.fn()}
        onBack={vi.fn()}
        onDiscarded={vi.fn()}
      />,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Discard this letter' }));
    fireEvent.click(screen.getByRole('button', { name: 'Keep reviewing' }));
    expect(discardLoaDocument).not.toHaveBeenCalled();
    expect(screen.getByTestId('fact-letter-number').textContent).toBe('L-42/2025');
  });

  it('reports a refused discard without leaving the review screen', async () => {
    const onBack = vi.fn();
    const api = stubApi({
      getLoaDocument: vi.fn().mockResolvedValue(REVIEW_DOCUMENT),
      discardLoaDocument: vi
        .fn()
        .mockRejectedValue(
          new RequestFailedError(
            409,
            'DOCUMENT_CONFIRMED',
            'loa-letter.pdf has already been confirmed into a Work.',
          ),
        ),
    });
    render(
      <ReviewLoa
        api={api}
        organisationId={ORG_ID}
        documentId={DOC_ID}
        canModify
        onConfirmed={vi.fn()}
        onBack={onBack}
        onDiscarded={vi.fn()}
      />,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Discard this letter' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm discard' }));
    expect((await screen.findByRole('alert')).textContent).toContain(
      'already been confirmed into a Work',
    );
    expect(onBack).not.toHaveBeenCalled();
  });

  it('offers no discard to a role that cannot modify', async () => {
    const api = stubApi({
      getLoaDocument: vi.fn().mockResolvedValue(REVIEW_DOCUMENT),
    });
    render(
      <ReviewLoa
        api={api}
        organisationId={ORG_ID}
        documentId={DOC_ID}
        canModify={false}
        onConfirmed={vi.fn()}
        onBack={vi.fn()}
        onDiscarded={vi.fn()}
      />,
    );

    await screen.findByTestId('fact-letter-number');
    expect(screen.queryByRole('button', { name: 'Discard this letter' })).toBeNull();
  });

  it('opens a field for every value the parser could not read', async () => {
    // A letter whose header and totals block both defeated the parser: with
    // nothing extracted there is nothing to lock, and the whole form is the
    // reviewer's to complete.
    const unreadable = {
      ...REVIEW_DOCUMENT,
      extractionPayload: {
        ...REVIEW_PAYLOAD,
        review: {
          ...REVIEW_PAYLOAD.review,
          header: {
            letterNumber: { value: null, raw: 'Letter No:', needsReview: true },
            letterDate: { value: null, raw: 'Dated:', needsReview: true },
            workDescription: { value: null, raw: 'Name of work:', needsReview: true },
          },
          pricingShape: {
            ...REVIEW_PAYLOAD.review.pricingShape,
            needsReview: true,
          },
        },
      },
    };
    const api = stubApi({ getLoaDocument: vi.fn().mockResolvedValue(unreadable) });
    render(
      <ReviewLoa
        api={api}
        organisationId={ORG_ID}
        documentId={DOC_ID}
        canModify
        onConfirmed={vi.fn()}
        onBack={vi.fn()}
        onDiscarded={vi.fn()}
      />,
    );

    const letterNumber =
      await screen.findByLabelText<HTMLInputElement>('Letter number');
    expect(letterNumber.tagName).toBe('INPUT');
    expect(letterNumber.value).toBe('');
    expect(screen.getByLabelText('Letter date').tagName).toBe('INPUT');
    expect(screen.getByLabelText('Work description').tagName).toBe('TEXTAREA');
    expect(screen.getByLabelText('Advertised value (₹)').tagName).toBe('INPUT');
    expect(screen.getByLabelText('Contract value (₹)').tagName).toBe('INPUT');
    // Nothing was extracted, so no panel of facts is shown at all.
    expect(screen.queryByTestId('letter-facts')).toBeNull();
  });

  it('lets read-only roles review but not confirm', async () => {
    const api = stubApi({
      getLoaDocument: vi.fn().mockResolvedValue(REVIEW_DOCUMENT),
    });
    render(
      <ReviewLoa
        api={api}
        organisationId={ORG_ID}
        documentId={DOC_ID}
        canModify={false}
        onConfirmed={vi.fn()}
        onBack={vi.fn()}
        onDiscarded={vi.fn()}
      />,
    );

    await screen.findByTestId('fact-letter-number');
    expect(
      screen.queryByRole('button', { name: 'Confirm and create Work' }),
    ).toBeNull();
    expect(screen.getByText(/ask an owner or office member/)).toBeTruthy();
  });

  it('warns, without refusing, when the letter number is already on record', async () => {
    const api = stubApi({
      getLoaDocument: vi.fn().mockResolvedValue({
        ...REVIEW_DOCUMENT,
        letterNumberMatches: [
          {
            kind: 'work' as const,
            id: WORK_ID,
            letterNumber: 'L-42/2025',
            label: 'PL270-CRB',
            status: 'active',
            confirmedWorkId: WORK_ID,
            at: '2026-05-04T00:00:00.000Z',
          },
        ],
      }),
    });
    render(
      <ReviewLoa
        api={api}
        organisationId={ORG_ID}
        documentId={DOC_ID}
        canModify
        onConfirmed={vi.fn()}
        onBack={vi.fn()}
        onDiscarded={vi.fn()}
      />,
    );

    const warning = await screen.findByTestId('letter-number-conflict');
    expect(warning.textContent).toContain('L-42/2025');
    expect(warning.textContent).toContain('PL270-CRB');
    expect(warning.textContent).toContain(
      'confirming under this number will be refused',
    );
    // A warning, not a refusal: the reviewer can still confirm.
    expect(
      screen.getByRole('button', { name: 'Confirm and create Work' }),
    ).toBeTruthy();
  });

  it('opens only the first schedule, and expand all reveals the rest', async () => {
    const twoSchedules = {
      ...REVIEW_DOCUMENT,
      extractionPayload: {
        ...REVIEW_PAYLOAD,
        review: {
          ...REVIEW_PAYLOAD.review,
          items: [
            REVIEW_PAYLOAD.review.items[0],
            {
              ...REVIEW_PAYLOAD.review.items[0],
              schedule: { id: 'B' },
              itemSno: '1',
              // The conservative layout reading, whose per-row boundary the
              // parser never verified, so it stays editable.
              descriptionSource: 'layout-overinclusive',
              description:
                'Distribution board with a description long enough that two lines cannot hold it, which is exactly the shape the owner reported on a real letter',
            },
          ],
        },
      },
    };
    const api = stubApi({
      getLoaDocument: vi.fn().mockResolvedValue(twoSchedules),
    });
    render(
      <ReviewLoa
        api={api}
        organisationId={ORG_ID}
        documentId={DOC_ID}
        canModify
        onConfirmed={vi.fn()}
        onBack={vi.fn()}
        onDiscarded={vi.fn()}
      />,
    );

    await screen.findByLabelText('Rate for row 1 in schedule A');
    // Schedule B is named but shut, so none of its cells are on the page.
    expect(screen.queryByLabelText('Rate for row 1 in schedule B')).toBeNull();
    const scheduleB = screen
      .getAllByRole('button')
      .find((button) => button.textContent?.includes('Schedule B'));
    expect(scheduleB?.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(screen.getByRole('button', { name: 'Expand all' }));
    expect(screen.getByLabelText('Rate for row 1 in schedule B')).toBeTruthy();

    // A long description is clamped with its own expander, and the value
    // in the field is the whole text either way.
    const description = screen.getByLabelText<HTMLTextAreaElement>(
      'Description for row 1 in schedule B',
    );
    expect(description.value).toContain('two lines cannot hold it');
    expect(description.rows).toBe(2);
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Show the full description for row 1',
      }),
    );
    expect(
      screen.getByLabelText<HTMLTextAreaElement>('Description for row 1 in schedule B')
        .rows,
    ).toBe(10);

    fireEvent.click(screen.getByRole('button', { name: 'Collapse all' }));
    expect(screen.queryByLabelText('Rate for row 1 in schedule A')).toBeNull();
  });
});

describe('ReviewLoa PBG requirement and row editing', () => {
  // The base REVIEW_PAYLOAD (untouched above) has no performance-guarantee
  // field; this variant carries the parsed clause plus a second item row.
  // Row 2's own arithmetic does NOT reconcile — the letter contradicts
  // itself there — so the parser vouches for neither its quantity nor its
  // rate and both stay editable, which is what the totals and removal
  // cases below need to exercise.
  const PBG_PAYLOAD = {
    ...REVIEW_PAYLOAD,
    review: {
      ...REVIEW_PAYLOAD.review,
      header: {
        ...REVIEW_PAYLOAD.review.header,
        performanceGuarantee: {
          amountFigures: 152321.33,
          amountWords:
            'Rupees One Lakh Fifty-Two Thousand Three Hundred And Twenty-One Rupees And Thirty-Three Paise Only',
          submissionDays: 21,
          extensionDays: 60,
          penalInterestPercent: 12,
          raw: 'amounting to Rs. 152321.33 (…) within 21 days from the date of issue of Letter of Acceptance',
          needsReview: false,
        },
      },
      items: [
        ...REVIEW_PAYLOAD.review.items,
        {
          schedule: { id: 'A' },
          itemSno: '2',
          itemCode: 'S02',
          description: 'Distribution board, wall mounted',
          descriptionSource: 'raw-exact',
          qty: '1.000',
          qtyUnit: 'Numbers',
          unitRate: '100.00',
          bidAmount: '95.00',
          reconciliation: { ok: false },
          needsReview: true,
          raw: { anchorLine: '2  S02  Distribution board ...' },
        },
      ],
    },
  };
  const PBG_DOCUMENT = { ...REVIEW_DOCUMENT, extractionPayload: PBG_PAYLOAD };

  /** The same letter with nothing the parser could vouch for in its totals
   * block or its guarantee clause: both carry `needsReview`, so both are
   * the reviewer's to establish and both render as fields. */
  const UNVERIFIED_PAYLOAD = {
    ...PBG_PAYLOAD,
    review: {
      ...PBG_PAYLOAD.review,
      header: {
        ...PBG_PAYLOAD.review.header,
        performanceGuarantee: {
          ...PBG_PAYLOAD.review.header.performanceGuarantee,
          needsReview: true,
        },
      },
      pricingShape: { ...PBG_PAYLOAD.review.pricingShape, needsReview: true },
    },
  };
  const UNVERIFIED_DOCUMENT = {
    ...REVIEW_DOCUMENT,
    extractionPayload: UNVERIFIED_PAYLOAD,
  };

  function renderReview(
    confirmLoa = vi.fn(),
    reviewDocument: LoaDocumentDetail = PBG_DOCUMENT,
  ) {
    const api = stubApi({
      getLoaDocument: vi.fn().mockResolvedValue(reviewDocument),
      confirmLoa: confirmLoa.mockResolvedValue({
        work: { id: WORK_ID },
        schedules: [],
      }),
    });
    render(
      <ReviewLoa
        api={api}
        organisationId={ORG_ID}
        documentId={DOC_ID}
        canModify
        onConfirmed={vi.fn()}
        onBack={vi.fn()}
        onDiscarded={vi.fn()}
      />,
    );
    return confirmLoa;
  }

  it('shows a cleanly read PBG requirement as fact and submits it unchanged', async () => {
    const confirmLoa = renderReview();

    expect((await screen.findByTestId('fact-pbg-amount')).textContent).toBe(
      '₹152321.33',
    );
    expect(screen.getByTestId('fact-pbg-submission-days').textContent).toBe('21 days');
    expect(screen.getByTestId('fact-pbg-extension-days').textContent).toBe('60 days');
    expect(screen.getByTestId('fact-pbg-penal-interest').textContent).toBe('12% p.a.');
    expect(screen.getByText(/amounting to Rs\. 152321\.33/)).toBeTruthy();
    // What the letter demands is not the reviewer's to drop: there is no
    // control to turn the requirement off and none to retype its figures.
    expect(
      screen.queryByLabelText('The letter demands a Performance Bank Guarantee'),
    ).toBeNull();
    expect(screen.queryByLabelText('Required amount (₹)')).toBeNull();

    fireEvent.change(screen.getByLabelText('Work code (your reference)'), {
      target: { value: 'PL273-JHS' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm and create Work' }));

    await waitFor(() => {
      expect(confirmLoa).toHaveBeenCalledOnce();
    });
    const [, , requestArg] = confirmLoa.mock.calls[0] as [
      string,
      string,
      ConfirmWorkRequest,
    ];
    expect(requestArg.pbgRequirement).toEqual({
      requiredAmount: '152321.33',
      submissionDays: 21,
      extensionDays: 60,
      penalInterestPercent: '12',
    });
  });

  it('leaves a flagged guarantee clause entirely to the reviewer', async () => {
    const confirmLoa = renderReview(vi.fn(), UNVERIFIED_DOCUMENT);

    // The parser could not read the clause, so whether the letter demands
    // one at all is the reviewer's answer.
    fireEvent.click(
      await screen.findByLabelText('The letter demands a Performance Bank Guarantee'),
    );
    fireEvent.change(screen.getByLabelText('Work code (your reference)'), {
      target: { value: 'PL273-JHS' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm and create Work' }));

    await waitFor(() => {
      expect(confirmLoa).toHaveBeenCalledOnce();
    });
    const [, , requestArg] = confirmLoa.mock.calls[0] as [
      string,
      string,
      ConfirmWorkRequest,
    ];
    expect(requestArg.pbgRequirement).toBeUndefined();
  });

  it('adds a manual row flagged for review and confirms it with the manual marker', async () => {
    const confirmLoa = renderReview();

    await screen.findByLabelText('Rate for row 1 in schedule A');
    expect(screen.getByTestId('reconciliation-totals').textContent).toContain(
      'Entered rows total ₹1000.00 across 2 rows',
    );

    fireEvent.click(screen.getByRole('button', { name: 'Add row' }));
    const description = screen.getByLabelText('Description for row M1 in schedule A');
    fireEvent.change(description, {
      target: { value: 'Extra switch panels supplied loose' },
    });
    fireEvent.change(screen.getByLabelText('Unit for row M1 in schedule A'), {
      target: { value: 'Nos' },
    });
    fireEvent.change(screen.getByLabelText('Quantity for row M1 in schedule A'), {
      target: { value: '2' },
    });
    fireEvent.change(screen.getByLabelText('Rate for row M1 in schedule A'), {
      target: { value: '50.00' },
    });
    expect(
      screen.getByLabelText<HTMLInputElement>('Item number for row M1 in schedule A')
        .value,
    ).toBe('A/M1');
    expect(screen.getByText('manual row')).toBeTruthy();
    // 900 + 100 + 2×50 against the advertised value of 1000.00. The
    // percentage-adjusted contract value is related context, not the row target.
    expect(screen.getByTestId('reconciliation-totals').textContent).toContain(
      'Entered rows total ₹1100.00 across 3 rows — advertised value ₹1000.00 (difference ₹100.00). ' +
        'Contract value ₹900.00 reflects 10.000% below the advertised value.',
    );

    fireEvent.change(screen.getByLabelText('Work code (your reference)'), {
      target: { value: 'PL273-JHS' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm and create Work' }));

    await waitFor(() => {
      expect(confirmLoa).toHaveBeenCalledOnce();
    });
    const [, , requestArg] = confirmLoa.mock.calls[0] as [
      string,
      string,
      ConfirmWorkRequest,
    ];
    const manualItem = requestArg.schedules[0]?.items.find(
      (item) => item.itemNumber === 'A/M1',
    );
    expect(manualItem).toMatchObject({
      manualEntry: true,
      description: 'Extra switch panels supplied loose',
      awardedQuantity: '2',
      effectiveRate: '50.00',
    });
    expect(manualItem?.sourceRef).toBeUndefined();
    // Parsed rows keep their sourceRef untouched.
    expect(requestArg.schedules[0]?.items[0]?.sourceRef).toEqual({
      scheduleId: 'A',
      itemSno: '1',
    });
  });

  it('removes a parsed row behind an inline confirmation and recomputes the totals', async () => {
    const confirmLoa = renderReview();

    await screen.findByLabelText('Rate for row 2 in schedule A');
    fireEvent.click(screen.getByRole('button', { name: 'Remove row 2 in schedule A' }));
    // Nothing is removed until the inline prompt is confirmed.
    expect(screen.getByLabelText('Rate for row 2 in schedule A')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm remove' }));

    expect(screen.queryByLabelText('Rate for row 2 in schedule A')).toBeNull();
    expect(screen.getByTestId('reconciliation-totals').textContent).toContain(
      'Entered rows total ₹900.00 across 1 row — advertised value ₹1000.00 (difference -₹100.00)',
    );

    fireEvent.change(screen.getByLabelText('Work code (your reference)'), {
      target: { value: 'PL273-JHS' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm and create Work' }));
    await waitFor(() => {
      expect(confirmLoa).toHaveBeenCalledOnce();
    });
    const [, , requestArg] = confirmLoa.mock.calls[0] as [
      string,
      string,
      ConfirmWorkRequest,
    ];
    expect(requestArg.schedules).toHaveLength(1);
    expect(requestArg.schedules[0]?.items).toHaveLength(1);
    expect(requestArg.schedules[0]?.items[0]?.itemNumber).toBe('A/1');
  });

  it('keeps a removal candidate when the reviewer chooses Keep', async () => {
    renderReview();
    await screen.findByLabelText('Rate for row 2 in schedule A');
    fireEvent.click(screen.getByRole('button', { name: 'Remove row 2 in schedule A' }));
    fireEvent.click(screen.getByRole('button', { name: 'Keep' }));
    expect(screen.getByLabelText('Rate for row 2 in schedule A')).toBeTruthy();
  });

  // Click the real button. Dispatching submit on the <form> would prove
  // nothing: it is exactly the step native constraint validation used to
  // abort, which is why these checks were unreachable before the form
  // took validation over.
  function submitReview() {
    fireEvent.click(screen.getByRole('button', { name: 'Confirm and create Work' }));
  }

  it('binds each rejected field to its own message, reports them together, and focuses the first', async () => {
    const confirmLoa = renderReview(vi.fn(), UNVERIFIED_DOCUMENT);

    const direction = await screen.findByLabelText('Direction');
    fireEvent.change(direction, { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Submit within (days)'), {
      target: { value: '0' },
    });
    fireEvent.change(screen.getByLabelText('Work code (your reference)'), {
      target: { value: 'PL273-JHS' },
    });
    submitReview();

    expect(confirmLoa).not.toHaveBeenCalled();
    expect(direction.getAttribute('aria-invalid')).toBe('true');
    const directionMessage = screen.getByText(
      'Select the percentage direction printed on the letter.',
    );
    expect(direction.getAttribute('aria-describedby')).toBe(directionMessage.id);
    // Per-field messages stay silent; the summary carries the announcement.
    expect(directionMessage.getAttribute('role')).toBeNull();
    const days = screen.getByLabelText('Submit within (days)');
    expect(days.getAttribute('aria-invalid')).toBe('true');
    // Both failures arrive on one pass, not one resubmission apart.
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(
      'Select the percentage direction printed on the letter.',
    );
    expect(alert.textContent).toContain(
      'Enter the PBG submission window in days (1–180).',
    );
    // The direction is flagged first, so that is where a keyboard user lands
    // instead of hunting a form a hundred rows long.
    expect(document.activeElement).toBe(direction);

    fireEvent.change(direction, { target: { value: 'below' } });
    fireEvent.change(days, { target: { value: '21' } });
    submitReview();
    await waitFor(() => {
      expect(confirmLoa).toHaveBeenCalledOnce();
    });
    expect(
      screen.queryByText('Select the percentage direction printed on the letter.'),
    ).toBeNull();
  });

  it('asks for at least one item row and moves focus to the control that adds one', async () => {
    const confirmLoa = renderReview();

    await screen.findByLabelText('Rate for row 1 in schedule A');
    for (const itemSno of ['1', '2']) {
      fireEvent.click(
        screen.getByRole('button', { name: `Remove row ${itemSno} in schedule A` }),
      );
      fireEvent.click(screen.getByRole('button', { name: 'Confirm remove' }));
    }
    fireEvent.change(screen.getByLabelText('Work code (your reference)'), {
      target: { value: 'PL273-JHS' },
    });
    submitReview();

    expect(confirmLoa).not.toHaveBeenCalled();
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Add at least one item row before confirming.',
    );
    // No box is wrong when the table is empty, so focus goes to the one that
    // can satisfy the rule.
    expect(document.activeElement).toBe(
      screen.getByLabelText('Schedule for the new row'),
    );
  });

  it('subtotals each schedule exactly and withholds the figure when a cell is unusable', async () => {
    renderReview();

    await screen.findByLabelText('Rate for row 1 in schedule A');
    expect(screen.getByTestId('schedule-subtotal-A').textContent).toBe('₹1000.00');

    // Mid-edit and malformed cells report nothing rather than a total that
    // silently omits a row. Row 2 is the one the letter's own arithmetic
    // failed, so its rate is still the reviewer's to establish.
    fireEvent.change(screen.getByLabelText('Rate for row 2 in schedule A'), {
      target: { value: '' },
    });
    expect(screen.getByTestId('schedule-subtotal-A').textContent).toBe(
      'Not yet available',
    );
  });

  it('keeps the advertised-value difference exact for six-decimal rates', async () => {
    renderReview();

    fireEvent.change(await screen.findByLabelText('Rate for row 2 in schedule A'), {
      target: { value: '100.000002' },
    });
    // 2 × 450 plus 1 × 100.000002 against an advertised value of 1000.00:
    // the comparison survives at the row total's own nine-digit scale.
    expect(screen.getByTestId('schedule-subtotal-A').textContent).toBe('₹1000.000002');
    expect(screen.getByTestId('reconciliation-totals').textContent).toContain(
      'Entered rows total ₹1000.000002 across 2 rows — advertised value ₹1000.00 ' +
        '(difference ₹0.000002)',
    );
  });

  it('explains the PL281 above-par contract without reporting its premium as missing rows', async () => {
    const pl281Document = {
      ...PBG_DOCUMENT,
      extractionPayload: {
        ...PBG_PAYLOAD,
        review: {
          ...PBG_PAYLOAD.review,
          pricingShape: {
            advertised_value: 118502769.36,
            contract_value: 147535947.85,
            pricing_shape: 'letter_percentage',
            letter_percentage: 24.5,
            letter_percentage_direction: 'above',
            needsReview: false,
          },
          items: [
            {
              ...PBG_PAYLOAD.review.items[0],
              qty: '1.000',
              unitRate: '118502769.36',
              bidAmount: '118502769.36',
            },
          ],
        },
      },
    };
    renderReview(vi.fn(), pl281Document);

    await screen.findByLabelText('Rate for row 1 in schedule A');
    const totals = screen.getByTestId('reconciliation-totals').textContent;
    expect(totals).toContain(
      'Entered rows total ₹118502769.36 across 1 row — advertised value ₹118502769.36 (difference ₹0.00).',
    );
    expect(totals).toContain(
      'Contract value ₹147535947.85 reflects 24.500% above the advertised value.',
    );
    expect(totals).not.toContain('-₹29033178.49');
  });

  it('keeps Shape B item rows tied to advertised value and explains schedule pricing', async () => {
    const perScheduleDocument = {
      ...PBG_DOCUMENT,
      extractionPayload: {
        ...PBG_PAYLOAD,
        review: {
          ...PBG_PAYLOAD.review,
          pricingShape: {
            advertised_value: 1000,
            contract_value: 875,
            pricing_shape: 'per_schedule',
            letter_percentage: null,
            letter_percentage_direction: null,
            needsReview: false,
          },
        },
      },
    };
    renderReview(vi.fn(), perScheduleDocument);

    await screen.findByLabelText('Rate for row 1 in schedule A');
    expect(screen.getByTestId('reconciliation-totals').textContent).toContain(
      'Entered rows total ₹1000.00 across 2 rows — advertised value ₹1000.00 (difference ₹0.00). ' +
        'Contract value ₹875.00 comes from the accepted schedule totals.',
    );
  });

  it('keeps review edits available for retry and shows the server request reference', async () => {
    const confirmLoa = vi
      .fn()
      .mockRejectedValueOnce(
        new RequestFailedError(
          503,
          'DATABASE_UNAVAILABLE',
          'The database is temporarily unavailable. Nothing was saved. Try again.',
          undefined,
          'req-db-1',
        ),
      );
    renderReview(confirmLoa);

    const workCode = await screen.findByLabelText<HTMLInputElement>(
      'Work code (your reference)',
    );
    fireEvent.change(workCode, { target: { value: 'PL281-BB' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm and create Work' }));

    expect((await screen.findByRole('alert')).textContent).toContain(
      'The database is temporarily unavailable. Nothing was saved. Try again. Reference: req-db-1.',
    );
    expect(workCode.value).toBe('PL281-BB');
    // The extracted rate is still on screen, unchanged and still read-only.
    expect(screen.getByLabelText('Rate for row 1 in schedule A').textContent).toBe(
      '450',
    );
    expect(
      screen.getByRole<HTMLButtonElement>('button', {
        name: 'Confirm and create Work',
      }).disabled,
    ).toBe(false);
  });
});

describe('ReviewLoa payment categories', () => {
  it('sends the reviewer-selected category and omits it when uncategorised', async () => {
    const confirmLoa = vi
      .fn()
      .mockResolvedValue({ work: { id: WORK_ID }, schedules: [] });
    const api = stubApi({
      getLoaDocument: vi.fn().mockResolvedValue(REVIEW_DOCUMENT),
      confirmLoa,
    });
    render(
      <ReviewLoa
        api={api}
        organisationId={ORG_ID}
        documentId={DOC_ID}
        canModify
        onConfirmed={vi.fn()}
        onBack={vi.fn()}
        onDiscarded={vi.fn()}
      />,
    );

    const categorySelect = await screen.findByLabelText<HTMLSelectElement>(
      'Payment category for row 1 in schedule A',
    );
    expect(categorySelect.value).toBe('');
    fireEvent.change(categorySelect, { target: { value: 'SUPPLY_AND_INSTALLATION' } });
    fireEvent.change(screen.getByLabelText('Work code (your reference)'), {
      target: { value: 'PL270-CAT' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm and create Work' }));

    await waitFor(() => {
      expect(confirmLoa).toHaveBeenCalledOnce();
    });
    const [, , requestArg] = confirmLoa.mock.calls[0] as [
      string,
      string,
      ConfirmWorkRequest,
    ];
    expect(requestArg.schedules[0]?.items[0]?.paymentCategory).toBe(
      'SUPPLY_AND_INSTALLATION',
    );
  });

  it('omits the field entirely when the reviewer leaves an item uncategorised', async () => {
    const confirmLoa = vi
      .fn()
      .mockResolvedValue({ work: { id: WORK_ID }, schedules: [] });
    const api = stubApi({
      getLoaDocument: vi.fn().mockResolvedValue(REVIEW_DOCUMENT),
      confirmLoa,
    });
    render(
      <ReviewLoa
        api={api}
        organisationId={ORG_ID}
        documentId={DOC_ID}
        canModify
        onConfirmed={vi.fn()}
        onBack={vi.fn()}
        onDiscarded={vi.fn()}
      />,
    );

    const categorySelect = await screen.findByLabelText<HTMLSelectElement>(
      'Payment category for row 1 in schedule A',
    );
    expect(categorySelect.value).toBe('');
    fireEvent.change(screen.getByLabelText('Work code (your reference)'), {
      target: { value: 'PL270-UNC' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm and create Work' }));
    await waitFor(() => {
      expect(confirmLoa).toHaveBeenCalledOnce();
    });
    const [, , requestArg] = confirmLoa.mock.calls[0] as [
      string,
      string,
      ConfirmWorkRequest,
    ];
    expect('paymentCategory' in (requestArg.schedules[0]?.items[0] ?? {})).toBe(false);
  });
});
