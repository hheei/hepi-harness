/**
 * The session-stats shape the copied session panel reads.
 *
 * This file used to hold the whole copied agent-session surface — the SDK session, its model runtime, its settings and
 * session managers, the RPC result types and the theme/editor handles — because the Web host used to run a session of
 * its own. Ticket 08 moved the browser onto the backend's own stream, so the only two types anything still imports are
 * these: the usage read and the panel that shows it. The rest had no reader in this deployment (and the SDK's own
 * declarations remain the authority for them), so ticket 09 retired them here rather than leaving a second, unused
 * copy of the SDK's surface to drift.
 */
export interface ContextUsage {
  percent: number | null;
  contextWindow: number;
  tokens: number | null;
}

export interface SessionStatsInfo {
  sessionId: string;
  sessionName?: string;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  toolResults: number;
  totalMessages: number;
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
  cost: number;
  contextUsage?: ContextUsage;
}
