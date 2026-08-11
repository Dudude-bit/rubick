# Rubick

[![CI](https://github.com/Dudude-bit/rubick/actions/workflows/ci.yml/badge.svg)](https://github.com/Dudude-bit/rubick/actions/workflows/ci.yml)
[![Build Artifacts](https://github.com/Dudude-bit/rubick/actions/workflows/build.yml/badge.svg)](https://github.com/Dudude-bit/rubick/actions/workflows/build.yml)
[![License: MIT](https://img.shields.io/github/license/Dudude-bit/rubick)](LICENSE)
[![Latest release](https://img.shields.io/github/v/release/Dudude-bit/rubick)](https://github.com/Dudude-bit/rubick/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/Dudude-bit/rubick/total)](https://github.com/Dudude-bit/rubick/releases)

A desktop Kubernetes client that tries not to lie to you.

Most cluster UIs answer _what is the API server storing_. Rubick tries to answer _what is actually happening, and what will happen if you touch this_ — and where it cannot answer, it says so instead of guessing.

![Rubick on a workload page](docs/images/hero-workload-detail.png)

## The idea

One rule shaped nearly every screen: **never claim what cannot be backed.**

It sounds abstract until you see what it costs a tool to break it. A pod whose container is crash-looping reports `Running` in most tools, because that is what `.status.phase` says — so Rubick ports kubectl's own display logic and shows the truth. A Service with healthy pods and a mismatched port name publishes no endpoints at all, and every dashboard draws it green — so Rubick reads the EndpointSlices the cluster actually publishes rather than deducing from labels. An integration that has not been asked about something says _not looked at_ rather than leaving an empty space that reads as _nothing there_.

## What it does

### Sees what is really wrong

- Pod status derived the way `kubectl get pod` derives it, including init containers, sidecars and termination signals
- Init containers as an ordered sequence — a container that failed and one that never got a turn are different things
- Logs open **where the answer is**: on a pod stuck in init, on the failing container, on the run that failed
- Conditions coloured by meaning, not by the word `True` — `MemoryPressure=True` is a fault, `DisruptionAllowed=False` is a budget doing its job
- Certificate expiry wherever TLS is named, and the four-object cert-manager chain walked down to the sentence that says what failed

![A path that stops, and why](docs/images/traffic-chain-stops.png)

### Shows how things connect

- **How traffic gets here** — the path from Ingress through Service to the pods actually serving, on the workload's own page
- **Where the path stops**, named: a backend that does not exist, a selector matching nothing, pods running but not ready, or a Service publishing nothing at all
- A Connections tab grouped by the question you are asking — what it needs to run, what it runs on, what made it — not by resource kind
- What governs it: autoscalers, disruption budgets, and which GitOps controller delivers it

![The Connections tab, grouped by question](docs/images/connections-tab.png)

![Logs open on the container that failed](docs/images/logs-failing-init-container.png)

### Tells you before you act

- Scale, Restart, Delete and Edit YAML say **who will undo this and how fast** — an autoscaler in about fifteen seconds, Argo CD or Flux in about three minutes, both if both apply
- It tells rather than blocks: scaling a managed workload by hand during an incident is legitimate, and the app has no business refusing
- Draining a node names every disruption budget that will make the drain wait

![Scaling something an autoscaler owns](docs/images/scale-interception.png)

### Integrates without pretending

Integrations come in three tiers with different obligations. In-cluster extensions are **detected** — their CRDs exist or they do not. External services are **configured** — you give them an address, and nothing is ever sniffed or guessed.

|                  |                                                                                                                                                                                                                                                                         |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Routing**      | Traefik, ingress-nginx and Istio read as routing: hosts, rules, middleware chains and where each host actually lands. nginx annotations are decoded into sentences with the raw key beside each — and a `configuration-snippet` is shown verbatim and never paraphrased |
| **Certificates** | cert-manager: expiry, issuers, and the issuance chain when renewal fails                                                                                                                                                                                                |
| **Delivery**     | Argo CD and Flux, kept as the different shapes they are. Every object says whether it is delivered, from which revision, and whether your edit will survive                                                                                                             |
| **Metrics**      | Prometheus for real history — ranges, disk fullness and network traffic that `metrics.k8s.io` cannot answer at all                                                                                                                                                      |
| **Logs**         | Loki, so a crashed pod's logs outlive the pod                                                                                                                                                                                                                           |
| **Clouds**       | GKE, EKS and AKS node pools, machine types, zones and spot status read from labels with no cloud account; their controllers' CRDs read as the configuration they are                                                                                                    |

Adding one costs a folder and a line.

![Integrations, with what each is doing](docs/images/integrations-settings.png)

### Everyday things, done properly

- Every name you can go to is a link, and every link takes the same gestures: click to peek, middle-click for a background tab, shift for a foreground one
- Names inside event and condition prose are links too — but only when the controller stated the kind, never guessed from shape
- Tabs are route **and** scope, so several clusters and namespaces stay open side by side
- Search across clusters, with `!cluster-name` to aim it

![Search, from anywhere](docs/images/command-palette.png)

- A peek panel that answers without leaving the page, and expands to the full page when the answer is longer
- Per-pod shell as a real tab whose session survives you looking elsewhere
- Logs virtualised, with density, repeat collapsing, multi-container interleave and server-side filtering
- Identity colouring that survives greyscale and colour blindness, and can be turned down or off
- Light and dark, following the system or pinned

![The same page in the light theme](docs/images/light-theme.png)

![Usage with real history](docs/images/usage-history.png)

### Careful with your cluster and your laptop

Polling was measured and cut by **77%** — from ~895 to ~205 API requests per minute for an idle window. Queries stop when nothing is looking at them, slow down when nothing is changing, and resume the instant you come back. A query that has backed off says `slowed` rather than claiming to be live, because a stale number under a live badge is exactly the kind of lie this project exists to avoid.

## Install

Download the latest build for your platform from [Releases](https://github.com/Dudude-bit/rubick/releases/latest). macOS (Intel and Apple Silicon), Windows and Linux are built on every release.

Rubick reads your existing kubeconfig. Cloud authentication (EKS, GKE, AKS, OIDC, exec plugins) works through the same credentials `kubectl` uses; the Clusters section of Settings shows each context, how it authenticates, and anything missing.

## Development

### Prerequisites

- [Bun](https://bun.sh) 1.2+
- Rust 1.91+ and the [Tauri prerequisites](https://tauri.app/start/prerequisites/) for your platform

### Setup

```bash
bun install
bun run tauri dev
```

### Checks

Everything below must pass before a push; the git hooks run them for you.

```bash
bunx tsc --noEmit                                    # types
bun run lint                                         # eslint, zero warnings
bun run test                                         # frontend tests
cargo test --manifest-path src-tauri/Cargo.toml --lib # Rust tests
```

Three lint rules exist to stop the codebase drifting back, and each will fail your commit:

- raw colours, `dark:` and legacy design tokens are banned across `src/` — the app draws only in role tokens
- nothing outside `src/integrations/` may import a vendor folder by name — surfaces ask for a capability, never for a vendor
- `refetchInterval` may only be written inside `useLiveQuery` — polling rates are named, not typed by hand

### Build

```bash
bun run tauri build
```

## Tech

Tauri 2 and Rust on the back, React 19 and TypeScript on the front, TanStack Query for data, CodeMirror for YAML, xterm.js for terminals, Recharts for usage. Cluster access is [kube-rs](https://kube.rs).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) — it covers the checks, the lint rules above, and what it takes to add an integration.

## License

MIT — see [LICENSE](LICENSE).
