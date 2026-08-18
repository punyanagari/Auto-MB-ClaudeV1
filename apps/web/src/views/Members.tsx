import { useEffect, useState, type FormEvent } from 'react';
import type { Membership, MembershipRole, Work } from '@auto-mb/contracts';
import { RequestFailedError, formValue, type ApiClient } from '../api.js';
import { Button } from '../ui/button.js';
import { StatusChip } from '../ui/chip.js';
import { DataTable, wrapCell } from '../ui/table.js';
import { Disclosure } from '../ui/disclosure.js';
import { Field, FieldRow, Actions, FormError, FormNotice } from '../ui/form.js';
import { PageHeader } from '../ui/page-header.js';
import { ErrorState, LoadingState } from '../ui/state.js';

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
    return <LoadingState label="the Work assignments" rows={2} />;
  }
  if (works.length === 0) {
    return <p className="text-sm text-muted-foreground">No Works exist yet.</p>;
  }
  return (
    <ul className="my-2 flex list-none flex-col gap-1.5 p-0">
      {works.map((work) => (
        <li key={work.id}>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-0.5 size-4 shrink-0 accent-primary"
              disabled={busy}
              checked={assigned.includes(work.id)}
              onChange={(event) => {
                void toggle(work.id, event.currentTarget.checked);
              }}
            />
            {/* The mock renders an assigned Work as a mono code chip
             * (`app/members/page` at fdfe5ef); here the chip is the
             * control's own label, with the title behind it so the
             * operator picks by name rather than by code alone. */}
            <span className="min-w-0">
              <span className="font-mono text-xs">{work.workCode}</span>{' '}
              <span className="text-muted-foreground">{work.title}</span>
            </span>
          </label>
        </li>
      ))}
    </ul>
  );
}

/** A member, as the mock draws identity: a 36px monogram beside the name
 * over a quieter second line (`app/members/page` at fdfe5ef). The
 * mock has a display name and an email; the membership record carries
 * neither, only the account id, so the id takes the name line in mono
 * and the monogram is cut from it. */
function MemberIdentity({
  label,
  userId,
}: {
  readonly label: string;
  readonly userId: string;
}) {
  const initials = (
    userId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 2) || '??'
  ).toUpperCase();
  return (
    <span className="flex min-w-0 items-center gap-3">
      <span
        aria-hidden="true"
        className="flex size-9 shrink-0 items-center justify-center rounded-full bg-accent text-xs font-semibold text-accent-foreground"
      >
        {initials}
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="truncate font-medium">{label}</span>
        <span className="truncate font-mono text-xs font-normal text-muted-foreground">
          {userId}
        </span>
      </span>
    </span>
  );
}

/** The four feature grants the matrix carries, in the order the columns
 * read. Each is a boolean on the membership record; the server is the
 * authority and this is the one place an owner changes them.
 *
 * `docs/UX.md` § Approved divergences 3: the mock's Owner/Editor/Viewer
 * collapse is rejected, and the matrix renders the real feature set
 * rather than the mock's six representative columns. */
const FEATURES = [
  {
    key: 'canIssueDocuments',
    heading: 'Can issue',
    authority: 'Issue authority',
    change: 'Issue authority',
  },
  {
    key: 'canCancelDocuments',
    heading: 'Can cancel',
    authority: 'Cancel authority',
    change: 'Cancel authority',
  },
  {
    key: 'canApproveAmendments',
    heading: 'Can approve',
    authority: 'Amendment approval authority',
    change: 'Amendment approval authority',
  },
  {
    /* The compliance authority (migration 0061): who may register,
       reconcile or cancel documents at the IRP and the NIC E-way Bill
       portal, and who may record what those portals answered. It is
       granted on top of issue/cancel, never inherited from them. */
    key: 'canManageStatutoryReporting',
    heading: 'Can report statutory',
    authority: 'Statutory reporting authority',
    change: 'Statutory reporting authority',
  },
  {
    /* The payments authority (migration 0080): who may approve an
       employee's advance or reimbursement, and who may record and pay a
       vendor invoice. Granted on top of issue/cancel, never inherited —
       sending money out is not the same act as issuing a document. */
    key: 'canManagePayments',
    heading: 'Can pay',
    authority: 'Payments authority',
    change: 'Payments authority',
  },
  {
    /* The signing authority (migration 0091, owner ruling 2026-08-18):
       who may send an issued document for the organisation's own digital
       signature. Granted on top of issue, never inherited from it — the
       person at the kiosk types their PIN because the queue said to, so
       who may fill that queue is its own decision. */
    key: 'canSignDocuments',
    heading: 'Can sign',
    authority: 'Signing authority',
    change: 'Signing authority',
  },
  {
    /* The payroll authority (migration 0089): who may see the employee
       register and run payroll. Separate from the payments authority
       because the register carries every colleague's salary, PAN, UAN
       and bank account — a vendor-payment manager has no business
       reading any of that by default. The salary disbursement still
       flows through the payments workspace; only the visibility and the
       run are gated here. */
    key: 'canManagePayroll',
    heading: 'Can run payroll',
    authority: 'Payroll authority',
    change: 'Payroll authority',
  },
] as const satisfies readonly {
  key: keyof Membership & `can${string}`;
  heading: string;
  authority: string;
  change: string;
}[];

