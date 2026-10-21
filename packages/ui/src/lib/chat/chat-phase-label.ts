import type { AgentPhase } from "../../hooks/useAgentSession";

/** The i18n translate function shape this module needs. */
export type Translate = (key: string, params?: Record<string, string | number>) => string;

/**
 * The status line shown while the agent is working: the projection's own phase, named.
 *
 * The copied composer used to give a client-side "compacting" flag precedence here. Nothing states that flag any more —
 * the durable runtime compacts inside a run and the wire carries no such phase — so the label states only what the
 * projection reported.
 */
export function phaseLabel(phase: AgentPhase, t: Translate): string | null {
  if (phase?.kind === "running_tools") {
    const latest = phase.tools[phase.tools.length - 1];
    if (latest?.progress) {
      return `${t("chat.runningNamedTool", { name: latest.name })} ${latest.progress}`;
    }
    const names = phase.tools.map((tool) => tool.name);
    if (names.length === 0) return t("chat.runningTool");
    if (names.length === 1) return t("chat.runningNamedTool", { name: names[0] });
    if (names.length <= 3) return t("chat.runningTools", { names: names.join(", ") });
    return t("chat.runningToolsMore", { names: names.slice(0, 2).join(", "), count: names.length - 2 });
  }
  if (phase?.kind === "preparing") return t("chat.preparing");
  if (phase?.kind === "waiting_model") return t("chat.waitingModel");
  if (phase?.kind === "running_command") return t("chat.runningCommand");
  return null;
}
