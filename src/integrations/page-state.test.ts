import { describe, expect, it } from "vitest";

import { pageDecision } from "./page-state";

const crdVendor = { id: "traefik", configured: false };
const connectVendor = { id: "prometheus", configured: true };

describe("what /integrations/<slug> answers", () => {
  it("does not exist for a slug no vendor claims", () => {
    expect(pageDecision(undefined, [], undefined)).toBe("unknown");
  });

  it("waits for detection before calling a CRD vendor absent", () => {
    expect(pageDecision(crdVendor, undefined, undefined)).toBe("detecting");
  });

  it("answers a CRD vendor from the detection scan", () => {
    expect(
      pageDecision(crdVendor, [{ id: "traefik", installed: true }], undefined)
    ).toBe("ready");
    expect(
      pageDecision(crdVendor, [{ id: "traefik", installed: false }], undefined)
    ).toBe("absent");
  });

  /**
   * The reported case: a connected Prometheus and a page saying "not
   * installed — its custom resource definitions are not in this API
   * server". The vendor installs no CRDs and the detector has no entry for
   * it, so the CRD scan can never answer; the connection is the answer.
   * Would break if the page gate went back to reading detection alone.
   */
  it("opens a configured vendor's page because its address answered", () => {
    expect(
      pageDecision(connectVendor, [{ id: "traefik", installed: true }], {
        state: "connected",
      })
    ).toBe("ready");
  });

  /**
   * Configured and not answering is still configured: the page is where
   * "unreachable" is said, and bouncing to "not installed" would tell the
   * reader their setup evaporated.
   */
  it("still opens the page when the configured address is not answering", () => {
    expect(pageDecision(connectVendor, [], { state: "unreachable" })).toBe(
      "ready"
    );
  });

  it("says a configured vendor with no address is not connected, not absent", () => {
    expect(pageDecision(connectVendor, [], { state: "notConfigured" })).toBe(
      "notConfigured"
    );
  });

  it("waits while the connection is still being read", () => {
    expect(pageDecision(connectVendor, [], { state: "reading" })).toBe(
      "detecting"
    );
    expect(pageDecision(connectVendor, [], undefined)).toBe("detecting");
  });

  /**
   * A vendor with both a marker CRD and an address: the install answers
   * first, so a cluster running it is never told to go configure a URL.
   */
  it("lets a detected install answer before the connection", () => {
    const hybrid = { id: "argocd", configured: true };
    expect(
      pageDecision(hybrid, [{ id: "argocd", installed: true }], {
        state: "notConfigured",
      })
    ).toBe("ready");
    expect(
      pageDecision(hybrid, [{ id: "argocd", installed: false }], {
        state: "notConfigured",
      })
    ).toBe("absent");
  });
});
