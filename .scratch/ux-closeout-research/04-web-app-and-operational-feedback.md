# Web, App, admission and operational feedback

Date 2026-10-19. Code baseline: clean integration/client-app `9400dcc8ca970f42ba4e02d71022d793a684039a`. Live ingress artifact `1873d244289db29e5aaa62118e3dfc1b30ffabb5`. Parent verified source paths and authored this report. Paths below refer to integration worktree. Evidence tiers are explicit; no authenticated live mutations performed.

## A1 — Live first-open admission blocked (highest priority, fixed source not deployed)

Fresh no-cookie desktop and mobile contexts on live origin render only unauthorized after descriptor 401, with no action. Parent inspected screenshots and browser output. See [runtime evidence](evidence/runtime-observation.md): exact command, target release, exit 0 and raw log; exit 0 means observation completed, not usable entrance.

Current `packages/ui/src/lib/web-session-gate.ts:46-64` distinguishes Web sign-in, refused bearer and unreachable/configuration errors. `packages/ui/src/workbench.tsx:119-147,227-229` queries descriptor/login status and renders WebSignIn. History `git log 1873d24..9400dcc8 -- packages/ui/src/workbench.tsx packages/ui/src/lib/web-session-gate.ts` includes gate fix `41fabf3` and readiness `2c6f801`; old Workbench at live SHA lacks WebSignIn/web-auth/admissionOf.

Closeout: publish current source through existing immutable release mechanism and perform normal fresh-user entrance acceptance against actual artifact. This research performs no deployment and does not authorize duplicate gate implementation. Login failure, slow/unreachable deployment and bearer reconfiguration remain distinct states.

Acceptance: fresh desktop/mobile cookie host presents login; normal valid admission renders accepted descriptor; rejected login is readable; no business UI appears over unadmitted identity. Use isolated acceptance credentials, no host-keyring mutation.

## A2 — Settings logout calls obsolete route (high priority, source-confirmed mismatch)

Journey: signed-in Web user clicks Log out in Settings General. `packages/ui/src/components/SettingsPanel.tsx:118-128` sends DELETE `/api/web-auth`. Current ingress implements GET `/api/web-auth` and DELETE `/api/web-logout` (`packages/gateway/src/ingress/index.ts:374-395`). No Backend web-auth handler was found in server.ts. Thus UI does not call current cookie-clearing handler; source indicates ordinary logout fails or is forwarded without clearing cookie. This is source tracing, not an authenticated live reproduction.

Visible section is gated only on public webAuthEnabled (`SettingsPanel.tsx:370-379`); a bearer App on a login-enabled deployment can also show a Web-cookie logout action that cannot revoke/forget its device credential. Separate host-appropriate action and credential semantics.

Closeout at owning request/UI seam: use current ingress logout contract, render it for cookie host, and show logout failure without pretending session ended. Device disconnect/reconfigure uses App shell, not Web logout. No new auth service required.

Acceptance: normal signed-in Web logout clears cookie and returns to sign-in; subsequent normal descriptor read needs admission; bearer App offers device connection management rather than cookie logout. Verify on isolated fixture, not by changing live user session during research.

## A3 — Revoked/incorrect App connection lacks in-app recovery path (high desktop usability priority, source-derived)

`apps/app/src/main.tsx:29-68` renders Configure only when connection is null; a syntactically valid stored connection renders Workbench. Refused bearer in `web-session-gate.ts:54-55` tells user to configure again in shell, but Workbench renders only refusal paragraph. `apps/app/src/shell.ts:102-107` already exports configureConnection/forgetConnection; source search across apps/app/src found no forgetConnection caller outside shell definition. `apps/app/src-tauri/src/main.rs:185-207` has app_configure/app_forget restart commands; headless --configure/--forget also exist. Thus capability exists, but ordinary UI recovery is missing; do not say credentials cannot be recovered at all.

Closeout: host-provided Configure connection / Disconnect action on refused and connection-management surfaces. Reuse shell storage/restart semantics because origin policy is constructed before WebView exists. Explain refusal versus network failure and preserve explicit choice to replace/forget connection.

Acceptance: stored revoked bearer shows reachable configure action, replacement restarts and admits new descriptor, user can disconnect without command line; cancellation preserves old configuration. Keyring acceptance must use isolated Secret Service bus or mock store, never developer account entry.

## A4 — Connection changes and late identity (investigate, exported-component contract)

