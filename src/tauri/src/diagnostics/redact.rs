//! Making a report safe to paste.
//!
//! Substitution is consistent: one context keeps one placeholder in every
//! block, because a finding that points at `context-1` has to match a row
//! the reader can find. Scrubbing each field on its own would produce a
//! report nobody can follow, which is worse than not offering one.

use std::collections::BTreeMap;

use super::Diagnostics;
use crate::shell::ShellEnvReport;

const XDG_BASES: [&str; 4] = [
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_STATE_HOME",
    "XDG_CACHE_HOME",
];

/// What on this machine names the person running the app, and what a report
/// says instead.
///
/// `$HOME` alone is not enough: a sandbox, `sudo -E` or a snap moves it, and
/// the search path still names `/home/<them>`; an XDG base outside the home
/// directory puts the config and the log somewhere `~` never covers.
pub struct Identity {
    /// Directory prefixes, longest first, each with its stand-in.
    roots: Vec<(String, String)>,
    user: Option<String>,
}

impl Identity {
    #[must_use]
    pub fn of_this_machine() -> Self {
        let var = |name: &str| std::env::var(name).ok().filter(|v| !v.is_empty());
        Self::new(
            dirs::home_dir().map(|home| home.to_string_lossy().into_owned()),
            ["USER", "LOGNAME", "USERNAME"].into_iter().find_map(var),
            XDG_BASES
                .into_iter()
                .filter_map(|name| var(name).map(|path| (name, path)))
                .collect(),
        )
    }

    fn new(home: Option<String>, user: Option<String>, xdg: Vec<(&str, String)>) -> Self {
        let user = user.filter(|user| user.len() > 1);
        let mut homes: Vec<String> = home.into_iter().filter(|home| home.len() > 1).collect();
        if let Some(user) = &user {
            homes.extend(["/home/", "/Users/", "C:\\Users\\"].map(|base| format!("{base}{user}")));
        }
        let under_a_home = |path: &str| homes.iter().any(|home| within(path, home));
        let mut roots: Vec<(String, String)> = xdg
            .into_iter()
            .filter(|(_, path)| !under_a_home(path))
            .map(|(name, path)| (path, format!("${name}")))
            .collect();
        roots.extend(homes.iter().map(|home| (home.clone(), "~".to_string())));
        roots.sort_by(|a, b| b.0.len().cmp(&a.0.len()).then_with(|| a.0.cmp(&b.0)));
        roots.dedup_by(|a, b| a.0 == b.0);
        Self { roots, user }
    }

    /// `text` with every root replaced and the login name hidden where it
    /// stands as a path segment. Only there: a user called `dev` must not
    /// turn prose about a dev cluster into nonsense.
    #[must_use]
    pub fn hide(&self, text: &str) -> String {
        let mut out = text.to_string();
        for (root, stand_in) in &self.roots {
            out = replace_whole(&out, root, stand_in, |_| true);
        }
        if let Some(user) = &self.user {
            out = replace_whole(&out, user, "<user>", |before| {
                before == Some('/') || before == Some('\\')
            });
        }
        out
    }
}

/// A character that continues a name, so `marco` is not found in `marcos`.
fn continues(c: char) -> bool {
    c.is_alphanumeric() || matches!(c, '_' | '-' | '.')
}

fn within(path: &str, root: &str) -> bool {
    path.strip_prefix(root)
        .is_some_and(|rest| rest.is_empty() || rest.starts_with(['/', '\\']))
}

/// Every occurrence of `needle` that ends where a name ends and whose
/// preceding character `starts` accepts.
fn replace_whole(
    text: &str,
    needle: &str,
    with: &str,
    starts: impl Fn(Option<char>) -> bool,
) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find(needle) {
        let before = rest[..at].chars().last().or_else(|| out.chars().last());
        let after = rest[at + needle.len()..].chars().next();
        out.push_str(&rest[..at]);
        if starts(before) && !after.is_some_and(continues) {
            out.push_str(with);
        } else {
            out.push_str(needle);
        }
        rest = &rest[at + needle.len()..];
    }
    out.push_str(rest);
    out
}

/// Replace every identifying string in the report.
#[must_use]
pub fn redacted(d: Diagnostics) -> Diagnostics {
    redacted_as(d, &Identity::of_this_machine())
}

