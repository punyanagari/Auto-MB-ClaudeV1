// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Members } from '../../src/views/Members.js';
import { openForm, submitButton, stubApi, ORG_ID, membership } from './helpers.js';

describe('Members', () => {
  it('shows the member table and the add form to owners', async () => {
    const api = stubApi({
      listMembers: vi
        .fn()
        .mockResolvedValue([
          membership({ userId: 'user-a', role: 'owner' }),
          membership({ userId: 'user-b', role: 'viewer', canIssueDocuments: false }),
        ]),
    });
    render(<Members api={api} organisationId={ORG_ID} currentUserId="user-a" />);

    expect(await screen.findByRole('table')).toBeTruthy();
    expect(screen.getByText('You')).toBeTruthy();
    await openForm('Add member');
    expect(screen.getByLabelText('Account email')).toBeTruthy();
  });

  it('hides member management from non-owners', async () => {
    const api = stubApi({
      listMembers: vi
        .fn()
        .mockResolvedValue([
          membership({ userId: 'user-a', role: 'owner' }),
          membership({ userId: 'user-b', role: 'viewer' }),
        ]),
    });
    render(<Members api={api} organisationId={ORG_ID} currentUserId="user-b" />);

    await screen.findByRole('table');
    expect(screen.queryByLabelText('Account email')).toBeNull();
  });

  it('adds a member and announces the outcome', async () => {
    const grown = [
      membership({ userId: 'user-a', role: 'owner' }),
      membership({ userId: 'user-c', role: 'viewer' }),
    ];
    const api = stubApi({
      listMembers: vi.fn().mockResolvedValue([membership({ userId: 'user-a' })]),
      addMember: vi.fn().mockResolvedValue(grown),
    });
    render(<Members api={api} organisationId={ORG_ID} currentUserId="user-a" />);

    await openForm('Add member');
    fireEvent.change(screen.getByLabelText('Account email'), {
      target: { value: 'viewer@example.test' },
    });
    fireEvent.click(submitButton('Add member'));

    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toContain('viewer@example.test');
    });
    expect(api.addMember).toHaveBeenCalledWith(ORG_ID, {
      email: 'viewer@example.test',
      role: 'viewer',
    });
    expect(screen.getAllByRole('row')).toHaveLength(3);
  });
});

describe('Members amendment authority', () => {
  it('lets an owner grant the approval authority', async () => {
    const updateMember = vi
      .fn()
      .mockResolvedValue([
        membership({ userId: 'user-a' }),
        membership({ userId: 'user-b', role: 'office', canApproveAmendments: true }),
      ]);
    const api = stubApi({
      listMembers: vi
        .fn()
        .mockResolvedValue([
          membership({ userId: 'user-a' }),
          membership({ userId: 'user-b', role: 'office' }),
        ]),
      updateMember,
    });
    render(<Members api={api} organisationId={ORG_ID} currentUserId="user-a" />);

    const toggle = await screen.findByLabelText(
      'Amendment approval authority of user-b',
    );
    fireEvent.click(toggle);
    await waitFor(() => {
      expect(updateMember).toHaveBeenCalledWith(ORG_ID, 'user-b', {
        canApproveAmendments: true,
      });
    });
  });
});
