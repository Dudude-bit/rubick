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

describe("the badge on a Cilium policy", () => {
  /**
   * The one a `Ready`-shaped reader gets wrong. Cilium writes `Valid` once
   * it has looked at the policy, so a policy it has not answered about
   * carries no condition — and a reader that turns a missing condition into
   * "NotReady" would paint every freshly written policy red, while one that
   * turns it into "Ready" would promise enforcement nobody confirmed.
   * Fails if the third state collapses either way.
   */
  it("draws a policy nobody has answered about as neither valid nor rejected", () => {
    expect(crd.status.getStatus(policy(null))).toBeNull();
    expect(crd.status.getStatus(policy({ conditions: [] }))).toBeNull();
    expect(
      crd.status.getStatus(
        policy({ conditions: [{ type: "Valid", status: "True" }] })
      )
    ).toBe("Valid");
    expect(
      crd.status.getStatus(
        policy({ conditions: [{ type: "Valid", status: "False" }] })
      )
    ).toBe("Rejected");
  });

  /** A rejected policy is a fault, not a shade of grey. */
  it("gives a rejected policy the failure tone", () => {
    expect(crd.status.getVariant("Rejected")).toBe("destructive");
    expect(crd.status.getVariant("Valid")).toBe("default");
    expect(crd.status.getVariant("")).toBe("outline");
  });
});

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
   * The agent creates ten kinds and names more with every release, so a kind
   * this file has never heard of still has to come back with columns.
   */
  it("has columns for a kind it does not know", () => {
    expect(crd.columnsFor("CiliumBGPClusterConfig").length).toBeGreaterThan(0);
    expect(crd.columnsFor("CiliumEndpoint").map((c) => c.id)).toContain(
      "identity"
    );
  });
});
