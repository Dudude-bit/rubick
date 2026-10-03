import { describe, expect, it } from "vitest";

import { deliveryDigest } from "./useDelivery";
import type { DeliveryQuery } from "@/integrations";

const set = (
  labels: Record<string, string> = {},
  annotations: Record<string, string> = {}
): DeliveryQuery => ({
  group: "apps",
  kind: "StatefulSet",
  name: "stateful-demo",
  namespace: "k8s-gui-test",
  labels,
  annotations,
});

const CLAIM = { "argocd.argoproj.io/instance": "platform" };

describe("what two delivery reads have to agree on to share an answer", () => {
  /**
   * The bug this exists for. `StatefulSetInfo` carries no labels, so the list
   * row asks about a label-less object and caches "nothing delivers this";
   * the peek opened over that row fetched the full object and holds the Argo
   * claim. Same identity, different question — and keyed on identity alone
   * the peek read the row's answer and its Scale dialog said nothing about
   * the controller that would undo the number.
   */
  it("separates the same object asked with and without its claim", () => {
    expect(deliveryDigest([set()])).not.toBe(deliveryDigest([set(CLAIM)]));
  });

  it("separates two different claims on the same object", () => {
    expect(deliveryDigest([set(CLAIM)])).not.toBe(
      deliveryDigest([set({ "argocd.argoproj.io/instance": "other" })])
    );
  });

  it("sees an annotated claim, which is the tracking id's form", () => {
    expect(deliveryDigest([set()])).not.toBe(
      deliveryDigest([
        set({}, { "argocd.argoproj.io/tracking-id": "platform:apps/..." }),
      ])
    );
  });

  // Or every list that rebuilds its array inline refetches for ever, which is
  // the reason the key is a digest rather than the array.
  it("is stable across a rebuild of the same objects in any key order", () => {
    expect(deliveryDigest([set({ a: "1", b: "2" }), set({ ...CLAIM })])).toBe(
      deliveryDigest([set({ b: "2", a: "1" }), set({ ...CLAIM })])
    );
  });
});
