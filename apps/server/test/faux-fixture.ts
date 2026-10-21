import { contentText, createModels, type Message, type Models } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, type FauxProviderHandle, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import type { ModelRef } from "@earendil-works/pi-durable";

/**
 * The offline scripted model, as a test fixture and nothing else. Production never registers it and never defaults to
 * it: a deployment that configured no model offers none and settles its requests natively as no_model. A test that
 * needs a turn to really settle injects this catalog explicitly.
 */
export const SERVER_MODEL: ModelRef = { provider: "faux", modelId: "faux-1" };

function lastUserText(messages: readonly Message[]): string {
  const message = messages.findLast((candidate) => candidate.role === "user");
  return message === undefined ? "(no user message)" : contentText(message.content);
}

/** A fresh faux instance whose queued response echoes the last user text, so a reply is "Server reply to: <text>". */
export function createEchoFauxProvider(): FauxProviderHandle {
  const faux = fauxProvider();
  const respond: FauxResponseFactory = async (transcript) => {
    faux.setResponses([respond]);
    return fauxAssistantMessage(`Server reply to: ${lastUserText(transcript.messages)}`);
  };
  faux.setResponses([respond]);
  return faux;
}

/** A catalog holding only the scripted fixture model, for a test whose turns must settle without a network call. */
export function fauxModels(): Models {
  const models = createModels();
  models.setProvider(createEchoFauxProvider().provider);
  return models;
}

/**
 * The gate a test holds a model answer behind, so "the run is in flight" is a state the test creates rather than a race
 * it hopes to win. `arm` makes the next answer wait; `release` lets every held answer through and disarms the gate, so a
 * later turn in the same test answers immediately unless the test arms it again.
 */
export type AnswerGate = { armed: boolean; entered: boolean; waiters: (() => void)[]; arm(): void; release(): void };

export function createAnswerGate(): AnswerGate {
  return {
    armed: false,
    entered: false,
    waiters: [],
    arm() { this.armed = true; this.entered = false; },
    release() { this.armed = false; for (const resolve of this.waiters.splice(0)) resolve(); },
  };
}

/** The echo catalog, whose answers wait while `gate` is armed. */
export function gatedEchoModels(gate: AnswerGate): Models {
  const faux = createEchoFauxProvider();
  const models = createModels();
  const respond: FauxResponseFactory = async (transcript) => {
    faux.setResponses([respond]);
    gate.entered = true;
    if (gate.armed) await new Promise<void>((resolve) => { gate.waiters.push(resolve); });
    return fauxAssistantMessage(`Server reply to: ${lastUserText(transcript.messages)}`);
  };
  faux.setResponses([respond]);
  models.setProvider(faux.provider);
  return models;
}
