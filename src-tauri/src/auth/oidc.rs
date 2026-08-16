//! OIDC authentication provider

use super::{AuthProvider, AuthResult};
use crate::error::{AuthError, Error, Result};
use async_trait::async_trait;
use serde::Deserialize;

/// OIDC authentication provider
pub struct OidcAuth {
    issuer_url: String,
    client_id: String,
    client_secret: Option<String>,
    scopes: Vec<String>,
}

/// OIDC token response
#[derive(Debug, Deserialize)]
struct TokenResponse {
    access_token: String,
    token_type: String,
    expires_in: Option<u64>,
    refresh_token: Option<String>,
    id_token: Option<String>,
}

/// OIDC discovery document
#[derive(Debug, Deserialize)]
struct OidcDiscovery {
    token_endpoint: String,
    authorization_endpoint: String,
}

impl OidcAuth {
    /// Create a new OIDC auth provider
    #[must_use]
    pub fn new(
        issuer_url: String,
        client_id: String,
        client_secret: Option<String>,
        scopes: Vec<String>,
    ) -> Self {
        Self {
            issuer_url,
            client_id,
            client_secret,
            scopes,
        }
    }

    /// Discover OIDC endpoints
    async fn discover(&self) -> Result<OidcDiscovery> {
        let discovery_url = format!(
            "{}/.well-known/openid-configuration",
            self.issuer_url.trim_end_matches('/')
        );

        let client = reqwest::Client::new();
        let response = client
            .get(&discovery_url)
            .send()
            .await
            .map_err(|e| Error::Auth(AuthError::Oidc(format!("Discovery failed: {e}"))))?;

        let discovery: OidcDiscovery = response.json().await.map_err(|e| {
            Error::Auth(AuthError::Oidc(format!("Invalid discovery document: {e}")))
        })?;

        Ok(discovery)
    }

    /// Exchange refresh token for new access token
    async fn refresh_token(&self, refresh_token: &str) -> Result<TokenResponse> {
        let discovery = self.discover().await?;
        let client = reqwest::Client::new();

        let mut params = vec![
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh_token),
            ("client_id", &self.client_id),
        ];

        if let Some(secret) = &self.client_secret {
            params.push(("client_secret", secret));
        }

        let response = client
            .post(&discovery.token_endpoint)
            .form(&params)
            .send()
            .await
            .map_err(|e| {
                Error::Auth(AuthError::RefreshFailed(format!(
                    "Token refresh failed: {e}"
                )))
            })?;

        if !response.status().is_success() {
            let error_text = response.text().await.unwrap_or_default();
            return Err(Error::Auth(AuthError::RefreshFailed(format!(
                "Token refresh failed: {error_text}"
            ))));
        }

        let token_response: TokenResponse = response.json().await.map_err(|e| {
            Error::Auth(AuthError::RefreshFailed(format!(
                "Invalid token response: {e}"
            )))
        })?;

        Ok(token_response)
    }
}

#[async_trait]
impl AuthProvider for OidcAuth {
    async fn authenticate(&self) -> Result<AuthResult> {
        // OIDC authentication typically requires user interaction
        // This is a simplified flow for cases where we have a refresh token

        // In a real implementation, this would:
        // 1. Open a browser for user authentication
        // 2. Listen on a callback URL
        // 3. Exchange the authorization code for tokens

        Err(Error::Auth(AuthError::Oidc(
            "Interactive OIDC authentication required. Please use the UI to authenticate."
                .to_string(),
        )))
    }

    async fn refresh(&self, auth: &AuthResult) -> Result<AuthResult> {
        let refresh_token = auth.refresh_token.as_ref().ok_or_else(|| {
            Error::Auth(AuthError::RefreshFailed(
                "No refresh token available".to_string(),
            ))
        })?;

        let token_response = self.refresh_token(refresh_token).await?;

        let expires_at = token_response.expires_in.and_then(|secs| {
            secs.try_into()
                .ok()
                .map(|secs_i64: i64| chrono::Utc::now() + chrono::Duration::seconds(secs_i64))
        });

        Ok(AuthResult {
            token: token_response
                .id_token
                .unwrap_or(token_response.access_token),
            expires_at,
            refresh_token: token_response
                .refresh_token
                .or_else(|| auth.refresh_token.clone()),
            token_type: token_response.token_type,
        })
    }

    fn supports_refresh(&self) -> bool {
        true
    }

    fn name(&self) -> &'static str {
        "oidc"
    }
}

