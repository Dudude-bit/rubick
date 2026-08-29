# Rubick Test Manifests

Fixtures that put one of everything Rubick can display into a cluster, so a
feature can be checked against a real object rather than a screenshot.

## Quick start

```bash
# Create everything
kubectl apply -f comprehensive-test.yaml

# Check it came up
kubectl get all -n k8s-gui-test

# Remove everything
kubectl delete -f comprehensive-test.yaml
kubectl delete pv k8s-gui-test-pv
```

## What it creates

### Namespace

- `k8s-gui-test` — everything below lives here, so cleanup is one delete

### Configuration

| Resource  | Name                    | What it exercises                          |
| --------- | ----------------------- | ------------------------------------------ |
| ConfigMap | `app-config`            | Plain key-value data                       |
| ConfigMap | `nginx-config`          | Multi-line values (nginx.conf, index.html) |
| Secret    | `app-secrets`           | An Opaque secret holding credentials       |
| Secret    | `docker-registry-creds` | kubernetes.io/dockerconfigjson             |
| Secret    | `tls-secret`            | kubernetes.io/tls                          |

### Storage

| Resource              | Name              | What it exercises |
| --------------------- | ----------------- | ----------------- |
| PersistentVolume      | `k8s-gui-test-pv` | hostPath PV (1Gi) |
| PersistentVolumeClaim | `data-pvc`        | A claim (500Mi)   |

### Workloads

| Resource    | Name            | Replicas | What it exercises                              |
| ----------- | --------------- | -------- | ---------------------------------------------- |
| Deployment  | `frontend`      | 2        | nginx with a ConfigMap volume                  |
| Deployment  | `backend`       | 3        | http-echo, env drawn from ConfigMap and Secret |
| Deployment  | `worker`        | 2        | busybox writing a steady log                   |
| StatefulSet | `redis`         | 3        | Ordered pods with volumeClaimTemplates         |
| DaemonSet   | `log-collector` | \*       | One pod per node                               |
| Job         | `db-migration`  | -        | Runs once and finishes                         |
| CronJob     | `backup-job`    | -        | Every five minutes                             |

### Standalone pods

| Name          | Containers                      | What it exercises                     |
| ------------- | ------------------------------- | ------------------------------------- |
| `debug-pod`   | main (nginx), sidecar (busybox) | Logs, exec and port-forward           |
| `failing-pod` | failing                         | Crashes every ten seconds, on purpose |
| `init-pod`    | init-wait, main                 | An init container                     |

### Network

| Resource  | Name                | Type                 | What it exercises                                |
| --------- | ------------------- | -------------------- | ------------------------------------------------ |
| Service   | `frontend`          | ClusterIP            | The ordinary case                                |
| Service   | `backend`           | ClusterIP            | The ordinary case                                |
| Service   | `frontend-nodeport` | NodePort             | Port 30080                                       |
| Service   | `backend-lb`        | LoadBalancer         | External access                                  |
| Service   | `redis-headless`    | ClusterIP (headless) | Backs the StatefulSet                            |
| Service   | `external-api`      | ExternalName         | api.example.com                                  |
| Service   | `external-db`       | ClusterIP            | Fronts hand-written endpoints                    |
| Ingress   | `main-ingress`      | -                    | With TLS, paths / and /api                       |
| Ingress   | `api-ingress`       | -                    | No TLS, with a path rewrite                      |
| Endpoints | `external-db`       | -                    | Written by hand rather than by the control plane |

## Draining a node

`drain-scene.yaml` and `drain-kind.yaml` are separate, because draining wants a
node it is allowed to empty and a second one to be the control plane.

```bash
kind create cluster --config test-manifests/drain-kind.yaml
kubectl apply -f test-manifests/drain-scene.yaml
K8S_GUI_DRAIN_CONTEXT=kind-rubick-drain \
  cargo test --test live_drain -- --ignored --nocapture
```

Every specimen is there for a rule that is otherwise unobservable:

|                        | why it is in the scene                                                                                                                       |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `held` ×2 + `held-pdb` | a budget with nothing spare — eviction is refused 429 forever                                                                                |
| `movable`              | no budget, so it has to actually leave                                                                                                       |
| `scratchy`             | an `emptyDir`, out of the set unless asked for                                                                                               |
| `lonely`               | no controller, out of the set unless asked for                                                                                               |
| `stubborn`             | tolerates the cordon, so its replacement lands back on the node — without it, "the drain does not chase its own replacements" cannot be seen |
| `slowpoke`             | ignores SIGTERM, so "accepted" and "gone" are 25s apart and a premature "drained" is measurable                                              |

`drained_means_the_pods_are_gone` drains the node completely, which `held-pdb`
would forbid forever — delete the budget first:

```bash
kubectl delete pdb held-pdb -n draintest
```

## What there is to check

### Lists

- [ ] Pods — several states at once (Running, CrashLoopBackOff, Init)
- [ ] Deployments — different replica counts
- [ ] StatefulSets — ordered pods (redis-0, redis-1, redis-2)
- [ ] DaemonSets — one pod per node
- [ ] Jobs — completed and running
- [ ] CronJobs — scheduled
- [ ] Services — every type (ClusterIP, NodePort, LoadBalancer, ExternalName, headless)
- [ ] Ingresses — with TLS and without
- [ ] ConfigMaps — plain and multi-line
- [ ] Secrets — every type (Opaque, dockerconfigjson, tls)
- [ ] PersistentVolumes — cluster-scoped
- [ ] PersistentVolumeClaims — bound and pending
- [ ] Endpoints — control-plane written and hand-written

