# Open-Source Release v2.0.0 — Design

**Date:** 2026-04-23
**Scope:** One-time operation to publish `Dudude-bit/k8s-gui` as an open-source project under MIT.
**Out of scope:** Homebrew/AUR packaging, release hosting migration, re-signing release artifacts with a new updater key, CODE_OF_CONDUCT, funding links.

---

## 1. Context

The project previously had a proprietary licensing system (user auth, license validation, payment integration, separate `auth-server/` Rust service, `appsmith-admin-panel/`). That system was removed in staged deletions totaling 126 files and 13,055 lines, but the removal was never committed — it lives in the index.

A thorough audit was performed before writing this spec. Summary: zero leftover premium/license/user-auth references in the working tree (ripgrep across Rust, TS/TSX, configs, docs, and dependencies — all matches were false positives like `license = "MIT"` in `Cargo.toml` or `telemetry.istio.io` CRD group). The k8s cluster authentication module (`src-tauri/src/auth/` — EKS/GKE/AKS/OIDC) is legitimate and stays.

The user decided against preserving git history: the license code never reached revenue, the project has zero stargazers and zero forks, and no external contributors depend on the history. A squash-to-orphan approach is the cleanest path.

## 2. Goals

- Publish `Dudude-bit/k8s-gui` as a public OSS repo under MIT.
- Single-commit `main` with version **2.0.0**, free of all premium/license history.
- Working build (Rust + TypeScript) at HEAD.
- Minimal OSS hygiene: README, CONTRIBUTING, CHANGELOG, issue/PR templates.
- Preserve full pre-OSS history **locally only** via a safety tag in case rollback is needed. The tag MUST NOT be pushed to origin — once the repo flips to public, any reachable ref leaks the entire license/payment history.

## 3. Non-goals

- Rewrite of the source code.
- Changes to Kubernetes features, UI, or CLI flows.
- New updater signing key.
- CI release automation. First 2.0.x releases are built locally and uploaded via `gh release create` manually. A `release.yml` workflow with signing and `latest.json` generation is a follow-up project.
- Migration of existing 1.7.x users onto 2.0.0. 1.7.x installs have a hardcoded YC updater URL; the YC bucket will not be updated with a 2.0.0 build. Acceptable because the installed userbase is effectively zero (project never shipped publicly).
- **Change of Tauri `identifier` (`com.k8s-gui.app`)** — must stay stable so any existing install could auto-update if a transition release were published. Renaming it would break updater continuity forever.

### In scope (added 2026-04-24 after user decision)

- **Switch updater endpoint from YC bucket to GitHub Releases.** Single-line change in `tauri.conf.json`. New 2.0.0 installs will check `https://github.com/Dudude-bit/k8s-gui/releases/latest/download/latest.json` for updates. This makes the release pipeline standard-OSS-shaped and removes the YC bucket from the critical path for new users.

## 4. Architecture

Three areas of change:

### 4.1 Git operations (local, then force-push)

1. Commit the staged deletions onto current `main` — so the archive tag captures a consistent state.
2. Tag `pre-opensource-archive` **locally only** (do not push). This tag is the rollback anchor; leaving it on origin would expose the full license history once the repo turns public.
3. Create an orphan branch, add new OSS files + version bump, commit as `feat: initial open-source release v2.0.0`.
4. Swap branches: delete the old `main`, rename orphan → `main`.
5. Force-push with `--force-with-lease`.
6. After the force-push, the local `pre-opensource-archive` tag is the ONLY reference to the pre-OSS history. For an additional offline safety net, `git clone --mirror .` to external storage before step 5.

### 4.2 Repository housekeeping (new files + version bump + cleanup)

New files:
- `README.md`
- `CONTRIBUTING.md`
- `CHANGELOG.md`
- `.github/ISSUE_TEMPLATE/bug_report.md`
- `.github/ISSUE_TEMPLATE/feature_request.md`
- `.github/PULL_REQUEST_TEMPLATE.md`

Version bumped 1.7.12 → **2.0.0** in:
- `src-tauri/tauri.conf.json`
- `src-tauri/Cargo.toml`
- `k8s-gui-common/Cargo.toml`
- `package.json`
- `Cargo.lock` updates automatically via the preflight `cargo check`.

