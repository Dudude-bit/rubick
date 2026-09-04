use serde::{Deserialize, Serialize};

use crate::commands::binaries::{kubectl_plugin_binary, locate_on_user_path, search_directories};
use crate::shell::ShellEnvReport;

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
    /// Something could not be checked, so the verdicts that rest on it are
    /// guesses: a plugin "not installed" below may be one this app could
    /// not look for.
    Unverified,
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
    /// The shell outcome this finding is about, when it is about one.
    ///
    /// Carried rather than described. The same five outcomes already have
    /// catalogue entries the pane renders four lines below the findings
    /// list, so composing English for them here put both on one screen —
    /// the Rust sentence in the reader's second language above the
    /// catalogue's in their first — and any wording fix had to be made in
    /// three files or the halves disagreed.
    pub shell: Option<ShellEnvReport>,
}

/// The finding for a kubeconfig the app could not read.
///
/// Blocking, because nothing works without it: no context can be selected,
/// so every screen behind this one is empty for a reason none of them can
/// explain. This is the one failure the Diagnostics panel exists for and
/// the one it used to stay silent about.
#[must_use]
pub fn unreadable_kubeconfig_finding(path: &str, why: &str) -> Finding {
    Finding {
        severity: Severity::Blocking,
        title: "Kubeconfig could not be read".to_string(),
        detail: format!(
            "{why}. No context can be selected until this file parses, which \
             is why the cluster screens are empty. Check it with \
             `kubectl config view`, which reports the same error against the \
             same file."
        ),
        subject: Some(path.to_string()),
        shell: None,
    }
}

/// The finding for a login shell that did not answer at startup.
///
/// `None` when it answered, or was never needed. Without an answer the
/// search path is the well-known directories and nothing the profile adds,
/// so this has to sit above any "not installed" verdict that rests on it:
/// the plugin may well be there, on a directory this app could not see.
#[must_use]
pub fn shell_env_finding(report: &ShellEnvReport) -> Option<Finding> {
    // No prose. The five outcomes already have catalogue entries — the pane
    // renders one four lines below this list — so wording them here put the
    // English sentence above the reader's own and made any fix a three-file
    // edit. What travels is the outcome; the words are chosen where the
    // language is known, which is the rule this project states for every
    // sentence composed in Rust.
    match report {
        ShellEnvReport::Imported { .. } | ShellEnvReport::NotAsked => None,
        other => Some(Finding {
            severity: Severity::Unverified,
            title: String::new(),
            detail: String::new(),
            subject: match other {
                ShellEnvReport::TimedOut { shell, .. }
                | ShellEnvReport::CouldNotStart { shell, .. }
                | ShellEnvReport::NoAnswer { shell, .. } => Some(shell.clone()),
                _ => None,
            },
            shell: Some(other.clone()),
        }),
    }
}

/// The finding for a context whose kubectl plugin is not installed.
///
/// `None` when the command names no plugin, or names one that is present —
/// there is nothing to report in either case, and reporting anyway would
/// refuse commands that work today.
#[must_use]
pub fn missing_plugin_finding(context: &str, command: &str, args: &[String]) -> Option<Finding> {
    missing_plugin_finding_given(context, command, args, crate::shell::env_report())
}

/// Split from the above so a test can say what the shell did.
fn missing_plugin_finding_given(
    context: &str,
    command: &str,
    args: &[String],
    shell: Option<&ShellEnvReport>,
) -> Option<Finding> {
    let plugin = kubectl_plugin_binary(command, args)?;
    if locate_on_user_path(&plugin).is_some() {
        return None;
    }
    // "Not installed" is only as good as the list that was searched, and
    // without the shell's answer that list is a guess; say so in the same
    // sentence rather than one block away.
    let caveat = match shell {
        Some(report) if !report.answered() => {
            " The login shell did not answer at startup, so this list is only the \
             well-known directories; the plugin may be on one your profile adds."
        }
        _ => "",
    };

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
             {searched}.{caveat}"
        ),
        subject: Some(context.to_string()),
        shell: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(std::string::ToString::to_string).collect()
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
            Severity::Unverified,
            Severity::Blocking,
            Severity::Misconfigured,
        ];
        all.sort();
        assert_eq!(
            all,
            [
                Severity::Blocking,
                Severity::Misconfigured,
                Severity::Unverified,
                Severity::Optional
            ]
        );
    }

    /// The case the panel used to be silent about: a shell that timed out
    /// left the headline saying nothing needs attention while the search path
    /// below was a guess. A shell that answered, or was never needed, is not
    /// news.
    ///
    /// What the finding carries is the outcome, not a sentence about it: the
    /// same five outcomes are worded once, in the catalogue, and the pane and
    /// the pasted report both read them from there.
    #[test]
    fn a_shell_that_did_not_answer_is_a_finding_and_one_that_did_is_not() {
        let timed_out = shell_env_finding(&ShellEnvReport::TimedOut {
            shell: "/bin/zsh".into(),
            seconds: 30,
        })
        .expect("a shell that timed out is worth a line");
        assert_eq!(timed_out.severity, Severity::Unverified);
        assert_eq!(timed_out.subject.as_deref(), Some("/bin/zsh"));
        assert!(
            matches!(
                timed_out.shell,
                Some(ShellEnvReport::TimedOut { seconds: 30, .. })
            ),
            "{:?}",
            timed_out.shell
        );
        // No prose here — the words live in the catalogue, and a sentence
        // composed in Rust is one no scanner in this project can see.
        assert!(timed_out.detail.is_empty(), "{}", timed_out.detail);

        let no_answer = shell_env_finding(&ShellEnvReport::NoAnswer {
            shell: "/bin/tcsh".into(),
            exit: Some(1),
        })
        .expect("a shell that said nothing is worth a line");
        assert!(
            matches!(
                no_answer.shell,
                Some(ShellEnvReport::NoAnswer { exit: Some(1), .. })
            ),
            "{:?}",
            no_answer.shell
        );

        assert!(shell_env_finding(&ShellEnvReport::Imported {
            shell: "/bin/zsh".into(),
            adopted: 1,
            removed: 0
        })
        .is_none());
        assert!(shell_env_finding(&ShellEnvReport::NotAsked).is_none());

        // And the state that means nobody asked is news, unlike the one that
        // means there was nothing to ask.
        assert!(shell_env_finding(&ShellEnvReport::NotRecorded).is_some());
    }

    /// "Not installed" after a search the app could not complete is the
    /// third state collapsing into the second. The verdict stays, because
    /// the spawn really would fail, but the sentence has to carry the doubt.
    #[test]
    fn a_missing_plugin_says_when_the_search_itself_was_a_guess() {
        let plugin = args(&["surely-no-such-credential-plugin", "get-token"]);
        let unsure = missing_plugin_finding_given(
            "ctx",
            "kubectl",
            &plugin,
            Some(&ShellEnvReport::TimedOut {
                shell: "/bin/zsh".into(),
                seconds: 30,
            }),
        )
        .expect("still missing from the directories that were searched");
        assert!(
            unsure.detail.contains("did not answer"),
            "{}",
            unsure.detail
        );

        let sure = missing_plugin_finding_given(
            "ctx",
            "kubectl",
            &plugin,
            Some(&ShellEnvReport::Imported {
                shell: "/bin/zsh".into(),
                adopted: 2,
                removed: 0,
            }),
        )
        .expect("missing for real");
        assert!(!sure.detail.contains("did not answer"), "{}", sure.detail);
    }
}
