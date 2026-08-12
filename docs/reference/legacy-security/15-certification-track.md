## 13. Certification track (context for auditors)

- **Bar:** OWASP ASVS 5.0 **Level 2**; auditors test per OWASP WSTG.
- **Auditor requirement — RESOLVED (CEO, 29/07/2026): STQC specifically is
  required.** The open verification that stood here since this section was
  written ("confirm whether STQC specifically or any CERT-In empanelled
  auditor is acceptable") is answered by the certificate-consuming
  authority's requirement. Planning consequences, recorded so scheduling
  starts from reality: STQC lab engagement carries government-lab lead
  times and queue-based scheduling (book early, well before the internal
  pre-audit completes), the fee schedule is STQC's own (no competitive
  quotes), and the change-classification matrix below must be agreed **in
  writing with STQC** — its acceptance of the delta-audit model is now the
  single most schedule-critical unknown in the certification track.
- **Sequence:** internal pre-audit (own pen test + green §2 gates + this
  matrix complete for shipped scope) → auditor engagement with the
  change-classification matrix agreed **in writing** → fix/retest →
  clearance certificate → certified release train + annual re-audit.
- **Change classification (summary; full text archived):** cosmetic/UI →
  self-attest · new read-only screen on audited APIs → delta scan · new
  module → delta audit · kernel/authz/session/crypto → full re-audit.
- Certificates are **version-bound, ~1 year max** — the kernel boundary
  exists to make every re-audit a delta, not an excavation.

