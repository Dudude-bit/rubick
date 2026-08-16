//! Shared exec-credential types used by both the exec flow and the
//! native-cloud fallback that fakes one.

use kube::config::ExecAuthCluster;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Deserialize)]
pub(super) struct ExecCredential {
    pub status: Option<ExecCredentialStatus>,
}

#[derive(Debug, Deserialize)]
pub(super) struct ExecCredentialStatus {
    #[serde(rename = "expirationTimestamp")]
    pub expiration_timestamp: Option<String>,
    pub token: Option<String>,
    #[serde(rename = "clientCertificateData")]
    pub client_certificate_data: Option<String>,
    #[serde(rename = "clientKeyData")]
    pub client_key_data: Option<String>,
}

#[derive(Debug, Serialize)]
pub(super) struct ExecCredentialSpec {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub interactive: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cluster: Option<ExecAuthCluster>,
}

#[derive(Debug, Serialize)]
pub(super) struct ExecCredentialRequest {
    pub kind: Option<String>,
    #[serde(rename = "apiVersion")]
    pub api_version: Option<String>,
    pub spec: Option<ExecCredentialSpec>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<serde_json::Value>,
}

/// Parameters for creating a terminal session for exec auth
pub(super) struct ExecTerminalParams {
    pub command: String,
    pub args: Vec<String>,
    pub env: HashMap<String, String>,
}

/// Extract an `ExecCredential` JSON object from a (possibly noisy)
/// stdout buffer.
///
/// Why this is needed: `AuthExecAdapter` runs the auth child under a
/// real PTY (so tools that gate on `isatty(stdin)` print their
/// prompts). All PTY stdout — prompts, status lines, occasional ANSI
/// control sequences, then the final `ExecCredential` JSON — is
/// tee'd into a single `Vec<u8>`. Calling `serde_json::from_slice`
/// on the raw buffer fails with `expected value at line N column 1`
/// because the bytes don't start with `{`.
///
/// Approach: kubectl exec-credential plugins emit the JSON
/// `ExecCredential` as their last structured output. Scan the buffer
/// for every byte position where a `{` begins, then for each
/// candidate (newest first) try to consume a single balanced JSON
/// object starting there and parse it as `ExecCredential`. The first
/// one that parses *and* has a recognisable `kind`/`status` wins.
///
/// Returns the parse error from the earliest-attempted candidate when
/// nothing parses, so error messages stay close to what
/// `from_slice(&buffer)` used to say in the clean-input case.
pub(super) fn extract_exec_credential(buffer: &[u8]) -> Result<ExecCredential, String> {
    let starts: Vec<usize> = buffer
        .iter()
        .enumerate()
        .filter_map(|(i, &b)| if b == b'{' { Some(i) } else { None })
        .collect();

    if starts.is_empty() {
        return Err(format!(
            "no JSON object found in {} bytes of stdout",
            buffer.len()
        ));
    }

    let mut last_parse_err: Option<String> = None;
    let mut fallback_no_status: Option<ExecCredential> = None;

    // Walk candidates newest-first. ExecCredential is the final
    // structured output, so a later `{` is more likely to be the
    // real one. The `has_status` filter is what keeps us from
    // mistaking a nested `{"token": "..."}` (inside the outer
    // `"status": { ... }`) for the credential itself — that nested
    // fragment also parses successfully into `ExecCredential` since
    // every field is `Option`, but its `.status` is `None`.
    for &start in starts.iter().rev() {
        let end = match find_balanced_object_end(&buffer[start..]) {
            Some(rel_end) => start + rel_end,
            None => continue,
        };

        match serde_json::from_slice::<ExecCredential>(&buffer[start..=end]) {
            Ok(cred) if cred.status.is_some() => return Ok(cred),
            Ok(cred) => {
                // Parses, but no `status` — keep as fallback so the
                // downstream "missing status" error message stays
                // accurate when nothing better turns up.
                fallback_no_status.get_or_insert(cred);
            }
            Err(e) => last_parse_err = Some(e.to_string()),
        }
    }

    if let Some(cred) = fallback_no_status {
        return Ok(cred);
    }
    Err(last_parse_err.unwrap_or_else(|| "no parseable JSON object in stdout".to_string()))
}

