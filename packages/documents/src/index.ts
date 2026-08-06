export interface IssuedDocumentEnvelope<TSnapshot> {
  readonly documentType: string;
  readonly documentNumber: string;
  readonly templateVersion: string;
  readonly issuedAt: string;
  readonly snapshot: TSnapshot;
}

export interface RenderedDocument {
  readonly mediaType: 'application/pdf';
  readonly sha256: string;
  readonly bytes: Uint8Array;
}

/**
 * Rendering remains deterministic: callers provide an immutable snapshot and
 * explicit template version. No master-data lookup is permitted here.
 */
export type DocumentRenderer<TSnapshot> = (
  envelope: IssuedDocumentEnvelope<TSnapshot>,
) => Promise<RenderedDocument>;
