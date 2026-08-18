import { Type, type Static } from '@sinclair/typebox';

/**
 * The one place a statutory rate, threshold or legal citation is written
 * down.
 *
 * WHY THIS FILE EXISTS. Before it, the same statutory facts were spelled
 * out in four places that could not see each other: the deduction-head
 * hints in `apps/web/src/views/WorkBillSettlement.tsx`, the prose in
 * `packages/db/migrations/0067_bill_payments.sql`, the commentary at the
 * head of `packages/contracts/src/bill-payments.ts`, and the route
 * comments in `apps/server/src/routes/bill-payments.ts`. Four copies of a
 * number that Parliament changes on a Finance Act cycle is four chances
 * to update three of them. Every rate, every threshold and every
 * provision now lives here once, and both halves of the product read it
 * from here.
 *
 * WHY IN `contracts` RATHER THAN THE SERVER. `apps/server` cannot be
 * imported by `apps/web`, and the web half needs the labels and the
 * provision citations to render a deduction row honestly. This package is
 * the only module both halves already depend on, so it is the only place
 * a single copy can actually be single. The precedent it deliberately
 * does NOT follow is `apps/server/src/gst-rates.ts`, whose
 * `DEFAULT_GST_RATES` is seed data for a per-organisation table an owner
 * then edits; these values are not editable configuration, they are what
 * the statute currently says.
 *
 * ─────────────────────────────────────────────────────────────────────
 * EVERY NUMBER BELOW IS UNVERIFIED AND REQUIRES OWNER CONFIRMATION.
 *
 * These were written from an engineer's reading, not from a tax
 * practitioner's advice, and Indian TDS rates and thresholds move with
 * each Finance Act. `statutoryVerificationChecklist()` enumerates them
 * so a pull request can list them for sign-off rather than burying them
 * in a diff. Nothing here should be treated as correct until an owner
 * has confirmed it against the bare Act.
 * ─────────────────────────────────────────────────────────────────────
 */

/** A pointer to the law a value comes from, carried next to the value so
 * a reviewer never has to guess which statute a number is claiming. */
interface StatutoryProvision {
  /** How the provision is cited in ordinary Indian practice. */
  readonly citation: string;
  /** The enactment the citation belongs to. */
  readonly act: string;
  /** What the provision does, in one operational sentence. */
  readonly effect: string;
}

// ── Vendor-side income-tax TDS ───────────────────────────────────────

/**
 * The TDS sections an executing agency actually deducts under when it
 * pays a vendor. Two, not the whole Act: 194C for work done and 194J for
 * professional or technical fees. A section this product cannot compute
 * correctly is a section it should not offer, so the list stays short and
 * grows only when a real payment needs it.
 */
const TDS_SECTIONS = ['194C', '194J'] as const;
export const TdsSectionSchema = Type.Union(
  TDS_SECTIONS.map((section) => Type.Literal(section)),
);
type TdsSection = Static<typeof TdsSectionSchema>;

/**
 * Which of a section's two rates applies. 194C splits on what kind of
 * person the payee is; 194J splits on what kind of service was bought.
 * One discriminator serves both because both are a binary choice the
 * operator makes at capture time.
 */
const TDS_PAYEE_CLASSES = ['individual_huf', 'other'] as const;
export const TdsPayeeClassSchema = Type.Union(
  TDS_PAYEE_CLASSES.map((payeeClass) => Type.Literal(payeeClass)),
);
type TdsPayeeClass = Static<typeof TdsPayeeClassSchema>;

interface TdsSectionRule {
  readonly section: TdsSection;
  readonly label: string;
  readonly provision: StatutoryProvision;
  /**
   * Rate as an exact decimal string, never a number. A percentage that
   * has been through a JS float has already lost the property that makes
   * it auditable.
   */
  readonly rates: Readonly<Record<TdsPayeeClass, string>>;
  /** What each rate branch means for this section, since the same
   * discriminator names different things in 194C and 194J. */
  readonly rateLabels: Readonly<Record<TdsPayeeClass, string>>;
  /** Deduction is due once a SINGLE payment reaches this, in rupees, as
   * a decimal string. `null` where the section has no single-payment
   * trigger. */
  readonly singlePaymentThreshold: string | null;
  /** Deduction is due once the financial-year AGGREGATE to this payee
   * reaches this, in rupees, as a decimal string. */
  readonly annualThreshold: string;
}