/// OIDC authorization URL builder
pub struct OidcAuthorizationUrl {
    pub url: String,
    pub state: String,
    pub code_verifier: String,
}

impl OidcAuth {
    /// Generate authorization URL for browser-based flow
    ///
    /// # Errors
    ///
    /// Returns an error if OIDC discovery fails or if the discovery document
    /// is invalid or missing required endpoints.
    pub async fn generate_auth_url(&self, redirect_uri: &str) -> Result<OidcAuthorizationUrl> {
        let discovery = self.discover().await?;

        let state = uuid::Uuid::new_v4().to_string();
        let code_verifier = generate_code_verifier();
        let code_challenge = generate_code_challenge(&code_verifier);

        let scopes = if self.scopes.is_empty() {
            "openid email profile".to_string()
        } else {
            self.scopes.join(" ")
        };

        let url = format!(
            "{}?response_type=code&client_id={}&redirect_uri={}&scope={}&state={}&code_challenge={}&code_challenge_method=S256",
            discovery.authorization_endpoint,
            urlencoding::encode(&self.client_id),
            urlencoding::encode(redirect_uri),
            urlencoding::encode(&scopes),
            urlencoding::encode(&state),
            urlencoding::encode(&code_challenge),
        );

        Ok(OidcAuthorizationUrl {
            url,
            state,
            code_verifier,
        })
    }

    /// Exchange authorization code for tokens
    ///
    /// # Errors
    ///
    /// Returns an error if OIDC discovery fails, the token exchange request fails,
    /// or the token response is invalid.
    pub async fn exchange_code(
        &self,
        code: &str,
        redirect_uri: &str,
        code_verifier: &str,
    ) -> Result<AuthResult> {
        let discovery = self.discover().await?;
        let client = reqwest::Client::new();

        let mut params = vec![
            ("grant_type", "authorization_code"),
            ("code", code),
            ("redirect_uri", redirect_uri),
            ("client_id", &self.client_id),
            ("code_verifier", code_verifier),
        ];

        if let Some(secret) = &self.client_secret {
            params.push(("client_secret", secret));
        }

        let response = client
            .post(&discovery.token_endpoint)
            .form(&params)
            .send()
            .await
            .map_err(|e| Error::Auth(AuthError::Oidc(format!("Code exchange failed: {e}"))))?;

        if !response.status().is_success() {
            let error_text = response.text().await.unwrap_or_default();
            return Err(Error::Auth(AuthError::Oidc(format!(
                "Code exchange failed: {error_text}"
            ))));
        }

        let token_response: TokenResponse = response
            .json()
            .await
            .map_err(|e| Error::Auth(AuthError::Oidc(format!("Invalid token response: {e}"))))?;

        let expires_at = token_response.expires_in.and_then(|secs| {
            secs.try_into()
                .ok()
                .map(|secs_i64: i64| chrono::Utc::now() + chrono::Duration::seconds(secs_i64))
        });

        Ok(AuthResult {
            token: token_response
                .id_token
                .unwrap_or(token_response.access_token),
            expires_at,
            refresh_token: token_response.refresh_token,
            token_type: token_response.token_type,
        })
    }
}

/// Generate a random code verifier for PKCE
fn generate_code_verifier() -> String {
    use base64::Engine;

    // `fill` draws from the same thread-local CSPRNG the old
    // `thread_rng().gen()` loop did; rand 0.10 just exposes it as a free
    // function that fills a slice, which says what this needs plainly.
    let mut bytes = [0u8; 32];
    rand::fill(&mut bytes);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// Generate code challenge from verifier for PKCE
fn generate_code_challenge(verifier: &str) -> String {
    use base64::Engine;
    use sha2::{Digest, Sha256};

    let mut hasher = Sha256::new();
    hasher.update(verifier.as_bytes());
    let hash = hasher.finalize();
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(hash)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_oidc_auth_creation() {
        let auth = OidcAuth::new(
            "https://auth.example.com".to_string(),
            "client-id".to_string(),
            Some("client-secret".to_string()),
            vec!["openid".to_string()],
        );

        assert_eq!(auth.name(), "oidc");
        assert!(auth.supports_refresh());
    }

    #[test]
    fn test_code_verifier_generation() {
        let verifier = generate_code_verifier();
        assert!(!verifier.is_empty());
        assert!(verifier.len() >= 32);
    }

    #[test]
    fn test_code_challenge_generation() {
        let verifier = "test-verifier";
        let challenge = generate_code_challenge(verifier);
        assert!(!challenge.is_empty());
    }
}
