# Auto-MB product contract

## 1. Product definition

Auto-MB is the post-award works-contract execution system for Indian government contractors, beginning with executing agencies and vendors working with Indian Railways.

It helps a contractor move from an awarded Letter of Acceptance (LOA) to defensible delivery, installation, measurement, billing, and payment records.

### First product promise

> Upload the LOA, confirm awarded quantities and rates, issue every Delivery Challan, and always know what was awarded, delivered, and left to supply.

### Primary users

- organisation owner;
- office/documentation staff;
- site staff;
- read-only auditor or accountant.

### Initial market boundary

- Indian Railways works and supply contracts;
- shared multi-tenant SaaS;
- assisted onboarding is expected;
- UI language is operational and calm, not AI-centric.

## 2. First sellable workflow

### LOA intake

1. An authorised user uploads an LOA PDF.
2. The system stores the original privately under an opaque object key.
3. Text extraction and the deterministic LOA parser produce a proposed header, schedules, items, totals, warnings, source spans, and confidence.
4. Uncertain fields retain raw source evidence and a review flag.
5. A human reviews and corrects the proposal.
6. Confirmation atomically creates the Work, schedules, and items.
7. Empty numeric and category fields are stored as null, never as zero or empty strings.

**No extraction output may directly create authoritative contract records without explicit confirmation.**

### Delivery Challan

1. A user creates a draft for a Work and consignee.
2. Lines reference awarded Work items and show awarded, issued, and remaining quantities.
3. At most one open draft Delivery Challan exists per Work.
4. Issue revalidates authorisation and quantities inside the same database transaction.
5. Issue assigns the next per-Work number without duplication or gaps under concurrency.
6. The system stores an immutable issued snapshot and generates a PDF from that snapshot.
7. Cancelling an issued challan requires a note, retains the number forever, reverses its ledger contribution, and never deletes history.
8. A signed-copy attachment may be added after issue.

### Quantity ledger

For each Work item:

```text
issued_quantity    = sum(quantity on issued, non-cancelled DC lines)
remaining_quantity = max(awarded_quantity - issued_quantity, 0)
```

The system must prevent issue above the awarded quantity unless the Work explicitly permits excess delivery.

## 3. Domain glossary

| Term | Meaning |
|---|---|
| Organisation | A tenant/legal entity using Auto-MB |
| LOA | Railway Letter of Acceptance defining the awarded contract |
| Work | One awarded contract created from one confirmed LOA |
| Schedule | A grouping of awarded lines inside a Work |
| Work item | One awarded description, unit, quantity, and effective rate |
| DC | Delivery Challan accompanying delivered material |
| Consignee | Railway/site party receiving material |
| MB | Measurement Book used for staged/partial billing; later milestone |
| PBG/PAC/DOC | Guarantee, acceptance, and completion lifecycle records; later milestone |

## 4. Initial roles

| Role | Default authority |
|---|---|
| Owner | Organisation, users, all Works, sensitive actions |
| Office | LOA, Works, Delivery Challans, documents |
| Site | Assigned Works, receipts, delivery/installation evidence |
| Viewer | Read-only |

Role is combined with Work scope (`all` or `assigned`) and explicit sensitive-action flags for issue and cancel.

## 5. Business invariants

1. **Work identity:** `work_code` is 1–20 uppercase letters, digits, `-`, `_`, or `/`, begins alphanumeric, and is unique forever within an organisation, including soft-deleted Works.
2. **Letter identity:** LOA letter number is unique forever within an organisation.
3. **One draft:** at most one draft DC per Work.
4. **Gap-free issue sequence:** numbers are assigned only at issue, serialised per Work, and never reused after cancellation.
5. **Quantity ceiling:** issued quantity cannot exceed awarded quantity unless excess delivery is explicitly enabled.
6. **Positive quantities:** quantities are strictly positive; authoritative rates are non-negative decimal values.
7. **No duplicate item line:** one Work item appears at most once in a DC.
8. **Date rules:** document dates are not in the future and not before the LOA date.
9. **Lifecycle:** drafts may be deleted; issued records cancel and remain immutable.
10. **Snapshot integrity:** issued PDF content is generated from the stored issued snapshot, not current master data.
11. **Rounding:** round each line to two decimals, then sum lines.
12. **Audit:** every create, confirm, issue, cancel, permission change, and destructive action records actor, time, entity, action, and relevant detail.
13. **Tenant boundary:** cross-organisation access always fails, regardless of guessed identifiers.

## 6. Data conventions

- Calendar dates are stored as PostgreSQL `date` and represented as `YYYY-MM-DD` in APIs.
- Money is PostgreSQL `numeric`, represented as decimal strings at API boundaries.
- Original filenames never become storage paths.
- Issued records are never hard-deleted.
- Soft-deleted Work identity remains reserved.
- All tenant-owned tables include `organisation_id`.

## 7. First-release acceptance

A design partner can:

- create an organisation and users;
- upload one of the real LOA fixtures;
- review and confirm extraction;
- create a Work;
- draft and issue a DC;
- print/download the issued PDF;
- upload a signed copy;
- see awarded, issued, and remaining quantities;
- inspect an audit timeline;
- remain isolated from every other organisation.

## 8. Explicit non-goals for the first release

- Measurement Books and RA bills;
- GST IRN or e-way-bill integration;
- procurement, POs, and quotations;
- broad reporting;
- mobile-native apps;
- offline sync;
- custom permission-builder UI;
- microservices, Kafka, Kubernetes, or distributed databases;
- a custom AI Software Factory.
