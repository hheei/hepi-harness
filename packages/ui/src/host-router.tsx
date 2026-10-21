"use client";

import { useLocation, useNavigate } from "react-router";
import type { WorkbenchNavigation } from "./lib/navigation";

/**
 * The host's router, stated as the one thing the workbench needs from it.
 *
 * React Router's `BrowserRouter` and `HashRouter` both hand their children the same `location` and `navigate`; what
 * differs is where the address lives — a path on a Web page, a fragment of the document a packaged App loaded. Choosing
 * which one to mount is the host's decision, so this adapter is the only place that knows a router exists at all, and
 * the workbench above it sees a search string and a way to replace it.
 */
export function useHostNavigation(): WorkbenchNavigation {
  const location = useLocation();
  const navigate = useNavigate();
  return {
    location: { search: location.search },
    // `replace` keeps the logical query as the page's own state rather than a history entry per keystroke of navigation:
    // the workbench writes the session and the folder it is showing, not a trail of every switch.
    navigate: (search) => navigate({ search }, { replace: true }),
  };
}
