# Railway bill panel — review screenshots

`CONTRIBUTING.md` requires screenshots for visible UI changes, and this is
the first change in the repository to carry any, so it is also the first
directory of images. Four states of `apps/web/src/views/RailwayBillPanel.tsx`,
captured at 980px in the light theme against the real production stylesheet:

| File             | State                                                                                         |
| ---------------- | --------------------------------------------------------------------------------------------- |
| `1-no-bill.png`  | No bill recorded — the measurement is outstanding with the railway, and the upload is offered |
| `2-verified.png` | A verified bill: its extracted facts, the full signature panel, and closure offered           |
| `3-refused.png`  | A recorded bill the verdict refuses — closure disabled, with the reason in words              |
| `4-closed.png`   | The measurement closed — the settlement date stated, no further action offered                |

These are **review artefacts, not product assets**. Nothing renders them and
nothing links to them from the application. If the owner would rather this
repository keep tracking no binaries — it tracked none before this — deleting
this directory costs nothing.

They were captured from a throwaway Vite harness that mounted the panel with a
stubbed API client, not from the e2e suite: the panel sits inside the
Measurement Book detail of the workspace shell, and driving Playwright to it
would have meant mocking the whole Work → Measurement Book → bill chain for
four still images. The harness was deleted after capture.
