#!/usr/bin/env bash
# A kind cluster for the Traffic page read through Cilium's Hubble, in both
# ways the page reads it: Hubble's metrics in kube-prometheus-stack (with the
# source and destination labels the page asks for) and Hubble Relay live.
# A namespace `shop` holds a caller, two servers, an HTTP rule that gives
# Hubble L7 visibility and denies a PUT, a deny NetworkPolicy and a pod that
# trips it, and a gRPC server whose every call fails inside an HTTP 200.
#
#   RUBICK_KUBECONFIG=/path/to/sandbox/kubeconfig tests/stands/traffic-cilium.sh
#
# RUBICK_RECREATE=1 deletes an existing cluster of the same name first.
# RUBICK_RELAY_TLS=1 has the relay serve TLS (no client certificates), and
# RUBICK_RELAY_TLS=mtls asks clients for one.
# Pinned: kind's node image v1.36.4 (Cilium 1.20 is tested on 1.33 to 1.36,
# not on kind's default 1.37), Cilium 1.20.4 (the newest; the app's Hubble
# protos are vendored from the same tag), kube-prometheus-stack 92.22.0 (the
# last of 92.x; 93.0.0 is a major released a week ago).
set -euo pipefail

: "${RUBICK_KUBECONFIG:?set RUBICK_KUBECONFIG to the sandbox kubeconfig path}"
case "$(cd "$(dirname "$RUBICK_KUBECONFIG")" 2>/dev/null && pwd)/$(basename "$RUBICK_KUBECONFIG")" in
  "$HOME/.kube/config") echo "refusing to write $HOME/.kube/config" >&2; exit 1 ;;
esac

CLUSTER=rubick-gui
CONTEXT="kind-$CLUSTER"
NODE_IMAGE="kindest/node:v1.36.4@sha256:099e049362a1526b2db71494e1947aae99bd16290d7c895f2b7ea312e3cbfaed"
CILIUM=1.20.4
CILIUM_CHARTS=https://helm.cilium.io
KPS=92.22.0
KPS_CHARTS=https://prometheus-community.github.io/helm-charts
LABELS="source_namespace,source_workload,source_workload_kind,destination_namespace,destination_workload,destination_workload_kind,traffic_direction"

export KUBECONFIG="$RUBICK_KUBECONFIG"
STAND="$(dirname "$RUBICK_KUBECONFIG")/.rubick-stand"
export HELM_CONFIG_HOME="$STAND/helm/config" HELM_CACHE_HOME="$STAND/helm/cache" HELM_DATA_HOME="$STAND/helm/data"
mkdir -p "$HELM_CONFIG_HOME" "$HELM_CACHE_HOME" "$HELM_DATA_HOME"
k() { kubectl --context "$CONTEXT" "$@"; }
h() { helm --kube-context "$CONTEXT" "$@"; }

if kind get clusters | grep -qx "$CLUSTER"; then
  if [ "${RUBICK_RECREATE:-}" = 1 ]; then
    kind delete cluster --name "$CLUSTER" --kubeconfig "$RUBICK_KUBECONFIG"
  else
    echo "cluster $CLUSTER exists; RUBICK_RECREATE=1 to replace it" >&2
    exit 1
  fi
fi

kind create cluster --name "$CLUSTER" --kubeconfig "$RUBICK_KUBECONFIG" --image "$NODE_IMAGE" --config - <<'YAML'
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
networking:
  disableDefaultCNI: true
nodes:
  - role: control-plane
  - role: worker
YAML

case "${RUBICK_RELAY_TLS:-}" in
  "") RELAY_TLS=false; RELAY_MTLS=false ;;
  1) RELAY_TLS=true; RELAY_MTLS=false ;;
  mtls) RELAY_TLS=true; RELAY_MTLS=true ;;
  *) echo "RUBICK_RELAY_TLS is empty, 1 or mtls" >&2; exit 1 ;;
esac

