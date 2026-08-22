import type { Contact, ContactAddress } from '@auto-mb/contracts';

/**
 * The addresses a contact currently offers (migration 0116): live rows
 * only, in the order the masters route returns them — primary first, then
 * the operator's own ordering. Filtered rather than re-sorted, so every
 * picker and the register agree about which address is offered first.
 *
 * Shared by the challan editor, the standalone-challan form and the
 * inspection clause tab, which had each grown their own copy.
 */
export function liveAddresses(contact: Contact | undefined): readonly ContactAddress[] {
  return (contact?.addresses ?? []).filter((address) => address.active);
}

/** What an address is called in a one-line picker: its own label where
 * the operator gave one, the address text otherwise, and the primary one
 * saying so — every picker marks it the same way. */
export function addressOptionLabel(address: ContactAddress): string {
  return `${address.label ?? address.address}${address.isPrimary ? ' (primary)' : ''}`;
}
