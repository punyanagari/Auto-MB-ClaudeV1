# ADR-0006: Organisation entry and the contract-source document pack

- Status: Accepted
- Date: 2026-08-11

## Context

Auto-MB previously combined organisation selection and organisation creation on the normal post-sign-in screen. That made a rare, legally significant tenant-creation action appear during every login and required a user with only one active membership to make a redundant choice.

LOA intake also treated the Letter of Acceptance as the only source document. In practice, payment stages, warranty or maintenance periods, PBG and security-deposit release clauses, and item-level technical specifications may live in the NIT, tender document or Contract Agreement instead.

The user approved a revised entry flow and an optional contract-source pack during the product-experience overhaul.

## Decision 1: organisation entry follows active membership count

After authentication, Auto-MB loads the user's active organisation memberships and the organisations visible through the membership-filtered API.

- Zero active organisations: show first-organisation onboarding and invitation guidance.
- Exactly one active organisation: enter it automatically.
- Two or more active organisations: require the user to select the active tenant.
- The organisation switch control is visible only when two or more active organisations remain available.
- Creating an additional organisation is a deliberate account-level action exposed from Settings, not a form shown during ordinary login.

Organisation selection remains navigation state, never authority. The server membership check, role, Work scope, Work assignments, explicit sensitive-action flags, PostgreSQL membership floor and RLS continue to decide every request. Disabled or absent memberships are not offered and cannot be recovered by altering browser state or tenant headers.

One Organisation remains one legal entity. Creating another organisation creates a new tenant with separate members, Works, numbering, documents and audit history; it does not create another legal profile inside the current tenant.

## Decision 2: LOA intake may include an optional contract-source pack

Alongside the required LOA PDF, an authorised owner or office user may optionally upload one document of each supported kind:

- Notice Inviting Tender (NIT);
- Contract Agreement;
- tender/specification document.

Each supporting document uses the existing private upload boundary: PDF magic-byte and size validation, malware scanning when configured, server-generated tenant-prefixed object keys, authenticated access and SHA-256 evidence.

Before the bytes are accepted into trusted storage, deterministic text extraction must identify both:

- the same tender number as the reviewed LOA proposal; and
- the same name of work as the reviewed LOA proposal.

A missing or mismatched identity rejects the document. Auto-MB does not permit an operator to override that mismatch because attaching another tender's clauses or specifications to a Work would corrupt the contractual baseline.

## Decision 3: tender extraction is proposal evidence

The deterministic tender parser may propose:

- the Work-level payment-category matrix;
- Work-wide or item-specific warranty and maintenance periods;
- PBG release clauses;
- security-deposit release clauses;
- item-specific technical specifications and their proposed item references.

The raw text blocks, extracted identity and review flags remain attached to the source document. Parser output never directly creates authoritative Work records.

Item references are suggestions until the reviewer maps them to reviewed LOA item rows. Unresolved or ambiguous mappings remain visibly unconfirmed rather than being guessed.

## Decision 4: the manually reviewed payment matrix is authoritative

The operator may enter or edit the payment matrix manually during LOA review. The matrix must satisfy the existing category and 100-percent invariants before confirmation.

When tender evidence contains a proposed matrix, Auto-MB compares the manual values with the extracted values by payment category and stage. Differences produce a persistent warning and are recorded in the confirmation evidence. They do not silently overwrite the user's reviewed matrix and they do not prevent confirmation merely because the tender parser differs.

The confirmed manual matrix is written atomically with the Work and is the authoritative matrix used by later Measurement Book and billing calculations. The tender proposal and mismatch detail remain immutable provenance so an auditor can see what was printed and what the reviewer accepted.

## Consequences

- Sign-in becomes shorter for the common one-organisation case and safer for multi-organisation operators.
- Organisation creation is less discoverable during normal login but remains available deliberately under Settings and in the zero-membership onboarding state.
- LOA intake becomes a contract-source review workflow rather than a single-file parser.
- Supporting documents cannot be casually attached to an unrelated Work.
- The product preserves human authority over payment terms while making discrepancies explicit and auditable.
- Confirmation now spans the Work baseline, supporting-document links and the reviewed payment matrix in one transaction.

## Non-goals

- Multiple legal entities inside one Organisation.
- Model or parser output directly committing contractual facts.
- Automatically resolving ambiguous item references.
- Treating the Contract Agreement as mandatory for every Work.
- Allowing an identity mismatch to be bypassed by a normal operator.
- Moving authoritative payment arithmetic into the browser.
