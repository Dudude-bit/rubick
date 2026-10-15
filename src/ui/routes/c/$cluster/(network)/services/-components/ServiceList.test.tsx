import { screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vite-plus/test";

import { DataTable } from "@/components/ui/data-table";
import type { ServiceInfo, ServicePublished } from "@/generated/types";
import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import { renderWithRouter } from "@/test/render";
import { CopyableAddresses } from "@/components/ui/copyable-value";
import { columns } from "./ServiceList";

vi.mock("@/lib/commands", () => ({
  commands: new Proxy(
    {},
    { get: () => vi.fn(async () => ({ rows: [], unread: [] })) }
  ),
}));

const base = {
  namespace: "k8s-gui-test",
  sessionAffinity: "None",
  externalIps: [],
  loadBalancerIps: [],
  ports: [],
  labels: {},
  annotations: {},
  createdAt: null,
};

/** As `list_services_in` returns them: an alias with no cluster IP, and a headless Service. */
const externalDemo: ServiceInfo = {
  ...base,
  name: "external-demo",
  uid: "1",
  type: "ExternalName",
  clusterIp: null,
  externalName: "example.com",
  selector: {},
};
const headlessDemo: ServiceInfo = {
  ...base,
  name: "headless-demo",
  uid: "2",
  type: "ClusterIP",
  clusterIp: "None",
  externalName: null,
  selector: { app: "headless-demo" },
};

const cellOf = (name: string, column: string) => {
  const row = screen.getByText(name).closest("tr")!;
  const index = screen
    .getAllByRole("columnheader")
    .findIndex((header) => header.textContent?.includes(column));
  return within(row).getAllByRole("cell")[index];
};
const clusterIpCell = (name: string) => cellOf(name, "Cluster IP");

describe("the Services list's Cluster IP column", () => {
  /**
   * Headless Services printed the API's "None" and ExternalName ones "none":
   * two spellings a reader could not tell apart. Fails if the headless
   * literal loses its label or an absent address borrows it.
   */
  it("labels the headless literal and says none where there is no address", async () => {
    await renderWithRouter(
      <DataTable columns={columns()} data={[externalDemo, headlessDemo]} />
    );
    expect(clusterIpCell("headless-demo")).toHaveTextContent("None (headless)");
    expect(clusterIpCell("external-demo")).toHaveTextContent(/^none$/);
  });
});

describe("the Services list's External IPs column", () => {
  /**
   * The list printed external-demo's alias example.com as an external IP
   * while its page and peek said none. Fails if the column reads anything
   * but spec.externalIPs, as the page's row does, or the alias leaves the row.
   */
  it("says what the page says for an ExternalName and keeps the alias beside its type", async () => {
    await renderWithRouter(
      <>
        <DataTable columns={columns()} data={[externalDemo]} />
        <div data-testid="page-row">
          <CopyableAddresses values={externalDemo.externalIps} />
        </div>
      </>
    );
    const listed = cellOf("external-demo", "External IPs");
    expect(listed).not.toHaveTextContent("example.com");
    expect(listed.textContent).toBe(screen.getByTestId("page-row").textContent);
    expect(cellOf("external-demo", "Type")).toHaveTextContent(
      "ExternalNameexample.com"
    );
  });
});

describe("the Services list's Endpoints column", () => {
  const t: T = (section, key, values) => translate("en", section, key, values);
  const refused: ServicePublished = {
    service: {
      kind: "Service",
      name: "headless-demo",
      namespace: "k8s-gui-test",
      existence: "present",
      facts: null,
    },
    source: "slices",
    slices: 0,
    ready: 0,
    draining: 0,
    notReady: 0,
    unrouted: 0,
    unroutedReady: 0,
    ports: [],
    endpoints: [],
    whole: true,
    unpublished: [],
    stop: {
      reason: "podsRefused",
      service: {
        kind: "Service",
        name: "headless-demo",
        namespace: "k8s-gui-test",
        existence: "present",
        facts: null,
      },
      selector: "app=headless-demo",
      workloads: [
        {
          kind: "StatefulSet",
          name: "headless-demo",
          namespace: "k8s-gui-test",
          existence: "present",
          facts: null,
        },
      ],
      said: 'pods "headless-demo-0" is forbidden: violates PodSecurity "restricted:latest": runAsNonRoot != true (pod or container "app" must set securityContext.runAsNonRoot=true)',
    },
  };

  /**
   * A shared Services list carried no word about which Services serve: the
   * column was left out as one the page reads beside the list. Fails if a
   * shared row loses its verdict or the reason the list draws beside it.
   */
  it("shares each row's verdict with the reason it draws beside it", () => {
    const health = columns({
      read: { published: () => refused, why: () => null },
    }).find((column) => column.id === "health");
    expect(health?.meta?.share?.(headlessDemo as never, t)).toEqual({
      text: "no endpoints · Pod Security restricted refuses its pods: 1 check fails",
      role: "err",
      unread: false,
    });
  });
});
