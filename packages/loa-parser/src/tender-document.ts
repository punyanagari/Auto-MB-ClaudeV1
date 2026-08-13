/**
 * Deterministic extraction for optional contract-source documents uploaded
 * beside a Letter of Acceptance. The result is proposal/evidence only: it is
 * reviewed by a human and never writes authoritative Work data by itself.
 */

export type TenderDocumentKind = 'nit' | 'contract_agreement' | 'tender_specification';
export type TenderPeriodKind = 'maintenance' | 'warranty';
export type TenderReleaseKind = 'pbg' | 'security_deposit';
export type TenderMatrixCategory =
  | 'SUPPLY'
  | 'SUPPLY_AND_INSTALLATION'
  | 'PURE_INSTALLATION'
  | 'SPARE_SUPPLY'
  | 'AMC'
  | 'UNCATEGORISED';

export interface TenderField {
  readonly value: string | null;
  readonly raw: string | null;
  readonly needsReview: boolean;
}

export interface TenderPaymentMatrixSuggestion {
  readonly category: TenderMatrixCategory;
  readonly pctSupply: string | null;
  readonly pctInstallation: string | null;
  readonly pctPac: string | null;
  readonly pctFinalBill: string | null;
  readonly rawBlock: string;
  readonly needsReview: boolean;
}

export interface TenderPeriodSuggestion {
  readonly kind: TenderPeriodKind;
  readonly durationValue: string | null;
  readonly durationUnit: 'day' | 'month' | 'year' | null;
  readonly scope: 'work' | 'item';
  readonly itemReferences: readonly string[];
  readonly rawBlock: string;
  readonly needsReview: boolean;
}

export interface TenderReleaseClauseSuggestion {
  readonly kind: TenderReleaseKind;
  readonly rawBlock: string;
  readonly needsReview: boolean;
}

export interface TenderItemSpecificationSuggestion {
  readonly itemReferences: readonly string[];
  readonly specification: string;
  readonly rawBlock: string;
  readonly needsReview: boolean;
}

export interface TenderReviewPayload {
  readonly documentKind: TenderDocumentKind;
  readonly identity: {
    readonly tenderNumber: TenderField;
    readonly workDescription: TenderField;
  };
  readonly paymentMatrix: readonly TenderPaymentMatrixSuggestion[];
  readonly periods: readonly TenderPeriodSuggestion[];
  readonly releaseClauses: readonly TenderReleaseClauseSuggestion[];
  readonly itemSpecifications: readonly TenderItemSpecificationSuggestion[];
  readonly needsReview: {
    readonly total: number;
    readonly identityUnresolved: boolean;
  };
}

export interface TenderIdentityMatch {
  readonly matched: boolean;
  readonly tenderNumberMatched: boolean;
  readonly workDescriptionMatched: boolean;
  readonly expectedTenderNumber: string;
  readonly extractedTenderNumber: string | null;
  readonly expectedWorkDescription: string;
  readonly extractedWorkDescription: string | null;
  readonly reasons: readonly string[];
}

function normalizeLines(rawText: string): readonly string[] {
  return rawText
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim());
}

function paragraphs(rawText: string): readonly string[] {
  const lines = normalizeLines(rawText);
  const result: string[] = [];
  let current: string[] = [];
  const flush = () => {
    if (current.length > 0) result.push(current.join(' '));
    current = [];
  };
  for (const line of lines) {
    if (line === '') {
      flush();
      continue;
    }
    current.push(line);
  }
  flush();
  return result;
}

function firstLabelValue(
  lines: readonly string[],
  labels: readonly RegExp[],
): TenderField {
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    for (const label of labels) {
      const match = label.exec(line);
      if (match === null) continue;
      const inline = (match.groups?.value ?? match[1] ?? '').trim();
      if (inline.length > 0) {
        return { value: inline, raw: line, needsReview: false };
      }
      const next = lines.slice(index + 1).find((candidate) => candidate.length > 0);
      if (next !== undefined) {
        return { value: next, raw: `${line}\n${next}`, needsReview: false };
      }
      return { value: null, raw: line, needsReview: true };
    }
  }
  return { value: null, raw: null, needsReview: true };
}