### Detail pages

- [ ] Pod — containers, volumes, environment
- [ ] Deployment — replicas, strategy, conditions
- [ ] Service — endpoints, selector
- [ ] Ingress — rules, TLS, backends

### Actions

- [ ] **Logs** — `debug-pod` has two containers writing
- [ ] **Shell** — `debug-pod` (nginx and busybox)
- [ ] **Port forward** — `debug-pod:80`, `backend:8080`
- [ ] **Scale** — the `frontend` and `backend` deployments
- [ ] **Restart** — any deployment
- [ ] **Delete** — any object
- [ ] **View YAML** — every kind
- [ ] **Edit YAML** — ConfigMaps, Secrets, Deployments
- [ ] **Reveal values** — `app-secrets`
- [ ] **Copy keys** — Secrets

### Events

- [ ] Ordinary events — creation and scheduling
- [ ] Warning events — `failing-pod` crashing

### Filters

- [ ] Namespace — `k8s-gui-test`
- [ ] Label selector — `app=k8s-gui-test`
- [ ] Status — Running, Pending, Failed
- [ ] Service type — ClusterIP, NodePort, LoadBalancer
- [ ] Secret type — Opaque, tls, dockerconfigjson

---

## Helm

### Install some releases

```bash
# The script does all of the below
./helm-test.sh

# Or by hand:
helm repo add bitnami https://charts.bitnami.com/bitnami
helm repo update

helm install redis-test bitnami/redis -n helm-test --create-namespace \
    --set architecture=standalone --set auth.enabled=false \
    --set master.persistence.enabled=false

helm install nginx-test bitnami/nginx -n helm-test \
    --set replicaCount=2 --set service.type=ClusterIP
```

### In Rubick

Open **Helm** in the sidebar and check:

- [ ] The release list, filtered by namespace
- [ ] Statuses (deployed, pending-install, failed)
- [ ] A release's own page
- [ ] Revision history
- [ ] Rollback, once there is more than one revision
- [ ] Uninstall, with its confirmation

### Clean up

```bash
helm uninstall redis-test nginx-test -n helm-test
kubectl delete namespace helm-test
```

---

## Custom resources (Traefik, Istio, cert-manager)

### Install the definitions

```bash
# The CRDs alone — no controllers, so nothing acts on these objects
kubectl apply -f crds-traefik-istio.yaml
```

### Create some objects

```bash
kubectl apply -f crd-resources-test.yaml
```

### What that creates

| CRD group               | Resources                                              |
| ----------------------- | ------------------------------------------------------ |
| **traefik.io**          | IngressRoute, Middleware, TraefikService               |
| **networking.istio.io** | VirtualService, DestinationRule, Gateway, ServiceEntry |
| **cert-manager.io**     | Certificate, ClusterIssuer                             |

Nothing reconciles them, so every `status` is whatever the manifest says —
enough to check how the app renders them, not enough to judge behaviour.

### In Rubick

Open **CRDs** and check:

- [ ] Every CRD in the cluster is listed
- [ ] Filtering by group (traefik.io, networking.istio.io)
- [ ] The objects inside a CRD
- [ ] An object's own page (YAML, metadata)

### Clean up

```bash
kubectl delete -f crd-resources-test.yaml
kubectl delete -f crds-traefik-istio.yaml
```

---

## Loki (the `logs.history` capability)

`loki-stack.yaml` brings up Loki (single binary, filesystem, 72h retention) and
Promtail beside the demo Prometheus in the `monitoring` namespace. This is what
the log viewer reads once a pod is gone: `--previous` gives exactly one earlier
run, and only while the pod object still exists.

```bash
# Before installing: Promtail opens an inotify instance per directory
sudo sysctl -w fs.inotify.max_user_instances=1024

kubectl apply -f loki-stack.yaml
kubectl -n monitoring rollout status deploy/loki

# The address for Settings -> Integrations -> Loki -> Connect
echo "http://$(kubectl get node -o jsonpath='{.items[0].status.addresses[0].address}'):30310"

kubectl delete -f loki-stack.yaml   # remove it
```

The app queries on the `namespace` and `pod` labels (see
`src/integrations/loki/queries.ts`). If your Promtail or Alloy renames them,
the viewer says which labels it tried rather than showing an empty panel.

---

## Troubleshooting

### The StatefulSet stays pending

Usually there is no default StorageClass:

```bash
kubectl get sc
# If that is empty, make a local one:
kubectl apply -f - <<EOF
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: standard
provisioner: kubernetes.io/no-provisioner
volumeBindingMode: WaitForFirstConsumer
EOF
```

### The LoadBalancer stays pending

Expected on a local cluster (minikube, kind, k3d) — nothing is there to assign
an address. For minikube, `minikube tunnel` provides one.

### The Ingress does nothing

Check that a controller is installed:

```bash
# minikube
minikube addons enable ingress

# kind
kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/main/deploy/static/provider/kind/deploy.yaml
```

k3d ships Traefik as its controller, so nothing extra is needed there.

### Helm releases do not appear

1. Check the Helm CLI is on PATH: `helm version`
2. Check the release secrets exist: `kubectl get secrets -l owner=helm --all-namespaces`
3. If the secrets are there and the releases are not, the app's log will say why

### CRDs do not appear

1. Check they were created: `kubectl get crds`
2. Check your context is allowed to list them
