//! The certificate behind a TLS Secret.
//!
//! Core, not an extension: a `kubernetes.io/tls` Secret's `tls.crt` states
//! its own validity, and it does so on every cluster whether or not anything
//! manages it. cert-manager adds *why* a certificate looks the way it does;
//! it is not what makes the expiry date knowable.
//!
//! Only `tls.crt` is read. The Secret's other key is the private key and it
//! does not leave this process — see `resources::tls::withhold_reason`.

use k8s_openapi::api::core::v1::Secret;
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::commands::helpers::ResourceContext;
use crate::error::Result;
use crate::resources::{read_certificate, CertificateFacts, CertificateProblem};
use crate::state::AppState;

/// One Secret's certificate, or the stated reason there is none to read.
///
/// Both fields are `None` only where the app has not looked, which this
/// command never returns — one of the two is always set.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TlsCertificate {
    pub secret_name: String,
    pub certificate: Option<CertificateFacts>,
    /// Why there is nothing to describe, named — see [`CertificateProblem`].
    pub problem: Option<CertificateProblem>,
}

/// Read the certificate out of each named Secret in one namespace.
///
/// Batched because an Ingress can name a Secret per host and a page that
/// fires one request each is a page that gets slower the more TLS you use.
#[tauri::command]
pub async fn get_tls_certificates(
    namespace: String,
    secret_names: Vec<String>,
    state: State<'_, AppState>,
) -> Result<Vec<TlsCertificate>> {
    let ctx = ResourceContext::for_command(&state, Some(namespace))?;
    let api: kube::Api<Secret> = ctx.namespaced_api();

    let mut out = Vec::with_capacity(secret_names.len());
    for name in secret_names {
        crate::validation::validate_dns_subdomain(&name)?;
        out.push(match api.get(&name).await {
            Ok(secret) => read_tls_certificate(&name, &secret),
            Err(kube::Error::Api(err)) if err.code == 404 => TlsCertificate {
                secret_name: name,
                certificate: None,
                problem: Some(CertificateProblem::NoSecret),
            },
            Err(err) => TlsCertificate {
                secret_name: name,
                certificate: None,
                problem: Some(CertificateProblem::SecretUnreadable {
                    said: err.to_string(),
                }),
            },
        });
    }
    Ok(out)
}

fn read_tls_certificate(name: &str, secret: &Secret) -> TlsCertificate {
    let bytes = secret
        .data
        .as_ref()
        .and_then(|data| data.get("tls.crt"))
        .map(|value| value.0.clone());

    let (certificate, problem) = match bytes {
        Some(bytes) => match read_certificate(&bytes) {
            Ok(facts) => (Some(facts), None),
            Err(why) => (None, Some(why)),
        },
        None => (None, Some(CertificateProblem::NoTlsCrt)),
    };

    TlsCertificate {
        secret_name: name.to_string(),
        certificate,
        problem,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use k8s_openapi::ByteString;
    use std::collections::BTreeMap;

    fn secret_with(key: &str, value: &[u8]) -> Secret {
        let mut data = BTreeMap::new();
        data.insert(key.to_string(), ByteString(value.to_vec()));
        Secret {
            data: Some(data),
            ..Default::default()
        }
    }

    /// Would break if a Secret that is not a TLS Secret came back looking
    /// like one that simply has no certificate yet — those are different
    /// situations and only one of them is worth a reader's attention.
    #[test]
    fn a_secret_without_a_certificate_says_which_way_it_is_empty() {
        let read = read_tls_certificate("app-config", &secret_with("password", b"hunter2"));
        assert!(read.certificate.is_none());
        assert_eq!(read.problem, Some(CertificateProblem::NoTlsCrt));

        let read = read_tls_certificate("shop-tls", &secret_with("tls.crt", b"garbage"));
        assert!(read.certificate.is_none());
        assert_eq!(read.problem, Some(CertificateProblem::NoPemCertificate));
    }

    /// Would break if the private key next to the certificate were ever
    /// read by this path — it parses `tls.crt` and nothing else.
    #[test]
    fn only_tls_crt_is_read() {
        let key = include_str!("../../tests/fixtures/leaf.key.pem");
        let read = read_tls_certificate("shop-tls", &secret_with("tls.key", key.as_bytes()));
        assert!(read.certificate.is_none());
        assert_eq!(read.problem, Some(CertificateProblem::NoTlsCrt));
    }
}
