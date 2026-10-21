//! The Hepi App shell.
//!
//! What lives here is only what a WebView cannot do for itself:
//!
//! - **The connection.** A profile, the Gateway origin the client ingress answers on, and the device bearer this install
//!   was issued live in the OS credential store (Secret Service on the verified Linux target, ticket 04). They reach the
//!   page as a value injected at document start — never a build-time substitution, a file in the bundle or a URL.
//! - **The cross-origin allowance.** The page's own origin is `tauri://localhost`, so every Gateway is cross-origin and
//!   the WebView refuses one the built CSP does not name *before the request leaves it* (ticket 04). The origin the
//!   credential was issued for is therefore named in `connect-src` when the window is built, from the same stored value
//!   the page reads.
//!
//! There is no Node, no Next server, no agent runtime and no service credential here. A device may not issue, list or
//! revoke credentials; that is a Web session's operation on the ingress, and this shell only stores what one issued.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod save;

use tauri::Manager;

/// The keyring service every entry of this App is filed under.
const KEYRING_SERVICE: &str = "dev.hepi.app";

/// The one entry this install has: the connection it was configured with.
const CONNECTION_ENTRY: &str = "connection";

/// One connection, as the page reads it. It carries no service credential: the ingress presents those to the Backend.
#[derive(Clone, serde::Serialize)]
struct Connection {
    profile: String,
    origin: String,
    token: String,
}

fn keyring_entry(name: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, name).map_err(|error| format!("credential store unavailable: {error}"))
}

/// Read this install's connection out of the credential store.
///
/// A stored entry that is not exactly this shape is refused rather than half-adopted: a connection with an empty origin
/// would resolve every request against the bundle, and one with an empty bearer would be presented to a Gateway that
/// refuses it. Nothing here invents a default address.
fn read_stored_connection() -> Result<Connection, String> {
    let raw = match keyring_entry(CONNECTION_ENTRY)?.get_password() {
        Ok(value) => value,
        Err(keyring::Error::NoEntry) => return Err("no connection is configured for this App".into()),
        Err(error) => return Err(format!("credential store read failed: {error}")),
    };
    let parsed: serde_json::Value = serde_json::from_str(&raw).map_err(|_| "the stored connection is not readable".to_string())?;
    let field = |name: &str| parsed.get(name).and_then(|value| value.as_str()).unwrap_or_default().trim().to_string();
    let connection = Connection { profile: field("profile"), origin: field("origin"), token: field("token") };
    if connection.profile.is_empty() || connection.origin.is_empty() || connection.token.is_empty() {
        return Err("the stored connection is incomplete".into());
    }
    Ok(connection)
}

/// Store a connection, normalizing its origin once.
///
/// The origin is normalized where it is written so the value the CSP is built from and the value the page reads cannot
/// disagree about a trailing slash, and so a Gateway address that is not an http(s) origin is refused before it is kept.
fn store_connection(profile: &str, origin: &str, token: &str) -> Result<Connection, String> {
    let connection = normalize_connection(profile, origin, token)?;
    let value = serde_json::json!({
        "profile": connection.profile,
        "origin": connection.origin,
        "token": connection.token,
    });
    keyring_entry(CONNECTION_ENTRY)?
        .set_password(&value.to_string())
        .map_err(|error| format!("credential store write failed: {error}"))?;
    Ok(connection)
}

/// A connection a Gateway address can actually be reached on, or the reason it cannot.
///
/// The origin is reduced to scheme, host and port, because that is the only form the window's policy can name: a pasted
/// address with a path or a query would otherwise be stored as written and then silently not match the CSP.
fn normalize_connection(profile: &str, origin: &str, token: &str) -> Result<Connection, String> {
    if profile.trim().is_empty() || token.is_empty() {
        return Err("a connection needs a profile and a device bearer".into());
    }
    let parsed = tauri::Url::parse(origin.trim()).map_err(|_| "the Gateway address is not a URL".to_string())?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
        return Err("the Gateway address must be an http(s) origin".into());
    }
    Ok(Connection {
        profile: profile.trim().to_string(),
        origin: parsed.origin().ascii_serialization(),
        token: token.to_string(),
    })
}

/// The script that hands the connection to the page before any of its own scripts run.
///
/// An injected value rather than a substituted one: the document in the bundle is the same document for every install,
/// and the credential exists only in this process's memory and the credential store.
fn connection_script(connection: Option<&Connection>) -> String {
    let value = match connection {
        Some(connection) => serde_json::json!({
            "profile": connection.profile,
            "origin": connection.origin,
            "token": connection.token,
        }),
        None => serde_json::Value::Null,
    };
    format!("globalThis.__HEPI_CONNECTION__ = {value};")
}

