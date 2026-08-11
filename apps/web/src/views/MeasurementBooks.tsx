import { useCallback, useEffect, useState } from 'react';
import type {
  Challan,
  Contact,
  Installation,
  MbSourceRef,
  MbSourceType,
  MeasurementBook,
  MeasurementBookDetailResponse,
  MeasurementBookKind,
  PacCertificate,
} from '@auto-mb/contracts';
import {
  existingRecordIdOf,
  formValue,
  RequestFailedError,
  type ApiClient,
} from '../api.js';
import { formatInr } from '../format.js';
import { Button } from '../ui/button.js';
import { StatusChip } from '../ui/chip.js';
import { DataTable, numericCell, wrapCell } from '../ui/table.js';
import { Field, Actions, FormError, Hint } from '../ui/form.js';
import { Disclosure } from '../ui/disclosure.js';

interface MeasurementBooksProps {
  readonly api: ApiClient;
  readonly organisationId: string;
  readonly workId: string;
  /** Draft lifecycle (create, select sources, delete) runs under
   * owner/office. */
  readonly canModify: boolean;
  /** Finalize and bill preparation are financial acts under the issue
   * authority â€” the server is the arbiter, this only decides what to
   * offer. */
  readonly canIssue: boolean;
  /** Existing bills must be known before offering another financial record. */
  readonly canPrepareBill: boolean;
  /** Cancelling a finalized MB runs under the cancel authority
   * (membership.canCancelDocuments), matching the challan detail
   * screens. */
  readonly canCancel: boolean;
  /** Lets the Work page refresh its Bills section once a bill is
   * prepared from a finalized MB. */
  readonly onBillPrepared: () => void;
}

function openPdf(blob: Blob) {
  const url = URL.createObjectURL(blob);
  window.open(url, '_blank', 'noopener');
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 60_000);
}

function sourceKey(sourceType: MbSourceType, sourceId: string): string {
  return `${sourceType}:${sourceId}`;
}

/** Details shape of the MB_SOURCE_ALREADY_BILLED 409. */
interface SourceConflictDetails {
  readonly sourceType?: MbSourceType;
  readonly sourceId?: string;
  readonly holdingMbNumber?: string | null;
  readonly holdingMeasurementBookId?: string;
}

interface SourceCandidate {
  readonly sourceType: MbSourceType;
  readonly sourceId: string;
  readonly label: string;
}

const KIND_LABELS: Record<MeasurementBookKind, string> = {
  on_account: 'on-account',
  record: 'record',
  final: 'final',
};

/**
 * The stage-wise Measurement Book workspace (Milestone 8; ADR-0006,
 * spec Â§5.9): draft an MB against the Work's open sources (issued
 * delivery challans, recorded installations, recorded PACs), preview
 * the computed stage deltas/amounts/remarks live, finalize into a
 * numbered immutable snapshot, prepare the bill from it, and render the
 * MB document PDF. Drafts stream a DRAFT-watermarked preview PDF;
 * finalized MBs render a persisted one.
 */
