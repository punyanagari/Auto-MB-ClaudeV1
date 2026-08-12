import { Type, type Static } from '@sinclair/typebox';

const ExportRowSchema = Type.Record(Type.String(), Type.Unknown());
const ExportRowsSchema = Type.Array(ExportRowSchema);

export const ExportObjectManifestEntrySchema = Type.Object(
  {
    kind: Type.String(),
    objectKey: Type.String(),
    sha256: Type.Union([Type.String(), Type.Null()]),
  },
  { additionalProperties: false },
);

/** Portable owner-only tenant record. Row keys intentionally mirror database
 * column names so export additions never silently discard evidence. */
export const OrganisationExportSchema = Type.Object(
  {
    exportedAt: Type.String({ format: 'date-time' }),
    formatVersion: Type.Literal('export-v8'),
    organisation: Type.Union([ExportRowSchema, Type.Null()]),
    members: ExportRowsSchema,
    workAssignments: ExportRowsSchema,
    works: ExportRowsSchema,
    workSchedules: ExportRowsSchema,
    workItems: ExportRowsSchema,
    loaDocuments: ExportRowsSchema,
    deliveryChallans: ExportRowsSchema,
    deliveryChallanItems: ExportRowsSchema,
    challanReceipts: ExportRowsSchema,
    challanItemSerials: ExportRowsSchema,
    issueChallans: ExportRowsSchema,
    issueChallanLines: ExportRowsSchema,
    workInstruments: ExportRowsSchema,
    extensionRequests: ExportRowsSchema,
    mbEntries: ExportRowsSchema,
    bills: ExportRowsSchema,
    installations: ExportRowsSchema,
    installationSerials: ExportRowsSchema,
    approvalRequests: ExportRowsSchema,
    correctionNotices: ExportRowsSchema,
    paymentMatrices: ExportRowsSchema,
    pacCertificates: ExportRowsSchema,
    pacCertificateItems: ExportRowsSchema,
    measurementBooks: ExportRowsSchema,
    measurementBookLines: ExportRowsSchema,
    mbSources: ExportRowsSchema,
    measurementBookMergeProvenance: ExportRowsSchema,
    importBatches: ExportRowsSchema,
    importRecords: ExportRowsSchema,
    contacts: ExportRowsSchema,
    workConsignees: ExportRowsSchema,
    locationMasters: ExportRowsSchema,
    unitMasters: ExportRowsSchema,
    organisationSignatories: ExportRowsSchema,
    purchaseOrders: ExportRowsSchema,
    purchaseOrderLines: ExportRowsSchema,
    budgetaryQuotations: ExportRowsSchema,
    budgetaryQuotationLines: ExportRowsSchema,
    taxInvoices: ExportRowsSchema,
    taxInvoiceRenders: ExportRowsSchema,
    ewayBills: ExportRowsSchema,
    documentNumberSeries: ExportRowsSchema,
    statutoryProviderOperations: ExportRowsSchema,
    deliveryChallanCounters: ExportRowsSchema,
    billCounters: ExportRowsSchema,
    extensionRequestCounters: ExportRowsSchema,
    issueChallanCounters: ExportRowsSchema,
    correctionNoticeCounters: ExportRowsSchema,
    measurementBookCounters: ExportRowsSchema,
    purchaseOrderCounters: ExportRowsSchema,
    budgetaryQuotationCounters: ExportRowsSchema,
    taxInvoiceCounters: ExportRowsSchema,
    objectManifest: Type.Array(ExportObjectManifestEntrySchema),
    auditEvents: ExportRowsSchema,
  },
  { additionalProperties: false },
);

export type OrganisationExport = Static<typeof OrganisationExportSchema>;
