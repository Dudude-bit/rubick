//! The TLS every `reqwest` client here is built on: rustls on the ring
//! provider, verified by the platform. The cluster's client is kube's own.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};

use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::{CryptoProvider, WebPkiSupportedAlgorithms};
use rustls::pki_types::{
    alg_id, AlgorithmIdentifier, CertificateDer, InvalidSignature, ServerName,
    SignatureVerificationAlgorithm, UnixTime,
};
use rustls::{CertificateError, DigitallySignedStruct, SignatureScheme};

/// ring, and an ECDSA P-521 verifier ring does not have: a Prometheus, Loki
/// or identity provider serving a P-521 certificate reached through the
/// platform's TLS until 4.20.0 and must still. `main` installs it as the
/// process default, which is what kube's client uses; it is installed here
/// when missing, because reqwest panics on `build()` without one and a test
/// or a harness never went through `main`. Every `reqwest` client here takes
/// this one whatever the default is.
pub fn provider() -> Arc<CryptoProvider> {
    static PROVIDER: OnceLock<Arc<CryptoProvider>> = OnceLock::new();
    let provider = PROVIDER
        .get_or_init(|| {
            let mut provider = rustls::crypto::ring::default_provider();
            provider.signature_verification_algorithms =
                with_p521(provider.signature_verification_algorithms);
            Arc::new(provider)
        })
        .clone();
    if CryptoProvider::get_default().is_none()
        && CryptoProvider::install_default((*provider).clone()).is_ok()
    {
        INSTALLED.store(true, Ordering::Release);
    }
    provider
}

/// Set when this module's own install became the process default: the
/// default is once-only, so that is the whole proof of whose it is.
static INSTALLED: AtomicBool = AtomicBool::new(false);

/// Whether the process default is this provider — what kube's client uses.
/// One installed first by anything else would leave kube without P-521 while
/// every `reqwest` client here had it.
#[must_use]
pub fn default_is_ours() -> bool {
    INSTALLED.load(Ordering::Acquire)
}

fn with_p521(ring: WebPkiSupportedAlgorithms) -> WebPkiSupportedAlgorithms {
    static P521: &[&dyn SignatureVerificationAlgorithm] = &[&EcdsaP521Sha512];
    let all: Vec<&'static dyn SignatureVerificationAlgorithm> = ring
        .all
        .iter()
        .copied()
        .chain(P521.iter().copied())
        .collect();
    let mapping: Vec<(
        SignatureScheme,
        &'static [&'static dyn SignatureVerificationAlgorithm],
    )> = ring
        .mapping
        .iter()
        .copied()
        .chain([(SignatureScheme::ECDSA_NISTP521_SHA512, P521)])
        .collect();
    // Once per process: `provider` builds this a single time.
    WebPkiSupportedAlgorithms {
        all: Vec::leak(all),
        mapping: Vec::leak(mapping),
    }
}

/// ECDSA over P-521 with SHA-512, the one combination a P-521 key signs a
/// TLS handshake with and the usual one on a P-521 certificate.
#[derive(Debug)]
struct EcdsaP521Sha512;

impl SignatureVerificationAlgorithm for EcdsaP521Sha512 {
    fn verify_signature(
        &self,
        public_key: &[u8],
        message: &[u8],
        signature: &[u8],
    ) -> Result<(), InvalidSignature> {
        use p521::ecdsa::signature::Verifier;
        let key =
            p521::ecdsa::VerifyingKey::from_sec1_bytes(public_key).map_err(|_| InvalidSignature)?;
        let signature =
            p521::ecdsa::Signature::from_der(signature).map_err(|_| InvalidSignature)?;
        key.verify(message, &signature)
            .map_err(|_| InvalidSignature)
    }

    fn public_key_alg_id(&self) -> AlgorithmIdentifier {
        alg_id::ECDSA_P521
    }

    fn signature_alg_id(&self) -> AlgorithmIdentifier {
        alg_id::ECDSA_SHA512
    }
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
    let config = rustls::ClientConfig::builder_with_provider(provider())
        .with_safe_default_protocol_versions()?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(pinned(roots)?))
        .with_no_client_auth();
    Ok(builder().tls_backend_preconfigured(config))
}

