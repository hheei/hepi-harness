/**
 * Which of this workspace's skills a `/skill:` command is not allowed to invoke on its own.
 *
 * The palette annotates a dormant skill without hiding it, and the annotation is a fact the Skills inventory owns: the
 * read is the same one the Skills panel makes, on the same execution target, so a toggle made there is what the next
 * palette open reflects. A failure leaves the palette unannotated rather than guessing.
 */
import { useEffect, useState } from "react";
import { workspaceIdFromCwd } from "../../lib/skill-inventory";
import { useExecutionTarget } from "../../lib/workbench-scope";

export function useSkillDormancy(cwd: string | null | undefined, paletteOpen: boolean): Record<string, boolean> {
  const [state, setState] = useState<{ cwd: string; values: Record<string, boolean> } | null>(null);
  const target = useExecutionTarget(workspaceIdFromCwd(cwd));
  useEffect(() => {
    if (!paletteOpen || !cwd || target === null) return;
    const requested = cwd;
    let cancelled = false;
    setState({ cwd: requested, values: {} });
    void target.inventory().then((answer) => {
      if (cancelled || !answer.ok) return;
      const values: Record<string, boolean> = {};
      for (const skill of answer.value.skills) values[skill.name] = skill.disableModelInvocation;
      setState({ cwd: requested, values });
    });
    return () => {
      cancelled = true;
    };
  }, [paletteOpen, cwd, target]);
  return cwd && state?.cwd === cwd ? state.values : {};
}
