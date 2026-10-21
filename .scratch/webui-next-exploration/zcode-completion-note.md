# ZCode subagent completion: automatic runtime reporting

Checked 2026-10-16. ZCode means official zai-org/ZCode, not a similarly named fork. Static source inspection only; no execution test. Main resolved to commit `aac4755666d09fdcd70272fcf063c077a639015f`; final completion excerpts fetched at that exact pin.

- `apps/zcode-cli/packages/core/src/subagent/runner.ts`: foreground run awaits completion and returns `completed.output` (around line 384). Background completion Promise calls `finalizeBackgroundCompletion` (around lines 324–329).
- `finalizeBackgroundCompletion` (1497 onward) writes result artifacts, passes joined completed text blocks as `result` to `formatLocalAgentTaskNotification` (1514), and transitions runtime task state. Notification enqueue uses `options.enqueueParentTaskNotification` (1863), supplying task ID, text and trace context.
- `completion-notification.ts` formats a runtime task notification with result, status, parent tool-call ID, output-file reference and usage.

Conclusion: audited normal final-result path is runtime-mediated completion capture and parent reporting. Child need not invoke a contact-parent tool to make its final answer reach parent. This does not assert that every proactive communication path is automatic, or that receiving a notification always starts a new parent turn.

Sources:

- [runner: foreground result](https://github.com/zai-org/ZCode/blob/aac4755666d09fdcd70272fcf063c077a639015f/apps/zcode-cli/packages/core/src/subagent/runner.ts#L384)
- [runner: background completion](https://github.com/zai-org/ZCode/blob/aac4755666d09fdcd70272fcf063c077a639015f/apps/zcode-cli/packages/core/src/subagent/runner.ts#L1497)
- [runner: parent enqueue](https://github.com/zai-org/ZCode/blob/aac4755666d09fdcd70272fcf063c077a639015f/apps/zcode-cli/packages/core/src/subagent/runner.ts#L1863)
- [notification formatter](https://github.com/zai-org/ZCode/blob/aac4755666d09fdcd70272fcf063c077a639015f/apps/zcode-cli/packages/core/src/subagent/completion-notification.ts)