/**
 * UNVERIFIED — every rate and threshold in this table needs owner
 * confirmation. See the checklist at the foot of this file.
 */
export const TDS_SECTION_RULES: readonly TdsSectionRule[] = [
  {
    section: '194C',
    label: 'Payments to contractors',
    provision: {
      citation: 'Section 194C',
      act: 'Income-tax Act, 1961',
      effect:
        'Tax is deducted at source on payment to a resident contractor or sub-contractor for carrying out any work, including supply of labour.',
    },
    rates: { individual_huf: '1.00', other: '2.00' },
    rateLabels: {
      individual_huf: 'Individual or HUF payee — 1%',
      other: 'Any other person (company, firm, LLP) — 2%',
    },
    singlePaymentThreshold: '30000.00',
    annualThreshold: '100000.00',
  },
  {
    section: '194J',
    label: 'Professional or technical fees',
    provision: {
      citation: 'Section 194J',
      act: 'Income-tax Act, 1961',
      effect:
        'Tax is deducted at source on fees for professional services, fees for technical services, royalty, and non-compete payments.',
    },
    rates: { individual_huf: '2.00', other: '10.00' },
    rateLabels: {
      individual_huf: 'Technical service or call-centre operation — 2%',
      other: 'Professional service — 10%',
    },
    singlePaymentThreshold: null,
    annualThreshold: '30000.00',
  },
];

/**
 * The penal rate for a payee who has not furnished a PAN.
 *
 * Section 206AA does not set a rate, it sets a FLOOR: deduct at the
 * higher of the rate in force and 20%. Modelling it as a floor rather
 * than as "20% when PAN is missing" matters for 194J professional fees,
 * where the ordinary 10%... is lower, but also for any future section
 * whose rate exceeds 20%, where blindly substituting 20% would
 * under-deduct. `resolveTdsRate` applies it as a floor.
 *
 * UNVERIFIED — needs owner confirmation.
 */
export const PAN_ABSENT_MINIMUM_RATE = '20.00';
const PAN_ABSENT_PROVISION: StatutoryProvision = {
  citation: 'Section 206AA',
  act: 'Income-tax Act, 1961',
  effect:
    'Where the payee has not furnished a PAN, tax is deducted at the higher of the rate in force and 20%.',
};

// ── Railway-side deduction heads ─────────────────────────────────────

/**
 * The heads a railway payment against a prepared bill is reduced by,
 * each with the provision that authorises it.
 *
 * `GST_TDS`, `INCOME_TAX_TDS`, `SECURITY_DEPOSIT`, `PENALTY` and `OTHER`
 * are the original five of migration 0067. `BOCW_CESS` and
 * `LIQUIDATED_DAMAGES` are added because both were previously swept into
 * `OTHER` or into `PENALTY`, and neither belongs there: BOCW cess is a
 * statutory levy reconciled against a cess return, and liquidated damages
 * are a contractual recovery argued under a named GCC clause. A head that
 * is reconciled through its own form needs its own row, which is the same
 * reasoning that separated GST TDS from income-tax TDS in the first
 * place.
 *
 * `PENALTY` is deliberately kept alongside `LIQUIDATED_DAMAGES` rather
 * than replaced by it. They are not the same recovery — LD is the
 * pre-agreed sum for delay under the contract, a penalty is anything else
 * the railway imposes — and existing rows already carry `PENALTY`.
 */
export const BILL_DEDUCTION_HEADS = [
  'GST_TDS',
  'INCOME_TAX_TDS',
  'SECURITY_DEPOSIT',
  'LIQUIDATED_DAMAGES',
  'BOCW_CESS',
  'PENALTY',
  'OTHER',
] as const;
type BillDeductionHead = (typeof BILL_DEDUCTION_HEADS)[number];

