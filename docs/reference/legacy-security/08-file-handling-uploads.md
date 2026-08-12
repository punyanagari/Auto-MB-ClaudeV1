## 7. V5 File Handling & Uploads

| ASVS | Requirement | Implementation | Proving test | Status |
|---|---|---|---|---|
| 5.2.2 | Content validated by magic bytes (PDF/PNG/JPEG), never client MIME | Kernel upload validator | Unit: spoofed MIME rejected | TBD |
| 5.3.2 | Server-generated opaque storage keys; original filenames never become paths | Storage adapter | Unit | TBD |
| 5.3.2 | Path traversal impossible on any local fallback | Resolve-and-assert inside designated dir (read & write) | Unit: `..`, absolute paths rejected | TBD |
| 8.2.2 | Documents streamed via authenticated, tenant-scoped endpoints; store private | Signed/streamed access through API | Integration: anonymous & cross-tenant fetch denied | TBD |
| 5.2.1, 5.1.1 | Upload size limits & rate limits (LOA extraction throttled) | Edge/app limiter | Integration | TBD |

