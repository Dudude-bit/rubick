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

describe("whether a policy was accepted", () => {
  /**
   * The whole reason this vendor is worth a folder. A rejected policy is
   * still an object with a name, an age and a spec, and a namespace a reader
   * believes is locked down can be one typo away from open. Fails if the
   * `Valid` condition stops being read.
   */
  it("reads a rejected policy as rejected, with the operator's own words", () => {
    const rejected = enforcementOf(
      policy(
        {},
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
   * The third state, and both of its doors. A policy with no condition and a
   * policy whose condition says `Unknown` are equally undecided; calling
   * either of them rejected paints a working policy red, and calling either
   * accepted promises enforcement nobody confirmed.
   */
  it("reads silence and Unknown as neither, not as one of the two", () => {
    expect(enforcementOf(policy({}, null)).state).toBe("notSaid");
    expect(enforcementOf(policy({}, { conditions: [] })).state).toBe("notSaid");
    expect(
      enforcementOf(
        policy({}, { conditions: [{ type: "Other", status: "True" }] })
      ).state
    ).toBe("notSaid");
    expect(
      enforcementOf(
        policy({}, { conditions: [{ type: "Valid", status: "Unknown" }] })
      ).state
    ).toBe("notSaid");
    expect(enforcementOf(policy({}, VALID)).state).toBe("accepted");
  });
});

describe("a policy whose rules are not on the wire", () => {
  /**
   * `specs:` is a legal shape — the API server takes it and the agent marks
   * it `Valid` — and it is a sibling of `spec`, which is the only field
   * `CustomResourceInfo` carries. Every reader has to answer "not here"
   * rather than counting to zero, or a policy full of rules is drawn as an
   * empty cluster-wide default-deny. Fails if any reader guesses again.
   */
  it("says so rather than reporting an empty policy", () => {
    const viaSpecs = policy(null, VALID);
    expect(selectionOf(viaSpecs)).toEqual({ kind: "notHere" });
    expect(directionsOf(viaSpecs)).toBeNull();
    expect(leavesTheCluster(viaSpecs)).toBeNull();
  });

  /**
   * A host policy selects with `nodeSelector`, and a `CiliumNode` — which
   * Cilium writes one of per node — has a spec that is not a policy's at
   * all. Neither selects every endpoint in the cluster.
   */
  it("does not read a missing endpointSelector as everything", () => {
    expect(
      selectionOf(policy({ nodeSelector: { matchLabels: { role: "cp" } } }))
    ).toEqual({ kind: "notHere" });
    expect(selectionOf(policy({ ingress: {} }))).toEqual({ kind: "notHere" });
  });
});

describe("what a policy does", () => {
  /** A deny rule changes what every allow beside it means, so it is counted apart. */
  it("counts denies apart from allows, in both directions", () => {
    expect(
      directionsOf(
        policy({
          endpointSelector: {},
          ingress: [{}],
          ingressDeny: [{}, {}],
          egress: [{}],
          egressDeny: [{}],
        })
      )
    ).toEqual({ ingress: 3, egress: 2, denies: 3 });
    expect(directionsOf(policy({ endpointSelector: {} }))).toEqual({
      ingress: 0,
      egress: 0,
      denies: 0,
    });
  });

  /**
   * Four answers, and the two in the middle are the traps. An empty selector
   * is the whole scope; `matchExpressions` is a subset no cell can spell;
   * and a selector carrying both must not be reported by its labels alone,
   * which would draw a narrow policy as a broad one.
   */
  it("tells the four kinds of selector apart", () => {
    expect(selectionOf(policy({ endpointSelector: {} }))).toEqual({
      kind: "all",
    });
    expect(
      selectionOf(policy({ endpointSelector: { matchLabels: { app: "api" } } }))
    ).toEqual({ kind: "labels", said: "app=api", andExpressions: 0 });
    expect(
      selectionOf(
        policy({
          endpointSelector: {
            matchExpressions: [{ key: "app", operator: "In", values: ["api"] }],
          },
        })
      )
    ).toEqual({ kind: "expressions", count: 1 });
    expect(
      selectionOf(
        policy({
          endpointSelector: {
            matchLabels: { app: "api" },
            matchExpressions: [{ key: "tier", operator: "Exists" }],
          },
        })
      )
    ).toEqual({ kind: "labels", said: "app=api", andExpressions: 1 });
  });

  /**
   * Most of Cilium's entities name things *inside* the cluster — `cluster`,
   * `host`, `remote-node`, `kube-apiserver` — and a column that called any
   * of them "outside the cluster" would say a policy about the API server
   * leaves the network. Fails if the entity list stops being consulted.
   */
  it("tells an entity outside the cluster from one inside it", () => {
    const outside = (rule: unknown) =>
      leavesTheCluster(policy({ endpointSelector: {}, egress: [rule] }));
    expect(outside({ toFQDNs: [{ matchName: "payments.example.com" }] })).toBe(
      true
    );
    expect(outside({ toEntities: ["world"] })).toBe(true);
    expect(outside({ toCIDR: ["1.1.1.1/32"] })).toBe(true);
    expect(outside({ toEntities: ["cluster"] })).toBe(false);
    expect(outside({ toEntities: ["host", "remote-node"] })).toBe(false);
    expect(outside({ toEndpoints: [{ matchLabels: { app: "db" } }] })).toBe(
      false
    );
  });

  /**
   * A rule that forbids world traffic is still a rule about world traffic.
   * The column says where a policy reaches, not whether it permits it.
   */
  it("counts a deny rule as reaching outside", () => {
    expect(
      leavesTheCluster(
        policy({
          endpointSelector: {},
          egressDeny: [{ toEntities: ["world"] }],
        })
      )
    ).toBe(true);
  });
});