`workbench.tsx:96-148` retains descriptor/admission while next connectionKey probe runs; identity at 162-169 combines configRef.current.profile with existing descriptor. Current source therefore warrants controlled profile-switch scenario for stale identity/readout and lifetime disposal. However current AppHost reads one stored connection at startup and shell replacement restarts; source alone does not prove ordinary current App users can hot-switch profiles in place.

Closeout if dynamic host switching is supported: scope admission/descriptor/connection to configuration generation and render connecting until new read settles, fence late old results, preserve per-connection drafts/cache identity. Do not invent a new lifecycle store. First prove normal supported trigger and actual render/readout impact.

Acceptance: controlled two-backend/slow-descriptor scenario; new profile never reports old backend or account; old results cannot install scope; failed new admission has host-appropriate recovery. Native restart path separately proves clean initial identity.

## A5 — Recoverable network and load states (high where workflow blocked)

Admission refused for network/5xx currently produces plain paragraph; selected session errors have separate bare state (see navigation N4). Avoid generic Retry that resends writes: distinguish read reconnect/descriptor retry from lost mutation request-ID readback. Offer retry/back/configure as appropriate while keeping original operation outcome truthful. Preserve confirmed content and drafts when possible.

Acceptance: temporary outage recovers via read retry; no valid previous connection is relabeled; queued/lost mutation is looked up with existing identity and not silently replayed. Browser/network interruption reproduction still needed for exact message and progress behavior.

## A6 — PWA, offline, completion notifications (delivered scoped capability)

Current `docs/migration-status.md:935-952` identifies owning sources: apps/web/src/pwa.ts, public/sw.js, manifest/offline page, packages/ui/src/lib/browser-notifications.ts. Web worker caches static hashed assets/offline page, not /api; App registers no service worker. Completion page notifications follow answered lifecycle while page backgrounded; recovery/reconnect/resync must not invent completion. Universal background push is explicitly a non-goal, not an accidental missing button.

Closeout is current artifact/browser acceptance, not replacement push architecture. Real browser installation/notification permission behavior remains distinct from headless install-surface checks; supported secure-origin requirements and platform behavior should remain visible. No claim of browser-native install prompt or full closed-app push acceptance in this research.

Acceptance: installed surface/offline navigation, API never served stale success from cache, reconnect truthful, one real completion notice and none from resync/restart acquisition; denied permission remains understandable. Observe supported browser/platform only.

## A7 — Artifact/platform acceptance and legacy retirement (existing tickets)

Integration `.scratch/client-app/issues/16-integration-and-direct-cutover.md` records packaged/debug-native driver and sandbox/readiness work delivered, Web cutover done at older release, but full target acceptance not complete. Target evidence is not interchangeable: test-stack checks are not current immutable-release acceptance, debug native is not release-performance measurement, archive generation is not system install. Android SDK/toolchain is absent.

Ticket 17 remains blocked by 16 and owns old Next/BFF routes/config/dependencies/retired e2e cleanup. `apps/web/package.json` now runs Vite while retaining Next dependency/files entries and older scripts. Preserve historical validation; close stale drivers through owning retirement/SSH acceptance work rather than claiming a current UI regression from obsolete driver failure.

Closeout: finish actually supported desktop/Web matrix against final artifact and own logs/revisions, distinguish Android blocked scope, then retire old entries with caller dispositions. No Android prerequisite should be silently treated as evidence desktop works. Release acceptance scope must name supported target.

## Mobile, accessibility, internationalization evidence limits

Only fresh unauthenticated landing was newly observed at 390x844; no horizontal overflow/pageerror there, but body was unusable unauthorized. This establishes no authenticated mobile usability or accessibility pass. Future focused journeys: dialogs focus/escape, keyboard navigation, touch hit targets, narrow rail/search/settings, IME in composer/terminal, reduced-motion jump and screen-reader status announcements. These are acceptance candidates, not unproven defect claims. Configure/admission/preview-limit surfaces include English literal strings; localization polish can be recorded after material flows.

## Source navigation and verification

Reused exact parent/scout locations for Workbench, gate and App entry. Narrow graph query `SettingsPanel logOut web-auth` returned SettingsPanel and historical auth references; focused current source confirmed route mismatch. Rust source is apps/app/src-tauri/src/main.rs, not apps/app/src/main.rs. No live login/logout, credential/keyring writes, deployment, build or broad test run performed.