/// The CSP this window is served with, naming the origin the connection was issued for.
///
/// Ticket 04's measured constraint: an address outside this list is refused by the WebView itself, so the configured
/// Gateway has to be named here before the window exists. `ipc:` and `http://ipc.localhost` are the shell's own
/// transport; `'unsafe-inline'` for styles is what the shared workbench's element styles need, and scripts stay
/// `'self'` plus the hash Tauri computes for the bundle's one inline theme script.
fn content_security_policy(origin: Option<&str>) -> String {
    let mut connect = vec!["'self'".to_string(), "ipc:".into(), "http://ipc.localhost".into()];
    if let Some(origin) = origin {
        connect.push(origin.to_string());
    }
    format!(
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; \
         font-src 'self' data:; connect-src {connect}; object-src 'none'; base-uri 'self'; form-action 'none'",
        connect = connect.join(" ")
    )
}

/// What the App is, as the page and a packaged run report it: the revisions this binary and its UI were built from.
#[derive(serde::Serialize)]
struct BuildInfo {
    version: &'static str,
    client_revision: &'static str,
    shell_revision: &'static str,
    target: &'static str,
}

/// Stamped by `scripts/build-artifacts.mjs` from the checkout it built, so a packaged binary names its own source.
const CLIENT_REVISION: &str = match option_env!("HEPI_CLIENT_REVISION") {
    Some(value) => value,
    None => "unstamped",
};
const SHELL_REVISION: &str = match option_env!("HEPI_SHELL_REVISION") {
    Some(value) => value,
    None => "unstamped",
};

/// Reported by the page for each state its own connection read settled to, so a packaged run can be told apart from a
/// process that merely started.
///
/// `surface` names what the document actually rendered. `backend`, `scope`, `client` and `profile` are the four facts a
/// page can only hold **after** its Gateway answered the connection descriptor, so a line that states them is an
/// observation of the WebView's own transport rather than of the process that hosts it: a `workbench` cannot be reported
/// for a connection the ingress never admitted. A read that has not settled, or was refused, states them empty — which is
/// what tells "nothing was read" apart from "the connection was admitted". `client` is the identity the deployment named
/// for the credential it admitted (`device:<id>` / `web`), never the bearer itself.
#[tauri::command]
fn app_ready(surface: String, backend: String, scope: String, client: String, profile: String, reason: String) {
    use std::io::Write;
    let mut out = std::io::stdout();
    let _ = writeln!(
        out,
        "HEPI_APP_READY {}",
        serde_json::json!({ "surface": surface, "backend": backend, "scope": scope, "client": client, "profile": profile, "reason": reason })
    );
    // A piped stdout would otherwise lose the line when the process is killed.
    let _ = out.flush();
}

#[tauri::command]
fn app_build() -> BuildInfo {
    BuildInfo {
        version: env!("CARGO_PKG_VERSION"),
        client_revision: CLIENT_REVISION,
        shell_revision: SHELL_REVISION,
        target: std::env::consts::ARCH,
    }
}

/// Configure this install: store the connection, then start over.
///
/// A restart rather than a reload, because the origin the connection names has to be in the window's policy *before the
/// window exists*, and a running document cannot be handed a new policy. The stored connection is read again on the way
/// back up, so there is one code path that builds the window and it always builds it from the credential store.
#[tauri::command]
fn app_configure(app: tauri::AppHandle, profile: String, origin: String, token: String) -> Result<(), String> {
    store_connection(&profile, &origin, &token)?;
    app.restart()
}

/// Forget this install's connection: delete the stored entry, then start over with no connection.
#[tauri::command]
fn app_forget(app: tauri::AppHandle) -> Result<(), String> {
    match keyring_entry(CONNECTION_ENTRY)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => {}
        Err(error) => return Err(format!("credential store delete failed: {error}")),
    }
    app.restart()
}

/// The headless operations, before any window exists.
///
/// `--configure` reads one connection as JSON on stdin and stores it: the device bearer stays off the command line, where
/// a process list would publish it. `--forget` removes the entry. Both are what provisions or clears a machine without a
/// display, and the artifact test uses the same two paths it ships. **Both write the OS credential store the process's
/// environment names**, which is why a test run of either has to own a store of its own — see
/// `scripts/lib/credential-sandbox.mjs`.
fn headless(command: &str) -> Option<i32> {
    match command {
        "--configure" => {
            let mut raw = String::new();
            let read = std::io::Read::read_to_string(&mut std::io::stdin(), &mut raw);
            let result = read.map_err(|error| error.to_string()).and_then(|_| {
                let parsed: serde_json::Value = serde_json::from_str(&raw).map_err(|_| "expected a JSON connection on stdin".to_string())?;
                let field = |name: &str| parsed.get(name).and_then(|value| value.as_str()).unwrap_or_default().to_string();
                store_connection(&field("profile"), &field("origin"), &field("token")).map(|_| ())
            });
            Some(report("configure", result))
        }
        "--forget" => {
            let result = keyring_entry(CONNECTION_ENTRY).and_then(|entry| match entry.delete_credential() {
                Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
                Err(error) => Err(format!("credential store delete failed: {error}")),
            });
            Some(report("forget", result))
        }
        _ => None,
    }
}