fn redacted_as(mut d: Diagnostics, identity: &Identity) -> Diagnostics {
    // Longest first: a context named `prod` is a substring of `prod-eu`, and
    // replacing the short one first would leave `context-1-eu` behind.
    let mut names: Vec<String> = d.contexts.iter().map(|c| c.context.clone()).collect();
    names.sort_by(|a, b| b.len().cmp(&a.len()).then_with(|| a.cmp(b)));

    let mut map: BTreeMap<String, String> = BTreeMap::new();
    for (i, ctx) in d.contexts.iter().enumerate() {
        map.insert(ctx.context.clone(), format!("context-{}", i + 1));
    }

    let scrub = |s: &str| -> String {
        let mut out = s.to_string();
        for name in &names {
            if let Some(placeholder) = map.get(name) {
                out = out.replace(name.as_str(), placeholder);
            }
        }
        identity.hide(&out)
    };
    // A shell under `~/.nix-profile` names the user as surely as a path does.
    match &mut d.shell {
        ShellEnvReport::Imported { shell, .. }
        | ShellEnvReport::TimedOut { shell, .. }
        | ShellEnvReport::NoAnswer { shell, .. } => *shell = scrub(shell),
        ShellEnvReport::CouldNotStart { shell, error } => {
            *shell = scrub(shell);
            *error = scrub(error);
        }
        // Neither carries a name.
        ShellEnvReport::NotAsked | ShellEnvReport::NotRecorded => {}
    }
    for ctx in &mut d.contexts {
        ctx.context = scrub(&ctx.context);
        ctx.command_path = ctx.command_path.as_deref().map(&scrub);
    }
    for plugin in &mut d.plugins {
        plugin.path = plugin.path.as_deref().map(&scrub);
        plugin.required_by = plugin.required_by.iter().map(|c| scrub(c)).collect();
    }
    for entry in &mut d.search_path {
        entry.path = scrub(&entry.path);
    }
    for tool in &mut d.tools {
        tool.path = tool.path.as_deref().map(&scrub);
    }
    // No loop over a shell report inside a finding: there is not one. A
    // finding says it is *about* the shell; the report itself lives once, on
    // `Diagnostics`, and is scrubbed above. A second copy on the wire was a
    // second thing to remember to scrub, and it was not remembered.
    // What kubectl printed names the context, the home directory and
    // sometimes the issuer; the same scrub the rest of the report gets.
    for attempt in &mut d.connections {
        attempt.context = scrub(&attempt.context);
        if let crate::client::PathOutcome::Failed { error, .. } = &mut attempt.direct {
            *error = scrub(error);
        }
        match &mut attempt.proxy {
            crate::client::ProxyOutcome::Failed {
                error,
                stdout,
                stderr,
                kubectl,
            } => {
                *error = scrub(error);
                *stdout = scrub(stdout);
                *stderr = scrub(stderr);
                *kubectl = scrub(kubectl);
            }
            crate::client::ProxyOutcome::Ok { kubectl, .. } => *kubectl = scrub(kubectl),
            crate::client::ProxyOutcome::NotTried | crate::client::ProxyOutcome::NoKubectl => {}
        }
    }
    for finding in &mut d.findings {
        finding.title = scrub(&finding.title);
        finding.detail = scrub(&finding.detail);
        finding.subject = finding.subject.as_deref().map(&scrub);
    }
    if let Some(kc) = &mut d.kubeconfig {
        kc.path = scrub(&kc.path);
        kc.parse_error = kc.parse_error.as_deref().map(&scrub);
    }
    // Who, not which cluster, for both: `scrub` also replaces context names
    // as bare substrings, and a context called `logs` or `app` would rewrite
    // the constant part of these paths into ones that do not exist, hiding
    // nothing, since that part names nobody.
    d.app.config_path = d.app.config_path.as_deref().map(|path| identity.hide(path));
    d.app.log_destination = d
        .app
        .log_destination
        .as_deref()
        .map(|path| identity.hide(path));

    d
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::diagnostics::ToolStatus;
    use crate::diagnostics::{DiagnosticContext, Diagnostics, Finding, InstallationInfo, Severity};

    fn sample() -> Diagnostics {
        Diagnostics {
            shell: ShellEnvReport::Imported {
                shell: "/bin/zsh".into(),
                adopted: 3,
                removed: 0,
            },
            search_path_is_real: true,
            search_path: Vec::new(),
            tools: vec![ToolStatus {
                name: "kubectl".into(),
                path: Some("/Users/someone/bin/kubectl".into()),
                version: Some("v1.31.0".into()),
            }],
            plugins: Vec::new(),
            contexts: vec![
                DiagnosticContext {
                    context: "orders-stage".into(),
                    method: "exec".into(),
                    command: Some("kubectl".into()),
                    command_path: Some("/Users/someone/bin/kubectl".into()),
                },
                DiagnosticContext {
                    context: "orders-prod".into(),
                    method: "exec".into(),
                    command: Some("kubectl".into()),
                    command_path: None,
                },
            ],
            kubeconfig: None,
            app: InstallationInfo {
                version: "4.0.1".into(),
                os: "macos aarch64".into(),
                config_path: Some("/Users/someone/Library/Application Support/k8s-gui".into()),
                log_destination: Some(
                    "/Users/someone/Library/Logs/com.k8s-gui.app/rubick.log".into(),
                ),
            },
            findings: vec![Finding {
                severity: Severity::Blocking,
                title: "kubectl-oidc_login is not installed".into(),
                detail: "The context orders-stage authenticates with kubectl oidc-login.".into(),
                subject: Some("orders-stage".into()),
                about_shell: false,
            }],
            connections: vec![crate::client::ConnectAttempt {
                context: "orders-prod".into(),
                at: "2026-09-07T07:00:00Z".into(),
                direct: crate::client::PathOutcome::Failed {
                    error: "orders-prod: Unauthorized".into(),
                    failure: crate::client::ConnectFailure::Credentials,
                },
                proxy: crate::client::ProxyOutcome::Failed {
                    error: "kubectl proxy exited".into(),
                    stdout: String::new(),
                    stderr: "error: /Users/someone/.kube/config: orders-prod refused".into(),
                    kubectl: "/Users/someone/bin/kubectl".into(),
                },
            }],
        }
    }

    /// kubectl's stderr is the one field in the report the app never wrote,
    /// and it names the home directory and the context as freely as any.
    #[test]
    fn what_kubectl_said_is_scrubbed_like_the_rest() {
        let Some(home) = dirs::home_dir() else { return };
        let home = home.to_string_lossy().into_owned();
        let mut d = sample();
        if let crate::client::ProxyOutcome::Failed { stderr, .. } = &mut d.connections[0].proxy {
            *stderr = format!("error: {home}/.kube/config: orders-prod refused");
        }
        let scrubbed = redacted(d);
        let text = serde_json::to_string(&scrubbed.connections).expect("serialises");
        assert!(!text.contains("orders-prod"), "{text}");
        assert!(!text.contains(&home), "{text}");
    }

    #[test]
    fn context_names_are_replaced_everywhere_or_the_findings_stop_making_sense() {
        let out = redacted(sample());
        let all = serde_json::to_string(&out).expect("serialises");

        assert!(
            !all.contains("orders-stage"),
            "a real context name survived"
        );
        assert!(!all.contains("orders-prod"), "a real context name survived");

        // The same context has to keep one name, or a finding stops pointing
        // at a row the reader can find.
        assert_eq!(out.contexts[0].context, "context-1");
        assert_eq!(out.findings[0].subject.as_deref(), Some("context-1"));
        assert!(out.findings[0].detail.contains("context-1"));
    }

    #[test]
    fn a_home_directory_becomes_a_tilde() {
        // The scrubber knows one home: this machine's. A fixture with an
        // invented path would pass while proving nothing, so the path under
        // test is built from the real one.
        let Some(home) = dirs::home_dir() else {
            return; // No home to hide.
        };
        let home = home.to_string_lossy().into_owned();

        let mut d = sample();
        d.app.config_path = Some(format!("{home}/Library/Application Support/k8s-gui"));
        // The log file lives under the home directory on every platform, and
        // it is the field a reader is most likely to be asked to paste.
        d.app.log_destination = Some(format!("{home}/Library/Logs/com.k8s-gui.app/rubick.log"));
        d.contexts[0].command_path = Some(format!("{home}/bin/kubectl"));
        d.shell = ShellEnvReport::CouldNotStart {
            shell: format!("{home}/.nix-profile/bin/zsh"),
            error: format!("{home}/.nix-profile/bin/zsh: No such file"),
        };
        // Both fields on the tool too: a spawn that failed quotes the file
        // it could not run, so the error carries the home directory in prose
        // even when the path beside it has already been scrubbed.
        d.tools[0].path = Some(format!("{home}/bin/kubectl"));

        let out = redacted(d);
        let all = serde_json::to_string(&out).expect("serialises");
        assert!(!all.contains(&home), "a home path survived: {all}");
        assert!(
            out.app.config_path.as_deref().unwrap().starts_with('~'),
            "the tilde is what makes the rest of the path readable"
        );
    }

    /// Marco's machine: `$HOME` is `/home/marco`, and his search path, his
    /// config file and his log all live under it.
    fn marco() -> Identity {
        Identity::new(Some("/home/marco".into()), Some("marco".into()), Vec::new())
    }

    /// Lena's run: `$HOME` and the XDG bases point into a sandbox while the
    /// search path still names the login's real home. Each printed path
    /// stayed raw on screen and in the copied report.
    fn sandboxed() -> Identity {
        Identity::new(
            Some("/tmp/rubick-fix/live/lena/home".into()),
            Some("belliel".into()),
            vec![
                (
                    "XDG_CONFIG_HOME",
                    "/tmp/rubick-fix/live/lena/xdg/config".into(),
                ),
                ("XDG_DATA_HOME", "/tmp/rubick-fix/live/lena/xdg/data".into()),
            ],
        )
    }

    fn with_paths(home: &str, config: &str, log: &str) -> Diagnostics {
        let mut d = sample();
        d.search_path = vec![
            crate::diagnostics::SearchPathEntry {
                path: "/usr/local/bin".into(),
                exists: true,
            },
            crate::diagnostics::SearchPathEntry {
                path: format!("{home}/.local/share/mise/installs/kubectl/latest"),
                exists: true,
            },
        ];
        d.app.config_path = Some(config.into());
        d.app.log_destination = Some(log.into());
        d
    }

    /// Fails if a path under the home directory, or the login name, reaches
    /// the report the "hide names and paths" box promises to clean.
    #[test]
    fn a_report_hides_every_path_under_the_home_and_the_login_name() {
        let out = redacted_as(
            with_paths(
                "/home/marco",
                "/home/marco/.config/k8s-gui/config.toml",
                "/home/marco/.local/share/com.k8s-gui.app/logs/rubick.log",
            ),
            &marco(),
        );
        let all = serde_json::to_string(&out).expect("serialises");
        assert!(!all.contains("marco"), "the login survived: {all}");
        assert_eq!(out.search_path[0].path, "/usr/local/bin");
        assert_eq!(
            out.search_path[1].path,
            "~/.local/share/mise/installs/kubectl/latest"
        );
        assert_eq!(
            out.app.config_path.as_deref(),
            Some("~/.config/k8s-gui/config.toml")
        );
    }

    /// Fails if a sandboxed `$HOME` lets the real home, or an XDG base
    /// outside it, through: the case the live check found.
    #[test]
    fn a_home_the_environment_moved_still_hides_the_login_and_the_xdg_bases() {
        let out = redacted_as(
            with_paths(
                "/home/belliel",
                "/tmp/rubick-fix/live/lena/xdg/config/k8s-gui/config.toml",
                "/tmp/rubick-fix/live/lena/xdg/data/com.k8s-gui.app/logs/rubick.log",
            ),
            &sandboxed(),
        );
        let all = serde_json::to_string(&out).expect("serialises");
        assert!(!all.contains("belliel"), "the login survived: {all}");
        assert!(!all.contains("lena"), "a sandbox path survived: {all}");
        assert_eq!(
            out.search_path[1].path,
            "~/.local/share/mise/installs/kubectl/latest"
        );
        assert_eq!(
            out.app.config_path.as_deref(),
            Some("$XDG_CONFIG_HOME/k8s-gui/config.toml")
        );
        assert_eq!(
            out.app.log_destination.as_deref(),
            Some("$XDG_DATA_HOME/com.k8s-gui.app/logs/rubick.log")
        );
    }

    /// The login is hidden as a path segment, never inside a longer name or
    /// in prose: a user `dev` must leave "dev cluster" and `devbox` alone.
    #[test]
    fn the_login_is_hidden_only_where_it_names_a_directory() {
        let dev = Identity::new(Some("/home/dev".into()), Some("dev".into()), Vec::new());
        assert_eq!(
            dev.hide("/data/dev/.kube/config"),
            "/data/<user>/.kube/config"
        );
        assert_eq!(dev.hide("the dev cluster"), "the dev cluster");
        assert_eq!(dev.hide("/home/devbox/bin"), "/home/devbox/bin");
        assert_eq!(dev.hide("/home/dev"), "~");
    }

    #[test]
    fn a_name_that_contains_another_is_not_half_replaced() {
        // `prod` inside `prod-eu` is the case that leaves `context-1-eu`
        // behind when substitution runs shortest-first.
        let mut d = sample();
        d.contexts[0].context = "prod".into();
        d.contexts[1].context = "prod-eu".into();
        d.findings[0].detail = "Both prod and prod-eu need it.".into();
        d.findings[0].subject = Some("prod".into());

        let out = redacted(d);
        assert!(
            !out.findings[0].detail.contains("prod"),
            "a name survived inside another: {}",
            out.findings[0].detail
        );
    }
}
