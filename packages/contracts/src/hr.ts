import { Type, type Static } from '@sinclair/typebox';
import {
  DateOnlySchema,
  NonNegativeMoneyStringSchema,
  PositiveMoneyStringSchema,
  UuidSchema,
  nonBlankString,
} from './primitives.js';

/**
 * The employee master and the monthly payroll run (migrations 0089 and
 * 0090).
 *
 * Every amount here is an exact decimal string that PostgreSQL computed.
 * The browser formats a payslip; it never adds one up — a payroll that
 * had been through JavaScript floating point would disagree with the
 * contribution actually remitted, by paise at first and by rupees over a
 * year of them.
 *
 * ─────────────────────────────────────────────────────────────────────
 * WHAT THIS FILE DELIBERATELY DOES NOT CARRY: a statutory rate.
 *
 * `statutory.ts` holds the vendor-side TDS rates as constants and says
 * why. Payroll's rates cannot live beside them: a run is re-computed and
 * a run for a past month must reproduce that month's figures, so the
 * rates are rows in a dated table (`payroll_statutory_rates`, 0089) and
 * the only thing that reads them is the SQL that does the arithmetic.
 * What crosses this boundary is the RESULT, plus — on a run's detail —
 * the parameters that produced it, so a screen can show an operator what
 * the run was computed against without becoming a second copy of it.
 * ─────────────────────────────────────────────────────────────────────
 */

// ── The employee ─────────────────────────────────────────────────────

/** Whether the employer contributes provident fund on the whole wage or
 * restricts it to the statutory ceiling. Both are lawful and the gap is
 * thousands of rupees a month, so it is the organisation's recorded
 * election rather than a rule the product picks. */
const PF_WAGE_BASES = ['actual', 'ceiling'] as const;
const PfWageBasisSchema = Type.Union(PF_WAGE_BASES.map((basis) => Type.Literal(basis)));

/**
 * Which arm of a State's profession-tax schedule applies.
 *
 * It exists for one reason, and the field is named for that reason
 * rather than for the category: Maharashtra and several other States set
 * a higher exemption threshold for women — ₹25,000 a month against
 * ₹7,500 since the 2023 amendment — and a payroll that did not read the
 * distinction would deduct ₹200 a month from every woman between those
 * figures who owes nothing.
 */
const PROFESSIONAL_TAX_CATEGORIES = ['male', 'female'] as const;
const ProfessionalTaxCategorySchema = Type.Union(
  PROFESSIONAL_TAX_CATEGORIES.map((category) => Type.Literal(category)),
);

/** `new` is the default under section 115BAC(1A) — an employee opts OUT
 * of it rather than into it — so the product defaults the same way the
 * statute does. */
const TAX_REGIMES = ['old', 'new'] as const;
const TaxRegimeSchema = Type.Union(TAX_REGIMES.map((regime) => Type.Literal(regime)));

/**
 * The register's projection of an employee.
 *
 * WHAT IS NOT HERE IS THE POINT. No PAN, no UAN, no ESIC number, no bank
 * details, and no salary structure. Those are on the detail, behind the
 * same authority, because a register is the screen most likely to be
 * open on a shared desk and a list API is the payload most likely to end
 * up in a log, a cache or a screenshot. `contacts.pan` set the precedent
 * (migration 0080): stored, exported in the owner's own portability
 * snapshot, and not projected where no screen needs it.
 *
 * `monthlyGross` IS here, because a register with no money on it cannot
 * answer the question a payroll clerk opens it to ask, and it is the sum
 * rather than the structure.
 */
