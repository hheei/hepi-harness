import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { HashRouter } from "react-router";
import { Workbench } from "@hepi/ui/workbench";
import { useHostNavigation } from "@hepi/ui/host-router";
import "@hepi/ui/styles/globals.css";
import "@hepi/ui/styles/settings.css";
import "@hepi/ui/styles/sidebar.css";
import "@hepi/ui/styles/sidebar-menu.css";
import { Configure } from "./Configure";
import { readConnection, workbenchConfig, type AppConnection } from "./connection";
import { nativeSaveHost } from "./save-host";
import { forgetConnection, inShell, reportConnection, reportSurface } from "./shell";

/**
 * The shell's save, stated once for this document's whole life.
 *
 * It is stateless — a picker, a handle and the shell's own file — so one value is all this host has, and stating it here
 * rather than inside the render is what keeps the workbench's capabilities from changing identity on every keystroke.
 */
const SAVE_HOST = nativeSaveHost();

/**
 * The App host.
 *
 * What differs from the Web page is stated here: the history is a `HashRouter`, because the document was loaded from a
 * bundle rather than served per address; the ingress is a Gateway the user configured, so it has an origin of its own;
 * and the credential is a device bearer the shell holds, never a cookie and never a service token.
 *
 * The tree below the configuration surface is the same workbench. Nothing in it knows which of the two hosts it is in.
 *
 * **What is reported to the shell, and when.** A packaged run reads the shell's stdout, so the moment a line is printed is
 * a claim about the document. A stored connection is not an admitted one: the bearer can be revoked, or the Gateway may be
 * unreachable, and then the workbench shows the refusal rather than a workbench. So nothing that names a connection is
 * stated until its descriptor read settles — `connecting` covers the mount before it does, and `workbench` is only ever
 * printed together with the Backend, the account scope and the client identity the ingress actually confirmed.
 *
 * **Recovery is the shell's, and it is stated as such.** A refused bearer can only be replaced or deleted by the process
 * that owns the credential store, so this host hands the workbench two actions and no more: open the configuration form
 * over the stored connection, or forget it. Both are the shell's own commands, which is why the workbench offers them only
 * when a host states them.
 */
function AppHost() {
  const navigation = useHostNavigation();
  const [connection, setConnection] = useState<AppConnection | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  // Whether the configuration form is open over a connection this install already has. It is separate from `connection`
  // because a replacement must not delete the stored one first: cancelling has to return to the connection it had.
  const [replacing, setReplacing] = useState(false);

  useEffect(() => {
    // The connection is read once, from the value the shell injected at document start. Reading it here rather than at
    // module scope is what makes a page that is not inside the shell report why it cannot connect instead of throwing
    // before React mounts.
    if (!inShell()) {
      setFailure("This build is the packaged App; it needs the Hepi shell to hold its connection.");
      return;
    }
    try {
      setConnection(readConnection());
      // The configuration surface is reported from the same decision that rendered it. A workbench is not: that one waits
      // for the readout below, because a stored bearer is a fact about this install, not about the deployment.
      reportSurface("connecting");
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : String(cause));
      reportSurface("configure");
    }
  }, []);

  if (connection === null) return <Configure failure={failure} />;
  if (replacing) {
    return <Configure failure={failure} replacing={connection} onCancel={() => { setFailure(null); setReplacing(false); }} />;
  }
  return (
    <Workbench
      navigation={navigation}
      config={{
        ...workbenchConfig(connection),
        // The readout decides both the surface and its facts: an admitted read is the workbench, a refused one is named
        // `refused` with the reason the tree itself shows, so a packaged run hears which of the two the WebView settled on.
        onConnectionReadout: (readout) => reportConnection(readout),
        // Saving a file is the shell's own work here: this document is a bundle, so it has no download navigation and no
        // element of it can present the device bearer. A Web page states nothing and keeps its browser download.
        save: SAVE_HOST,
        connectionManagement: {
          // The form is opened over the stored connection rather than after forgetting it, so an abandoned replacement
          // leaves this machine connected to what it was connected to.
          configure: () => { setFailure(null); setReplacing(true); },
          // A disconnect is the shell deleting the entry and restarting. If it fails the connection is still stored, so
          // nothing here pretends it was removed: the shell's own words are reported and the form is offered as the step
          // that still can change this install.
          disconnect: () => {
            void forgetConnection().catch((cause: unknown) => {
              setFailure("Disconnecting did not complete: " + (cause instanceof Error ? cause.message : String(cause)));
              setReplacing(true);
            });
          },
        },
      }}
    />
  );
}

const root = document.getElementById("root");
if (root === null) throw new Error("The App entry has no root element to mount into.");
createRoot(root).render(<StrictMode><HashRouter><AppHost /></HashRouter></StrictMode>);
