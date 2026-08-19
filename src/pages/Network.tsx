import { Routes, Route } from "react-router-dom";
import { ResourceType, toPlural } from "@/lib/resource-registry";
import { ServiceList } from "@/components/resources/ServiceList";
import { IngressList } from "@/components/resources/IngressList";
import { EndpointsList } from "@/components/resources/EndpointsList";
import { GatewayList } from "@/components/resources/GatewayList";
import {
  GRPCRouteList,
  HTTPRouteList,
  TCPRouteList,
  TLSRouteList,
  UDPRouteList,
} from "@/components/resources/GatewayRouteList";

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
      <Route
        path={toPlural(ResourceType.HTTPRoute)}
        element={<HTTPRouteList />}
      />
      <Route
        path={toPlural(ResourceType.GRPCRoute)}
        element={<GRPCRouteList />}
      />
      <Route
        path={toPlural(ResourceType.TLSRoute)}
        element={<TLSRouteList />}
      />
      <Route
        path={toPlural(ResourceType.TCPRoute)}
        element={<TCPRouteList />}
      />
      <Route
        path={toPlural(ResourceType.UDPRoute)}
        element={<UDPRouteList />}
      />
      <Route index element={<ServiceList />} />
    </Routes>
  );
}