interface BillDeductionHeadRule {
  readonly head: BillDeductionHead;
  readonly label: string;
  /** Where the operator reconciles or reclaims this head. Shown as the
   * hint under the field, so the person entering it knows which document
   * proves it. */
  readonly reconciledThrough: string;
  /** `null` for the heads that are contractual rather than statutory. */
  readonly provision: StatutoryProvision | null;
  /**
   * The contract value above which the head applies at all, where the
   * provision sets one. Only GST TDS does: section 51 engages a deductor
   * once the contract's taxable value exceeds ₹2,50,000.
   *
   * Typed rather than left in the provision prose because it is a rule
   * an operator acts on — "should this bill have GST TDS on it at all" —
   * and `statutoryVerificationChecklist()` only sees typed fields. The
   * RATES of these heads are deliberately NOT typed here: the railway
   * computes them and the operator copies the figure off the payment
   * advice, so a rate on this side would be a number the product asserts
   * and never uses. They stay described in `provision.effect`.
   */
  readonly contractValueThreshold: string | null;
}

/**
 * UNVERIFIED — every rate below needs owner confirmation.
 */
export const BILL_DEDUCTION_HEAD_RULES: readonly BillDeductionHeadRule[] = [
  {
    head: 'GST_TDS',
    label: 'GST TDS',
    reconciledThrough: 'GSTR-7A',
    provision: {
      citation: 'Section 51',
      act: 'Central Goods and Services Tax Act, 2017',
      effect:
        'A notified deductor, which includes a Government department, deducts 2% (1% CGST + 1% SGST, or 2% IGST) from payment on a contract whose taxable value exceeds ₹2,50,000.',
    },
    contractValueThreshold: '250000.00',
  },
  {
    head: 'INCOME_TAX_TDS',
    label: 'Income-tax TDS',
    reconciledThrough: 'Form 26AS',
    provision: {
      citation: 'Section 194C',
      act: 'Income-tax Act, 1961',
      effect:
        'The railway deducts tax at source on payment to the agency as a contractor. The rate follows the agency’s own payee class.',
    },
    contractValueThreshold: null,
  },
  {
    head: 'SECURITY_DEPOSIT',
    label: 'Retention / SD',
    reconciledThrough: 'Release at PAC or end of maintenance',
    provision: null,
    contractValueThreshold: null,
  },
  {
    head: 'LIQUIDATED_DAMAGES',
    label: 'Liquidated damages',
    reconciledThrough: 'Contract clause — argued per bill',
    provision: null,
    contractValueThreshold: null,
  },
  {
    head: 'BOCW_CESS',
    label: 'BOCW cess',
    reconciledThrough: 'Cess return to the State welfare board',
    provision: {
      citation: 'Section 3',
      act: 'Building and Other Construction Workers’ Welfare Cess Act, 1996',
      effect:
        'A cess of 1% of the cost of construction is levied and is deducted at source by the authority approving the works.',
    },
    contractValueThreshold: null,
  },
  {
    head: 'PENALTY',
    label: 'Penalty',
    reconciledThrough: 'Argued individually',
    provision: null,
    contractValueThreshold: null,
  },
  {
    head: 'OTHER',
    label: 'Other',
    reconciledThrough: 'Named in the description, which is required',
    provision: null,
    contractValueThreshold: null,
  },
];

const HEAD_RULE_BY_HEAD: ReadonlyMap<BillDeductionHead, BillDeductionHeadRule> =
  new Map(BILL_DEDUCTION_HEAD_RULES.map((rule) => [rule.head, rule]));

export function billDeductionHeadRule(head: BillDeductionHead): BillDeductionHeadRule {
  const rule = HEAD_RULE_BY_HEAD.get(head);
  // The map is built from the same literal union the parameter is typed
  // by, so a miss is impossible unless the two drift apart; throwing
  // rather than returning a placeholder is what makes that drift loud.
  if (rule === undefined) {
    throw new Error(`No statutory rule declared for deduction head ${head}.`);
  }
  return rule;
}

const SECTION_RULE_BY_SECTION: ReadonlyMap<TdsSection, TdsSectionRule> = new Map(
  TDS_SECTION_RULES.map((rule) => [rule.section, rule]),
);

