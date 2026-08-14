import type { Contact, GstRateMaster } from '@auto-mb/contracts';
import { formatDate } from '../../format.js';

/**
 * The buyer picker's options, shared by the create fields
 * (`InvoiceFactFields`) and the draft editor (`InvoiceDetail`) so the two
 * cannot disagree on who may be named — the divergence that let one form
 * offer a retired contact the server then refused with CONTACT_RETIRED.
 *
 * Only ACTIVE clients are offered, with ONE exception: the draft's own
 * current buyer. A buyer retired AFTER the draft was written stays in the
 * list, because a required select whose value is not among its options
 * renders blank and would block edits that have nothing to do with the
 * buyer. That retired buyer is found in `allContacts`, the unfiltered
 * contact list both mounts already pass as the ship-to source.
 */
export function BuyerOptions({
  clients,
  allContacts,
  currentBuyerId = null,
}: {
  readonly clients: readonly Contact[];
  readonly allContacts: readonly Contact[];
  readonly currentBuyerId?: string | null;
}) {
  const current =
    currentBuyerId === null || clients.some((client) => client.id === currentBuyerId)
      ? undefined
      : allContacts.find((contact) => contact.id === currentBuyerId);
  const options = current === undefined ? clients : [...clients, current];
  return (
    <>
      {options.map((client) => (
        <option key={client.id} value={client.id}>
          {client.designation}
        </option>
      ))}
    </>
  );
}

/** One option per master row, so a historic invoice date can still pick a
 * rate that has since been end-dated — the SERVER decides validity
 * against the invoice date; this list is a picker convenience. */
export function GstRateOptions({
  rates,
}: {
  readonly rates: readonly GstRateMaster[];
}) {
  return (
    <>
      {rates.map((row) => (
        <option key={row.id} value={row.rate}>
          {row.rate}% · {row.label}
          {row.effectiveTo === null ? '' : ` (until ${formatDate(row.effectiveTo)})`}
        </option>
      ))}
    </>
  );
}

/** The shared action-runner signature every panel receives from the Work
 * page: run the mutation, report the outcome, refresh what it names. */
export type ActRunner = (run: () => Promise<void>, message: string) => Promise<void>;
