import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import type {
  CustomResourceInfo,
  IngressInfo,
  ServiceInfo,
} from "@/generated/types";

const answers = vi.hoisted(() => ({
  crds: (): Promise<CustomResourceInfo[]> => Promise.resolve([]),
}));

vi.mock("@/lib/commands", () => ({
  commands: {
    listIngresses: () => Promise.resolve([shop]),
    listCustomResources: () => answers.crds(),
    listServiceBacking: () =>
      Promise.resolve({ services: [storefront], published: [] }),
  },
}));

const { default: GkeIngressPage } = await import("./page");

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
          backendService: "storefront",
          backendPort: "80",
          resourceBackend: null,
        },
      ],
    },
  ],
  loadBalancerIps: ["34.1.2.3"],
  tlsHosts: [],
  tlsConfigs: [],
  hasCatchAllTls: false,
  defaultBackend: null,
  labels: {},
  annotations: {
    "kubernetes.io/ingress.class": "gce",
    "networking.gke.io/v1beta1.FrontendConfig": "shop-fc",
    "networking.gke.io/managed-certificates": "shop-cert",
  },
  createdAt: null,
};

const storefront = {
  name: "storefront",
  namespace: "web",
  uid: "svc",
  type: "ClusterIP",
  selector: { app: "storefront" },
  annotations: { "cloud.google.com/backend-config": '{"default":"shop-bc"}' },
  labels: {},
  ports: [],
  clusterIp: "10.0.0.1",
  externalIps: [],
  createdAt: null,
} as unknown as ServiceInfo;

const failing = (code: string, words: string) => () =>
  Promise.reject(
    new Error(`Tauri command 'listCustomResources' failed: ${words}`, {
      cause: { code, message: words },
    })
  );

async function openShop() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
  render(<GkeIngressPage />, { wrapper });
  const row = await screen.findByRole("button", {
    name: "shop.example.com — expand",
  });
  // A broken row opens itself; a click would close it again.
  if (row.getAttribute("aria-expanded") === "false") fireEvent.click(row);
}

beforeEach(() => {
  answers.crds = () => Promise.resolve([]);
});

describe("the GKE custom resources a reader may not list", () => {
  /**
   * The page said "anything below that names one is shown as unresolved
   * rather than as missing", and directly under it every name was a red
   * "absent".
   */
  it("draws the names as not read, not as absent", async () => {
    answers.crds = failing(
      "PERMISSION_DENIED",
      "managedcertificates.networking.gke.io is forbidden"
    );

    await openShop();

    expect(await screen.findByText("shop-cert — not read")).toBeTruthy();
    expect(screen.getByText("shop-fc — not read")).toBeTruthy();
    expect(screen.getByText("shop-bc — not read")).toBeTruthy();
    expect(screen.getByText("names something not read")).toBeTruthy();
    expect(screen.queryByText(/— absent/)).toBeNull();
    expect(screen.queryByText("names something absent")).toBeNull();
  });

  /**
   * A kind this API server does not serve holds none, so a name into it
   * points at nothing — and it is not a list anybody failed to read.
   */
  it("draws a name into an unserved kind as absent", async () => {
    answers.crds = failing("NOT_FOUND", "not found");

    await openShop();

    expect(await screen.findByText("shop-cert — absent")).toBeTruthy();
    expect(screen.getByText("names something absent")).toBeTruthy();
    expect(screen.queryByText(/could not be listed/)).toBeNull();
    expect(screen.queryByText(/— not read/)).toBeNull();
  });
});
