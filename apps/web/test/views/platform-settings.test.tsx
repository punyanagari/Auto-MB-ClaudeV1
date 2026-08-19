// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Entitlement, JobRun, JobSchedule } from '@auto-mb/contracts';
import { OrganisationExportSettings } from '../../src/views/OrganisationExportSettings.js';
import { PlatformSettings } from '../../src/views/PlatformSettings.js';
import { ORG_ID, stubApi } from './helpers.js';

/*
 * The platform panels, on the things only they have to say.
 *
 * Loading, failure and empty are covered for every view once by
 * `state-coverage.test.tsx`. What is here is this screen's own copy:
 * that a module nobody has configured says so rather than pretending
 * somebody chose, that a check whose member has left explains the remedy
 * instead of showing a bare failure, and that the export digest is
 * printed in full.
 */

const SCHEDULE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const RUN_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const EXPORT_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const DIGEST = 'd'.repeat(64);

function flag(overrides: Partial<Entitlement> = {}): Entitlement {
  return {
    key: 'eway_bill',
    label: 'E-way bill',
    description: 'Generating, cancelling and reconciling NIC E-way Bills.',
    enabled: true,
    defaultEnabled: true,
    configured: false,
    note: null,
    setBy: null,
    updatedAt: null,
    ...overrides,
  };
}

function schedule(overrides: Partial<JobSchedule> = {}): JobSchedule {
  return {
    id: SCHEDULE_ID,
    kind: 'instrument_expiry_review',
    label: 'Guarantee and certificate expiry',
    description: 'Reports the guarantees whose expiry falls inside the horizon.',
    enabled: true,
    cadence: 'weekly',
    horizonDays: 45,
    nextRunAt: '2026-08-25T04:00:00.000Z',
    lastEnqueuedAt: '2026-08-18T04:00:00.000Z',
    authorityUserId: 'user-owner',
    disabledReason: null,
    ...overrides,
  };
}

function run(overrides: Partial<JobRun> = {}): JobRun {
  return {
    id: RUN_ID,
    kind: 'instrument_expiry_review',
    state: 'done',
    attempts: 1,
    createdAt: '2026-08-18T04:00:00.000Z',
    finishedAt: '2026-08-18T04:00:02.000Z',
    outcome: { reviewed: 3, lapsed: 0 },
    lastError: null,
    ...overrides,
  };
}

function platformApi(options: {
  readonly entitlements?: readonly Entitlement[];
  readonly schedules?: readonly JobSchedule[];
  readonly runs?: readonly JobRun[];
}) {
  return stubApi({
    listEntitlements: vi
      .fn()
      .mockResolvedValue({ entitlements: options.entitlements ?? [flag()] }),
    listJobSchedules: vi.fn().mockResolvedValue({
      schedules: options.schedules ?? [schedule()],
      runs: options.runs ?? [run()],
    }),
    setEntitlement: vi
      .fn()
      .mockResolvedValue({ entitlement: flag({ enabled: false }) }),
    setJobSchedule: vi.fn().mockResolvedValue({ schedule: schedule() }),
  });
}

