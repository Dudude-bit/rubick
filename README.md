# K8s GUI

[![CI](https://github.com/Dudude-bit/k8s-gui/actions/workflows/ci.yml/badge.svg)](https://github.com/Dudude-bit/k8s-gui/actions/workflows/ci.yml)
[![Build Artifacts](https://github.com/Dudude-bit/k8s-gui/actions/workflows/build.yml/badge.svg)](https://github.com/Dudude-bit/k8s-gui/actions/workflows/build.yml)
[![License: MIT](https://img.shields.io/github/license/Dudude-bit/k8s-gui)](LICENSE)
[![Latest release](https://img.shields.io/github/v/release/Dudude-bit/k8s-gui)](https://github.com/Dudude-bit/k8s-gui/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/Dudude-bit/k8s-gui/total)](https://github.com/Dudude-bit/k8s-gui/releases)

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
- Node.js 24 LTS (or newer)
- Bun 1.3+ (<https://bun.sh> — the package manager for this repo)
- Tauri platform dependencies: <https://v2.tauri.app/start/prerequisites/>

### Setup

```bash
git clone https://github.com/Dudude-bit/k8s-gui.git
cd k8s-gui
bun install
bun run tauri dev
```

### Build

```bash
bun run tauri build
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
