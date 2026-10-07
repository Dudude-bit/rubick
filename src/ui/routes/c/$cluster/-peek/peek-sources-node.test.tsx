import { render, screen, within } from "@testing-library/react";
import { isValidElement } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("@/lib/commands", () => ({ commands: {} }));

import type { NodeBudget, NodeInfo } from "@/generated/types";
import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import { None } from "@/components/ui/none";
import { NodeResources } from "../(cluster)/nodes/-components/NodeResources";
import { CLUSTER_SOURCES } from "./peek-sources-cluster";
import type { WordCell } from "./peek-sources-kit";

const t: T = (section, key, values) => translate("en", section, key, values);

/** node01 as the kubelet reported it: no node-role label, memory in Ki. */
const node01 = {
  name: "node01",
  uid: "node01-uid",
  status: {
    ready: true,
    conditions: [],
    addresses: [{ type: "InternalIP", address: "172.30.2.2" }],
  },
  roles: [],
  version: "v1.34.1",
  os: "linux",
  arch: "amd64",
  containerRuntime: "containerd://1.7.28",
  labels: {
    "kubernetes.io/hostname": "node01",
    "kubernetes.io/os": "linux",
  },
  taints: [],
  unschedulable: false,
  capacity: {
    cpu: "1",
    memory: "1948912Ki",
    pods: "110",
    ephemeralStorage: "19221248Ki",
  },
  allocatable: {
    cpu: "1",
    memory: "1846512Ki",
    pods: "110",
    ephemeralStorage: "18233108Ki",
  },
  providerId: null,
  createdAt: "2026-10-05T13:20:00Z",
} as unknown as NodeInfo;

/** The same node as `node_resource_budget` reads it: quantities parsed in Rust. */
const budget: NodeBudget = {
  pods: 19,
  known: true,
  refused: [],
  error: null,
  resources: [
    ["cpu", "cpu", 1000, 1000],
    ["memory", "memory", 1948912 * 1024, 1846512 * 1024],
    ["pods", "count", 110, 110],
    ["ephemeral-storage", "memory", 19221248 * 1024, 18233108 * 1024],
  ].map(([name, unit, capacity, allocatable]) => ({
    name: name as string,
    unit: unit as "cpu" | "memory" | "count",
    capacity: capacity as number,
    allocatable: allocatable as number,
    requested: 0,
    limited: name === "pods" ? null : 0,
    extended: false,
  })),
};

const peek = () =>
  CLUSTER_SOURCES.Node!.summarise(
    node01,
    { kind: "Node", name: "node01", namespace: null },
    t
  );

describe("the node peek against the node page", () => {
  /**
   * Sam's node01 peek printed Memory "1846512Ki" under "Capacity": the
   * allocatable figure, raw, under the other figure's name, while the page
   * said 1.9Gi capacity and 1.8Gi allocatable. Fails if the peek reads
   * another field, label or formatter than the page's Resources table.
   */
  it("states capacity and allocatable as the page's Resources table does", () => {
    const table = peek().groups.find((group) => group.table)?.table;
    expect(table?.columns).toEqual(["Resource", "Capacity", "Allocatable"]);

    render(
      <NodeResources
        budget={budget}
        error={null}
        onRetry={() => {}}
        usage={null}
      />
    );
    for (const row of table!.rows) {
      const [name, capacity, allocatable] = row.map(
        (cell: WordCell) => cell.words[0]
      );
      const pageRow = screen
        .getAllByRole("row")
        .find((tr) => tr.firstElementChild?.textContent === name)!;
      const [, pageCapacity, pageAllocatable] =
        within(pageRow).getAllByRole("cell");
      expect([capacity, allocatable]).toEqual([
        pageCapacity.textContent,
        pageAllocatable.textContent,
      ]);
    }
    expect(table!.rows[1].map((cell: WordCell) => cell.words[0])).toEqual([
      "memory",
      "1.9Gi",
      "1.8Gi",
    ]);
  });

  /**
   * The same peek called node01 a "worker", which no label says: kubectl
   * prints `<none>` and the Nodes list "none". Fails if a node with no
   * node-role label is given a role.
   */
  it("gives a node with no node-role label no role", () => {
    const roles = peek()
      .groups.flatMap((group) => group.items)
      .find((item) => item.label === "Roles");
    expect(isValidElement(roles?.value) && roles.value.type).toBe(None);
  });
});
