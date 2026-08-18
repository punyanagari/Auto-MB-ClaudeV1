import type { TransactionSql } from '@auto-mb/db';

/**
 * The payroll statutory schedules every organisation is seeded with
 * (migrations 0089 § 7).
 *
 * The GST rate master set this pattern and this file is its twin:
 * migration 0089 seeded the organisations that existed when it ran, and
 * organisation creation seeds the ones created afterwards, from the same
 * three lists so the two can never hand out different schedules. See
 * `gst-rates.ts` for the original.
 *
 * WHY THE LISTS ARE HERE AND NOT ONLY IN THE MIGRATION. A migration runs
 * once. An organisation created tomorrow has to arrive with the same
 * schedules, and it cannot get them by re-running a migration.
 *
 * THE DUPLICATION IS REAL AND IS NOT GUARDED BY A TEST, which is worth
 * saying plainly rather than leaving for somebody to discover. It is the
 * same duplication `gst-rates.ts` has carried against migration 0048
 * since that pack landed, and the same bar: the migration's own seed is
 * asserted by `packages/db/test/migration-contract.test.ts`, this one by
 * the payroll suite in `apps/server/test`, and nothing compares the two
 * lists to each other. A parity census is the obvious next step and it
 * belongs to both pairs at once, not to this file alone.
 *
 * ─────────────────────────────────────────────────────────────────────
 * EVERY VALUE BELOW IS UNVERIFIED AND AWAITS A PRACTITIONER'S SIGN-OFF,
 * on the same footing as `packages/contracts/src/statutory.ts` and the
 * pre-production gate `docs/PRODUCT.md` § 5.9 records. They were written
 * from an engineer's reading of the provisions cited beside them.
 * ─────────────────────────────────────────────────────────────────────
 */

interface PayrollStatutoryRateSeed {
  readonly parameter: string;
  /** An exact decimal string, never a number: a rate that has been
   * through a JS float has already lost the property that makes it
   * auditable. */
  readonly value: string;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly notification: string;
}

export const DEFAULT_PAYROLL_STATUTORY_RATES: readonly PayrollStatutoryRateSeed[] = [
  {
    parameter: 'epf_employee_percent',
    value: '12.0000',
    effectiveFrom: '2014-09-01',
    effectiveTo: null,
    notification: "Paragraph 29, Employees' Provident Funds Scheme, 1952",
  },
  {
    parameter: 'epf_employer_total_percent',
    value: '12.0000',
    effectiveFrom: '2014-09-01',
    effectiveTo: null,
    notification:
      "Section 6, Employees' Provident Funds and Miscellaneous Provisions Act, 1952",
  },
  {
    parameter: 'eps_employer_percent',
    value: '8.3300',
    effectiveFrom: '2014-09-01',
    effectiveTo: null,
    notification: "Paragraph 3, Employees' Pension Scheme, 1995",
  },
  {
    parameter: 'eps_monthly_wage_ceiling_rupees',
    value: '15000.0000',
    effectiveFrom: '2014-09-01',
    effectiveTo: null,
    notification: 'G.S.R. 609(E) dated 22 August 2014, effective 1 September 2014',
  },
  {
    parameter: 'epf_monthly_wage_ceiling_rupees',
    value: '15000.0000',
    effectiveFrom: '2014-09-01',
    effectiveTo: null,
    notification:
      "Paragraph 2(f), Employees' Provident Funds Scheme, 1952, read with G.S.R. 609(E)",
  },
  {
    parameter: 'esi_employee_percent',
    value: '1.7500',
    effectiveFrom: '2017-01-01',
    effectiveTo: '2019-06-30',
    notification:
      "Rule 51, Employees' State Insurance (Central) Rules, 1950, before G.S.R. 423(E). 1 January 2017 is this table's floor, not the date the rate was introduced",
  },
  {
    parameter: 'esi_employee_percent',
    value: '0.7500',
    effectiveFrom: '2019-07-01',
    effectiveTo: null,
    notification: 'G.S.R. 423(E) dated 13 June 2019, effective 1 July 2019',
  },
  {
    parameter: 'esi_employer_percent',
    value: '4.7500',
    effectiveFrom: '2017-01-01',
    effectiveTo: '2019-06-30',
    notification:
      "Rule 51, Employees' State Insurance (Central) Rules, 1950, before G.S.R. 423(E). 1 January 2017 is this table's floor, not the date the rate was introduced",
  },
  {
    parameter: 'esi_employer_percent',
    value: '3.2500',
    effectiveFrom: '2019-07-01',
    effectiveTo: null,
    notification: 'G.S.R. 423(E) dated 13 June 2019, effective 1 July 2019',
  },
  {
    parameter: 'esi_monthly_gross_ceiling_rupees',
    value: '21000.0000',
    effectiveFrom: '2017-01-01',
    effectiveTo: null,
    notification:
      "Rule 50, Employees' State Insurance (Central) Rules, 1950, as amended with effect from 1 January 2017",
  },
  {
    parameter: 'income_tax_cess_percent',
    value: '4.0000',
    effectiveFrom: '2018-04-01',
    effectiveTo: null,
    notification: 'Health and Education Cess, Finance Act 2018',
  },
  {
    parameter: 'income_tax_surcharge_floor_rupees',
    value: '5000000.0000',
    effectiveFrom: '2025-04-01',
    effectiveTo: null,
    notification:
      'Section 2, Finance Act 2025 — first surcharge threshold on total income',
  },
  {
    parameter: 'standard_deduction_old_rupees',
    value: '50000.0000',
    effectiveFrom: '2025-04-01',
    effectiveTo: null,
    notification: 'Section 16(ia), Income-tax Act, 1961',
  },
  {
    parameter: 'standard_deduction_new_rupees',
    value: '75000.0000',
    effectiveFrom: '2025-04-01',
    effectiveTo: null,
    notification: 'Section 16(ia) as applied to section 115BAC(1A), Finance Act 2024',
  },
  {
    parameter: 'rebate_87a_old_income_limit_rupees',
    value: '500000.0000',
    effectiveFrom: '2025-04-01',
    effectiveTo: null,
    notification: 'Section 87A, Income-tax Act, 1961 — old regime',
  },
  {
    parameter: 'rebate_87a_old_cap_rupees',
    value: '12500.0000',
    effectiveFrom: '2025-04-01',
    effectiveTo: null,
    notification: 'Section 87A, Income-tax Act, 1961 — old regime',
  },
  {
    parameter: 'rebate_87a_new_income_limit_rupees',
    value: '1200000.0000',
    effectiveFrom: '2025-04-01',
    effectiveTo: null,
    notification: 'Section 87A as amended by Finance Act 2025 — new regime',
  },
  {
    parameter: 'rebate_87a_new_cap_rupees',
    value: '60000.0000',
    effectiveFrom: '2025-04-01',
    effectiveTo: null,
    notification: 'Section 87A as amended by Finance Act 2025 — new regime',
  },
];

