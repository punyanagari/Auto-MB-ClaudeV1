import { describe, expect, it } from 'vitest';
import { proposePaymentCategory } from '../src/lib/payment-category-proposal.js';

/**
 * The keyword proposer behind the post-creation payment setup dialog.
 *
 * Most of the descriptions below are taken from the LOA regression corpus
 * (`packages/loa-parser/fixtures/PL270-CRB.txt` and its siblings) rather
 * than invented, because the whole value of the proposer is how it reads
 * the sentences a railway schedule actually contains — "Laying of PVC/
 * Coaxial cable", "Supply & Installation of 9U rack", "Cutting of trench".
 *
 * The rule the suite pins hardest is the one that is easy to get wrong in
 * either direction: a line that mentions BOTH families is supply and
 * installation, including when the installation half is a trade verb
 * ("Supply and laying of..."), and a line that matches nothing at all
 * proposes nothing rather than falling back to a category.
 */

describe('proposePaymentCategory', () => {
  it('proposes supply and installation when both families are present', () => {
    for (const description of [
      'Supply, installation, testing and commissioning of additional train indication boards',
      'Supply & Installation of 9U Wall Mount Rack',
      'Supply Installation Testing and Commissioning of True Colour AVD',
      'Supply, Installation, Testing & Commissioning of Single Face display',
      'Supply and erection of steel pole with foundation',
    ]) {
      expect(proposePaymentCategory(description), description).toBe(
        'SUPPLY_AND_INSTALLATION',
      );
    }
  });

  it('reads a trade verb as the installation half of a mixed line', () => {
    // The owner's ruling, encoded: cutting, laying and blowing are
    // installation work, so a line that supplies the material AND does
    // one of them is supply plus installation, not supply.
    for (const description of [
      'Supply and laying of armoured optical fibre cable',
      'Supply of HDPE duct including laying in trench',
      'Providing and laying of PVC/Coaxial cable along the platform',
      'Supply and blowing of 24F OFC through existing duct',
      'Supply, laying and jointing of 6 core armoured cable',
    ]) {
      expect(proposePaymentCategory(description), description).toBe(
        'SUPPLY_AND_INSTALLATION',
      );
    }
  });

  it('proposes pure installation for installation-only wording', () => {
    for (const description of [
      'Installation, testing and commissioning of various display boards',
      'Laying and fixing of FRP perforated tray',
      'Laying of G.I. pipe along the platform edge',
      'Cutting of platform with tile/rock cutting machine',
      'Cutting of trench for cable route',
      'Blowing of armoured optical fibre cable through duct',
      'Jointing of optical fibre cable at the exchange end',
      'Termination of Cat 6 armoured cable on the patch panel',
      'Splicing of 24F OFC at the joint chamber',
      'Trenching along the yard for cable laying',
      'Erection of the mast at the platform end',
      'Commissioning of True Colour indoor display',
    ]) {
      expect(proposePaymentCategory(description), description).toBe(
        'PURE_INSTALLATION',
      );
    }
  });

  it('reads cutting and fixing as goods on a supply line, not as work', () => {
    // "Cutting" and "fixing" are noun adjuncts in the names of things a
    // railway schedule buys. On a line that already says supply they
    // describe the merchandise, and proposing supply-and-installation
    // would split the item's value across a stage no quantity will ever
    // move through.
    for (const description of [
      'Supply of tile/rock cutting machine',
      'Supply of GI fixing clamps',
      'Providing of rock cutting bits for the drilling rig',
    ]) {
      expect(proposePaymentCategory(description), description).toBe('SUPPLY');
    }
    // A strong installation word beside them still carries the line.
    expect(
      proposePaymentCategory('Supply, laying and fixing of FRP perforated tray'),
    ).toBe('SUPPLY_AND_INSTALLATION');
    // And with no supply word on the line they still mean the work.
    for (const description of [
      'Cutting of trench for cable route',
      'Fixing of the pole mount bracket at platform 3',
    ]) {
      expect(proposePaymentCategory(description), description).toBe(
        'PURE_INSTALLATION',
      );
    }
  });

  it('proposes supply for supply-only wording', () => {
    for (const description of [
      'Supply of True colour MLDB',
      'Supply of SFP 1G module',
      'Supply of Cat 6 Armoured cable',
      'Supply of layer 2 managed switch',
      'Supply of FRP perforated cable tray',
      'Providing of wall mount/pole mount bracket',
      'Provision of 12 Port LIU Rack',
    ]) {
      expect(proposePaymentCategory(description), description).toBe('SUPPLY');
    }
  });

  it('proposes nothing when no keyword matches', () => {
    for (const description of [
      'Charges for statutory approvals',
      'Third party inspection by RDSO',
      'Freight and insurance up to destination',
      'Miscellaneous items as per site requirement',
      '',
      '   ',
    ]) {
      expect(proposePaymentCategory(description), description).toBeNull();
    }
  });

  it('never proposes AMC, and stays silent on maintenance lines', () => {
    // Ratified: AMC is never auto-proposed. A maintenance line routinely
    // names the equipment it maintains, so its supply and installation
    // words are about the goods rather than about this line's own work —
    // proposing SUPPLY there would be a confident wrong answer.
    for (const description of [
      'AMC of LED based display boards for the third year',
      'AMC for SCH A items for the fourth and fifth year',
      'Annual maintenance of Fully Automatic display system',
      'Comprehensive maintenance of the 5 KVA online UPS',
      'AMC of the supplied and installed True Colour boards',
      'Maintenance contract for the coach guidance system',
    ]) {
      expect(proposePaymentCategory(description), description).toBeNull();
    }
  });

  it('never proposes SPARE_SUPPLY, which only the contract can tell apart', () => {
    // A spare is still a supply line by its words; the commercial
    // treatment is not written in the description, so the proposer reads
    // what is there and the operator makes the call.
    expect(proposePaymentCategory('Supply of spares for the LED board')).toBe('SUPPLY');
  });

  it('reads case and punctuation the way a schedule writes them', () => {
    expect(proposePaymentCategory('SUPPLY, INSTALLATION AND COMMISSIONING')).toBe(
      'SUPPLY_AND_INSTALLATION',
    );
    expect(proposePaymentCategory('supply & installation of rack')).toBe(
      'SUPPLY_AND_INSTALLATION',
    );
    expect(proposePaymentCategory('Supply/laying of duct')).toBe(
      'SUPPLY_AND_INSTALLATION',
    );
    expect(proposePaymentCategory('Supplying of 6 core armored cable')).toBe('SUPPLY');
    expect(proposePaymentCategory('Installing the display at platform 3')).toBe(
      'PURE_INSTALLATION',
    );
  });

  it('matches whole words only', () => {
    // "Resupplyable" and "overlaying" are not this vocabulary; a
    // substring match would read them as supply and as laying.
    expect(proposePaymentCategory('Resupplyable canister assembly')).toBeNull();
    expect(proposePaymentCategory('Overlaying of the ballast bed')).toBeNull();
  });
});