describe('the platform settings panel', () => {
  it('renders nothing for an owner who does not hold the entitlements authority', () => {
    // Owner-only is enforced on the route by `role: 'owner'` AND the
    // authority together, so the panel needs both. This is the door, not
    // the lock — the server refuses either way.
    const api = platformApi({});
    const { container } = render(
      <PlatformSettings
        api={api}
        organisationId={ORG_ID}
        isOwner
        canManageEntitlements={false}
        currentUserId="user-a"
      />,
    );
    expect(container.innerHTML).toBe('');
    expect(api.listEntitlements).not.toHaveBeenCalled();
  });

  it('renders nothing for a non-owner holding the authority', () => {
    const api = platformApi({});
    const { container } = render(
      <PlatformSettings
        api={api}
        organisationId={ORG_ID}
        isOwner={false}
        canManageEntitlements
        currentUserId="user-a"
      />,
    );
    expect(container.innerHTML).toBe('');
  });

  it('says when a module has never been configured rather than implying somebody chose', async () => {
    render(
      <PlatformSettings
        api={platformApi({})}
        organisationId={ORG_ID}
        isOwner
        canManageEntitlements
        currentUserId="user-a"
      />,
    );
    expect(
      await screen.findByText(/never configured — using the shipped default \(on\)/),
    ).toBeTruthy();
  });

  it('names the operator and the date once a module has been set', async () => {
    render(
      <PlatformSettings
        api={platformApi({
          entitlements: [
            flag({
              enabled: false,
              configured: true,
              setBy: 'user-owner',
              updatedAt: '2026-08-18T10:00:00.000Z',
              note: 'waiting on NIC re-certification',
            }),
          ],
        })}
        organisationId={ORG_ID}
        isOwner
        canManageEntitlements
        currentUserId="user-a"
      />,
    );
    expect(await screen.findByText(/set by user-owner on/)).toBeTruthy();
  });

  it('explains the remedy for a run whose member has left, rather than showing a bare failure', async () => {
    // ADR-0011 makes `refused_bind` terminal and distinct from `failed` so
    // an operator can tell "this check's member lost their membership"
    // from "this check keeps breaking". The screen has to carry that
    // distinction or the state is just a red chip.
    render(
      <PlatformSettings
        api={platformApi({ runs: [run({ state: 'refused_bind', outcome: null })] })}
        organisationId={ORG_ID}
        isOwner
        canManageEntitlements
        currentUserId="user-a"
      />,
    );
    expect(
      await screen.findByText(/no longer in the organisation. Use Run as me/),
    ).toBeTruthy();
  });

  it('renders the note that says why a module is off', async () => {
    // The contract's own argument for the column: "off" without "waiting
    // on NIC re-certification" is a fact nobody can act on six months
    // later. A panel that stored the note and never showed it would make
    // the column decorative.
    render(
      <PlatformSettings
        api={platformApi({
          entitlements: [
            flag({
              enabled: false,
              configured: true,
              setBy: 'user-owner',
              updatedAt: '2026-08-18T10:00:00.000Z',
              note: 'waiting on NIC re-certification',
            }),
          ],
        })}
        organisationId={ORG_ID}
        isOwner
        canManageEntitlements
        currentUserId="user-a"
      />,
    );
    expect(await screen.findByText(/waiting on NIC re-certification/)).toBeTruthy();
  });

  it('toggles a module without sending — and so without erasing — its note', async () => {
    const api = platformApi({
      entitlements: [
        flag({ enabled: true, configured: true, note: 'switched on for the pilot' }),
      ],
    });
    render(
      <PlatformSettings
        api={api}
        organisationId={ORG_ID}
        isOwner
        canManageEntitlements
        currentUserId="user-a"
      />,
    );
    // Scoped to the module row: the schedule below it carries a button
    // with the same label, and an ambiguous query is a test that fails for
    // a reason unrelated to what it is checking.
    const module = (await screen.findByText('E-way bill')).closest('li');
    expect(module).not.toBeNull();
    fireEvent.click(
      within(module as HTMLElement).getByRole('button', { name: 'Switch off' }),
    );
    await waitFor(() => {
      expect(api.setEntitlement).toHaveBeenCalledWith(ORG_ID, 'eway_bill', {
        enabled: false,
      });
    });
  });

  it('offers the re-adopt control on a paused check, not only a switch', async () => {
    // The refused_bind remedy has to be a CONTROL. Telling an operator to
    // "save the check again" while the only button switches it off would
    // make them disable a statutory check to fix its custody.
    const api = platformApi({
      schedules: [
        schedule({
          enabled: false,
          disabledReason:
            'the member this check ran as is no longer in the organisation',
        }),
      ],
    });
    render(
      <PlatformSettings
        api={api}
        organisationId={ORG_ID}
        isOwner
        canManageEntitlements
        currentUserId="user-a"
      />,
    );
    expect(await screen.findByText(/Paused automatically/)).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: 'Run as me' }));
    await waitFor(() => {
      expect(api.setJobSchedule).toHaveBeenCalledWith(
        ORG_ID,
        'instrument_expiry_review',
        { enabled: true },
      );
    });
  });

  it('lets the cadence be changed from the screen it is displayed on', async () => {
    const api = platformApi({});
    render(
      <PlatformSettings
        api={api}
        organisationId={ORG_ID}
        isOwner
        canManageEntitlements
        currentUserId="user-a"
      />,
    );
    const cadence = await screen.findByLabelText('How often');
    fireEvent.change(cadence, { target: { value: 'monthly' } });
    await waitFor(() => {
      expect(api.setJobSchedule).toHaveBeenCalledWith(
        ORG_ID,
        'instrument_expiry_review',
        { cadence: 'monthly' },
      );
    });
  });

  it('confirms a change rather than leaving the operator guessing', async () => {
    render(
      <PlatformSettings
        api={platformApi({})}
        organisationId={ORG_ID}
        isOwner
        canManageEntitlements
        currentUserId="user-a"
      />,
    );
    const module = (await screen.findByText('E-way bill')).closest('li');
    expect(module).not.toBeNull();
    fireEvent.click(
      within(module as HTMLElement).getByRole('button', { name: 'Switch off' }),
    );
    expect(await screen.findByRole('status')).toBeTruthy();
  });

  it('offers to start the check when none is configured', async () => {
    render(
      <PlatformSettings
        api={platformApi({ schedules: [], runs: [] })}
        organisationId={ORG_ID}
        isOwner
        canManageEntitlements
        currentUserId="user-a"
      />,
    );
    expect(
      await screen.findByRole('button', { name: /Start the guarantee expiry check/ }),
    ).toBeTruthy();
  });
});