/// One line on stdout, and an exit code, for a headless operation.
fn report(operation: &str, result: Result<(), String>) -> i32 {
    use std::io::Write;
    let mut out = std::io::stdout();
    match result {
        Ok(()) => {
            let _ = writeln!(out, "HEPI_APP_{} ok", operation.to_uppercase());
            0
        }
        Err(error) => {
            let _ = writeln!(out, "HEPI_APP_{} failed: {error}", operation.to_uppercase());
            1
        }
    }
}

fn main() {
    if let Some(code) = std::env::args().nth(1).as_deref().and_then(headless) {
        std::process::exit(code);
    }
    // A credential store that cannot be read is not a connection: the App starts unconfigured and says so.
    let stored = read_stored_connection().ok();
    let script = connection_script(stored.as_ref());
    // A packaged run names its own provenance on stdout before anything else happens: the artifact test reads this line
    // from the binary it installed, so the stamp cannot come from the checkout the test happens to sit in.
    println!(
        "HEPI_APP_BUILD {}",
        serde_json::json!({
            "version": env!("CARGO_PKG_VERSION"),
            "client_revision": CLIENT_REVISION,
            "shell_revision": SHELL_REVISION,
            "target": std::env::consts::ARCH,
        })
    );
    let mut context = tauri::generate_context!();
    context.config_mut().app.security.csp = Some(tauri::utils::config::Csp::Policy(content_security_policy(
        stored.as_ref().map(|connection| connection.origin.as_str()),
    )));

    tauri::Builder::default()
        // The save is the one thing a WebView cannot do for itself on this host: a bundle has no download navigation, so
        // the shell writes the file the page read. See `save.rs`.
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            app_build,
            app_ready,
            app_configure,
            app_forget,
            save::app_save_choose,
            save::app_save_begin,
            save::app_save_append,
            save::app_save_finish,
            save::app_save_abort
        ])
        .setup(move |app| {
            // The save registry is this process's, created before the window exists so no save can race its own setup.
            app.manage(save::Saves::default());
            tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::App("index.html".into()))
                .title("Hepi")
                .inner_size(1200.0, 820.0)
                .min_inner_size(640.0, 480.0)
                .initialization_script(&script)
                .build()?;
            Ok(())
        })
        .run(context)
        .expect("the App shell could not start");
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_gateway_address_is_reduced_to_an_origin_the_policy_can_name() {
        let connection = normalize_connection("workstation", "https://gateway.example/prefix?x=1", "device-token").unwrap();
        assert_eq!(connection.origin, "https://gateway.example");
        assert_eq!(connection.profile, "workstation");
        assert_eq!(normalize_connection("a", "http://127.0.0.1:8090", "t").unwrap().origin, "http://127.0.0.1:8090");
    }

    #[test]
    fn a_connection_that_cannot_be_reached_is_refused_rather_than_stored() {
        // Each of these would otherwise become a workbench pointed at nothing: a relative address, another scheme, or an
        // address whose scheme carries no host.
        for origin in ["not-a-url", "ftp://gateway.example", "file:///tmp/socket", ""] {
            assert!(normalize_connection("p", origin, "t").is_err(), "{origin} must be refused");
        }
        assert!(normalize_connection("", "https://gateway.example", "t").is_err());
        assert!(normalize_connection("p", "https://gateway.example", "").is_err());
    }

    #[test]
    fn the_window_policy_names_the_configured_gateway_and_nothing_else() {
        let configured = content_security_policy(Some("https://gateway.example"));
        assert!(configured.contains("connect-src 'self' ipc: http://ipc.localhost https://gateway.example"));
        assert!(configured.contains("script-src 'self'"), "scripts stay same-origin: {configured}");
        assert!(!configured.contains("unsafe-eval"), "no eval: {configured}");

        // An unconfigured install has no Gateway in its policy, so a page cannot reach one it was not given.
        let unconfigured = content_security_policy(None);
        assert!(unconfigured.contains("connect-src 'self' ipc: http://ipc.localhost;"));
        assert!(!unconfigured.contains("https://gateway.example"));
    }

    #[test]
    fn the_injected_value_carries_the_connection_and_nothing_when_there_is_none() {
        let connection = Connection { profile: "p".into(), origin: "https://gateway.example".into(), token: "device-token".into() };
        let script = connection_script(Some(&connection));
        assert!(script.starts_with("globalThis.__HEPI_CONNECTION__ = {"));
        assert!(script.contains("\"origin\":\"https://gateway.example\""));
        assert!(script.contains("\"token\":\"device-token\""));
        assert_eq!(connection_script(None), "globalThis.__HEPI_CONNECTION__ = null;");
    }
}