const WORK_DESCRIPTION_BOUNDARY_RE =
  /^(?:payment(?:\s+terms?)?|warrant(?:y|ies)|guarantee\s+period|maintenance(?:\s+period)?|defect\s+liability|performance\s+(?:bank\s+)?guarantee|PBG|security\s+deposit|item\s+\S+\s+technical\s+specification)\b/i;
const NEXT_LABEL_RE = /^[A-Za-z][^:]{0,80}:\s*\S/;

/**
 * Extracts a labelled prose field that may wrap over several PDF text lines.
 * Continuations stop at a blank line, the next labelled field, a known tender
 * clause, or the sentence-ending line. This keeps adjacent tender metadata
 * out of the name of work while preserving its complete printed wording.
 */
function firstWrappedLabelValue(
  lines: readonly string[],
  labels: readonly RegExp[],
): TenderField {
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    for (const label of labels) {
      const match = label.exec(line);
      if (match === null) continue;

      const valueLines: string[] = [];
      const rawLines = [line];
      const inline = (match.groups?.value ?? match[1] ?? '').trim();
      if (inline.length > 0) valueLines.push(inline);

      for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
        const candidate = lines[cursor] ?? '';
        if (
          candidate.length === 0 ||
          NEXT_LABEL_RE.test(candidate) ||
          WORK_DESCRIPTION_BOUNDARY_RE.test(candidate)
        ) {
          break;
        }
        valueLines.push(candidate);
        rawLines.push(candidate);
        if (/[.!?]$/.test(candidate)) break;
      }

      const value = valueLines.join(' ').trim();
      return value.length > 0
        ? { value, raw: rawLines.join('\n'), needsReview: false }
        : { value: null, raw: line, needsReview: true };
    }
  }
  return { value: null, raw: null, needsReview: true };
}

function decimalText(value: string): string {
  const stripped = value.replace(/,/g, '').trim();
  const number = /^(\d{1,3}(?:\.\d{1,2})?)/.exec(stripped)?.[1] ?? stripped;
  return number.replace(/\.0+$/, '');
}

function percentageHundredths(value: string | null): bigint | null {
  if (value === null) return null;
  const match = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(value);
  if (match === null) return null;
  const whole = BigInt(match[1] ?? '0');
  const fraction = BigInt((match[2] ?? '').padEnd(2, '0') || '0');
  const result = whole * 100n + fraction;
  return result <= 10000n ? result : null;
}

function percentageNear(block: string, expressions: readonly RegExp[]): string | null {
  for (const expression of expressions) {
    const match = expression.exec(block);
    if (match !== null && match[1] !== undefined) return decimalText(match[1]);
  }
  return null;
}

function matrixCategory(block: string): TenderMatrixCategory {
  // Spare supply is tested FIRST and stays first. A "maintenance spare"
  // is a spare part despatched under a maintenance obligation — material
  // that moves, and therefore a supply category — while AMC is the
  // service itself. The two read alike and the spare test is the
  // narrower one, so it keeps its precedence and the AMC test below
  // cannot capture it.
  if (/spare\s+supply|mandatory\s+spare|maintenance\s+spare/i.test(block)) {
    return 'SPARE_SUPPLY';
  }
  // AMC (migration 0068). The corpus spells it as a schedule heading —
  // PL270-CRB's "Schedule B-AMC for complete SCH A systems" and its item
  // "AMC for SCH A items for the period of 5 year" — and the expanded
  // form appears as "annual maintenance". A bare "maintenance period"
  // clause is deliberately NOT enough: every tender carries one, and it
  // describes a warranty obligation on supplied material rather than a
  // priced maintenance schedule.
  if (
    /\bAMC\b|annual\s+(?:comprehensive\s+)?maintenance(?:\s+contract)?/i.test(block)
  ) {
    return 'AMC';
  }
  if (/pure(?:ly)?\s+installation|installation\s+only/i.test(block)) {
    return 'PURE_INSTALLATION';
  }
  if (/supply\s*(?:and|&)\s*installation|supply-cum-installation/i.test(block)) {
    return 'SUPPLY_AND_INSTALLATION';
  }
  if (/supply\s+only|on\s+supply/i.test(block) && !/installation/i.test(block)) {
    return 'SUPPLY';
  }
  return 'UNCATEGORISED';
}

