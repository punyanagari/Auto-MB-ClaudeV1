# Adoption from the original Auto-MB repository

## Adopted now

| Asset                                              | Treatment                                                                       |
| -------------------------------------------------- | ------------------------------------------------------------------------------- |
| Architecture-independent product specification     | Preserved as historical reference; distilled into `docs/PRODUCT.md`             |
| Six real IREPS LOA fixtures and corpus manifest    | Copied into `packages/loa-parser/fixtures`                                      |
| LOA parser source and tests                        | Copied with minimal package renaming; behaviour preserved                       |
| Work-code validation and challan-prefix concepts   | Re-expressed in the active product contract; port during Work module            |
| Tenant-owned rows and PostgreSQL RLS intent        | Strengthened into shared multi-tenancy from first pilot                         |
| Date-only, decimal-money, immutable-snapshot rules | Retained as non-negotiable invariants                                           |
| Gap-free numbering and one-draft rules             | Retained and implemented across legal-document workflows with concurrency tests |
| Security traceability idea                         | Retained in smaller evidence-driven form                                        |

## Preserved only as reference

- original `PRODUCT-SPEC.md`;
- original `ARCHITECTURE.md`;
- original `SECURITY.md`;
- LOA parser research contract;
- selected decisions concerning stack, tenancy, and production posture.

Reference material is not automatically authoritative. A new ADR or active document must explicitly adopt a rule before new code depends on it.

## Not adopted

- the original repository's broad `.claude/agents`, routing, loops, memory,
  and custom orchestration. The current repository has only a small set of
  task-specific verification/review agents under `.agents/` and `.codex/`;
- file-per-ticket DAG and dashboard machinery;
- frozen-path and decision-binding guard system;
- vendored design-skill trees;
- single-tenant-per-deployment launch model;
- the legacy plan's generic security-kernel package (its useful properties — RLS binding, advisory-lock numbering — are rebuilt as plain modules instead);
- speculative scale infrastructure;
- hundreds of historical governance documents.

## Provenance

The imported parser assets originate from the uploaded `Auto-MB-main.zip` snapshot whose archive comment identifies commit:

```text
a39d2f7e442df64c88663785fb9168fe49990c7a
```

The new repository must preserve Git history from this point forward; imported file history is documented here because it cannot be carried across as native commits in this clean-sheet repository.
