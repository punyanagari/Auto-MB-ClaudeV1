## 10. V11/V12 Cryptography & Communication

| ASVS | Requirement | Implementation | Proving test | Status |
|---|---|---|---|---|
| 12.2.1, 3.4.1 | TLS everywhere; HSTS | Edge/load balancer config | IaC scan + ZAP | TBD |
| 13.3.1 | Secrets never in repo; app refuses to start with missing/placeholder/short (<32) signing secrets | Boot-time secret validation | Unit: boot fails on bad secret; secretlint (§2.1) | TBD |
| 13.3.1, 11.3.2 | Per-tenant GSP credentials envelope-encrypted (KEK in managed KMS), decrypted only in worker at call time | Kernel crypto envelope | Unit + integration (GST phase) | N/A until GST phase |