const MAHARASHTRA_NOTIFICATION =
  'Schedule I entry 1, Maharashtra State Tax on Professions, Trades, Callings and Employments Act 1975, as amended by Maharashtra Act No. XXII of 2023 with effect from 1 April 2023';

interface ProfessionalTaxSlabSeed {
  readonly stateCode: string;
  readonly payeeCategory: 'any' | 'male' | 'female';
  readonly effectiveFrom: string;
  readonly monthlyWageFrom: string;
  /** Exclusive; null is the top band. */
  readonly monthlyWageTo: string | null;
  readonly monthlyAmount: string;
  /** Where the State's annual figure does not divide by twelve. */
  readonly februaryAmount: string | null;
  readonly notification: string;
}

/**
 * Only Maharashtra's, and deliberately.
 *
 * Profession tax is a State levy under Article 276, so there is no
 * national schedule to seed. An organisation in another State meets a
 * named refusal — `PAYROLL_SCHEDULE_MISSING` — rather than being
 * deducted Maharashtra's figures, which is the failure that would
 * actually cost somebody money.
 *
 * Bands are [from, to), so ₹10,000 exactly falls in the ₹175 band and
 * ₹10,000.01 in the ₹200 one, which is how the entry is written.
 */
export const DEFAULT_PROFESSIONAL_TAX_SLABS: readonly ProfessionalTaxSlabSeed[] = [
  {
    stateCode: '27',
    payeeCategory: 'male',
    effectiveFrom: '2023-04-01',
    monthlyWageFrom: '0.00',
    monthlyWageTo: '7500.01',
    monthlyAmount: '0.00',
    februaryAmount: null,
    notification: MAHARASHTRA_NOTIFICATION,
  },
  {
    stateCode: '27',
    payeeCategory: 'male',
    effectiveFrom: '2023-04-01',
    monthlyWageFrom: '7500.01',
    monthlyWageTo: '10000.01',
    monthlyAmount: '175.00',
    februaryAmount: null,
    notification: MAHARASHTRA_NOTIFICATION,
  },
  {
    stateCode: '27',
    payeeCategory: 'male',
    effectiveFrom: '2023-04-01',
    monthlyWageFrom: '10000.01',
    monthlyWageTo: null,
    monthlyAmount: '200.00',
    februaryAmount: '300.00',
    notification: MAHARASHTRA_NOTIFICATION,
  },
  {
    stateCode: '27',
    payeeCategory: 'female',
    effectiveFrom: '2023-04-01',
    monthlyWageFrom: '0.00',
    monthlyWageTo: '25000.01',
    monthlyAmount: '0.00',
    februaryAmount: null,
    notification: MAHARASHTRA_NOTIFICATION,
  },
  {
    stateCode: '27',
    payeeCategory: 'female',
    effectiveFrom: '2023-04-01',
    monthlyWageFrom: '25000.01',
    monthlyWageTo: null,
    monthlyAmount: '200.00',
    februaryAmount: '300.00',
    notification: MAHARASHTRA_NOTIFICATION,
  },
];

