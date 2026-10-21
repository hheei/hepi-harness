# Workbench, files, SSH, terminal closeout

Date 2026-10-19; source integration/client-app `9400dcc8ca970f42ba4e02d71022d793a684039a`. Static traces and existing ticket records, not fresh native/browser acceptance. Parent checked key claims in source. Paths below refer to integration worktree.

## Delivered baseline: preserve and verify rather than reimplement

- Shared file upload exists: `FileExplorer.tsx:729-738` opens standard file input; `packages/ui/src/lib/file-seam.ts:235-276` builds FormData and XHR, attaching device bearer when needed. Thus lack of custom Rust picker does not prove App upload absent. Actual packaged native picker behavior still needs supported-platform acceptance.
- Conflict precheck/replacement is present in FileExplorer and file seam. File read/tree/Git diff and workspace/worktree management already have owning APIs and UI.
- Read-only viewer is an explicit product scope (`docs/workbench.md`); manual source editing is optional new scope, not an existing broken save action. Upload and agent writes remain supported mutations.
- SSH workbench tickets 01,02,03 are delivered/reviewed/integrated according to integration `.scratch/ssh-remote-workbench/issues/`; primary scratch status is stale. Do not reopen ticket 02 from old metadata.
- DOCX preview delivered in ticket 05. `packages/protocol/src/files.ts:49` sets **10 MiB raw-byte bound**, not 500 KiB; `docx-preview.ts` reads bounded bytes and extracts text via mammoth. This is text preview, not layout-faithful Word rendering.
- xterm with FitAddon, terminal writer and fan-in/recovery already exist (`TerminalPanel.tsx:81-140`, terminal fan-in modules). Preserve renderer choice.

## W1 — App native download/save (high for desktop parity, explicit absence)

Journey: save execution-host file to desktop from bearer App. `file-seam.ts:97,161-166` returns named `NATIVE_SAVE_REQUIRED` for non-cookie connection. Cookie Web can navigate authenticated download URL; bearer cannot authenticate a plain element URL. This is an explicit missing feature, not proof all file transfer is absent.

Owner: shared file action + App platform save adapter + connection-authenticated resource stream. Closeout: native destination picker and bounded streaming save through current authenticated transport; preserve cancellation, partial file outcome, device credential placement and connection identity. Do not buffer entire large download or put token in URL. Native plugin choice remains implementation detail.

Acceptance: choose destination/cancel/overwrite, large file bounded memory, progress, completion/failure, connection switch does not silently save another host file, native cancellation cleans owned partial file according to stated policy. Existing Tauri measurements favor <=1 MiB transfer slices; keep debug/6 jobs/incremental/shared target if native build later required.

## W2 — File not found vs server failure (medium, source-derived)

Journey: tree or chat link points to file deleted/moved by ongoing work. `packages/gateway/src/workbench/index.ts:72-80` flattens errors other than path_denied into operation_failed; `files-surface.ts` maps to 500. Missing file can therefore show alarming generic failure.

Closeout at workbench protocol/filesystem boundary: named missing outcome carried through local and SSH, then understandable file-removed state with refresh/back. Preserve distinction from unreachable host, timeout, unsupported preview and empty file.

Acceptance: local/SSH deleted target reports unavailable file; real transport failure still reports host failure; refresh updates selection without blank document pretending success. Browser reproduction remains needed for exact wording and reset behavior.

## W3 — SSH terminal and failure acceptance (high verification priority; existing tickets)

Integration plan: SSH 01-03 delivered; 05 DOCX delivered; 06 terminal parity/abort, 07 watch research, 08 failure-boundary acceptance and 04 final system acceptance remain open in integration scratch. Ticket 04 header still lists 05 open despite delivered ticket: reconcile dependencies, not reimplement DOCX.

Closeout: use existing 06/08/04 seams. Exercise normal remote host offline, caller cancel, timeout, non-repo Git, remote read/transfer limits and errors; ensure UI exit/retry are truthful and do not replay uncertain writes. Terminal open/input/resize/reconnect/close should be checked against packaged bearer App and Web, local and SSH. Existing source implementation is not current packaged acceptance.

Acceptance: reachable profile → directory selection → conversation binding → tree/diff/preview/upload → terminal, with host labels visible; offline/cancel/timeout produces actionable state; request/reconnect uses existing terminal identity/cursor; close of failed tab remains possible. No security-control bypass testing is proposed.

## W4 — Upload cancellation and operation ownership (investigate, not established bug)

`file-seam.ts:235-276` XHR checks client disposal before send and supports onabort callback, but this function exposes no cancellation handle/signal and does not itself subscribe to client disposal. Determine actual desired UI when user changes workspace/profile mid-upload: continue visibly on original target, or request cancellation with uncertain-write outcome. Cancellation cannot promise rollback once server may have written files.

Closeout direction depends on observed user workflow. Preserve original host and names in progress/result; prohibit late old upload success from being mistaken for current folder state. Acceptance uses a controlled normal large upload and switch/close/cancel, not live user files.

## W5 — Live watch (research/optional, explicit limit)

FileViewer shows watch-unavailable state; current protocol lacks live event subscription. Manual refresh is distinct from watch. Continue existing ticket 07 protocol research across local/SSH event delivery, lifecycle, overflow/resync and cancellation before deciding implementation. No fixed-interval polling advertised as live watch. Acceptance if kept deferred: label/manual refresh truthful; if implemented later: changes/deletion/reconnect/overflow converge via bounded refresh.

## W6 — Mobile terminal convenience (low, unproven defect)

xterm onData/hidden textarea owns terminal text input; absence of custom composition buffer is not evidence of broken Chinese IME. `TerminalPanel.tsx:105-114` custom keydown only handles paste/selected copy. Separate actual native/CJK/mobile keyboard acceptance from optional Ctrl/Esc/Tab touch ribbon. Only observed input loss or blocked workflow should become a defect; retain xterm.

## W7 — Preview limit and progress wording (medium/low, source-derived)

`files-surface.ts:384-395` serves one bounded preview, sets `previewOnly: true` and `nextOffset: preview.sizeBytes`, and refuses additional truncated offset reads. `FileViewer.tsx:1348-1362` correctly disables the button and says Preview limit reached, so this is not a broken clickable Load more action. However it displays nextOffset / size, making a truncated preview appear as full-size / full-size. Use explicit previewed bytes versus total, or an honest preview-limit label without a false progress ratio. Local large-text preview and SSH >16 MiB refusal also differ (docs/workbench.md:403-406); keep named limit visible without silently widening transfer policy. Acceptance: file beyond preview bound shows partial content with accurate limit wording; large remote refusal differs from missing file and offline host. This is a presentation/contract limit candidate, not a mandate to add general file paging.

## Corrections from manual review

Scout initially called SSH 02/03 outstanding and DOCX raw limit 500 KiB. Parent checked current integration tickets and protocol: 02/03 integrated; raw DOCX limit 10 MiB. Scout upload claim is source-supported, but no fresh native acceptance was run. Missing custom mobile IME code is not a bug finding. Scout had no write access; parent created this report from checked evidence.

No runtime code or deployment changed.
