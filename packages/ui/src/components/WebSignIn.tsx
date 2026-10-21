"use client";
import { useState } from "react";

/** Exchanges this deployment's Web login for its same-origin HttpOnly session cookie. */
export function WebSignIn({ submit }: { submit: (token: string) => Promise<{ ok: boolean; status: number }> }) {
  const [token, setToken] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  return (
    <main className="web-login-page">
      <section className="web-login-shell" aria-labelledby="web-login-title">
        <div className="web-login-brand">
          <img src="/icons/icon-192.png" width={36} height={36} alt="" />
          <span>Hepi</span>
        </div>
        <h1 id="web-login-title">Welcome back.</h1>
        <p className="web-login-description">Sign in to your workspace to pick up where you left off.</p>
        <form
          className="web-login-form"
          aria-busy={pending}
          onSubmit={async (event) => {
            event.preventDefault();
            if (token === "" || pending) return;
            setPending(true);
            setError("");
            try {
              const answer = await submit(token);
              setToken("");
              if (!answer.ok) setError(answer.status === 401 || answer.status === 403 ? "That login was refused. Check your access token and try again." : "This deployment could not be reached (" + answer.status + ").");
            } catch {
              setError("This deployment could not be reached. Please try again.");
            } finally {
              setPending(false);
            }
          }}
        >
          <label className="web-login-label" htmlFor="web-login-token">Access token</label>
          <input
            id="web-login-token"
            type="password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            placeholder="Enter your access token"
            autoComplete="current-password"
            autoCapitalize="none"
            spellCheck={false}
            autoFocus
            readOnly={pending}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? "web-login-error" : undefined}
          />
          {error && <p className="web-login-error" id="web-login-error" role="alert">{error}</p>}
          <button type="submit" disabled={pending || token === ""}>
            {pending ? "Signing in…" : <>Sign in <span aria-hidden="true">→</span></>}
          </button>
        </form>
        <p className="web-login-note">Use the access token provided by your workspace administrator.</p>
      </section>
    </main>
  );
}
