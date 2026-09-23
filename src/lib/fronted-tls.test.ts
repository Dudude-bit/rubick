import { describe, expect, it, vi } from "vitest";

import type { ServiceRoute } from "@/integrations";
import { settleFrontedRoutes } from "./fronted-tls";

const route = (tls: boolean | null): ServiceRoute => ({
  host: "shop.example.com",
  path: "/",
  tls,
  source: { kind: "IngressRoute", name: "shop", namespace: "web" },
  front: {
    ingresses: [],
    proxy: { namespace: "edge", name: "traefik" },
  },
});

describe("a route with a proxy in front, settled", () => {
  /**
   * GKE answers `tls: null` for the proxy's route while its certificate is
   * still provisioning, and the proxy's page reads "TLS not checked". Read
   * from the route alone, the Service page said `http://`. Fails if the
   * proxy's own routes are not asked.
   */
  it("could not say when the proxy's route in front could not tell", async () => {
    const [found] = await settleFrontedRoutes([route(false)], {
      ingressTls: [],
      serviceRoutes: [
        async (service) =>
          service.name === "traefik"
            ? [{ ...route(null), front: undefined }]
            : [],
      ],
    });
    expect(found.tls).toBeNull();
  });

  /** A route its own objects already serve over TLS needs nobody's word. */
  it("asks nobody about a route already served over TLS", async () => {
    const ask = vi.fn(async () => []);
    const [found] = await settleFrontedRoutes([route(true)], {
      ingressTls: [ask],
      serviceRoutes: [ask],
    });
    expect(found.tls).toBe(true);
    expect(ask).not.toHaveBeenCalled();
  });
});
