import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CustomResourceInfo, IngressInfo } from "@/generated/types";

const answers = vi.hoisted(() => ({
  crds: (): Promise<CustomResourceInfo[]> => Promise.resolve([]),
}));

vi.mock("@/lib/commands", () => ({
  commands: {
    listIngresses: () => Promise.resolve([shop]),
    listCustomResources: () => answers.crds(),
  },
}));

const { serviceRoutes } = await import("./service-routes");

const shop: IngressInfo = {
  name: "shop",
  namespace: "web",
  className: null,
  rules: [
    {
      host: "shop.example.com",
      paths: [
        {
          path: "/",
          pathType: "Prefix",
          backendService: "traefik",
          backendPort: "80",
          resourceBackend: null,
        },
      ],
    },
  ],
  loadBalancerIps: [],
  tlsHosts: [],
  tlsConfigs: [],
  hasCatchAllTls: false,
  defaultBackend: null,
  labels: {},
  annotations: {
    "kubernetes.io/ingress.class": "gce",
    "networking.gke.io/managed-certificates": "shop-cert",
  },
  createdAt: null,
};

const failing = (code: string, words: string) => () =>
  Promise.reject(
    new Error(`Tauri command 'listCustomResources' failed: ${words}`, {
      cause: { code, message: words },
    })
  );

const tlsOfShop = async () =>
  (await serviceRoutes({ namespace: "web", name: "traefik" }))[0]?.tls;

beforeEach(() => {
  answers.crds = () => Promise.resolve([]);
});

describe("whether GKE terminates TLS in front of a Service", () => {
  /**
   * With `managedcertificates` refused the certificate the Ingress names
   * could not be found, and the proxy behind it was told its host is served
   * in the clear.
   */
  it("does not settle it when the certificates could not be listed", async () => {
    answers.crds = failing(
      "PERMISSION_DENIED",
      "managedcertificates.networking.gke.io is forbidden"
    );

    expect(await tlsOfShop()).toBeNull();
  });

  /** A kind the API server does not serve holds no certificate at all. */
  it("says it does not when the kind is not served", async () => {
    answers.crds = failing("NOT_FOUND", "not found");

    expect(await tlsOfShop()).toBe(false);
  });
});
