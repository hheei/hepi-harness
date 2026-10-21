import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { ConnectionRecovery, DisconnectConfirm, recoveryDetail, recoveryHeadline, recoveryPlan } = await jiti.import("./ConnectionRecovery.tsx");

/**
 * What a refused connection offers.
 *
 * Two rules are asserted here, and they are the whole of the ticket: the step a surface offers has to be one that can
 * change the state it is shown for, and the surface has to be honest about what its destructive step destroys. A retry on
 * a refused credential repeats a read that will be refused again; a configuration form on an outage invites a person to
 * replace a connection that was fine; and a disconnect that read as "sign out" would claim a revocation this machine
 * cannot perform.
 */
const render = (props) => renderToStaticMarkup(React.createElement(ConnectionRecovery, props));

test("a refused credential offers the host's own connection management, never a retry", () => {
  const managed = recoveryPlan({ state: "credential", managed: true });
  assert.deepEqual(managed.map(action => action.id), ["configure", "disconnect"]);
  assert.equal(managed.filter(action => action.primary).length, 1, "exactly one step receives focus");
  assert.equal(managed[0].primary, true, "the step that can make progress is the focused one");
  // A Web page's credential is the ingress's cookie: no page inside the deployment can replace or forget it, so a refused
  // Web page is offered no action rather than a control that would do nothing.
  assert.deepEqual(recoveryPlan({ state: "credential", managed: false }), []);
});

test("an unreachable Gateway offers a retry, and the management steps beside it on a host that has them", () => {
  assert.deepEqual(recoveryPlan({ state: "unreachable", managed: false }).map(action => action.id), ["retry"]);
  assert.deepEqual(recoveryPlan({ state: "unreachable", managed: true }).map(action => action.id), ["retry", "configure", "disconnect"]);
  assert.equal(recoveryPlan({ state: "unreachable", managed: true })[0].primary, true, "retry is the step an outage needs");
});

test("the surface states the refusal and its next step, and says what disconnecting does not do", () => {
  const html = render({
    state: "credential",
    reason: "This App's device credential was refused.",
    management: { configure() {}, disconnect() {} },
  });
  assert.match(html, /role="alert"/, "the deployment's own reason is announced");
  assert.match(html, /did not admit this connection/, "the headline names the state, not a bare code");
  assert.match(html, /Configure connection/, "the management step is reachable by keyboard");
  assert.match(html, /Disconnect/, "the disconnect step exists");
  assert.match(html, /<button[^>]*autofocus/i, "the primary step is focused for keyboard use");
  // The distinction the ticket requires: this is this machine's stored connection, not the server's record of the device
  // and not a durable run.
  assert.match(recoveryDetail("credential", true), /device credential/i);
  assert.match(recoveryHeadline("unreachable"), /could not be reached/);
  assert.match(recoveryDetail("unreachable", true), /kept/i, "an outage does not describe the connection as lost");
});

test("disconnecting is a second step, and its copy says what it does not do", () => {
  const html = render({ state: "unreachable", reason: "This deployment could not be reached.", management: { configure() {}, disconnect() {} } });
  // The confirmation is not the first click: the surface offers the step, and only the confirmation states what it destroys.
  assert.match(html, /Disconnect…/);
  assert.doesNotMatch(html, /does not revoke/, "the destructive copy is not shown before the person asks to disconnect");
  // That copy is what the ticket requires: this machine's stored connection, not the Gateway's device record and not a
  // durable run on the execution host.
  const confirm = renderToStaticMarkup(React.createElement(DisconnectConfirm, { onConfirm() {}, onCancel() {} }));
  assert.match(confirm, /deletes the connection stored on this machine/);
  assert.match(confirm, /does not revoke the device\s+credential on the Gateway/);
  assert.match(confirm, /does not stop anything already running on the execution host/);
  assert.match(confirm, /<button[^>]*autofocus/i, "the confirmation's own first action is focused");
  assert.match(confirm, />Cancel</, "and cancelling it is offered");
});

test("a Web page's refusal is stated without actions it cannot perform", () => {
  const html = render({ state: "credential", reason: "This deployment serves no login, and it refused the request without one." });
  assert.match(html, /did not admit this connection/);
  assert.doesNotMatch(html, /Configure connection/);
  assert.doesNotMatch(html, /Disconnect/);
  assert.match(html, /cannot replace the credential/, "it says why there is nothing to press");
});
