// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Work } from '@auto-mb/contracts';
import { WriteOutwardLetter } from '../../src/views/CorrespondenceComposer.js';
import { MaintenanceRequestForm } from '../../src/views/MaintenanceRequestForm.js';
import { Production } from '../../src/views/Production.js';
import { ORG_ID, WORK_ID, stubApi } from './helpers.js';

/*
 * Every Work picker in the product, after the conversion (§ 38, owner
 * ruling of 2026-08-22).
 *
 * The primitive's own contract is `test/ui-primitives.test.tsx`. What is
 * asserted here is the thing a shared primitive most easily loses on the
 * way into a screen: the CONVERTED picker still yields the same value to
 * the same submission it did as a `<select>`. A picker that filters
 * beautifully and hands the server an empty `workId` is a worse control
 * than the wall of titles it replaced.
 *
 * `test/work-picker-census.test.ts` is the other half — it counts the
 * source so a fifth picker added next month cannot quietly be a
 * `<select>` again.
 */

const OTHER_WORK = '5b6c1d2e-3f40-4a51-8b62-7c8d9e0f1a2b';

const WORKS: readonly Partial<Work>[] = [
  {
    id: WORK_ID,
    workCode: 'SIG-2026-11',
    title: 'Signalling and telecommunication at Alpha yard',
  },
  {
    id: OTHER_WORK,
    workCode: 'TEL-2026-03',
    title: 'Telecom at Beta yard',
  },
];

function picker(label: string): HTMLInputElement {
  return screen.getByRole<HTMLInputElement>('combobox', { name: label });
}

/** Types into one picker and takes the row that survives, the way an
 * operator with a code in their hand does. */
function pick(label: string, typed: string, row: string | RegExp): void {
  const input = screen.getByRole('combobox', { name: label });
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value: typed } });
  fireEvent.mouseDown(screen.getByRole('option', { name: row }));
}

/** The rows one picker offers, out of the popup it names. Scoped through
 * `aria-controls` because the native `<select>`s on the same screens have
 * `<option>` children of their own. */
function pickerRows(label: string): readonly string[] {
  const input = screen.getByRole('combobox', { name: label });
  fireEvent.focus(input);
  const list = document.getElementById(input.getAttribute('aria-controls') ?? '');
  return [...(list?.querySelectorAll('[role="option"]') ?? [])].map(
    (row) => row.textContent ?? '',
  );
}

describe('the Work pickers', () => {
  it('files a letter against the Work the composer picked', async () => {
    const api = stubApi({ listWorks: vi.fn().mockResolvedValue(WORKS) });
    render(
      <WriteOutwardLetter
        api={api}
        organisationId={ORG_ID}
        onDone={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    await screen.findByRole('combobox', { name: 'Related Work (optional)' });
    pick('Related Work (optional)', 'tel-2026', /TEL-2026-03/);
    expect(picker('Related Work (optional)').value).toContain('TEL-2026-03');
  });

  it('raises a site material request against the Work it picked', async () => {
    const api = stubApi({
      listWorks: vi.fn().mockResolvedValue(WORKS),
      createMaintenanceRequest: vi.fn().mockResolvedValue({ id: 'mr' }),
    });
    render(
      <MaintenanceRequestForm
        api={api}
        organisationId={ORG_ID}
        onDone={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    await screen.findByRole('combobox', { name: 'Work' });
    // The whole list is offered when nothing has been typed, which is the
    // `<select>` behaviour this replaced.
    expect(pickerRows('Work')).toEqual([
      'SIG-2026-11Signalling and telecommunication at Alpha yard',
      'TEL-2026-03Telecom at Beta yard',
    ]);

    pick('Work', 'alpha', /SIG-2026-11/);
    expect(picker('Work').value).toContain('SIG-2026-11');
  });

  it('submits the job card with the picked Work id, inside its real form', async () => {
    const createJobCard = vi.fn().mockResolvedValue({ id: 'jc' });
    const api = stubApi({
      listWorks: vi.fn().mockResolvedValue(WORKS),
      listProductionItems: vi.fn().mockResolvedValue({
        items: [
          {
            id: 'i1',
            itemCode: 'RK-42U',
            name: '42U rack',
            unit: 'Nos',
            manufactured: true,
            active: true,
          },
        ],
      }),
      listJobCards: vi.fn().mockResolvedValue({
        jobCards: [],
        nextCursor: null,
        openCount: 0,
        inProductionCount: 0,
        dispatchReadyCount: 0,
      }),
      createJobCard,
    });
    render(
      <Production
        api={api}
        organisationId={ORG_ID}
        workId={null}
        canRecord
        onOpenJobCard={vi.fn()}
        onOpenItemMaster={vi.fn()}
      />,
    );

    fireEvent.click(await screen.findByRole('button', { name: /New job card/ }));
    await screen.findByRole('combobox', { name: 'Work' });

    fireEvent.change(screen.getByRole('combobox', { name: 'OEM item' }), {
      target: { value: 'i1' },
    });
    pick('Work', 'tel', /TEL-2026-03/);
    fireEvent.change(screen.getByLabelText('Source reference'), {
      target: { value: 'A2/1' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Raise job card/ }));

    await waitFor(() => {
      expect(createJobCard).toHaveBeenCalled();
    });
    expect(createJobCard.mock.calls[0]?.[1]).toMatchObject({ workId: OTHER_WORK });
  });
});
