//! OIDC interactive authentication: spin up a localhost listener,
//! emit the auth URL to the frontend, exchange the callback code for
//! a token via `OidcAuth`.

use crate::auth::OidcAuth;
use crate::error::{AuthError, Error, Result};
use crate::state::{AppEvent, AppState};
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
    provider: &AuthProviderConfig,
) -> Result<crate::auth::AuthResult> {
    let config = &provider.config;
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
    let redirect_uri = format!("http://127.0.0.1:{redirect_port}/callback");

    let auth_url = auth.generate_auth_url(&redirect_uri).await?;
    let (session_id, mut cancel_rx) = state.create_auth_session(context, "oidc");

    state.emit(AppEvent::AuthUrlRequested {
        context: context.to_string(),
        url: auth_url.url.clone(),
        flow: "oidc".to_string(),
        session_id: Some(session_id.clone()),
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

    /// The whole of #67: a redirect URI has to be registered with the provider,
    /// so the port cannot be one the kernel picked. Dex answered
    /// `Unregistered redirect_uri ("http://127.0.0.1:58884/callback")` and
    /// showed that to the reader instead of signing them in.
    #[tokio::test]
    async fn binds_a_port_a_provider_could_have_registered() {
        let listener = bind_redirect().await.expect("a listener");
        let port = listener.local_addr().expect("an address").port();
        assert!(
            REDIRECT_PORTS.contains(&port),
            "bound {port}, which no provider was told about"
        );
    }

    /// Both busy is not a reason to refuse: a provider that honours RFC 8252
    /// takes any loopback port, and one that does not at least names the URI
    /// it refused.
    #[tokio::test]
    async fn falls_back_to_any_port_when_both_are_taken() {
        let mut held = Vec::new();
        for port in REDIRECT_PORTS {
            if let Ok(listener) = TcpListener::bind(("127.0.0.1", port)).await {
                held.push(listener);
            }
        }
        if held.len() < REDIRECT_PORTS.len() {
            // Something else on this machine holds one of them; the case this
            // test is about cannot be set up, so it has nothing to say.
            return;
        }

        let listener = bind_redirect().await.expect("a listener");
        let port = listener.local_addr().expect("an address").port();
        assert!(!REDIRECT_PORTS.contains(&port));
        assert_ne!(port, 0);
    }

    /// `kubectl oidc-login`'s own defaults, and in its order — the provider was
    /// configured for those by whoever followed its instructions.
    #[test]
    fn uses_kubelogins_defaults_in_its_order() {
        assert_eq!(REDIRECT_PORTS, [8000, 18000]);
    }
}
