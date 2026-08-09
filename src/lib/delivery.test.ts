import { describe, expect, it } from "vitest";

import type { Delivery, DeliverySource } from "@/integrations";
import {
  deliveryCell,
  deliveryIntercept,
  deliveryLine,
  deliveryMarks,
  deliveryScopeOf,
  matchesDeliveryFilter,
} from "./delivery";

function source(over: Partial<DeliverySource> = {}): DeliverySource {
  return {
    vendor: "Argo CD",
    vendorId: "argocd",
    owner: {
      kind: "Application",
      name: "shop",
      namespace: "argocd",
      to: "/crds/applications.argoproj.io/instances/argocd/shop",
    },
    revision: "a3f21c9d4e5b6a7c8d9e0f1a2b3c4d5e6f7a8b9c",
    repoUrl: "https://github.com/acme/infra",
    path: "manifests/shop",
    drift: "kept",
    sync: "synced",
    lastAppliedAt: null,
    warning: null,
    note: "Auto-sync is off, so an edit here stands until somebody syncs it.",
    ...over,
  };
}

const delivered = (over: Partial<DeliverySource> = {}): Delivery => ({
  state: "delivered",
  source: source(over),
});

const claimed = (over: Partial<Extract<Delivery, { state: "claimed" }>> = {}) =>
  ({
    state: "claimed",
    vendor: "Argo CD",
    vendorId: "argocd",
    claim: "shop",
    ownerKind: "Application",
    owner: {
      kind: "Application",
      name: "shop",
      namespace: "argocd",
      to: "/crds/applications.argoproj.io/instances/argocd/shop",
    },
    ...over,
  }) as Delivery;

describe("the Overview line is earned, never granted", () => {
  /**
   * The load-bearing test of the whole feature, and the one that fails if the
   * line ever becomes "this object is managed".
   *
   * On a cluster Argo runs, *everything* is delivered. A line that appeared
   * for a healthy, in-sync object whose delivery will not fight you would
   * therefore be on every detail page in the app — the same mistake as a
   * "managed" badge on every row, one storey up and costing more pixels. The
   * header mark already answers "where does this come from"; there is nothing
   * left for a banner to add.
   */
  it("says nothing about a delivered, in-sync object whose edits would stick", () => {
    expect(deliveryLine([delivered({ drift: "kept", sync: "synced" })])).toBe(
      null
    );
  });

  it("says nothing at all when nothing claims the object", () => {
    expect(deliveryLine([])).toBe(null);
  });

  it("warns, in the vendor's own words, when an edit will be put back", () => {
    const line = deliveryLine([
      delivered({ drift: "reverted", note: "Argo self-heals this." }),
    ]);
    expect(line?.tone).toBe("info");
    expect(line?.detail).toContain("Argo self-heals this.");
  });

  it("says how long ago it was last applied when live has drifted", () => {
    const line = deliveryLine([
      delivered({
        sync: "drifted",
        lastAppliedAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
      }),
    ]);
    expect(line?.tone).toBe("warn");
    expect(line?.title).toContain("Live differs from git");
    expect(line?.title).toContain("2d");
  });

  it("separates a stopped reconciler from an edit that simply stands", () => {
    const line = deliveryLine([
      delivered({ drift: "unmanaged", note: "apps is suspended." }),
    ]);
    expect(line?.tone).toBe("warn");
    expect(line?.title).toContain("Nothing is applying this");
  });

  /**
   * Two controllers that both really apply an object are undoing each other,
   * and no edit made here settles it. This is the only case a first-provider
   * capability lookup could never have found.
   */
  it("names both when two controllers deliver the same object", () => {
    const line = deliveryLine([
      delivered(),
      delivered({ vendor: "Flux", vendorId: "flux", sync: null }),
    ]);
    expect(line?.tone).toBe("warn");
    expect(line?.title).toContain("Argo CD and Flux");
    expect(line?.detail).toContain("undoes");
  });
});

