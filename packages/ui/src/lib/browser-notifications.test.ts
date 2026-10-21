import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import type { BrowserNotificationEnvironment } from "./browser-notifications.ts";

const jiti = createJiti(import.meta.url);
const { shouldShowBrowserNotification, showBrowserNotification } = await jiti.import<typeof import("./browser-notifications.ts")>("./browser-notifications.ts");

/**
 * The page's completion notice.
 *
 * It is the one notification this page raises, and it belongs to the live lifecycle: AppShell asks for it only when the
 * projection reported an answered turn the user was not looking at, so this module's job is delivery and nothing else —
 * the page's own notification where the browser has one, the worker's where a registration exists, and silence when
 * neither is available. It never raises a notice for a page that is on screen: the transcript and the tone are that
 * case's report, and a system notification for a tab the user is watching is noise.
 */
test("the notice is only for a page the user is not looking at", () => {
  // `hasFocus` is the document's own method, so the state a caller states is the same shape the document has.
  const attention = (visibilityState: DocumentVisibilityState, focused: boolean) => ({ visibilityState, hasFocus: () => focused });
  assert.equal(shouldShowBrowserNotification(attention("visible", true)), false);
  assert.equal(shouldShowBrowserNotification(attention("visible", false)), true, "another window has focus");
  assert.equal(shouldShowBrowserNotification(attention("hidden", true)), true, "the tab is in the background");
});

test("a worker registration delivers the notice, and its click selects the conversation", async () => {
  const shown: { title: string; options: NotificationOptions | undefined }[] = [];
  let clicked = false;
  const environment: BrowserNotificationEnvironment = {
    createWindowNotification: () => { throw new Error("a worker registration exists"); },
    getServiceWorkerRegistration: async () => ({ showNotification: async (title, options) => { shown.push({ title, options }); } }),
  };
  const delivery = await showBrowserNotification({
    title: "Session", body: "Task finished", sessionUrl: "/?session=conv", tag: "pi-session-complete:conv",
    onClick: () => { clicked = true; },
  }, environment);
  assert.equal(delivery, "service-worker");
  assert.deepEqual(shown, [{
    title: "Session",
    options: { body: "Task finished", tag: "pi-session-complete:conv", renotify: true, data: { url: "/?session=conv" } },
  }]);
  assert.equal(clicked, false, "a worker-delivered notice is followed up by the worker, not by this page");
});

test("without a worker the page's own notification is used, and clicking it selects the conversation", async () => {
  type Opened = { title: string; options?: NotificationOptions | undefined; onclick: (() => void) | null; closed: boolean; close(): void };
  const created: Opened[] = [];
  let clicked = false;
  const environment: BrowserNotificationEnvironment = {
    createWindowNotification: (title, options) => {
      const notification: Opened = { title, options, onclick: null, closed: false, close() { notification.closed = true; } };
      created.push(notification);
      return notification;
    },
    getServiceWorkerRegistration: null,
  };
  const delivery = await showBrowserNotification({
    title: "Session", body: "Task finished", sessionUrl: "/?session=conv", onClick: () => { clicked = true; },
  }, environment);
  assert.equal(delivery, "window");
  assert.equal(created.length, 1);
  assert.equal(created[0].options?.tag, undefined, "no tag is stated when none was given");
  created[0].onclick?.();
  assert.equal(clicked, true);
  assert.equal(created[0].closed, true, "and the notice it opened is closed");
});

test("a refused or unsupported notification is silence, never a page error", async () => {
  assert.equal(await showBrowserNotification(
    { title: "t", body: "b", sessionUrl: "/", onClick: () => {} },
    { createWindowNotification: () => { throw new Error("not allowed"); }, getServiceWorkerRegistration: async () => undefined },
  ), null);
  assert.equal(await showBrowserNotification(
    { title: "t", body: "b", sessionUrl: "/", onClick: () => {} },
    { createWindowNotification: () => { throw new Error("not allowed"); }, getServiceWorkerRegistration: async () => { throw new Error("no worker"); } },
  ), null, "a failed worker lookup falls through to the page's own notification");
});
