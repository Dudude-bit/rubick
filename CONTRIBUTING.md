# Contributing to Rubick

Thanks for your interest in contributing.

## Local development

### Prerequisites

- Rust stable (`rustup default stable`)
- Node.js 24 LTS (or newer)
- Bun 1.3+ (<https://bun.sh> — the package manager for this repo)
- Tauri platform dependencies: <https://v2.tauri.app/start/prerequisites/>

### Setup

```bash
git clone https://github.com/Dudude-bit/rubick.git
cd rubick
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

Three lint rules exist to stop the codebase drifting back to habits it has
already left. Each fails the commit, and each has a reason:

- **Role tokens only.** Raw Tailwind colours, `dark:` variants and the legacy
  shadcn tokens are banned across `src/`. The app draws in roles — `--fg-mut`,
  `--warn`, `--hair` — so a theme is one file rather than a thousand decisions.
- **No vendor imports outside `src/integrations/`.** A surface asks for a
  _capability_ (`usage.history`, `delivery.source`) and never names Traefik or
  Prometheus. This is what lets every integration be optional without a single
  `if (hasPrometheus)` anywhere in the UI.
- **No hand-written `refetchInterval`.** Polling goes through `useLiveQuery`,
  which takes a rate _name_ and derives the interval from whether anything is
  visible, focused and changing. Written by hand, it was costing the cluster
  ~895 API requests a minute per idle window.

Before committing:

```bash
cargo fmt --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
bun run lint
```

## Tests

```bash
bun run test                                          # frontend
cargo test --manifest-path src-tauri/Cargo.toml       # Rust
```

Tests here assert _behaviour_, not markup, and the house style is a doc comment
saying what would break followed by the assertion — so a failing test explains
itself. There are also `#[ignore]`d integration tests that run against a live
cluster (`src-tauri/tests/live_*.rs`); `test-manifests/k8s-gui-all.yaml` creates
every fixture they need, each block carrying its own cleanup command.

## Adding an integration

An integration costs **one folder and one line**. Create
`src/integrations/<vendor>/`, export a `defineVendor({...})` from its
`index.ts`, and add it to the list in `src/integrations/index.ts`. Nothing
else in the app changes.

Which tier it belongs to decides its obligations, not where its files live:

- **In-cluster extension** — cert-manager, Traefik, Argo CD. **Detected**, never
  configured: its CRDs exist or they do not, which is a fact with a yes and a
  no rather than a guess. No connect form, no settings.
- **External service** — Prometheus, Loki. **Configured**, never detected. It
  needs an address, and the app does not go looking for one.

### Connecting a configured integration

Worth its own paragraphs, because everything about it follows from one fact
that is easy to forget while writing the code:

> **The request is made from the reader's machine, not from inside the
> cluster.** `wire.rs` is a plain `reqwest` client in the app's own process.
> Nothing is proxied through the API server and the kubeconfig is not involved.

So the address has to be one the _desktop_ can resolve and reach. The obvious
one — `http://prometheus.monitoring:9090` — is a name only CoreDNS answers,
and it was this app's own placeholder for a while, which meant the field was
suggesting the single value that cannot work. Two things exist because of
that, and a new configured vendor should use both:

- **`Connect.inCluster`** — declare how your vendor's Service is labelled and
  which port it answers on, and the connect dialog grows a _Find it in this
  cluster_ button. The app resolves the Service to a running pod, forwards a
  local port and fills the address in. The reader is naming a server either
  way; a Service names one the app can already reach.
- **`unreachable()` in `src/integrations/reachability.ts`** — recognises a
  cluster-internal address in a failed probe and appends the sentence that
  explains it. Call it from your `probe`; keep the transport's own words in
  front of it, because somebody searching for `Name or service not known` has
  to find them.

Two traps in `inCluster`, both learned from real charts:

- **A chart installs several Services and most of them cannot answer your
  query.** Loki's puts up a gateway, a read path, a write path, an ingester
  and a compactor, all labelled `loki` and all answering HTTP; a connection to
  the write path establishes and then returns nothing. Put the query path in
  `prefer` and the rest in `avoid` — `avoid` **excludes**, it does not merely
  sort, because offering a dead end is worse than offering nothing.
- **Neighbours borrow the name.** `kube-prometheus-stack` calls its
  Alertmanager, node-exporter and kube-state-metrics Services after
  Prometheus. They belong in `avoid` too.

The forward is re-resolved rather than pinned: `port_forward_pod` targets a
**pod**, and `autoReconnect` retries that same pod, so a rollout would leave
it chasing something that no longer exists behind a `localhost` URL that still
looks fine. `forwarded.ts` looks the pod up from the Service every time and
keeps the local port, so the saved address stays true.

Two rules hold for both. An integration may only ever _add_ — the core answer
is drawn first and stays drawn, so a page is never worse for having an
integration that is down. And a capability whose absence has no good answer
does not belong behind an integration at all.

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