VALUES="$STAND/cilium-values.yaml"
cat > "$VALUES" <<YAML
image: { pullPolicy: IfNotPresent }
ipam: { mode: kubernetes }
hubble:
  enabled: true
  tls:
    enabled: true
    auto: { enabled: true, method: helm }
  relay:
    enabled: true
    tls:
      server: { enabled: $RELAY_TLS, mtls: $RELAY_MTLS }
  metrics:
    enabled:
      - dns
      - tcp
      - "flow:labelsContext=$LABELS"
      - "drop:labelsContext=$LABELS"
      - "httpV2:labelsContext=$LABELS"
YAML

echo "== Cilium $CILIUM with Hubble, its relay (tls=$RELAY_TLS, mtls=$RELAY_MTLS) and its metrics"
h upgrade --install cilium cilium --repo "$CILIUM_CHARTS" --version "$CILIUM" \
  --namespace kube-system -f "$VALUES" --wait --timeout 10m
k wait --for=condition=Ready nodes --all --timeout=300s
k -n kube-system rollout status deploy/hubble-relay --timeout=300s

echo "== kube-prometheus-stack $KPS (monitors in every namespace, no Grafana or Alertmanager)"
h upgrade --install kps kube-prometheus-stack --repo "$KPS_CHARTS" --version "$KPS" \
  --namespace monitoring --create-namespace --wait --timeout 10m \
  --set fullnameOverride=kps \
  --set grafana.enabled=false \
  --set alertmanager.enabled=false \
  --set prometheus.prometheusSpec.podMonitorSelectorNilUsesHelmValues=false \
  --set prometheus.prometheusSpec.serviceMonitorSelectorNilUsesHelmValues=false \
  --set prometheus.prometheusSpec.scrapeInterval=15s

echo "== Hubble's metrics scraped, now that the ServiceMonitor kind exists"
h upgrade cilium cilium --repo "$CILIUM_CHARTS" --version "$CILIUM" \
  --namespace kube-system -f "$VALUES" \
  --set hubble.metrics.serviceMonitor.enabled=true --wait --timeout 10m

echo "== shop: a caller, two servers, an L7 rule, a deny policy and a pod that trips it"
k create namespace shop --dry-run=client -o yaml | k apply -f -
k -n shop apply -f - <<'YAML'
apiVersion: apps/v1
kind: Deployment
metadata: { name: web, labels: { app: web } }
spec:
  replicas: 2
  selector: { matchLabels: { app: web } }
  template:
    metadata: { labels: { app: web } }
    spec:
      containers: [{ name: web, image: "nginx:1.27.3-alpine", ports: [{ containerPort: 80 }] }]
---
apiVersion: v1
kind: Service
metadata: { name: web }
spec: { selector: { app: web }, ports: [{ port: 80 }] }
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: db, labels: { app: db } }
spec:
  replicas: 1
  selector: { matchLabels: { app: db } }
  template:
    metadata: { labels: { app: db } }
    spec:
      containers: [{ name: db, image: "nginx:1.27.3-alpine", ports: [{ containerPort: 80 }] }]
---
apiVersion: v1
kind: Service
metadata: { name: db }
spec: { selector: { app: db }, ports: [{ port: 80 }] }
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: caller, labels: { app: caller } }
spec:
  replicas: 1
  selector: { matchLabels: { app: caller } }
  template:
    metadata: { labels: { app: caller } }
    spec:
      containers:
        - name: caller
          image: curlimages/curl:8.11.1
          command: ["sh", "-c"]
          args:
            - |
              while true; do
                curl -s -o /dev/null http://web/
                curl -s -o /dev/null http://web/missing
                curl -s -o /dev/null -X PUT http://web/
                curl -s -o /dev/null --max-time 2 http://db/
                sleep 0.5
              done
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: intruder, labels: { app: intruder } }
spec:
  replicas: 1
  selector: { matchLabels: { app: intruder } }
  template:
    metadata: { labels: { app: intruder } }
    spec:
      containers:
        - name: intruder
          image: curlimages/curl:8.11.1
          command: ["sh", "-c"]
          args:
            - |
              while true; do
                curl -s -o /dev/null --max-time 2 http://db/
                sleep 1
              done
---
# db takes traffic from caller and nothing else: intruder's is dropped.
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: { name: db-from-caller-only }
spec:
  podSelector: { matchLabels: { app: db } }
  policyTypes: [Ingress]
  ingress:
    - from: [{ podSelector: { matchLabels: { app: caller } } }]
      ports: [{ port: 80, protocol: TCP }]
