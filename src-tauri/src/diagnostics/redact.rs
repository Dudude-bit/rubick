//! Making a report safe to paste.
//!
//! Substitution is consistent: one context keeps one placeholder in every
//! block, because a finding that points at `context-1` has to match a row
//! the reader can find. Scrubbing each field on its own would produce a
//! report nobody can follow, which is worse than not offering one.

use std::collections::BTreeMap;

use super::Diagnostics;
use crate::shell::ShellEnvReport;

/// Replace every identifying string in the report.
#[must_use]
pub fn redacted(mut d: Diagnostics) -> Diagnostics {
    // Longest first: a context named `prod` is a substring of `prod-eu`, and
    // replacing the short one first would leave `context-1-eu` behind.
    let mut names: Vec<String> = d.contexts.iter().map(|c| c.context.clone()).collect();
    names.sort_by(|a, b| b.len().cmp(&a.len()).then_with(|| a.cmp(b)));

    let mut map: BTreeMap<String, String> = BTreeMap::new();
    for (i, ctx) in d.contexts.iter().enumerate() {
        map.insert(ctx.context.clone(), format!("context-{}", i + 1));
    }

    let home = dirs::home_dir().map(|h| h.to_string_lossy().into_owned());

    let scrub = |s: &str| -> String {
        let mut out = s.to_string();
        for name in &names {
            if let Some(placeholder) = map.get(name) {
                out = out.replace(name.as_str(), placeholder);
            }
        }
        if let Some(home) = &home {
            out = out.replace(home.as_str(), "~");
        }
        out
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
        // The path, and the error too: a spawn failure quotes the file it
        // could not run, which is the home directory again in prose.
        tool.path = tool.path.as_deref().map(&scrub);
        tool.error = tool.error.as_deref().map(&scrub);
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
    d.app.config_path = d.app.config_path.as_deref().map(&scrub);

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
                error: None,
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
                log_destination: "stdout".into(),
            },
            findings: vec![Finding {
                severity: Severity::Blocking,
                title: "kubectl-oidc_login is not installed".into(),
                detail: "The context orders-stage authenticates with kubectl oidc-login.".into(),
                subject: Some("orders-stage".into()),
                shell: None,
            }],
        }
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
        d.contexts[0].command_path = Some(format!("{home}/bin/kubectl"));
        d.shell = ShellEnvReport::CouldNotStart {
            shell: format!("{home}/.nix-profile/bin/zsh"),
            error: format!("{home}/.nix-profile/bin/zsh: No such file"),
        };
        // Both fields on the tool too: a spawn that failed quotes the file
        // it could not run, so the error carries the home directory in prose
        // even when the path beside it has already been scrubbed.
        d.tools[0].path = Some(format!("{home}/bin/kubectl"));
        d.tools[0].error = Some(format!("{home}/bin/kubectl: permission denied"));

        let out = redacted(d);
        let all = serde_json::to_string(&out).expect("serialises");
        assert!(!all.contains(&home), "a home path survived: {all}");
        assert!(
            out.app.config_path.as_deref().unwrap().starts_with('~'),
            "the tilde is what makes the rest of the path readable"
        );
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
