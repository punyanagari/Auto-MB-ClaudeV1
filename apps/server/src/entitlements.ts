import type { TransactionSql } from '@auto-mb/db';
import { httpError } from './http.js';

/**
 * Which modules an organisation may use (migration 0096).
 *
 * ## What this is not
 *
 * It is not a permission and it must never grow into one. `AGENTS.md`
 * forbids replacing the per-feature permission matrix with a role system,
 * and the boundary that keeps this on the right side of that rule is: a
 * membership says what a PERSON may do, an entitlement says whether a
 * MODULE exists for the ORGANISATION at all. They compose and neither
 * substitutes for the other — a member holding
 * `can_manage_statutory_reporting` in an organisation whose `eway_bill`
 * entitlement is off is refused, and so is the owner.
 *
 * ## Why it exists
 *
 * Procurement, not product. Two modules on `main` are finished code
 * waiting on somebody else's paperwork: the e-way bill module needs NIC
 * re-certification and outbound signing needs the ESP/TSA procurement of
 * ADR-0012. Before this there were two ways to say "built, but not for
 * this organisation yet" and both were wrong — a deployment flag (it is
 * per-organisation, not per-installation) and not deploying (it is
 * deployed, and other organisations want it).
 *
 * ## The defaults ship ENABLED
 *
 * Which is the opposite of what the procurement story suggests, and
 * deliberate: shipping a mechanism must not change what any organisation
 * can do on the day it lands. A default of `false` would switch off two
 * live modules for every existing tenant as a side effect. Turning one off
 * is an operator act with a note attached; flipping a shipped default is a
 * one-line change on the day the owner decides to.
 */
export const ENTITLEMENT_FLAGS = [
  {
    key: 'eway_bill',
    label: 'E-way bill',
    description:
      'Generating, cancelling and reconciling NIC E-way Bills. Switch this off for an organisation whose NIC re-certification has not landed, so the module cannot speak to the portal in its name.',
    default: true,
  },
  {
    key: 'outbound_signing',
    label: 'Outbound signing',
    description:
      'Sending an issued document for the organisation’s own digital signature. Switch this off until a kiosk certificate is registered, so the signing queue cannot fill with requests nothing can fulfil.',
    default: true,
  },
] as const;

export type EntitlementFlagKey = (typeof ENTITLEMENT_FLAGS)[number]['key'];

const DEFAULTS = new Map<string, boolean>(
  ENTITLEMENT_FLAGS.map((flag) => [flag.key, flag.default]),
);

/**
 * The per-request cache.
 *
 * Keyed on the TRANSACTION, not the request, and that is the honest key
 * here: a guard's answer is only good for as long as the snapshot it was
 * read under, and `tenant-route.ts` hands every handler a transaction
 * closure rather than one open transaction. Two bound transactions in one
 * request are two chances for an owner to have switched a module off in
 * between, and caching across them would serve the first answer to the
 * second transaction.
 *
 * A WeakMap so an entry dies with the transaction object; nothing has to
 * remember to clear it, and a long-lived process cannot accumulate
 * entitlement rows for transactions that closed hours ago.
 */
const cache = new WeakMap<TransactionSql, Promise<ReadonlyMap<string, boolean>>>();

async function readEntitlements(
  tx: TransactionSql,
): Promise<ReadonlyMap<string, boolean>> {
  const rows = await tx<{ flag_key: string; enabled: boolean }[]>`
    select flag_key, enabled from organisation_entitlements
  `;
  const effective = new Map(DEFAULTS);
  for (const row of rows) effective.set(row.flag_key, row.enabled);
  return effective;
}

/**
 * Whether a module is available to the bound organisation.
 *
 * RLS scopes the read; nothing here names an organisation. The promise
 * rather than the resolved map goes into the cache, so two guards racing
 * inside one transaction share one query instead of issuing two.
 */
export async function entitlementEnabled(
  tx: TransactionSql,
  flag: EntitlementFlagKey,
): Promise<boolean> {
  let pending = cache.get(tx);
  if (pending === undefined) {
    pending = readEntitlements(tx);
    cache.set(tx, pending);
  }
  return (await pending).get(flag) ?? DEFAULTS.get(flag) ?? true;
}

/** Every flag's effective value for the bound organisation, for the
 * management screen. Shares the same per-transaction cache. */
export async function effectiveEntitlements(
  tx: TransactionSql,
): Promise<ReadonlyMap<string, boolean>> {
  let pending = cache.get(tx);
  if (pending === undefined) {
    pending = readEntitlements(tx);
    cache.set(tx, pending);
  }
  return pending;
}

/**
 * Refuses when the module is switched off for this organisation.
 *
 * 403 and not 404: the module exists, the organisation is simply not
 * entitled to it, and pretending the route is absent would send an
 * operator hunting a deployment problem that is really a setting on their
 * own Platform screen. The refusal names the remedy for the same reason.
 */
export async function requireEntitlement(
  tx: TransactionSql,
  flag: EntitlementFlagKey,
): Promise<void> {
  if (await entitlementEnabled(tx, flag)) return;
  const declared = ENTITLEMENT_FLAGS.find((candidate) => candidate.key === flag);
  throw httpError(
    403,
    'ENTITLEMENT_DISABLED',
    `The ${declared?.label ?? flag} module is switched off for this organisation. An owner can switch it back on under Settings → Platform.`,
  );
}
