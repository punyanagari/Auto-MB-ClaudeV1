import { useEffect, useState, type FormEvent } from 'react';
import type { Membership, MembershipRole, Work } from '@auto-mb/contracts';
import { RequestFailedError, formValue, type ApiClient } from '../api.js';
import { Button } from '../ui/button.js';
import { StatusChip } from '../ui/chip.js';
import { Card } from '../ui/card.js';
import { DataTable, wrapCell } from '../ui/table.js';
import { Field, FieldRow, Actions, FormError, FormNotice } from '../ui/form.js';

interface MembersProps {
  readonly api: ApiClient;
  readonly organisationId: string;
  readonly currentUserId: string;
}

const ROLE_LABELS: Record<MembershipRole, string> = {
  owner: 'Owner',
  office: 'Office',
  site: 'Site',
  viewer: 'Viewer',
};

/** Per-member Work assignment editor: loads the member's assignment set
 * on expand and saves it as a replace-set on every toggle. */
function AssignmentsEditor({
  api,
  organisationId,
  userId,
  works,
  onError,
}: {
  readonly api: ApiClient;
  readonly organisationId: string;
  readonly userId: string;
  readonly works: readonly Work[];
  readonly onError: (message: string) => void;
}) {
  const [assigned, setAssigned] = useState<readonly string[] | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .memberAssignments(organisationId, userId)
      .then((payload) => {
        if (!cancelled) setAssigned(payload.workIds);
      })
      .catch(() => {
        if (!cancelled) onError('The assignments could not be loaded.');
      });
    return () => {
      cancelled = true;
    };
  }, [api, organisationId, userId, onError]);

  async function toggle(workId: string, include: boolean) {
    if (assigned === null) return;
    const next = include
      ? [...assigned, workId]
      : assigned.filter((candidate) => candidate !== workId);
    setBusy(true);
    try {
      const payload = await api.setMemberAssignments(organisationId, userId, next);
      setAssigned(payload.workIds);
    } catch (cause) {
      onError(
        cause instanceof RequestFailedError
          ? cause.message
          : 'Saving the assignments failed.',
      );
    } finally {
      setBusy(false);
    }
  }

  if (assigned === null) {
    return (
      <p className="text-muted-foreground" role="status">
        Loading assignments…
      </p>
    );
  }
  if (works.length === 0) {
    return <p className="text-muted-foreground">No Works exist yet.</p>;
  }
  return (
    <ul className="my-2 flex list-none flex-col gap-1 p-0 [&_label]:flex [&_label]:items-center [&_label]:gap-2 [&_label]:text-sm">
      {works.map((work) => (
        <li key={work.id}>
          <label>
            <input
              type="checkbox"
              disabled={busy}
              checked={assigned.includes(work.id)}
              onChange={(event) => {
                void toggle(work.id, event.currentTarget.checked);
              }}
            />{' '}
            {work.workCode} <span className="text-muted-foreground">{work.title}</span>
          </label>
        </li>
      ))}
    </ul>
  );
}

