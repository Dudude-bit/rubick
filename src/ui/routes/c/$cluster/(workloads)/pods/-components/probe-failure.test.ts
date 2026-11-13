import { describe, expect, it } from "vite-plus/test";

import type { EventInfo } from "@/generated/types";
import { probeFailure } from "./probe-failure";

const event = (over: Partial<EventInfo>): EventInfo => ({
  name: "e",
  namespace: "ns",
  uid: "u",
  type: "Warning",
  reason: "Unhealthy",
  message: "Liveness probe failed: HTTP probe failed with statuscode: 500",
  source: "kubelet",
  involvedObject: { kind: "Pod", name: "p", namespace: "ns", uid: null },
  count: 3,
  firstTimestamp: null,
  lastTimestamp: "2026-11-13T10:00:00Z",
  ...over,
});

describe("probeFailure", () => {
  it("names the probe and keeps the kubelet's own words", () => {
    expect(probeFailure([event({})])).toEqual({
      probe: "liveness",
      message: "Liveness probe failed: HTTP probe failed with statuscode: 500",
    });
  });

  it("takes the newest failure when several probes failed", () => {
    const readiness = event({
      message: "Readiness probe failed: connection refused",
      lastTimestamp: "2026-11-13T11:00:00Z",
    });
    expect(probeFailure([event({}), readiness])?.probe).toBe("readiness");
  });

  it("says nothing for events that are not probe failures, and for a list never read", () => {
    expect(
      probeFailure([event({ reason: "Pulled", message: "ok" })])
    ).toBeNull();
    expect(probeFailure(undefined)).toBeNull();
  });
});