Cleanup before orphan commit:
- Delete legacy `docs/plans/2026-01-*.md` and `docs/plans/2026-01-17-terminal-refactor-auth-prompts-design.md` — they contain 10+ hardcoded `/Users/kirillinakin/...` paths and describe features already shipped (shell wrapper, metrics unification, terminal refactor). Keeping them in a public repo leaks personal filesystem paths for no benefit. This spec file under `docs/superpowers/specs/` stays — it documents the OSS transition itself.
- Verify `.gitignore` already excludes `artifacts/`, `.env`, `dist/`, `target/`, `.DS_Store`, `.idea/`, `.vscode/`, `.cursor/` (it does — checked during audit), so the orphan commit picks up none of them.

### 4.3 GitHub repo settings (via `gh` CLI)

- Flip visibility private → public.
- Set description: `Modern cross-platform Kubernetes GUI client built with Tauri and Rust`.
- Add topics: `kubernetes`, `tauri`, `rust`, `react`, `k8s`, `desktop-app`.

## 5. Detailed procedure

```bash
# --- Preflight (must succeed before any destructive step) ---
cargo check --manifest-path src-tauri/Cargo.toml
npm run build
rg -E '(AIza|sk_|sk-|xox[pbar]|ghp_|gho_|github_pat_|AKIA|ASIA|SG\.|ya29\.)' \
   --glob='!node_modules' --glob='!dist' --glob='!src-tauri/target' .
rg -n 'kirillinakin|<old-author-email>' src/ src-tauri/ k8s-gui-common/ docs/ || true

# --- Backup ---
git add -A
git commit -m "chore: finalize premium/license removal"
git tag pre-opensource-archive          # LOCAL ONLY — do not push
# Optional: offline backup before destructive step
git clone --mirror . /path/to/external/k8s-gui-archive.git

# --- Add OSS files + bump version on current main ---
# (files created via Write tool — see Section 6)

# --- Clean slate ---
git checkout --orphan opensource-release
git rm -rf --cached .
git add -A
git commit -m "feat: initial open-source release v2.0.0"
git branch -D main
git branch -m opensource-release main

# --- Force-push ---
git fetch origin main                                 # refresh ref for --force-with-lease
git push --force-with-lease origin main

# --- Go public ---
gh repo edit Dudude-bit/k8s-gui \
   --visibility public \
   --accept-visibility-change-consequences \
   --description "Modern cross-platform Kubernetes GUI client built with Tauri and Rust" \
   --add-topic kubernetes --add-topic tauri --add-topic rust \
   --add-topic react --add-topic desktop-app --add-topic k8s

# --- Post-verify ---
gh api /repos/Dudude-bit/k8s-gui --jq '.visibility'   # -> "public"
gh repo view Dudude-bit/k8s-gui --web                  # manual eyeball
```

Note on ordering: new files must be added on the old `main` BEFORE the orphan checkout, so `git checkout --orphan` picks them up via the working tree. Alternative is to add them after the orphan checkout but before the commit — either works, the spec uses the first form for simplicity.

## 6. File content specifications

### 6.1 `README.md` (~80–120 lines)

Sections in order:
1. Title and one-sentence description.
2. Features — bullet list: cluster management, workloads (Pods/Deployments/StatefulSets/DaemonSets/Jobs/CronJobs), network (Services/Ingresses/Endpoints), storage (PV/PVC/StorageClass), configuration (ConfigMaps/Secrets), nodes, events, CRDs + custom resources, Helm, in-app terminal, port-forwarding, logs streaming, metrics.
3. Installation — link to GitHub Releases (to be populated by first public release).
4. Development — prerequisites (Rust stable, Node 20+, bun or npm), `npm install`, `npm run tauri dev`.
5. Tech stack — Tauri 2.1, Rust, React 18, TypeScript, TanStack Query, Zustand, Tailwind.
6. Contributing — link to CONTRIBUTING.md.
7. License — MIT (link to LICENSE).

### 6.2 `CONTRIBUTING.md` (~40–60 lines)

1. How to run locally (repeat of README Development, slightly expanded).
2. Code style: `cargo fmt` and `cargo clippy` for Rust; ESLint + Prettier (configs already in repo) for frontend.
3. Tests: `cargo test` where applicable.
4. Commit convention: conventional commits (`feat:`, `fix:`, `chore:`, `refactor:`, `docs:`) — this is already the project's practice.
5. PR flow: fork, branch, PR against `main`, one topic per PR.

### 6.3 `CHANGELOG.md`