export function Members({ api, organisationId, currentUserId }: MembersProps) {
  const [members, setMembers] = useState<readonly Membership[] | null>(null);
  const [works, setWorks] = useState<readonly Work[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setMembers(null);
    setLoadError(null);
    Promise.all([api.listMembers(organisationId), api.listWorks(organisationId)])
      .then(([loadedMembers, loadedWorks]) => {
        if (cancelled) return;
        setMembers(loadedMembers);
        setWorks(loadedWorks);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setLoadError(
          cause instanceof RequestFailedError
            ? cause.message
            : 'The member list could not be loaded.',
        );
      });
    return () => {
      cancelled = true;
    };
  }, [api, organisationId]);

  const isOwner =
    members?.some(
      (member) => member.userId === currentUserId && member.role === 'owner',
    ) ?? false;

  async function change(
    userId: string,
    body: Parameters<ApiClient['updateMember']>[2],
    description: string,
  ) {
    setPending(true);
    setFormError(null);
    setNotice(null);
    try {
      const updated = await api.updateMember(organisationId, userId, body);
      setMembers(updated);
      setNotice(description);
    } catch (cause) {
      setFormError(
        cause instanceof RequestFailedError
          ? cause.message
          : 'The change could not be saved.',
      );
    } finally {
      setPending(false);
    }
  }

  async function addMember(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const email = formValue(data, 'email');
    const role = (formValue(data, 'role') || 'viewer') as MembershipRole;

    setPending(true);
    setFormError(null);
    setNotice(null);
    try {
      const updated = await api.addMember(organisationId, { email, role });
      setMembers(updated);
      setNotice(`Added ${email} as ${ROLE_LABELS[role]}.`);
      form.reset();
    } catch (cause) {
      setFormError(
        cause instanceof RequestFailedError
          ? cause.message
          : 'The server could not be reached. Try again.',
      );
    } finally {
      setPending(false);
    }
  }

  if (loadError !== null) {
    return (
      <Card aria-labelledby="members-title">
        <h1 id="members-title" tabIndex={-1}>
          Members
        </h1>
        <FormError>{loadError}</FormError>
      </Card>
    );
  }

  return (
    <Card aria-labelledby="members-title">
      <h1 id="members-title" tabIndex={-1}>
        Members
      </h1>

      {members === null ? (
        <p className="text-muted-foreground" role="status">
          Loading members…
        </p>
      ) : (
        <DataTable>
          <caption className="sr-only">
            Organisation members with role, work scope, and document authority
          </caption>
          <thead>
            <tr>
              <th scope="col">User</th>
              <th scope="col">Role</th>
              <th scope="col">Work scope</th>
              <th scope="col">Can issue</th>
              <th scope="col">Can cancel</th>
              <th scope="col">Can approve</th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            {members.map((member) => {
              const label = member.userId === currentUserId ? 'You' : member.userId;
              if (!isOwner) {
                return (
                  <tr key={member.userId}>
                    <th scope="row">{label}</th>
                    <td>{ROLE_LABELS[member.role]}</td>
                    <td>{member.workScope === 'all' ? 'All Works' : 'Assigned'}</td>
                    <td>{member.canIssueDocuments ? 'Yes' : 'No'}</td>
                    <td>{member.canCancelDocuments ? 'Yes' : 'No'}</td>
                    <td>{member.canApproveAmendments ? 'Yes' : 'No'}</td>
                    <td>{member.status}</td>
                  </tr>
                );
              }
              return (
                <tr key={member.userId}>
                  <th scope="row" className={wrapCell}>
                    {label}
                    <details className="flex flex-wrap items-center gap-2">
                      <summary>Assignments</summary>
                      <AssignmentsEditor
                        api={api}
                        organisationId={organisationId}
                        userId={member.userId}
                        works={works}
                        onError={setFormError}
                      />
                    </details>
                  </th>
                  <td>
                    <select
                      aria-label={`Role of ${label}`}
                      value={member.role}
                      disabled={pending}
                      onChange={(event) => {
                        void change(
                          member.userId,
                          { role: event.currentTarget.value as MembershipRole },
                          `Role updated for ${label}.`,
                        );
                      }}
                    >
                      <option value="owner">Owner</option>
                      <option value="office">Office</option>
                      <option value="site">Site</option>
                      <option value="viewer">Viewer</option>
                    </select>
                  </td>
                  <td>
                    <select
                      aria-label={`Work scope of ${label}`}
                      value={member.workScope}
                      disabled={pending}
                      onChange={(event) => {
                        void change(
                          member.userId,
                          {
                            workScope: event.currentTarget.value as 'all' | 'assigned',
                          },
                          `Work scope updated for ${label}.`,
                        );
                      }}
                    >
                      <option value="all">All Works</option>
                      <option value="assigned">Assigned</option>
                    </select>
                  </td>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`Issue authority of ${label}`}
                      checked={member.canIssueDocuments}
                      disabled={pending}
                      onChange={(event) => {
                        void change(
                          member.userId,
                          { canIssueDocuments: event.currentTarget.checked },
                          `Issue authority updated for ${label}.`,
                        );
                      }}
                    />
                  </td>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`Cancel authority of ${label}`}
                      checked={member.canCancelDocuments}
                      disabled={pending}
                      onChange={(event) => {
                        void change(
                          member.userId,
                          { canCancelDocuments: event.currentTarget.checked },
                          `Cancel authority updated for ${label}.`,
                        );
                      }}
                    />
                  </td>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`Amendment approval authority of ${label}`}
                      checked={member.canApproveAmendments}
                      disabled={pending}
                      onChange={(event) => {
                        void change(
                          member.userId,
                          { canApproveAmendments: event.currentTarget.checked },
                          `Amendment approval authority updated for ${label}.`,
                        );
                      }}
                    />
                  </td>
                  <td>
                    <StatusChip
                      status={member.status === 'active' ? 'active' : 'failed'}
                    >
                      {member.status}
                    </StatusChip>{' '}
                    <Button
                      variant="outline"
                      disabled={pending}
                      onClick={() => {
                        void change(
                          member.userId,
                          {
                            status: member.status === 'active' ? 'disabled' : 'active',
                          },
                          member.status === 'active'
                            ? `${label} disabled — access ends immediately.`
                            : `${label} re-enabled.`,
                        );
                      }}
                    >
                      {member.status === 'active' ? 'Disable' : 'Enable'}
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </DataTable>
      )}

      {notice !== null && <FormNotice>{notice}</FormNotice>}
      {formError !== null && <FormError>{formError}</FormError>}

      {isOwner && (
        <>
          <h2>Add a member</h2>
          <p className="text-muted-foreground">
            The person must already have an Auto-MB account; add them by their account
            email. Site members record delivery evidence; set their scope to Assigned
            and pick their Works under Assignments.
          </p>
          <form onSubmit={(event) => void addMember(event)}>
            <FieldRow>
              <Field>
                <label htmlFor="member-email">Account email</label>
                <input
                  id="member-email"
                  name="email"
                  type="email"
                  required
                  autoComplete="off"
                />
              </Field>
              <Field>
                <label htmlFor="member-role">Role</label>
                <select id="member-role" name="role" defaultValue="viewer">
                  <option value="owner">Owner</option>
                  <option value="office">Office</option>
                  <option value="site">Site</option>
                  <option value="viewer">Viewer</option>
                </select>
              </Field>
            </FieldRow>

            <Actions>
              <Button type="submit" disabled={pending}>
                {pending ? 'Adding…' : 'Add member'}
              </Button>
            </Actions>
          </form>
        </>
      )}
    </Card>
  );
}