describe('the organisation export panel', () => {
  function exportApi(records: unknown[]) {
    return stubApi({
      listOrganisationExports: vi
        .fn()
        .mockResolvedValue({ exports: records, retentionHours: 720 }),
      requestOrganisationExport: vi.fn(),
    });
  }

  it('renders nothing without the export authority', () => {
    const api = exportApi([]);
    const { container } = render(
      <OrganisationExportSettings
        api={api}
        organisationId={ORG_ID}
        canExportOrg={false}
        currentUserId="user-a"
      />,
    );
    expect(container.innerHTML).toBe('');
    expect(api.listOrganisationExports).not.toHaveBeenCalled();
  });

  it('prints the digest in full, because half a digest checks nothing', async () => {
    render(
      <OrganisationExportSettings
        api={exportApi([
          {
            id: EXPORT_ID,
            state: 'ready',
            requestedBy: 'user-owner',
            requestedAt: '2026-08-18T10:00:00.000Z',
            completedAt: '2026-08-18T10:04:00.000Z',
            formatVersion: 'export-v28',
            byteSize: '4194304',
            sha256: DIGEST,
            expiresAt: '2026-09-17T10:04:00.000Z',
            failureReason: null,
            downloadCount: 0,
          },
        ])}
        organisationId={ORG_ID}
        canExportOrg
        currentUserId="user-a"
      />,
    );
    expect(await screen.findByText(DIGEST)).toBeTruthy();
  });

  it('refuses a second request while one is being built', async () => {
    render(
      <OrganisationExportSettings
        api={exportApi([
          {
            id: EXPORT_ID,
            state: 'running',
            requestedBy: 'user-owner',
            requestedAt: '2026-08-18T10:00:00.000Z',
            completedAt: null,
            formatVersion: null,
            byteSize: null,
            sha256: null,
            expiresAt: null,
            failureReason: null,
            downloadCount: 0,
          },
        ])}
        organisationId={ORG_ID}
        canExportOrg
        currentUserId="user-a"
      />,
    );
    await waitFor(() => {
      expect(screen.getByText(/One export is already being built/)).toBeTruthy();
    });
    const button = screen.getByRole('button', { name: 'Request an export' });
    expect(button.hasAttribute('disabled')).toBe(true);
  });

  it('says an expired artefact is gone rather than offering a download', async () => {
    render(
      <OrganisationExportSettings
        api={exportApi([
          {
            id: EXPORT_ID,
            state: 'expired',
            requestedBy: 'user-owner',
            requestedAt: '2026-08-01T10:00:00.000Z',
            completedAt: '2026-08-01T10:04:00.000Z',
            formatVersion: 'export-v28',
            byteSize: '4194304',
            sha256: DIGEST,
            expiresAt: '2026-08-31T10:04:00.000Z',
            failureReason: null,
            downloadCount: 2,
          },
        ])}
        organisationId={ORG_ID}
        canExportOrg
        currentUserId="user-a"
      />,
    );
    expect(
      await screen.findByText(/The file has been deleted. Request a new export/),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Download' })).toBeNull();
  });
});
