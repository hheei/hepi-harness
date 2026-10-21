import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { conversationSource } from "@hepi/session/browser";
import { Workbench } from "@hepi/ui/workbench";
import { useHostNavigation } from "@hepi/ui/host-router";
import "@hepi/ui/styles/globals.css";
import "@hepi/ui/styles/settings.css";
import "@hepi/ui/styles/sidebar.css";
import "@hepi/ui/styles/sidebar-menu.css";
import { registerServiceWorker } from "./pwa";

/**
 * The Web host.
 *
 * Everything that makes this the Web page rather than the App is stated here and nowhere below: the history a
 * `BrowserRouter` reads from the address bar, a same-origin ingress origin, and a cookie the browser attaches by itself.
 * The workbench above it is the same tree the App mounts.
 */
function WebHost() {
  const navigation = useHostNavigation();
  return (
    <Workbench
      navigation={navigation}
      config={{
        host: { kind: "web", ingressOrigin: "" },
        // A Web page's profile is its own origin: there is one connection per page, and the descriptor names the Backend
        // and account behind it.
        profile: window.location.origin,
        credential: { kind: "cookie" },
        // The Web page's stream is a same-origin address under the ingress, with no header: the httpOnly cookie is the
        // credential and the browser attaches it by itself.
        createSource: () => conversationSource(),
      }}
    />
  );
}

const root = document.getElementById("root");
if (root === null) throw new Error("The Web entry has no root element to mount into.");
createRoot(root).render(<StrictMode><BrowserRouter><WebHost /></BrowserRouter></StrictMode>);

// The page is usable before this resolves and stays usable if it never does: the worker only adds the offline page and
// the install surface. Registering after the first render keeps the mount the only thing the entry does on the critical
// path, and the build's version is what names the cache a new build replaces.
void registerServiceWorker({ navigator, version: __WEB_BUILD_VERSION__ });
