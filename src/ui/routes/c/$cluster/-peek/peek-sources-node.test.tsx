import { isValidElement } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("@/lib/commands", () => ({ commands: {} }));

import type { NodeInfo } from "@/generated/types";
import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import { None } from "@/components/ui/none";
import { CLUSTER_SOURCES } from "./peek-sources-cluster";

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

const peek = () =>
  CLUSTER_SOURCES.Node!.summarise(
    node01,
    { kind: "Node", name: "node01", namespace: null },
    t
  );

describe("the node peek against the node page", () => {
  /**
   * Sam's node01 peek called it a "worker", which no label says: kubectl
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