export function tdsSectionRule(section: TdsSection): TdsSectionRule {
  const rule = SECTION_RULE_BY_SECTION.get(section);
  if (rule === undefined) {
    throw new Error(`No statutory rule declared for TDS section ${section}.`);
  }
  return rule;
}

// ── Rate resolution ──────────────────────────────────────────────────

/**
 * Comparison of two exact decimal strings without going through a JS
 * number.
 *
 * Money and rates in this product are decimal strings precisely so that
 * `0.1 + 0.2` never happens to them, and a comparison that parses both
 * sides with `Number()` hands that property straight back. Splitting on
 * the point and comparing the integer and fractional halves as padded
 * digit strings keeps the whole operation in exact arithmetic.
 *
 * Both inputs are schema-validated decimal strings by the time they
 * reach here — unsigned, at most one point — so this does not attempt to
 * be a general decimal parser.
 */
export function compareDecimalStrings(left: string, right: string): number {
  const [leftWhole = '0', leftFraction = ''] = left.split('.');
  const [rightWhole = '0', rightFraction = ''] = right.split('.');

  const wholeWidth = Math.max(leftWhole.length, rightWhole.length);
  const leftPaddedWhole = leftWhole.padStart(wholeWidth, '0');
  const rightPaddedWhole = rightWhole.padStart(wholeWidth, '0');
  if (leftPaddedWhole !== rightPaddedWhole) {
    return leftPaddedWhole < rightPaddedWhole ? -1 : 1;
  }

  const fractionWidth = Math.max(leftFraction.length, rightFraction.length);
  const leftPaddedFraction = leftFraction.padEnd(fractionWidth, '0');
  const rightPaddedFraction = rightFraction.padEnd(fractionWidth, '0');
  if (leftPaddedFraction === rightPaddedFraction) return 0;
  return leftPaddedFraction < rightPaddedFraction ? -1 : 1;
}

/** Subtraction of two non-negative decimal strings, exact, floored at
 * zero. Deliberately NOT exported and deliberately not named
 * `subtractDecimalStrings`: `apps/web/src/format.ts` exports a function of
 * that name with different semantics — signed, and rounded to three
 * places for display — and two different subtractions sharing one name
 * across the barrel is how the wrong one gets imported. This one exists
 * only to work out how much of a financial-year aggregate has not yet
 * been taxed. */
function untaxedRemainder(left: string, right: string): string {
  if (compareDecimalStrings(left, right) <= 0) return '0.00';
  const [leftWhole = '0', leftFraction = ''] = left.split('.');
  const [rightWhole = '0', rightFraction = ''] = right.split('.');
  const fractionWidth = Math.max(leftFraction.length, rightFraction.length);
  const scaled = (whole: string, fraction: string): bigint =>
    BigInt(whole + fraction.padEnd(fractionWidth, '0'));
  const total = scaled(leftWhole, leftFraction) - scaled(rightWhole, rightFraction);
  if (fractionWidth === 0) return total.toString();
  const digits = total.toString().padStart(fractionWidth + 1, '0');
  const cut = digits.length - fractionWidth;
  return `${digits.slice(0, cut)}.${digits.slice(cut)}`;
}

interface TdsRateQuery {
  readonly section: TdsSection;
  readonly payeeClass: TdsPayeeClass;
  /** False when the vendor has no PAN on record, which engages the
   * section 206AA floor. */
  readonly panOnRecord: boolean;
  /** This payment's own amount, as an exact decimal string. */
  readonly paymentAmount: string;
  /** What has already been paid to this vendor in the same financial
   * year, BEFORE this payment, as an exact decimal string. Summed in
   * SQL by the caller — the browser never adds money. */
  readonly financialYearPaidBefore: string;
  /** How much of `financialYearPaidBefore` was ALREADY subjected to TDS.
   * Only the untaxed remainder is caught up when the annual threshold is
   * crossed; without this a payment that was taxed on its own single-
   * payment trigger would be taxed a second time by the catch-up. */
  readonly financialYearTaxedBefore: string;
}

