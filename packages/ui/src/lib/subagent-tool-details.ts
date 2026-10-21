import type { SubagentSessionStatus } from "./types";

/**
 * What a `pi-web-subagent` control tool call states as its own `details`.
 *
 * It lives here, in the shared UI, rather than beside the host extension that produces it: the transcript renders a
 * finished call from this shape, and the extension that writes it is host-only code. Two declarations would let the
 * reader and the writer drift, so the extension imports this one.
 */
export interface SubagentToolDetails {
  kind: "pi-web-subagent";
  sessionId: string;
  profile: string;
  description: string;
  status: SubagentSessionStatus;
  runInBackground: boolean;
  createdAt: string;
  completedAt?: string;
  error?: string;
  worktreePath?: string;
  worktreeBranch?: string;
  worktreeCleanupError?: string;
}
