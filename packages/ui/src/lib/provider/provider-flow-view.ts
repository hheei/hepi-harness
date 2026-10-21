import type { ProviderAuthEvent, ProviderAuthPrompt, ProviderLoginInfo } from "@hepi/protocol/gateway";

/**
 * The step a provider's sign-in is on, in the one form this panel shows it.
 *
 * A flow's state is a phase, an optional question and an optional statement (docs/providers.md). Those three do not map
 * onto fields directly: a copy-code flow states an address and asks for a pasted one at the same time, and a device flow
 * states a code that is never typed into anything here. So this decides, from the host's own answer, what a person is
 * being asked to do next — open a link, type a code, choose one of these, paste a value, or wait — and nothing else.
 *
 * It is pure and it reads only the narrowed answer, which is what makes the panel's rendering testable without a host,
 * a browser or a provider: the shapes below are the whole set a flow can ask for.
 */
export type ProviderFlowView =
  /** Nothing to do yet: the flow is working, or this side has not read a step from it. */
  | { readonly kind: "waiting" }
  /** A sentence the host wants shown while its own work continues. */
  | { readonly kind: "progress"; readonly message: string }
  /** A link to open, with no question attached: the browser step of a flow. */
  | { readonly kind: "browser"; readonly message: string; readonly link: string; readonly instructions?: string }
  /** A code a person types into another device or page. Shown, never masked: it is only useful beside its URI. */
  | { readonly kind: "device_code"; readonly userCode: string; readonly verificationUri: string; readonly expiresInSeconds?: number }
  /** The open question, with the answer's field: text, a secret, or a pasted code. */
  | { readonly kind: "answer"; readonly message: string; readonly placeholder?: string; readonly secret: boolean; readonly link?: string; readonly focuses: true }
  /** One of these options — the answer a flow is holding, so a person never types an id. */
  | { readonly kind: "select"; readonly message: string; readonly options: readonly { id: string; label: string; description?: string }[] };

/**
 * The one thing a person is being asked to do, or that the flow is doing without them.
 *
 * An open question wins over a statement: a provider that says "open this address" and then asks for the redirect has
 * already been shown the address by the earlier read, and the field is what is actionable now. A flow that states a link
 * and asks nothing is the browser step; a flow that asks for a value while a link is still open shows both — the link
 * under the question, which is the copy-code case this panel exists for.
 */
export function providerFlowView(flow: ProviderLoginInfo): ProviderFlowView {
  const prompt = flow.prompt as ProviderAuthPrompt | undefined;
  const event = flow.event as ProviderAuthEvent | undefined;
  if (prompt !== undefined) {
    if (prompt.type === "select") {
      return { kind: "select", message: prompt.message, options: prompt.options.map((option) => ({ id: option.id, label: option.label, ...(option.description === undefined ? {} : { description: option.description }) })) };
    }
    return {
      kind: "answer",
      message: prompt.message,
      ...(prompt.placeholder === undefined ? {} : { placeholder: prompt.placeholder }),
      secret: prompt.type === "secret",
      ...(event?.type === "auth_url" ? { link: event.url } : {}),
      focuses: true,
    };
  }
  switch (event?.type) {
    case "device_code":
      return {
        kind: "device_code",
        userCode: event.userCode,
        verificationUri: event.verificationUri,
        ...(event.expiresInSeconds === undefined ? {} : { expiresInSeconds: event.expiresInSeconds }),
      };
    case "auth_url":
      return { kind: "browser", message: event.instructions ?? DEFAULT_BROWSER_MESSAGE, link: event.url, ...(event.instructions === undefined ? {} : { instructions: event.instructions }) };
    case "progress":
      return { kind: "progress", message: event.message };
    case "info":
      return { kind: "progress", message: event.message };
    default:
      return { kind: "waiting" };
  }
}

/** The browser step's own sentence, when the provider wrote none. */
const DEFAULT_BROWSER_MESSAGE = "Continue the sign-in in your browser.";