/// Find the offset of the matching closing brace for the `{` at
/// position 0 of `slice`. Returns `None` if the braces don't balance
/// before EOF. Respects JSON string literals so `}` inside a string
/// doesn't close the object.
fn find_balanced_object_end(slice: &[u8]) -> Option<usize> {
    debug_assert_eq!(slice.first().copied(), Some(b'{'));

    let mut depth = 0usize;
    let mut in_string = false;
    let mut escaped = false;

    for (i, &b) in slice.iter().enumerate() {
        if in_string {
            if escaped {
                escaped = false;
            } else if b == b'\\' {
                escaped = true;
            } else if b == b'"' {
                in_string = false;
            }
            continue;
        }
        match b {
            b'"' => in_string = true,
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(i);
                }
            }
            _ => {}
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_plain_exec_credential() {
        // Sanity: an unadorned JSON payload still parses (this is
        // what the old `from_slice(buffer)` path used to handle).
        let buf = br#"{
            "kind": "ExecCredential",
            "apiVersion": "client.authentication.k8s.io/v1beta1",
            "status": { "token": "abc123" }
        }"#;
        let cred = extract_exec_credential(buf).expect("clean JSON must parse");
        assert_eq!(cred.status.unwrap().token.as_deref(), Some("abc123"));
    }

    #[test]
    fn skips_prompt_noise_before_json() {
        // Real `kubectl-oidc_login` output under PTY: a "please open
        // this URL" prompt, blank line, then the JSON payload.
        // serde_json::from_slice on the raw buffer fails with
        // "expected value at line 2 column 1" — exactly the user's
        // production error.
        let buf = b"Please visit the following URL to authenticate: https://sso.example.com/realms/demo\n\n{\"kind\":\"ExecCredential\",\"status\":{\"token\":\"tok-after-prompt\"}}";
        let cred = extract_exec_credential(buf).expect("must extract JSON past prompt");
        assert_eq!(
            cred.status.unwrap().token.as_deref(),
            Some("tok-after-prompt")
        );
    }

    #[test]
    fn picks_last_json_when_multiple_objects_present() {
        // Some plugins emit a JSON-shaped progress line mid-run and
        // the real ExecCredential at the end. The final object wins.
        let buf = b"{\"progress\":\"opening browser\"}\n{\"kind\":\"ExecCredential\",\"status\":{\"token\":\"final-token\"}}";
        let cred = extract_exec_credential(buf).expect("must prefer the last JSON block");
        assert_eq!(cred.status.unwrap().token.as_deref(), Some("final-token"));
    }

    #[test]
    fn handles_ansi_control_sequences_before_json() {
        // PTY output sometimes carries terminal control sequences
        // (e.g. clear-line, cursor moves) that contain `[` and other
        // punctuation. Make sure they don't confuse the scanner.
        let buf = b"\x1b[2K\x1b[1G> waiting for login...\x1b[0m\n{\"kind\":\"ExecCredential\",\"status\":{\"token\":\"after-ansi\"}}";
        let cred = extract_exec_credential(buf).expect("must skip ANSI noise");
        assert_eq!(cred.status.unwrap().token.as_deref(), Some("after-ansi"));
    }

    #[test]
    fn errors_when_no_json_object_in_buffer() {
        let buf = b"just plain text, no braces at all\n";
        assert!(extract_exec_credential(buf).is_err());
    }

    #[test]
    fn errors_when_object_starts_but_never_closes() {
        // Truncated child output: `{` without matching `}`. Must not
        // hang or panic; must return an error.
        let buf = b"prefix\n{\"kind\":\"ExecCredential\",\"status\":{\"token\":\"";
        assert!(extract_exec_credential(buf).is_err());
    }

    #[test]
    fn ignores_closing_brace_inside_string_literal() {
        // A `}` inside a JSON string literal must not be mistaken
        // for the end of the object.
        let buf = br#"{"kind":"ExecCredential","status":{"token":"} fake }"}}"#;
        let cred = extract_exec_credential(buf).expect("must respect string literals");
        assert_eq!(cred.status.unwrap().token.as_deref(), Some("} fake }"));
    }
}