/** What the rate is applied to. `payment` is the ordinary case;
 * `aggregate_catch_up` is the crossing payment, which carries the tax of
 * every earlier untaxed payment in the year as well as its own. */
type TdsTaxableBasis = 'payment' | 'aggregate_catch_up' | 'none';

interface TdsRateVerdict {
  /** The rate to apply, as an exact decimal string. `'0.00'` when no
   * threshold has been crossed. */
  readonly rate: string;
  /** True when a threshold has been crossed and tax is actually due. */
  readonly deductible: boolean;
  /** True when the section 206AA floor raised the rate above the
   * ordinary one — the PAN-absent higher-rate flag. */
  readonly panAbsentUplift: boolean;
  /** Which threshold triggered, for the operator and the audit trail. */
  readonly thresholdBasis: 'single_payment' | 'annual_aggregate' | 'none';
  /** The ordinary rate before the 206AA floor, so a screen can show what
   * furnishing a PAN would save. */
  readonly ordinaryRate: string;
  /** The amount the rate multiplies. Equal to `paymentAmount` except on
   * the payment that first carries the year over its annual threshold,
   * where it is the untaxed part of the whole aggregate. */
  readonly taxableAmount: string;
  /** Why `taxableAmount` is what it is. Snapshotted onto the payment row
   * so a 26Q line whose tax exceeds its own rate × gross explains
   * itself years later. */
  readonly taxableBasis: TdsTaxableBasis;
}

/**
 * Decides whether TDS is due on one vendor payment, at what rate, and on
 * what amount.
 *
 * THRESHOLDS ARE STRICTLY ABOVE, NOT AT. Sections 194C(5) and 194J are
 * written as "does not exceed", so a payment of exactly ₹30,000 is not
 * deductible and ₹30,000.01 is. The `>` here is the whole difference
 * between reading the Act and paraphrasing it, and it is the boundary an
 * operator meets on a round-numbered invoice.
 *
 * THE CROSSING PAYMENT CARRIES THE WHOLE YEAR. Below the annual
 * threshold nothing is withheld; the moment the financial-year aggregate
 * exceeds it, tax is due on the aggregate — including the earlier
 * payments that went out untaxed — and the deductor recovers it from the
 * payment in hand. So the crossing payment's taxable amount is the
 * aggregate, not itself. Five payments of ₹25,000 under 194C withhold
 * nothing on the first four and tax ₹1,25,000 on the fifth.
 *
 * `financialYearTaxedBefore` keeps that catch-up from double-taxing: a
 * payment already taxed on its own single-payment trigger is subtracted
 * out, so only the genuinely untaxed remainder is caught up.
 *
 * This returns a verdict; it does not compute the tax amount. Rate ×
 * amount is money arithmetic and belongs in SQL numeric, not here.
 */
export function resolveTdsRate(query: TdsRateQuery): TdsRateVerdict {
  const rule = tdsSectionRule(query.section);
  const ordinaryRate = rule.rates[query.payeeClass];

  // Strictly above: "does not exceed" means the threshold itself is
  // still exempt.
  const singleTriggered =
    rule.singlePaymentThreshold !== null &&
    compareDecimalStrings(query.paymentAmount, rule.singlePaymentThreshold) > 0;

  const aggregate = addDecimalStrings(
    query.financialYearPaidBefore,
    query.paymentAmount,
  );
  const annualTriggered = compareDecimalStrings(aggregate, rule.annualThreshold) > 0;
  const alreadyOver =
    compareDecimalStrings(query.financialYearPaidBefore, rule.annualThreshold) > 0;

  const thresholdBasis = singleTriggered
    ? 'single_payment'
    : annualTriggered
      ? 'annual_aggregate'
      : 'none';

  if (thresholdBasis === 'none') {
    return {
      rate: '0.00',
      deductible: false,
      panAbsentUplift: false,
      thresholdBasis,
      ordinaryRate,
      taxableAmount: '0.00',
      taxableBasis: 'none',
    };
  }

  // The catch-up arm: the year crosses its annual threshold on THIS
  // payment, so everything paid this year that has not yet been taxed
  // becomes taxable now. Once the year is already over the threshold,
  // each later payment carries only itself.
  const catchingUp = annualTriggered && !alreadyOver;
  const taxableAmount = catchingUp
    ? untaxedRemainder(aggregate, query.financialYearTaxedBefore)
    : query.paymentAmount;

  // Section 206AA as a floor, not a substitution: the higher of the rate
  // in force and 20%.
  const upliftApplies =
    !query.panOnRecord &&
    compareDecimalStrings(PAN_ABSENT_MINIMUM_RATE, ordinaryRate) > 0;

  return {
    rate: upliftApplies ? PAN_ABSENT_MINIMUM_RATE : ordinaryRate,
    deductible: true,
    panAbsentUplift: upliftApplies,
    thresholdBasis,
    ordinaryRate,
    taxableAmount,
    taxableBasis: catchingUp ? 'aggregate_catch_up' : 'payment',
  };
}