describe("a label is a claim, and an unconfirmed claim is never delivery", () => {
  /**
   * The second load-bearing test. An object wearing a delivery label whose
   * owner does not list it is stale bookkeeping — a pruned Kustomization, a
   * deleted Application, a label committed into the manifest by hand. The app
   * must say what the object claims and that nothing honours it. It must
   * never state a revision, a repository or a revert behaviour for it,
   * because nothing is enforcing any of them.
   */
  it("says the owner does not list it, rather than asserting delivery", () => {
    const line = deliveryLine([claimed()]);
    expect(line?.tone).toBe("warn");
    expect(line?.title).toBe(
      "Labelled as delivered by shop, which does not list it"
    );
    expect(line?.detail).not.toContain("reverted");
  });

  it("says so differently when no such owner exists at all", () => {
    const line = deliveryLine([claimed({ owner: null })]);
    expect(line?.title).toBe(
      "Labelled as delivered by shop, and no Application by that name exists"
    );
  });

  it("marks an unconfirmed claim as unconfirmed, not as provenance", () => {
    const [mark] = deliveryMarks([claimed()]);
    expect(mark.text).toBe("Argo CD · shop · unconfirmed");
    expect(mark.tone).toBe("warn");
  });

  it("never offers to warn about an edit an unconfirmed claim cannot undo", () => {
    expect(deliveryIntercept([claimed()], "Scale")).toBe(null);
  });

  it("keeps it out of the column's quiet case", () => {
    expect(deliveryCell([claimed()])).toEqual({
      text: "labelled, not listed",
      tone: "warn",
    });
  });
});

describe("the list column is empty for the rule and marks the exception", () => {
  it("draws nothing for a delivered, in-sync row", () => {
    expect(deliveryCell([delivered()])).toBe(null);
  });

  it("draws `not delivered` quietly, because it is not a fault", () => {
    expect(deliveryCell([])).toEqual({ text: "not delivered", tone: "faint" });
  });

  it("marks drift, which is a problem and earns one", () => {
    expect(deliveryCell([delivered({ sync: "drifted" })])?.tone).toBe("warn");
  });

  /**
   * Flux corrects silently and records nothing, so `sync: null` can never
   * become a drift mark. A column that guessed here would state a comparison
   * nobody made.
   */
  it("never turns an unreported comparison into a verdict", () => {
    expect(
      deliveryCell([
        delivered({ vendor: "Flux", vendorId: "flux", sync: null }),
      ])
    ).toBe(null);
  });

  it("filters to what nothing delivers, and to what needs attention", () => {
    expect(matchesDeliveryFilter("notDelivered", [])).toBe(true);
    expect(matchesDeliveryFilter("notDelivered", [delivered()])).toBe(false);
    expect(matchesDeliveryFilter("trouble", [delivered()])).toBe(false);
    expect(
      matchesDeliveryFilter("trouble", [delivered({ sync: "drifted" })])
    ).toBe(true);
  });
});

describe("the interception tells rather than blocks", () => {
  it("speaks only where something really re-applies the object", () => {
    expect(deliveryIntercept([delivered({ drift: "kept" })], "Scale")).toBe(
      null
    );
    expect(
      deliveryIntercept([delivered({ drift: "unmanaged" })], "Scale")
    ).toBe(null);
    expect(deliveryIntercept([], "Scale")).toBe(null);
  });

  it("keeps the verb, so the button still does what it says", () => {
    const intercept = deliveryIntercept(
      [delivered({ drift: "reverted" })],
      "Scale"
    );
    expect(intercept?.confirmLabel).toBe("Scale anyway");
    expect(intercept?.title).toContain("Argo CD will undo this");
    expect(intercept?.description).toContain("manifests/shop");
  });
});

describe("which lists carry the column", () => {
  /**
   * A Pod comes from its controller and a ReplicaSet from its Deployment.
   * Neither carries a delivery label, so a column would read `not delivered`
   * on every row of every cluster — the section-one trap with the colours
   * swapped.
   */
  it("leaves out the kinds the cluster makes from something else", () => {
    expect(deliveryScopeOf("Pod")).toBe(null);
    expect(deliveryScopeOf("ReplicaSet")).toBe(null);
  });

  it("carries the group, which Flux's inventory id is spelled with", () => {
    expect(deliveryScopeOf("Deployment")).toEqual({
      group: "apps",
      kind: "Deployment",
    });
    expect(deliveryScopeOf("ConfigMap")).toEqual({
      group: "",
      kind: "ConfigMap",
    });
  });
});
