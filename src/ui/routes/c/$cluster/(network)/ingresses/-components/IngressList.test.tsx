import { screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vite-plus/test";

import type { QuickAction } from "@/components/ui/quick-actions";
import type { ColumnDef } from "@/components/ui/table-features";
import type { IngressInfo } from "@/generated/types";
import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import { useIngressTls } from "@/hooks/useIngressTls";
import { useClusterStore } from "@/stores/clusterStore";
import { renderWithRouter } from "@/test/render";
import { ResourceList } from "../../../-list/ResourceList";
import { IngressList } from "./IngressList";

/** plain-nginx as `list_ingresses_in` returns it on a cluster with no IngressClass. */
const plain: IngressInfo = {
  uid: "",
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
            targets: [8080],
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
vi.mock("@/hooks/useIngressTls", async (original) => {
  const real = await original<typeof import("@/hooks/useIngressTls")>();
  return { ...real, useIngressTls: vi.fn(real.useIngressTls) };
});

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

/**
 * A shared Ingresses list carried no status, and the row hid its reason
 * behind a hover. Fails if the health column stops sharing the verdict and
 * the reason it draws beside the badge.
 */
it("shares each row's status with the reason it draws beside it", async () => {
  useClusterStore.setState({ isConnected: true });
  await renderWithRouter(<IngressList />, {
    at: "/c/prod/ingresses",
    route: "/c/$cluster/ingresses",
  });
  const t: T = (section, key, values) => translate("en", section, key, values);
  await waitFor(() => {
    const columns = vi.mocked(ResourceList).mock.calls.at(-1)![0]
      .columns as ColumnDef<IngressInfo>[];
    const health = columns.find((column) => column.id === "health");
    expect(health?.meta?.share?.(plain as never, t)).toMatchObject({
      text: "no controller · No IngressClass named nginx in this cluster, so nothing picks this Ingress up.",
      role: "err",
    });
  });
});

/**
 * A GKE Ingress, or an annotation-only nginx or ALB one, was drawn "no
 * controller" in red with its Open in Browser refused, while it had an
 * address and served. Fails if the row reads a missing IngressClass as
 * nobody serving a class only the annotation names.
 */
it("calls an annotated Ingress a controller has addressed served, and offers to open it", async () => {
  const gke: IngressInfo = {
    ...plain,
    name: "gke-shop",
    className: "gce",
    classAnnotated: true,
    loadBalancerIps: ["34.1.2.3"],
  };
  const before = { ...answers };
  answers.listIngressesIn = { rows: [gke], unread: [] };
  answers.resolveIngressClass = {
    requested: "gce",
    resolved: null,
    controller: null,
    viaDefault: false,
    available: [],
  };
  useClusterStore.setState({ isConnected: true });
  await renderWithRouter(<IngressList />, {
    at: "/c/prod/ingresses",
    route: "/c/$cluster/ingresses",
  });
  const t: T = (section, key, values) => translate("en", section, key, values);
  await waitFor(() => {
    const columns = vi.mocked(ResourceList).mock.calls.at(-1)![0]
      .columns as ColumnDef<IngressInfo>[];
    const health = columns.find((column) => column.id === "health");
    expect(health?.meta?.share?.(gke as never, t)).toMatchObject({
      text: "served",
      role: "ok",
    });
  });
  expect(openAction().reason?.(gke)).toBeUndefined();
  Object.assign(answers, before);
});

/**
 * Traefik's answer replaces `spec.tls`. While it was out, the Ingress's page
 * said "TLS not checked" and its row here said "1 host". Fails if the row's
 * TLS cell is not handed the verdict the page reads, from the same unread
 * answer.
 */
it("says TLS was not checked in a row whose controller replaces spec.tls and has not answered", async () => {
  const secured: IngressInfo = {
    ...plain,
    tlsHosts: ["plain.k8s-gui.test"],
    tlsConfigs: [
      {
        hosts: ["plain.k8s-gui.test"],
        secretName: "plain-tls",
        isCatchAll: false,
      },
    ],
  };
  const real = vi.mocked(useIngressTls).getMockImplementation()!;
  vi.mocked(useIngressTls).mockReturnValue({
    available: true,
    of: () => null,
    isPending: true,
    error: null,
    unread: "replaces",
  });
  vi.mocked(ResourceList).mockImplementation(((props: {
    columns: ColumnDef<IngressInfo>[];
  }) => {
    const tls = props.columns.find(
      (column) => "accessorKey" in column && column.accessorKey === "tlsHosts"
    );
    const Cell = tls!.cell as (props: {
      row: { original: IngressInfo };
    }) => React.ReactNode;
    return <Cell row={{ original: secured }} />;
  }) as never);
  useClusterStore.setState({ isConnected: true });
  await renderWithRouter(<IngressList />, {
    at: "/c/prod/ingresses",
    route: "/c/$cluster/ingresses",
  });

  expect(await screen.findByText("TLS not checked")).toBeInTheDocument();
  expect(screen.queryByText("1 host")).toBeNull();
  vi.mocked(useIngressTls).mockImplementation(real);
  vi.mocked(ResourceList).mockImplementation((() => null) as never);
});
