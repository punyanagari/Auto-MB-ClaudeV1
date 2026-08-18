import type { OrganisationProfile } from '@auto-mb/contracts';

/**
 * The seller facts the submit route refuses without — mirrors
 * ORG_STATE/GSTIN/ADDRESS/PINCODE/LOCALITY_REQUIRED.
 *
 * Asked in two places against the same list: once per Work by
 * `WorkBillingReadiness`, and once on the dashboard a new organisation
 * lands on, so the facts are met before any Work depends on them.
 */
export function missingOrganisationFacts(
  profile: OrganisationProfile,
): readonly string[] {
  return [
    ...((profile.stateCode ?? null) === null ? ['GST state code'] : []),
    ...(profile.gstin === null ? ['GSTIN'] : []),
    ...(profile.address === null ? ['address'] : []),
    ...((profile.pincode ?? null) === null ? ['PIN code'] : []),
    ...((profile.locality ?? null) === null ? ['locality'] : []),
  ];
}
