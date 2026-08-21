//! OIDC interactive authentication: spin up a localhost listener,
//! emit the auth URL to the frontend, exchange the callback code for
//! a token via `OidcAuth`.

use crate::auth::kubeconfig_tokens::{
    can_replace, file_defining_user, kubeconfig_files, write_tokens,
};
use crate::auth::{AuthProvider as _, AuthResult, OidcAuth};
use crate::error::{AuthError, Error, Result};
use crate::state::{AppEvent, AppState};
use base64::Engine as _;
use kube::config::AuthProviderConfig;
use std::collections::HashMap;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::time::Duration;
use url::Url;

/// Buffer size for OIDC callback reading
const OIDC_CALLBACK_BUFFER_SIZE: usize = 4096;

/// The loopback ports an OIDC client is likely to have been registered with.
///
/// A redirect URI has to be registered with the provider before it will
/// redirect to it, so a port picked at random can never be right: Dex answers
/// `Bad Request — Unregistered redirect_uri ("http://127.0.0.1:58884/callback")`
/// and the browser shows that instead of signing anybody in (#67).
///
/// These two are `kubectl oidc-login`'s own defaults — `--listen-address`
/// defaults to `127.0.0.1:8000,127.0.0.1:18000` — which is what the provider
/// was configured for by whoever followed its instructions, and this app is
/// reading their kubeconfig.
const REDIRECT_PORTS: [u16; 2] = [8000, 18000];

/// A listener on a port the provider is likely to accept a redirect to.
///
/// Falls back to a port from the kernel only if both are busy. That still
/// works for a provider that honours RFC 8252 — any loopback port for a
/// native app, which is what Google does — and for one that does not, the
/// browser at least says which URI was refused.
/// Headroom before an `exp` is treated as spent, so a token that dies in
/// flight is not sent in the first place.
const TOKEN_SKEW_SECS: i64 = 60;

/// The `exp` claim of a JWT, read without verifying anything.
///
/// The signature is the API server's business. All this decides is whether a
/// token is worth sending, so anything unreadable simply reads as spent.
fn expiry_of(token: &str) -> Option<chrono::DateTime<chrono::Utc>> {
    let payload = token.split('.').nth(1)?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload)
        .ok()?;
    let claims: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    chrono::DateTime::from_timestamp(claims.get("exp")?.as_i64()?, 0)
}

fn still_usable(token: &str) -> bool {
    expiry_of(token)
        .is_some_and(|exp| exp > chrono::Utc::now() + chrono::Duration::seconds(TOKEN_SKEW_SECS))
}

/// Trade the refresh token for a live one and write both back, or `None` when
/// that cannot be done safely — no refresh token, nowhere certain to write, or
/// the provider refused.
///
/// Every `None` here falls through to the browser, which is the honest
/// outcome: it asks for something rather than silently spending a credential
/// somebody else still needs.
async fn refreshed(
    config: &HashMap<String, String>,
    user: &str,
    files: &[std::path::PathBuf],
) -> Option<AuthResult> {
    let refresh_token = config.get("refresh-token").filter(|t| !t.is_empty())?;
    let issuer_url = config.get("idp-issuer-url")?.clone();
    let client_id = config.get("client-id")?.clone();

    let path = file_defining_user(files, user)?;
    // Asked before the token is spent, not after: a refresh token is
    // single-use, so nowhere to put the replacement has to mean no refresh.
    if !can_replace(&path) {
        tracing::info!(
            path = %path.display(),
            "kubeconfig cannot be rewritten; asking for a browser rather than              spending a refresh token whose replacement could not be stored"
        );
        return None;
    }

    let auth = OidcAuth::new(
        issuer_url,
        client_id,
        config.get("client-secret").cloned(),
        parse_scopes(config),
    );
    let spent = AuthResult {
        token: String::new(),
        expires_at: None,
        refresh_token: Some(refresh_token.clone()),
        token_type: "Bearer".to_string(),
    };
    let fresh = match auth.refresh(&spent).await {
        Ok(fresh) => fresh,
        Err(err) => {
            tracing::info!(%err, "OIDC refresh declined; falling back to the browser");
            return None;
        }
    };

    if let Err(err) = write_tokens(&path, user, &fresh.token, fresh.refresh_token.as_deref()) {
        // The token just spent is gone either way; saying so is the only thing
        // that explains why `kubectl` may now ask for a fresh login too.
        tracing::warn!(%err, path = %path.display(), "refreshed the OIDC token but could not write it back");
    }
    Some(fresh)
}

