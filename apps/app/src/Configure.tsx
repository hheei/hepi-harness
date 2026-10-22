import { useEffect, useState } from "react";
import { configureConnection, readBuild, type ShellBuild } from "./shell";
import type { AppConnection } from "./connection";

/**
 * The connection form, on both the states that need it: an install with no connection, and an install whose stored one the
 * Gateway refused.
 *
 * An install with no connection cannot show a workbench at all: the Gateway origin has to be named in the window's policy
 * before the window exists, so the shell restarts once the values are stored and the workbench is what comes back. The
 * device bearer is issued by a Web session on the same Gateway (the ingress refuses issuance to a device) and pasted here
 * once; the shell keeps it in the OS credential store.
 *
 * **Replacing a connection is the same form, and cancelling keeps the old one.** A refused connection is not deleted when
 * this form opens: the stored profile and origin are what the form starts from, the credential has to be typed again
 * because the refused one is exactly what is being replaced, and Cancel returns to the refusal with the connection this
 * machine had. Nothing is written until Connect, so an abandoned form is not a lost connection.
 */
export function Configure(props: {
  /** Why this surface is shown when it was not a person's choice, or null on a first run. */
  readonly failure: string | null;
  /** The connection being replaced, when there is one. Its presence is what makes this a replacement. */
  readonly replacing?: AppConnection | null;
  /** Return to the previous surface with the stored connection untouched. */
  readonly onCancel?: () => void;
}) {
  const replacing = props.replacing ?? null;
  const [profile, setProfile] = useState(replacing?.profile ?? "default");
  const [origin, setOrigin] = useState(replacing?.origin ?? "");
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [build, setBuild] = useState<ShellBuild | null>(null);

  useEffect(() => {
    // Provenance is on the surface a person sees when something is wrong, not only in a build log: this binary names the
    // two revisions it was built from.
    readBuild().then(setBuild).catch((cause: unknown) => {
      // Provenance is a line on this surface, not a step a person waits on, so a shell that does not answer leaves it out
      // rather than blocking the form. It is still stated to the console: an absent version line is otherwise
      // indistinguishable from a build that carries no stamp, and that difference is what a packaged run needs to know.
      console.error("[hepi-app] the shell did not answer the build report: " + (cause instanceof Error ? cause.message : String(cause)));
      setBuild(null);
    });
  }, []);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      // A successful store restarts the shell, so this promise does not resolve into a page: the surface below the form is
      // whatever the restarted process admits, which is why a failed replace is reported here and a successful one cannot
      // be reported by the form at all.
      await configureConnection({ profile: profile.trim(), origin: origin.trim(), token });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setPending(false);
    }
  };

  return (
    <main style={{ padding: 24, fontFamily: "system-ui, sans-serif", maxWidth: 560 }}>
      <h1 style={{ fontSize: 20 }}>{replacing === null ? "Connect to a Hepi Gateway" : "Replace this App's connection"}</h1>
      {replacing === null ? null : (
        <p style={{ opacity: 0.8, fontSize: 13 }}>
          Currently configured for profile <strong>{replacing.profile}</strong> at <strong>{replacing.origin}</strong>. The
          stored connection is kept unless you connect, so cancelling changes nothing.
        </p>
      )}
      {props.failure === null ? null : <p role="alert">{props.failure}</p>}
      <form onSubmit={submit} style={{ display: "grid", gap: 12 }}>
        <label>
          Profile
          <input value={profile} onChange={event => setProfile(event.target.value)} required />
        </label>
        <label>
          Gateway address
          <input value={origin} onChange={event => setOrigin(event.target.value)} placeholder="https://gateway.example" required />
        </label>
        <label>
          Device credential
          <input value={token} onChange={event => setToken(event.target.value)} type="password" required />
        </label>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button type="submit" disabled={pending}>{pending ? "Connecting…" : replacing === null ? "Connect" : "Replace connection"}</button>
          {props.onCancel === undefined ? null : (
            <button type="button" onClick={props.onCancel} disabled={pending}>Cancel</button>
          )}
        </div>
      </form>
      {error === null ? null : <p role="alert">{error}</p>}
      <p style={{ opacity: 0.7, fontSize: 12 }}>
        The device credential is issued by a signed-in Web session on that Gateway and stored in this machine's credential
        store.
      </p>
      {build === null ? null : (
        <p style={{ opacity: 0.7, fontSize: 12 }}>
          Hepi {build.version} · {build.target} · UI {build.client_revision.slice(0, 12)} · shell {build.shell_revision.slice(0, 12)}
        </p>
      )}
    </main>
  );
}
