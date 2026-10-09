#!/usr/bin/env bash
set -euo pipefail
CTX="${K8S_GUI_SHAPE_CONTEXT:-kind-rubick-ls}"
NOW="2026-08-30T00:00:00Z"
C='{"type":"%s","status":"%s","reason":"%s","lastTransitionTime":"'"$NOW"'","observedGeneration":1,"message":"ok"}'

kubectl --context "$CTX" patch gatewayclass envoy --subresource=status --type=merge \
  -p "{\"status\":{\"conditions\":[$(printf "$C" Accepted True Accepted)]}}"

# The Gateway carries its own http listener AND the set's https one, which is
# what a controller does when it merges a ListenerSet in.
kubectl --context "$CTX" patch gateway shared -n edge --subresource=status --type=merge -p "{\"status\":{
  \"conditions\":[$(printf "$C" Accepted True Accepted),$(printf "$C" Programmed True Programmed)],
  \"addresses\":[{\"type\":\"IPAddress\",\"value\":\"203.0.113.9\"}],
  \"listeners\":[
    {\"name\":\"http\",\"attachedRoutes\":0,\"supportedKinds\":[{\"group\":\"gateway.networking.k8s.io\",\"kind\":\"HTTPRoute\"}],\"conditions\":[$(printf "$C" Accepted True Accepted),$(printf "$C" Programmed True Programmed),$(printf "$C" ResolvedRefs True ResolvedRefs)]}
  ]}}"

kubectl --context "$CTX" patch listenerset app-tls -n apps --subresource=status --type=merge -p "{\"status\":{
  \"conditions\":[$(printf "$C" Accepted True Accepted),$(printf "$C" Programmed True Programmed)],
  \"listeners\":[
    {\"name\":\"https\",\"port\":443,\"protocol\":\"HTTPS\",\"attachedRoutes\":1,\"supportedKinds\":[{\"group\":\"gateway.networking.k8s.io\",\"kind\":\"HTTPRoute\"}],\"conditions\":[$(printf "$C" Accepted True Accepted),$(printf "$C" Programmed True Programmed),$(printf "$C" ResolvedRefs True ResolvedRefs)]}
  ]}}"

# The route's verdict is written against the ListenerSet, not the Gateway.
kubectl --context "$CTX" patch httproute app -n apps --subresource=status --type=merge -p "{\"status\":{\"parents\":[
  {\"controllerName\":\"gateway.envoyproxy.io/gatewayclass-controller\",
   \"parentRef\":{\"kind\":\"ListenerSet\",\"group\":\"gateway.networking.k8s.io\",\"name\":\"app-tls\"},
   \"conditions\":[$(printf "$C" Accepted True Accepted),$(printf "$C" ResolvedRefs True ResolvedRefs)]}
]}}"
echo "controller played: class accepted, gateway programmed, set accepted, route answered against the set"
