# SECURITY.md — ASVS Level 2 Traceability Matrix (index)

This document — the legacy repository's single security ledger, imported
as historical evidence — was one 478 KB file with table rows thousands of
characters long. It is now split by topic under
[`legacy-security/`](legacy-security/), with **every byte preserved
verbatim**: concatenating the seventeen files below in order reproduces
the imported file exactly (SHA-256
`ec754a5abb0037dd8d8e8b0b69127bbdb46e9a8b7c18b30a1480e58c5ef9aed7`, the
same hash `IMPORT-MANIFEST.json` records for the original
`docs/reference/legacy-security.md`). Nothing here is active instruction;
see `docs/reference/README.md` for how to read legacy material.

| File | Contents |
| --- | --- |
| [00-preamble.md](legacy-security/00-preamble.md) | Status, governance rule, scope note |
| [01-conventions.md](legacy-security/01-conventions.md) | §0 Conventions, ASVS v5.0.0 mapping and chapter completeness |
| [02-architecture-kernel.md](legacy-security/02-architecture-kernel.md) | §1 Architecture: the security kernel |
| [03-security-gates.md](legacy-security/03-security-gates.md) | §2 Security gates (enforced vs named-but-missing) |
| [04-authentication.md](legacy-security/04-authentication.md) | §3 V6 Authentication |
| [05-session-management.md](legacy-security/05-session-management.md) | §4 V7 Session Management |
| [06-authorization.md](legacy-security/06-authorization.md) | §5 V8 Authorization |
| [07-validation-business-logic.md](legacy-security/07-validation-business-logic.md) | §6 V2 Validation & Business Logic |
| [08-file-handling-uploads.md](legacy-security/08-file-handling-uploads.md) | §7 V5 File Handling & Uploads |
| [09-encoding-web-frontend.md](legacy-security/09-encoding-web-frontend.md) | §8 V1/V3 Encoding, Sanitization & Web Frontend |
| [10-api-web-service.md](legacy-security/10-api-web-service.md) | §9 V4 API & Web Service |
| [11-cryptography-communication.md](legacy-security/11-cryptography-communication.md) | §10 V11/V12 Cryptography & Communication |
| [12-logging-audit.md](legacy-security/12-logging-audit.md) | §11 V16 Logging & Error Handling / Audit |
| [13-configuration-data-protection.md](legacy-security/13-configuration-data-protection.md) | §12 V13/V14/V15 Configuration, Data Protection, Secure Coding |
| [14-org-tooling.md](legacy-security/14-org-tooling.md) | §12A Org tooling (incl. the skill supply-chain rows) |
| [15-certification-track.md](legacy-security/15-certification-track.md) | §13 Certification track (context for auditors) |
| [16-changelog.md](legacy-security/16-changelog.md) | §14 Changelog (the bulk of the evidence, append-only) |
