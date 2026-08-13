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
});

describe('UploadLoa', () => {
  it('requires a chosen file before uploading', async () => {
    const api = stubApi();
    render(
      <UploadLoa
        api={api}
        organisationId={ORG_ID}
        onUploaded={vi.fn()}
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
});

describe('ReviewLoa', () => {
  it('prefills parsed values, shows flags with printed source, and confirms', async () => {
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
      />,
    );

    // Parsed values arrive as editable prefills with their provenance.
    const letterNumber = await screen.findByLabelText('Letter number');
    expect((letterNumber as HTMLInputElement).value).toBe('L-42/2025');
    expect(
      screen.getByRole('heading', { name: '1 review issue needs attention' }),
    ).toBeTruthy();
    expect(screen.getByText('The printed unit could not be resolved.')).toBeTruthy();
    expect(screen.getByText('Route Kilo Meter (RKM)')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Work code (your reference)'), {
      target: { value: 'PL270-CRB' },
    });
    fireEvent.change(screen.getByLabelText('Rate for row 1 in schedule A'), {
      target: { value: '451.00' },
    });
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
    expect(requestArg.letterPercentage).toBe('10.000');
    expect(requestArg.letterPercentageDirection).toBe('below');
    expect(requestArg.schedules).toHaveLength(1);
    expect(requestArg.schedules[0]?.items[0]).toMatchObject({
      itemNumber: 'A/1',
      effectiveRate: '451.00',
      sourceRef: { scheduleId: 'A', itemSno: '1' },
    });
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
      />,
    );

    await screen.findByLabelText('Letter number');
    expect(
      screen.queryByRole('button', { name: 'Confirm and create Work' }),
    ).toBeNull();
    expect(screen.getByText(/ask an owner or office member/)).toBeTruthy();
  });
});

describe('ReviewLoa PBG requirement and row editing', () => {
  // The base REVIEW_PAYLOAD (untouched above) has no performance-guarantee
  // field; this variant carries the parsed clause plus a second item row
  // so removal leaves a confirmable Work.
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
          qty: '1.000',
          qtyUnit: 'Numbers',
          unitRate: '100.00',
          bidAmount: '100.00',
          needsReview: false,
          raw: { anchorLine: '2  S02  Distribution board ...' },
        },
      ],
    },
  };
  const PBG_DOCUMENT = { ...REVIEW_DOCUMENT, extractionPayload: PBG_PAYLOAD };

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
      />,
    );
    return confirmLoa;
  }

  it('prefills the parsed PBG requirement and submits it with the confirmation', async () => {
    const confirmLoa = renderReview();

    const amount = await screen.findByLabelText('Required amount (₹)');
    expect((amount as HTMLInputElement).value).toBe('152321.33');
    expect(screen.getByLabelText<HTMLInputElement>('Submit within (days)').value).toBe(
      '21',
    );
    expect(
      screen.getByLabelText<HTMLInputElement>('Extension window (days)').value,
    ).toBe('60');
    expect(
      screen.getByLabelText<HTMLInputElement>('Penal interest (% p.a.)').value,
    ).toBe('12');
    expect(screen.getByText(/amounting to Rs\. 152321\.33/)).toBeTruthy();

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

  it('confirms without a PBG requirement when the reviewer unchecks it', async () => {
    const confirmLoa = renderReview();

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

  // Submitting through the form rather than the button: the controls under
  // test are `required`, and a click would be stopped by the browser's own
  // validation before the view's checks ever run.
  // Click the real button. Dispatching submit on the <form> would prove
  // nothing: it is exactly the step native constraint validation used to
  // abort, which is why these checks were unreachable before the form
  // took validation over.
  function submitReview() {
    fireEvent.click(screen.getByRole('button', { name: 'Confirm and create Work' }));
  }

  it('binds each rejected field to its own message, reports them together, and focuses the first', async () => {
    const confirmLoa = renderReview();

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
    // silently omits a row.
    fireEvent.change(screen.getByLabelText('Rate for row 2 in schedule A'), {
      target: { value: '' },
    });
    expect(screen.getByTestId('schedule-subtotal-A').textContent).toBe(
      'Not yet available',
    );
  });

  it('keeps the advertised-value difference exact for six-decimal rates', async () => {
    renderReview();

    fireEvent.change(await screen.findByLabelText('Rate for row 1 in schedule A'), {
      target: { value: '450.000001' },
    });
    // 2 × 450.000001 plus 1 × 100 against an advertised value of 1000.00: the
    // comparison survives at the row total's own nine-digit scale.
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
    expect(
      screen.getByLabelText<HTMLInputElement>('Rate for row 1 in schedule A').value,
    ).toBe('450');
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