function matrixSuggestions(
  blocks: readonly string[],
): readonly TenderPaymentMatrixSuggestion[] {
  const byCategory = new Map<TenderMatrixCategory, TenderPaymentMatrixSuggestion>();
  for (const block of blocks) {
    if (!/%|percent|payment/i.test(block)) continue;
    const pctSupply = percentageNear(block, [
      /(\d{1,3}(?:\.\d{1,2})?)\s*%?\s*(?:on|against|after)\s+(?:successful\s+)?supply/i,
      /supply\s*(?:stage|payment)?\s*[:=-]?\s*(\d{1,3}(?:\.\d{1,2})?)\s*%/i,
    ]);
    const pctInstallation = percentageNear(block, [
      /(\d{1,3}(?:\.\d{1,2})?)\s*%?\s*(?:on|against|after)\s+(?:successful\s+)?installation/i,
      /installation\s*(?:stage|payment)?\s*[:=-]?\s*(\d{1,3}(?:\.\d{1,2})?)\s*%/i,
    ]);
    const pctPac = percentageNear(block, [
      /(\d{1,3}(?:\.\d{1,2})?)\s*%?\s*(?:on|against|after)\s+(?:issue\s+of\s+)?(?:PAC|provisional\s+acceptance)/i,
      /(?:PAC|provisional\s+acceptance)\s*(?:stage|payment)?\s*[:=-]?\s*(\d{1,3}(?:\.\d{1,2})?)\s*%/i,
    ]);
    const pctFinalBill = percentageNear(block, [
      /(\d{1,3}(?:\.\d{1,2})?)\s*%?\s*(?:on|against|after)\s+(?:final\s+acceptance|final\s+bill|DOC|completion)/i,
      /(?:final\s+bill|final\s+acceptance|DOC|completion)\s*(?:stage|payment)?\s*[:=-]?\s*(\d{1,3}(?:\.\d{1,2})?)\s*%/i,
    ]);
    const values = [pctSupply, pctInstallation, pctPac, pctFinalBill];
    if (values.filter((value) => value !== null).length < 2) continue;
    const parsed = values.map(percentageHundredths);
    const complete = parsed.every((value) => value !== null);
    const total = parsed.reduce<bigint>((sum, value) => sum + (value ?? 0n), 0n);
    const category = matrixCategory(block);
    byCategory.set(category, {
      category,
      pctSupply,
      pctInstallation,
      pctPac,
      pctFinalBill,
      rawBlock: block,
      needsReview: !complete || total !== 10000n,
    });
  }
  return [...byCategory.values()];
}

