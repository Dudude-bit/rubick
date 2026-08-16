# Open-Source Release v2.0.0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish the private `Dudude-bit/k8s-gui` repository as a public open-source project under MIT license, version 2.0.0, with a clean single-commit history.

**Architecture:** One-time destructive operation. Commit staged deletions → create local backup tag → delete legacy plans → add OSS files → bump version → create orphan branch with single commit → force-push → flip visibility to public.

**Tech Stack:** Git (orphan branches, force-push with lease), GitHub CLI (`gh`), local shell. No runtime code changes.

---

## Source spec

`docs/superpowers/specs/2026-04-23-opensource-release-v2-design.md`

## Prerequisites for the engineer running this plan

- `git` installed locally (recent version supporting `--force-with-lease`).
- `gh` CLI installed and authenticated as the repo owner (`Dudude-bit`). Verify with `gh auth status`.
- Rust stable (`rustup default stable`) and Node.js 20+ / npm (for smoke tests).
- Ability to run `cargo check` on `src-tauri/` and `npm run build` on the repo.
- Physical access to a second storage location (USB / another drive / cloud folder) **if** the engineer wants an offline mirror backup (Task 3 — optional).

## File structure

| Path | Action | Purpose |
|---|---|---|
| `LICENSE` | CREATE | MIT license text at repo root (spec references it; file was missing) |
| `README.md` | CREATE | Project overview, install, dev setup |
| `CONTRIBUTING.md` | CREATE | Contribution guidelines |
| `CHANGELOG.md` | CREATE | Keep-a-Changelog format, one entry: v2.0.0 |
| `.github/ISSUE_TEMPLATE/bug_report.md` | CREATE | GitHub bug template |
| `.github/ISSUE_TEMPLATE/feature_request.md` | CREATE | GitHub feature request template |
| `.github/PULL_REQUEST_TEMPLATE.md` | CREATE | PR template |
| `src-tauri/tauri.conf.json` | MODIFY (version + updater endpoint) | Bump 1.7.12 → 2.0.0; switch updater URL from YC bucket to GitHub Releases |
| `src-tauri/Cargo.toml` | MODIFY (line with `version =`) | Bump 1.7.12 → 2.0.0 |
| `k8s-gui-common/Cargo.toml` | MODIFY (line with `version =`) | Bump 0.1.0 → 2.0.0 (unifies to app version) |
| `package.json` | MODIFY (line with `"version"`) | Bump 0.1.0 → 2.0.0 |
| `Cargo.lock` | AUTO-UPDATE | Refreshed by `cargo check` after version bump |
| `docs/plans/2026-01-15-metrics-unification-design.md` | DELETE | Leaks `/Users/kirillinakin/...` paths |
| `docs/plans/2026-01-15-metrics-unification.md` | DELETE | Leaks personal paths; feature shipped |
| `docs/plans/2026-01-15-shell-command-implementation.md` | DELETE | Leaks personal paths; feature shipped |
| `docs/plans/2026-01-15-shell-command-wrapper-design.md` | DELETE | Leaks personal paths; feature shipped |
| `docs/plans/2026-01-17-terminal-refactor-auth-prompts-design.md` | DELETE | Feature shipped; kept for uniformity of cleanup |
| `build.py` | DELETE | 2381-line personal upload script, 4 YC URL references, not invoked from Makefile or CI. User confirmed YC bucket is being retired; script has no home in OSS repo. |

All other files (source code, configs, build scripts, the new `docs/superpowers/` directory) stay unchanged.

---

## Task 1: Preflight verification

**Files:** (read-only — verification only)

- [ ] **Step 1: Confirm working directory**

Run:
```bash
pwd && git remote -v && git status --short | head -10
```

Expected: cwd is `/Users/kirillinakin/RustroverProjects/k8s-gui`, remote origin points to `git@github.com:Dudude-bit/k8s-gui.git`, status shows a large number of staged deletions (126 files).

- [ ] **Step 2: Verify Rust compiles**

Run:
```bash
cargo check --manifest-path src-tauri/Cargo.toml
```

Expected: `Finished ...` — no errors. If it fails, STOP — do not continue until fixed.

- [ ] **Step 3: Verify frontend builds**

Run:
```bash
npm run build
```

Expected: TypeScript compiles (`tsc`) and Vite produces `dist/` without errors. If it fails, STOP.

- [ ] **Step 4: Secret-pattern scan**

Run:
```bash
rg -E '(AIza|sk_|sk-|xox[pbar]|ghp_|gho_|github_pat_|AKIA|ASIA|SG\.|ya29\.)' \
   --glob='!node_modules' --glob='!dist' --glob='!src-tauri/target' --glob='!artifacts' .
```