fn redirect_uri_for(port: u16) -> String {
    format!("http://localhost:{port}")
}

async fn bind_redirect() -> Result<TcpListener> {
    for port in REDIRECT_PORTS {
        if let Ok(listener) = TcpListener::bind(("127.0.0.1", port)).await {
            return Ok(listener);
        }
    }
    Ok(TcpListener::bind(("127.0.0.1", 0)).await?)
}

pub(super) async fn run_oidc_auth(
    state: &AppState,
    context: &str,
    user: &str,
    provider: &AuthProviderConfig,
) -> Result<AuthResult> {
    let config = &provider.config;

    // `kubectl` never opens a browser for this kind of user: it sends the
    // `id-token` sitting in the file until that expires, and only then reaches
    // for the refresh token. Opening a browser first asks the provider to have
    // registered a redirect URI that this config never needed — which is how a
    // cluster somebody uses daily through kubectl answered
    // "Unregistered redirect_uri" here.
    if let Some(token) = config.get("id-token").filter(|token| still_usable(token)) {
        return Ok(AuthResult {
            token: token.clone(),
            expires_at: expiry_of(token),
            refresh_token: config.get("refresh-token").cloned(),
            token_type: "Bearer".to_string(),
        });
    }

    // The token is spent, and `kubectl` would now trade the refresh token for
    // a new one without a browser in sight. Do the same — but settle where the
    // result will be written *first*. Dex invalidates a refresh token the
    // moment it is spent, so refreshing without being able to write the
    // replacement back would leave the file holding a dead token and break the
    // `kubectl` beside us. No single file to write means no refresh.
    let override_path =
        crate::commands::settings::helpers::read_config(|c| c.kubernetes.kubeconfig_path.clone())
            .ok()
            .flatten();
    if let Some(result) = refreshed(config, user, &kubeconfig_files(override_path)).await {
        return Ok(result);
    }

    let issuer_url = config
        .get("idp-issuer-url")
        .ok_or_else(|| Error::Auth(AuthError::Oidc("Missing issuer URL".to_string())))?
        .clone();
    let client_id = config
        .get("client-id")
        .ok_or_else(|| Error::Auth(AuthError::Oidc("Missing client ID".to_string())))?
        .clone();
    let client_secret = config.get("client-secret").cloned();
    let scopes = parse_scopes(config);

    let auth = OidcAuth::new(issuer_url, client_id, client_secret, scopes);
    let listener = bind_redirect().await?;
    let redirect_port = listener.local_addr()?.port();
    // `http://localhost:<port>`, exactly — host and path included.
    //
    // A provider compares redirect URIs by string (RFC 6749 §3.1.2.3), so
    // matching the port is not enough: `http://127.0.0.1:8000/callback` is a
    // different string from what was registered. What was registered is what
    // `kubectl oidc-login` sends, and asking it directly answers
    // `redirect_uri=http://localhost:8000` — host `localhost`, no path. Dex is
    // lenient about both for a public client; Keycloak, Okta and Entra are not.
    //
    // The listener stays on 127.0.0.1 — also what kubelogin does — and the
    // callback parser reads the query off whatever path arrives, so serving at
    // the root costs nothing here.
    let redirect_uri = redirect_uri_for(redirect_port);

    let auth_url = auth.generate_auth_url(&redirect_uri).await?;
    let (session_id, mut cancel_rx) = state.create_auth_session(context, "oidc");

    state.emit(AppEvent::AuthUrlRequested {
        context: context.to_string(),
        url: auth_url.url.clone(),
        flow: "oidc".to_string(),
        session_id: Some(session_id.clone()),
        redirect_uri: Some(redirect_uri.clone()),
    });

    let callback_fut = wait_for_oidc_callback(listener);
    tokio::pin!(callback_fut);

    let callback_result = tokio::select! {
        result = &mut callback_fut => result,
        _ = &mut cancel_rx => {
            state.remove_auth_session(&session_id);
            state.emit(AppEvent::AuthFlowCancelled {
                session_id,
                context: context.to_string(),
                message: Some("Authentication cancelled.".to_string()),
            });
            return Err(Error::Auth(AuthError::Oidc("Authentication cancelled".to_string())));
        }
        () = tokio::time::sleep(Duration::from_mins(3)) => {
            state.remove_auth_session(&session_id);
            // A provider that refuses the redirect never reaches this
            // listener, so the wait simply runs out — and the reader is
            // looking at the browser's "Unregistered redirect_uri" with no
            // idea what to do. Name the URI their client has to allow.
            let message = format!(
                "Authentication timed out. If the browser said the redirect \
                 was not registered, add {redirect_uri} to this client's \
                 allowed redirect URIs."
            );
            state.emit(AppEvent::AuthFlowCompleted {
                session_id,
                context: context.to_string(),
                success: false,
                message: Some(message.clone()),
            });
            return Err(Error::Timeout(message));
        }
    };

    let callback = match callback_result {
        Ok(callback) => callback,
        Err(err) => {
            state.remove_auth_session(&session_id);
            state.emit(AppEvent::AuthFlowCompleted {
                session_id,
                context: context.to_string(),
                success: false,
                message: Some(err.to_string()),
            });
            return Err(err);
        }
    };

    if callback.state != auth_url.state {
        state.remove_auth_session(&session_id);
        state.emit(AppEvent::AuthFlowCompleted {
            session_id,
            context: context.to_string(),
            success: false,
            message: Some("OIDC state mismatch.".to_string()),
        });
        return Err(Error::Auth(AuthError::Oidc(
            "OIDC state mismatch".to_string(),
        )));
    }

    let auth_result = auth
        .exchange_code(&callback.code, &redirect_uri, &auth_url.code_verifier)
        .await?;

    state.remove_auth_session(&session_id);
    state.emit(AppEvent::AuthFlowCompleted {
        session_id,
        context: context.to_string(),
        success: true,
        message: None,
    });

    Ok(auth_result)
}

