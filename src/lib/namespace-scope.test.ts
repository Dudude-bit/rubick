import { describe, expect, it } from "vitest";

import {
  SCOPE_LIMIT,
  clampScope,
  decodeScope,
  inScope,
  sameScope,
  scopeIn,
  scopeLabel,
  wireNamespace,
} from "./namespace-scope";

describe("what the backend is told", () => {
  /**
   * Would break if a multi-namespace scope ever reached a list command. Every
   * one of them takes one namespace, so several has to ask for the cluster
   * and narrow afterwards — sending `"a,b"` would ask for a namespace that
   * does not exist and quietly return nothing.
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
   * Would put the cost of the overview back where `lib/refresh.ts` found it:
   * one poll per selected namespace, and no ceiling on the selection.
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
    expect(scopeLabel([])).toBe("All namespaces");
    expect(scopeLabel(["prod"])).toBe("prod");
    expect(scopeLabel(["prod", "staging"])).toBe("prod, staging");
    expect(scopeLabel(["a", "b", "c"])).toBe("3 namespaces");
    expect(scopeIn([])).toBe("any namespace");
    expect(scopeIn(["prod", "staging"])).toBe("2 namespaces");
  });
});
