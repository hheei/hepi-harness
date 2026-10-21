import { normalizeStreamingToolCalls } from "./normalize";
import type {
  AgentMessage,
  AssistantMessage,
} from "./types";

/**
 * The bubble the surface draws while a run is in flight.
 *
 * It is fed by **whole** live messages, not by deltas: the browser folds the backend's own frames, so the message a
 * frame states is the message on screen, and the assistant delta events the old Web host assembled block by block no
 * longer reach this surface at all. A snapshot therefore replaces the bubble, and the tool-call normalisation is the
 * one piece of assembly left — it is what makes a live message render exactly as its committed entry will.
 */
export interface StreamingState {
  isStreaming: boolean;
  streamingMessage: AssistantMessage | null;
}

export type StreamAction =
  | { type: "start" }
  | { type: "resume" }
  | { type: "snapshot"; message: AgentMessage }
  | { type: "end" };

export const INITIAL_STREAMING_STATE: StreamingState = {
  isStreaming: false,
  streamingMessage: null,
};

export function streamReducer(
  state: StreamingState,
  action: StreamAction,
): StreamingState {
  switch (action.type) {
    case "start":
      return { isStreaming: true, streamingMessage: null };
    case "resume":
      return { ...state, isStreaming: true };
    case "snapshot": {
      const message = normalizeStreamingToolCalls(action.message);
      return message.role === "assistant"
        ? { isStreaming: true, streamingMessage: message }
        : state;
    }
    case "end":
      return INITIAL_STREAMING_STATE;
    default:
      return state;
  }
}
