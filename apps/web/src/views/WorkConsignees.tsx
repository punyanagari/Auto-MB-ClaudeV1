import { useCallback, useEffect, useState } from 'react';
import type { Contact } from '@auto-mb/contracts';
import { formValue, type ApiClient } from '../api.js';
import { errorMessage } from '../lib/load-failure.js';
import { useReload } from '../lib/view-state.js';
import { Button } from '../ui/button.js';
import { StatusChip } from '../ui/chip.js';
import { DataTable, wrapCell } from '../ui/table.js';
import { Field, Actions, FormError, FormNotice } from '../ui/form.js';
import { EmptyState, ErrorState, LoadingState } from '../ui/state.js';
import { Disclosure } from '../ui/disclosure.js';

interface WorkConsigneesProps {
  readonly api: ApiClient;
  readonly organisationId: string;
  readonly workId: string;
  readonly canModify: boolean;
}

/**
 * The Work's consignee list (legacy rule R16: "a work may have many
 * consignees; the challan picks one"). Linked consignees are offered
 * first in the challan and PAC pickers; any active consignee contact
 * remains selectable — linking is organisational convenience, never a
 * restriction. Unlinking removes only the preference: every issued
 * document keeps its own snapshot.
 *
 * A RETIRED contact keeps its row here — the link is a preference, not
 * history, and reactivating the contact restores it — but it is marked
 * as retired and the challan and PAC pickers stop offering it. Retiring
 * is a refusal to offer, not a refusal to show.
 */
export function WorkConsignees({
  api,
  organisationId,
  workId,
  canModify,
}: WorkConsigneesProps) {
  const [linked, setLinked] = useState<readonly Contact[] | null>(null);
  const [contacts, setContacts] = useState<readonly Contact[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [loadVersion, retry] = useReload();
  /** True while the screen has nothing on it because the load failed —
   * distinct from an action that failed with the list still on screen. */
  const [loadFailed, setLoadFailed] = useState(false);

  const reload = useCallback(async () => {
    const [loadedLinked, loadedContacts] = await Promise.all([
      api.listWorkConsignees(organisationId, workId),
      canModify
        ? api.listContacts(organisationId, { role: 'consignee' }).catch(() => [])
        : Promise.resolve([]),
    ]);
    setLinked(loadedLinked);
    setContacts(loadedContacts);
  }, [api, organisationId, workId, canModify]);

  useEffect(() => {
    let cancelled = false;
    setLinked(null);
    setError(null);
    setLoadFailed(false);
    reload().catch((cause: unknown) => {
      if (cancelled) return;
      setLoadFailed(true);
      setError(errorMessage(cause, 'The Work consignees could not be loaded.'));
    });
    return () => {
      cancelled = true;
    };
  }, [reload, loadVersion]);

  const act = useCallback(
    async (work: () => Promise<void>, done: string) => {
      setPending(true);
      setError(null);
      // An action's failure is not the load's: it leaves the list on
      // screen and is answered by fixing the input, not by retrying.
      setLoadFailed(false);
      setNotice(null);
      try {
        await work();
        await reload();
        setNotice(done);
      } catch (cause) {
        setError(errorMessage(cause, 'The change could not be saved.'));
      } finally {
        setPending(false);
      }
    },
    [reload],
  );

  const linkable = contacts.filter(
    (contact) => !(linked ?? []).some((entry) => entry.id === contact.id),
  );

  return (
    <>
      <h2>Consignees for this Work</h2>
      {notice !== null && <FormNotice>{notice}</FormNotice>}
      {error !== null &&
        (loadFailed ? (
          <ErrorState onRetry={retry} retryLabel="Retry consignees">
            {error}
          </ErrorState>
        ) : (
          <FormError>{error}</FormError>
        ))}
      {linked === null && !loadFailed ? (
        <LoadingState label="the Work consignees" rows={3} columns={3} />
      ) : linked !== null && linked.length === 0 ? (
        <EmptyState>
          No consignees linked yet — linked consignees appear first in the challan and
          PAC pickers.
        </EmptyState>
      ) : linked !== null ? (
        <DataTable>
          <caption className="sr-only">Consignees linked to this Work</caption>
          <thead>
            <tr>
              <th scope="col">Designation</th>
              <th scope="col">Address</th>
              <th scope="col">Offered</th>
              {canModify && <th scope="col">Actions</th>}
            </tr>
          </thead>
          <tbody>
            {linked.map((contact) => (
              <tr key={contact.id}>
                <th scope="row">{contact.designation}</th>
                <td className={wrapCell}>{contact.address ?? '—'}</td>
                <td>
                  {contact.active ? (
                    <span className="text-muted-foreground">in the pickers</span>
                  ) : (
                    <StatusChip status="cancelled">retired — not offered</StatusChip>
                  )}
                </td>
                {canModify && (
                  <td>
                    <Button
                      variant="outline"
                      disabled={pending}
                      onClick={() =>
                        void act(async () => {
                          await api.unlinkWorkConsignee(
                            organisationId,
                            workId,
                            contact.id,
                          );
                        }, `${contact.designation} unlinked — documents keep their snapshots.`)
                      }
                    >
                      Unlink
                    </Button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </DataTable>
      ) : null}
      {(linked ?? []).some((contact) => !contact.active) && (
        <p className="text-muted-foreground">
          A retired consignee keeps its link to this Work but is no longer offered in
          the challan and PAC pickers. Reactivate the contact under Masters to offer it
          again, or unlink it here — issued documents keep their own snapshots either
          way.
        </p>
      )}
      {canModify && linkable.length > 0 && (
        <Disclosure label="New consignee link" startOpen={(linked ?? []).length === 0}>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const form = event.currentTarget;
              const contactId = formValue(new FormData(form), 'work-consignee-pick');
              if (contactId.length === 0) return;
              void act(async () => {
                await api.linkWorkConsignee(organisationId, workId, contactId);
                form.reset();
              }, 'Consignee linked to this Work.');
            }}
          >
            <Field>
              <label htmlFor="work-consignee-pick">Link a consignee contact</label>
              <select id="work-consignee-pick" name="work-consignee-pick" required>
                {linkable.map((contact) => (
                  <option key={contact.id} value={contact.id}>
                    {contact.designation}
                    {contact.address !== null ? ` — ${contact.address}` : ''}
                  </option>
                ))}
              </select>
            </Field>
            <Actions>
              <Button type="submit" disabled={pending}>
                Link consignee
              </Button>
            </Actions>
          </form>
        </Disclosure>
      )}
    </>
  );
}
