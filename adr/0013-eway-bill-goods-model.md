# ADR-0013: E-way bills key on line content, and challans learn the statutory facts

- Status: Accepted (owner decision 2026-08-14, wave-4 scope ruling)
- Date: 2026-08-14
- Amends: the disposition of audit finding 1 (docs/AUDIT-DISPOSITION-2026-08-10.md) — its
  blanket refusal is narrowed, not repudiated. Programme reference: W4-P5,
  IMPROVEMENT-PROGRAMME-2026-08-13 §2.10.

## Context

The e-way bill module has schema, routes, provider transport and a web
panel, but fresh generation is switched off. The 2026-08-10 disposition
ruled that a contractor→Railways invoice carries a SAC service line and
needs no e-way bill, and NIC confirmed the position empirically during
sandbox certification: generation by IRN was refused with error 4009 —
"E Way Bill can be generated provided at least HSN of one item belongs
to goods." The payload builders were then deleted as dead code, and the
delivery-challan module recorded its statutory facts as "stage 3b and
deliberately absent."

The owner's wave-4 ruling changes the premise, not the logic. Auto-MB
now also serves movements outside the railway-contract scope: direct
invoices to private customers already ship server-side, and standalone
delivery challans already carry goods to private consignees, vendors and
job workers. Those movements are goods movements. For them the 2026-08-10
reasoning — "our invoices are services" — simply does not apply, and an
e-way bill is a legal requirement above the value threshold.

## Decision

### Applicability is a property of the lines, never of the document kind

The current refusals are blanket: any cumulative SAC invoice, and the
nic-payload route unconditionally. Both are replaced by one rule read
from the data: an e-way bill can be generated when the source document
carries at least one goods (HSN) line. A service-only document keeps
being refused with the existing error code; a mixed or goods document
proceeds. The rule lives in one place server-side and is the same for
railway and private documents — there is no per-customer-type switch.

### The delivery challan gains its stage-3b statutory facts

Standalone delivery challans become a valid e-way-bill source. That
requires the facts migration 0056 deliberately deferred, added by a
wave-4 migration:

- per line: HSN code and goods/service marker (same shape as
  `tax_invoice_lines`, migration 0057's CHECK pairing code length to
  kind);
- per challan: movement reason (supply / job work / for own use /
  others, per the NIC vocabulary), consignee GSTIN where one exists, and
  the transport block (transporter id/name, vehicle number, transport
  document number/date, distance) — reusing the shapes already proven in
  `eway_bills`.

Work-scoped (railway) challans may carry the same facts optionally; they
are mandatory only on the path that raises an e-way bill.

### Linkage: exactly one source document

`eway_bills.tax_invoice_id` becomes nullable and the table gains a
nullable `delivery_challan_id`, with a CHECK that exactly one is set.
The invoice path keeps its guard (submitted invoice, now with the goods
test on lines); the challan path requires an issued standalone challan
whose lines carry HSN goods facts. One live bill per source document,
as today. Numbering, RLS, immutability guards and provider-state
machinery carry over unchanged — they key on the bill, not the source.

### Payload builder re-authored, transport reused

The deleted builders are not resurrected from history; the replacement
is written against the goods model: payload from lines (HSN, quantity,
unit, taxable value), party block from the source document's snapshots,
transport block from the challan/bill facts. The Whitebooks adapter,
credential handling, durable provider operations and reconcile flows are
already proven (EWB authenticate succeeded in sandbox certification) and
are reused as-is. Generation by IRN remains the invoice path's shape;
the challan path uses the direct generation API.

### Printable e-way bill document

The module renders a printable EWB summary PDF (bill number, validity
window, parties, line summary, transport facts) following the tax
invoice's existing server-side render precedent — HTML template, stamped
render metadata, immutable once the bill is generated. This is a
convenience print of facts the module already stores; the NIC portal
document remains the statutory original, and the render says so.

### UI

The e-way bill panel leaves the work-invoice corner: the invoice
workspace (W4-P4) and standalone challan detail each surface their own
bill lifecycle (generate / record NIC response / cancel / reconcile /
print), gated by the same applicability rule the server enforces.

## Consequences

- The 2026-08-10 disposition's operative sentence ("fresh generation is
  disabled until a goods/HSN delivery-challan model supplies the legally
  required item facts") is fulfilled rather than overturned — this ADR
  supplies exactly that model. The blanket nic-payload 409 goes away;
  the SAC-only refusal remains for service-only documents.
- Two migrations land: challan statutory facts, and the eway_bills
  linkage change. Both touch issued-document tables and require fresh
  human review under CONTRIBUTING.md.
- The NIC sandbox certification must be re-run for the new payloads
  before production use; the existing certification covered IRN
  registration and EWB authentication only.
- Railway-scope behaviour is unchanged: a SAC-only railway invoice still
  cannot raise an e-way bill, which is the 2026-08-10 ruling surviving
  intact.
