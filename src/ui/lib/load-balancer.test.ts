import { describe, expect, it } from "vite-plus/test";

import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import type { ServiceInfo } from "@/generated/types";
import {
  balancerAddressOf,
  balancerEvidence,
  balancerWords,
} from "./load-balancer";

const t: T = (section, key, values) => translate("en", section, key, values);

function service(
  name: string,
  type: string,
  loadBalancerIps: string[] = []
): ServiceInfo {
  return {
    name,
    namespace: "net",
    uid: name,
    type,
    sessionAffinity: "None",
    clusterIp: "10.0.0.1",
    externalIps: [],
    loadBalancerIps,
    ports: [],
    selector: { app: name },
    labels: {},
    annotations: {},
    createdAt: null,
  };
}

const PUBLIC_API = service("public-api", "LoadBalancer");

describe("a LoadBalancer Service with no address", () => {
  /**
   * The persona cluster had no implementation at all, and the Service sat in
   * yellow "pending" as if an address were coming. Fails if a cluster where
   * nothing ever got an address reads as waiting.
   */
  it("says nothing here assigns one when no LoadBalancer has an address", () => {
    const evidence = balancerEvidence(
      [PUBLIC_API, service("api", "ClusterIP")],
      null
    );
    const address = balancerAddressOf(PUBLIC_API, evidence);
    expect(address).toEqual({ state: "neverAssigned" });
    if (address.state !== "neverAssigned") return;
    const words = balancerWords(address, [31279], t);
    expect(words.role).toBe("err");
    expect(words.reason).toContain("may never arrive");
    expect(words.reason).toContain("31279");
  });

  /** Another Service has one, so something hands them out: it is waiting. */
  it("calls it waiting when another LoadBalancer has an address", () => {
    const evidence = balancerEvidence(
      [PUBLIC_API, service("edge", "LoadBalancer", ["203.0.113.7"])],
      null
    );
    const address = balancerAddressOf(PUBLIC_API, evidence);
    expect(address).toEqual({ state: "waiting" });
    if (address.state !== "waiting") return;
    expect(balancerWords(address, [], t).role).toBe("pending");
  });

  /**
   * The other Services could not be read: neither waiting nor never. Fails
   * if a refused read is taken for "none has an address".
   */
  it("cannot tell when the other Services were refused", () => {
    const evidence = balancerEvidence(
      undefined,
      new Error("services is forbidden")
    );
    const address = balancerAddressOf(PUBLIC_API, evidence);
    expect(address.state).toBe("cannotTell");
    if (address.state !== "cannotTell") return;
    const words = balancerWords(address, [], t);
    expect(words.role).toBe("neutral");
    expect(words.reason).toContain("services is forbidden");

    expect(
      balancerAddressOf(PUBLIC_API, balancerEvidence(undefined, null))
    ).toEqual({ state: "cannotTell", why: null });
  });

  it("leaves other types and assigned addresses alone", () => {
    const none = balancerEvidence([], null);
    expect(balancerAddressOf(service("api", "ClusterIP"), none)).toEqual({
      state: "notBalancer",
    });
    expect(
      balancerAddressOf(service("edge", "LoadBalancer", ["203.0.113.7"]), none)
    ).toEqual({ state: "assigned", addresses: ["203.0.113.7"] });
  });
});
