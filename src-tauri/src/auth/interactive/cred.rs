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

/// What a bearer token turned out to be once the console had finished
/// drawing it.
///
/// Three states, because the alternative is one: `Unauthorized`. A token the
/// console broke and a token the cluster refuses reach the reader as the same
/// bare 401, and only one of them is theirs to fix.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum TokenShape {
    /// Nothing to say: every byte is one a bearer token may carry.
    Intact,
    /// The plugin's value carried whitespace, which a bearer token never
    /// does. Removed — the count is what the report says.
    Mended { removed: usize },
    /// Something is in there that whitespace removal does not explain.
    Unusable { first_bad: char },
}

/// Repair what a console put inside a bearer token, and say what was found.
///
/// A bearer token is `token68` (RFC 7235): letters, digits, and
/// `-._~+/`, with `=` padding. **Whitespace is never part of one** — it
/// cannot be, because the value travels in an HTTP header. So removing
/// whitespace from a token cannot destroy a value that was ever valid; it can
/// only rescue one a terminal wrapped or padded.
///
/// This exists because `ConPTY` hands back the *rendered screen* rather than
/// the bytes the child wrote (see `unwrap_console_breaks`). That pass removes
/// the control bytes, which is what stopped the JSON parsing. What it cannot
/// remove is a space, because a space inside a JSON string is ordinary data —
/// and a space inside a `kubectl oidc-login` `id_token` is a credential the API
/// server answers with `Unauthorized`, naming nothing.
pub(super) fn mend_bearer_token(token: &mut String) -> TokenShape {
    let before = token.len();
    token.retain(|c| !c.is_whitespace());
    let removed = before - token.len();

    if let Some(bad) = token.chars().find(|c| !is_token68(*c)) {
        return TokenShape::Unusable { first_bad: bad };
    }
    if removed > 0 {
        return TokenShape::Mended { removed };
    }
    TokenShape::Intact
}

