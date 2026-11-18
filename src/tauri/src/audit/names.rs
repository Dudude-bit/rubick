//! Three readings of a string: a variable name that suggests a secret, an
//! image reference that pins nothing, a host path that reaches a container
//! runtime's socket.

/// Words that, as a whole word of a variable name, say it holds a secret.
const SECRET_WORDS: &[&str] = &[
    "PASSWORD",
    "PASSWD",
    "PASS",
    "PASSPHRASE",
    "PWD",
    "SECRET",
    "SECRETS",
    "TOKEN",
    "TOKENS",
    "APIKEY",
    "CREDENTIAL",
    "CREDENTIALS",
];

/// A `KEY` is a secret only after one of these: `CACHE_KEY` is not.
const KEY_QUALIFIERS: &[&str] = &[
    "API",
    "ACCESS",
    "PRIVATE",
    "SECRET",
    "ENCRYPTION",
    "SIGNING",
    "MASTER",
    "CLIENT",
];

/// A last word that makes the variable about a secret rather than one:
/// where it is kept, what it is called, how long it lives, whether it is on.
const ABOUT_A_SECRET: &[&str] = &[
    "FILE", "FILES", "PATH", "DIR", "NAME", "NAMES", "URL", "URI", "ENDPOINT", "HOST", "PORT",
    "TTL", "TIMEOUT", "EXPIRY", "EXPIRES", "AGE", "LENGTH", "LEN", "SIZE", "TYPE", "MODE",
    "HEADER", "HEADERS", "FIELD", "ENABLED", "ENABLE", "DISABLED", "DISABLE", "REQUIRED", "POLICY",
    "ROTATION", "REF", "ID", "ISSUER", "AUDIENCE", "SECONDS", "MINUTES", "HOURS", "DAYS",
];

/// Values that switch something on or off.
const SWITCHES: &[&str] = &["yes", "no", "true", "false", "on", "off", "y", "n"];

/// Words that make a variable a switch about a secret rather than the
/// secret: `ALLOW_EMPTY_PASSWORD=yes` says there is none,
/// `MYSQL_RANDOM_ROOT_PASSWORD=yes` asks for one made up.
const SWITCHING: &[&str] = &[
    "ALLOW", "EMPTY", "RANDOM", "GENERATE", "ENABLE", "ENABLED", "DISABLE", "DISABLED", "SKIP",
    "USE", "REQUIRE", "REQUIRED",
];

/// The words of a variable name: split at `_`, `-`, `.` and a lower-case
/// letter followed by a capital, all upper-case.
fn words(name: &str) -> Vec<String> {
    let mut words = Vec::new();
    let mut word = String::new();
    let mut lower = false;
    for c in name.chars() {
        if !c.is_ascii_alphanumeric() {
            words.extend((!word.is_empty()).then(|| std::mem::take(&mut word)));
            lower = false;
            continue;
        }
        if c.is_ascii_uppercase() && lower {
            words.push(std::mem::take(&mut word));
        }
        lower = c.is_ascii_lowercase() || c.is_ascii_digit();
        word.push(c.to_ascii_uppercase());
    }
    words.extend((!word.is_empty()).then_some(word));
    words
}

/// Whether a variable's name suggests it holds a secret. A suggestion, not
/// a verdict: the rule says the name suggests one, never that it is.
#[must_use]
pub fn suggests_secret(name: &str) -> bool {
    let words = words(name);
    if words.len() == 1 && words[0] == "PWD" {
        return false;
    }
    if words
        .last()
        .is_some_and(|last| ABOUT_A_SECRET.contains(&last.as_str()))
    {
        return false;
    }
    words.iter().enumerate().any(|(at, word)| {
        SECRET_WORDS.contains(&word.as_str())
            || (word == "KEY" && at > 0 && KEY_QUALIFIERS.contains(&words[at - 1].as_str()))
    })
}

/// Whether an env value is a literal worth naming: not empty, and not only
/// a `$(VAR)` reference to another variable.
#[must_use]
pub fn is_literal(value: &str) -> bool {
    let value = value.trim();
    let reference = value.starts_with("$(") && value.ends_with(')') && !value[2..].contains("$(");
    !value.is_empty() && !reference
}

