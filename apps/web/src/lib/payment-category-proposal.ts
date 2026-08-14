import type { WorkItemPaymentCategory } from '@auto-mb/contracts';

/**
 * The keyword proposer behind the post-creation payment setup dialog.
 *
 * WHAT IT IS. A pure reading of an item's DESCRIPTION that suggests a
 * payment category to a human, who then confirms or overrides it before
 * anything is written. It is not extraction and it is not a default: the
 * LOA parser still proposes no category at all (the letter's item table
 * does not carry one), and nothing here reaches the database except
 * through the reviewer pressing Save.
 *
 * WHAT IT REFUSES TO DO. Guess. A description that matches nothing
 * returns null and the item stays uncategorised for the operator to
 * decide — a wrong category is worse than an absent one, because it
 * silently decides which quantity the completion predicate measures and
 * which matrix row bills the item (PRODUCT.md §5.4).
 *
 * Two categories are never proposed, by ruling:
 *
 *  - SPARE_SUPPLY, because "spare" in a railway description names the
 *    goods ("supply of spares for the LED board"), not the commercial
 *    treatment of the line. Only the contract tells them apart.
 *  - AMC, because a maintenance schedule is recognised by its own
 *    heading and its `Year`/`Month` unit rather than by a word in the
 *    row, and because getting it wrong is expensive in both directions
 *    (an AMC item may never carry movement; a non-AMC item certifies
 *    against installed rather than sanctioned quantity). Worse, a
 *    maintenance line routinely names the equipment it maintains and so
 *    carries supply and installation words that are about the goods, not
 *    about this line's own work — so maintenance wording suppresses the
 *    proposal entirely rather than producing a confident wrong answer.
 *
 * THE RULES, in order, on the case-insensitive description:
 *
 *  1. maintenance wording      → no proposal (above);
 *  2. supply AND installation  → SUPPLY_AND_INSTALLATION;
 *  3. installation only        → PURE_INSTALLATION;
 *  4. supply only              → SUPPLY;
 *  5. neither                  → no proposal.
 *
 * The installation family deliberately includes the trade verbs a
 * railway BOQ uses instead of the word "installation" — laying, blowing,
 * jointing, termination, splicing, trenching — because "Laying of
 * armoured optical fibre cable" is installation work and saying
 * otherwise would be the same guess in a different direction. That is
 * why "Supply and laying of PVC cable" proposes SUPPLY_AND_INSTALLATION:
 * both families are present, and a line that supplies the cable AND lays
 * it is exactly what that category means.
 *
 * TWO OF THOSE VERBS ARE WEAK, and the distinction is the whole reason
 * the family is split in two. "Cutting" and "fixing" are also NOUN
 * ADJUNCTS in the names of goods a railway schedule buys — a "tile/rock
 * cutting machine", a set of "GI fixing clamps" — so on a line that
 * already says supply they are describing the MERCHANDISE, not a second
 * activity. "Supply of tile/rock cutting machine" is a supply line, and
 * reading it as supply-and-installation would split its value across a
 * stage nothing will ever move quantity through. So they count toward
 * installation only when no supply word is present ("Cutting of trench
 * for cable route" is still installation work); when a supply word IS
 * present they contribute nothing, and the line falls to SUPPLY unless a
 * strong installation word appears beside them ("Supply, laying and
 * fixing of FRP tray" is still supply and installation, on the strength
 * of "laying").
 *
 * This is NOT the uncategorised-item fallback the completion predicate
 * and the Measurement Book remark use (`description ilike '%installation%'`
 * on the server). That rule decides how an item with no category behaves;
 * this one proposes a category so the item need not rely on it.
 */

/** Supply wording. "Providing" is included because a railway BOQ writes
 * "Providing and laying" as often as "Supply and laying", and it means
 * the same thing: the contractor furnishes the material. */
const SUPPLY_WORDS =
  /\b(supply|supplies|supplying|supplied|provision|providing|provide)\b/;

/** Installation wording that means installation wherever it appears: the
 * explicit words first, then the trade verbs a railway schedule uses in
 * their place. None of these is ever the name of a thing. */
const STRONG_INSTALLATION_WORDS =
  /\b(install|installs|installing|installation|installations|erect|erecting|erection|commission|commissioning|laying|lay|blowing|jointing|termination|terminating|splicing|trenching)\b/;

/** Installation wording that is ALSO how a railway schedule names goods —
 * a "rock cutting machine", "GI fixing clamps". Counted only on a line
 * with no supply word on it (see the header). */
const WEAK_INSTALLATION_WORDS = /\b(cutting|fixing)\b/;

/** Maintenance wording, which suppresses any proposal. Deliberately
 * narrow: the bare word "maintenance" appears in ordinary supply lines
 * ("spares for maintenance"), so only the phrasings that actually name a
 * maintenance SCHEDULE count. */
const MAINTENANCE_WORDS =
  /\b(amc|annual\s+maintenance|comprehensive\s+maintenance|maintenance\s+contract)\b/;

/**
 * The category proposed for this description, or null when nothing is
 * proposed. Pure: same text in, same answer out, no I/O and no state.
 */
export function proposePaymentCategory(
  description: string,
): WorkItemPaymentCategory | null {
  const text = description.toLowerCase();
  if (MAINTENANCE_WORDS.test(text)) return null;
  const supply = SUPPLY_WORDS.test(text);
  const installation =
    STRONG_INSTALLATION_WORDS.test(text) ||
    (!supply && WEAK_INSTALLATION_WORDS.test(text));
  if (supply && installation) return 'SUPPLY_AND_INSTALLATION';
  if (installation) return 'PURE_INSTALLATION';
  if (supply) return 'SUPPLY';
  return null;
}