fn parse_scopes(config: &HashMap<String, String>) -> Vec<String> {
    config
        .get("extra-scopes")
        .map(|scopes| {
            scopes
                .split([',', ' '])
                .filter(|s| !s.trim().is_empty())
                .map(|s| s.trim().to_string())
                .collect::<Vec<String>>()
        })
        .unwrap_or_default()
}

struct OidcCallback {
    code: String,
    state: String,
}

async fn wait_for_oidc_callback(listener: TcpListener) -> Result<OidcCallback> {
    let (mut socket, _) = listener.accept().await?;
    let mut buf = [0u8; OIDC_CALLBACK_BUFFER_SIZE];
    let n = socket.read(&mut buf).await?;
    if n == 0 {
        return Err(Error::Auth(AuthError::Oidc(
            "OIDC callback empty".to_string(),
        )));
    }
    let request = String::from_utf8_lossy(&buf[..n]);
    let path = request
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .unwrap_or("/");
    let url = Url::parse(&format!("http://localhost{path}"))
        .map_err(|e| Error::Auth(AuthError::Oidc(format!("OIDC callback parse failed: {e}"))))?;

    let mut code = None;
    let mut state = None;
    for (key, value) in url.query_pairs() {
        if key == "code" {
            code = Some(value.to_string());
        }
        if key == "state" {
            state = Some(value.to_string());
        }
    }

    let body = "<html><body>Authentication complete. You can close this window.</body></html>";
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\n\r\n{}",
        body.len(),
        body
    );
    let _ = socket.write_all(response.as_bytes()).await;

    let code = code.ok_or_else(|| Error::Auth(AuthError::Oidc("Missing code".to_string())))?;
    let state = state.ok_or_else(|| Error::Auth(AuthError::Oidc("Missing state".to_string())))?;

    Ok(OidcCallback { code, state })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A JWT shaped the way a provider issues one, expiring `secs` from now.
    /// Only the payload matters here — nothing verifies the other two parts.
    fn token_expiring_in(secs: i64) -> String {
        let exp = (chrono::Utc::now() + chrono::Duration::seconds(secs)).timestamp();
        let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(format!(r#"{{"sub":"a@b.c","exp":{exp}}}"#));
        format!("header.{payload}.signature")
    }

    #[test]
    fn reads_the_expiry_a_provider_stamped() {
        let token = token_expiring_in(3600);
        let exp = expiry_of(&token).expect("exp");
        let left = (exp - chrono::Utc::now()).num_seconds();
        assert!((3500..=3600).contains(&left), "{left}s left");
    }

    /// The whole point: a config carrying a live token must not send anybody
    /// to a browser, because the redirect URI it would need was never
    /// registered — `kubectl` works on exactly this config without one.
    #[test]
    fn a_live_token_is_used_as_it_stands() {
        assert!(still_usable(&token_expiring_in(3600)));
    }

    /// The behavioural half: the issuer here is an address nothing listens on,
    /// so anything that reached for the network would fail. Returning the token
    /// is the proof that no browser and no round trip happen at all.
    #[tokio::test]
    async fn a_live_token_skips_the_browser_entirely() {
        let token = token_expiring_in(3600);
        let provider = AuthProviderConfig {
            name: "oidc".to_string(),
            config: HashMap::from([
                (
                    "idp-issuer-url".to_string(),
                    "http://127.0.0.1:1/dex".to_string(),
                ),
                ("client-id".to_string(), "kubernetes".to_string()),
                ("id-token".to_string(), token.clone()),
                ("refresh-token".to_string(), "refresh".to_string()),
            ]),
        };
        let state = AppState::new().expect("state");
        let result = run_oidc_auth(&state, "ctx", "alice", &provider)
            .await
            .expect("a live token needs no provider");
        assert_eq!(result.token, token);
        assert_eq!(result.refresh_token.as_deref(), Some("refresh"));
    }

    /// The whole loop against a real provider, because the part that matters
    /// is somebody else's behaviour: Dex invalidates a refresh token the
    /// moment it is spent, so the replacement has to reach the file or the
    /// next `kubectl` is locked out.
    ///
    /// Needs a Dex on 127.0.0.1:5556 and a refresh token in
    /// `RUBICK_TEST_REFRESH_TOKEN`, so it is not part of the normal run:
    /// `cargo test -- --ignored refreshes_against_a_real_provider`
    #[tokio::test]
    #[ignore = "needs a live Dex; see the doc comment"]
    async fn refreshes_against_a_real_provider_and_writes_the_result_back() {
        let spent_refresh =
            std::env::var("RUBICK_TEST_REFRESH_TOKEN").expect("RUBICK_TEST_REFRESH_TOKEN");
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("config");
        std::fs::write(
            &path,
            format!(
                "apiVersion: v1\nkind: Config\nusers:\n- name: alice\n  user:\n    \
                 auth-provider:\n      name: oidc\n      config:\n        \
                 client-id: kubernetes\n        id-token: expired\n        \
                 idp-issuer-url: http://127.0.0.1:5556/dex\n        \
                 refresh-token: {spent_refresh}\n"
            ),
        )
        .expect("write");

        let config = HashMap::from([
            (
                "idp-issuer-url".to_string(),
                "http://127.0.0.1:5556/dex".to_string(),
            ),
            ("client-id".to_string(), "kubernetes".to_string()),
            ("refresh-token".to_string(), spent_refresh.clone()),
        ]);

        let fresh = refreshed(&config, "alice", std::slice::from_ref(&path))
            .await
            .expect("a live refresh token buys a new one");

        assert!(still_usable(&fresh.token), "the new id-token must be live");

        // The file has to carry the replacement, not the token just spent.
        let after = std::fs::read_to_string(&path).expect("read");
        assert!(
            after.contains(&fresh.token),
            "new id-token not written back"
        );
        assert!(
            !after.contains(&spent_refresh),
            "the file still holds the refresh token Dex just invalidated"
        );

        // And the chain has to continue: whatever landed in the file must buy
        // the next token too, or the `kubectl` reading this file is locked out
        // one refresh from now.
        let stored: serde_yaml::Value = serde_yaml::from_str(&after).expect("yaml");
        let stored = stored["users"][0]["user"]["auth-provider"]["config"]["refresh-token"]
            .as_str()
            .expect("refresh-token")
            .to_string();
        let mut next = config.clone();
        next.insert("refresh-token".to_string(), stored);
        refreshed(&next, "alice", std::slice::from_ref(&path))
            .await
            .expect("the refresh token written back must work in its turn");
    }

    #[test]
    fn a_spent_token_is_not() {
        assert!(!still_usable(&token_expiring_in(-1)));
    }

    /// A token dying inside the skew window would expire mid-request.
    #[test]
    fn nor_is_one_that_dies_while_it_travels() {
        assert!(!still_usable(&token_expiring_in(30)));
    }

    #[test]
    fn anything_unreadable_counts_as_spent() {
        for token in ["", "not-a-jwt", "header..signature", "a.!!!.c"] {
            assert!(!still_usable(token), "{token:?}");
            assert!(expiry_of(token).is_none(), "{token:?}");
        }
    }

    /// A JWT without `exp` says nothing about when it dies, and guessing
    /// "still good" there is how a request fails at the API server instead.
    #[test]
    fn so_does_one_that_never_says_when_it_ends() {
        let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(r#"{"sub":"a@b.c"}"#);
        assert!(!still_usable(&format!("header.{payload}.signature")));
    }

    /// The whole of #67, and both halves of the rule in one test on purpose.
    ///
    /// These were two tests and they raced: the fallback one binds 8000 and
    /// 18000 and holds them, so the other — asking for a registered port —
    /// got a kernel-assigned one and failed. It passed locally on timing and
    /// went red on CI. Ports are process-wide state; the phases have to be
    /// ordered, not merely written next to each other.
    #[tokio::test]
    async fn asks_for_a_registered_port_and_settles_for_any() {
        let listener = bind_redirect().await.expect("a listener");
        let port = listener.local_addr().expect("an address").port();
        assert!(
            REDIRECT_PORTS.contains(&port),
            "bound {port}, which no provider was told about"
        );
        drop(listener);

        // Both busy is not a reason to refuse: a provider honouring RFC 8252
        // takes any loopback port, and one that does not at least names the
        // URI it refused.
        let mut held = Vec::new();
        for port in REDIRECT_PORTS {
            match TcpListener::bind(("127.0.0.1", port)).await {
                Ok(listener) => held.push(listener),
                // Something else on this machine holds it; the second phase
                // cannot be set up, and the first has already said its piece.
                Err(_) => return,
            }
        }

        let fallback = bind_redirect().await.expect("a listener");
        let port = fallback.local_addr().expect("an address").port();
        assert!(!REDIRECT_PORTS.contains(&port));
        assert_ne!(port, 0);
    }

    /// `kubectl oidc-login`'s own defaults, and in its order — the provider was
    /// configured for those by whoever followed its instructions.
    #[test]
    fn uses_kubelogins_defaults_in_its_order() {
        assert_eq!(REDIRECT_PORTS, [8000, 18000]);
    }

    /// The port alone was not enough, and this is the shape that was missed:
    /// asking `kubectl oidc-login` what it sends answers
    /// `redirect_uri=http://localhost:8000` — host `localhost`, no path. A
    /// provider compares the whole string, so `http://127.0.0.1:8000/callback`
    /// matches nothing anybody registered.
    #[test]
    fn builds_the_uri_a_kubelogin_setup_registered() {
        assert_eq!(redirect_uri_for(8000), "http://localhost:8000");
        assert_eq!(redirect_uri_for(18000), "http://localhost:18000");
    }
}
