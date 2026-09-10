import { beforeEach, describe, expect, it } from "vitest";

import { MAX_PINNED_PER_CONTEXT } from "@/lib/my-services";
import { usePinnedServicesStore } from "./pinnedServicesStore";

const pin = (name: string, context = "prod") => ({
  context,
  kind: "Deployment",
  namespace: "shop",
  name,
  pinnedAt: 1,
});

beforeEach(() => {
  usePinnedServicesStore.setState({ pins: [] });
});

describe("pinned services", () => {
  /**
   * Two clusters share nothing. A pin made against staging showing up on a
   * production home page is somebody watching the wrong thing at the moment
   * it matters most.
   */
  it("keeps each cluster's pins to that cluster", () => {
    const store = usePinnedServicesStore.getState();
    store.pin(pin("payments", "prod"));
    store.pin(pin("payments", "staging"));

    expect(
      usePinnedServicesStore
        .getState()
        .forContext("prod")
        .map((entry) => entry.context)
    ).toEqual(["prod"]);
    expect(
      usePinnedServicesStore.getState().forContext("staging")
    ).toHaveLength(1);
  });

  it("pins the same service only once", () => {
    const store = usePinnedServicesStore.getState();
    expect(store.pin(pin("payments"))).toBe("pinned");
    expect(usePinnedServicesStore.getState().pin(pin("payments"))).toBe(
      "already"
    );
    expect(usePinnedServicesStore.getState().pins).toHaveLength(1);
  });

  /**
   * Each card is a neighbourhood read, so the list is budgeted. Refusing is
   * the point: dropping the oldest would quietly stop watching something a
   * person chose to watch, and they would find out by not being told.
   */
  it("refuses past the cap rather than dropping the oldest pin", () => {
    for (let n = 0; n < MAX_PINNED_PER_CONTEXT; n += 1) {
      expect(usePinnedServicesStore.getState().pin(pin(`svc-${n}`))).toBe(
        "pinned"
      );
    }
    expect(usePinnedServicesStore.getState().pin(pin("one-too-many"))).toBe(
      "full"
    );
    expect(usePinnedServicesStore.getState().pins).toHaveLength(
      MAX_PINNED_PER_CONTEXT
    );
    expect(
      usePinnedServicesStore
        .getState()
        .pins.some((entry) => entry.name === "svc-0")
    ).toBe(true);
  });

  it("unpins in one cluster without touching the other", () => {
    const store = usePinnedServicesStore.getState();
    store.pin(pin("payments", "prod"));
    store.pin(pin("payments", "staging"));
    usePinnedServicesStore.getState().unpin("prod", "Deployment/shop/payments");

    expect(usePinnedServicesStore.getState().forContext("prod")).toEqual([]);
    expect(
      usePinnedServicesStore.getState().forContext("staging")
    ).toHaveLength(1);
  });
});
