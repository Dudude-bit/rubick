//! Interactive authentication helpers for exec and OIDC flows.
//!
//! Public surface: `prepare_kubeconfig_for_context` — the rest is
//! split by flow into `cloud` (native GKE/AKS), `exec` (kubectl
//! exec credential plugins), and `oidc` (kubeconfig auth-provider
//! `oidc`). Shared exec-credential types live in `cred`.

mod cloud;
mod cred;
mod exec;
mod oidc;

use crate::error::{AuthError, Error, Result};
use crate::state::AppState;
use kube::config::{AuthInfo, ExecAuthCluster, Kubeconfig};
use secrecy::SecretString;

use cred::ExecCredentialStatus;

/// Prepare kubeconfig for a context, handling exec auth if needed.
///
/// # Errors
///
/// Returns an error if the context cannot be resolved, exec
/// authentication fails, or kubeconfig processing fails.
/// A prepared kubeconfig, and the one fact about it that expires.
///
/// The credential plugin states when what it just handed over stops working,
/// and this used to be read and thrown away on the next line. Nothing renews
/// it — `apply_exec_credentials` strips the `exec` block that could — so that
/// timestamp is the only thing in the process that knows the session has a
/// deadline. It is carried out of here so a surface can say *when*, rather
/// than only that something is wrong once every request has started failing.
pub struct PreparedContext {
    pub kubeconfig: Kubeconfig,
    /// `None` where the plugin named no deadline, which many do not.
    pub expires_at: Option<chrono::DateTime<chrono::Utc>>,
}

pub async fn prepare_kubeconfig_for_context(
    state: &AppState,
    mut kubeconfig: Kubeconfig,
    context_name: &str,
) -> Result<PreparedContext> {
    let (user_name, cluster_name) = resolve_context(&kubeconfig, context_name)?;

    // First, get the exec config and check if we need cluster info
    let (exec_config, needs_cluster_info) = {
        let auth_info = find_auth_info_mut(&mut kubeconfig, &user_name)?;
        if let Some(exec) = auth_info.exec.clone() {
            (Some(exec.clone()), exec.provide_cluster_info)
        } else {
            (None, false)
        }
    };

    // Now resolve cluster info if needed (kubeconfig is no longer mutably borrowed)
    let exec_cluster = if needs_cluster_info {
        resolve_exec_cluster(&kubeconfig, &cluster_name)?
    } else {
        None
    };

    // Get auth_info again for modification
    let auth_info = find_auth_info_mut(&mut kubeconfig, &user_name)?;

    if let Some(exec_config) = exec_config {
        let status = exec::run_exec_auth(state, context_name, &exec_config, exec_cluster).await?;
        let expires_at = apply_exec_credentials(auth_info, status)?;
        auth_info.exec = None;
        auth_info.auth_provider = None;
        return Ok(PreparedContext {
            kubeconfig,
            expires_at,
        });
    }

    if let Some(provider) = auth_info.auth_provider.clone() {
        if provider.name == "oidc" {
            let oidc_result =
                oidc::run_oidc_auth(state, context_name, &user_name, &provider).await?;
            auth_info.token = Some(SecretString::from(oidc_result.token));
            auth_info.auth_provider = None;
        }
    }

    Ok(PreparedContext {
        kubeconfig,
        expires_at: None,
    })
}

fn resolve_context(kubeconfig: &Kubeconfig, context_name: &str) -> Result<(String, String)> {
    let context = kubeconfig
        .contexts
        .iter()
        .find(|ctx| ctx.name == context_name)
        .and_then(|ctx| ctx.context.as_ref())
        .ok_or_else(|| Error::Config(format!("Context {context_name} not found")))?;

    let user = context
        .user
        .clone()
        .ok_or_else(|| Error::Config(format!("Context {context_name} has no user")))?;
    Ok((user, context.cluster.clone()))
}

fn find_auth_info_mut<'a>(
    kubeconfig: &'a mut Kubeconfig,
    user_name: &str,
) -> Result<&'a mut AuthInfo> {
    let auth_info = kubeconfig
        .auth_infos
        .iter_mut()
        .find(|info| info.name == user_name)
        .ok_or_else(|| Error::Config(format!("Auth info {user_name} not found")))?;

    Ok(auth_info.auth_info.get_or_insert_with(AuthInfo::default))
}

fn resolve_exec_cluster(
    kubeconfig: &Kubeconfig,
    cluster_name: &str,
) -> Result<Option<ExecAuthCluster>> {
    let cluster = kubeconfig
        .clusters
        .iter()
        .find(|cluster| cluster.name == cluster_name)
        .and_then(|cluster| cluster.cluster.as_ref())
        .ok_or_else(|| Error::Config(format!("Cluster {cluster_name} not found")))?;

    let exec_cluster = ExecAuthCluster::try_from(cluster)
        .map_err(|e| Error::Config(format!("Failed to load cluster info: {e}")))?;
    Ok(Some(exec_cluster))
}

