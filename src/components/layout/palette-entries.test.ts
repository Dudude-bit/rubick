import { describe, expect, it } from "vitest";

import type { ClusterSearchState, SearchHit } from "@/hooks/useResourceSearch";
import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import { getResourceDetailUrl } from "@/lib/navigation-utils";
import {
  buildPaletteEntries,
  ROWS_PER_CLUSTER,
  type Entry,
  type PaletteState,
} from "./palette-entries";

const t: T = (section, key, values) => translate("en", section, key, values);

function state(overrides: Partial<PaletteState> = {}): PaletteState {
  return {
    text: "",
    scope: { kind: "current" },
    contexts: [{ name: "k3d-dev" }, { name: "prod-eu" }],
    currentContext: "k3d-dev",
    marks: {},
    recentItems: [],
    isConnected: true,
    error: null,
    shownClusters: [],
    hitsByContext: new Map(),
    t,
    ...overrides,
  };
}

function cluster(
  context: string,
  status: ClusterSearchState["status"] = "done",
  reason: ClusterSearchState["reason"] = null
): ClusterSearchState {
  return {
    context,
    status,
    reason,
    message: null,
    matched: 0,
    truncated: false,
  };
}

function pods(context: string, n: number): SearchHit[] {
  return Array.from({ length: n }, (_, i) => ({
    context,
    kind: "Pod",
    name: `api-${i}`,
    namespace: "default",
  }));
}

/** Keyed the way the palette keys them: by cluster, then by object. */
function byContext(hits: SearchHit[]): Map<string, Map<string, SearchHit>> {
  const grouped = new Map<string, Map<string, SearchHit>>();
  for (const hit of hits) {
    const bucket = grouped.get(hit.context) ?? new Map<string, SearchHit>();
    bucket.set(`${hit.kind}/${hit.namespace ?? ""}/${hit.name}`, hit);
    grouped.set(hit.context, bucket);
  }
  return grouped;
}

const ids = (entries: Entry[]) => entries.map((entry) => entry.id);

function hintText(entries: Entry[]): unknown {
  const hint = entries.find((entry) => entry.kind === "hint");
  return hint?.kind === "hint" ? hint.text : undefined;
}

describe("the palette's entries with nothing typed", () => {
  /**
   * Recent objects are what a reader opens the palette for most often;
   * pushed under Navigation they fall below the fold of a short window.
   */
  it("lists recents, then navigation and settings, then the activity panels", () => {
    const entries = buildPaletteEntries(
      state({
        recentItems: [
          {
            path: "/workloads/pods/default/api-0",
            name: "api-0",
            kind: "Pod",
            namespace: "default",
            timestamp: 1,
          },
        ],
      })
    );

    expect(ids(entries)).toEqual([
      "cap:recent",
      "recent:/workloads/pods/default/api-0",
      "cap:nav",
      "nav:/",
      "nav:/workloads/pods",
      "nav:/workloads/deployments",
      "nav:/network/services",
      "nav:/nodes",
      "nav:/configuration/configmaps",
      "nav:/configuration/secrets",
      "nav:/events",
      "nav:/helm",
      "settings",
      "cap:activity",
      "panel:ports",
      "panel:terminals",
    ]);
  });

  /**
   * A scope chip means "search over there", and pages of this window are
   * not over there: offering them under it would open the wrong cluster.
   */
  it("offers only the scope hint under a cluster chip", () => {
    const entries = buildPaletteEntries(
      state({ scope: { kind: "context", context: "prod-eu" } })
    );

    expect(ids(entries)).toEqual(["hint:scoped"]);
    expect(hintText(entries)).toBe("Type to search prod-eu.");
  });
});