Expected: zero hits. If any, inspect — likely false positive (`sk_` appears in Tailwind class names etc.), but confirm each manually before proceeding.

- [ ] **Step 5: Private updater key scan**

Run:
```bash
rg -n 'minisign secret|^RWR' src-tauri/ .github/ scripts/ build.py 2>/dev/null
```

Expected: zero hits. Only `untrusted comment: minisign public key` should exist (in `tauri.conf.json`). Private key must NOT be in the tree.

- [ ] **Step 6: Personal path scan in tracked source**

Run:
```bash
rg -n 'kirillinakin|<old-author-email>' src/ src-tauri/ k8s-gui-common/ scripts/ build.py Makefile
```

Expected: zero hits. (The `docs/plans/*.md` files DO contain personal paths — those will be deleted in Task 5, so do not scan `docs/` here.)

- [ ] **Step 7: Confirm no committed artifacts**

Run:
```bash
git ls-files artifacts/ | wc -l
```

Expected: `0`. (`artifacts/` is gitignored — already confirmed.)

- [ ] **Step 8: Check for existing LICENSE file**

Run:
```bash
ls LICENSE* 2>/dev/null
```

Expected: (no output — file is absent). Task 6 will create it.

- [ ] **Step 9: Manual bucket ACL check**

Open the Yandex Cloud console (or any S3-compatible CLI pointed at the bucket) and confirm the bucket `k8s-gui-releases` has `list-unauthorized` ACL — meaning anonymous users can download by direct URL but cannot list bucket contents.

If listing is public: stop and tighten the ACL before proceeding. The bucket URL will be discoverable from `tauri.conf.json` once the repo is public.

This is a manual step — no automated check. Note the outcome before moving on.

---

## Task 2: Finalize staged deletions as a backup commit

**Files:** All currently staged files (126 pending deletions + a few modifications).

- [ ] **Step 1: Review what will be committed**

Run:
```bash
git diff --cached --stat | tail -3
```

Expected: Roughly `126 files changed, 246 insertions(+), 13055 deletions(-)`.

- [ ] **Step 2: Verify nothing else is staged unintentionally**

Run:
```bash
git diff --cached --name-only | head -30
```

Expected: Most entries start with `D ` (deletion). A few modifications: `.gitmodules`, `Cargo.lock`, `Cargo.toml`, `Makefile`, plus adjustments to `src/` files that reference removed modules. If you see anything suspicious (hostnames, secrets, random binaries), STOP.

- [ ] **Step 3: Commit**

Run:
```bash
git commit -m "chore: finalize premium/license removal"
```

Expected: commit is created. Capture the SHA:

```bash
git rev-parse HEAD
```

Write down this SHA — it is the backup point.

- [ ] **Step 4: Verify working tree is clean**

Run:
```bash
git status --short
```

Expected: empty output (working tree clean). Any remaining changes mean the commit missed something; investigate before proceeding.

---

## Task 3: Create local backup tag + optional offline mirror

**Files:** None (git metadata + external backup).

- [ ] **Step 1: Create the local tag**

Run:
```bash
git tag pre-opensource-archive
```

Expected: silent success.

- [ ] **Step 2: Verify the tag points to the backup commit**

Run:
```bash
git rev-parse pre-opensource-archive
git log --oneline -1 pre-opensource-archive
```

Expected: the SHA matches what you recorded in Task 2 Step 3; commit message is `chore: finalize premium/license removal`.

- [ ] **Step 3: DO NOT push the tag**

This is a critical rule. Verify no automatic push is configured:

```bash
git config --get remote.origin.pushTagsMode 2>/dev/null
git config --get push.followTags 2>/dev/null
```

Expected: both return empty (no auto-tag-push). If `push.followTags` is `true`, unset it: `git config --unset push.followTags`. The tag must stay local-only.

- [ ] **Step 4 (OPTIONAL): Create offline mirror backup**

If the engineer wants an extra safety net beyond the local tag, create a mirror clone to external storage:

```bash
# Replace /path/to/external with an actual external path chosen by the engineer
# (USB drive, separate disk, iCloud Drive folder, etc.)
git clone --mirror . /path/to/external/k8s-gui-archive.git
```

Expected: `Cloning into bare repository '/path/to/external/k8s-gui-archive.git'...done`.

If skipping this step: the only rollback path is the local `pre-opensource-archive` tag. If the engineer later deletes `.git/`, the pre-OSS history is lost forever. Document the choice.

---

## Task 4: Delete legacy docs/plans and build.py

