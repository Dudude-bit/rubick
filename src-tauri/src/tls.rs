//! The TLS every `reqwest` client here is built on: rustls on the ring
//! provider, verified by the platform. The cluster's client is kube's own.

use std::sync::Arc;

use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::CryptoProvider;
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{CertificateError, DigitallySignedStruct, SignatureScheme};

/// ring, which `main` installs before anything else runs — and which is
/// installed here when missing, because reqwest panics on `build()` without a
/// process default and a test or a harness never went through `main`.
pub fn provider() -> Arc<CryptoProvider> {
    if CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
    CryptoProvider::get_default().map_or_else(
        || Arc::new(rustls::crypto::ring::default_provider()),
        Arc::clone,
    )
}

/// A builder for plain HTTP, or for a server whose certificate is not checked.
#[allow(clippy::disallowed_methods)]
pub fn builder() -> reqwest::ClientBuilder {
    provider();
    reqwest::Client::builder()
}

/// A builder trusting the certificates a kubeconfig names on top of the
/// platform's roots — and a server presenting exactly one of them, although
/// it is marked a CA as everything `openssl req -x509` makes is. webpki and
/// the platform refuse that shape as a server certificate; kubectl accepts it.
pub fn trusting(
    roots: Vec<CertificateDer<'static>>,
) -> Result<reqwest::ClientBuilder, rustls::Error> {
    let provider = provider();
    let platform =
        rustls_platform_verifier::Verifier::new_with_extra_roots(roots.clone(), provider.clone())?;
    let config = rustls::ClientConfig::builder_with_provider(provider.clone())
        .with_safe_default_protocol_versions()?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(Pinned {
            platform,
            named: roots,
            provider,
        }))
        .with_no_client_auth();
    Ok(builder().tls_backend_preconfigured(config))
}

#[derive(Debug)]
struct Pinned {
    platform: rustls_platform_verifier::Verifier,
    named: Vec<CertificateDer<'static>>,
    provider: Arc<CryptoProvider>,
}

impl ServerCertVerifier for Pinned {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        server_name: &ServerName<'_>,
        ocsp: &[u8],
        now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        let refused = match self.platform.verify_server_cert(
            end_entity,
            intermediates,
            server_name,
            ocsp,
            now,
        ) {
            Ok(verified) => return Ok(verified),
            Err(refused) => refused,
        };
        if !self
            .named
            .iter()
            .any(|named| named.as_ref() == end_entity.as_ref())
        {
            return Err(refused);
        }
        pinned_holds(end_entity, server_name, now)?;
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.provider
            .signature_verification_algorithms
            .supported_schemes()
    }
}

/// A pinned certificate is trusted for what it is, not for where it came
/// from: it still has to name the host and be within its dates.
fn pinned_holds(
    cert: &CertificateDer<'_>,
    server_name: &ServerName<'_>,
    now: UnixTime,
) -> Result<(), rustls::Error> {
    let bad = |error| rustls::Error::InvalidCertificate(error);
    webpki::EndEntityCert::try_from(cert)
        .map_err(|_| bad(CertificateError::BadEncoding))?
        .verify_is_valid_for_subject_name(server_name)
        .map_err(|_| bad(CertificateError::NotValidForName))?;
    let (_, parsed) = x509_parser::parse_x509_certificate(cert.as_ref())
        .map_err(|_| bad(CertificateError::BadEncoding))?;
    let at = i64::try_from(now.as_secs()).unwrap_or(i64::MAX);
    let validity = parsed.validity();
    if at < validity.not_before.timestamp() {
        return Err(bad(CertificateError::NotValidYet));
    }
    if at > validity.not_after.timestamp() {
        return Err(bad(CertificateError::Expired));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Would break if a client built where `main` never ran — a filtered test
    /// run, a live harness — panicked with "No provider set" again. In a fresh
    /// process, because any earlier test may have installed one in this.
    #[test]
    fn a_client_builds_in_a_process_that_never_ran_main() {
        let status = std::process::Command::new(std::env::current_exe().expect("test binary"))
            .args([
                "--exact",
                "tls::tests::fresh_process_builds_clients",
                "--ignored",
            ])
            .env("RUBICK_FRESH_PROCESS", "1")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .expect("the test binary runs");
        assert!(status.success());
    }

    /// A certificate the kubeconfig names is trusted as itself, not as a
    /// blank cheque: served for another host, or outside its dates, it is
    /// refused like any other.
    #[test]
    fn a_pinned_certificate_still_has_to_name_the_host_and_be_in_date() {
        let pem = include_bytes!("../tests/fixtures/pinned-localhost.crt.pem");
        let cert = rustls_pemfile::certs(&mut pem.as_slice())
            .next()
            .expect("a certificate")
            .expect("parses");
        let host = |name: &str| ServerName::try_from(name.to_string()).expect("a name");
        let at = |secs: u64| UnixTime::since_unix_epoch(std::time::Duration::from_secs(secs));
        let now = at(1_800_000_000);

        assert!(pinned_holds(&cert, &host("localhost"), now).is_ok());
        assert_eq!(
            pinned_holds(&cert, &host("evil.example"), now),
            Err(rustls::Error::InvalidCertificate(
                CertificateError::NotValidForName
            ))
        );
        assert_eq!(
            pinned_holds(&cert, &host("localhost"), at(1_000_000_000)),
            Err(rustls::Error::InvalidCertificate(
                CertificateError::NotValidYet
            ))
        );
        assert_eq!(
            pinned_holds(&cert, &host("localhost"), at(5_000_000_000)),
            Err(rustls::Error::InvalidCertificate(CertificateError::Expired))
        );
    }

    #[test]
    #[ignore = "run in its own process by the test above"]
    fn fresh_process_builds_clients() {
        if std::env::var_os("RUBICK_FRESH_PROCESS").is_none() {
            return;
        }
        assert!(
            CryptoProvider::get_default().is_none(),
            "not a fresh process"
        );
        builder().build().expect("a plain client");
    }
}
