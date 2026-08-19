// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { RailwayMeasurement } from '@auto-mb/contracts';
import { RailwayMeasurementPanel } from '../../src/views/RailwayMeasurementPanel.js';
import { billableBook, ORG_ID, stubApi, WORK_ID } from './helpers.js';

/**
 * The railway-measurement panel (migration 0111).
 *
 * The three shapes it takes are the three the gate cares about, and the
 * distinction the tests below hold hardest is the one that would be
 * easiest to erode: a MISMATCH offers no way past itself. A panel that
 * drew a Confirm button on a disagreement would be a screen inviting an
 * operator to click past a difference in quantities, and the server
 * refusing it twice afterwards would only make that a worse experience,
 * not a safer one.
 */

function measurement(overrides: Partial<RailwayMeasurement> = {}): RailwayMeasurement {
  return {
    id: 'measurement-1',
    workId: WORK_ID,
    measurementBookId: billableBook().id,
    originalFilename: 'CMB-01.pdf',
    sha256: 'a'.repeat(64),
    sizeBytes: 2048,
    matchStatus: 'matched',
    lines: [
      {
        itemNumber: 'A/1',
        matched: true,
        refusal: null,
        detail: null,
        confirmedByUserId: null,
        confirmedAt: null,
      },
    ],
    settles: true,
    discardedAt: null,
    createdAt: '2026-05-10T10:00:00.000Z',
    ...overrides,
  };
}

function renderPanel(api: ReturnType<typeof stubApi>) {
  return render(
    <RailwayMeasurementPanel
      api={api}
      organisationId={ORG_ID}
      book={billableBook()}
      canIssue
      canCancel
      onChanged={() => undefined}
    />,
  );
}

describe('the railway measurement panel', () => {
  it('offers the upload, and sends only the file', async () => {
    const uploadRailwayMeasurement = vi
      .fn<ReturnType<typeof stubApi>['uploadRailwayMeasurement']>()
      .mockResolvedValue(measurement());
    const api = stubApi({
      getRailwayMeasurement: vi.fn().mockResolvedValue(null),
      uploadRailwayMeasurement,
    });
    renderPanel(api);

    const input = await screen.findByLabelText('Railway measurement PDF');
    // No field to type a quantity or a remark into: every fact is read
    // from the document on the server.
    expect(screen.queryByLabelText(/quantity/i)).toBeNull();
    const file = new File(['%PDF-1.7'], 'CMB-01.pdf', { type: 'application/pdf' });
    fireEvent.change(input, { target: { files: [file] } });
    // Submitted through the form: jsdom's constraint validation does not
    // see the file list this test injects and would block a click.
    fireEvent.submit(input.closest('form') as HTMLFormElement);

    await waitFor(() => {
      expect(uploadRailwayMeasurement).toHaveBeenCalledWith(
        ORG_ID,
        billableBook().id,
        file,
        'CMB-01.pdf',
      );
    });
    expect(uploadRailwayMeasurement.mock.calls[0]).toHaveLength(4);
  });

  it('says the bill cannot be recorded when nothing is on record', async () => {
    const api = stubApi({ getRailwayMeasurement: vi.fn().mockResolvedValue(null) });
    renderPanel(api);
    expect(await screen.findByText(/cannot be recorded before it/i)).not.toBeNull();
  });

  it('reports a matched measurement without asking for anything', async () => {
    const api = stubApi({
      getRailwayMeasurement: vi.fn().mockResolvedValue(measurement()),
    });
    renderPanel(api);
    expect(await screen.findByText('Matched')).not.toBeNull();
    expect(screen.queryByRole('button', { name: /^Confirm item/ })).toBeNull();
  });

  it('names each differing line, and offers no way to confirm past a mismatch', async () => {
    const api = stubApi({
      getRailwayMeasurement: vi.fn().mockResolvedValue(
        measurement({
          matchStatus: 'mismatched',
          settles: false,
          lines: [
            {
              itemNumber: 'A/1',
              matched: false,
              refusal: 'quantity',
              detail:
                'Item A/1: this Measurement Book measures 2.8, the railway records 2.1.',
              confirmedByUserId: null,
              confirmedAt: null,
            },
          ],
        }),
      ),
    });
    renderPanel(api);
    expect(await screen.findByText('Does not match')).not.toBeNull();
    expect(screen.getByText(/measures 2\.8/)).not.toBeNull();
    // The rule this panel must not soften.
    expect(screen.queryByRole('button', { name: /^Confirm item/ })).toBeNull();
  });

  it('asks for a confirmation per line when nothing could be read', async () => {
    const confirmRailwayMeasurementLine = vi
      .fn<ReturnType<typeof stubApi>['confirmRailwayMeasurementLine']>()
      .mockResolvedValue(
        measurement({
          matchStatus: 'unreadable',
          settles: true,
          lines: [
            {
              itemNumber: 'A/1',
              matched: false,
              refusal: null,
              detail: null,
              confirmedByUserId: 'user-1',
              confirmedAt: '2026-05-12T09:00:00.000Z',
            },
          ],
        }),
      );
    const api = stubApi({
      getRailwayMeasurement: vi.fn().mockResolvedValue(
        measurement({
          matchStatus: 'unreadable',
          settles: false,
          lines: [
            {
              itemNumber: 'A/1',
              matched: false,
              refusal: null,
              detail: null,
              confirmedByUserId: null,
              confirmedAt: null,
            },
          ],
        }),
      ),
      confirmRailwayMeasurementLine,
    });
    renderPanel(api);

    expect(await screen.findByText('Could not be read')).not.toBeNull();
    expect(screen.getByText(/1 of 1 still to confirm/)).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm item A/1' }));
    await waitFor(() => {
      // One line at a time, named. A control that confirmed the whole
      // document at once would be the single click migration 0111
      // refuses to model.
      expect(confirmRailwayMeasurementLine).toHaveBeenCalledWith(
        ORG_ID,
        'measurement-1',
        'A/1',
      );
    });
  });
});