fn pinned(roots: Vec<CertificateDer<'static>>) -> Result<Pinned, rustls::Error> {
    let provider = provider();
    let platform =
        rustls_platform_verifier::Verifier::new_with_extra_roots(roots.clone(), provider.clone())?;
    Ok(Pinned {
        platform,
        named: roots,
        provider,
    })
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

    /// ring verifies no ECDSA P-521 signature, so without the extra verifier
    /// a Prometheus, Loki or identity provider serving a P-521 certificate
    /// failed the handshake from 4.20.0; a client only offers the scheme the
    /// provider maps.
    #[test]
    fn the_provider_offers_p521_beside_rings_own() {
        let offered = provider()
            .signature_verification_algorithms
            .supported_schemes();
        assert!(offered.contains(&SignatureScheme::ECDSA_NISTP384_SHA384));
        assert!(offered.contains(&SignatureScheme::ECDSA_NISTP521_SHA512));
    }

    /// Every place that installs a provider installs this one; a stray ring
    /// install won the race in tests and left kube on a different policy.
    /// (rustls itself installs ring on the first `ClientConfig::builder()`
    /// in a process with no default, which is why `main` goes first and
    /// asserts it did; the fresh-process test below checks that path.)
    #[test]
    fn nothing_but_this_module_installs_a_provider() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        let mut stray = Vec::new();
        let mut dirs = vec![root.join("src"), root.join("tests")];
        while let Some(dir) = dirs.pop() {
            for entry in std::fs::read_dir(&dir).expect("dir") {
                let path = entry.expect("an entry").path();
                if path.is_dir() {
                    dirs.push(path);
                } else if path.extension().is_some_and(|ext| ext == "rs")
                    && !path.ends_with("src/tls.rs")
                    && std::fs::read_to_string(&path)
                        .expect("a source file")
                        .contains(".install_default()")
                {
                    stray.push(path.display().to_string());
                }
            }
        }
        assert!(
            stray.is_empty(),
            "providers installed outside tls.rs: {stray:?}"
        );
    }

    /// A signature is checked, not merely parsed: a verifier that returned
    /// `Ok` for anything well-formed would pass the handshake too.
    #[test]
    fn a_p521_signature_verifies_and_a_changed_message_does_not() {
        use p521::ecdsa::signature::Signer;
        use p521::elliptic_curve::sec1::ToEncodedPoint;
        let mut secret = [7u8; 66];
        secret[0] = 0; // below the curve order
        let signing = p521::ecdsa::SigningKey::from_slice(&secret).expect("key");
        let public = p521::ecdsa::VerifyingKey::from(&signing)
            .as_affine()
            .to_encoded_point(false);
        let signature: p521::ecdsa::Signature = signing.sign(b"handshake");
        let der = signature.to_der();

        let verify = |message: &[u8]| {
            EcdsaP521Sha512.verify_signature(public.as_bytes(), message, der.as_bytes())
        };
        assert!(verify(b"handshake").is_ok());
        assert!(verify(b"handshakf").is_err());
    }

    /// Would break if a client built where `main` never ran — a filtered test
    /// run, a live harness — panicked with "No provider set" again. In a fresh
    /// process, because any earlier test may have installed one in this.
    ///
    /// A filter that matches nothing exits 0 too, so the child has to say it
    /// ran the one test.
    #[test]
    fn a_client_builds_in_a_process_that_never_ran_main() {
        let output = std::process::Command::new(std::env::current_exe().expect("test binary"))
            .args([
                "--exact",
                "tls::tests::fresh_process_builds_clients",
                "--ignored",
            ])
            .env("RUBICK_FRESH_PROCESS", "1")
            .output()
            .expect("the test binary runs");
        let said = String::from_utf8_lossy(&output.stdout);
        assert!(output.status.success(), "{said}");
        assert!(
            said.contains("test result: ok. 1 passed;"),
            "the fresh-process test did not run: {said}"
        );
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

    fn fixture(pem: &[u8]) -> CertificateDer<'static> {
        rustls_pemfile::certs(&mut &*pem)
            .next()
            .expect("a certificate")
            .expect("parses")
    }

    fn served(
        verifier: &Pinned,
        cert: &CertificateDer<'_>,
        host: &str,
        secs: u64,
    ) -> Result<ServerCertVerified, rustls::Error> {
        verifier.verify_server_cert(
            cert,
            &[],
            &ServerName::try_from(host.to_string()).expect("a name"),
            &[],
            UnixTime::since_unix_epoch(std::time::Duration::from_secs(secs)),
        )
    }

    /// Would break if the verifier stopped asking the pinned certificate to
    /// name the host and be in date once the platform refused it — then an
    /// `idp-certificate-authority` would vouch for any host, for ever. The
    /// platform refuses this `CA:TRUE` certificate as a server's, so every
    /// answer here is the pinned path's.
    #[test]
    fn the_verifier_takes_the_named_certificate_only_for_its_host_and_dates() {
        let cert = fixture(include_bytes!("../tests/fixtures/pinned-localhost.crt.pem"));
        let verifier = pinned(vec![cert.clone()]).expect("a verifier");

        assert!(served(&verifier, &cert, "localhost", 1_800_000_000).is_ok());
        assert_eq!(
            served(&verifier, &cert, "evil.example", 1_800_000_000).err(),
            Some(rustls::Error::InvalidCertificate(
                CertificateError::NotValidForName
            ))
        );
        assert_eq!(
            served(&verifier, &cert, "localhost", 5_000_000_000).err(),
            Some(rustls::Error::InvalidCertificate(CertificateError::Expired))
        );
    }

    /// Would break if "the kubeconfig names it" were loosened to anything
    /// short of the same bytes: an attacker's own self-signed certificate
    /// for the host, in date, would then pass as the provider's.
    #[test]
    fn the_verifier_refuses_a_certificate_the_kubeconfig_does_not_name() {
        let other = fixture(include_bytes!("../tests/fixtures/leaf.crt.pem"));
        let cert = fixture(include_bytes!("../tests/fixtures/pinned-localhost.crt.pem"));
        let verifier = pinned(vec![other]).expect("a verifier");

        assert!(served(&verifier, &cert, "localhost", 1_800_000_000).is_err());
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
        assert!(default_is_ours(), "the default is not this provider");
    }
}
