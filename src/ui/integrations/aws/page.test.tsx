import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import type {
  CustomResourceInfo,
  IngressClassBinding,
  IngressInfo,
} from "@/generated/types";

const answers = vi.hoisted(() => ({
  crds: (): Promise<CustomResourceInfo[]> => Promise.resolve([]),
}));

vi.mock("@/lib/commands", () => ({
  commands: {
    listIngresses: () => Promise.resolve([shop]),
    resolveIngressClass: () => Promise.resolve(classes),
    listCustomResources: () => answers.crds(),
  },
}));

const { default: AwsLoadBalancerPage } = await import("./page");

const shop: IngressInfo = {
  name: "shop",
  namespace: "web",
  className: "alb",
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
  loadBalancerIps: [],
  tlsHosts: [],
  tlsConfigs: [],
  hasCatchAllTls: false,
  defaultBackend: null,
  labels: {},
  annotations: {},
  createdAt: null,
};

const classes: IngressClassBinding = {
  requested: null,
  resolved: null,
  controller: null,
  viaDefault: false,
  available: [
    {
      name: "alb",
      controller: "ingress.k8s.aws/alb",
      isDefault: false,
      parameters: {
        apiGroup: "elbv2.k8s.aws",
        kind: "IngressClassParams",
        name: "shared-alb",
        scope: null,
        namespace: null,
      },
    },
  ],
};

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
  render(<AwsLoadBalancerPage />, { wrapper });
  const row = (await screen.findByText("web/shop")).closest("button")!;
  // A row with a finding opens itself; a click would close it again.
  if (row.getAttribute("aria-expanded") === "false") fireEvent.click(row);
}

beforeEach(() => {
  answers.crds = () => Promise.resolve([]);
});

describe("the ALB custom resources a reader may not list", () => {
  /**
   * The page noted that `ingressclassparams` could not be listed and then
   * called the class's parameters absent, in red — and, with no group of
   * its own, said the Ingress owned its ALB when the parameters may name one.
   */
  it("draws the load balancer as not read, not as broken or alone", async () => {
    answers.crds = failing(
      "PERMISSION_DENIED",
      "ingressclassparams.elbv2.k8s.aws is forbidden"
    );

    await openShop();

    expect(await screen.findByText("names something not read")).toBeTruthy();
    expect(screen.queryByText("names something absent")).toBeNull();
    expect(screen.queryByText(/its own ALB/)).toBeNull();
    expect(screen.queryByText("1 load balancer")).toBeNull();
    expect(screen.getByText("not read")).toBeTruthy();
    expect(screen.queryByText("no TargetGroupBinding")).toBeNull();
  });

  /** A kind this API server does not serve holds no parameters at all. */
  it("calls the parameters absent when the kind is not served", async () => {
    answers.crds = failing("NOT_FOUND", "not found");

    await openShop();

    expect(await screen.findByText("names something absent")).toBeTruthy();
    expect(screen.queryByText(/could not be listed/)).toBeNull();
    expect(screen.getByText("1 load balancer")).toBeTruthy();
    expect(screen.getByText("no TargetGroupBinding")).toBeTruthy();
  });
});
