/**
 * One event as the browser's stream states it.
 *
 * The Web host used to translate every frame for the browser (`toClientAgentEvent`): it dropped the events nothing
 * renders, slimmed nested tool calls and replaced each `message_update`'s cumulative response with a delta. The
 * browser folds the backend's frames itself now, so the stream states five event kinds — `connected`, `frame`,
 * `submission`, `resync` and `oversize` — and every reader of them (the open surface, the background watches and the
 * completion registry) reads the same shape. Nothing here interprets an event's payload: what a frame means is decided
 * by the fold and the projection, not by a second translation between them.
 */
export interface AgentEventLike {
  type: string;
  [key: string]: unknown;
}
