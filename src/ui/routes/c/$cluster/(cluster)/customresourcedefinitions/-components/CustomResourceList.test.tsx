import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import { screen, within } from "@testing-library/react";

import { commands } from "@/lib/commands";
import type { CustomResourceInfo, PrinterColumn } from "@/generated/types";
import { useClusterStore } from "@/stores/clusterStore";
import { renderWithRouter } from "@/test/render";
import { CustomResourceList } from "./CustomResourceList";

const column = (name: string, jsonPath: string): PrinterColumn => ({
  name,
  columnType: "string",
  jsonPath,
  description: null,
  priority: null,
});

const CILIUM_NODE_COLUMNS: PrinterColumn[] = [
  column(
    "CiliumInternalIP",
    '.spec.addresses[?(@.type=="CiliumInternalIP")].ip'
  ),
  column("InternalIP", '.spec.addresses[?(@.type=="InternalIP")].ip'),
  { ...column("Age", ".metadata.creationTimestamp"), columnType: "date" },
];

const node = (
  name: string,
  internal: string,
  cilium: string
): CustomResourceInfo => ({
  name,
  namespace: null,
  uid: `uid-${name}`,
  apiVersion: "cilium.io/v2",
  kind: "CiliumNode",
  spec: {
    addresses: [
      { ip: internal, type: "InternalIP" },
      { ip: cilium, type: "CiliumInternalIP" },
    ],
    health: { ipv4: "192.168.0.108" },
    ipam: { podCIDRs: ["192.168.0.0/24"], pools: {} },
  },
  status: { ipam: { "operator-status": {} } },
  labels: { "kubernetes.io/hostname": name },
  annotations: {},
  createdAt: "2026-10-06T17:40:00Z",
  ownerReferences: [],
  generation: 1,
});

function draw(rows: CustomResourceInfo[], printerColumns: PrinterColumn[]) {
  vi.spyOn(commands, "listCustomResourcesIn").mockResolvedValue({
    rows,
    unread: [],
  });
  vi.spyOn(commands, "subscribeCustomResourceWatch").mockReturnValue(
    new Promise(() => {})
  );
  return renderWithRouter(
    <CustomResourceList
      crdName="ciliumnodes.cilium.io"
      crdKind="CiliumNode"
      crdGroup="cilium.io"
      crdVersion="v2"
      crdPlural="ciliumnodes"
      scope="Cluster"
      printerColumns={printerColumns}
    />,
    { at: "/c/prod/customresourcedefinitions/ciliumnodes.cilium.io" }
  );
}

const rowOf = async (name: string) =>
  (await screen.findByRole("link", { name })).closest("tr")!;

beforeEach(() => {
  useClusterStore.setState({ isConnected: true, currentContext: "prod" });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a CRD's printer columns in its instance list", () => {
  /**
   * Sam's CiliumNode list read "none" for both addresses kubectl prints: the
   * CRD's columns filter `.spec.addresses` by type, which the list could not
   * evaluate. Fails if a filter expression stops finding the address.
   */
  it("evaluates the CiliumNode address columns kubectl prints", async () => {
    await draw(
      [
        node("controlplane", "172.30.1.2", "192.168.0.69"),
        node("node01", "172.30.2.2", "192.168.1.25"),
      ],
      CILIUM_NODE_COLUMNS
    );

    const controlplane = within(await rowOf("controlplane"));
    expect(controlplane.getByText("192.168.0.69")).toBeInTheDocument();
    expect(controlplane.getByText("172.30.1.2")).toBeInTheDocument();
    const node01 = within(await rowOf("node01"));
    expect(node01.getByText("192.168.1.25")).toBeInTheDocument();
    expect(node01.getByText("172.30.2.2")).toBeInTheDocument();
    expect(controlplane.queryByText("none")).toBeNull();
  });

  /**
   * A path this app cannot read is not the cluster's "none". Fails if a
   * column it could not evaluate collapses into the word for an absent field.
   */
  it("says a column it cannot evaluate was not evaluated, with the expression", async () => {
    await draw(
      [node("controlplane", "172.30.1.2", "192.168.0.69")],
      [
        column("Finalizer", ".metadata.finalizers[0]"),
        column("Encryption", ".spec.encryption.key"),
      ]
    );

    const row = within(await rowOf("controlplane"));
    const unread = row.getByText("not evaluated");
    expect(unread.closest("[title]")).toHaveAttribute(
      "title",
      expect.stringContaining(".metadata.finalizers[0]")
    );
    expect(row.getAllByText("none")).toHaveLength(1);
  });
});

/** The `widgets.demo.k8s-gui.io` specimen, one instance. */
const widget: CustomResourceInfo = {
  name: "blue",
  namespace: "k8s-gui-test",
  uid: "w1",
  apiVersion: "demo.k8s-gui.io/v1",
  kind: "Widget",
  spec: { size: 3 },
  status: null,
  labels: {},
  annotations: {},
  createdAt: null,
  ownerReferences: [],
  generation: 1,
};

describe("a custom resource list's count", () => {
  /**
   * Sam's widgets list ended "1 widgets": the plural stood in for the kind,
   * so the count could not agree with its number. Fails if the footer stops
   * naming one instance by its kind.
   */
  it("names one instance by its kind", async () => {
    vi.spyOn(commands, "listCustomResourcesIn").mockResolvedValue({
      rows: [widget],
      unread: [],
    });
    vi.spyOn(commands, "subscribeCustomResourceWatch").mockReturnValue(
      new Promise(() => {})
    );
    await renderWithRouter(
      <CustomResourceList
        crdName="widgets.demo.k8s-gui.io"
        crdKind="Widget"
        crdGroup="demo.k8s-gui.io"
        crdVersion="v1"
        crdPlural="widgets"
        scope="Namespaced"
      />,
      { at: "/c/prod/customresourcedefinitions", route: "/c/$cluster/$" }
    );
    expect(await screen.findByText("1 Widget")).toBeInTheDocument();
    expect(screen.queryByText("1 widgets")).toBeNull();
  });
});

describe("a custom resource list's count of several", () => {
  /**
   * Sam's lists ended "1 Widget" but "2 ciliumnodes": the kind for one, the
   * API's lowercase resource plural for many. Fails if a count of several
   * stops naming them by the kind's own noun.
   */
  it("counts CiliumNodes as CiliumNodes", async () => {
    await draw(
      [
        node("controlplane", "172.30.1.2", "192.168.0.69"),
        node("node01", "172.30.2.2", "192.168.1.25"),
      ],
      CILIUM_NODE_COLUMNS
    );
    expect(await screen.findByText("2 CiliumNodes")).toBeInTheDocument();
    expect(screen.queryByText("2 ciliumnodes")).toBeNull();
  });
});
