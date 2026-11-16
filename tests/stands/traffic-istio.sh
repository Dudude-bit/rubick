#!/usr/bin/env bash
# A kind cluster for the Traffic page read through Istio's metrics:
# Istio (demo profile, an ingress gateway), bookinfo with sidecars, a load
# generator through the gateway, a namespace outside the mesh, and
# kube-prometheus-stack scraping the sidecars with Istio's own monitors.
#
#   RUBICK_KUBECONFIG=/path/to/sandbox/kubeconfig tests/stands/traffic-istio.sh
#
# RUBICK_RECREATE=1 deletes an existing cluster of the same name first.
# Pinned: kind's node image v1.37.0 (Istio 1.31 supports 1.32 to 1.37),
# Istio 1.31.4 (the newest patch of a minor three months old; 1.32.0 is days
# old), kube-prometheus-stack 92.22.0 (the last of 92.x; 93.0.0 is a major
# released a week ago), bookinfo and the monitors from Istio's own 1.31.4 tag.
set -euo pipefail

: "${RUBICK_KUBECONFIG:?set RUBICK_KUBECONFIG to the sandbox kubeconfig path}"
case "$(cd "$(dirname "$RUBICK_KUBECONFIG")" 2>/dev/null && pwd)/$(basename "$RUBICK_KUBECONFIG")" in
  "$HOME/.kube/config") echo "refusing to write $HOME/.kube/config" >&2; exit 1 ;;
esac

CLUSTER=rubick-gui
CONTEXT="kind-$CLUSTER"
NODE_IMAGE="kindest/node:v1.37.0@sha256:a1ed56cfb0e7b93589bdf97c8cd566405a265939e3620fc4f5de89adff580ae5"
ISTIO=1.31.4
ISTIO_CHARTS=https://blob.istio.io/istio-release/charts
ISTIO_RAW="https://raw.githubusercontent.com/istio/istio/$ISTIO"
KPS=92.22.0
KPS_CHARTS=https://prometheus-community.github.io/helm-charts

export KUBECONFIG="$RUBICK_KUBECONFIG"
# Helm's caches beside the kubeconfig, not in the home it belongs to.
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
nodes:
  - role: control-plane
  - role: worker
YAML
k wait --for=condition=Ready nodes --all --timeout=300s

echo "== kube-prometheus-stack $KPS (monitors in every namespace, no Grafana or Alertmanager)"
h upgrade --install kps kube-prometheus-stack --repo "$KPS_CHARTS" --version "$KPS" \
  --namespace monitoring --create-namespace --wait --timeout 10m \
  --set fullnameOverride=kps \
  --set grafana.enabled=false \
  --set alertmanager.enabled=false \
  --set prometheus.prometheusSpec.podMonitorSelectorNilUsesHelmValues=false \
  --set prometheus.prometheusSpec.serviceMonitorSelectorNilUsesHelmValues=false \
  --set prometheus.prometheusSpec.scrapeInterval=15s

echo "== Istio $ISTIO, demo profile"
h upgrade --install istio-base base --repo "$ISTIO_CHARTS" --version "$ISTIO" \
  --namespace istio-system --create-namespace --set defaultRevision=default --wait
h upgrade --install istiod istiod --repo "$ISTIO_CHARTS" --version "$ISTIO" \
  --namespace istio-system --set profile=demo --wait --timeout 10m
# The gateway chart maps 80 to 80; bookinfo's Gateway listens on 8080, as an
# istioctl install would map it.
h upgrade --install istio-ingressgateway gateway --repo "$ISTIO_CHARTS" --version "$ISTIO" \
  --namespace istio-system --wait --timeout 10m -f - <<'YAML'
service:
  type: ClusterIP
  ports:
    - { name: status-port, port: 15021, protocol: TCP, targetPort: 15021 }
    - { name: http2, port: 80, protocol: TCP, targetPort: 8080 }
YAML

echo "== Istio's own monitors for the sidecars and istiod"
k apply -f "$ISTIO_RAW/samples/addons/extras/prometheus-operator.yaml"

echo "== bookinfo, injected"
k create namespace bookinfo --dry-run=client -o yaml | k apply -f -
k label namespace bookinfo istio-injection=enabled --overwrite
k -n bookinfo apply -f "$ISTIO_RAW/samples/bookinfo/platform/kube/bookinfo.yaml"
k -n bookinfo apply -f "$ISTIO_RAW/samples/bookinfo/networking/bookinfo-gateway.yaml"

echo "== a load generator through the gateway, in the mesh"
k create namespace loadgen --dry-run=client -o yaml | k apply -f -
k label namespace loadgen istio-injection=enabled --overwrite
k -n loadgen apply -f - <<'YAML'
apiVersion: apps/v1
kind: Deployment
metadata: { name: loadgen, labels: { app: loadgen } }
spec:
  replicas: 1
  selector: { matchLabels: { app: loadgen } }
  template:
    metadata: { labels: { app: loadgen } }
    spec:
      containers:
        - name: loadgen
          image: curlimages/curl:8.11.1
          command: ["sh", "-c"]
          args:
            - |
              while true; do
                curl -s -o /dev/null http://istio-ingressgateway.istio-system/productpage
                curl -s -o /dev/null http://istio-ingressgateway.istio-system/productpage?u=normal
                sleep 0.5
              done
YAML

echo "== a namespace outside the mesh, for 'Not observed by Istio'"
k create namespace plain --dry-run=client -o yaml | k apply -f -
k -n plain apply -f - <<'YAML'
apiVersion: apps/v1
kind: Deployment
metadata: { name: outside, labels: { app: outside } }
spec:
  replicas: 1
  selector: { matchLabels: { app: outside } }
  template:
    metadata: { labels: { app: outside } }
    spec:
      containers:
        - { name: web, image: "nginx:1.27.3-alpine" }
YAML

for ns in bookinfo loadgen plain; do
  k -n "$ns" rollout status deploy --timeout=600s
done

PROM_SVC=$(k -n monitoring get svc -l app=kube-prometheus-stack-prometheus -o jsonpath='{.items[0].metadata.name}')
cat <<EOF

Ready. In Rubick, context $CONTEXT from $RUBICK_KUBECONFIG.
Prometheus: Settings > Integrations > Prometheus, either the in-cluster
service monitoring/$PROM_SVC:9090, or forward it and give http://localhost:19090:
  kubectl --kubeconfig "$RUBICK_KUBECONFIG" --context $CONTEXT -n monitoring port-forward svc/$PROM_SVC 19090:9090
Give it a minute for rate() to have two scrapes. Then:
  - Traffic: loadgen -> istio-ingressgateway -> productpage -> details, reviews; reviews -> ratings.
  - Deployment plain/outside: "Not observed by Istio".
  - 5xx: kubectl --kubeconfig "$RUBICK_KUBECONFIG" --context $CONTEXT -n bookinfo scale deploy ratings-v1 --replicas=0
EOF
