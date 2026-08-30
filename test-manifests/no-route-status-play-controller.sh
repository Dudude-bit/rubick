#!/usr/bin/env bash
# Plays the controller for test-manifests/no-route-status.yaml: claims the
# class, programs the Gateway *without* an address, and deliberately writes
# nothing about the route. That last silence is the whole specimen.
set -euo pipefail

CTX="${K8S_GUI_SHAPE_CONTEXT:-kind-rubick-gw}"
NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

kubectl --context "$CTX" patch gatewayclass netbird-private --subresource=status --type=merge -p \
  "{\"status\":{\"conditions\":[{\"type\":\"Accepted\",\"status\":\"True\",\"reason\":\"Accepted\",\"lastTransitionTime\":\"$NOW\",\"observedGeneration\":1,\"message\":\"claimed\"}]}}"

kubectl --context "$CTX" patch gateway private -n netbird --subresource=status --type=merge -p \
  "{\"status\":{\"conditions\":[{\"type\":\"Accepted\",\"status\":\"True\",\"reason\":\"Accepted\",\"lastTransitionTime\":\"$NOW\",\"observedGeneration\":1,\"message\":\"ok\"},{\"type\":\"Programmed\",\"status\":\"True\",\"reason\":\"Programmed\",\"lastTransitionTime\":\"$NOW\",\"observedGeneration\":1,\"message\":\"programmed\"}],\"listeners\":[{\"name\":\"tcp\",\"attachedRoutes\":1,\"supportedKinds\":[{\"group\":\"gateway.networking.k8s.io\",\"kind\":\"TCPRoute\"}],\"conditions\":[{\"type\":\"Accepted\",\"status\":\"True\",\"reason\":\"Accepted\",\"lastTransitionTime\":\"$NOW\",\"message\":\"ok\"},{\"type\":\"Programmed\",\"status\":\"True\",\"reason\":\"Programmed\",\"lastTransitionTime\":\"$NOW\",\"message\":\"ok\"},{\"type\":\"ResolvedRefs\",\"status\":\"True\",\"reason\":\"ResolvedRefs\",\"lastTransitionTime\":\"$NOW\",\"message\":\"ok\"}]}]}}"

echo "class claimed, gateway programmed with no address, route left unanswered"
