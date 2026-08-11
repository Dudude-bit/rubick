# Contributing to K8s GUI

Thanks for your interest in contributing.

## Local development

### Prerequisites

- Rust stable (`rustup default stable`)
- Node.js 24 LTS (or newer)
- Bun 1.3+ (<https://bun.sh> — the package manager for this repo)
- Tauri platform dependencies: <https://v2.tauri.app/start/prerequisites/>

### Setup

```bash
git clone https://github.com/Dudude-bit/k8s-gui.git
cd k8s-gui
bun install
bunx lefthook install   # one-time: enables pre-commit + pre-push hooks
bun run tauri dev
```

The hooks (defined in `lefthook.yml`) run `cargo fmt --check`, `eslint`,
and `prettier --check` on staged files before each commit, and run the
test suites before each push. Skip them for a single commit with
`LEFTHOOK=0 git commit ...`.

## Code style

- **Rust:** `cargo fmt` and `cargo clippy` must pass.
- **TypeScript:** ESLint + Prettier (configs are in the repo).

Before committing:

```bash
cargo fmt --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
bun run lint
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