describe("the palette's entries while typing", () => {
  /**
   * Typing narrows the links instead of hiding them, so "go to pods" is
   * one word away; without the filter every link stays and Enter lands on
   * Overview.
   */
  it("keeps only the links whose words match the query", () => {
    const entries = buildPaletteEntries(
      state({ text: "helm", shownClusters: [cluster("k3d-dev")] })
    );

    expect(
      entries.filter((entry) => entry.kind === "link").map((e) => e.id)
    ).toEqual(["nav:/helm"]);
    expect(entries.some((entry) => entry.kind === "settings")).toBe(false);
    expect(entries.some((entry) => entry.kind === "panel")).toBe(false);
  });

  /**
   * One character would match most of the cluster; the backend refuses it,
   * and saying nothing would read as "no such object".
   */
  it("asks for a longer query instead of searching one character", () => {
    const entries = buildPaletteEntries(state({ text: "a" }));

    expect(ids(entries).slice(-2)).toEqual(["cap:res", "hint:short"]);
  });

  /** With no connection there is nothing to search, and that is said. */
  it("says to connect first when this window is on no cluster", () => {
    const entries = buildPaletteEntries(
      state({ text: "api", isConnected: false })
    );

    expect(ids(entries).slice(-2)).toEqual(["cap:res", "hint:offline"]);
  });

  /** A search that failed shows the failure, not an empty result. */
  it("shows the search error in place of results", () => {
    const entries = buildPaletteEntries(
      state({
        text: "api",
        error: "search refused",
        shownClusters: [cluster("k3d-dev")],
      })
    );

    expect(ids(entries).slice(-2)).toEqual(["cap:res", "hint:error"]);
    expect(hintText(entries)).toBe("search refused");
  });
});

