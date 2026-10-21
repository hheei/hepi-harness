# Image history checks

Status: fixed test observation, product image behavior unchanged. User prioritized the three historical C1 failures.
This is a dated record (archive revision `e6c182f`, worktree `.dev/worktrees/architecture-consolidation-10`): those paths
are historical, and the driver it patched still exists as `apps/web/e2e/ux-image-submit.mjs`. Nothing is pending here — a
"resource image" patch or gap this record was once read as standing for does not exist on the current line; image
submission, storage and rendering are delivered by [ux-follow-up 06](../ux-follow-up/issues/06-image-submission-durable-history.md).

## Reproduction and classification

At clean e6c182f using the retained production build Be4b114CesOWD7SHhEc6I (built from e20ab94), the original image driver returned exit 1: 18 checks passed and the three display checks failed after submit, browser reconnect and backend restart. The controlled provider received the exact original PNG bytes.

Ranked hypotheses: inline-data-only test selector; missing UI image projection; broken/auth-refused image recovery URL. A focused browser probe at the first failure found a committed image with src /api/sessions/7/entries/16/tool-result-image?blockIndex=1, complete=true, naturalWidth=1, HTTP 200 and exact submitted PNG bytes. The selector was wrong. This is an ordinary test logic error tied to an obsolete representation assumption, not an architectural defect or a product rendering/storage failure. Earlier statements calling C1 an image-projection gap are corrected.

## Fix

Commit 34bfaa9 changes only apps/web/e2e/ux-image-submit.mjs. Each of the three display checks finds images in committed transcript entries, waits for decoding, verifies a rendered image and fetches its source to compare exact original bytes. It handles inline and deferred sources. Composer previews cannot satisfy these checks. Rejected submissions still require zero transcript images and a retained composer attachment. All 21 assertion names remain; none was removed or weakened to a mere element-presence check. Temporary DEBUG-image-history probe removed.

## Evidence

Working directory: .dev/worktrees/architecture-consolidation-10, branch fix/web-image-history. Command: HEPI_UX06_WEB_PORT=45806 HEPI_UX06_BACKEND_PORT=45807 node apps/web/e2e/ux-image-submit.mjs.

- Baseline: e6c182f, clean, exit 1, 18 pass / 3 fail, .dev/verify/image-history/baseline.log.
- Probe: e6c182f plus temporary observation only, exit 1 with the same three names; actual decoded image/HTTP status/bytes captured in probe.log.
- Fix: e6c182f plus single driver patch (dirty-before paths captured in fix-dirty-before.txt), exit 0, 21 pass / 0 fail, fixed.log. Published patch is 34bfaa9; the run is not relabeled as a clean-commit run. node --check passed.
- Product sources and production build unchanged, so prior package/type/unit checks remain reusable. No build, production deployment/restart or paid model call. Driver cleanup closes its fixture children.

The source-owning verification/migration guides point to this correction. Original architecture-consolidation reports retain their historical failing results. Worktree C2 is a separate baseline, outside this image task.