const NEW_REGIME_NOTIFICATION =
  'Section 115BAC(1A), Income-tax Act, 1961, as substituted by Finance Act 2025 for assessment year 2026-27';
const OLD_REGIME_NOTIFICATION =
  'Paragraph A of Part III of the First Schedule, Finance Act 2025 — rates outside section 115BAC';

interface IncomeTaxSlabSeed {
  readonly regime: 'old' | 'new';
  readonly payeeCategory: 'general' | 'senior' | 'super_senior';
  readonly effectiveFrom: string;
  readonly annualIncomeFrom: string;
  readonly annualIncomeTo: string | null;
  readonly rate: string;
  readonly notification: string;
}

/** The new regime's single ladder. Section 115BAC(1A) draws no age
 * distinction, so the same seven bands are seeded for all three age
 * categories below — which keeps the resolver a single indexed lookup
 * with no fallback branch, per migration 0089 § 5. */
const NEW_REGIME_BANDS: readonly (readonly [string, string | null, string])[] = [
  ['0.00', '400000.00', '0.00'],
  ['400000.00', '800000.00', '5.00'],
  ['800000.00', '1200000.00', '10.00'],
  ['1200000.00', '1600000.00', '15.00'],
  ['1600000.00', '2000000.00', '20.00'],
  ['2000000.00', '2400000.00', '25.00'],
  ['2400000.00', null, '30.00'],
];

/** The old regime's three, which genuinely differ: the basic exemption
 * rises at sixty and again at eighty, and the eighty-and-over ladder has
 * no 5% band at all. */
const OLD_REGIME_BANDS: readonly (readonly [
  IncomeTaxSlabSeed['payeeCategory'],
  string,
  string | null,
  string,
])[] = [
  ['general', '0.00', '250000.00', '0.00'],
  ['general', '250000.00', '500000.00', '5.00'],
  ['general', '500000.00', '1000000.00', '20.00'],
  ['general', '1000000.00', null, '30.00'],
  ['senior', '0.00', '300000.00', '0.00'],
  ['senior', '300000.00', '500000.00', '5.00'],
  ['senior', '500000.00', '1000000.00', '20.00'],
  ['senior', '1000000.00', null, '30.00'],
  ['super_senior', '0.00', '500000.00', '0.00'],
  ['super_senior', '500000.00', '1000000.00', '20.00'],
  ['super_senior', '1000000.00', null, '30.00'],
];

export const DEFAULT_INCOME_TAX_SLABS: readonly IncomeTaxSlabSeed[] = [
  ...(['general', 'senior', 'super_senior'] as const).flatMap((payeeCategory) =>
    NEW_REGIME_BANDS.map(([from, to, rate]) => ({
      regime: 'new' as const,
      payeeCategory,
      effectiveFrom: '2025-04-01',
      annualIncomeFrom: from,
      annualIncomeTo: to,
      rate,
      notification: NEW_REGIME_NOTIFICATION,
    })),
  ),
  ...OLD_REGIME_BANDS.map(([payeeCategory, from, to, rate]) => ({
    regime: 'old' as const,
    payeeCategory,
    effectiveFrom: '2025-04-01',
    annualIncomeFrom: from,
    annualIncomeTo: to,
    rate,
    notification: OLD_REGIME_NOTIFICATION,
  })),
];

/**
 * Seeds all three schedules for one organisation, idempotently.
 *
 * `ON CONFLICT DO NOTHING` against each table's own uniqueness skips
 * every row that already exists, so a re-run converges and an owner's
 * later corrections are never overwritten — the same posture
 * `seedDefaultGstRates` holds. Returns how many rows were actually
 * written, so a caller can audit a real change and stay silent on a
 * no-op.
 */
