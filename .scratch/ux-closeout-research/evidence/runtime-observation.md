# Live entrance observation

Observed 2026-10-19 on workstation. Research only; fresh browser contexts with no credentials, no form submission, no account or conversation mutation.

## Identity

- Research source: clean integration/client-app at `9400dcc8ca970f42ba4e02d71022d793a684039a`.
- Live ingress unit: `/home/developer/.config/systemd/user/hepi-ingress.service`, ExecStart and WorkingDirectory name `release-1873d24`.
- Live artifact provenance: `/home/developer/.local/share/hepi/client/release-1873d24/provenance.json`, revision `1873d244289db29e5aaa62118e3dfc1b30ffabb5`, dirty false, built 2026-10-18T13:50:23.811Z. This proves ingress artifact identity, not that every running process loaded identical source.
- `systemctl --user show hepi-ingress.service hepi-backend.service hepi-gateway.service -p Id -p ActiveState -p FragmentPath`: all active; command exit 0. Service activity alone does not establish workflow health.

## Browser observation

Command: `node /home/developer/Documents/dev/hepi-harness/.scratch/ux-closeout-research/evidence/landing-observation.mjs`

Exit: 0. Raw log: `/home/developer/.pi/agent/sessions/--home-developer-Documents-dev-hepi-harness--/tasks/01a149c2-9296-76fb-9341-cff9a365fbbb/bash-1.log`. Browser target revision is live ingress artifact `1873d244289db29e5aaa62118e3dfc1b30ffabb5`; runner uses Playwright installed in integration checkout `9400dcc8`.

Both desktop 1440x900 and mobile 390x844 fresh contexts loaded `http://192.0.2.10:30141/` with HTTP 200. Document title: `Pi Web`. Rendered body text: exactly `unauthorized`. `/api/descriptor` returned 401. No pageerror or horizontal document overflow observed.

The request refusal is an expected response without admission. User-facing problem is absence of a rendered login/recovery action on this entrance. Parent subsequently checked source history: current gate handling is present in Workbench/web-session-gate, introduced after live revision by `41fabf3` (later readiness change `2c6f801`). Old `1873d24` Workbench has no WebSignIn/web-auth/admissionOf references. Classify as an undeployed source fix; immutable release acceptance still required. No attempts to circumvent authentication were made.

Artifacts: [script](landing-observation.mjs), [structured results](landing-observation.json), [desktop screenshot](desktop.png), [mobile screenshot](mobile.png).

## Limits

No authenticated workflows were exercised on live deployment. This is an entrance observation, not a full browser acceptance result. OAuth, mutations, uploads, commands, terminals, models, and conversation navigation findings elsewhere in research remain source-derived unless their notes cite a separate actual run. Existing validation logs establish only their own source revision and scope.
