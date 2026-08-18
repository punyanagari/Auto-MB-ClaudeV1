import { Type, type Static } from '@sinclair/typebox';
import { PaymentMatrixCategorySchema } from './payment.js';
import { UuidSchema } from './primitives.js';
import {
  PdfSignatureReportSchema,
  StoredPdfSignatureStatusSchema,
} from './pdf-signature.js';

const CONTRACT_SOURCE_DOCUMENT_KINDS = [
  'nit',
  'contract_agreement',
  'tender_specification',
] as const;

const ContractSourceDocumentKindSchema = Type.Union(
  CONTRACT_SOURCE_DOCUMENT_KINDS.map((kind) => Type.Literal(kind)),
);
export type ContractSourceDocumentKind = Static<
  typeof ContractSourceDocumentKindSchema
>;

export const ContractSourceUploadQuerySchema = Type.Object(
  {
    kind: ContractSourceDocumentKindSchema,
    filename: Type.String({ minLength: 1, maxLength: 255 }),
  },
  { additionalProperties: false },
);

const ContractSourceIdentityMatchSchema = Type.Object(
  {
    matched: Type.Literal(true),
    tenderNumberMatched: Type.Literal(true),
    workDescriptionMatched: Type.Literal(true),
    expectedTenderNumber: Type.String(),
    extractedTenderNumber: Type.String(),
    expectedWorkDescription: Type.String(),
    extractedWorkDescription: Type.String(),
    reasons: Type.Array(Type.String(), { maxItems: 0 }),
  },
  { additionalProperties: false },
);
export type ContractSourceIdentityMatch = Static<
  typeof ContractSourceIdentityMatchSchema
>;

const ContractSourceDocumentSchema = Type.Object(
  {
    id: UuidSchema,
    parentLoaDocumentId: UuidSchema,
    kind: ContractSourceDocumentKindSchema,
    originalFilename: Type.String(),
    sha256: Type.String({ pattern: '^[0-9a-f]{64}$' }),
    sizeBytes: Type.Integer({ minimum: 1 }),
    identityMatch: ContractSourceIdentityMatchSchema,
    confirmedWorkId: Type.Union([UuidSchema, Type.Null()]),
    createdAt: Type.String({ format: 'date-time' }),
    /** Digital-signature verdict recorded when these bytes were accepted
     * (migration 0060). A tender document or contract agreement arriving
     * from IREPS is signed the same way an LOA is, so it earns the same
     * evidence. */
    signatureStatus: StoredPdfSignatureStatusSchema,
    signatureVerdict: Type.Union([PdfSignatureReportSchema, Type.Null()]),
  },
  { additionalProperties: false },
);
export type ContractSourceDocument = Static<typeof ContractSourceDocumentSchema>;

const OptionalPercentageSchema = Type.Union([
  Type.String({
    pattern: '^(?:100(?:\\.0{1,2})?|0(?:\\.\\d{1,2})?|[1-9]\\d?(?:\\.\\d{1,2})?)$',
  }),
  Type.Null(),
]);

const TenderPaymentMatrixEvidenceSchema = Type.Object(
  {
    sourceDocumentId: UuidSchema,
    sourceFilename: Type.String(),
    category: PaymentMatrixCategorySchema,
    pctSupply: OptionalPercentageSchema,
    pctInstallation: OptionalPercentageSchema,
    pctPac: OptionalPercentageSchema,
    pctFinalBill: OptionalPercentageSchema,
    rawBlock: Type.String(),
    needsReview: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type TenderPaymentMatrixEvidence = Static<
  typeof TenderPaymentMatrixEvidenceSchema
>;

const TenderPeriodEvidenceSchema = Type.Object(
  {
    sourceDocumentId: UuidSchema,
    sourceFilename: Type.String(),
    kind: Type.Union([Type.Literal('maintenance'), Type.Literal('warranty')]),
    durationValue: Type.Union([Type.String(), Type.Null()]),
    durationUnit: Type.Union([
      Type.Literal('day'),
      Type.Literal('month'),
      Type.Literal('year'),
      Type.Null(),
    ]),
    scope: Type.Union([Type.Literal('work'), Type.Literal('item')]),
    itemReferences: Type.Array(Type.String()),
    mappedWorkItemIds: Type.Array(UuidSchema),
    rawBlock: Type.String(),
    needsReview: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type TenderPeriodEvidence = Static<typeof TenderPeriodEvidenceSchema>;

const TenderReleaseClauseEvidenceSchema = Type.Object(
  {
    sourceDocumentId: UuidSchema,
    sourceFilename: Type.String(),
    kind: Type.Union([Type.Literal('pbg'), Type.Literal('security_deposit')]),
    rawBlock: Type.String(),
    needsReview: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type TenderReleaseClauseEvidence = Static<
  typeof TenderReleaseClauseEvidenceSchema
>;

const TenderItemSpecificationEvidenceSchema = Type.Object(
  {
    sourceDocumentId: UuidSchema,
    sourceFilename: Type.String(),
    itemReferences: Type.Array(Type.String(), { minItems: 1 }),
    mappedWorkItemIds: Type.Array(UuidSchema),
    specification: Type.String(),
    rawBlock: Type.String(),
    needsReview: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type TenderItemSpecificationEvidence = Static<
  typeof TenderItemSpecificationEvidenceSchema
>;

export const ContractSourceContextSchema = Type.Object(
  {
    documents: Type.Array(ContractSourceDocumentSchema),
    paymentMatrix: Type.Array(TenderPaymentMatrixEvidenceSchema),
    periods: Type.Array(TenderPeriodEvidenceSchema),
    releaseClauses: Type.Array(TenderReleaseClauseEvidenceSchema),
    itemSpecifications: Type.Array(TenderItemSpecificationEvidenceSchema),
  },
  { additionalProperties: false },
);
export type ContractSourceContext = Static<typeof ContractSourceContextSchema>;

export const ContractSourceUploadResponseSchema = Type.Object(
  {
    document: ContractSourceDocumentSchema,
    context: ContractSourceContextSchema,
  },
  { additionalProperties: false },
);
export type ContractSourceUploadResponse = Static<
  typeof ContractSourceUploadResponseSchema
>;
