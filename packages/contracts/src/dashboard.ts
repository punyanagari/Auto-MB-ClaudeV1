import { Type, type Static } from '@sinclair/typebox';
import { DecimalStringSchema, UuidSchema } from './primitives.js';

/** One actionable item on the dashboard, ordered most urgent first. */
export const DashboardAlertSchema = Type.Object(
  {
    kind: Type.Union([
      Type.Literal('instrument_expired'),
      Type.Literal('instrument_expiring'),
      Type.Literal('loa_review_pending'),
      Type.Literal('challan_draft_open'),
      Type.Literal('bill_unpaid'),
      Type.Literal('pbg_missing'),
      Type.Literal('pbg_undervalue'),
      Type.Literal('pbg_window_missed'),
    ]),
    severity: Type.Union([
      Type.Literal('danger'),
      Type.Literal('warning'),
      Type.Literal('notice'),
    ]),
    message: Type.String({ minLength: 1, maxLength: 500 }),
    workId: Type.Union([UuidSchema, Type.Null()]),
    workCode: Type.Union([Type.String(), Type.Null()]),
    /** Days until the referenced due date; negative when overdue. */
    dueInDays: Type.Union([Type.Integer(), Type.Null()]),
  },
  { additionalProperties: false },
);
export type DashboardAlert = Static<typeof DashboardAlertSchema>;

export const DashboardWorkProgressSchema = Type.Object(
  {
    workId: UuidSchema,
    workCode: Type.String(),
    title: Type.String(),
    status: Type.Union([
      Type.Literal('active'),
      Type.Literal('completed'),
      Type.Literal('cancelled'),
    ]),
    contractValue: DecimalStringSchema,
    /** Value of goods on issued (non-cancelled) challans, exact SQL sum. */
    deliveredValue: DecimalStringSchema,
    /** Value measured into the MB and swept into bills. */
    billedValue: DecimalStringSchema,
    issuedChallans: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);
export type DashboardWorkProgress = Static<typeof DashboardWorkProgressSchema>;

export const DashboardResponseSchema = Type.Object(
  {
    totals: Type.Object(
      {
        works: Type.Integer({ minimum: 0 }),
        contractValue: DecimalStringSchema,
        deliveredValue: DecimalStringSchema,
        billedValue: DecimalStringSchema,
        openDrafts: Type.Integer({ minimum: 0 }),
        loaAwaitingReview: Type.Integer({ minimum: 0 }),
      },
      { additionalProperties: false },
    ),
    alerts: Type.Array(DashboardAlertSchema),
    works: Type.Array(DashboardWorkProgressSchema),
  },
  { additionalProperties: false },
);
export type DashboardResponse = Static<typeof DashboardResponseSchema>;
