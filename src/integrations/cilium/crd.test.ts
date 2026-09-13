import { describe, expect, it } from "vitest";

import type { CustomResourceInfo } from "@/generated/types";
import { statusRole } from "@/lib/status-role";
import { crd } from "./crd";

function policy(status: unknown): CustomResourceInfo {
  return {
    name: "p",
    namespace: "shop",
    kind: "CiliumNetworkPolicy",
    spec: {},
    status,
  } as CustomResourceInfo;
}

describe("the column that says whether a policy is in force", () => {
  const inForce = crd.columnsFor("CiliumNetworkPolicy")[0];
  const t = (() => "") as never;

  /**
   * A column, not the view's `status`: the list draws `columnsFor` and reads
   * `status` nowhere, so a rejected policy behind the latter is one nobody
   * sees without opening it. Fails if the column moves out of the list.
   */
  it("is the first thing on the row, and says which of the three it is", () => {
    expect(inForce.id).toBe("inForce");
    expect(
      inForce.accessor(
        policy({ conditions: [{ type: "Valid", status: "True" }] }),
        t
      )
    ).toBe("Valid");
    expect(
      inForce.accessor(
        policy({ conditions: [{ type: "Valid", status: "False" }] }),
        t
      )
    ).toBe("Rejected");
    expect(inForce.accessor(policy(null), t)).toBeNull();
  });

  /**
   * The badge colours by looking the word up in `statusRole`'s table, and a
   * word that is not in it comes back neutral — a rejected policy in grey.
   * Fails if either word is dropped from that table.
   */
  it("uses words the badge table knows", () => {
    expect(statusRole("Valid")).toBe("ok");
    expect(statusRole("Rejected")).toBe("err");
  });

  /** No `cell`, or the list would print the word instead of a badge. */
  it("leaves the drawing to the list", () => {
    expect(inForce.cell).toBeUndefined();
  });
});

describe("which kinds Cilium claims", () => {
  it("claims its own group and nobody else's", () => {
    expect(crd.matches("cilium.io", "CiliumNetworkPolicy")).toBe(true);
    expect(crd.matches("CILIUM.IO", "CiliumNetworkPolicy")).toBe(true);
    expect(crd.matches("networking.istio.io", "VirtualService")).toBe(false);
    expect(crd.matches("cilium.example.com", "Thing")).toBe(false);
  });

  /**
   * A vendor's columns *replace* the CRD's own printer columns, so a kind
   * this file has nothing to say about must claim none. It used to fall
   * through to the policy columns, which told a `CiliumNode` — one of which
   * Cilium writes per node — that it selected every endpoint in the cluster
   * and denied them everything, while throwing away the two columns the CRD
   * itself declares. Fails if the default arm starts answering again.
   */
  it("leaves a kind it has nothing to say about to its own columns", () => {
    for (const kind of [
      "CiliumNode",
      "CiliumIdentity",
      "CiliumLoadBalancerIPPool",
      "CiliumCIDRGroup",
      "CiliumBGPClusterConfig",
      "CiliumL2AnnouncementPolicy",
      "CiliumPodIPPool",
      "CiliumNodeConfig",
    ]) {
      expect(crd.columnsFor(kind)).toEqual([]);
    }
    expect(crd.columnsFor("CiliumEndpoint").map((c) => c.id)).toContain(
      "identity"
    );
  });

  /**
   * Without a `cell` the list wraps a bare string in a `StatusBadge`, and a
   * pod IP is not a status. Only the verdict column may go bare.
   */
  it("draws everything but the verdict itself", () => {
    for (const column of crd.columnsFor("CiliumEndpoint")) {
      expect(column.cell).toBeDefined();
    }
    const verdict = crd.columnsFor("CiliumNetworkPolicy")[0];
    expect(verdict.id).toBe("inForce");
    expect(verdict.cell).toBeUndefined();
  });
});
