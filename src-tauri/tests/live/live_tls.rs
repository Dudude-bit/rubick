//! The app's HTTPS clients against local servers with the certificates people
//! actually run: a private CA with a proper SAN, one with a Common Name only,
//! a self-signed one. Needs `openssl` and `python3`; no cluster.
//!
//! ```text
//! cargo test --test live live_tls:: -- --ignored --nocapture
//! ```
//!
//! What it pins is the single TLS stack — rustls on ring with the platform
//! verifier — so a change to it shows here, not in a user's Prometheus.

use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::time::Duration;

use k8s_gui_lib::auth::OidcAuth;
use k8s_gui_lib::integrations::wire;

/// A server answering OIDC discovery and a token exchange over TLS.
const SERVER: &str = r#"
import http.server, json, ssl, sys
port, cert, key = int(sys.argv[1]), sys.argv[2], sys.argv[3]
base = "https://localhost:%d" % port
class H(http.server.BaseHTTPRequestHandler):
    def reply(self, body):
        data = json.dumps(body).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)
    def do_GET(self):
        self.reply({"issuer": base, "authorization_endpoint": base + "/auth",
                    "token_endpoint": base + "/token"})
    def do_POST(self):
        length = int(self.headers.get("content-length", 0))
        form = self.rfile.read(length).decode()
        self.reply({"access_token": "a", "id_token": "form:" + form,
                    "token_type": "Bearer", "expires_in": 60})
    def log_message(self, *a): pass
ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
ctx.load_cert_chain(cert, key)
srv = http.server.HTTPServer(("127.0.0.1", port), H)
srv.socket = ctx.wrap_socket(srv.socket, server_side=True)
srv.serve_forever()
"#;

fn openssl(dir: &Path, args: &[&str]) {
    let status = Command::new("openssl")
        .args(args)
        .current_dir(dir)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .expect("openssl runs");
    assert!(status.success(), "openssl {args:?}");
}

/// A CA, and a leaf it signs for localhost, with or without a SAN.
fn signed(dir: &Path, name: &str, san: bool) {
    openssl(
        dir,
        &[
            "req",
            "-newkey",
            "rsa:2048",
            "-nodes",
            "-keyout",
            &format!("{name}.key"),
            "-subj",
            "/CN=localhost",
            "-out",
            &format!("{name}.csr"),
        ],
    );
    let ext = format!("{name}.ext");
    std::fs::write(
        dir.join(&ext),
        if san {
            "subjectAltName=DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\n"
        } else {
            "extendedKeyUsage=serverAuth\n"
        },
    )
    .expect("ext");
    openssl(
        dir,
        &[
            "x509",
            "-req",
            "-in",
            &format!("{name}.csr"),
            "-CA",
            "ca.crt",
            "-CAkey",
            "ca.key",
            "-CAcreateserial",
            "-days",
            "2",
            "-sha256",
            "-extfile",
            &ext,
            "-out",
            &format!("{name}.crt"),
        ],
    );
}

fn free_port() -> u16 {
    std::net::TcpListener::bind(("127.0.0.1", 0))
        .expect("bind")
        .local_addr()
        .expect("addr")
        .port()
}

struct Server(Child);
impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.0.kill();
    }
}

async fn serve(dir: &Path, name: &str) -> (Server, u16) {
    let port = free_port();
    let child = Command::new("python3")
        .arg(dir.join("server.py"))
        .arg(port.to_string())
        .arg(dir.join(format!("{name}.crt")))
        .arg(dir.join(format!("{name}.key")))
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("python3 runs");
    for _ in 0..50 {
        if std::net::TcpStream::connect(("127.0.0.1", port)).is_ok() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    (Server(child), port)
}

#[tokio::test]
#[ignore = "needs openssl and python3"]
async fn the_https_clients_answer_as_the_one_tls_stack_should() {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let dir = tempfile::tempdir().expect("tempdir");
    let dir = dir.path();
    std::fs::write(dir.join("server.py"), SERVER).expect("script");
    openssl(
        dir,
        &[
            "req",
            "-x509",
            "-newkey",
            "rsa:2048",
            "-nodes",
            "-keyout",
            "ca.key",
            "-subj",
            "/CN=Rubick test CA",
            "-days",
            "2",
            "-out",
            "ca.crt",
        ],
    );
    signed(dir, "san", true);
    signed(dir, "cn", false);
    let ca = std::fs::read(dir.join("ca.crt")).expect("ca");

    let (_san, san_port) = serve(dir, "san").await;
    let (_cn, cn_port) = serve(dir, "cn").await;
    let get = |insecure: bool, port: u16| async move {
        wire::client(insecure)
            .expect("client")
            .get(format!("https://localhost:{port}/"))
            .send()
            .await
    };

    // An integration with "skip verification" on talks to anything.
    assert!(get(true, san_port).await.is_ok(), "insecure, SAN");
    assert!(get(true, cn_port).await.is_ok(), "insecure, CN-only");
    // With it off, a private CA the machine does not trust is refused.
    assert!(get(false, san_port).await.is_err(), "secure, untrusted CA");

    // OIDC with the kubeconfig's `idp-certificate-authority`: discovery over
    // GET and the code exchange as a form POST, the path `.form()` feeds.
    let issuer = |port: u16| {
        OidcAuth::new(
            format!("https://localhost:{port}"),
            "rubick".into(),
            None,
            vec![],
        )
        .with_idp_ca(Some(ca.clone()))
    };
    let url = issuer(san_port)
        .generate_auth_url("http://localhost:8000/callback")
        .await
        .expect("discovery with the provider's CA");
    assert!(url
        .url
        .starts_with(&format!("https://localhost:{san_port}/auth?")));
    let token = issuer(san_port)
        .exchange_code("the-code", "http://localhost:8000/callback", "verifier")
        .await
        .expect("code exchange with the provider's CA");
    assert!(
        token.token.contains("grant_type=authorization_code")
            && token.token.contains("code=the-code"),
        "the form arrived: {}",
        token.token
    );

    // A leaf with a Common Name and no SAN: rustls matches names against the
    // SAN only, as browsers have since 2017. OpenSSL on Linux fell back to the
    // CN; this is the one answer the stack change moves there.
    let cn_only = issuer(cn_port)
        .generate_auth_url("http://localhost:8000/callback")
        .await;
    println!(
        "CN-only with the provider's CA: {:?}",
        cn_only.as_ref().map(|_| "ok")
    );
    assert!(
        cn_only.is_err(),
        "a certificate without a SAN names no host"
    );

    // The machine's own roots, through the platform verifier.
    let public = wire::client(false)
        .expect("client")
        .get("https://kubernetes.io/")
        .send()
        .await;
    println!(
        "public site: {:?}",
        public.as_ref().map(reqwest::Response::status)
    );
    assert!(public.is_ok(), "the platform verifier trusts a public CA");
}
