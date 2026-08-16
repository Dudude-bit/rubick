use serde::{Deserialize, Serialize};

use crate::commands::binaries::{kubectl_plugin_binary, locate_on_user_path, search_directories};

/// How much a finding costs the reader, worst first.
///
/// The order is the display order, so it is declared in it and derives
/// `Ord` from that declaration rather than from a table somebody has to
/// keep in step.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Severity {
    /// Something a context needs is absent: a connection will fail.
    Blocking,
    /// A setting points at a file that is not what it claims.
    Misconfigured,
    /// Something optional is missing: a feature is unavailable.
    Optional,
}

/// One thing that is wrong, in a sentence, with what to do about it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Finding {
    pub severity: Severity,
    /// What is wrong, short enough to be a heading.
    pub title: String,
    /// Why it matters and what to do, in prose.
    pub detail: String,
    /// The context or setting this is about; the tiebreak when two findings
    /// share a severity, so the order does not move between reads.
    pub subject: Option<String>,
}

/// The finding for a context whose kubectl plugin is not installed.
///
/// `None` when the command names no plugin, or names one that is present —
/// there is nothing to report in either case, and reporting anyway would
/// refuse commands that work today.
pub fn missing_plugin_finding(context: &str, command: &str, args: &[String]) -> Option<Finding> {
    let plugin = kubectl_plugin_binary(command, args)?;
    if locate_on_user_path(&plugin).is_some() {
        return None;
    }

    let subcommand = args
        .iter()
        .find(|a| !a.starts_with('-'))
        .cloned()
        .unwrap_or_default();
    let searched = search_directories()
        .iter()
        .map(|d| d.to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join(", ");

    Some(Finding {
        severity: Severity::Blocking,
        title: format!("{plugin} is not installed"),
        detail: format!(
            "The context {context} authenticates with `kubectl {subcommand}`, and kubectl \
             looks for a binary of that name. Install it (for oidc-login: `kubectl krew \
             install oidc-login`) or point the context at an absolute command. Searched: \
             {searched}"
        ),
        subject: Some(context.to_string()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn a_missing_plugin_names_the_file_and_the_context_that_needs_it() {
        let finding = missing_plugin_finding(
            "orders-stage",
            "kubectl",
            &args(&["surely-no-such-credential-plugin", "get-token"]),
        )
        .expect("a plugin nobody has installed should be reported");

        assert_eq!(finding.severity, Severity::Blocking);
        assert!(
            finding
                .title
                .contains("kubectl-surely_no_such_credential_plugin"),
            "title should name the file kubectl opens, got: {}",
            finding.title
        );
        assert!(
            finding.detail.contains("orders-stage"),
            "detail should name the context that needs it, got: {}",
            finding.detail
        );
        assert_eq!(finding.subject.as_deref(), Some("orders-stage"));
    }

    #[test]
    fn a_command_that_is_not_a_kubectl_plugin_produces_nothing() {
        assert!(missing_plugin_finding("ctx", "kubelogin", &args(&["get-token"])).is_none());
        assert!(missing_plugin_finding("ctx", "kubectl", &args(&["--help"])).is_none());
    }

    #[test]
    fn severity_orders_worst_first() {
        // The display order is this order; a sort that reversed it would
        // bury the connection that is about to fail.
        let mut all = [
            Severity::Optional,
            Severity::Blocking,
            Severity::Misconfigured,
        ];
        all.sort();
        assert_eq!(
            all,
            [
                Severity::Blocking,
                Severity::Misconfigured,
                Severity::Optional
            ]
        );
    }
}