describe("the palette's resource rows", () => {
  /**
   * Each cluster's row heads its own hits. Interleaved, a hit from prod
   * reads as a hit from dev, and Enter opens it in the wrong cluster's tab.
   */
  it("puts every cluster's hits under that cluster's row", () => {
    const entries = buildPaletteEntries(
      state({
        text: "api",
        scope: { kind: "all" },
        shownClusters: [cluster("k3d-dev"), cluster("prod-eu")],
        hitsByContext: byContext([
          ...pods("prod-eu", 1),
          ...pods("k3d-dev", 1),
        ]),
      })
    );

    expect(ids(entries)).toEqual([
      "grp:k3d-dev",
      "hit:k3d-dev/Pod/default/api-0",
      "grp:prod-eu",
      "hit:prod-eu/Pod/default/api-0",
    ]);
  });

  /**
   * Twenty hits from one cluster would push every other cluster below the
   * fold, the failed one included; the rest is one row away instead.
   */
  it("caps each cluster's hits when several clusters answer, and counts the rest", () => {
    const entries = buildPaletteEntries(
      state({
        text: "api",
        scope: { kind: "all" },
        shownClusters: [cluster("k3d-dev"), cluster("prod-eu")],
        hitsByContext: byContext(pods("k3d-dev", ROWS_PER_CLUSTER + 3)),
      })
    );

    const dev = entries.filter(
      (entry) => entry.kind === "hit" && entry.hit.context === "k3d-dev"
    );
    expect(dev).toHaveLength(ROWS_PER_CLUSTER);
    expect(entries).toContainEqual({
      id: "more:k3d-dev",
      kind: "more",
      context: "k3d-dev",
      rest: 3,
    });
  });

  /** One cluster has nobody to share the screen with, so nothing is held back. */
  it("shows every hit when only one cluster is searched", () => {
    const entries = buildPaletteEntries(
      state({
        text: "api",
        shownClusters: [cluster("k3d-dev")],
        hitsByContext: byContext(pods("k3d-dev", ROWS_PER_CLUSTER + 3)),
      })
    );

    expect(entries.filter((entry) => entry.kind === "hit")).toHaveLength(
      ROWS_PER_CLUSTER + 3
    );
    expect(entries.some((entry) => entry.kind === "more")).toBe(false);
  });

  /**
   * Enter on a cluster's row does what that cluster needs: a cold one is
   * woken, a failed one asked again, one that answered does nothing.
   */
  it("gives a cold cluster's row search-it and a failed one's retry", () => {
    const entries = buildPaletteEntries(
      state({
        text: "api",
        scope: { kind: "all" },
        shownClusters: [
          cluster("k3d-dev"),
          cluster("prod-eu", "skipped", "not-connected"),
          cluster("stage", "failed", "unreachable"),
        ],
      })
    );

    const actions = Object.fromEntries(
      entries.flatMap((entry) =>
        entry.kind === "group" ? [[entry.cluster.context, entry.action]] : []
      )
    );
    expect(actions).toEqual({
      "k3d-dev": "none",
      "prod-eu": "search-it",
      stage: "retry",
    });
  });

  /**
   * A Namespace is a scope to switch to, not a page; a kind with no page
   * would blank the shell if offered, so it is left out.
   */
  it("opens objects on their page, namespaces as a scope, and drops the unroutable", () => {
    const entries = buildPaletteEntries(
      state({
        text: "api",
        shownClusters: [cluster("k3d-dev")],
        hitsByContext: byContext([
          {
            context: "k3d-dev",
            kind: "Pod",
            name: "api-0",
            namespace: "default",
          },
          {
            context: "k3d-dev",
            kind: "Namespace",
            name: "api",
            namespace: null,
          },
          {
            context: "k3d-dev",
            kind: "Widget",
            name: "api",
            namespace: "default",
          },
        ]),
      })
    );

    const paths = entries.flatMap((entry) =>
      entry.kind === "hit" ? [[entry.hit.kind, entry.path]] : []
    );
    expect(paths).toEqual([
      ["Pod", getResourceDetailUrl("Pod", "api-0", "default")],
      ["Namespace", null],
    ]);
  });

  /**
   * "Nothing matches" while a cluster is still answering is a verdict
   * before the evidence; the count of who has answered is the honest line.
   */
  it("says how many clusters have answered instead of no results while one is still searching", () => {
    const entries = buildPaletteEntries(
      state({
        text: "api",
        scope: { kind: "all" },
        shownClusters: [cluster("k3d-dev"), cluster("prod-eu", "searching")],
      })
    );

    expect(hintText(entries)).toBe(
      "No matches yet — 1 of 2 clusters have answered."
    );
  });

  /** Only once every cluster has answered is an empty list the answer. */
  it("says nothing matches once every cluster has answered", () => {
    const entries = buildPaletteEntries(
      state({ text: "api", shownClusters: [cluster("k3d-dev")] })
    );

    expect(hintText(entries)).toBe("Nothing matches “api”.");
  });

  /**
   * A failed cluster has answered, and searched nothing. Counted as searched,
   * its row said "failed — retry" under a hint saying nothing matches.
   */
  it("counts only the clusters whose search completed in an empty result", () => {
    const entries = buildPaletteEntries(
      state({
        text: "api",
        scope: { kind: "all" },
        shownClusters: [
          cluster("k3d-dev"),
          cluster("stage", "failed", "forbidden"),
        ],
      })
    );

    expect(hintText(entries)).toBe(
      "Nothing matches “api” on the 1 of 2 clusters that were searched."
    );
  });

  /** One cluster, and its search failed: nothing was searched at all. */
  it("says nothing was searched when no cluster's search completed", () => {
    const entries = buildPaletteEntries(
      state({
        text: "api",
        shownClusters: [cluster("k3d-dev", "failed", "unreachable")],
      })
    );

    expect(hintText(entries)).toBe(
      "Nothing has been searched: the search did not complete on any cluster here."
    );
  });

  /** Where every cluster is cold, the reason is that none is connected. */
  it("says no cluster is connected when every one was skipped for it", () => {
    const entries = buildPaletteEntries(
      state({
        text: "api",
        scope: { kind: "all" },
        shownClusters: [
          cluster("k3d-dev", "skipped", "not-connected"),
          cluster("prod-eu", "skipped", "not-connected"),
        ],
      })
    );

    expect(hintText(entries)).toBe(
      "Nothing has been searched: no cluster here is connected yet."
    );
  });
});

describe("the palette's entries after a bang", () => {
  /**
   * A bang picks a cluster, so the page links and the search are not
   * offered; `*` stays first so every cluster is one Enter away.
   */
  it("lists only the clusters, every-cluster first", () => {
    const entries = buildPaletteEntries(state({ text: "!" }));

    expect(ids(entries)).toEqual([
      "cap:clusters",
      "ctx:*",
      "ctx:k3d-dev",
      "ctx:prod-eu",
    ]);
  });

  /** The live cluster is marked apart from the ones a pick would connect to. */
  it("marks which cluster is live", () => {
    const entries = buildPaletteEntries(state({ text: "!" }));

    const meta = Object.fromEntries(
      entries.flatMap((entry) =>
        entry.kind === "cluster" ? [[entry.context, entry.meta]] : []
      )
    );
    expect(meta).toEqual({ "k3d-dev": "live", "prod-eu": "not connected" });
  });

  /** An empty list after a bang would read as a broken palette, not an answer. */
  it("says no cluster answers to a needle that matches none", () => {
    const entries = buildPaletteEntries(state({ text: "!zzz" }));

    expect(ids(entries)).toEqual(["cap:clusters", "hint:no-cluster"]);
  });
});
