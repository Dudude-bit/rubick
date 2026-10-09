import { waitFor } from "@testing-library/react";
import { expect, it, vi } from "vite-plus/test";

import type { QuickAction } from "@/components/ui/quick-actions";
import type { IngressInfo } from "@/generated/types";
import { useClusterStore } from "@/stores/clusterStore";
import { renderWithRouter } from "@/test/render";
import { ResourceList } from "../../../-list/ResourceList";
import { IngressList } from "./IngressList";

/** plain-nginx as `list_ingresses_in` returns it on a cluster with no IngressClass. */
const plain: IngressInfo = {
  name: "plain-nginx",
  namespace: "k8s-gui-test",
  className: "nginx",
  rules: [
    {
      host: "plain.k8s-gui.test",
      paths: [
        {
          path: "/",
          pathType: "Prefix",
          backendService: "log-demo",
          backendPort: "80",
          resourceBackend: null,
        },
      ],
    },
  ],
  defaultBackend: null,
  loadBalancerIps: [],
  tlsHosts: [],
  tlsConfigs: [],
  hasCatchAllTls: false,
  labels: {},
  annotations: {},
  createdAt: null,
};

const answers: Record<string, unknown> = {
  listIngressesIn: { rows: [plain], unread: [] },
  resolveIngressClass: {
    requested: "nginx",
    resolved: null,
    controller: null,
    viaDefault: false,
    available: [],
  },
  listServiceHealthInputs: {
    rows: [
      {
        namespace: "k8s-gui-test",
        groups: [
          {
            names: ["log-demo"],
            type: "ClusterIP",
            selectorless: false,
            ready: 2,
            draining: 0,
            notReady: 0,
            unrouted: 0,
          },
        ],
      },
    ],
    unread: [],
  },
  subscribeIngressWatch: () => {},
};
vi.mock("@/lib/commands", () => ({
  commands: new Proxy(
    {},
    { get: (_, key: string) => vi.fn(async () => answers[key] ?? null) }
  ),
}));
vi.mock("@/hooks/useWatchedList", () => ({
  useWatchedList: () => ({ live: false, refresh: false, resyncing: false }),
}));
vi.mock("../../../-list/ResourceList", () => ({
  ResourceList: vi.fn(() => null),
}));

function openAction(): QuickAction<IngressInfo> {
  const build = vi.mocked(ResourceList).mock.calls.at(-1)![0]
    .quickActions as unknown as (
    setDeleteTarget: (item: IngressInfo) => void
  ) => QuickAction<IngressInfo>[];
  return build(() => {}).find((action) => action.label === "Open in Browser")!;
}

/**
 * The row offered "Open in Browser" for an Ingress the list's own status
 * column called "no controller". Fails if the action stops asking the
 * verdict, or offers the address while nothing answers at it.
 */
it("refuses to open an Ingress no controller serves, and says why", async () => {
  useClusterStore.setState({ isConnected: true });
  await renderWithRouter(<IngressList />, {
    at: "/c/prod/ingresses",
    route: "/c/$cluster/ingresses",
  });
  await waitFor(() =>
    expect(openAction().reason?.(plain)).toBe(
      "No IngressClass named nginx in this cluster, so nothing picks this Ingress up."
    )
  );
});