export async function seedDefaultPayrollSchedules(
  tx: TransactionSql,
  organisationId: string,
): Promise<number> {
  const rates = await tx`
    insert into payroll_statutory_rates (
      organisation_id, parameter, value, effective_from, effective_to,
      notification
    )
    select ${organisationId}, seed.parameter, seed.value, seed.effective_from,
           seed.effective_to, seed.notification
    from unnest(
      ${DEFAULT_PAYROLL_STATUTORY_RATES.map((seed) => seed.parameter)}::text[],
      ${DEFAULT_PAYROLL_STATUTORY_RATES.map((seed) => seed.value)}::numeric(14,4)[],
      ${DEFAULT_PAYROLL_STATUTORY_RATES.map((seed) => seed.effectiveFrom)}::date[],
      ${DEFAULT_PAYROLL_STATUTORY_RATES.map((seed) => seed.effectiveTo)}::date[],
      ${DEFAULT_PAYROLL_STATUTORY_RATES.map((seed) => seed.notification)}::text[]
    ) as seed(parameter, value, effective_from, effective_to, notification)
    on conflict (organisation_id, parameter, effective_from) do nothing
  `;

  const slabs = await tx`
    insert into professional_tax_slabs (
      organisation_id, state_code, payee_category, effective_from,
      monthly_wage_from, monthly_wage_to, monthly_amount, february_amount,
      notification
    )
    select ${organisationId}, seed.state_code, seed.payee_category,
           seed.effective_from, seed.wage_from, seed.wage_to, seed.amount,
           seed.february, seed.notification
    from unnest(
      ${DEFAULT_PROFESSIONAL_TAX_SLABS.map((seed) => seed.stateCode)}::text[],
      ${DEFAULT_PROFESSIONAL_TAX_SLABS.map((seed) => seed.payeeCategory)}::text[],
      ${DEFAULT_PROFESSIONAL_TAX_SLABS.map((seed) => seed.effectiveFrom)}::date[],
      ${DEFAULT_PROFESSIONAL_TAX_SLABS.map((seed) => seed.monthlyWageFrom)}::numeric(18,2)[],
      ${DEFAULT_PROFESSIONAL_TAX_SLABS.map((seed) => seed.monthlyWageTo)}::numeric(18,2)[],
      ${DEFAULT_PROFESSIONAL_TAX_SLABS.map((seed) => seed.monthlyAmount)}::numeric(18,2)[],
      ${DEFAULT_PROFESSIONAL_TAX_SLABS.map((seed) => seed.februaryAmount)}::numeric(18,2)[],
      ${DEFAULT_PROFESSIONAL_TAX_SLABS.map((seed) => seed.notification)}::text[]
    ) as seed(
      state_code, payee_category, effective_from, wage_from, wage_to, amount,
      february, notification
    )
    on conflict (
      organisation_id, state_code, payee_category, effective_from,
      monthly_wage_from
    ) do nothing
  `;

  const ladders = await tx`
    insert into income_tax_slabs (
      organisation_id, regime, payee_category, effective_from,
      annual_income_from, annual_income_to, rate, notification
    )
    select ${organisationId}, seed.regime, seed.payee_category,
           seed.effective_from, seed.income_from, seed.income_to, seed.rate,
           seed.notification
    from unnest(
      ${DEFAULT_INCOME_TAX_SLABS.map((seed) => seed.regime)}::text[],
      ${DEFAULT_INCOME_TAX_SLABS.map((seed) => seed.payeeCategory)}::text[],
      ${DEFAULT_INCOME_TAX_SLABS.map((seed) => seed.effectiveFrom)}::date[],
      ${DEFAULT_INCOME_TAX_SLABS.map((seed) => seed.annualIncomeFrom)}::numeric(18,2)[],
      ${DEFAULT_INCOME_TAX_SLABS.map((seed) => seed.annualIncomeTo)}::numeric(18,2)[],
      ${DEFAULT_INCOME_TAX_SLABS.map((seed) => seed.rate)}::numeric(5,2)[],
      ${DEFAULT_INCOME_TAX_SLABS.map((seed) => seed.notification)}::text[]
    ) as seed(
      regime, payee_category, effective_from, income_from, income_to, rate,
      notification
    )
    on conflict (
      organisation_id, regime, payee_category, effective_from,
      annual_income_from
    ) do nothing
  `;

  return rates.count + slabs.count + ladders.count;
}