export function Members({ api, organisationId, currentUserId }: MembersProps) {
  const [members, setMembers] = useState<readonly Membership[] | null>(null);
  const [works, setWorks] = useState<readonly Work[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  /** Bumped by the failure state's retry, to re-run the load below. */
  const [loadVersion, setLoadVersion] = useState(0);

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
  }, [api, organisationId, loadVersion]);

  function retry(): void {
    setLoadVersion((current) => current + 1);
  }

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

  const header = (
    <PageHeader
      eyebrow="Administration"
      title="Members"
      description="Grant document and statutory authority per feature, and restrict members to their assigned Works."
    />
  );

  if (loadError !== null) {
    return (
      <>
        {header}
        <ErrorState onRetry={retry} retryLabel="Retry members">
          {loadError}
        </ErrorState>
      </>
    );
  }

  return (
    <>
      {header}
      {/* The mock's standing info note (`app/members/page` at
       * fdfe5ef), carrying the rule the matrix runs on. */}
      <div className="mb-4 rounded-lg border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
        A member whose work access is{' '}
        <strong className="font-medium text-foreground">Assigned</strong> sees only the
        Works listed under their name. Every column below is a separate grant: authority
        is given per feature, never inherited from a role.
      </div>

      {members === null ? (
        <LoadingState label="the members" rows={4} columns={4} />
      ) : (
        <DataTable>
          <caption className="sr-only">
            Organisation members with role, work scope, and document and statutory
            authority
          </caption>
          <thead>
            <tr>
              <th scope="col">Member</th>
              <th scope="col">Role</th>
              <th scope="col">Work access</th>
              {/* The mock centres the feature columns over their boxes and
               * lets the heading be the only label the box has. */}
              {FEATURES.map((feature) => (
                <th key={feature.key} scope="col" className="text-center!">
                  {feature.heading}
                </th>
              ))}
              <th scope="col">Two-factor</th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            {members.map((member) => {
              const label = member.userId === currentUserId ? 'You' : member.userId;
              const twoFactor = (
                /* Enrolment before authority: an unenrolled member who is
                   granted issue/cancel/approve walls themselves out of the
                   workspace until they enrol (finding 36). */
                <StatusChip status={member.twoFactorEnabled ? 'active' : 'review'}>
                  {member.twoFactorEnabled ? 'Enrolled' : 'Not enrolled'}
                </StatusChip>
              );
              if (!isOwner) {
                return (
                  <tr key={member.userId}>
                    <th scope="row" className={wrapCell}>
                      <MemberIdentity label={label} userId={member.userId} />
                    </th>
                    <td>{ROLE_LABELS[member.role]}</td>
                    <td>{member.workScope === 'all' ? 'All Works' : 'Assigned'}</td>
                    {FEATURES.map((feature) => (
                      <td key={feature.key} className="text-center!">
                        {member[feature.key] ? 'Yes' : 'No'}
                      </td>
                    ))}
                    <td>{twoFactor}</td>
                    <td>
                      <StatusChip
                        status={member.status === 'active' ? 'active' : 'failed'}
                      >
                        {member.status}
                      </StatusChip>
                    </td>
                  </tr>
                );
              }
              return (
                <tr key={member.userId}>
                  <th scope="row" className={wrapCell}>
                    <MemberIdentity label={label} userId={member.userId} />
                    <details className="mt-1.5 text-sm font-normal">
                      <summary className="cursor-pointer text-muted-foreground">
                        Assignments
                      </summary>
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
                  {FEATURES.map((feature) => (
                    <td key={feature.key} className="text-center!">
                      <input
                        type="checkbox"
                        className="size-4 accent-primary"
                        aria-label={`${feature.authority} of ${label}`}
                        checked={member[feature.key]}
                        disabled={pending}
                        onChange={(event) => {
                          void change(
                            member.userId,
                            { [feature.key]: event.currentTarget.checked },
                            `${feature.change} updated for ${label}.`,
                          );
                        }}
                      />
                    </td>
                  ))}
                  <td>{twoFactor}</td>
                  <td>
                    <span className="flex items-center gap-2">
                      <StatusChip
                        status={member.status === 'active' ? 'active' : 'failed'}
                      >
                        {member.status}
                      </StatusChip>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={pending}
                        onClick={() => {
                          void change(
                            member.userId,
                            {
                              status:
                                member.status === 'active' ? 'disabled' : 'active',
                            },
                            member.status === 'active'
                              ? `${label} disabled — access ends immediately.`
                              : `${label} re-enabled.`,
                          );
                        }}
                      >
                        {member.status === 'active' ? 'Disable' : 'Enable'}
                      </Button>
                    </span>
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
        <Disclosure label="New member">
          <p className="max-w-2xl text-sm text-pretty text-muted-foreground">
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
        </Disclosure>
      )}
    </>
  );
}
