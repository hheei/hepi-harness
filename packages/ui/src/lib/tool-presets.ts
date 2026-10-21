/**
 * The shape the backend's `get_tools` answer arrives in, plus the read-only tool list a subagent profile is declared
 * with.
 *
 * There is deliberately no preset here: this host serves no tool selection. The create request carries none, the
 * browser cannot send one for a running conversation, and the composer offers no picker to choose one (R9).
 */
export interface ToolEntry {
  name: string;
  description: string;
  active: boolean;
  /** Active, but left out of requests: the model calls it only from codemode scripts. */
  declarationHidden?: boolean;
  parameters?: Record<string, unknown>;
  promptGuidelines?: string[];
}

/** The read-only built-ins a review-style subagent profile runs with. */
export const PRESET_READ_ONLY: string[] = ["read", "grep", "find", "ls"];
