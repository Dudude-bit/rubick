import { describe, expect, it } from "vitest";

import type { CustomResourceInfo } from "@/generated/types";
import {
  directionsOf,
  enforcementOf,
  leavesTheCluster,
  selectionOf,
} from "./model";

/** Shapes recorded from Cilium 1.20.1 on a kind cluster. */
function policy(spec: unknown, status?: unknown): CustomResourceInfo {
  return {
    name: "p",
    namespace: "shop",
    kind: "CiliumNetworkPolicy",
    spec,
    status: status ?? null,
  } as CustomResourceInfo;
}

const VALID = { conditions: [{ type: "Valid", status: "True" }] };

describe("whether a policy is in force", () => {
  /**
   * The whole reason this vendor is worth a folder. A rejected policy is
   * still an object with a name, an age and a spec, and a namespace a reader
   * believes is locked down can be one typo away from open. Fails if the
   * `Valid` condition stops being read.
   */
  it("reads a rejected policy as rejected, with the agent's own words", () => {
    const rejected = enforcementOf(
      policy(
        {
          endpointSelector: {
            matchExpressions: [{ key: "app", operator: "In" }],
          },
        },
        {
          conditions: [
            {
              type: "Valid",
              status: "False",
              message:
                "invalid label selector: matchExpressions[0].values: Required value",
            },
          ],
        }
      )
    );

    expect(rejected.state).toBe("rejected");
    expect(rejected.state === "rejected" && rejected.why).toContain(
      "invalid label selector"
    );
  });

  /**
   * The third state. A policy the agent has not answered about is not one it
   * accepted, and rendering the two the same way is the defect this app
   * exists to avoid. Fails if `notSaid` collapses into either neighbour.
   */
  it("does not read silence as acceptance", () => {
    expect(enforcementOf(policy({}, null)).state).toBe("notSaid");
    expect(enforcementOf(policy({}, { conditions: [] })).state).toBe("notSaid");
    expect(
      enforcementOf(
        policy({}, { conditions: [{ type: "Other", status: "True" }] })
      ).state
    ).toBe("notSaid");
    expect(enforcementOf(policy({}, VALID)).state).toBe("enforced");
  });
});

describe("what a policy does", () => {
  /** A deny rule changes what every allow beside it means, so it is counted apart. */
  it("counts denies apart from allows, in both directions", () => {
    const both = directionsOf(
      policy({
        ingress: [{}],
        ingressDeny: [{}, {}],
        egress: [{}],
        egressDeny: [{}],
      })
    );
    expect(both).toEqual({ ingress: 3, egress: 2, denies: 3 });
    expect(directionsOf(policy({}))).toEqual({
      ingress: 0,
      egress: 0,
      denies: 0,
    });
  });

  /**
   * Three answers, and the middle one is the trap. An empty selector is the
   * whole scope; a `matchExpressions` selector is a *subset* no cell can
   * spell, and calling it "everything" would make the narrowest policy in
   * the cluster read as the widest. Fails if the two are collapsed.
   */
  it("tells a selector that selects everything from one it cannot spell", () => {
    expect(selectionOf(policy({ endpointSelector: {} }))).toEqual({
      kind: "all",
    });
    expect(selectionOf(policy({}))).toEqual({ kind: "all" });
    expect(
      selectionOf(policy({ endpointSelector: { matchLabels: { app: "api" } } }))
    ).toEqual({ kind: "labels", said: "app=api" });
    expect(
      selectionOf(
        policy({
          endpointSelector: {
            matchExpressions: [{ key: "app", operator: "In", values: ["api"] }],
          },
        })
      )
    ).toEqual({ kind: "expressions", count: 1 });
  });

  it("notices egress that leaves the cluster", () => {
    expect(
      leavesTheCluster(
        policy({
          egress: [{ toFQDNs: [{ matchName: "payments.example.com" }] }],
        })
      )
    ).toBe(true);
    expect(
      leavesTheCluster(
        policy({ egress: [{ toEndpoints: [{ matchLabels: { app: "db" } }] }] })
      )
    ).toBe(false);
    expect(leavesTheCluster(policy({}))).toBe(false);
  });
});