**Files:**
- Delete: `docs/plans/2026-01-15-metrics-unification-design.md`
- Delete: `docs/plans/2026-01-15-metrics-unification.md`
- Delete: `docs/plans/2026-01-15-shell-command-implementation.md`
- Delete: `docs/plans/2026-01-15-shell-command-wrapper-design.md`
- Delete: `docs/plans/2026-01-17-terminal-refactor-auth-prompts-design.md`
- Delete: `build.py` (personal YC upload script, 2381 lines, not invoked from Makefile/CI, YC bucket is being retired)

- [ ] **Step 1: Confirm exactly which files exist under docs/plans/**

Run:
```bash
ls docs/plans/
```

Expected: the 5 files listed above. If the directory has additional files you did not expect, STOP and investigate — do not blindly delete.

- [ ] **Step 2: Confirm build.py is not referenced anywhere that would break on delete**

Run:
```bash
rg -n 'build\.py' --glob='!build.py' --glob='!docs/superpowers/**' --glob='!node_modules' --glob='!src-tauri/target' --glob='!dist' .
```

Expected: zero hits. (Previously confirmed — `Makefile` and `Dockerfile.linux-build` do not reference it. Any hit outside the specs/plans directory means the script is still wired in and deletion would break something.)

- [ ] **Step 3: Remove all 6 files with git rm**

Run:
```bash
git rm docs/plans/2026-01-15-metrics-unification-design.md \
       docs/plans/2026-01-15-metrics-unification.md \
       docs/plans/2026-01-15-shell-command-implementation.md \
       docs/plans/2026-01-15-shell-command-wrapper-design.md \
       docs/plans/2026-01-17-terminal-refactor-auth-prompts-design.md \
       build.py
```

Expected: `rm 'docs/plans/...'` × 5 and `rm 'build.py'`. The `docs/plans/` directory is now empty.

- [ ] **Step 4: Remove the now-empty docs/plans directory**

Run:
```bash
rmdir docs/plans 2>/dev/null && echo "empty dir removed" || echo "dir has remaining files — check"
```

Expected: `empty dir removed`. If it reports remaining files, list them with `ls docs/plans/` and stop — the earlier deletion missed something.

- [ ] **Step 5: Verify no personal path leaks or build.py references remain in tracked files**

Run:
```bash
rg -n 'kirillinakin|<old-author-email>|/Users/' \
   --glob='!node_modules' --glob='!src-tauri/target' --glob='!dist' --glob='!artifacts' \
   --glob='!docs/superpowers/specs/**' --glob='!docs/superpowers/plans/**' \
   .
rg -n 'build\.py' --glob='!docs/superpowers/**' --glob='!node_modules' --glob='!src-tauri/target' --glob='!dist' .
```

Expected: zero hits on both. (Specs/plans under `docs/superpowers/` ARE allowed to contain personal paths and build.py mentions — they describe this one-time operation. The exclusion is intentional.)

If any hit remains: sanitize that file manually. Re-run the scan until clean.

---

## Task 5: Create LICENSE file (MIT)

**Files:**
- Create: `LICENSE`

- [ ] **Step 1: Write the LICENSE file**

Use the Write tool (or an editor) to create `LICENSE` at repo root with exactly this content:

```
MIT License

Copyright (c) 2026 Dudude-bit

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

- [ ] **Step 2: Verify file exists**

Run:
```bash
wc -l LICENSE && head -1 LICENSE
```

Expected: line count around 21, first line `MIT License`.

---

## Task 6: Create README.md

**Files:**
- Create: `README.md`

- [ ] **Step 1: Write the README**

Use the Write tool to create `README.md` at repo root with exactly this content:

````markdown
# K8s GUI

A modern, cross-platform Kubernetes GUI client built with Tauri and Rust.

## Features

### Cluster management
- Multi-cluster support via kubeconfig
- Cloud provider authentication: EKS (AWS), GKE (GCP), AKS (Azure), OIDC
- Interactive browser-based auth flows

### Workloads
- Pods, Deployments, StatefulSets, DaemonSets, Jobs, CronJobs
- Real-time status, metrics, and events

### Network
- Services, Ingresses, Endpoints
- Port-forwarding manager with auto-restart

### Storage
- PersistentVolumes, PersistentVolumeClaims, StorageClasses

### Configuration
- ConfigMaps, Secrets (with base64 decode)

### Observability
- Live log streaming with level filtering and search
- CPU / memory metrics for pods and nodes
- Event timeline

### Custom resources
- Full CRD browsing with per-instance views
- YAML editing with validation

### Helm
- List releases and view release details
- Upgrade dialog with values editing

### Terminal
- Per-pod exec terminal
- General-purpose in-app terminal with shell PATH detection

### UI/UX
- Light / dark / system theme
- Resource tables with sorting and filtering
- Integrated auto-updater

## Installation

Pre-built binaries: [Releases](https://github.com/Dudude-bit/k8s-gui/releases).

Supported platforms:
- macOS (arm64, x64)
- Linux (x64, arm64)
- Windows (x64)

## Development

### Prerequisites

- Rust stable (`rustup default stable`)
- Node.js 20+
- Tauri platform dependencies: <https://v2.tauri.app/start/prerequisites/>

### Setup

```bash
git clone https://github.com/Dudude-bit/k8s-gui.git
cd k8s-gui
npm install
npm run tauri dev
```

### Build

```bash
npm run tauri build
```

## Tech stack

- **Framework:** Tauri 2.1
- **Backend:** Rust
- **Frontend:** React 18 + TypeScript
- **State:** Zustand + TanStack Query
- **Styling:** Tailwind CSS
- **UI primitives:** Radix UI

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT — see [LICENSE](LICENSE).
````

- [ ] **Step 2: Verify README renders**

Run:
```bash
head -3 README.md
```

Expected: first line `# K8s GUI`, second empty, third begins with `A modern, cross-platform`.

---

## Task 7: Create CONTRIBUTING.md

**Files:**
- Create: `CONTRIBUTING.md`

- [ ] **Step 1: Write the file**

Use the Write tool to create `CONTRIBUTING.md` at repo root:

````markdown
# Contributing to K8s GUI

Thanks for your interest in contributing.

## Local development

### Prerequisites

- Rust stable (`rustup default stable`)
- Node.js 20+
- Tauri platform dependencies: <https://v2.tauri.app/start/prerequisites/>

### Setup

```bash
git clone https://github.com/Dudude-bit/k8s-gui.git
cd k8s-gui
npm install
npm run tauri dev
```

## Code style

- **Rust:** `cargo fmt` and `cargo clippy` must pass.
- **TypeScript:** ESLint + Prettier (configs are in the repo).

Before committing:

```bash
cargo fmt --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
npm run lint
```

## Tests

```bash
cargo test --manifest-path src-tauri/Cargo.toml
```

## Commit convention

[Conventional Commits](https://www.conventionalcommits.org/):

- `feat:` new feature
- `fix:` bug fix
- `docs:` documentation
- `refactor:` code restructuring without behavior change
- `chore:` tooling, build, deps
- `test:` tests only

## Pull requests

1. Fork the repo.
2. Create a feature branch from `main`.
3. Keep PRs focused — one topic per PR.
4. Link the related issue in the description.
5. Ensure CI is green before requesting review.

## Issues

- Bug reports: use the bug template (include reproduction steps, OS, k8s version).
- Feature requests: explain the use case, not just the proposal.
````

- [ ] **Step 2: Verify file**

Run:
```bash
head -3 CONTRIBUTING.md
```

Expected: first line `# Contributing to K8s GUI`.

---

## Task 8: Create CHANGELOG.md

**Files:**
- Create: `CHANGELOG.md`

- [ ] **Step 1: Write the file**

Note: the `YYYY-MM-DD` placeholder is intentional — replace it with today's date (or the actual force-push date) just before executing Task 15.

Use the Write tool to create `CHANGELOG.md`:

````markdown
# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.0.0] - YYYY-MM-DD

### Added
- Initial open-source release under MIT license.

### Removed
- Proprietary licensing and premium feature gating.
````

- [ ] **Step 2: Verify file**

Run:
```bash
head -3 CHANGELOG.md
```

Expected: first line `# Changelog`.

---

## Task 9: Create .github/ISSUE_TEMPLATE/bug_report.md

**Files:**
- Create: `.github/ISSUE_TEMPLATE/bug_report.md`

- [ ] **Step 1: Ensure directory exists**

Run:
```bash
mkdir -p .github/ISSUE_TEMPLATE
```

Expected: silent success (or directory already exists).

- [ ] **Step 2: Write the file**

Use the Write tool to create `.github/ISSUE_TEMPLATE/bug_report.md`:

```markdown
---
name: Bug report
about: Report something that doesn't work as expected
labels: bug
---

**Describe the bug**

A clear description of what is broken.

**To reproduce**

1. Go to '...'
2. Click '...'
3. See error

**Expected behavior**

What you expected to happen.

**Environment**

- OS: [e.g. macOS 14.5 / Ubuntu 24.04 / Windows 11]
- k8s-gui version: [e.g. 2.0.0 — see Settings > About]
- Kubernetes version: [e.g. 1.30]
- Cluster provider: [EKS / GKE / AKS / local / OIDC]

**Logs / screenshots**

Paste relevant logs from the app or terminal output, and attach screenshots if helpful.
```

- [ ] **Step 3: Verify**

Run:
```bash
head -5 .github/ISSUE_TEMPLATE/bug_report.md
```

Expected: YAML frontmatter with `name: Bug report`.

---

## Task 10: Create .github/ISSUE_TEMPLATE/feature_request.md

**Files:**
- Create: `.github/ISSUE_TEMPLATE/feature_request.md`

- [ ] **Step 1: Write the file**

Use the Write tool to create `.github/ISSUE_TEMPLATE/feature_request.md`:

```markdown
---
name: Feature request
about: Suggest a new feature or improvement
labels: enhancement
---

**What problem does this solve?**

Describe the user pain point or use case.

**Proposed solution**

What should the feature do?

**Alternatives considered**

Other approaches you thought about and why you did not pick them.

**Additional context**

Screenshots, related issues, or anything else.
```

- [ ] **Step 2: Verify**

Run:
```bash
head -5 .github/ISSUE_TEMPLATE/feature_request.md
```

Expected: YAML frontmatter with `name: Feature request`.

---

## Task 11: Create .github/PULL_REQUEST_TEMPLATE.md

**Files:**
- Create: `.github/PULL_REQUEST_TEMPLATE.md`

- [ ] **Step 1: Write the file**

Use the Write tool to create `.github/PULL_REQUEST_TEMPLATE.md`:

```markdown
## What changed

Brief description of the change.

## Why

Link to the issue or explain the motivation.

Closes #

## Test plan

- [ ] Verified manually on <platform>
- [ ] Added/updated tests where applicable
- [ ] `cargo fmt`, `cargo clippy`, and `npm run lint` pass

## Screenshots (if UI change)

<!-- paste if applicable -->
```

- [ ] **Step 2: Verify**

Run:
```bash
head -3 .github/PULL_REQUEST_TEMPLATE.md
```

Expected: first line `## What changed`.

---

## Task 12: Bump version in 4 files to 2.0.0 + switch updater endpoint

**Files:**
- Modify: `src-tauri/tauri.conf.json` (version bump AND updater endpoint URL swap)
- Modify: `src-tauri/Cargo.toml` (`version = "1.7.12"` → `version = "2.0.0"`)
- Modify: `k8s-gui-common/Cargo.toml` (`version = "0.1.0"` → `version = "2.0.0"`)
- Modify: `package.json` (`"version": "0.1.0"` → `"version": "2.0.0"`)

- [ ] **Step 1: Edit src-tauri/tauri.conf.json — version**

Use the Edit tool:
- old_string: `"version": "1.7.12",`
- new_string: `"version": "2.0.0",`

- [ ] **Step 2: Edit src-tauri/tauri.conf.json — updater endpoint**

Use the Edit tool:
- old_string: `"https://storage.yandexcloud.net/k8s-gui-releases/releases/latest.json"`
- new_string: `"https://github.com/Dudude-bit/k8s-gui/releases/latest/download/latest.json"`

- [ ] **Step 3: Verify both changes in tauri.conf.json**

Run:
```bash
grep -E '("version"|"endpoints")' src-tauri/tauri.conf.json
grep -A1 '"endpoints"' src-tauri/tauri.conf.json | tail -1
```

Expected:
- `"version": "2.0.0",`
- endpoint line contains `https://github.com/Dudude-bit/k8s-gui/releases/latest/download/latest.json`
- NO `storage.yandexcloud.net` in the endpoints block.

- [ ] **Step 4: Edit src-tauri/Cargo.toml**

Use the Edit tool:
- old_string: `version = "1.7.12"`
- new_string: `version = "2.0.0"`

- [ ] **Step 5: Verify**

Run:
```bash
grep '^version' src-tauri/Cargo.toml
```

Expected: `version = "2.0.0"`.

- [ ] **Step 6: Edit k8s-gui-common/Cargo.toml**

Use the Edit tool:
- old_string: `version = "0.1.0"`
- new_string: `version = "2.0.0"`

- [ ] **Step 7: Verify**

Run:
```bash
grep '^version' k8s-gui-common/Cargo.toml
```

Expected: `version = "2.0.0"`.

- [ ] **Step 8: Edit package.json**

Use the Edit tool:
- old_string: `"version": "0.1.0",`
- new_string: `"version": "2.0.0",`

(If the line in package.json is formatted differently — e.g., different whitespace — match exactly. Read the file first to confirm.)

- [ ] **Step 9: Verify**

Run:
```bash
grep '"version"' package.json
```

Expected: `"version": "2.0.0",`.

---

## Task 13: Refresh Cargo.lock and smoke-test builds

**Files:**
- Auto-modify: `Cargo.lock` (via `cargo check`)

- [ ] **Step 1: Refresh Cargo.lock for the version bump**

Run:
```bash
cargo check --manifest-path src-tauri/Cargo.toml
```

Expected: Finishes without errors. `Cargo.lock` is updated to reflect `k8s-gui@2.0.0` and `k8s-gui-common@2.0.0`.

- [ ] **Step 2: Confirm Cargo.lock reflects new versions**

Run:
```bash
grep -A1 'name = "k8s-gui"' Cargo.lock | head -4
grep -A1 'name = "k8s-gui-common"' Cargo.lock | head -4
```

Expected: both show `version = "2.0.0"`.

- [ ] **Step 3: Smoke-test frontend build with new version**

Run:
```bash
npm run build
```

Expected: TypeScript compiles, Vite produces `dist/` without errors.

- [ ] **Step 4: Confirm working tree state matches the plan**

Run:
```bash
git status --short | head -20
```

Expected (in arbitrary order): a handful of untracked new files (`LICENSE`, `README.md`, `CONTRIBUTING.md`, `CHANGELOG.md`, `.github/ISSUE_TEMPLATE/...`, `.github/PULL_REQUEST_TEMPLATE.md`), modifications to `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, `k8s-gui-common/Cargo.toml`, `package.json`, `Cargo.lock`, and deletions for the 5 removed `docs/plans/...` files. No other entries. If unexpected files appear, investigate before proceeding.

---

## Task 14: Create orphan branch with single commit

**Files:** (git operations only — no file content changes)

- [ ] **Step 1: Create the orphan branch**

Run:
```bash
git checkout --orphan opensource-release
```

Expected: `Switched to a new branch 'opensource-release'`. The working tree is unchanged; the index still holds the state inherited from `main`.

- [ ] **Step 2: Reset the index (so nothing from the old history carries over implicitly)**

Run:
```bash
git rm -rf --cached .
```

Expected: many `rm '...'` lines, one per previously tracked file. This removes everything from the index but leaves the working tree intact.

- [ ] **Step 3: Stage everything from the working tree**

Run:
```bash
git add -A
```

Expected: silent success. This stages all current files — existing code + new OSS files, minus anything in `.gitignore`.

- [ ] **Step 4: Sanity-check the staging area**

Run:
```bash
git status --short | wc -l
git status --short | grep -E '^A ' | head -5
git status --short | grep -vE '^A ' | head -20
```

Expected: the first number is roughly the total count of tracked files (a few hundred). Nearly every entry should start with `A ` (added). Anything else (`??` untracked, `D ` deletion) indicates something went wrong — investigate.

- [ ] **Step 5: Verify key files are staged**

Run:
```bash
git ls-files --stage | grep -E '(LICENSE|README\.md|CONTRIBUTING\.md|CHANGELOG\.md|\.github/ISSUE_TEMPLATE|PULL_REQUEST_TEMPLATE|src-tauri/src/lib\.rs|src/App\.tsx|package\.json|src-tauri/Cargo\.toml)' | head -15
```

Expected: at minimum, all the files above are listed. If `LICENSE` or `README.md` is missing, re-check Tasks 5–6.

- [ ] **Step 6: Commit as the single open-source release commit**

Run:
```bash
git commit -m "feat: initial open-source release v2.0.0"
```

Expected: `[opensource-release (root-commit) <sha>] feat: initial open-source release v2.0.0` followed by `<N> files changed, <M> insertions(+)`.

- [ ] **Step 7: Confirm this branch has exactly one commit**

Run:
```bash
git log --oneline opensource-release
```

Expected: exactly one line, the commit just made.

---

## Task 15: Update CHANGELOG with actual release date, then amend

**Files:**
- Modify: `CHANGELOG.md` (replace `YYYY-MM-DD` with today's date)

- [ ] **Step 1: Get today's date in ISO format**

Run:
```bash
date +%Y-%m-%d
```

Write the output down (e.g., `2026-04-24`).

- [ ] **Step 2: Update CHANGELOG.md**

Use the Edit tool:
- old_string: `## [2.0.0] - YYYY-MM-DD`
- new_string: `## [2.0.0] - <today's date from Step 1>`

(Use the literal date string from Step 1.)

- [ ] **Step 3: Stage and amend the orphan commit**

Run:
```bash
git add CHANGELOG.md
git commit --amend --no-edit
```

Expected: the single commit in `opensource-release` now contains the dated CHANGELOG. The commit SHA changes — that is expected.

- [ ] **Step 4: Confirm the amendment**

Run:
```bash
git show --stat HEAD | head -5
grep '^## \[2.0.0\]' CHANGELOG.md
```

Expected: commit shows `feat: initial open-source release v2.0.0`; CHANGELOG line shows the actual date (no `YYYY-MM-DD`).

---

## Task 16: Swap branches — rename opensource-release → main

**Files:** (git metadata only)

- [ ] **Step 1: Delete the old main branch**

Run:
```bash
git branch -D main
```

Expected: `Deleted branch main (was <old-sha>).` The old main is still reachable via the `pre-opensource-archive` tag, so this is safe.

- [ ] **Step 2: Rename opensource-release → main**

Run:
```bash
git branch -m opensource-release main
```

Expected: silent success.

- [ ] **Step 3: Verify current branch is main with a single commit**

Run:
```bash
git branch --show-current
git log --oneline
```

Expected: `main`; exactly one commit.

- [ ] **Step 4: Verify the archive tag still exists and points to the old history**

Run:
```bash
git rev-parse pre-opensource-archive
git log --oneline pre-opensource-archive | head -5
```

Expected: the tag still resolves; its log shows the pre-OSS history (starting with `chore: finalize premium/license removal`).

---

## Task 17: Force-push the new main to origin

**Files:** None (remote git operation).

- [ ] **Step 1: Fetch latest remote state**

Run:
```bash
git fetch origin main
```

Expected: fetches latest `origin/main`. This refreshes the local `origin/main` ref so `--force-with-lease` knows what it's overwriting.

- [ ] **Step 2: Force-push with lease**

Run:
```bash
git push --force-with-lease origin main
```

Expected: `+ <old-sha>...<new-sha> main -> main (forced update)`.

If this fails with `stale info` or `rejected`: someone pushed to origin/main between the fetch and push. Re-run Step 1 and Step 2. Do NOT use plain `--force` unless you have manually verified no one else pushed.

- [ ] **Step 3: Verify remote matches local**

Run:
```bash
git fetch origin main
git log origin/main --oneline | head -3
```

Expected: exactly one commit on `origin/main`, matching the local `main` commit.

- [ ] **Step 4: Verify the pre-opensource-archive tag is NOT on origin**

Run:
```bash
git ls-remote --tags origin | grep pre-opensource-archive || echo "tag is NOT on remote (expected)"
```

Expected: `tag is NOT on remote (expected)`. If the tag IS on remote, delete it immediately: `git push origin --delete pre-opensource-archive`.

---

## Task 18: Flip repository visibility to public

**Files:** None (GitHub settings).

- [ ] **Step 1: Confirm gh is authenticated**

Run:
```bash
gh auth status
```

Expected: `Logged in to github.com account Dudude-bit`. Token scopes include `repo`.

- [ ] **Step 2: Flip visibility**

Run:
```bash
gh repo edit Dudude-bit/k8s-gui \
   --visibility public \
   --accept-visibility-change-consequences
```

Expected: `✓ Edited repository Dudude-bit/k8s-gui`.

- [ ] **Step 3: Confirm visibility is public**

Run:
```bash
gh api /repos/Dudude-bit/k8s-gui --jq '.visibility'
```

Expected: `public`.

If it still shows `private`: wait 10s and retry (GitHub is eventually consistent). If still wrong, check `gh auth status` and permissions on the account.

---

## Task 19: Set description and topics

**Files:** None (GitHub settings).

- [ ] **Step 1: Apply description and topics**

Run:
```bash
gh repo edit Dudude-bit/k8s-gui \
   --description "Modern cross-platform Kubernetes GUI client built with Tauri and Rust" \
   --add-topic kubernetes \
   --add-topic tauri \
   --add-topic rust \
   --add-topic react \
   --add-topic desktop-app \
   --add-topic k8s
```

Expected: `✓ Edited repository Dudude-bit/k8s-gui`.

- [ ] **Step 2: Verify**

Run:
```bash
gh api /repos/Dudude-bit/k8s-gui --jq '{description: .description, topics: .topics}'
```

Expected: `description` matches; `topics` array contains all 6 topics.

---

## Task 20: Post-push verification

**Files:** None (verification only).

- [ ] **Step 1: Open the repo in a browser**

Run:
```bash
gh repo view Dudude-bit/k8s-gui --web
```

Expected: browser opens the repo page. Manually check:
- README renders with sections (Features, Installation, Development, etc.).
- Topics are visible below description.
- Only one commit in history (click `commits` link).
- `LICENSE`, `CONTRIBUTING.md`, `CHANGELOG.md` are listed in the file tree.
- `.github/ISSUE_TEMPLATE/` and `.github/PULL_REQUEST_TEMPLATE.md` are present.

- [ ] **Step 2: Check CI run**

Run:
```bash
gh run list --repo Dudude-bit/k8s-gui --limit 3
```

Expected: a run for the new commit. Status should be `in_progress` or `completed`. If `failure`, inspect:

```bash
gh run view --repo Dudude-bit/k8s-gui --log-failed
```

If the failure is due to secrets unset after visibility change (unlikely — Actions secrets survive visibility flips), restore them via `gh secret set`.

- [ ] **Step 3: Fresh-clone smoke test**

Run:
```bash
cd /tmp
rm -rf k8s-gui-smoketest
git clone https://github.com/Dudude-bit/k8s-gui.git k8s-gui-smoketest
cd k8s-gui-smoketest
git log --oneline
wc -l README.md CONTRIBUTING.md CHANGELOG.md LICENSE
```

Expected:
- Clone succeeds anonymously (proof of public visibility).
- `git log` shows exactly one commit.
- All four root docs have plausible line counts.

- [ ] **Step 4: Fresh-clone build smoke**

Still inside `/tmp/k8s-gui-smoketest`:

```bash
npm install
npm run build
```

Expected: both succeed. If they fail on a machine that isn't the owner's dev box, note the error and file it as the first real issue on the OSS repo.

- [ ] **Step 5: Return to the main workspace**

Run:
```bash
cd /Users/kirillinakin/RustroverProjects/k8s-gui
```

Expected: back in the original working directory.

---

## Rollback procedure (if anything goes wrong)

At any point BEFORE Task 18 (visibility flip): the repo is still private. Simply:

```bash
git reset --hard pre-opensource-archive
git push --force-with-lease origin main
```

If Task 18 has already completed and something is wrong in the public repo:

```bash
gh repo edit Dudude-bit/k8s-gui --visibility private --accept-visibility-change-consequences
git reset --hard pre-opensource-archive
git push --force-with-lease origin main
```

Then investigate, fix, and re-run from Task 14.

If the local `.git/` is damaged and the tag is lost: restore from the offline `--mirror` backup created in Task 3 Step 4 (if that step was performed).

---

## Self-review

**Spec coverage (each spec section maps to tasks):**
- Section 1 Context — Task 1 (audit preflight).
- Section 2 Goals — Tasks 5–14 (single-commit main, OSS files, local tag).
- Section 3 Non-goals — N/A (nothing to implement).
- Section 4.1 Git operations — Tasks 2, 3, 14, 16, 17.
- Section 4.2 Housekeeping + version bump + cleanup — Tasks 4, 5, 6, 7, 8, 9, 10, 11, 12, 13.
- Section 4.3 GitHub settings — Tasks 18, 19.
- Section 5 Detailed procedure — mirrors Tasks 1–19.
- Section 6.1 README — Task 6.
- Section 6.2 CONTRIBUTING — Task 7.
- Section 6.3 CHANGELOG — Tasks 8 and 15 (placeholder → real date).
- Section 6.4 Issue/PR templates — Tasks 9, 10, 11.
- Section 6.5 Version bump — Task 12.
- Section 7 Risks and rollback — Rollback procedure section above.
- Section 8 Verification — Tasks 1 (pre) and 20 (post).
- Section 9 Open questions — none.

Gap added vs spec: LICENSE file creation (Task 5) was not explicitly listed in the spec because the spec assumed LICENSE existed. It does not — verified during self-review of the plan. Task 5 addresses this.

**Placeholder scan:** searched the plan for "TBD", "TODO", "implement later", "fill in details", "similar to Task N". The only remaining placeholder is `YYYY-MM-DD` in the CHANGELOG template — which is intentional and explicitly replaced in Task 15. Also `/path/to/external/...` in Task 3 Step 4 which is an intentional parameter the engineer picks.

**Type / identifier consistency:** branch name `opensource-release` used consistently across Tasks 14, 16. Tag name `pre-opensource-archive` used consistently across Tasks 3, 16 Step 4, 17 Step 4, rollback. Repo identifier `Dudude-bit/k8s-gui` used consistently in all `gh` commands.

**One more thing:** the plan does NOT commit itself (this file, the plan document). That happens after the plan is finalized and the user accepts it — a pre-execution commit outside the 20-task flow. The orphan commit in Task 14 will include this plan file as part of the working tree, so the OSS release ships with its own implementation plan. That's by design.
