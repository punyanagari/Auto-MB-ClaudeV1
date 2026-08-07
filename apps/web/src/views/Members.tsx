import { useEffect, useState, type FormEvent } from 'react';
import type { Membership, MembershipRole } from '@auto-mb/contracts';
import { RequestFailedError, formValue, type ApiClient } from '../api.js';

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

export function Members({ api, organisationId, currentUserId }: MembersProps) {
  const [members, setMembers] = useState<readonly Membership[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setMembers(null);
    setLoadError(null);
    api
      .listMembers(organisationId)
      .then((loaded) => {
        if (!cancelled) setMembers(loaded);
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
      <section className="card" aria-labelledby="members-title">
        <h1 id="members-title" tabIndex={-1}>
          Members
        </h1>
        <p className="form-error" role="alert">
          {loadError}
        </p>
      </section>
    );
  }

  return (
    <section className="card" aria-labelledby="members-title">
      <h1 id="members-title" tabIndex={-1}>
        Members
      </h1>

      {members === null ? (
        <p className="muted" role="status">
          Loading members…
        </p>
      ) : (
        <table className="data-table">
          <caption className="visually-hidden">
            Organisation members with role, work scope, and document authority
          </caption>
          <thead>
            <tr>
              <th scope="col">User</th>
              <th scope="col">Role</th>
              <th scope="col">Work scope</th>
              <th scope="col">Can issue</th>
              <th scope="col">Can cancel</th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            {members.map((member) => (
              <tr key={member.userId}>
                <th scope="row">
                  {member.userId === currentUserId ? 'You' : member.userId}
                </th>
                <td>{ROLE_LABELS[member.role]}</td>
                <td>{member.workScope === 'all' ? 'All Works' : 'Assigned'}</td>
                <td>{member.canIssueDocuments ? 'Yes' : 'No'}</td>
                <td>{member.canCancelDocuments ? 'Yes' : 'No'}</td>
                <td>{member.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {notice !== null && (
        <p className="form-notice" role="status">
          {notice}
        </p>
      )}

      {isOwner && (
        <>
          <h2>Add a member</h2>
          <p className="muted">
            The person must already have an Auto-MB account; add them by their account
            email.
          </p>
          <form onSubmit={(event) => void addMember(event)}>
            <div className="field-row">
              <div className="field">
                <label htmlFor="member-email">Account email</label>
                <input
                  id="member-email"
                  name="email"
                  type="email"
                  required
                  autoComplete="off"
                />
              </div>
              <div className="field">
                <label htmlFor="member-role">Role</label>
                <select id="member-role" name="role" defaultValue="viewer">
                  <option value="owner">Owner</option>
                  <option value="office">Office</option>
                  <option value="site">Site</option>
                  <option value="viewer">Viewer</option>
                </select>
              </div>
            </div>

            {formError !== null && (
              <p className="form-error" role="alert">
                {formError}
              </p>
            )}

            <div className="actions">
              <button type="submit" disabled={pending}>
                {pending ? 'Adding…' : 'Add member'}
              </button>
            </div>
          </form>
        </>
      )}
    </section>
  );
}