/// The characters RFC 7235 allows in a `token68`, which is what a bearer
/// credential is. Deliberately not "any printable byte": the point is to
/// separate a token a console mangled from one it did not.
fn is_token68(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '-' | '.' | '_' | '~' | '+' | '/' | '=')
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

        let candidate = unwrap_console_breaks(&buffer[start..=end]);
        match serde_json::from_slice::<ExecCredential>(&candidate) {
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

/// Drop what a console put inside a JSON string, and nothing else.
///
/// A pty on Unix hands back the bytes the child wrote. `ConPTY` does not: it
/// is a screen buffer, so a read gives back the *rendered* screen — hard
/// line breaks at the console width included. Our auth pty is 80 columns
/// wide and an `id_token` runs to a kilobyte or two, so the break lands inside
/// the quoted JWT, and a raw newline inside a JSON string is not JSON.
///
/// The rule is exact rather than heuristic: a control byte inside a JSON
/// string literal is *never* valid JSON, so removing one cannot change the
/// meaning of any document that was valid to begin with. It can only rescue
/// one that a console broke. Outside a string, whitespace is legal and is
/// left exactly as it was.
///
/// ANSI escape sequences are dropped on the same grounds — `ESC [ ... m`
/// inside a string is a terminal's colour, not the plugin's data.
fn unwrap_console_breaks(slice: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(slice.len());
    let mut in_string = false;
    let mut escaped = false;
    let mut i = 0;

    while i < slice.len() {
        let b = slice[i];

        if in_string && b == 0x1b {
            // ESC: skip the whole sequence rather than the escape alone,
            // or its parameter bytes would land in the token.
            i += 1;
            if i < slice.len() && slice[i] == b'[' {
                i += 1;
                while i < slice.len() && !(0x40..=0x7e).contains(&slice[i]) {
                    i += 1;
                }
            }
            i += 1;
            continue;
        }

        if in_string && b < 0x20 && !escaped {
            i += 1;
            continue;
        }

        out.push(b);

        if escaped {
            escaped = false;
        } else if in_string && b == b'\\' {
            escaped = true;
        } else if b == b'"' {
            in_string = !in_string;
        }

        i += 1;
    }

    out
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

    /// The ordinary case has to stay ordinary: a token that arrived whole is
    /// reported as whole and comes back byte-identical. Would break if
    /// mending rewrote a value it had no business touching.
    #[test]
    fn a_token_that_arrived_whole_is_left_alone() {
        let mut token = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln-_~+/=".to_string();
        let before = token.clone();

        assert_eq!(mend_bearer_token(&mut token), TokenShape::Intact);
        assert_eq!(token, before);
    }

    /// The reported failure, one layer below where it is felt: `ConPTY` hands
    /// back the rendered screen, and what `unwrap_console_breaks` cannot
    /// remove is the padding, because a space inside a JSON string is data.
    /// A space inside an `id_token` is not — it is a credential the API server
    /// answers `Unauthorized` without naming a cause. Would break if
    /// whitespace survived into the header.
    #[test]
    fn a_token_the_console_broke_across_rows_comes_back_in_one_piece() {
        // A row that ends short is padded out to the console width, and the
        // next one starts after a hard break: five whitespace characters per
        // row boundary.
        const BREAK: &str = "   \r\n";
        let whole = format!("{}.{}.{}", "e".repeat(40), "p".repeat(40), "s".repeat(40));
        let rows: Vec<String> = whole
            .as_bytes()
            .chunks(32)
            .map(|c| String::from_utf8_lossy(c).into_owned())
            .collect();
        let mut token = rows.join(BREAK);

        assert_eq!(
            mend_bearer_token(&mut token),
            TokenShape::Mended {
                removed: (rows.len() - 1) * BREAK.len()
            }
        );
        assert_eq!(token, whole);
    }

    /// Removing whitespace is safe because a bearer token never contains
    /// any. That argument does not extend one character further, so anything
    /// else stops here with the character named rather than reaching the
    /// cluster. Would break if an unusable token were reported as mended.
    #[test]
    fn a_token_holding_more_than_whitespace_is_reported_unusable() {
        let mut token = "abc.def\u{1b}[0m.ghi".to_string();

        assert_eq!(
            mend_bearer_token(&mut token),
            TokenShape::Unusable {
                first_bad: '\u{1b}'
            }
        );
    }

    /// The count in the report is the number of characters taken out, not
    /// the number of rows or bytes — it is what a reader compares against
    /// the console width to recognise their own terminal in it.
    #[test]
    fn the_report_counts_the_characters_removed() {
        let mut token = " a b ".to_string();
        assert_eq!(
            mend_bearer_token(&mut token),
            TokenShape::Mended { removed: 3 }
        );
        assert_eq!(token, "ab");
    }

    /// Reported against 4.7.3 on Windows (#106): "Exec credentials missing
    /// status" from a `kubectl oidc-login get-token` that works under
    /// `kubectl` and under Lens.
    ///
    /// The plugin runs under a PTY so it behaves interactively. On Unix a
    /// pty master hands back exactly the bytes the child wrote — wrapping is
    /// the terminal's own business at draw time. `ConPTY` is not that: it is a
    /// screen buffer, and what you read back is the rendered screen, hard
    /// line breaks and all, at whatever width the console was opened with.
    /// Ours is opened at 80 columns and an `id_token` is one to two kilobytes,
    /// so the break lands inside the quoted JWT — and a raw newline inside a
    /// JSON string is not JSON.
    ///
    /// The credential then fails to parse, the extractor falls back to some
    /// smaller balanced object that has no `status`, and the reader is told
    /// their credentials are missing a field the plugin did in fact write.
    #[test]
    fn reads_a_credential_a_console_wrapped_mid_token() {
        let token = "e".repeat(600);
        let json = format!(
            r#"{{"kind":"ExecCredential","apiVersion":"client.authentication.k8s.io/v1beta1","status":{{"token":"{token}"}}}}"#
        );
        // What a ConPTY read gives back: the same bytes with CRLF driven in
        // every 80 columns.
        let wrapped: String = json
            .as_bytes()
            .chunks(80)
            .map(|chunk| String::from_utf8_lossy(chunk).to_string())
            .collect::<Vec<_>>()
            .join("\r\n");

        let cred = extract_exec_credential(wrapped.as_bytes())
            .expect("a wrapped credential is still a credential");
        assert_eq!(
            cred.status.expect("status").token.as_deref(),
            Some(token.as_str()),
            "the token must come back whole, without the console's breaks"
        );
    }

    /// The same rescue must not become a licence to rewrite the token. A
    /// backslash-escaped `\n` is data the plugin wrote and has to survive;
    /// only a raw control byte — which is never valid inside a JSON string —
    /// may be dropped.
    #[test]
    fn keeps_the_escapes_the_plugin_actually_wrote() {
        let buf = br#"{"kind":"ExecCredential","status":{"token":"a\nb\tc"}}"#;
        let cred = extract_exec_credential(buf).expect("parses");
        assert_eq!(cred.status.unwrap().token.as_deref(), Some("a\nb\tc"));
    }

    /// A console may colour what it echoes. An escape sequence inside the
    /// quoted token is the terminal talking, not the plugin, and dropping
    /// only the ESC would leave `[0m` behind in the credential.
    #[test]
    fn drops_a_whole_escape_sequence_from_inside_a_token() {
        let buf = b"{\"kind\":\"ExecCredential\",\"status\":{\"token\":\"ab\x1b[0mcd\"}}";
        let cred = extract_exec_credential(buf).expect("parses");
        assert_eq!(cred.status.unwrap().token.as_deref(), Some("abcd"));
    }

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