function itemReferences(block: string): readonly string[] {
  const references = new Set<string>();
  const expressions = [
    /(?:item|schedule\s+item)\s*(?:nos?\.?|numbers?|codes?)?\s*[:#-]?\s*([A-Z0-9][A-Z0-9.,/&()\-\s]{0,80})/gi,
    /\b(?:ITM|ITEM)[-_/]?[A-Z0-9-]+\b/gi,
  ];
  for (const expression of expressions) {
    for (const match of block.matchAll(expression)) {
      const raw = (match[1] ?? match[0] ?? '').trim();
      for (const part of raw.split(/\s*(?:,|&|and)\s*/i)) {
        const cleaned = part.replace(/[.;:]$/, '').trim();
        if (/^[A-Z0-9][A-Z0-9./_-]{0,39}$/i.test(cleaned)) references.add(cleaned);
      }
    }
  }
  return [...references];
}

const DURATION_PATTERN = String.raw`(\d+(?:\.\d+)?)\s*(days?|months?|years?)`;
const WARRANTY_PERIOD_LABEL = String.raw`(?:warrant(?:y|ies)(?:\s+period)?|guarantee\s+period)`;
const MAINTENANCE_PERIOD_LABEL = String.raw`(?:maintenance\s+period|defect\s+liability(?:\s+period)?|AMC\s+period)`;

function labelledPeriodDuration(
  clause: string,
  kind: TenderPeriodKind,
): RegExpExecArray | null {
  const label = kind === 'warranty' ? WARRANTY_PERIOD_LABEL : MAINTENANCE_PERIOD_LABEL;
  const afterLabel = new RegExp(
    String.raw`${label}\s*(?:(?:is|of|for|shall\s+be|valid\s+for|coverage)\s*)?[:=-]?\s*${DURATION_PATTERN}`,
    'i',
  ).exec(clause);
  return (
    afterLabel ??
    new RegExp(String.raw`${DURATION_PATTERN}\s*${label}`, 'i').exec(clause)
  );
}

function anyDuration(clause: string): RegExpExecArray | null {
  return new RegExp(DURATION_PATTERN, 'i').exec(clause);
}

function periodDuration(
  clause: string,
  kind: TenderPeriodKind,
): RegExpExecArray | null {
  return labelledPeriodDuration(clause, kind) ?? anyDuration(clause);
}

function periodKindOf(clause: string): TenderPeriodKind | null {
  const hasDuration = anyDuration(clause) !== null;
  const hasExplicitPeriodDuration =
    labelledPeriodDuration(clause, 'warranty') !== null ||
    labelledPeriodDuration(clause, 'maintenance') !== null;
  const isInstrumentReleaseReference =
    /\b(?:PBG|performance\s+bank\s+guarantee|bank\s+guarantee|security\s+deposit|SD)\b/i.test(
      clause,
    ) &&
    /\b(?:release(?:d)?|return(?:ed)?|refund(?:ed)?|discharg(?:ed)?|paid\s+back)\b/i.test(
      clause,
    ) &&
    !hasExplicitPeriodDuration;
  if (isInstrumentReleaseReference) return null;

  const warrantyIndex = hasDuration
    ? clause.search(
        /\b(?:warranty|warranties)\b(?!\s+obligations?\b)|guarantee\s+period/i,
      )
    : clause.search(
        /\b(?:warranty|warranties)\b(?=\s*(?:period\b|requirements?\b|terms?\b|coverage\b|valid(?:ity)?\b|appl(?:y|ies|icable)\b|(?:shall|will|is|of|for|from)\b|[:=-]|\d))|guarantee\s+period/i,
      );
  const maintenanceIndex = clause.search(
    /maintenance\s+period|defect\s+liability|AMC\s+period/i,
  );
  return maintenanceIndex >= 0 &&
    (warrantyIndex < 0 || maintenanceIndex < warrantyIndex)
    ? 'maintenance'
    : warrantyIndex >= 0
      ? 'warranty'
      : null;
}

function sentenceClauses(block: string): readonly string[] {
  const protectedStop = '\uE000';
  return block
    .replace(/\b(?:Nos?|S\.?\s*No)\./gi, (abbreviation) =>
      abbreviation.replaceAll('.', protectedStop),
    )
    .split(/[.!?]\s+/)
    .filter((clause) => clause.length > 0)
    .map((clause) => clause.replaceAll(protectedStop, '.'));
}

function periodSuggestions(
  blocks: readonly string[],
): readonly TenderPeriodSuggestion[] {
  const result: TenderPeriodSuggestion[] = [];
  for (const block of blocks) {
    // A single PDF paragraph often carries warranty and maintenance on
    // adjacent sentences. Judge each labelled sentence independently, but
    // retain an immediately following duration sentence as the same evidence.
    const clauses = sentenceClauses(block);
    const consumedClauseIndexes = new Set<number>();
    for (const [index, clause] of clauses.entries()) {
      if (consumedClauseIndexes.has(index)) continue;
      const kind = periodKindOf(clause);
      if (kind === null) continue;
      let evidence = clause;
      let duration = periodDuration(evidence, kind);
      const next = clauses[index + 1];
      const nextKind = next === undefined ? null : periodKindOf(next);
      const clauseRefs = itemReferences(clause);
      const nextRefs = next === undefined ? [] : itemReferences(next);
      const sameItemScope =
        nextRefs.length === 0 ||
        (nextRefs.length === clauseRefs.length &&
          nextRefs.every((reference) => clauseRefs.includes(reference)));
      if (
        duration === null &&
        next !== undefined &&
        ((nextKind === kind && sameItemScope) ||
          (nextKind === null &&
            /\b(?:the|this|such|its)\s+(?:said\s+)?(?:period|duration)\b/i.test(
              next,
            ))) &&
        anyDuration(next) !== null
      ) {
        evidence = `${clause}. ${next}`;
        duration = periodDuration(evidence, kind);
        consumedClauseIndexes.add(index + 1);
      }
      const refs = itemReferences(evidence);
      const unitRaw = duration?.[2]?.toLowerCase() ?? null;
      const durationUnit =
        unitRaw === null
          ? null
          : unitRaw.startsWith('day')
            ? 'day'
            : unitRaw.startsWith('month')
              ? 'month'
              : 'year';
      result.push({
        kind,
        durationValue: duration?.[1] ?? null,
        durationUnit,
        scope: refs.length > 0 ? 'item' : 'work',
        itemReferences: refs,
        rawBlock: evidence,
        needsReview: duration === null,
      });
    }
  }
  return result;
}

function releaseClauses(
  blocks: readonly string[],
): readonly TenderReleaseClauseSuggestion[] {
  const result: TenderReleaseClauseSuggestion[] = [];
  for (const block of blocks) {
    const releaseLanguage = /release|return|refund|discharge|shall be paid back/i.test(
      block,
    );
    if (!releaseLanguage) continue;
    if (/performance\s+(?:bank\s+)?guarantee|\bPBG\b/i.test(block)) {
      result.push({ kind: 'pbg', rawBlock: block, needsReview: false });
    }
    if (/security\s+deposit|\bSD\b/i.test(block)) {
      result.push({ kind: 'security_deposit', rawBlock: block, needsReview: false });
    }
  }
  return result;
}

function specificationSuggestions(
  blocks: readonly string[],
): readonly TenderItemSpecificationSuggestion[] {
  const result: TenderItemSpecificationSuggestion[] = [];
  for (const block of blocks) {
    if (
      !/specification|technical\s+requirement|shall\s+conform|make\s*\/\s*model|standard\s+(?:as|no\.?)/i.test(
        block,
      )
    ) {
      continue;
    }
    const refs = itemReferences(block);
    if (refs.length === 0) continue;
    result.push({
      itemReferences: refs,
      specification: block,
      rawBlock: block,
      needsReview: true,
    });
  }
  return result;
}

export function reviewTenderDocument(
  rawText: string,
  documentKind: TenderDocumentKind,
): TenderReviewPayload {
  const lines = normalizeLines(rawText);
  const blocks = paragraphs(rawText);
  const tenderNumber = firstLabelValue(lines, [
    /^(?:tender|e-tender|nit|notice\s+inviting\s+tender)\s*(?:no\.?|number|id)?\s*[:-]\s*(?<value>.+)$/i,
    /^tender\s+reference\s*[:-]\s*(?<value>.+)$/i,
  ]);
  const workDescription = firstWrappedLabelValue(lines, [
    /^(?:name\s+of\s+(?:the\s+)?work|work\s+description|description\s+of\s+work)\s*[:-]\s*(?<value>.*)$/i,
    /^(?:subject|sub\.)\s*[:-]\s*(?<value>.*)$/i,
  ]);
  const paymentMatrix = matrixSuggestions(blocks);
  const periods = periodSuggestions(blocks);
  const clauses = releaseClauses(blocks);
  const specifications = specificationSuggestions(blocks);
  const total =
    Number(tenderNumber.needsReview) +
    Number(workDescription.needsReview) +
    paymentMatrix.filter((row) => row.needsReview).length +
    periods.filter((row) => row.needsReview).length +
    clauses.filter((row) => row.needsReview).length +
    specifications.filter((row) => row.needsReview).length;
  return {
    documentKind,
    identity: { tenderNumber, workDescription },
    paymentMatrix,
    periods,
    releaseClauses: clauses,
    itemSpecifications: specifications,
    needsReview: {
      total,
      identityUnresolved: tenderNumber.value === null || workDescription.value === null,
    },
  };
}

function normalizedTenderNumber(value: string): string {
  return value
    .normalize('NFKC')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

function normalizedWords(value: string): readonly string[] {
  return value
    .normalize('NFKC')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(
      (word) =>
        word.length > 1 && !['THE', 'OF', 'FOR', 'AND', 'AT', 'IN'].includes(word),
    );
}

function workDescriptionMatches(expected: string, actual: string): boolean {
  const left = normalizedWords(expected);
  const right = normalizedWords(actual);
  if (left.length === 0 || right.length === 0) return false;
  const leftText = left.join(' ');
  const rightText = right.join(' ');
  if (leftText === rightText) return true;
  if (leftText.includes(rightText) || rightText.includes(leftText)) {
    const ratio =
      Math.min(leftText.length, rightText.length) /
      Math.max(leftText.length, rightText.length);
    if (ratio >= 0.72) return true;
  }
  const rightSet = new Set(right);
  const intersection = left.filter((word) => rightSet.has(word)).length;
  const union = new Set([...left, ...right]).size;
  return union > 0 && intersection / union >= 0.82;
}

/** Strict enough to prevent cross-tender attachments, but punctuation and
 * harmless label wording do not create false mismatches. Missing identity is
 * always a rejection: the system never guesses which Work a document belongs to. */
export function matchTenderIdentity(
  expectedTenderNumber: string,
  expectedWorkDescription: string,
  review: TenderReviewPayload,
): TenderIdentityMatch {
  const extractedTenderNumber = review.identity.tenderNumber.value;
  const extractedWorkDescription = review.identity.workDescription.value;
  const tenderNumberMatched =
    extractedTenderNumber !== null &&
    normalizedTenderNumber(expectedTenderNumber) !== '' &&
    normalizedTenderNumber(expectedTenderNumber) ===
      normalizedTenderNumber(extractedTenderNumber);
  const workDescriptionMatched =
    extractedWorkDescription !== null &&
    workDescriptionMatches(expectedWorkDescription, extractedWorkDescription);
  const reasons: string[] = [];
  if (extractedTenderNumber === null) {
    reasons.push('The tender number could not be located in the uploaded document.');
  } else if (!tenderNumberMatched) {
    reasons.push('The tender number does not match the Letter of Acceptance.');
  }
  if (extractedWorkDescription === null) {
    reasons.push('The name of work could not be located in the uploaded document.');
  } else if (!workDescriptionMatched) {
    reasons.push('The name of work does not match the Letter of Acceptance.');
  }
  return {
    matched: tenderNumberMatched && workDescriptionMatched,
    tenderNumberMatched,
    workDescriptionMatched,
    expectedTenderNumber,
    extractedTenderNumber,
    expectedWorkDescription,
    extractedWorkDescription,
    reasons,
  };
}