/// Applies what the plugin returned, and hands back the deadline it named.
///
/// The log line and the two refusals are what tell a bare `Unauthorized`
/// apart: the cluster refusing a whole credential, and us sending a broken
/// one, read identically and have nothing in common to do about them.
fn apply_exec_credentials(
    auth_info: &mut AuthInfo,
    status: ExecCredentialStatus,
) -> Result<Option<chrono::DateTime<chrono::Utc>>> {
    use base64::Engine;

    if let Some(mut token) = status.token {
        match cred::mend_bearer_token(&mut token) {
            // The length only — a token is a credential and does not go in a log.
            cred::TokenShape::Intact => tracing::info!(
                "Applied a {} character token from the credential plugin, intact.",
                token.len()
            ),
            cred::TokenShape::Mended { removed } => tracing::warn!(
                "The credential plugin's token carried {removed} whitespace \
                 characters the console that drew it put there. Removed."
            ),
            cred::TokenShape::Unusable { first_bad } => {
                return Err(Error::Auth(AuthError::Kubeconfig(format!(
                    "The credential plugin's token contains {first_bad:?}, which no \
                     HTTP header can carry, so the cluster would refuse it without \
                     saying why. The terminal the plugin ran under corrupted its \
                     output; this is not a rejected login."
                ))));
            }
            cred::TokenShape::Empty => {
                return Err(Error::Auth(AuthError::Kubeconfig(
                    "The credential plugin returned a token that is entirely \
                     whitespace. Sending it would reach the cluster as no \
                     credential at all."
                        .to_string(),
                )));
            }
        }
        auth_info.token = Some(SecretString::from(token));
    }
    // A plugin hands back PEM, but the fields it lands in are kubeconfig
    // fields, and kube reads those through a base64 decode. Storing the PEM
    // as-is leaves the decode to fail, and the failure is swallowed — the
    // client is then built with no certificate at all, and the server
    // answers the anonymous request with a denial that names no cause.
    if let Some(cert) = status.client_certificate_data {
        auth_info.client_certificate_data =
            Some(base64::engine::general_purpose::STANDARD.encode(cert));
    }
    if let Some(key) = status.client_key_data {
        auth_info.client_key_data = Some(SecretString::from(
            base64::engine::general_purpose::STANDARD.encode(key),
        ));
    }
    // A plugin that names no expiry, or names one this cannot parse, leaves
    // the deadline unknown — which is a different thing from "does not
    // expire", and is why the caller gets an `Option` rather than a guess.
    Ok(status
        .expiration_timestamp
        .and_then(|stamp| chrono::DateTime::parse_from_rfc3339(&stamp).ok())
        .map(|stamp| stamp.with_timezone(&chrono::Utc)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;
    use secrecy::ExposeSecret;

    const CERT: &str = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n";
    const KEY: &str = "-----BEGIN EC PRIVATE KEY-----\nMHcC\n-----END EC PRIVATE KEY-----\n";

    /// A plugin answers in PEM, and the kubeconfig fields this lands in are
    /// read through a base64 decode: kube swallows the failure and builds
    /// the client with no certificate at all, so the server refuses an
    /// anonymous request and names no cause. Would break if the PEM went
    /// into the fields as it came.
    #[test]
    fn a_plugins_pem_certificate_is_stored_the_way_kubeconfig_is_read() {
        let mut auth_info = AuthInfo::default();
        apply_exec_credentials(
            &mut auth_info,
            ExecCredentialStatus {
                expiration_timestamp: None,
                token: None,
                client_certificate_data: Some(CERT.to_string()),
                client_key_data: Some(KEY.to_string()),
            },
        )
        .expect("a certificate is not a token and has nothing to mend");

        let decoded = |field: &str| {
            base64::engine::general_purpose::STANDARD
                .decode(field)
                .expect("a kubeconfig field is base64")
        };
        let cert = auth_info
            .client_certificate_data
            .as_deref()
            .expect("the certificate");
        assert_eq!(decoded(cert), CERT.as_bytes());
        let key = auth_info.client_key_data.as_ref().expect("the key");
        assert_eq!(decoded(key.expose_secret()), KEY.as_bytes());
    }

    fn token_status(token: &str) -> ExecCredentialStatus {
        ExecCredentialStatus {
            expiration_timestamp: None,
            token: Some(token.to_string()),
            client_certificate_data: None,
            client_key_data: None,
        }
    }

    /// A console pads a wrapped row, and a space is ordinary data inside a
    /// JSON string — so the credential parses and the API server answers
    /// `Unauthorized` naming nothing (#106). Would break if the token reached
    /// `AuthInfo` with the console's spaces still in it.
    #[test]
    fn a_token_a_console_padded_is_stored_without_the_padding() {
        let mut auth_info = AuthInfo::default();
        apply_exec_credentials(&mut auth_info, token_status("header.pay load.sig \nnature"))
            .expect("whitespace is not a reason to refuse — it is one to remove");

        assert_eq!(
            auth_info.token.as_ref().expect("the token").expose_secret(),
            "header.payload.signature"
        );
    }

    /// Damage no header can carry stops before the request, with the byte
    /// named. Would break if an unusable token were stored and left to the
    /// server to refuse.
    #[test]
    fn a_token_carrying_what_no_console_explains_is_refused_here() {
        let mut auth_info = AuthInfo::default();
        let err = apply_exec_credentials(&mut auth_info, token_status("header.pay\u{7f}load.sig"))
            .expect_err("a token that cannot be a bearer credential is not sent");

        assert!(auth_info.token.is_none(), "nothing half-applied");
        assert!(
            err.to_string().contains("\\u{7f}"),
            "the message names the character found: {err}"
        );
    }

    /// `<` and `:` are bytes an HTTP header carries and real plugins emit —
    /// Rancher's `<id>:<secret>` among them. Would break if the refusal
    /// widened back to a charset narrower than the transport.
    #[test]
    fn a_token_with_punctuation_the_transport_accepts_is_applied() {
        let mut auth_info = AuthInfo::default();
        apply_exec_credentials(&mut auth_info, token_status("kubeconfig-u-abc:x9f7q2"))
            .expect("a colon is not damage");

        assert_eq!(
            auth_info.token.as_ref().expect("the token").expose_secret(),
            "kubeconfig-u-abc:x9f7q2"
        );
    }
}
