import type { InspectionAgency } from '@auto-mb/contracts';

/**
 * Which inspecting agency a schedule item's DESCRIPTION appears to name.
 *
 * The clause mapping screen used to be one flat list of every item on the
 * Work, with an empty agency select on each row. On a 129-item schedule
 * that is 129 identical decisions, of which perhaps six are real: railway
 * schedules say so in the item text — "Inspection by RDSO", "RITES
 * inspection at vendor's works" — and the operator was reading for those
 * six by eye.
 *
 * So the screen reads for them instead, and this is the reading. What it
 * returns is a PROPOSAL and nothing more: it sorts the items into the
 * list an operator looks at first, and the mapping is still the
 * operator's own confirming act. Nothing here writes a clause.
 *
 * ## Why it is fuzzy
 *
 * The corpus does not spell these words reliably. LOA schedules arrive as
 * scanned PDFs typed by a dozen different offices, and the extraction
 * corpus already carries "Consingee" for consignee and runs whole phrases
 * together where the source line-wrapped ("inspectionbyRDSO"). An exact
 * match would find the six items on a clean letter and none at all on a
 * scanned one, which is the case that actually needs help.
 *
 * The reading is therefore: strip everything that is not a letter or a
 * digit, then look for the agency's name AND an inspection stem, each
 * within a bounded edit distance, anywhere in what is left. Stripping the
 * separators is what makes joined words free — "inspectionbyrdso" and
 * "Inspection by R.D.S.O." reduce to the same string — and the distance
 * bound is what makes typos free.
 *
 * ponytail: the bound is a fixed edit distance per term, not a similarity
 * score. It over-matches on short words that are one letter from an
 * agency name ("rates" is one edit from "rites"), which is why the
 * inspection stem must ALSO be present — and why a wrong proposal costs
 * the operator one select, not a wrong clause. If the corpus ever shows
 * this reading missing real items, the upgrade is a token-weighted score
 * over the same normalisation, not a wider bound.
 */

/** The two names that appear in the text. `consignee` is not here: an
 * item inspected by the consignee is rarely written as such, and it is
 * the value an operator reaches for when neither of these is proposed. */
const AGENCY_TERMS: ReadonlyArray<readonly [InspectionAgency, string]> = [
  ['RDSO', 'rdso'],
  ['RITES', 'rites'],
];

/** One edit on a four- or five-letter acronym. Two would make "rdso" and
 * "rites" reachable from most short words in the schedule. */
const AGENCY_TOLERANCE = 1;

/** The stem rather than the whole word, so "inspected", "inspecting" and
 * "inspection" are all one term; two edits on seven letters then absorbs
 * the transpositions the corpus actually contains ("insepction"). */
const INSPECTION_STEM = 'inspect';
const INSPECTION_TOLERANCE = 2;

/** Lower case, letters and digits only. Everything that separates words —
 * spaces, full stops inside "R.D.S.O.", hyphens, the newline a wrapped
 * cell leaves behind — is removed rather than collapsed, because the
 * failure being absorbed is words run together and words split apart, and
 * deleting the separators makes those two the same string. */
export function normaliseForMatch(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/**
 * The smallest edit distance between `needle` and ANY substring of
 * `haystack`.
 *
 * Ordinary Levenshtein with the first row pinned to zero, which is what
 * makes the start of the match free, and the answer taken as the minimum
 * over the whole last row, which makes the end free. One pass, two rows.
 */
export function approximateDistance(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let previous = Array.from({ length: needle.length + 1 }, (_, row) => row);
  let best = previous[needle.length] ?? needle.length;
  for (let column = 1; column <= haystack.length; column += 1) {
    // A match may BEGIN at any column, so consuming haystack costs
    // nothing until the needle starts.
    const current: number[] = [0];
    for (let row = 1; row <= needle.length; row += 1) {
      const same = haystack[column - 1] === needle[row - 1];
      current[row] = Math.min(
        (previous[row - 1] ?? row - 1) + (same ? 0 : 1),
        (previous[row] ?? row) + 1,
        (current[row - 1] ?? row - 1) + 1,
      );
    }
    best = Math.min(best, current[needle.length] ?? needle.length);
    previous = current;
  }
  return best;
}

/**
 * The agency an item's description appears to name, or null.
 *
 * Both halves must be present: the agency's name and an inspection stem.
 * A description naming BOTH agencies proposes the closer spelling, and
 * RDSO on a tie — a genuine "inspection by RDSO/RITES" item exists, and
 * proposing one of the two costs the operator the same single select as
 * proposing neither while making the item easier to find.
 */
export function proposeInspectionAgency(description: string): InspectionAgency | null {
  const text = normaliseForMatch(description);
  if (text.length === 0) return null;
  if (approximateDistance(text, INSPECTION_STEM) > INSPECTION_TOLERANCE) return null;

  let proposal: InspectionAgency | null = null;
  let bestDistance = AGENCY_TOLERANCE + 1;
  for (const [agency, term] of AGENCY_TERMS) {
    const distance = approximateDistance(text, term);
    if (distance < bestDistance) {
      bestDistance = distance;
      proposal = agency;
    }
  }
  return proposal;
}
