# High-value test review

Scope is the user-authorized second reduction, compared with `.dev/verify/web-test-value/before/`. Historical input coverage is deliberately reduced; presentation, helper and dormant/SDK checks do not automatically block this task. Findings require a plausible costly user failure or an unsound retained test. Product implementation is unchanged.

## UI and integration

Reviewer51 performed Standards and Spec passes directly against the final source and reports. No material findings. Retained assertions cover actual callbacks/draft-image recovery, wrong-host refusal, origin/path/upload boundaries and terminal ordering/cleanup; no hidden filters, disabled cases or unawaited async matrices. All45 retained files match their recorded hashes; owned argv covers all paths. Reused UI23/23 and integration60/60 logs without rerunning.

## State

Reviewer50 found no Standards issues and one material Spec finding: the rewritten stale busy frame omitted its active run, weakening the assertion that stale stream state cannot start a run. This is a fixture logic error. Restored run:{inputs:["s1"]} at that exact scenario, preserving the preparing-state assertion; no new test registration or product change. Reviewer50 confirmed the exact correction closes the sole finding; focused hook verification8pass/0fail/0skip. No material findings remain. No other material findings in the six actual hook/lifecycle/deferred/window/scroll/cache files.

## Settings and parent refinement

Parent inspected the short active parser, secret masking, SDK resolution and producer checks and retained live Web authentication. These assert real refusals/outputs. Six extra dormant suites were removed after source import/call checks: old add/transport factory, provider usage, push publishing and Web subagent input/profile implementations. Current UI/adapter/gateway boundaries remain; no equivalent replacement is claimed for those dormant modules. The broad multi-file graph query was irrelevant/truncated; focused source references and current route ownership supplied the evidence.

## Accepted checks

The unchanged recursive runner reports69files142tests142pass0fail0skip, exit0. Current audit accounts for all239 original paths, zero unowned test files and zero unexpected product changes. The only package edits migrate explicit test:skills/test:upstream targets. Docs, entrypoints and diff checks passed on the dirty1758c1f working tree. Raw evidence under `.dev/verify/web-test-value/`; final acceptance details in [results.md](results.md).
