import { describe, expect, it } from "vitest";

import {
  SCOPE_LIMIT,
  clampScope,
  decodeScope,
  inScope,
  answeredIn,
  joinScoped,
  sameScope,
  scopeCacheKey,
  scopeIn,
  scopeLabel,
  inNamespace,
  whole,
  wireNamespace,
  wireScope,
} from "./namespace-scope";

import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";

/** The English catalogue — what these expectations are written in. */
const t: T = (section, key, values) => translate("en", section, key, values);

describe("what the backend is told", () => {
  /**
   * Would break if a multi-namespace scope ever reached a one-namespace
   * command: sending `"a,b"` would ask for a namespace that does not exist
   * and quietly return nothing.
   */
  it("asks for one namespace, or for the whole cluster", () => {
    expect(wireNamespace([])).toBe("");
    expect(wireNamespace(["prod"])).toBe("prod");
    expect(wireNamespace(["prod", "staging"])).toBe("");
  });
});

describe("what is stored against a context and a tab", () => {
  /**
   * Would break every screen after a downgrade. `ClusterPreferences` and a
   * scope tab both hold one opaque string that a build without this feature
   * reads straight into `currentNamespace`, so what is written there has to
   * be a namespace that build can ask for — never a joined list.
   */
  it("is a value an older build can still act on", () => {
    for (const scope of [[], ["prod"], ["prod", "staging"]]) {
      expect(wireNamespace(scope)).not.toContain(",");
    }
    // Several is stored as "all namespaces": a superset of the selection,
    // labelled as exactly that, rather than a namespace that does not exist.
    expect(wireNamespace(["prod", "staging"])).toBe("");
  });

  /**
   * Would break on upgrade. Every build before the scope existed wrote a bare
   * namespace here, and a reader whose window reopened on "all namespaces"
   * because of it would have lost a setting they never touched.
   */
  it("reads a single namespace written by an older build", () => {
    expect(decodeScope("prod")).toEqual(["prod"]);
    expect(decodeScope("")).toEqual([]);
    expect(decodeScope(undefined)).toEqual([]);
  });

  /** Builds of this feature that predate the wire-value rule wrote one. */
  it("still parses a joined selection", () => {
    expect(decodeScope("prod,,prod, staging ")).toEqual(["prod", "staging"]);
  });
});

describe("what a window is allowed to watch", () => {
  /**
   * Would take the ceiling off the requests a selection costs: a dozen per
   * namespace in every overview poll, and one per namespace in the events
   * feed's.
   */
  it("cuts a selection to what the app can answer for", () => {
    const asked = Array.from({ length: SCOPE_LIMIT + 3 }, (_, i) => `ns-${i}`);
    expect(clampScope(asked)).toHaveLength(SCOPE_LIMIT);
    expect(clampScope(asked)[0]).toBe("ns-0");
    expect(clampScope(["prod"])).toEqual(["prod"]);
    expect(clampScope([])).toEqual([]);
  });

  it("compares two selections without stringifying them", () => {
    expect(sameScope(["prod", "staging"], ["prod", "staging"])).toBe(true);
    expect(sameScope(["prod"], ["prod", "staging"])).toBe(false);
    expect(sameScope([], [])).toBe(true);
  });
});

describe("what is in scope", () => {
  it("is everything when nothing is selected", () => {
    expect(inScope([], "prod")).toBe(true);
    expect(inScope([], null)).toBe(true);
  });

  it("is the selection when there is one", () => {
    expect(inScope(["prod", "staging"], "prod")).toBe(true);
    expect(inScope(["prod", "staging"], "dev")).toBe(false);
  });

  /**
   * Would break if the Nodes or StorageClasses page emptied itself the moment
   * somebody narrowed the window. A cluster-scoped object is in no namespace
   * and does not stop existing because of a namespace filter — the filter was
   * never asked about it.
   */
  it("keeps cluster-scoped objects under any selection", () => {
    expect(inScope(["prod"], null)).toBe(true);
    expect(inScope(["prod"], undefined)).toBe(true);
  });
});

describe("what the scope is called", () => {
  it("names one and two, and counts past that", () => {
    expect(scopeLabel([], t)).toBe("All namespaces");
    expect(scopeLabel(["prod"], t)).toBe("prod");
    expect(scopeLabel(["prod", "staging"], t)).toBe("prod, staging");
    expect(scopeLabel(["a", "b", "c"], t)).toBe("3 namespaces");
    expect(scopeIn([], t)).toBe("any namespace");
    expect(scopeIn(["prod", "staging"], t)).toBe("2 namespaces");
  });
});

describe("the items a scoped rail counts", () => {
  const rows = [
    { namespace: "apps", name: "a" },
    { namespace: "edge", name: "b" },
  ];

  /** The defect this exists for. `""` is the app's word for "the whole
   *  cluster" — the store types it `string`, never `null` — so a `== null`
   *  test against the raw value compiles, is never true, and filters every
   *  row away. The sidebar read "Routes 0" above a page listing forty, and
   *  the red dot for a broken route went out with them. */
  it("counts everything when no namespace is picked", () => {
    expect(inNamespace(rows, "")).toHaveLength(2);
    expect(inNamespace(rows, null)).toHaveLength(2);
  });

  it("counts one namespace when one is picked", () => {
    expect(inNamespace(rows, "apps").map((r) => r.name)).toEqual(["a"]);
  });

  /** A namespace that holds none of them is an answer, not a reason to
   *  fall back to all of them. */
  it("counts none when the picked namespace holds none", () => {
    expect(inNamespace(rows, "kube-system")).toHaveLength(0);
  });
});

describe("reading a list across the selection", () => {
  it("keys a multi-namespace selection apart from a single one and the cluster", () => {
    expect(scopeCacheKey([])).toBeNull();
    expect(scopeCacheKey(["prod"])).toBe("prod");
    // Sorted and joined, so the same two namespaces in either order share a
    // key, and a comma is a thing no real namespace name can hold.
    expect(scopeCacheKey(["staging", "prod"])).toBe("prod,staging");
    expect(scopeCacheKey(["prod", "staging"])).toBe(
      scopeCacheKey(["staging", "prod"])
    );
  });

  /**
   * Would break if an empty selection were sent as `[]`: the backend refuses
   * that rather than reading it as the whole cluster.
   */
  it("hands the backend the cluster as nothing and a selection as its names", () => {
    expect(wireScope([])).toBeNull();
    expect(wireScope(["prod"])).toEqual(["prod"]);
    expect(wireScope(["prod", "staging"])).toEqual(["prod", "staging"]);
  });

  /**
   * Would break if the kinds' answers were joined on rows alone: a namespace
   * one kind could not read would vanish from the page, and the count beside
   * it would read as the whole scope's.
   */
  it("joins several answers without losing a namespace any of them could not read", () => {
    const refused = {
      namespace: "staging",
      code: "PERMISSION_DENIED",
      message: "httproutes is forbidden",
    };
    const joined = joinScoped([
      { rows: ["prod/a"], unread: [refused] },
      { rows: ["prod/b"], unread: [{ ...refused, message: "second" }] },
      whole(["prod/c"]),
    ]);
    expect(joined.rows).toEqual(["prod/a", "prod/b", "prod/c"]);
    expect(joined.unread).toEqual([refused]);
  });

  it("names the namespaces that answered", () => {
    expect(
      answeredIn(
        ["prod", "staging", "dev"],
        [{ namespace: "staging", code: "PERMISSION_DENIED", message: "" }]
      )
    ).toEqual(["prod", "dev"]);
  });
});