/**
 * Exact addition of two non-negative decimal strings.
 *
 * Used only to form the threshold-comparison aggregate above, which is a
 * COMPARISON input and never a stored amount — every authoritative total
 * in this product is summed by PostgreSQL numeric. It exists because
 * asking the database for "the aggregate including a payment that has
 * not been inserted yet" would mean a speculative write, and because
 * `Number(a) + Number(b)` on rupee figures is exactly the float
 * arithmetic AGENTS.md rule 5 forbids.
 */
export function addDecimalStrings(left: string, right: string): string {
  const [leftWhole = '0', leftFraction = ''] = left.split('.');
  const [rightWhole = '0', rightFraction = ''] = right.split('.');
  const fractionWidth = Math.max(leftFraction.length, rightFraction.length);

  const scaled = (whole: string, fraction: string): bigint =>
    BigInt(whole + fraction.padEnd(fractionWidth, '0'));

  const total = scaled(leftWhole, leftFraction) + scaled(rightWhole, rightFraction);
  if (fractionWidth === 0) return total.toString();

  const digits = total.toString().padStart(fractionWidth + 1, '0');
  const cut = digits.length - fractionWidth;
  return `${digits.slice(0, cut)}.${digits.slice(cut)}`;
}

// ── Owner verification ───────────────────────────────────────────────

interface StatutoryVerificationItem {
  readonly value: string;
  readonly meaning: string;
  readonly provision: StatutoryProvision;
}

/**
 * Every statutory number this module asserts, flattened for an owner to
 * check off.
 *
 * This is generated from the tables above rather than written out again,
 * so a rate that is added without being verified cannot be added without
 * appearing on the checklist. The pull request that introduces or
 * changes any of these pastes this list.
 */
export function statutoryVerificationChecklist(): readonly StatutoryVerificationItem[] {
  const items: StatutoryVerificationItem[] = [];

  for (const rule of TDS_SECTION_RULES) {
    for (const payeeClass of TDS_PAYEE_CLASSES) {
      items.push({
        value: `${rule.rates[payeeClass]}%`,
        meaning: `${rule.section} rate — ${rule.rateLabels[payeeClass]}`,
        provision: rule.provision,
      });
    }
    if (rule.singlePaymentThreshold !== null) {
      items.push({
        value: `₹${rule.singlePaymentThreshold}`,
        meaning: `${rule.section} single-payment threshold`,
        provision: rule.provision,
      });
    }
    items.push({
      value: `₹${rule.annualThreshold}`,
      meaning: `${rule.section} financial-year aggregate threshold`,
      provision: rule.provision,
    });
  }

  items.push({
    value: `${PAN_ABSENT_MINIMUM_RATE}%`,
    meaning: 'Minimum rate where the payee has furnished no PAN',
    provision: PAN_ABSENT_PROVISION,
  });

  for (const rule of BILL_DEDUCTION_HEAD_RULES) {
    if (rule.contractValueThreshold === null || rule.provision === null) continue;
    items.push({
      value: `₹${rule.contractValueThreshold}`,
      meaning: `Contract value above which ${rule.label} applies at all`,
      provision: rule.provision,
    });
  }

  return items;
}