/// Whether a variable's literal value is the secret its name suggests. A
/// switch value counts unless the name says it switches something about a
/// secret: `DB_PASSWORD=true` is a password, `ALLOW_EMPTY_PASSWORD=yes` and
/// `OAUTH2_PROXY_PASS_ACCESS_TOKEN=true`, which passes a token on, are not.
#[must_use]
pub fn holds_a_secret(name: &str, value: &str) -> bool {
    if !is_literal(value) || !suggests_secret(name) {
        return false;
    }
    let switch = SWITCHES
        .iter()
        .any(|word| value.trim().eq_ignore_ascii_case(word));
    if !switch {
        return true;
    }
    let words = words(name);
    // `PASS` before another word is the verb: pass something on.
    let passes_on = words
        .iter()
        .take(words.len().saturating_sub(1))
        .any(|word| word == "PASS");
    !(passes_on || words.iter().any(|word| SWITCHING.contains(&word.as_str())))
}

/// Whether an image reference pins nothing: tagged `latest`, or neither
/// tagged nor digested, which pulls `latest`.
#[must_use]
pub fn floats(image: &str) -> bool {
    if image.contains('@') {
        return false;
    }
    let last = image.rsplit('/').next().unwrap_or(image);
    match last.rsplit_once(':') {
        Some((_, tag)) => tag == "latest",
        None => true,
    }
}

/// The sockets a container runtime listens on by default: containerd and
/// CRI-O (setup/production-environment/container-runtimes), cri-dockerd
/// (same page) and Docker Engine (moby docs/reference/dockerd.md); k3s's
/// containerd and cri-dockerd (k3s `pkg/agent/config/config_linux.go`; RKE2
/// names the same containerd socket, `pkg/executor/staticpod/spw.go`) and
/// `MicroK8s`'s (`--address ${SNAP_COMMON}/run/containerd.sock`,
/// `microk8s-resources/default-args/containerd`).
const SOCKETS: &[&str] = &[
    "/run/containerd/containerd.sock",
    "/var/run/crio/crio.sock",
    "/run/cri-dockerd.sock",
    "/var/run/docker.sock",
    "/run/k3s/containerd/containerd.sock",
    "/run/k3s/cri-dockerd/cri-dockerd.sock",
    "/var/snap/microk8s/common/run/containerd.sock",
];

/// The runtime socket a hostPath reaches, where it reaches one: the socket
/// itself or any directory above it. `/var/run` and `/run` are one directory
/// (FHS 3.0 §5.13 allows the first as a link to the second), so each path is
/// read under both spellings.
#[must_use]
pub fn reaches_socket(path: &str) -> Option<&'static str> {
    let path = normalised(path);
    let spellings = [path.clone(), swapped_run(&path)];
    SOCKETS.iter().copied().find(|socket| {
        let socket_spellings = [(*socket).to_string(), swapped_run(socket)];
        spellings.iter().any(|path| {
            socket_spellings.iter().any(|socket| {
                path == "/" || socket == path || socket.starts_with(&format!("{path}/"))
            })
        })
    })
}

fn normalised(path: &str) -> String {
    let mut parts = Vec::new();
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            part => parts.push(part),
        }
    }
    format!("/{}", parts.join("/"))
}

