## 8. V1/V3 Encoding, Sanitization & Web Frontend

| ASVS | Requirement | Implementation | Proving test | Status |
|---|---|---|---|---|
| 1.2.1, 1.3.2 | Output encoding: framework auto-escaping only | React; `dangerouslySetInnerHTML`/`eval`/string-HTML lint-banned | ESLint frontend-ban rules (§2.1, [SEC-4]) via `pnpm lint`; discrimination proven by `scripts/probe-eslint-gates.mjs` (`pnpm eslint-gates:probe`) | TBD |
| 3.4.3 | CSP: same-origin scripts, never weakened | Header middleware; CSP change = kernel-class review | ZAP baseline + header snapshot test | TBD |
| 3.4.1, 3.4.4, 3.4.5, 3.4.6 | Security headers (HSTS, nosniff, frame-ancestors, referrer-policy) | Header middleware | Header snapshot test | TBD |
| 3.5.1, 3.5.3 | CSRF: origin check (or equivalent) on all mutating requests — mechanism & rationale documented here | Kernel middleware; **document the chosen mechanism in this row** | Integration: cross-origin mutation rejected | TBD |