const EmployeeSummarySchema = Type.Object(
  {
    id: UuidSchema,
    employeeCode: Type.String(),
    name: Type.String(),
    designation: Type.Union([Type.String(), Type.Null()]),
    department: Type.Union([Type.String(), Type.Null()]),
    dateOfJoining: DateOnlySchema,
    dateOfExit: Type.Union([DateOnlySchema, Type.Null()]),
    /** Derived, never stored: an employee is current until their exit
     * date has passed. A stored flag beside the date is a second answer
     * to one question. */
    employed: Type.Boolean(),
    monthlyGross: NonNegativeMoneyStringSchema,
    pfCovered: Type.Boolean(),
    esiApplicable: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type EmployeeSummary = Static<typeof EmployeeSummarySchema>;

const EmployeeSchema = Type.Object(
  {
    id: UuidSchema,
    contactId: UuidSchema,
    employeeCode: Type.String(),
    name: Type.String(),
    designation: Type.Union([Type.String(), Type.Null()]),
    department: Type.Union([Type.String(), Type.Null()]),
    phone: Type.Union([Type.String(), Type.Null()]),
    email: Type.Union([Type.String(), Type.Null()]),
    dateOfJoining: DateOnlySchema,
    dateOfExit: Type.Union([DateOnlySchema, Type.Null()]),
    dateOfBirth: DateOnlySchema,
    employed: Type.Boolean(),

    pan: Type.Union([Type.String(), Type.Null()]),
    uan: Type.Union([Type.String(), Type.Null()]),
    esicNumber: Type.Union([Type.String(), Type.Null()]),

    /**
     * The salary account, with the number MASKED to its last four
     * digits, exactly as the mock's own directory shows it.
     *
     * Nothing in this pack needs the whole number: a salary is paid
     * through the payments workspace, whose beneficiary snapshot reads
     * the contact directly. A screen that displayed the full account
     * would be publishing it for no purpose the screen has.
     */
    bankName: Type.Union([Type.String(), Type.Null()]),
    bankAccountMasked: Type.Union([Type.String(), Type.Null()]),
    bankIfsc: Type.Union([Type.String(), Type.Null()]),

    pfCovered: Type.Boolean(),
    pfWageBasis: PfWageBasisSchema,
    esiApplicable: Type.Boolean(),
    professionalTaxStateCode: Type.Union([Type.String(), Type.Null()]),
    professionalTaxCategory: Type.Union([ProfessionalTaxCategorySchema, Type.Null()]),

    taxRegime: TaxRegimeSchema,
    declaredExemptAllowancesAnnual: NonNegativeMoneyStringSchema,
    declaredChapterViaAnnual: NonNegativeMoneyStringSchema,

    basicMonthly: PositiveMoneyStringSchema,
    dearnessAllowanceMonthly: NonNegativeMoneyStringSchema,
    houseRentAllowanceMonthly: NonNegativeMoneyStringSchema,
    otherAllowancesMonthly: NonNegativeMoneyStringSchema,
    monthlyGross: NonNegativeMoneyStringSchema,
  },
  { additionalProperties: false },
);
export type Employee = Static<typeof EmployeeSchema>;

/**
 * The employment facts, without the party facts.
 *
 * Name, phone, email, PAN and bank details are NOT here: they live on
 * the `contacts` row this points at, they are edited on the contact form
 * in Masters, and a second form writing the same columns is how two
 * masters start disagreeing. Creating an employee therefore names an
 * existing contact.
 */
const EMPLOYEE_FIELDS = {
  /** Two characters at least. `nonBlankString` cannot express a
   * one-character minimum — its pattern needs a non-space at each end
   * — and a single-character employee code is not worth a second
   * validator, so the floor is two here and two in the CHECK. */
  employeeCode: nonBlankString({ minLength: 2, maxLength: 40 }),
  department: Type.Optional(
    Type.Union([nonBlankString({ minLength: 2, maxLength: 100 }), Type.Null()]),
  ),
  dateOfJoining: DateOnlySchema,
  dateOfExit: Type.Optional(Type.Union([DateOnlySchema, Type.Null()])),
  /** Required: the old regime's basic exemption depends on age, so a
   * run cannot pick the right slab ladder without it. */
  dateOfBirth: DateOnlySchema,

  uan: Type.Optional(
    Type.Union([Type.String({ pattern: '^[0-9]{12}$' }), Type.Null()]),
  ),
  esicNumber: Type.Optional(
    Type.Union([Type.String({ pattern: '^[0-9]{17}$' }), Type.Null()]),
  ),

  pfCovered: Type.Boolean(),
  pfWageBasis: PfWageBasisSchema,
  esiApplicable: Type.Boolean(),

  /** The two-digit GST State code, or null where the State levies no
   * profession tax. Travels with its category: a schedule cannot be
   * resolved without both. */
  professionalTaxStateCode: Type.Optional(
    Type.Union([Type.String({ pattern: '^[0-9]{2}$' }), Type.Null()]),
  ),
  professionalTaxCategory: Type.Optional(
    Type.Union([ProfessionalTaxCategorySchema, Type.Null()]),
  ),

  taxRegime: TaxRegimeSchema,
  /** The two totals off the employee's signed Form 12BB. Both ignored
   * under the new regime, where neither deduction is available. */
  declaredExemptAllowancesAnnual: Type.Optional(NonNegativeMoneyStringSchema),
  declaredChapterViaAnnual: Type.Optional(NonNegativeMoneyStringSchema),

  basicMonthly: PositiveMoneyStringSchema,
  dearnessAllowanceMonthly: Type.Optional(NonNegativeMoneyStringSchema),
  houseRentAllowanceMonthly: Type.Optional(NonNegativeMoneyStringSchema),
  otherAllowancesMonthly: Type.Optional(NonNegativeMoneyStringSchema),
} as const;

/**
 * Spread into one flat object rather than composed with `Type.Intersect`.
 *
 * An intersect of two objects that each carry `additionalProperties:
 * false` can never validate: each half refuses the other half's
 * properties, and the refusal arrives as a 400 saying a property that IS
 * present is missing. A flat object is what the validator can actually
 * check, and every other request schema in this package is one.
 */
export const CreateEmployeeSchema = Type.Object(
  { contactId: UuidSchema, ...EMPLOYEE_FIELDS },
  { additionalProperties: false },
);
export type CreateEmployee = Static<typeof CreateEmployeeSchema>;

export const UpdateEmployeeSchema = Type.Object(EMPLOYEE_FIELDS, {
  additionalProperties: false,
});
export type UpdateEmployee = Static<typeof UpdateEmployeeSchema>;

export const EmployeeResponseSchema = Type.Object(
  { employee: EmployeeSchema },
  { additionalProperties: false },
);
export type EmployeeResponse = Static<typeof EmployeeResponseSchema>;

export const EmployeeListQuerySchema = Type.Object(
  {
    /** `current` is the default: a register of people who have left is a
     * different question, asked deliberately. */
    status: Type.Optional(Type.Union([Type.Literal('all'), Type.Literal('current')])),
    search: Type.Optional(Type.String({ maxLength: 200 })),
  },
  { additionalProperties: false },
);

export const EmployeeListResponseSchema = Type.Object(
  {
    employees: Type.Array(EmployeeSummarySchema),
    nextCursor: Type.Union([UuidSchema, Type.Null()]),
    /** Register-wide, not the page's: the stat strip counts everybody. */
    currentCount: Type.Integer(),
    /** What the payroll costs at full attendance, summed by PostgreSQL
     * over every current employee. Register-wide for the same reason,
     * and server-side because the browser never adds money up. */
    currentMonthlyGross: NonNegativeMoneyStringSchema,
  },
  { additionalProperties: false },
);
export type EmployeeListResponse = Static<typeof EmployeeListResponseSchema>;

// ── The payroll run ──────────────────────────────────────────────────

const PAYROLL_RUN_STATUSES = ['draft', 'finalized', 'cancelled'] as const;
const PayrollRunStatusSchema = Type.Union(
  PAYROLL_RUN_STATUSES.map((status) => Type.Literal(status)),
);

const PayrollRunSummarySchema = Type.Object(
  {
    id: UuidSchema,
    runNumber: Type.String(),
    /** The month being paid, as its first day. */
    periodMonth: DateOnlySchema,
    status: PayrollRunStatusSchema,
    calculatedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
    finalizedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
    cancelledAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
    cancelReason: Type.Union([Type.String(), Type.Null()]),
    employeeCount: Type.Integer(),
    totalGross: NonNegativeMoneyStringSchema,
    totalNet: NonNegativeMoneyStringSchema,
  },
  { additionalProperties: false },
);
export type PayrollRunSummary = Static<typeof PayrollRunSummarySchema>;

/**
 * One employee's payslip for one month.
 *
 * Both halves of every contribution are here. The employer's shares are
 * NOT deducted from the employee — the net is the gross less the four
 * employee-side heads and nothing else — but a payroll screen that
 * showed only the employee's side could not tell an operator what the
 * organisation owes the EPFO and the ESIC this month, which is the
 * figure the remittance is made for.
 */
const PayrollRunLineSchema = Type.Object(
  {
    id: UuidSchema,
    employeeId: UuidSchema,
    employeeCode: Type.String(),
    employeeName: Type.String(),

    calendarDays: Type.Integer(),
    lopDays: Type.String(),
    paidDays: Type.String(),

    basic: NonNegativeMoneyStringSchema,
    dearnessAllowance: NonNegativeMoneyStringSchema,
    houseRentAllowance: NonNegativeMoneyStringSchema,
    otherAllowances: NonNegativeMoneyStringSchema,
    grossEarnings: NonNegativeMoneyStringSchema,

    pfWages: NonNegativeMoneyStringSchema,
    epfEmployee: NonNegativeMoneyStringSchema,
    epfEmployer: NonNegativeMoneyStringSchema,
    epsEmployer: NonNegativeMoneyStringSchema,

    esiCovered: Type.Boolean(),
    esiEmployee: NonNegativeMoneyStringSchema,
    esiEmployer: NonNegativeMoneyStringSchema,

    professionalTax: NonNegativeMoneyStringSchema,

    taxRegime: TaxRegimeSchema,
    projectedAnnualIncome: NonNegativeMoneyStringSchema,
    projectedAnnualTax: NonNegativeMoneyStringSchema,
    tds: NonNegativeMoneyStringSchema,

    netPay: NonNegativeMoneyStringSchema,

    /** The payments-workspace request the finalise raised, once there is
     * one. Null on a draft line and on a cancelled run. */
    paymentRequestId: Type.Union([UuidSchema, Type.Null()]),
    paymentRequestNumber: Type.Union([Type.String(), Type.Null()]),
    paymentRequestStatus: Type.Union([Type.String(), Type.Null()]),
  },
  { additionalProperties: false },
);
export type PayrollRunLine = Static<typeof PayrollRunLineSchema>;

/**
 * One statutory parameter as it stood on the run's month.
 *
 * Shown on the run so an operator — and the practitioner signing the
 * arithmetic off — can read what the figures were computed against
 * without opening the database. It is a projection of the run's own
 * inputs, not a second copy of the schedule: nothing writes back through
 * it, and the product has no screen that edits a notification.
 */
const PayrollStatutoryBasisSchema = Type.Object(
  {
    parameter: Type.String(),
    value: Type.String(),
    effectiveFrom: DateOnlySchema,
    notification: Type.String(),
  },
  { additionalProperties: false },
);
export type PayrollStatutoryBasis = Static<typeof PayrollStatutoryBasisSchema>;

/** Flat, for the reason `CreateEmployeeSchema` above gives. */
const PayrollRunSchema = Type.Object(
  {
    ...PayrollRunSummarySchema.properties,
    lines: Type.Array(PayrollRunLineSchema),
    /** Employer-side totals, summed in SQL. What the organisation
     * remits, as against what it deducts. */
    totalEpfEmployee: NonNegativeMoneyStringSchema,
    totalEpfEmployer: NonNegativeMoneyStringSchema,
    totalEpsEmployer: NonNegativeMoneyStringSchema,
    totalEsiEmployee: NonNegativeMoneyStringSchema,
    totalEsiEmployer: NonNegativeMoneyStringSchema,
    totalProfessionalTax: NonNegativeMoneyStringSchema,
    totalTds: NonNegativeMoneyStringSchema,
    statutoryBasis: Type.Array(PayrollStatutoryBasisSchema),
  },
  { additionalProperties: false },
);
export type PayrollRun = Static<typeof PayrollRunSchema>;

export const PayrollRunResponseSchema = Type.Object(
  { run: PayrollRunSchema },
  { additionalProperties: false },
);
export type PayrollRunResponse = Static<typeof PayrollRunResponseSchema>;

export const PayrollRunListResponseSchema = Type.Object(
  {
    runs: Type.Array(PayrollRunSummarySchema),
    nextCursor: Type.Union([UuidSchema, Type.Null()]),
  },
  { additionalProperties: false },
);
export type PayrollRunListResponse = Static<typeof PayrollRunListResponseSchema>;

export const OpenPayrollRunSchema = Type.Object(
  {
    /** Any date inside the month being paid; the server takes its first
     * day. A client sending the first day already is the ordinary case
     * and costs nothing. */
    periodMonth: DateOnlySchema,
  },
  { additionalProperties: false },
);
export type OpenPayrollRun = Static<typeof OpenPayrollRunSchema>;

export const SetPayrollLineLopSchema = Type.Object(
  {
    /** Loss-of-pay days, to a half day. The one figure a payroll clerk
     * states rather than the product deriving it — there is no
     * attendance subsystem behind this, deliberately, and
     * `docs/UX.md` § 15 records why. */
    lopDays: Type.String({ pattern: '^(?:0|[1-9]\\d?)(?:\\.\\d{1,2})?$' }),
  },
  { additionalProperties: false },
);
export type SetPayrollLineLop = Static<typeof SetPayrollLineLopSchema>;

export const CancelPayrollRunSchema = Type.Object(
  { reason: nonBlankString({ minLength: 3, maxLength: 500 }) },
  { additionalProperties: false },
);
export type CancelPayrollRun = Static<typeof CancelPayrollRunSchema>;