export function MeasurementBooks({
  api,
  organisationId,
  workId,
  canModify,
  canIssue,
  canPrepareBill,
  canCancel,
  onBillPrepared,
}: MeasurementBooksProps) {
  const [books, setBooks] = useState<readonly MeasurementBook[] | null>(null);
  const [detail, setDetail] = useState<MeasurementBookDetailResponse | null>(null);
  const [candidates, setCandidates] = useState<readonly SourceCandidate[] | null>(null);
  const [selection, setSelection] = useState<ReadonlySet<string>>(new Set());
  const [claimedElsewhere, setClaimedElsewhere] = useState<ReadonlyMap<string, string>>(
    new Map(),
  );
  /** The Work's consignees: the pick list for a record MB's author, and
   * the names the record-draft rows carry. */
  const [consignees, setConsignees] = useState<readonly Contact[]>([]);
  /** Controlled so the consignee field can appear the moment 'record' is
   * chosen, before anything is submitted. */
  const [createKind, setCreateKind] = useState<MeasurementBookKind>('on_account');
  /** Record draft ids checked for the next merge. */
  const [mergeSelection, setMergeSelection] = useState<ReadonlySet<string>>(new Set());
  const [existingDraftId, setExistingDraftId] = useState<string | null>(null);
  const [confirmingFinalize, setConfirmingFinalize] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [confirmingUnmerge, setConfirmingUnmerge] = useState(false);
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const [cancelNote, setCancelNote] = useState('');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setBooks(null);
    setDetail(null);
    setLoadError(null);
    api
      .listWorkMeasurementBooks(organisationId, workId)
      .then((loaded) => {
        if (!cancelled) setBooks(loaded.books);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setLoadError(
          cause instanceof RequestFailedError
            ? cause.message
            : 'The Measurement Books could not be loaded.',
        );
      });
    // A convenience read: without it record MBs lose their names and the
    // record kind is not offered, but the books themselves still load.
    api
      .listWorkConsignees(organisationId, workId)
      .then((loaded) => {
        if (!cancelled) setConsignees(loaded);
      })
      .catch(() => {
        // The record option simply is not offered.
      });
    return () => {
      cancelled = true;
    };
  }, [api, organisationId, workId]);

  const act = useCallback(async (work: () => Promise<void>, done: string) => {
    setPending(true);
    setActionError(null);
    setNotice(null);
    try {
      await work();
      setNotice(done);
    } catch (cause) {
      setActionError(
        cause instanceof RequestFailedError
          ? cause.message
          : 'The action failed; nothing was changed.',
      );
      throw cause;
    } finally {
      setPending(false);
    }
  }, []);

  /** act() variant for handlers that follow up after success only. */
  const tryAct = useCallback(
    (work: () => Promise<void>, done: string) => {
      void act(work, done).catch(() => {
        // Surfaced through actionError already.
      });
    },
    [act],
  );

  const refreshList = useCallback(async () => {
    setBooks((await api.listWorkMeasurementBooks(organisationId, workId)).books);
  }, [api, organisationId, workId]);

  const loadCandidates = useCallback(async () => {
    const [challans, installationList, pacList] = await Promise.all([
      api.listChallans(organisationId, workId),
      api.listWorkInstallations(organisationId, workId),
      api.listWorkPacCertificates(organisationId, workId),
    ]);
    const all: SourceCandidate[] = [
      ...challans
        .filter((challan: Challan) => challan.status === 'issued')
        .map((challan) => ({
          sourceType: 'delivery_challan' as const,
          sourceId: challan.id,
          label: `${challan.challanNumber ?? challan.id} Â· ${challan.challanDate}`,
        })),
      ...installationList.installations
        .filter((installation: Installation) => installation.status === 'recorded')
        .map((installation) => ({
          sourceType: 'installation' as const,
          sourceId: installation.id,
          label: `${installation.itemNumber} Ã— ${installation.quantity} Â· ${installation.installedOn} Â· ${installation.locationName}`,
        })),
      ...pacList.certificates
        .filter((certificate: PacCertificate) => certificate.status === 'recorded')
        .map((certificate) => ({
          sourceType: 'pac_certificate' as const,
          sourceId: certificate.id,
          label: `${certificate.reference} Â· ${certificate.issueDate}`,
        })),
    ];
    setCandidates(all);
  }, [api, organisationId, workId]);

  const openBook = useCallback(
    async (measurementBookId: string) => {
      const loaded = await api.getMeasurementBook(organisationId, measurementBookId);
      setDetail(loaded);
      setConfirmingFinalize(false);
      setConfirmingDelete(false);
      setConfirmingUnmerge(false);
      setConfirmingCancel(false);
      setCancelNote('');
      setSelection(
        new Set(
          loaded.sources
            .filter((source) => source.releasedAt === null)
            .map((source) => sourceKey(source.sourceType, source.sourceId)),
        ),
      );
      setClaimedElsewhere(new Map());
      if (loaded.book.status === 'draft' && canModify) {
        await loadCandidates();
      } else {
        setCandidates(null);
      }
    },
    [api, canModify, loadCandidates, organisationId],
  );

  if (loadError !== null) {
    return (
      <>
        <h2>Measurement Books</h2>
        <FormError>{loadError}</FormError>
      </>
    );
  }

  if (books === null) {
    return (
      <>
        <h2>Measurement Books</h2>
        <p className="text-muted-foreground" role="status">
          Loading Measurement Booksâ€¦
        </p>
      </>
    );
  }

  const nextSequence =
    books.reduce((highest, book) => Math.max(highest, book.sequenceNumber ?? 0), 0) + 1;
  const nextNumber = String(nextSequence).padStart(2, '0');
  const liveFinal = books.some((book) => book.isFinal && book.status !== 'cancelled');
  const book = detail?.book ?? null;
  /** A finalized MB always carries its number; the fallback exists only
   * because the shared contract type keeps it nullable for drafts. */
  const mbNumberLabel = book?.mbNumber ?? 'this Measurement Book';
  const consigneeNameById = new Map(
    consignees.map((consignee) => [consignee.id, consignee.designation]),
  );
  const consigneeLabel = (contactId: string | null): string =>
    contactId === null ? 'consignee' : (consigneeNameById.get(contactId) ?? contactId);
  /** How a merged record names its absorber: by number once finalized,
   * as "draft" while it is still one. */
  const absorberLabel = (absorberId: string): string =>
    books.find((candidate) => candidate.id === absorberId)?.mbNumber ?? 'draft';
  const recordDrafts = books.filter(
    (candidate) => candidate.kind === 'record' && candidate.status === 'draft',
  );
  /** The record MBs the OPEN draft absorbed: their existence is what makes
   * it an absorbing draft â€” un-merge is its way apart, delete is refused. */
  const absorbedRecords =
    book === null
      ? []
      : books.filter(
          (candidate) =>
            candidate.status === 'merged' && candidate.mergedIntoId === book.id,
        );

  return (
    <>
      <h2>Measurement Books</h2>
      <p className="text-muted-foreground">
        Stage-wise billing documents built from the Work&apos;s unbilled sources. A
        draft recomputes from live state; finalizing assigns the next gap-free MB number
        and freezes the snapshot; the bill is prepared from the finalized MB.
      </p>
      {actionError !== null && <FormError>{actionError}</FormError>}
      {notice !== null && (
        <p className="text-muted-foreground" role="status">
          {notice}
        </p>
      )}

      {books.length > 0 ? (
        <DataTable>
          <caption className="sr-only">Measurement Books raised on this Work</caption>
          <thead>
            <tr>
              <th scope="col">Number</th>
              <th scope="col">Kind</th>
              <th scope="col">Date</th>
              <th scope="col">Status</th>
              <th scope="col" className={numericCell}>
                Total
              </th>
            </tr>
          </thead>
          <tbody>
            {books.map((row) => {
              const mergedInto = row.mergedIntoId;
              return (
                <tr key={row.id}>
                  <th scope="row">
                    <Button
                      variant="link"
                      size="inline"
                      className="font-medium"
                      onClick={() => {
                        tryAct(
                          async () => {
                            await openBook(row.id);
                          },
                          `Measurement Book ${row.mbNumber ?? 'draft'} opened below.`,
                        );
                      }}
                    >
                      {row.mbNumber ?? 'Draft'}
                    </Button>{' '}
                    {row.isFinal && <StatusChip status="issued">FINAL BILL</StatusChip>}
                  </th>
                  <td>
                    {KIND_LABELS[row.kind]}
                    {row.kind === 'record' && (
                      <span className="text-muted-foreground">
                        {' '}
                        Â· {consigneeLabel(row.consigneeContactId)}
                      </span>
                    )}
                  </td>
                  <td>{row.mbDate}</td>
                  <td>
                    {row.status === 'merged' && mergedInto !== null ? (
                      /* The chip is the row's one live affordance: a merged
                         record's story continues on the draft that absorbed
                         it, so its status links there. */
                      <Button
                        variant="link"
                        size="inline"
                        onClick={() => {
                          tryAct(async () => {
                            await openBook(mergedInto);
                          }, 'The absorbing Measurement Book is opened below.');
                        }}
                      >
                        <StatusChip status="merged">
                          merged into {absorberLabel(mergedInto)}
                        </StatusChip>
                      </Button>
                    ) : (
                      <StatusChip status={row.status} />
                    )}
                  </td>
                  <td className={numericCell}>
                    {row.totalAmount !== null ? formatInr(row.totalAmount) : 'â€”'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </DataTable>
      ) : (
        <p className="text-muted-foreground">No Measurement Books raised yet.</p>
      )}

      {canModify && !liveFinal && (
        <Disclosure label="Create draft" startOpen={books.length === 0}>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const form = event.currentTarget;
              const data = new FormData(form);
              const mbDate = formValue(data, 'mb-draft-date');
              const consigneeContactId = formValue(data, 'mb-draft-consignee');
              const kind = createKind;
              setExistingDraftId(null);
              tryAct(async () => {
                try {
                  const created = await api.createWorkMeasurementBook(
                    organisationId,
                    workId,
                    {
                      mbDate,
            ç¯t¶‰žËkºwµçQ ø(€€€€€€€€€€€€€€€€ð½ÑÈø(€€€€€€€€€€€€€€ð½Ñ¡•…ø(€€€€€€€€€€€€€€ñÑ‰½‘äø(€€€€€€€€€€€€€€€í‘•Ñ…¥°¹±¥¹•Ì¹µ…À ¡±¥¹”¤€ôø€ (€€€€€€€€€€€€€€€€€€ñÑÈ­•äõí±¥¹”¹Ý½É­%Ñ•µ%‘ôø(€€€€€€€€€€€€€€€€€€€€ñÑ Í½Á”ô‰É½Üˆùí±¥¹”¹¥Ñ•µ9Õµ‰•Éôð½Ñ ø(€€€€€€€€€€€€€€€€€€€€ñÑ±…ÍÍ9…µ”õíÝÉ…Á•±±ôùí±¥¹”¹‘•ÍÉ¥ÁÑ¥½¹ôð½Ñø(€€€€€€€€€€€€€€€€€€€€ñÑùí±¥¹”¹Õ¹¥Ñ½‘•ôð½Ñø(€€€€€€€€€€€€€€€€€€€€ñÑ±…ÍÍ9…µ”õí¹Õµ•É¥•±±ôùí±¥¹”¹‘•±Ñ…MÕÁÁ±¥•‘ôð½Ñø(€€€€€€€€€€€€€€€€€€€€ñÑ±…ÍÍ9…µ”õí¹Õµ•É¥•±±ôùí±¥¹”¹‘•±Ñ…%¹ÍÑ…±±•‘ôð½Ñø(€€€€€€€€€€€€€€€€€€€€ñÑ±…ÍÍ9…µ”õí¹Õµ•É¥•±±ôùí±¥¹”¹‘•±Ñ…A…ôð½Ñø(€€€€€€€€€€€€€€€€€€€€ñÑ±…ÍÍ9…µ”õí¹Õµ•É¥•±±ôùí™½Éµ…Ñ%¹È¡±¥¹”¹±¥¹•Q½Ñ…°¥ôð½Ñø(€€€€€€€€€€€€€€€€€€€€ñÑ±…ÍÍ9…µ”õíÝÉ…Á•±±ôùí±¥¹”¹É•µ…É­ôð½Ñø(€€€€€€€€€€€€€€€€€€ð½ÑÈø(€€€€€€€€€€€€€€€€¤¥ô(€€€€€€€€€€€€€€ð½Ñ‰½‘äø(€€€€€€€€€€€€€ì¼¨Q¡”Ñ½Ñ…°‰•±½¹Ì¥¸Ñ¡”™½½ÐÍ¼¥Ð¥Ì…¹¹½Õ¹•…ÌÑ¡”(€€€€€€€€€€€€€€€€€Ñ…‰±”ÌÍÕµµ…ÉäÉ…Ñ¡•ÈÑ¡…¸…Ì½¹”µ½É”‘…Ñ„É½Ü¸Q¡¥Ì(€€€€€€€€€€€€€€€€€ÍÉ••¸¥Ì¹½ÐÝ¡…Ð•ÑÌÁÉ¥¹Ñ•ƒŠPÑ¡”5A¥ÌÉ•¹‘•É•(€€€€€€€€€€€€€€€€€Í•ÉÙ•ÈµÍ¥‘”™É½´¥ÑÌ½Ý¸Ñ•µÁ±…Ñ”ƒŠP…¹Ñ¡”Í•ÉÙ•ÈÍÑ…åÌ(€€€€€€€€€€€€€€€€€…ÕÑ¡½É¥Ñ…Ñ¥Ù”™½ÈÑ¡”™¥ÕÉ”¥ÑÍ•±˜¸€¨½ô(€€€€€€€€€€€€€€ñÑ™½½Ðø(€€€€€€€€€€€€€€€€ñÑÈø(€€€€€€€€€€€€€€€€€€ñÑ Í½Á”ô‰É½Üˆ½±MÁ…¸õìÙôø(€€€€€€€€€€€€€€€€€€€Q½Ñ…°Á…å…‰±”Ñ¡¥Ì5(€€€€€€€€€€€€€€€€€€ð½Ñ ø(€€€€€€€€€€€€€€€€€€ñÑ±…ÍÍ9…µ”õí¹Õµ•É¥•±±ôø(€€€€€€€€€€€€€€€€€€€€ñÍÑÉ½¹œø(€€€€€€€€€€€€€€€€€€€€€í‘•Ñ…¥°¹ÁÉ•Ù¥•ÝQ½Ñ…°€„ôô¹Õ±°(€€€€€€€€€€€€€€€€€€€€€€€€ü™½Éµ…Ñ%¹È¡‘•Ñ…¥°¹ÁÉ•Ù¥•ÝQ½Ñ…°¤(€€€€€€€€€€€€€€€€€€€€€€€€è€ŸŠPô(€€€€€€€€€€€€€€€€€€€€ð½ÍÑÉ½¹œø(€€€€€€€€€€€€€€€€€€ð½Ñø(€€€€€€€€€€€€€€€€€€ñÑøð½Ñø(€€€€€€€€€€€€€€€€ð½ÑÈø(€€€€€€€€€€€€€€ð½Ñ™½½Ðø(€€€€€€€€€€€€ð½…Ñ…Q…‰±”ø(€€€€€€€€€€¤€è€ (€€€€€€€€€€€€ñÀ±…ÍÍ9…µ”ô‰Ñ•áÐµµÕÑ•µ™½É•É½Õ¹ˆø(€€€€€€€€€€€€€9½Ñ¡¥¹œÑ¼‰¥±°å•ÐƒŠPÍ•±•ÐÍ½ÕÉ•ÌÝ¥Ñ Õ¹‰¥±±•ÅÕ…¹Ñ¥Ñ¥•Ì¸(€€€€€€€€€€€€ð½Àø(€€€€€€€€€€¥ô((€€€€€€€€€€ñÑ¥½¹Ìø(€€€€€€€€€€€í‰½½¬¹ÍÑ…ÑÕÌ€ôôô€‘É…™Ðœ€˜˜€ (€€€€€€€€€€€€€€ñ	ÕÑÑ½¸(€€€€€€€€€€€€€€€Ù…É¥…¹Ðô‰½ÕÑ±¥¹”ˆ(€€€€€€€€€€€€€€€‘¥Í…‰±•õíÁ•¹‘¥¹ô(€€€€€€€€€€€€€€€½¹±¥¬õì ¤€ôøì(€€€€€€€€€€€€€€€€€ÑÉåÐ¡…Íå¹Œ€ ¤€ôøì(€€€€€€€€€€€€€€€€€€€½Á•¹A‘˜ (€€€€€€€€€€€€€€€€€€€€€…Ý…¥Ð…Á¤¹‘½Ý¹±½…‘5•…ÍÕÉ•µ•¹Ñ	½½­É…™ÑAÉ•Ù¥•Ü (€€€€€€€€€€€€€€€€€€€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€€€€€€€€€€€€€€€€€€€€€‰½½¬¹¥°(€€€€€€€€€€€€€€€€€€€€€€¤°(€€€€€€€€€€€€€€€€€€€€¤ì(€€€€€€€€€€€€€€€€€ô°€É…™ÐÁÉ•Ù¥•ÜA½Á•¹•¥¸„¹•ÜÑ…ˆ€¡Ý…Ñ•Éµ…É­•IPì¹½Ñ¡¥¹œ¥ÌÍÑ½É•¤¸œ¤ì(€€€€€€€€€€€€€€€õô(€€€€€€€€€€€€€€ø(€€€€€€€€€€€€€€€AÉ•Ù¥•ÜA€¡‘É…™Ð¤(€€€€€€€€€€€€€€ð½	ÕÑÑ½¸ø(€€€€€€€€€€€€¥ô(€€€€€€€€€€€ì¼¨É•½É5¹•Ù•È™¥¹…±¥é•ÌƒŠP¥Ðµ•É•Ì½È¥Ì‘•±•Ñ•ƒŠPÍ¼(€€€€€€€€€€€€€€€Ñ¡”½™™•ÈÝ½Õ±½¹±ä•Ù•È‰”„É•™ÕÍ…°¸€¨½ô(€€€€€€€€€€€í‰½½¬¹ÍÑ…ÑÕÌ€ôôô€‘É…™Ðœ€˜˜(€€€€€€€€€€€€€…¹%ÍÍÕ”€˜˜(€€€€€€€€€€€€€‰½½¬¹­¥¹€„ôô€É•½Éœ€˜˜(€€€€€€€€€€€€€€…½¹™¥Éµ¥¹¥¹…±¥é”€˜˜€ (€€€€€€€€€€€€€€€€ñ	ÕÑÑ½¸(€€€€€€€€€€€€€€€€€‘¥Í…‰±•õíÁ•¹‘¥¹ô(€€€€€€€€€€€€€€€€€½¹±¥¬õì ¤€ôøì(€€€€€€€€€€€€€€€€€€€Í•Ñ½¹™¥Éµ¥¹•±•Ñ”¡™…±Í”¤ì(€€€€€€€€€€€€€€€€€€€Í•Ñ½¹™¥Éµ¥¹U¹µ•É”¡™…±Í”¤ì(€€€€€€€€€€€€€€€€€€€Í•Ñ½¹™¥Éµ¥¹¥¹…±¥é”¡ÑÉÕ”¤ì(€€€€€€€€€€€€€€€€€õô(€€€€€€€€€€€€€€€€ø(€€€€€€€€€€€€€€€€€¥¹…±¥é—Š˜(€€€€€€€€€€€€€€€€ð½	ÕÑÑ½¸ø(€€€€€€€€€€€€€€¥ô(€€€€€€€€€€€ì¼¨¸…‰Í½É‰¥¹œ‘É…™Ð…¹¹½Ð‰”‘•±•Ñ•€¡Ñ¡”Í•ÉÙ•ÈÉ•™ÕÍ•ÌÝ¥Ñ (€€€€€€€€€€€€€€€5	}!M}5I}I=IL¤ìÕ¸µµ•É”¥Ì¥ÑÌÝ…ä…Á…ÉÐ¸€¨½ô(€€€€€€€€€€€í‰½½¬¹ÍÑ…ÑÕÌ€ôôô€‘É…™Ðœ€˜˜(€€€€€€€€€€€€€…¹5½‘¥™ä€˜˜(€€€€€€€€€€€€€…‰Í½É‰•‘I•½É‘Ì¹±•¹Ñ €ôôô€À€˜˜(€€€€€€€€€€€€€€…½¹™¥Éµ¥¹•±•Ñ”€˜˜€ (€€€€€€€€€€€€€€€€ñ	ÕÑÑ½¸(€€€€€€€€€€€€€€€€€Ù…É¥…¹Ðô‰½ÕÑ±¥¹”ˆ(€€€€€€€€€€€€€€€€€‘¥Í…‰±•õíÁ•¹‘¥¹ô(€€€€€€€€€€€€€€€€€½¹±¥¬õì ¤€ôøì(€€€€€€€€€€€€€€€€€€€Í•Ñ½¹™¥Éµ¥¹¥¹…±¥é”¡™…±Í”¤ì(€€€€€€€€€€€€€€€€€€€Í•Ñ½¹™¥Éµ¥¹U¹µ•É”¡™…±Í”¤ì(€€€€€€€€€€€€€€€€€€€Í•Ñ½¹™¥Éµ¥¹•±•Ñ”¡ÑÉÕ”¤ì(€€€€€€€€€€€€€€€€€õô(€€€€€€€€€€€€€€€€ø(€€€€€€€€€€€€€€€€€•±•Ñ”‘É…™ÓŠ˜(€€€€€€€€€€€€€€€€ð½	ÕÑÑ½¸ø(€€€€€€€€€€€€€€¥ô(€€€€€€€€€€€í‰½½¬¹ÍÑ…ÑÕÌ€ôôô€‘É…™Ðœ€˜˜(€€€€€€€€€€€€€…¹5½‘¥™ä€˜˜(€€€€€€€€€€€€€…‰Í½É‰•‘I•½É‘Ì¹±•¹Ñ €ø€À€˜˜(€€€€€€€€€€€€€€…½¹™¥Éµ¥¹U¹µ•É”€˜˜€ (€€€€€€€€€€€€€€€€ñ	ÕÑÑ½¸(€€€€€€€€€€€€€€€€€Ù…É¥…¹Ðô‰½ÕÑ±¥¹”ˆ(€€€€€€€€€€€€€€€€€‘¥Í…‰±•õíÁ•¹‘¥¹ô(€€€€€€€€€€€€€€€€€½¹±¥¬õì ¤€ôøì(€€€€€€€€€€€€€€€€€€€Í•Ñ½¹™¥Éµ¥¹¥¹…±¥é”¡™…±Í”¤ì(€€€€€€€€€€€€€€€€€€€Í•Ñ½¹™¥Éµ¥¹•±•Ñ”¡™…±Í”¤ì(€€€€€€€€€€€€€€€€€€€Í•Ñ½¹™¥Éµ¥¹U¹µ•É”¡ÑÉÕ”¤ì(€€€€€€€€€€€€€€€€€õô(€€€€€€€€€€€€€€€€ø(€€€€€€€€€€€€€€€€€U¹µ•É”É•½É‘É…™ÑÏŠ˜(€€€€€€€€€€€€€€€€ð½	ÕÑÑ½¸ø(€€€€€€€€€€€€€€¥ô(€€€€€€€€€€€í‰½½¬¹ÍÑ…ÑÕÌ€ôôô€™¥¹…±¥é•œ€˜˜(€€€€€€€€€€€€€…¹%ÍÍÕ”€˜˜(€€€€€€€€€€€€€…¹AÉ•Á…É•	¥±°€˜˜(€€€€€€€€€€€€€‰½½¬¹‰¥±±%€ôôô¹Õ±°€˜˜€ (€€€€€€€€€€€€€€€€ñ	ÕÑÑ½¸(€€€€€€€€€€€€€€€€€‘¥Í…‰±•õíÁ•¹‘¥¹ô(€€€€€€€€€€€€€€€€€½¹±¥¬õì ¤€ôøì(€€€€€€€€€€€€€€€€€€€ÑÉåÐ¡…Íå¹Œ€ ¤€ôøì(€€€€€€€€€€€€€€€€€€€€€…Ý…¥Ð…Á¤¹ÁÉ•Á…É•	¥±±É½µ5•…ÍÕÉ•µ•¹Ñ	½½¬¡½É…¹¥Í…Ñ¥½¹%°‰½½¬¹¥¤ì(€€€€€€€€€€€€€€€€€€€€€…Ý…¥Ð½Á•¹	½½¬¡‰½½¬¹¥¤ì(€€€€€€€€€€€€€€€€€€€€€…Ý…¥ÐÉ•™É•Í¡1¥ÍÐ ¤ì(€€€€€€€€€€€€€€€€€€€€€½¹	¥±±AÉ•Á…É• ¤ì(€€€€€€€€€€€€€€€€€€€ô°€	¥±°ÁÉ•Á…É•™É½´Ñ¡¥Ì5•…ÍÕÉ•µ•¹Ð	½½¬ƒŠPÍ•”Ñ¡”	¥±±ÌÍ•Ñ¥½¸¸œ¤ì(€€€€€€€€€€€€€€€€€õô(€€€€€€€€€€€€€€€€ø(€€€€€€€€€€€€€€€€€AÉ•Á…É”‰¥±°(€€€€€€€€€€€€€€€€ð½	ÕÑÑ½¸ø(€€€€€€€€€€€€€€¥ô(€€€€€€€€€€€í‰½½¬¹ÍÑ…ÑÕÌ€ôôô€™¥¹…±¥é•œ€˜˜…¹5½‘¥™ä€˜˜€ (€€€€€€€€€€€€€€ñ	ÕÑÑ½¸(€€€€€€€€€€€€€€€Ù…É¥…¹Ðô‰½ÕÑ±¥¹”ˆ(€€€€€€€€€€€€€€€‘¥Í…‰±•õíÁ•¹‘¥¹ô(€€€€€€€€€€€€€€€½¹±¥¬õì ¤€ôøì(€€€€€€€€€€€€€€€€€ÑÉåÐ¡…Íå¹Œ€ ¤€ôøì(€€€€€€€€€€€€€€€€€€€Í•Ñ•Ñ…¥°¡…Ý…¥Ð…Á¤¹É•¹‘•É5•…ÍÕÉ•µ•¹Ñ	½½¬¡½É…¹¥Í…Ñ¥½¹%°‰½½¬¹¥¤¤ì(€€€€€€€€€€€€€€€€€€€…Ý…¥ÐÉ•™É•Í¡1¥ÍÐ ¤ì(€€€€€€€€€€€€€€€€€ô°€5•…ÍÕÉ•µ•¹Ð	½½¬AÉ•¹‘•É•…¹ÍÑ½É•¸œ¤ì(€€€€€€€€€€€€€€€õô(€€€€€€€€€€€€€€ø(€€€€€€€€€€€€€€€í‰½½¬¹É•¹‘•É•‘Ù…¥±…‰±”€ü€I”µÉ•¹‘•ÈAœ€è€I•¹‘•ÈAô(€€€€€€€€€€€€€€ð½	ÕÑÑ½¸ø(€€€€€€€€€€€€¥ô(€€€€€€€€€€€í‰½½¬¹É•¹‘•É•‘Ù…¥±…‰±”€˜˜€ (€€€€€€€€€€€€€€ñ	ÕÑÑ½¸(€€€€€€€€€€€€€€€Ù…É¥…¹Ðô‰½ÕÑ±¥¹”ˆ(€€€€€€€€€€€€€€€‘¥Í…‰±•õíÁ•¹‘¥¹ô(€€€€€€€€€€€€€€€½¹±¥¬õì ¤€ôøì(€€€€€€€€€€€€€€€€€ÑÉåÐ¡…Íå¹Œ€ ¤€ôøì(€€€€€€€€€€€€€€€€€€€½Á•¹A‘˜ (€€€€€€€€€€€€€€€€€€€€€…Ý…¥Ð…Á¤¹‘½Ý¹±½…‘5•…ÍÕÉ•µ•¹Ñ	½½­A‘˜¡½É…¹¥Í…Ñ¥½¹%°‰½½¬¹¥¤°(€€€€€€€€€€€€€€€€€€€€¤ì(€€€€€€€€€€€€€€€€€ô°€5•…ÍÕÉ•µ•¹Ð	½½¬A½Á•¹•¥¸„¹•ÜÑ…ˆ¸œ¤ì(€€€€€€€€€€€€€€€õô(€€€€€€€€€€€€€€ø(€€€€€€€€€€€€€€€=Á•¸A(€€€€€€€€€€€€€€ð½	ÕÑÑ½¸ø(€€€€€€€€€€€€¥ô(€€€€€€€€€€ð½Ñ¥½¹Ìø((€€€€€€€€€í‰½½¬¹ÍÑ…ÑÕÌ€ôôô€‘É…™Ðœ€˜˜(€€€€€€€€€€€…¹%ÍÍÕ”€˜˜(€€€€€€€€€€€‰½½¬¹­¥¹€„ôô€É•½Éœ€˜˜(€€€€€€€€€€€½¹™¥Éµ¥¹¥¹…±¥é”€˜˜€ (€€€€€€€€€€€€€€ñ‘¥Ø±…ÍÍ9…µ”ô‰µä´Ìˆø(€€€€€€€€€€€€€€€€ñ Ðù½¹™¥É´™¥¹…±¥é”ð½ Ðø(€€€€€€€€€€€€€€€€ñÀø(€€€€€€€€€€€€€€€€€¥¹…±¥é¥¹œ™É••é•ÌÑ¡¥Ì5•…ÍÕÉ•µ•¹Ð	½½¬…Ì…¸¥µµÕÑ…‰±”¹Õµ‰•É•(€€€€€€€€€€€€€€€€€Í¹…ÁÍ¡½ÐƒŠP¹•áÐ¹Õµ‰•Èí¹•áÑ9Õµ‰•ÉôƒŠP…¹±…¥µÌ¥ÑÌÍ½ÕÉ•Ì™½È½½¸(€€€€€€€€€€€€€€€€€½¹Ñ¥¹Õ”ü(€€€€€€€€€€€€€€€€ð½Àø(€€€€€€€€€€€€€€€€ñÑ¥½¹Ìø(€€€€€€€€€€€€€€€€€€ñ	ÕÑÑ½¸(€€€€€€€€€€€€€€€€€€€‘¥Í…‰±•õíÁ•¹‘¥¹ô(€€€€€€€€€€€€€€€€€€€½¹±¥¬õì ¤€ôøì(€€€€€€€€€€€€€€€€€€€€€ÑÉåÐ¡…Íå¹Œ€ ¤€ôøì(€€€€€€€€€€€€€€€€€€€€€€€½¹ÍÐ™¥¹…±¥é•€ô…Ý…¥Ð…Á¤¹™¥¹…±¥é•5•…ÍÕÉ•µ•¹Ñ	½½¬ (€€€€€€€€€€€€€€€€€€€€€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€€€€€€€€€€€€€€€€€€€€€€€‰½½¬¹¥°(€€€€€€€€€€€€€€€€€€€€€€€€¤ì(€€€€€€€€€€€€€€€€€€€€€€€Í•Ñ•Ñ…¥°¡™¥¹…±¥é•¤ì(€€€€€€€€€€€€€€€€€€€€€€€Í•Ñ½¹™¥Éµ¥¹¥¹…±¥é”¡™…±Í”¤ì(€€€€€€€€€€€€€€€€€€€€€€€Í•Ñ…¹‘¥‘…Ñ•Ì¡¹Õ±°¤ì(€€€€€€€€€€€€€€€€€€€€€€€…Ý…¥ÐÉ•™É•Í¡1¥ÍÐ ¤ì(€€€€€€€€€€€€€€€€€€€€€ô°€5•…ÍÕÉ•µ•¹Ð	½½¬™¥¹…±¥é•¸œ¤ì(€€€€€€€€€€€€€€€€€€€õô(€€€€€€€€€€€€€€€€€€ø(€€€€€€€€€€€€€€€€€€€¥¹…±¥é”¹½Ü(€€€€€€€€€€€€€€€€€€ð½	ÕÑÑ½¸ø(€€€€€€€€€€€€€€€€€€ñ	ÕÑÑ½¸(€€€€€€€€€€€€€€€€€€€Ù…É¥…¹Ðô‰½ÕÑ±¥¹”ˆ(€€€€€€€€€€€€€€€€€€€‘¥Í…‰±•õíÁ•¹‘¥¹ô(€€€€€€€€€€€€€€€€€€€½¹±¥¬õì ¤€ôøì(€€€€€€€€€€€€€€€€€€€€€Í•Ñ½¹™¥Éµ¥¹¥¹…±¥é”¡™…±Í”¤ì(€€€€€€€€€€€€€€€€€€€õô(€€€€€€€€€€€€€€€€€€ø(€€€€€€€€€€€€€€€€€€€-••À‘É…™Ñ¥¹œ(€€€€€€€€€€€€€€€€€€ð½	ÕÑÑ½¸ø(€€€€€€€€€€€€€€€€ð½Ñ¥½¹Ìø(€€€€€€€€€€€€€€ð½‘¥Øø(€€€€€€€€€€€€¥ô((€€€€€€€€€ì¼¨•±•Ñ¥¹œ¥ÌÑ¡”½¹”Õ¹É•½Ù•É…‰±”‘É…™Ð…Ñ¥½¸°Í¼¥Ð•ÑÌÑ¡”(€€€€€€€€€€€€€Í…µ”ÑÝ¼µÍÑ•ÀÑÉ•…Ñµ•¹Ð…ÌÑ¡”É•½Ù•É…‰±”™¥¹…±¥é”…‰½Ù”¸€¨½ô(€€€€€€€€€í‰½½¬¹ÍÑ…ÑÕÌ€ôôô€‘É…™Ðœ€˜˜…¹5½‘¥™ä€˜˜½¹™¥Éµ¥¹•±•Ñ”€˜˜€ (€€€€€€€€€€€€ñ‘¥Ø±…ÍÍ9…µ”ô‰µä´Ìˆø(€€€€€€€€€€€€€€ñ Ðù½¹™¥É´‘•±•Ñ”ð½ Ðø(€€€€€€€€€€€€€€ñÀø(€€€€€€€€€€€€€€€•±•Ñ¥¹œ‘¥Í…É‘ÌÑ¡¥Ì‘É…™Ð…¹¥ÑÌ±¥¹•Ì™½È½½°…¹É•±•…Í•Ì•Ù•Éä(€€€€€€€€€€€€€€€Í½ÕÉ”¥Ð±…¥µ•ƒŠPÑ¡½Í”¡…±±…¹Ì°¥¹ÍÑ…±±…Ñ¥½¹Ì…¹AÌ‰•½µ”(€€€€€€€€€€€€€€€‰¥±±…‰±”‰ä…¹½Ñ¡•È5•…ÍÕÉ•µ•¹Ð	½½¬……¥¸¸½¹Ñ¥¹Õ”ü(€€€€€€€€€€€€€€ð½Àø(€€€€€€€€€€€€€€ñÑ¥½¹Ìø(€€€€€€€€€€€€€€€€ñ	ÕÑÑ½¸(€€€€€€€€€€€€€€€€€‘¥Í…‰±•õíÁ•¹‘¥¹ô(€€€€€€€€€€€€€€€€€½¹±¥¬õì ¤€ôøì(€€€€€€€€€€€€€€€€€€€ÑÉåÐ¡…Íå¹Œ€ ¤€ôøì(€€€€€€€€€€€€€€€€€€€€€…Ý…¥Ð…Á¤¹‘•±•Ñ•5•…ÍÕÉ•µ•¹Ñ	½½¬¡½É…¹¥Í…Ñ¥½¹%°‰½½¬¹¥¤ì(€€€€€€€€€€€€€€€€€€€€€Í•Ñ•Ñ…¥°¡¹Õ±°¤ì(€€€€€€€€€€€€€€€€€€€€€Í•Ñ½¹™¥Éµ¥¹•±•Ñ”¡™…±Í”¤ì(€€€€€€€€€€€€€€€€€€€€€…Ý…¥ÐÉ•™É•Í¡1¥ÍÐ ¤ì(€€€€€€€€€€€€€€€€€€€ô°€É…™Ð‘•±•Ñ•ì¥ÑÌÍ½ÕÉ”±…¥µÌ…É”É•±•…Í•¸œ¤ì(€€€€€€€€€€€€€€€€€õô(€€€€€€€€€€€€€€€€ø(€€€€€€€€€€€€€€€€€•±•Ñ”‘É…™Ð¹½Ü(€€€€€€€€€€€€€€€€ð½	ÕÑÑ½¸ø(€€€€€€€€€€€€€€€€ñ	ÕÑÑ½¸(€€€€€€€€€€€€€€€€€Ù…É¥…¹Ðô‰½ÕÑ±¥¹”ˆ(€€€€€€€€€€€€€€€€€‘¥Í…‰±•õíÁ•¹‘¥¹ô(€€€€€€€€€€€€€€€€€½¹±¥¬õì ¤€ôøì(€€€€€€€€€€€€€€€€€€€Í•Ñ½¹™¥Éµ¥¹•±•Ñ”¡™…±Í”¤ì(€€€€€€€€€€€€€€€€€õô(€€€€€€€€€€€€€€€€ø(€€€€€€€€€€€€€€€€€-••À‘É…™Ñ¥¹œ(€€€€€€€€€€€€€€€€ð½	ÕÑÑ½¸ø(€€€€€€€€€€€€€€ð½Ñ¥½¹Ìø(€€€€€€€€€€€€ð½‘¥Øø(€€€€€€€€€€¥ô((€€€€€€€€€ì¼¨U¸µµ•É”Õ¹‘½•Ì„µ•É”•á…Ñ±äè¥ÐÉ•ÍÑ½É•ÌÝ¡…ÐÑ¡”µ•É”(€€€€€€€€€€€€€Ñ½½¬°É•±•…Í•ÌÝ¡…ÐÝ…Ì…‘‘•Í¥¹”°…¹Ñ¡”•µÁÑ¥•‘É…™Ð(€€€€€€€€€€€€€½•Ì¸%ÉÉ•Ù•ÉÍ¥‰±”¥¸Ñ¡”Í…µ”Ý…ä‘•±•Ñ”¥Ì°Í¼¥Ð•ÑÌÑ¡”(€€€€€€€€€€€€€Í…µ”ÑÝ¼µÍÑ•ÀÑÉ•…Ñµ•¹Ð¸€¨½ô(€€€€€€€€€í‰½½¬¹ÍÑ…ÑÕÌ€ôôô€‘É…™Ðœ€˜˜…¹5½‘¥™ä€˜˜½¹™¥Éµ¥¹U¹µ•É”€˜˜€ (€€€€€€€€€€€€ñ‘¥Ø±…ÍÍ9…µ”ô‰µä´Ìˆø(€€€€€€€€€€€€€€ñ Ðù½¹™¥É´Õ¹µ•É”ð½ Ðø(€€€€€€€€€€€€€€ñÀø(€€€€€€€€€€€€€€€U¸µµ•É¥¹œÑ…­•ÌÑ¡¥Ì‘É…™Ð…Á…ÉÐè•… ½˜Ñ¡•ìœ€ô(€€€€€€€€€€€€€€€íMÑÉ¥¹œ¡…‰Í½É‰•‘I•½É‘Ì¹±•¹Ñ ¥ô…‰Í½É‰•É•½É5•…ÍÕÉ•µ•¹Ð	½½¬(€€€€€€€€€€€€€€€í…‰Í½É‰•‘I•½É‘Ì¹±•¹Ñ €ôôô€Ä€ü€œœ€è€ÌôÉ•ÑÕÉ¹ÌÑ¼‘É…™Ð¡½±‘¥¹œ(€€€€€€€€€€€€€€€•á…Ñ±äÑ¡”Í½ÕÉ•ÌÑ¡”µ•É”Ñ½½¬™É½´¥Ð°Í½ÕÉ•ÌÍ•±•Ñ•½¸Ñ¡¥Ì(€€€€€€€€€€€€€€€‘É…™Ð…™Ñ•ÈÑ¡”µ•É”…É”É•±•…Í•°…¹Ñ¡¥Ì•µÁÑ¥•‘É…™Ð¥Ì‘•±•Ñ•¸(€€€€€€€€€€€€€€€½¹Ñ¥¹Õ”ü(€€€€€€€€€€€€€€ð½Àø(€€€€€€€€€€€€€€ñÑ¥½¹Ìø(€€€€€€€€€€€€€€€€ñ	ÕÑÑ½¸(€€€€€€€€€€€€€€€€€‘¥Í…‰±•õíÁ•¹‘¥¹ô(€€€€€€€€€€€€€€€€€½¹±¥¬õì ¤€ôøì(€€€€€€€€€€€€€€€€€€€ÑÉåÐ¡…Íå¹Œ€ ¤€ôøì(€€€€€€€€€€€€€€€€€€€€€…Ý…¥Ð…Á¤¹Õ¹µ•É•5•…ÍÕÉ•µ•¹Ñ	½½¬¡½É…¹¥Í…Ñ¥½¹%°‰½½¬¹¥¤ì(€€€€€€€€€€€€€€€€€€€€€Í•Ñ•Ñ…¥°¡¹Õ±°¤ì(€€€€€€€€€€€€€€€€€€€€€Í•Ñ½¹™¥Éµ¥¹U¹µ•É”¡™…±Í”¤ì(€€€€€€€€€€€€€€€€€€€€€…Ý…¥ÐÉ•™É•Í¡1¥ÍÐ ¤ì(€€€€€€€€€€€€€€€€€€€ô°€U¹µ•É•èÑ¡”É•½É‘É…™ÑÌ…É”É•ÍÑ½É•…¹Ñ¡”…‰Í½É‰¥¹œ‘É…™Ð¥Ì‘•±•Ñ•¸œ¤ì(€€€€€€€€€€€€€€€€€õô(€€€€€€€€€€€€€€€€ø(€€€€€€€€€€€€€€€€€U¹µ•É”¹½Ü(€€€€€€€€€€€€€€€€ð½	ÕÑÑ½¸ø(€€€€€€€€€€€€€€€€ñ	ÕÑÑ½¸(€€€€€€€€€€€€€€€€€Ù…É¥…¹Ðô‰½ÕÑ±¥¹”ˆ(€€€€€€€€€€€€€€€€€‘¥Í…‰±•õíÁ•¹‘¥¹ô(€€€€€€€€€€€€€€€€€½¹±¥¬õì ¤€ôøì(€€€€€€€€€€€€€€€€€€€Í•Ñ½¹™¥Éµ¥¹U¹µ•É”¡™…±Í”¤ì(€€€€€€€€€€€€€€€€€õô(€€€€€€€€€€€€€€€€ø(€€€€€€€€€€€€€€€€€-••ÀÑ¡”µ•É•‘É…™Ð(€€€€€€€€€€€€€€€€ð½	ÕÑÑ½¸ø(€€€€€€€€€€€€€€ð½Ñ¥½¹Ìø(€€€€€€€€€€€€ð½‘¥Øø(€€€€€€€€€€¥ô((€€€€€€€€€í‰½½¬¹ÍÑ…ÑÕÌ€ôôô€™¥¹…±¥é•œ€˜˜…¹…¹•°€˜˜‰½½¬¹‰¥±±%€ôôô¹Õ±°€˜˜€ (€€€€€€€€€€€€ðø(€€€€€€€€€€€€€ì¼¨Q¡”¹½Ñ”¥Ì„ÅÕ•ÍÑ¥½¸°¹½Ð„É•½Éè¥ÐÍÑ…åÌ‰•¡¥¹¥ÑÌ(€€€€€€€€€€€€€€€€€½Ý¸Ù•ÉˆÍ¼„™¥¹…±¥é•5É•…‘Ì…ÌÝ¡…Ð¥Ð¥Ì¸Q¡”½¹™¥É´(€€€€€€€€€€€€€€€€€ÍÑ•À‰•±½ÜÍÑ…åÌ½ÕÑÍ¥‘”Ñ¡”Á…¹•°ƒŠP¥Ð¥ÌÑ¡”Í•½¹¡…±˜(€€€€€€€€€€€€€€€€€½˜Ñ¡”ÑÝ¼µÍÑ•À°¹½ÐÁ…ÉÐ½˜Ñ¡”™½É´¸€¨½ô(€€€€€€€€€€€€€€ñ¥Í±½ÍÕÉ”±…‰•°ô‰…¹•°5•…ÍÕÉ•µ•¹Ð	½½¯Š˜ˆø(€€€€€€€€€€€€€€€€ñ™½É´(€€€€€€€€€€€€€€€€€½¹MÕ‰µ¥Ðõì¡•Ù•¹Ð¤€ôøì(€€€€€€€€€€€€€€€€€€€•Ù•¹Ð¹ÁÉ•Ù•¹Ñ•™…Õ±Ð ¤ì(€€€€€€€€€€€€€€€€€€€€¼¼MÕ‰µ¥ÑÑ¥¹œ½¹±ä½Á•¹ÌÑ¡”½¹™¥É´ÍÑ•À‰•±½ÜìÑ¡”‰É½ÝÍ•È(€€€€€€€€€€€€€€€€€€€€¼¼¡…Ì•¹™½É•Ñ¡”¹½Ñ”‰ä¹½Ü°…¹Ñ¡”¥ÉÉ•Ù•ÉÍ¥‰±”…Ð¥Ì(€€€€€€€€€€€€€€€€€€€€¼¼…ÕÑ¡½É¥Í•Ñ¡•É”……¥¹ÍÐÑ¡”5¹Õµ‰•È¸(€€€€€€€€€€€€€€€€€€€Í•Ñ½¹™¥Éµ¥¹…¹•°¡ÑÉÕ”¤ì(€€€€€€€€€€€€€€€€€õô(€€€€€€€€€€€€€€€€ø(€€€€€€€€€€€€€€€€€€ñ¥•±ø(€€€€€€€€€€€€€€€€€€€€ñ±…‰•°¡Ñµ±½Èô‰µˆµ…¹•°µ¹½Ñ”ˆø(€€€€€€€€€€€€€€€€€€€€€…¹•±±…Ñ¥½¸¹½Ñ”€¡½¹±äÑ¡”¹•Ý•ÍÐ±¥Ù”5…¸…¹•°¤(€€€€€€€€€€€€€€€€€€€€ð½±…‰•°ø(€€€€€€€€€€€€€€€€€€€€ñ¥¹ÁÕÐ(€€€€€€€€€€€€€€€€€€€€€¥ô‰µˆµ…¹•°µ¹½Ñ”ˆ(€€€€€€€€€€€€€€€€€€€€€¹…µ”ô‰µˆµ…¹•°µ¹½Ñ”ˆ(€€€€€€€€€€€€€€€€€€€€€Ù…±Õ”õí…¹•±9½Ñ•ô(€€€€€€€€€€€€€€€€€€€€€½¹¡…¹”õì¡•Ù•¹Ð¤€ôøì(€€€€€€€€€€€€€€€€€€€€€€€€¼¼I•Ý½É‘¥¹œÑ¡”¹½Ñ”Ý¥Ñ¡‘É…ÝÌÑ¡”½¹™¥Éµ…Ñ¥½¸èÝ¡…Ð¥Ì(€€€€€€€€€€€€€€€€€€€€€€€€¼¼½¹™¥Éµ•µÕÍÐ‰”Ñ¡”Ý½É‘¥¹œÑ¡…Ð•ÑÌÍÑ½É•¸(€€€€€€€€€€€€€€€€€€€€€€€Í•Ñ…¹•±9½Ñ”¡•Ù•¹Ð¹Ñ…É•Ð¹Ù…±Õ”¤ì(€€€€€€€€€€€€€€€€€€€€€€€Í•Ñ½¹™¥Éµ¥¹…¹•°¡™…±Í”¤ì(€€€€€€€€€€€€€€€€€€€€€õô(€€€€€€€€€€€€€€€€€€€€€É•ÅÕ¥É•(€€€€€€€€€€€€€€€€€€€€€µ¥¹1•¹Ñ õìÍô(€€€€€€€€€€€€€€€€€€€€€µ…á1•¹Ñ õìÄÀÀÁô(€€€€€€€€€€€€€€€€€€€€¼ø(€€€€€€€€€€€€€€€€€€ð½¥•±ø(€€€€€€€€€€€€€€€€€ì…½¹™¥Éµ¥¹…¹•°€˜˜€ (€€€€€€€€€€€€€€€€€€€€ñ	ÕÑÑ½¸ÑåÁ”ô‰ÍÕ‰µ¥ÐˆÙ…É¥…¹Ðô‰½ÕÑ±¥¹”ˆ‘¥Í…‰±•õíÁ•¹‘¥¹ôø(€€€€€€€€€€€€€€€€€€€€€…¹•°5•…ÍÕÉ•µ•¹Ð	½½¯Š˜(€€€€€€€€€€€€€€€€€€€€ð½	ÕÑÑ½¸ø(€€€€€€€€€€€€€€€€€€¥ô(€€€€€€€€€€€€€€€€ð½™½É´ø(€€€€€€€€€€€€€€ð½¥Í±½ÍÕÉ”ø(€€€€€€€€€€€€€í½¹™¥Éµ¥¹…¹•°€˜˜€ (€€€€€€€€€€€€€€€€ñ‘¥Ø±…ÍÍ9…µ”ô‰µä´Ìˆø(€€€€€€€€€€€€€€€€€€ñ Ðù½¹™¥É´…¹•±±…Ñ¥½¸ð½ Ðø(€€€€€€€€€€€€€€€€€€ñÀø(€€€€€€€€€€€€€€€€€€€5•…ÍÕÉ•µ•¹Ð	½½¬íµ‰9Õµ‰•É1…‰•±ôÝ¥±°‰”…¹•±±•¸Q¡¥Ì…¹¹½Ð‰”(€€€€€€€€€€€€€€€€€€€Õ¹‘½¹”èÑ¡”¹Õµ‰•Èíµ‰9Õµ‰•É1…‰•±ô¥ÌÉ•Ñ…¥¹•™½É•Ù•È…¹…¸¹•Ù•È(€€€€€€€€€€€€€€€€€€€‰”É•ÕÍ•°Ñ¡”Í½ÕÉ•Ì¥Ð‰¥±±•…É”É•±•…Í•™½È„±…Ñ•È5°…¹(€€€€€€€€€€€€€€€€€€€Ñ¡”¹½Ñ”…‰½Ù”¥ÌÍÑ½É•½¸Ñ¡”É•½É¸(€€€€€€€€€€€€€€€€€€ð½Àø(€€€€€€€€€€€€€€€€€€ñÑ¥½¹Ìø(€€€€€€€€€€€€€€€€€€€€ñ	ÕÑÑ½¸(€€€€€€€€€€€€€€€€€€€€€‘¥Í…‰±•õíÁ•¹‘¥¹ô(€€€€€€€€€€€€€€€€€€€€€½¹±¥¬õì ¤€ôøì(€€€€€€€€€€€€€€€€€€€€€€€ÑÉåÐ¡…Íå¹Œ€ ¤€ôøì(€€€€€€€€€€€€€€€€€€€€€€€€€½¹ÍÐ…¹•±±•€ô…Ý…¥Ð…Á¤¹…¹•±5•…ÍÕÉ•µ•¹Ñ	½½¬ (€€€€€€€€€€€€€€€€€€€€€€€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€€€€€€€€€€€€€€€€€€€€€€€€€‰½½¬¹¥°(€€€€€€€€€€€€€€€€€€€€€€€€€€€…¹•±9½Ñ”¹ÑÉ¥´ ¤°(€€€€€€€€€€€€€€€€€€€€€€€€€€¤ì(€€€€€€€€€€€€€€€€€€€€€€€€€Í•Ñ•Ñ…¥°¡…¹•±±•¤ì(€€€€€€€€€€€€€€€€€€€€€€€€€Í•Ñ½¹™¥Éµ¥¹…¹•°¡™…±Í”¤ì(€€€€€€€€€€€€€€€€€€€€€€€€€…Ý…¥ÐÉ•™É•Í¡1¥ÍÐ ¤ì(€€€€€€€€€€€€€€€€€€€€€€€ô°€5•…ÍÕÉ•µ•¹Ð	½½¬…¹•±±•ì¥ÑÌ¹Õµ‰•È¥ÌÉ•Ñ…¥¹•…¹¥ÑÌÍ½ÕÉ•Ì…É”É•±•…Í•¸œ¤ì(€€€€€€€€€€€€€€€€€€€€€õô(€€€€€€€€€€€€€€€€€€€€ø(€€€€€€€€€€€€€€€€€€€€€…¹•°íµ‰9Õµ‰•É1…‰•±ô¹½Ü(€€€€€€€€€€€€€€€€€€€€ð½	ÕÑÑ½¸ø(€€€€€€€€€€€€€€€€€€€€ñ	ÕÑÑ½¸(€€€€€€€€€€€€€€€€€€€€€Ù…É¥…¹Ðô‰½ÕÑ±¥¹”ˆ(€€€€€€€€€€€€€€€€€€€€€‘¥Í…‰±•õíÁ•¹‘¥¹ô(€€€€€€€€€€€€€€€€€€€€€½¹±¥¬õì ¤€ôøì(€€€€€€€€€€€€€€€€€€€€€€€Í•Ñ½¹™¥Éµ¥¹…¹•°¡™…±Í”¤ì(€€€€€€€€€€€€€€€€€€€€€õô(€€€€€€€€€€€€€€€€€€€€ø(€€€€€€€€€€€€€€€€€€€€€-••ÀÑ¡¥Ì5•…ÍÕÉ•µ•¹Ð	½½¬(€€€€€€€€€€€€€€€€€€€€ð½	ÕÑÑ½¸ø(€€€€€€€€€€€€€€€€€€ð½Ñ¥½¹Ìø(€€€€€€€€€€€€€€€€ð½‘¥Øø(€€€€€€€€€€€€€€¥ô(€€€€€€€€€€€€ð¼ø(€€€€€€€€€€¥ô(€€€€€€€€€í‰½½¬¹ÍÑ…ÑÕÌ€ôôô€™¥¹…±¥é•œ€˜˜‰½½¬¹‰¥±±%€„ôô¹Õ±°€˜˜€ (€€€€€€€€€€€€ñÀ±…ÍÍ9…µ”ô‰Ñ•áÐµµÕÑ•µ™½É•É½Õ¹ˆø(€€€€€€€€€€€€€‰¥±°Ý…ÌÁÉ•Á…É•™É½´Ñ¡¥Ì5•…ÍÕÉ•µ•¹Ð	½½¬ì¥Ð¥ÌÁ•Éµ…¹•¹Ñ±ä±½­•ƒŠP(€€€€€€€€€€€€€½ÉÉ•Ñ¥½¹Ì¡…ÁÁ•¸…Ì½µÁ•¹Í…Ñ¥¹œ•¹ÑÉ¥•Ì½¸Ñ¡”¹•áÐ5¸(€€€€€€€€€€€€ð½Àø(€€€€€€€€€€¥ô(€€€€€€€€ð½‘¥Øø(€€€€€€¥ô(€€€€ð¼ø(€€¤ì)ô