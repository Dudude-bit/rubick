import { Routes, Route, Navigate } from "react-router-dom";
import { ResourceType, toPlural } from "@/lib/resource-registry";
import { ServiceList } from "@/components/resources/ServiceList";
import { IngressList } from "@/components/resources/IngressList";
import { EndpointsList } from "@/components/resources/EndpointsList";
import { GatewayList } from "@/components/resources/GatewayList";
import { GatewayRoutesList } from "@/components/resources/GatewayRoutesList";
import { GATEWAY_ROUTE_KINDS } from "@/hooks/useGatewayRoutes";

export function Network() {
  return (
    <Routes>
      <Route path={toPlural(ResourceType.Service)} element={<ServiceList />} />
      <Route path={toPlural(ResourceType.Ingress)} element={<IngressList />} />
      <Route path="endpoints" element={<EndpointsList />} />
      {/* Registered whether or not the cluster serves the kinds: the rows in
          the sidebar are gated on detection, but a pasted or stale URL still
          deserves the page's own honest empty state over a 404. */}
      <Route path={toPlural(ResourceType.Gateway)} element={<GatewayList />} />
      {/* One table for the five kinds — the reader's question is "what
          routes into this cluster", not "which kind am I in". Depth lives on
          the row's detail page, where the trace is. /routes/all survives as
          a redirect for links minted while it was a separate page. */}
      <Route path="routes" element={<GatewayRoutesList />} />
      <Route
        path="routes/all"
        element={<Navigate to="/network/routes" replace />}
      />
      {GATEWAY_ROUTE_KINDS.map((kind) => (
        <Route
          key={kind}
          path={toPlural(kind)}
          element={<Navigate to="/network/routes" replace />}
        />
      ))}
      <Route index element={<ServiceList />} />
    </Routes>
  );
}
