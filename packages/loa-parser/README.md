# `@auto-mb/loa-parser-parser`

Pure deterministic parser and regression corpus adopted from the original Auto-MB snapshot.

## Boundary

- no database;
- no network;
- no application imports;
- no authoritative writes;
- output is proposal data for human review.

The six fixtures and `corpus.json` are protected regression evidence. Changes require an explicit parser issue, fixture provenance, and updated tests. Historical ticket/decision references inside imported comments are provenance only; they are not active governance in this repository.
