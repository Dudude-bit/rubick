# Security Policy

## Reporting a Vulnerability

If you've found a security issue in Rubick, please report it privately so we
can fix it before it's publicly disclosed.

**Don't open a regular GitHub issue for security problems.** Instead, use one
of:

- GitHub's private vulnerability reporting: open
  <https://github.com/Dudude-bit/rubick/security/advisories/new>.
- Email the maintainer at the address listed on the GitHub profile of the
  repository owner.

Please include:

- A description of the vulnerability and its impact.
- Steps to reproduce (or a minimal proof-of-concept).
- The version of Rubick you tested against (`Settings > About`).
- Your suggested mitigation, if you have one.

You'll get an acknowledgement within **5 business days**. We aim to ship a fix
within **30 days** of the initial report for high/critical issues, sooner where
possible.

## Scope

In scope:

- The Tauri desktop application itself (`src-tauri/`, `src/`,
  `k8s-gui-common/`).
- The release pipeline (`.github/workflows/release.yml`) and signing
  configuration.
- Anything that could let a malicious Kubernetes cluster, kubeconfig, or
  intercepted update compromise the user's machine.

Out of scope:

- Issues in upstream dependencies (kube-rs, Tauri, etc.) — please report those
  to the relevant project. We will pick up the fix once they release.
- Issues that require an attacker to already have local code execution on the
  user's machine.
- Vulnerabilities specific to a self-built fork running with non-default
  configuration.

## Supported Versions

Only the latest minor version line is supported. Patches go to the most recent
minor release.

| Version | Supported          |
| ------- | ------------------ |
| 4.2.x   | :white_check_mark: |
| < 4.2   | :x:                |

## Disclosure

After a fix ships, we'll publish a GitHub Security Advisory crediting the
reporter (unless you ask to remain anonymous).
