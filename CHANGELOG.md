# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [3.0.0] - 2026-08-11

One rule decided most of this release: **the app must not claim what it
cannot back.** It is why a pod that displayed `Running` while its
container was dead counted as a bug rather than a cosmetic issue, why an
integration reports which stones it left unturned, and why a chart with
no history says so instead of drawing an empty plot.

### Renamed — K8s GUI is now Rubick

The repository had been renamed and the product had not, so every window
title, bundle name and doc comment still said K8s GUI. The product now
answers to Rubick, and the repository moved to
[`Dudude-bit/rubick`](https://github.com/Dudude-bit/rubick).

Two things are deliberately unchanged:

- **The bundle identifier stays `com.k8s-gui.app`.** Changing it orphans
  every installed copy from its updater and leaves a second app sitting
  beside the first. Existing 2.x installs therefore take this release as
  an ordinary in-place update; the app's name on disk and in the menu bar
  changes, the install does not fork.
- **The crate and binary names stay `k8s-gui` / `k8s_gui_lib`**, because
  the release workflow's artifact paths are keyed to them.

The updater endpoint now points at the renamed repository. Binaries built
before the rename keep asking the old URL, which GitHub redirects, so
2.1.0 installs still find this release.

### Added — integrations platform

A vendor tree where a new integration costs one folder and one line,
with a lint rule holding the seam: nothing outside `src/integrations/`
may name a vendor, and every surface asks for a _facet_
(`useCapability`, `useCrdView`, `flavourOf`) rather than for
cert-manager. The drift that made this necessary was cert-manager
landing twice, in two systems, because nothing refused the second one.

Three tiers carry different obligations: core, in-cluster extensions
detected by CRD, and external services configured by URL. Shipped:
cert-manager, Traefik, ingress-nginx, Istio, Argo CD, Flux, Prometheus,
Loki, k3s, minikube, Karpenter, and the three clouds' own controller
CRDs (AWS, Azure, Google Cloud).

cert-manager surfaces certificate expiry everywhere TLS is named, plus
the four-object issuance chain that ends on the sentence saying what
actually failed.

### Added — connections

One command answers an object's whole neighbourhood from the six edges
Kubernetes states outright (`commands/connections.rs`,
`resources/connections.rs`, `resources/selector.rs`).

The traffic chain draws the path from Ingress to pods and, more usefully,
**names where it stops**: a backend that does not exist, a selector that
matches nothing, and pods that are running but not ready — which every
list page in every tool draws as healthy. EndpointSlices replaced the
readiness deduction, which is what caught the named-port mismatch: a
Service with healthy pods, a healthy selector, and no traffic at all.

### Added — governance and delivery awareness

HPA and PodDisruptionBudget are read and rendered as three rows on the
workload they qualify (`Set by`, `Now`, `A drain waits`) rather than as
blocks of their own.

Scale, Restart, Delete and Edit YAML each say who will undo the change
and how fast — an autoscaler in about fifteen seconds, a GitOps
controller in about three minutes, both if both. They tell rather than
block: scaling a managed object by hand during an incident is
legitimate, and the app has no business refusing it. Every object's page
says whether GitOps delivers it and whether your edit will survive.

### Added — usage over time

CPU and memory as a series: the window the app watched itself when only
metrics-server is present, real ranges when Prometheus is connected, and
disk fullness and traffic that `metrics.k8s.io` cannot answer at all.

### Added — search, overview, ReplicaSets

A planned cluster-wide search (`search/plan.rs`), a cluster overview
command, and ReplicaSet as a first-class resource with its own detail
page.

### Fixed — status that tells the truth

`resources/types/pod_display.rs` ports kubectl's `printPod`, so the app
stops showing `Running` for a crash-looping pod. Init containers reach
the frontend as an ordered sequence; sidecars are distinguished from
init containers by the kubelet's own judgement instead of being
re-derived. Readiness counts sidecars exactly as `kubectl get pod` does,
verified against all 16 pods of a live cluster.

### Changed — logs and shell

The log viewer opens where the answer is: on a pod stuck in
`Init:CrashLoopBackOff` it opens on the failing init container, on its
previous run, and says so. Adds server-side intake filtering, a density
strip, repeat collapsing, and multi-container interleave.

Shell became a full-height tab whose session survives tab switches. The
fix uncovered that pod shells had been accepting no keyboard input at
all.

### Changed — design system

One flat canvas built on role tokens, calibrated by measurement rather
than opinion, with identity colouring by kind and by identifier chosen
to survive greyscale and colour blindness.

Three lint guards keep it from drifting back, all in the single
`no-restricted-syntax` block in `eslint.config.js`:

- Raw Tailwind colours, `dark:` branches, and the legacy shadcn tokens
  the app was scaffolded with are refused across all of `src/`. The
  shadcn names still resolve, which is why they survived so long:
  nothing breaks, the component just quietly leaves the design system.
- `refetchInterval` is an error everywhere except `useLiveQuery.ts`.
- Importing a named vendor from outside `src/integrations/` is refused.

### Performance

**Idle load on the API server: 895 → 205 requests per minute (−77%.)**

What cost that traffic was 45 hand-written polling intervals, of which
two checked whether anybody was looking at the screen they belonged to.
`useLiveQuery` now takes a _rate_ rather than a number and derives the
interval from visibility, window focus, stillness, and whether a watch
is live — and a lint rule stops the number from being written by hand
again.

A fourth freshness state, `slowed`, exists so that backing off never
lets stale data sit under a live badge. Every way of arriving back at a
query refetches it first: switching to a detail tab, un-minimising,
regaining focus. The licence to stop polling rests on that.

### Tooling

- **npm → bun.** `bun.lock` is committed; `beforeDevCommand` and
  `beforeBuildCommand` run through bun. CI installs and builds with it.
- Tests: 129 → 337 cargo (plus 10 ignored), 100 → 1437 vitest across
  112 files.
- `tsc`, `eslint --max-warnings 0`, `cargo fmt --check` and both test
  suites were green at every one of the 231 commits on the branch.

### Deliberately not done

- **Cloud tier 3** (pool ceilings, load-balancer health, workload
  identity) needs a real GKE/EKS/AKS cluster to verify against.
  Building it blind means shipping fields we never saw an API return.
- **Cost estimation.** Committed use, sustained use, spot pricing and
  negotiated rates make it wrong more often than right, and a wrong
  number about money poisons the right ones.
- **A whole-cluster topology graph.** The routing layer is a chain in
  fixed order, not a general graph; a force-directed blob looks like
  insight and answers nothing.
- **Editing routes, renewing certificates.** Reading these well is a
  feature; writing them is a different one with a different blast
  radius. An ACME rate limit is five failures per hour, and a button
  that burns them takes the cluster down at the worst moment.

## [2.1.0] - 2026-04-28

### Fixed — interactive auth (OIDC, kubelogin, exec plugins)

The "Authentication Required" modal could appear blank when a kubeconfig
context required interactive credentials. Three independent root causes
were closed end-to-end:

- **Race between backend I/O loop and frontend listener.** Terminal
  sessions used to start emitting bytes the moment the adapter
  connected — but the React `listen("terminal-output")` callback
  was still mid-`await`. Tauri events have no replay, so the first
  prompt landed in the void. Backend now blocks on a deferred-start
  oneshot gate; the frontend hook releases it via the new
  `terminal_subscribed` Tauri command only after both `listen()`
  calls have resolved. 60 s safety timeout if the frontend never
  signals.
- **`AuthExecAdapter` swallowed stdout.** Many OIDC tools
  (`kubelogin --grant-type=authcode-keyboard`, some
  `kubectl-oidc_login` variants) print the "open this URL" prompt
  to stdout. The adapter previously dropped stdout (only stderr
  reached the terminal). Now stdout is tee'd into both the JSON
  collector and the terminal stream.
- **Pipes instead of a real PTY.** Tools that call
  `term.ReadPassword` / `getpass` check `isatty(stdin)` and refuse
  to prompt without a TTY. Replaced pipes with a real PTY pair via
  `portable-pty 0.9` (cross-platform: ConPTY on Windows, openpty
  on Unix). `resize` now actually issues `TIOCSWINSZ`.

The same deferred-start handshake also applies to `PodTerminal`
via the shared `useGenericTerminalSession` hook.

### Fixed — log viewer

- **Same listener-race as terminal-auth** applied to
  `stream_pod_logs`. The streamer task now blocks on a
  `log_stream_subscribed` gate.
- **Stable React keys.** `LogViewer` keyed on filtered-array index,
  so changing the search query unmounted unrelated rows. Each log
  line now carries a synthetic monotonic id assigned at receive time.
- **RAII cleanup guard** for the spawned log-stream task. Panic in
  `streamer.stream_logs()` (or any other unwind path) used to leave
  a zombie entry in `state.log_streams`; the entry is now removed
  by a Drop guard on every exit.

### Fixed — port-forward

Same RAII cleanup guard pattern applied to the port-forward listener
spawn. A panic in `listener.accept()` no longer leaves orphaned
entries in `state.port_forward_sessions` /
`state.port_forward_controls`.

### Performance

- **K8s watch instead of 2-second polling.** A new `WatchManager`
  owns `kube::runtime::watcher` streams keyed by `(cluster, kind,
namespace)`. Events are forwarded to the frontend over a
  `resource-event` Tauri broadcast and applied to the TanStack
  Query cache via `setQueryData` — no refetch round-trip.
  **All 16 list pages migrated** (ConfigMap, Secret, Service,
  Endpoints, Ingress, PersistentVolumeClaim, Pod, Deployment,
  StatefulSet, DaemonSet, Job, CronJob, Node, PersistentVolume,
  StorageClass, CustomResource).
- **Watch failure detection + automatic polling fallback.** If the
  kubeconfig user lacks the `watch` verb (or kube-apiserver is
  unreachable), the backend emits a `Failed` event after three
  consecutive errors. The frontend toasts «Real-time updates
  unavailable: <kind>: falling back to periodic refresh» and
  re-enables the underlying `useQuery`'s `refetchInterval`. When
  the watcher recovers, the page auto-flips back to pure-watch
  mode.
- **Initial JS bundle 408 KB → 197 KB gzip (-52%).** CodeMirror
  (`YamlEditor`) and xterm (`Terminal`) are now lazy-loaded behind
  `React.lazy`; their chunks fetch only when a screen mounts them.
- **Log-stream events now batched** (50 ms tick or 100 lines,
  whichever first). Renamed Tauri event `log-line` → `log-batch`;
  payload carries `Vec<LogLineEvent>`. Verbose pods (100+ lines/sec)
  generate ~5× fewer Tauri round-trips.

### Security

- `AuthResult` no longer derives `Debug` — manual impl emits
  `<redacted>` for `token` and `refresh_token`. Defense-in-depth
  against future code that might log the struct.
- `K8sClientManager::load_kubeconfig_from_path` canonicalizes the
  path (resolves `~`, `..`, symlinks) before opening the file.
  Returns a clear `AuthError::Kubeconfig` on a missing target.
- New `.github/workflows/codeql.yml` runs CodeQL JavaScript /
  TypeScript analysis with `security-extended` queries on every
  push/PR plus a weekly Monday cron.

### Refactors / hygiene

- `WatchManager`, `LogStream`, `PortForwardSession` cleanup all
  follow the same RAII Drop-guard pattern. Adding a new long-lived
  background task is now a one-line `let _cleanup = …;` at the top
  of the spawn.
- `eslint` count: **59 → 0**. The pre-existing 59 warnings from
  the react-hooks 4 → 7 upgrade (set-state-in-effect,
  preserve-caught-error, only-export-components, etc.) are all
  closed: real refactors where derivable, documented disables with
  rationale where genuinely event-driven, mechanical
  `{ cause: err }` for caught-error preservation. Lefthook enforces
  zero-lint going forward.
- `tsconfig` target bumped ES2020 → ES2022 (needed for
  `Error(message, { cause })`). Vite's emit target is already
  safari15 / chrome110, so runtime support matches.
- Tests: 113 → 129 cargo (+16), 70 → 100 vitest (+30), including
  characterization tests for `AuthTerminal`, end-to-end handshake
  tests for every deferred-start gate, and cache-mutation tests
  for `useResourceWatch`.

### Adding a new K8s resource watch (5-step recipe for contributors)

1. Ensure `KindInfo` has `From<&K8sType>` (most do).
2. One `subscribe_namespaced!` or `subscribe_cluster!` macro line
   in `commands/watch.rs`.
3. One `commands::watch::subscribe_<kind>_watch` line in `main.rs`'s
   invoke handler.
4. One `subscribe<Kind>Watch(...)` binding in
   `src/generated/commands.ts`.
5. One `watch:` field on the page's `createResourceListPage` /
   `createWorkloadListPage` config (or call `useResourceWatch`
   directly for hand-rolled pages).

### Known issues (deferred to a future minor)

- Five long files (`InfrastructureBuilder.tsx` 1222 LOC, `Helm.tsx`
  1037, `InspectorPanel.tsx` 1015, `PodDetail.tsx` 833,
  `src-tauri/src/logs/mod.rs` 910) are still single-file monoliths.
  Each is its own focused refactor with TDD safety net.
- Pod / Node metrics still poll. Metrics k8s API has a different
  shape than the typed list APIs — separate migration.

## [2.0.1] - 2026-04-25

### Fixed

- `rules-of-hooks` violations in `StatefulSetDetail`, `DaemonSetDetail`,
  and `JobDetail`: a conditional early-return ran before `useMemo`,
  shifting hook order between renders. Hook now runs first.
- `NodeDetail` rebuilt the page icon component inside a JSX IIFE on every
  render. Hoisted to module scope.
- `InspectorPanel` form-init effect was flagged by the stricter
  `react-hooks/exhaustive-deps` after the React 19 / react-hooks 7
  upgrade. The narrow dep list (`[node?.id]`) is intentional —
  documented inline so future readers see the design.

### Security

- Replaced `"csp": null` in `tauri.conf.json` with a restrictive
  Content-Security-Policy. Limits what a malicious K8s server response
  could execute inside the WebView.

### CI / Tooling

- New `.github/workflows/ci.yml` — fast lint + test job on every
  push/PR (cargo fmt, cargo clippy informational, cargo test, tsc
  noEmit, npm run lint informational).
- `.npmrc` pins `include=optional` so platform-specific native
  bindings stay in `package-lock.json` regardless of where the
  lockfile was regenerated.
- Removed `Dockerfile.linux-build` (long-dead, replaced by GitHub
  Actions Linux build).
- Applied `cargo fmt` across `src-tauri/` (one-time cleanup on
  rust 1.95).

### Known issues (deferred to 2.1)

- `tokio::spawn` calls in `commands/logs.rs` and
  `commands/port_forward.rs` don't track JoinHandles — task panics
  leave entries in state maps. Architectural fix planned.
- `npm run lint` surfaces ~49 errors after the
  eslint-plugin-react-hooks 4 → 7 upgrade. Most are stylistic
  (set-state-in-effect, preserve-caught-error); none are runtime
  bugs. Triage planned.
- See `docs/superpowers/specs/2026-04-24-post-v2-audit-findings.md`
  for the full roadmap.

## [2.0.0] - 2026-04-24

### Added

- Initial open-source release under MIT license.

### Removed

- Proprietary licensing and premium feature gating.