---
# An HTTP rule on web: Hubble sees HTTP, for requests, status and latency.
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata: { name: web-http-visible }
spec:
  endpointSelector: { matchLabels: { app: web } }
  ingress:
    - fromEndpoints: [{}]
      toPorts:
        - ports: [{ port: "80", protocol: TCP }]
          rules: { http: [{ method: GET }] }
---
# A gRPC server, and a caller of a method it does not have: each call is
# answered HTTP 200 with grpc-status 12 (UNIMPLEMENTED) in its trailers.
apiVersion: apps/v1
kind: Deployment
metadata: { name: etcd, labels: { app: etcd } }
spec:
  replicas: 1
  selector: { matchLabels: { app: etcd } }
  template:
    metadata: { labels: { app: etcd } }
    spec:
      containers:
        - name: etcd
          image: registry.k8s.io/etcd:3.6.6-0
          command:
            - etcd
            - --data-dir=/var/lib/etcd
            - --listen-client-urls=http://0.0.0.0:2379
            - --advertise-client-urls=http://etcd:2379
          ports: [{ containerPort: 2379 }]
          volumeMounts: [{ name: data, mountPath: /var/lib/etcd }]
      volumes: [{ name: data, emptyDir: {} }]
---
apiVersion: v1
kind: Service
metadata: { name: etcd }
spec: { selector: { app: etcd }, ports: [{ port: 2379 }] }
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: grpc-caller, labels: { app: grpc-caller } }
spec:
  replicas: 1
  selector: { matchLabels: { app: grpc-caller } }
  template:
    metadata: { labels: { app: grpc-caller } }
    spec:
      containers:
        - name: grpc-caller
          image: curlimages/curl:8.11.1
          command: ["sh", "-c"]
          args:
            - |
              printf '\000\000\000\000\000' > /tmp/frame
              while true; do
                curl -s -o /dev/null --http2-prior-knowledge -X POST \
                  -H 'content-type: application/grpc' -H 'te: trailers' \
                  --data-binary @/tmp/frame http://etcd:2379/etcdserverpb.KV/NoSuchMethod
                sleep 0.5
              done
---
# An HTTP rule on etcd's port: Hubble sees the gRPC calls as HTTP/2.
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata: { name: etcd-http-visible }
spec:
  endpointSelector: { matchLabels: { app: etcd } }
  ingress:
    - fromEndpoints: [{}]
      toPorts:
        - ports: [{ port: "2379", protocol: TCP }]
          rules: { http: [{}] }
YAML
k -n shop rollout status deploy --timeout=600s

PROM_SVC=$(k -n monitoring get svc -l app=kube-prometheus-stack-prometheus -o jsonpath='{.items[0].metadata.name}')
cat <<EOF

Ready. In Rubick, context $CONTEXT from $RUBICK_KUBECONFIG.
Live: Traffic > Live reads Hubble Relay kube-system/hubble-relay (tls=$RELAY_TLS, mtls=$RELAY_MTLS).
Window: Settings > Integrations > Prometheus, the in-cluster service
monitoring/$PROM_SVC:9090, or forward it and give http://localhost:19090:
  kubectl --kubeconfig "$RUBICK_KUBECONFIG" --context $CONTEXT -n monitoring port-forward svc/$PROM_SVC 19090:9090
Then, in shop:
  - caller -> web with requests/s, 404s (not errors) and p95 (L7 through the HTTP rule);
  - caller -> db forwarded; intruder -> db dropped: POLICY_DENIED, one drop per packet (not two). Hubble names no
    policy for it (the intruder falls to the default deny of a policy that admits only caller), so the panel
    gives the app's own reading: "db is selected by NetworkPolicy shop/db-from-caller-only; none of its rules
    admits intruder.";
  - Live, caller -> web: a warn edge, the panel saying "HTTP requests an L7 rule denied" (the PUT);
  - grpc-caller -> etcd: every call fails, yet answers HTTP/2 200: errors "≥0%", a grey edge, never
    green, and Hubble's panel line says a failed gRPC call is not counted.
EOF
