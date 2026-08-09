/** Reconciliation report types for the v1 importer, plus the
 * human-readable rendering printed to stdout. The JSON form is stored
 * verbatim (per organisation) in import_batches.reconciliation. */

export interface ImportException {
  readonly entityType: string;
  readonly sourceId: string;
  /** The violated rule, named (e.g. 'challan-date-precedes-loa (0010)'). */
  readonly rule: string;
  readonly detail: string;
}

export interface EntityCounts {
  source: number;
  imported: number;
  unchanged: number;
  drifted: number;
  excepted: number;
}

export interface QuantizationClassStats {
  quantized: number;
  changed: number;
}

export interface QuantizationDrift {
  readonly fieldClass: string;
  readonly sourceId: string;
  readonly original: number;
  readonly quantized: string;
  readonly relativeDelta: number;
}

export interface SuffixedSequenceAssignment {
  /** The printed number, preserved verbatim on the imported challan. */
  readonly challanNo: string;
  /** The sequence_number the importer assigned. */
  readonly assignedSequence: number;
  /** Why that sequence: the parsed numeric core when it was free in the
   * Work's series, else the next integer above the series head. */
  readonly reason: string;
}

export interface ChallanSeriesReport {
  readonly workCode: string;
  readonly prefixes: readonly string[];
  readonly highestSequence: number;
  /** Value stored in delivery_challan_counters.next_value: the highest
   * burned number — imported sequences (suffixed assignments included)
   * and duplicated historical sequences, which are burned even though
   * neither duplicate row imported. The live issue route
   * increments-then-uses, so the next issued challan takes
   * nextIssueSequence = counterValue + 1. */
  readonly counterValue: number;
  readonly nextIssueSequence: number;
  /** The EXACT number the live issue route will mint next
   * (`<prefix>/<sequence>` — note the '/' separator, whatever separator
   * the historical numbers used), from the series-head challan's
   * prefix; null when nothing imported. */
  readonly nextIssueNumber: string | null;
  readonly gapCount: number;
  readonly gaps: readonly number[];
  readonly duplicateSequences: readonly number[];
  /** Challans whose printed number carries a non-numeric tail
   * ('PL-236-BB-DC-15A') and imported under an assigned sequence. */
  readonly suffixedAssignments: readonly SuffixedSequenceAssignment[];
}

export interface VariationRateDivergence {
  readonly workItemSourceId: string;
  readonly variationSourceId: string;
  readonly variationRate: number;
  readonly agreementRate: number;
}

export interface OrganisationReport {
  readonly slug: string;
  readonly name: string;
  readonly organisationId: string;
  readonly batchId: string;
  readonly counts: Record<string, EntityCounts>;
  readonly valueTotals: {
    readonly contractValueSource: string;
    readonly contractValueImported: string;
    readonly challanLineTotalSource: string;
    readonly challanLineTotalImported: string;
  };
  readonly challanSeries: readonly ChallanSeriesReport[];
  readonly serials: {
    readonly sourceTokens: number;
    readonly imported: number;
    readonly unchanged: number;
    readonly excepted: number;
  };
  readonly quantization: Record<string, QuantizationClassStats>;
  readonly quantizationWorst: readonly QuantizationDrift[];
  readonly variationRateDivergences: {
    readonly count: number;
    readonly sample: readonly VariationRateDivergence[];
  };
  readonly exceptions: readonly ImportException[];
}

export interface CompanyTally {
  readonly company: string;
  readonly works: number;
  readonly challans: number;
}

export interface RunReport {
  readonly mode: 'dry-run' | 'apply';
  readonly sourceSystem: string;
  readonly importerVersion: string;
  readonly inputDigest: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly organisations: readonly OrganisationReport[];
  readonly excludedCompanies: readonly CompanyTally[];
  readonly unmappedCompanies: readonly CompanyTally[];
  readonly runExceptions: readonly ImportException[];
}

function pad(value: string | number, width: number): string {
  return String(value).padStart(width);
}

