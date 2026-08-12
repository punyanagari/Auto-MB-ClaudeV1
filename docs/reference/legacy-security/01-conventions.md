## 0. Conventions

| Column | Meaning |
|---|---|
| **ASVS** | Control ID from the ASVS 5.0 checklist (populate exact IDs from the official checklist during Stage 0 — do not cite from memory) |
| **Requirement** | One-line paraphrase of the control |
| **Implementation** | File/module/mechanism that satisfies it |
| **Proving test** | The automated test (or CI gate) that fails if the control regresses |
| **Status** | `DONE` · `PARTIAL` · `TBD` · `N/A (reason)` |

Statuses are claims to an auditor — never mark `DONE` without a named
proving test. `N/A` rows must state why (e.g. "no OAuth flows in scope").

> ASVS column mapped against OWASP ASVS v5.0.0 (tag v5.0.0, May 2025). **Spot-check discharged 27/07/2026:** every distinct ID cited in this file (47 as of this edit) was checked against the official v5.0.0 flat JSON (`OWASP_Application_Security_Verification_Standard_5.0.0_en.flat.json`) and all resolve to real v5.0.0 requirements; the V3 (Web Frontend Security), V12 (Secure Communication) and V14 (Data Protection) chapter mappings are confirmed against that raw text, not a summary. **No V4 IDs are cited anywhere in this file** — §9's heading is a topic label; its rows cite V2/V15/V1/V16/V6 controls. Only one cited control is above the L2 bar (8.3.2, L3) and it is labelled as such in §4.
>
> **Chapter completeness (all 17 v5.0.0 chapters accounted for).** §3–§12 cover V1, V2, V3, V4, V5, V6, V7, V8, V11, V12, V13, V14, V15 and V16. The three remaining chapters carry no rows because they are **N/A to this architecture**, stated here rather than silently omitted: **V9 (Self-contained Tokens)** — sessions are server-side (§4/V7), the product mints no self-contained bearer token (JWT/PASETO) whose claims a client could forge or replay, so V9's token-integrity controls have no surface; **V10 (OAuth and OIDC)** — no OAuth/OIDC flows in scope (the DC-first milestone authenticates against the product's own credential store, no third-party IdP, authorization-code, or token-exchange path); **V17 (WebRTC)** — no WebRTC, real-time media, or peer-to-peer data channels anywhere in the product. Each becomes live only if the named capability is added, at which point its chapter earns a section here.

---