fn swapped_run(path: &str) -> String {
    if let Some(rest) = path.strip_prefix("/var/run") {
        if rest.is_empty() || rest.starts_with('/') {
            return format!("/run{rest}");
        }
    }
    if let Some(rest) = path.strip_prefix("/run") {
        if rest.is_empty() || rest.starts_with('/') {
            return format!("/var/run{rest}");
        }
    }
    path.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A name built on a secret word, in every way names are written. Fails
    /// if any of them stops reading as one.
    #[test]
    fn a_name_built_on_a_secret_word_suggests_a_secret() {
        for name in [
            "DB_PASSWORD",
            "POSTGRES_PASSWORD",
            "REDIS_PASS",
            "API_KEY",
            "apiKey",
            "AWS_SECRET_ACCESS_KEY",
            "GITHUB_TOKEN",
            "clientSecret",
            "SMTP_PASSWD",
            "ENCRYPTION_KEY",
            "mysql-root-password",
            "DB_PWD",
            "OAUTH_CREDENTIALS",
        ] {
            assert!(suggests_secret(name), "{name}");
        }
    }

    /// Names about a secret, or holding a secret word only inside a longer
    /// one. Fails if any of them is called a secret.
    #[test]
    fn a_name_about_a_secret_or_merely_containing_the_letters_does_not() {
        for name in [
            "TOKEN_FILE",
            "PASSWORD_PATH",
            "SECRET_NAME",
            "TOKEN_URL",
            "TOKEN_TTL",
            "SECRETS_DIR",
            "PASSWORD_MIN_LENGTH",
            "TOKEN_ENDPOINT",
            "PASSWORD_ENABLED",
            "SECRET_REF",
            "PWD",
            "KEY",
            "CACHE_KEY",
            "BYPASS_CACHE",
            "PASSTHROUGH",
            "KEYCLOAK_URL",
            "TOKENIZER_MODEL",
            "SECRETARY",
            "HOME",
            "TOKEN_ISSUER",
            "TOKEN_AUDIENCE",
            "PASSWORD_RESET_TIMEOUT_MINUTES",
            "OAUTH2_PROXY_PASS_USER_HEADERS",
        ] {
            assert!(!suggests_secret(name), "{name}");
        }
    }

    /// An empty value and a reference to another variable carry no secret.
    /// Fails if either is called a literal, or a real value is not.
    #[test]
    fn only_a_value_that_is_more_than_a_reference_is_a_literal() {
        assert!(!is_literal(""));
        assert!(!is_literal("  "));
        assert!(!is_literal("$(DB_PASSWORD)"));
        assert!(is_literal("hunter2-but-longer"));
        assert!(is_literal("$(PREFIX)-$(SUFFIX)"));
    }

    /// A switch value is no secret where the name says it switches one, and
    /// is one where the name is the secret's own. Fails if
    /// `ALLOW_EMPTY_PASSWORD=yes` is a finding, or `DB_PASSWORD=true` is not.
    #[test]
    fn a_switch_is_a_secret_only_where_the_name_is_the_secrets_own() {
        for (name, value) in [
            ("ALLOW_EMPTY_PASSWORD", "yes"),
            ("MYSQL_RANDOM_ROOT_PASSWORD", "yes"),
            ("OAUTH2_PROXY_PASS_ACCESS_TOKEN", "true"),
            ("SKIP_TOKEN_VERIFY", "True"),
        ] {
            assert!(!holds_a_secret(name, value), "{name}={value}");
        }
        for (name, value) in [
            ("DB_PASSWORD", "true"),
            ("POSTGRES_PASSWORD", " OFF "),
            ("REDIS_PASS", "yes"),
            ("DB_PASSWORD", "hunter2-but-longer"),
        ] {
            assert!(holds_a_secret(name, value), "{name}={value}");
        }
        assert!(!holds_a_secret("DB_PASSWORD", "$(FROM_SECRET)"));
        assert!(!holds_a_secret("LOG_LEVEL", "debug"));
    }

    /// `latest`, and no tag at all, pull whatever was pushed last. Fails if
    /// a registry port is taken for a tag, or a digest is not a pin.
    #[test]
    fn an_image_pins_by_a_tag_other_than_latest_or_by_a_digest() {
        assert!(floats("nginx"));
        assert!(floats("nginx:latest"));
        assert!(floats("registry.local:5000/team/app"));
        assert!(!floats("registry.local:5000/team/app:1.4.2"));
        assert!(!floats("nginx@sha256:0123"));
        assert!(!floats("nginx:latest@sha256:0123"));
        assert!(!floats("quay.io/prometheus/prometheus:v3.1.0"));
    }

    /// The socket, its directory, `/run` under its other name, and the
    /// whole root all reach a runtime. Fails if any of them does not, or if a
    /// directory beside them is taken for one.
    #[test]
    fn a_host_path_reaches_a_runtime_socket_through_any_directory_above_it() {
        assert_eq!(
            reaches_socket("/var/run/docker.sock"),
            Some("/var/run/docker.sock")
        );
        assert_eq!(
            reaches_socket("/run/docker.sock"),
            Some("/var/run/docker.sock")
        );
        assert_eq!(
            reaches_socket("/run/containerd/"),
            Some("/run/containerd/containerd.sock")
        );
        assert_eq!(
            reaches_socket("/var/run/containerd/containerd.sock"),
            Some("/run/containerd/containerd.sock")
        );
        assert!(reaches_socket("/var/run").is_some());
        assert!(reaches_socket("/").is_some());
        assert_eq!(
            reaches_socket("/run/k3s"),
            Some("/run/k3s/containerd/containerd.sock")
        );
        assert_eq!(
            reaches_socket("/var/snap/microk8s/common/run/containerd.sock"),
            Some("/var/snap/microk8s/common/run/containerd.sock")
        );
        assert_eq!(reaches_socket("/var/log"), None);
        assert_eq!(reaches_socket("/run/containerd-not"), None);
        assert_eq!(reaches_socket("/var/lib/kubelet"), None);
    }
}