export function renderRunReport(report: RunReport): string {
  const lines: string[] = [];
  lines.push(
    `v1 import ${report.mode.toUpperCase()} — importer ${report.importerVersion}`,
    `input sha256 ${report.inputDigest}`,
    `started ${report.startedAt}  finished ${report.finishedAt}`,
    '',
  );
  for (const org of report.organisations) {
    lines.push(`organisation ${org.name} (${org.slug}) — batch ${org.batchId}`);
    lines.push(
      '  entity                     source  imported unchanged   drifted  excepted',
    );
    for (const [entity, counts] of Object.entries(org.counts)) {
      lines.push(
        `  ${entity.padEnd(25)}${pad(counts.source, 9)}${pad(counts.imported, 10)}` +
          `${pad(counts.unchanged, 10)}${pad(counts.drifted, 10)}${pad(counts.excepted, 10)}`,
      );
    }
    lines.push(
      `  contract value   source ${org.valueTotals.contractValueSource}  imported ${org.valueTotals.contractValueImported}`,
      `  challan lines    source ${org.valueTotals.challanLineTotalSource}  imported ${org.valueTotals.challanLineTotalImported}`,
      `  serials          source ${org.serials.sourceTokens}  imported ${org.serials.imported}` +
        `  unchanged ${org.serials.unchanged}  excepted ${org.serials.excepted}`,
    );
    for (const series of org.challanSeries) {
      const gaps =
        series.gapCount === 0
          ? 'gapless'
          : `${series.gapCount} gap(s): ${series.gaps.join(', ')}`;
      const duplicates =
        series.duplicateSequences.length === 0
          ? ''
          : `  DUPLICATE sequences: ${series.duplicateSequences.join(', ')}`;
      // The exact next number makes the separator change visible before
      // apply: the live route formats `<prefix>/<sequence>` while
      // historical numbers keep their printed separators (mostly '-').
      const nextMint =
        series.nextIssueNumber === null
          ? ''
          : `  next-mint ${series.nextIssueNumber} (live '/' separator)`;
      lines.push(
        `  series ${series.workCode.padEnd(10)} [${series.prefixes.join(', ')}] ` +
          `high ${series.highestSequence} counter ${series.counterValue} ` +
          `next-issue ${series.nextIssueSequence}  ${gaps}${duplicates}${nextMint}`,
      );
      for (const assignment of series.suffixedAssignments) {
        lines.push(
          `    suffixed number ${JSON.stringify(assignment.challanNo)} imported as ` +
            `sequence ${String(assignment.assignedSequence)} — ${assignment.reason}`,
        );
      }
    }
    const quantizationSummary = Object.entries(org.quantization)
      .map(([fieldClass, stats]) => `${fieldClass} ${stats.changed}/${stats.quantized}`)
      .join('  ');
    lines.push(`  quantization changed/total: ${quantizationSummary || 'none'}`);
    for (const drift of org.quantizationWorst) {
      lines.push(
        `    worst ${drift.fieldClass} ${drift.sourceId}: ${String(drift.original)} -> ` +
          `${drift.quantized} (rel ${drift.relativeDelta.toExponential(2)})`,
      );
    }
    if (org.variationRateDivergences.count > 0) {
      lines.push(
        `  variation rows priced off the agreement rate: ${org.variationRateDivergences.count}` +
          ' (value folded into provenance; effective_quantity carries the net quantity)',
      );
    }
    lines.push(`  exceptions: ${org.exceptions.length}`);
    for (const exception of org.exceptions) {
      lines.push(
        `    [${exception.rule}] ${exception.entityType} ${exception.sourceId}: ${exception.detail}`,
      );
    }
    lines.push('');
  }
  for (const tally of report.excludedCompanies) {
    lines.push(
      `excluded company ${JSON.stringify(tally.company)}: ${tally.works} works, ${tally.challans} challans (not imported by mapping)`,
    );
  }
  for (const tally of report.unmappedCompanies) {
    lines.push(
      `UNMAPPED company ${JSON.stringify(tally.company)}: ${tally.works} works, ${tally.challans} challans — nothing imported; extend the mapping`,
    );
  }
  for (const exception of report.runExceptions) {
    lines.push(
      `run exception [${exception.rule}] ${exception.entityType} ${exception.sourceId}: ${exception.detail}`,
    );
  }
  return lines.join('\n');
}