```markdown
# Changelog

All notable changes to this project will be documented in this file.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [2.0.0] - YYYY-MM-DD   (set to actual release date at implementation time)

### Added
- Initial open-source release under MIT license.

### Removed
- Proprietary licensing and premium feature gating.
```

### 6.4 Issue / PR templates

`bug_report.md`: reproduction steps, expected, actual, environment (OS, Kubernetes version, k8s-gui version), logs.
`feature_request.md`: problem statement, proposed solution, alternatives considered.
`PULL_REQUEST_TEMPLATE.md`: what changed, why, linked issue, test plan.

All short — ~20–30 lines each.

### 6.5 Version bump

Four files, value `2.0.0`:
- `src-tauri/tauri.conf.json` → `"version": "2.0.0"`
- `src-tauri/Cargo.toml` → `version = "2.0.0"`
- `k8s-gui-common/Cargo.toml` → `version = "2.0.0"`
- `package.json` → `"version": "2.0.0"`

## 7. Risks and rollback

| Risk | Mitigation |
|---|---|
| Force-push destroys history irretrievably | `pre-opensource-archive` tag kept locally points to the pre-force-push commit. Rollback: `git reset --hard pre-opensource-archive && gh repo edit Dudude-bit/k8s-gui --visibility private && git push --force-with-lease origin main`. For extra safety, clone `--mirror` to external storage before step 5. |
| Secrets leak when repo goes public | Actions secrets are not exposed on visibility change. Preflight secret scan (Section 5). `.env` confirmed empty during audit. |
| CI breaks after squash (historical commit hashes gone) | Any external reference via commit SHA breaks. Internal references (within this repo) all fresh. Mitigation: verify `.github/workflows/build.yml` does not pin to specific SHAs of this repo. |
| `updater.pubkey` in `tauri.conf.json` is a private key | False — the field name `pubkey` indicates a public key (minisign format, base64-encoded). The matching private key is kept outside the repo (locally or in CI secrets) and is not in tree. Implementation step: grep for `untrusted comment: minisign secret` / `RWR` prefixes to double-confirm no private key leaked before push. |
| YC bucket URL still appears in `build.py` | Resolved by deleting `build.py` entirely during Task 4 (user confirmed 2026-04-24 that YC bucket is being retired). No YC URLs remain in the tree after cleanup; updater endpoint now points at GitHub Releases. |
| New updater endpoint requires a valid `latest.json` at the GitHub Releases URL | Until the first 2.0.0 release is published to GitHub Releases with a `latest.json` asset, new 2.0.0 installs will fail silently during update checks (not a crash — just "no update available"). Mitigation: publish the first release immediately after force-push, OR accept the gap because no users have 2.0.0 yet. |
| Author email becomes public | Email `maintainer@example.com` will be visible in the orphan commit. Acceptable per user's current config — if later we want a noreply email, amend the orphan commit with `GIT_AUTHOR_EMAIL`. |

## 8. Verification (pre- and post-push)

Pre-push preflight (before the backup commit):
1. `cargo check` on `src-tauri/Cargo.toml` — Rust compiles. Also refreshes `Cargo.lock` with new version.
2. `npm run build` — frontend builds.
3. Secret-pattern scan across repo — no hits.
4. `kirillinakin|<old-author-email>` grep across `src/ src-tauri/ k8s-gui-common/ docs/` — MUST be zero hits after legacy plans deletion. If any remain, delete or sanitize the file.
5. `grep 'minisign secret\|RWR' src-tauri/ .github/` — confirm no private updater key leaked into the repo (public `pubkey` is expected; private is not).
6. Verify YC bucket `k8s-gui-releases` has list-unauthorized ACL (manual step — check via YC console or `aws s3api get-bucket-acl --endpoint-url https://storage.yandexcloud.net`).

Post-push verification:
7. `gh api /repos/Dudude-bit/k8s-gui --jq '.visibility'` returns `public`.
8. `gh repo view Dudude-bit/k8s-gui --web` — README renders, topics visible.
9. CI (`.github/workflows/build.yml`) triggered on the new single commit and passes.
10. Can clone fresh, run `npm install && npm run tauri dev`, app launches.

## 9. Open questions

None required to start implementation. All decisions settled:
- Squash approach: confirmed.
- Target repo: existing `Dudude-bit/k8s-gui`, flip private → public.
- No CODE_OF_CONDUCT / FUNDING / Wiki for initial release.
- Keep existing updater key.
- Keep existing YC bucket.
