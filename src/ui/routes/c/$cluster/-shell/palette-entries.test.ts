// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from "vite-plus/test";
import { createMemoryHistory, createRouter } from "@tanstack/react-router";
import { QueryClient } from "@tanstack/react-query";

import { routeTree } from "@/generated/routeTree.gen";
import type { ClusterSearchState, SearchHit } from "./useResourceSearch";
import { catalogGroups } from "../api-resources/-components/catalog-groups";
import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import { hrefOf, setRouter, type AppLink } from "@/lib/links";
import { Box } from "lucide-react";
import {
  buildActionEntries,
  buildPaletteEntries,
  hitKey,
  isSelectable,
  ROWS_PER_CLUSTER,
  type Entry,
  type PaletteState,
  byKindName,
  orderHits,
} from "./palette-entries";

const t: T = (section, key, values) => translate("en", section, key, values);

/** The window the links resolve from, as the app's own router would. */
beforeAll(async () => {
  const router = createRouter({
    routeTree,
    context: { queryClient: new QueryClient() },
    history: createMemoryHistory({ initialEntries: ["/c/k3d-dev"] }),
  });
  setRouter(router);
  await router.load();
});

const where = (link: AppLink | null) => (link ? hrefOf(link) : null);

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
    searched: [],
    unreadable: [],
    loading: [],
  };
}

function pods(context: string, n: number): SearchHit[] {
  return Array.from({ length: n }, (_, i) => ({
    context,
    kind: "Pod",
    group: "",
    plural: "pods",
    name: `api-${i}`,
    namespace: "default",
  }));
}

/** Keyed the way the palette keys them: by cluster, then by object. */
function byContext(hits: SearchHit[]): Map<string, Map<string, SearchHit>> {
  const grouped = new Map<string, Map<string, SearchHit>>();
  for (const hit of hits) {
    const bucket = grouped.get(hit.context) ?? new Map<string, SearchHit>();
    bucket.set(hitKey(hit), hit);
    grouped.set(hit.context, bucket);
  }
  return grouped;
}

const ids = (entries: Entry[]) => entries.map((entry) => entry.id);

function hintText(entries: Entry[]): unknown {
  const hint = entries.find((entry) => entry.kind === "hint");
  return hint?.kind === "hint" ? hint.text : undefined;
}

function hintTone(entries: Entry[]): unknown {
  const hint = entries.find((entry) => entry.kind === "hint");
  return hint?.kind === "hint" ? hint.tone : undefined;
}

const read = (kind: string, group = "", plural = `${kind.toLowerCase()}s`) => ({
  kind,
  group,
  plural,
});

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
            name: "api-0",
            kind: "Pod",
            namespace: "default",
            context: "k3d-dev",
            timestamp: 1,
          },
        ],
      })
    );

    expect(ids(entries)).toEqual([
      "cap:recent",
      "recent:k3d-dev/Pod/default/api-0",
      "cap:nav",
      "nav:goToOverview",
      "nav:goToPods",
      "nav:goToDeployments",
      "nav:goToServices",
      "nav:goToNodes",
      "nav:goToConfigMaps",
      "nav:goToSecrets",
      "nav:goToEvents",
      "nav:goToHelm",
      "nav:goToApiResources",
      "nav:goToMyAccess",
      "settings",
      "cap:activity",
      "panel:ports",
      "panel:terminals",
    ]);
    expect(
      entries.flatMap((entry) =>
        entry.kind === "link" ? [where(entry.path)] : []
      )
    ).toEqual([
      "/c/k3d-dev",
      "/c/k3d-dev/pods",
      "/c/k3d-dev/deployments",
      "/c/k3d-dev/services",
      "/c/k3d-dev/nodes",
      "/c/k3d-dev/configmaps",
      "/c/k3d-dev/secrets",
      "/c/k3d-dev/events",
      "/c/k3d-dev/helm",
      "/c/k3d-dev/api-resources",
      "/c/k3d-dev/my-access",
    ]);
  });

  /** A recent saved before it named its cluster could open in the wrong one, so it is not offered. */
  it("leaves out a recent that names no cluster", () => {
    const entries = buildPaletteEntries(
      state({
        recentItems: [
          {
            name: "api-0",
            kind: "Pod",
            namespace: "default",
            timestamp: 1,
          },
        ],
      })
    );

    expect(entries.some((entry) => entry.kind === "recent")).toBe(false);
    expect(ids(entries)).not.toContain("cap:recent");
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
    ).toEqual(["nav:goToHelm"]);
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
      "cov:k3d-dev",
      "grp:prod-eu",
      "hit:prod-eu/Pod/default/api-0",
      "cov:prod-eu",
    ]);
  });

  /**
   * Marco typed "checkout" and five of the seventeen matches were objects
   * called something else in a namespace called team-checkout. Fails if a
   * namespace-only match ranks among the name matches, or goes unsaid.
   */
  it("ranks the matches that only the namespace made after the name matches, under a caption", () => {
    const hit = (name: string, namespace: string): SearchHit => ({
      context: "k3d-dev",
      kind: "Pod",
      group: "",
      plural: "pods",
      name,
      namespace,
    });
    const entries = buildPaletteEntries(
      state({
        text: "checkout",
        shownClusters: [cluster("k3d-dev")],
        hitsByContext: byContext([
          hit("migrate-db-8hblx", "team-checkout"),
          hit("checkout-api-0", "team-checkout"),
          hit("sidecar-1", "team-checkout"),
        ]),
      })
    );

    expect(ids(entries).slice(0, 6)).toEqual([
      "grp:k3d-dev",
      "hit:k3d-dev/Pod/team-checkout/checkout-api-0",
      "cap:ns:k3d-dev",
      "hit:k3d-dev/Pod/team-checkout/migrate-db-8hblx",
      "hit:k3d-dev/Pod/team-checkout/sidecar-1",
      "cov:k3d-dev",
    ]);
    const caption = entries.find((entry) => entry.id === "cap:ns:k3d-dev");
    expect(caption).toMatchObject({
      text: "Only the namespace matches checkout",
    });
  });

  /** A search every hit of which is a name match has nothing to apologise for. */
  it("adds no caption when every match is by name", () => {
    const entries = buildPaletteEntries(
      state({
        text: "api",
        shownClusters: [cluster("k3d-dev")],
        hitsByContext: byContext(pods("k3d-dev", 2)),
      })
    );
    expect(ids(entries).some((id) => id.startsWith("cap:ns:"))).toBe(false);
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

  /**
   * The cap was spent before the unroutable hits were dropped: five hits
   * with no address took every slot, none was drawn, and "3 more" sat under
   * "Nothing matches" for the three pods nobody was shown.
   */
  it("spends a cluster's rows on hits it can open, not on the ones it drops", () => {
    const widgets: SearchHit[] = Array.from(
      { length: ROWS_PER_CLUSTER },
      (_, i) => ({
        context: "k3d-dev",
        kind: "Pod",
        group: "",
        plural: "pods",
        name: `api-w${i}`,
        namespace: null,
      })
    );
    const entries = buildPaletteEntries(
      state({
        text: "api",
        scope: { kind: "all" },
        shownClusters: [cluster("k3d-dev"), cluster("prod-eu")],
        hitsByContext: byContext([...widgets, ...pods("k3d-dev", 3)]),
      })
    );

    const dev = entries.flatMap((entry) =>
      entry.kind === "hit" && entry.hit.context === "k3d-dev"
        ? [entry.hit.name]
        : []
    );
    expect(dev).toEqual(["api-0", "api-1", "api-2"]);
    expect(entries.some((entry) => entry.kind === "more")).toBe(false);
    expect(entries.some((entry) => entry.kind === "hint")).toBe(false);
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
   * A Namespace is a scope to switch to, not a page. A kind with no page of
   * its own opens where every served kind does, by its group and plural; a
   * ServiceAccount found and then dropped read as no ServiceAccount at all.
   */
  it("opens objects on their page, namespaces as a scope, and other served kinds on the generic page", () => {
    const entries = buildPaletteEntries(
      state({
        text: "api",
        shownClusters: [cluster("k3d-dev")],
        hitsByContext: byContext([
          {
            context: "k3d-dev",
            kind: "Pod",
            group: "",
            plural: "pods",
            name: "api-0",
            namespace: "default",
          },
          {
            context: "k3d-dev",
            kind: "Namespace",
            group: "",
            plural: "namespaces",
            name: "api",
            namespace: null,
          },
          {
            context: "k3d-dev",
            kind: "ServiceAccount",
            group: "",
            plural: "serviceaccounts",
            name: "api",
            namespace: "default",
          },
          {
            context: "k3d-dev",
            kind: "Lease",
            group: "coordination.k8s.io",
            plural: "leases",
            name: "api",
            namespace: "kube-system",
          },
        ]),
      })
    );

    const paths = entries.flatMap((entry) =>
      entry.kind === "hit" ? [[entry.hit.kind, where(entry.path)]] : []
    );
    expect(paths).toEqual([
      ["Namespace", null],
      ["Lease", "/c/k3d-dev/leases.coordination.k8s.io/kube-system/api"],
      ["ServiceAccount", "/c/k3d-dev/serviceaccounts/default/api"],
      ["Pod", "/c/k3d-dev/pods/default/api-0"],
    ]);
  });

  /**
   * A hit from another cluster opens there; resolved against the window's
   * own cluster it would name an object that cluster does not have.
   */
  it("links a hit into the cluster it was found in", () => {
    const entries = buildPaletteEntries(
      state({
        text: "api",
        scope: { kind: "all" },
        shownClusters: [cluster("k3d-dev"), cluster("prod-eu")],
        hitsByContext: byContext(pods("prod-eu", 1)),
      })
    );

    expect(
      entries.flatMap((entry) =>
        entry.kind === "hit" ? [where(entry.path)] : []
      )
    ).toEqual(["/c/prod-eu/pods/default/api-0"]);
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
      "No matches yet: 1 of 2 clusters have answered."
    );
    expect(hintTone(entries)).toBe("loading");
  });

  /**
   * Only once every kind it names was read is an empty list the answer, and
   * it names them: a bare "Nothing matches" read as "does not exist" over
   * kinds the search never looked at.
   */
  it("names the kinds an empty answer covers once every one was read", () => {
    const entries = buildPaletteEntries(
      state({
        text: "api",
        shownClusters: [
          { ...cluster("k3d-dev"), searched: [read("Pod"), read("Service")] },
        ],
      })
    );

    expect(hintText(entries)).toBe(
      "No object matches “api” in the 2 kinds searched."
    );
    expect(hintTone(entries)).toBe("empty");
  });

  /** The served kinds it did not look at are part of the answer, not a footnote. */
  it("says how many served kinds an empty answer did not search", () => {
    const entries = buildPaletteEntries(
      state({
        text: "api",
        shownClusters: [{ ...cluster("k3d-dev"), searched: [read("Pod")] }],
        kinds: [
          {
            ...read("Pod"),
            version: "v1",
            namespaced: true,
            verbs: ["list"],
            shortNames: [],
          },
          {
            ...read("Widget", "demo.example.com"),
            version: "v1",
            namespaced: true,
            verbs: ["list"],
            shortNames: [],
          },
        ],
      })
    );

    expect(hintText(entries)).toBe(
      "No object matches “api” in the 1 kind searched. 1 other kind was not searched."
    );
  });

  /**
   * One cluster still reading has said nothing yet; "0 of 1 clusters have
   * answered" was the only sentence it had, and a kind still loading is
   * named apart from a search that has not finished.
   */
  it("says the one cluster is still reading, and how many kinds are still loading", () => {
    const searching = buildPaletteEntries(
      state({ text: "api", shownClusters: [cluster("k3d-dev", "searching")] })
    );
    expect(hintText(searching)).toBe("Still reading names for “api”…");
    expect(hintTone(searching)).toBe("loading");

    const loading = buildPaletteEntries(
      state({
        text: "api",
        shownClusters: [
          {
            ...cluster("k3d-dev"),
            searched: [read("Pod")],
            loading: [read("Widget", "demo.example.com")],
          },
        ],
      })
    );
    expect(hintText(loading)).toBe(
      "No object matches “api” in what has been read; 1 kind is still loading."
    );
    expect(hintTone(loading)).toBe("loading");
  });

  /**
   * "Leases" found the Lease kind and said "Nothing matches Leases" under
   * it. The sentence is about objects, so it cannot contradict a kind row.
   */
  it("words an empty answer about objects, beside a kind that matched", () => {
    const entries = buildPaletteEntries(
      state({
        text: "Leases",
        shownClusters: [
          {
            ...cluster("k3d-dev"),
            searched: [read("Lease", "coordination.k8s.io")],
          },
        ],
        kinds: [
          {
            ...read("Lease", "coordination.k8s.io"),
            version: "v1",
            namespaced: true,
            verbs: ["list"],
            shortNames: [],
          },
        ],
      })
    );

    expect(entries.some((entry) => entry.kind === "kind")).toBe(true);
    expect(String(hintText(entries))).toMatch(/^No object matches/);
    expect(String(hintText(entries))).not.toMatch(/Nothing matches/);
  });

  /** Several clusters read whole say which they covered, not that nothing exists. */
  it("names the clusters a whole empty answer covers", () => {
    const entries = buildPaletteEntries(
      state({
        text: "api",
        scope: { kind: "all" },
        shownClusters: [cluster("k3d-dev"), cluster("prod-eu")],
      })
    );
    expect(hintText(entries)).toBe(
      "No object matches “api” in the kinds searched on 2 clusters."
    );
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
      "No object matches “api” on the 1 of 2 clusters that were searched."
    );
    expect(hintTone(entries)).toBe("unread");
  });

  /**
   * A cluster that listed Pods and was refused Services has not searched
   * Services. Counted as searched, it said "Nothing matches" over objects
   * the reader simply could not see.
   */
  it("does not say nothing matches over a cluster that could not read some kinds", () => {
    const entries = buildPaletteEntries(
      state({
        text: "api",
        shownClusters: [
          {
            ...cluster("k3d-dev"),
            unreadable: [
              {
                kind: "Service",
                group: "",
                plural: "services",
                reason: "forbidden",
                message: "services is forbidden",
              },
            ],
          },
        ],
      })
    );

    expect(hintText(entries)).toBe(
      "No object matches “api” in the kinds that could be read."
    );
    expect(hintTone(entries)).toBe("unread");
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

describe("kinds the cluster serves", () => {
  const kinds = [
    {
      group: "coordination.k8s.io",
      version: "v1",
      kind: "Lease",
      plural: "leases",
      namespaced: true,
      verbs: ["list"],
      shortNames: [],
    },
    {
      group: "",
      version: "v1",
      kind: "Pod",
      plural: "pods",
      namespaced: true,
      verbs: ["list"],
      shortNames: [],
    },
    {
      group: "scheduling.k8s.io",
      version: "v1",
      kind: "PriorityClass",
      plural: "priorityclasses",
      namespaced: false,
      verbs: ["list"],
      shortNames: [],
    },
  ];
  const offered = (text: string, overrides: Partial<PaletteState> = {}) =>
    buildPaletteEntries(state({ text, kinds, ...overrides })).flatMap(
      (entry) => (entry.kind === "kind" ? [entry] : [])
    );

  /** "Leases" in the palette said Nothing matches, while the cluster served Leases. */
  it("offers a kind by its plural, opening its list", () => {
    const [lease] = offered("Leases");
    expect(lease.entry.kind).toBe("Lease");
    expect(where(lease.path)).toBe("/c/k3d-dev/leases.coordination.k8s.io");
  });

  it("opens a kind with a page of its own on that page", () => {
    expect(where(offered("pod")[0].path)).toBe("/c/k3d-dev/pods");
  });

  it("puts a whole name before a name that only contains it", () => {
    expect(offered("priority").map((entry) => entry.entry.kind)).toEqual([
      "PriorityClass",
    ]);
    expect(offered("e").length).toBeGreaterThan(1);
  });

  it("offers no kind with nothing typed, or with no cluster", () => {
    expect(offered("")).toEqual([]);
    expect(offered("lease", { isConnected: false })).toEqual([]);
  });

  it("offers the page that lists them all", () => {
    const links = buildPaletteEntries(state({ text: "api res" })).flatMap(
      (entry) => (entry.kind === "link" ? [entry] : [])
    );
    expect(links.map((entry) => where(entry.path))).toContain(
      "/c/k3d-dev/api-resources"
    );
  });
});

describe("what a name search covered", () => {
  const served = (
    kind: string,
    group: string,
    plural: string,
    verbs = ["list"]
  ) => ({
    group,
    version: "v1",
    kind,
    plural,
    namespaced: true,
    verbs,
    shortNames: [],
  });
  const catalogue = [
    served("Pod", "", "pods"),
    served("ServiceAccount", "", "serviceaccounts"),
    served("Lease", "coordination.k8s.io", "leases"),
    served("Widget", "demo.example.com", "widgets"),
    served("PriorityClass", "scheduling.k8s.io", "priorityclasses"),
    served("TokenReview", "authentication.k8s.io", "tokenreviews", ["create"]),
  ];
  const read = (kind: string, group: string, plural: string) => ({
    kind,
    group,
    plural,
  });
  const answered: ClusterSearchState = {
    ...cluster("k3d-dev"),
    searched: [
      read("Pod", "", "pods"),
      read("Lease", "coordination.k8s.io", "leases"),
    ],
    unreadable: [
      {
        ...read("ServiceAccount", "", "serviceaccounts"),
        reason: "forbidden",
        message: "serviceaccounts is forbidden",
      },
    ],
  };
  const coverage = (entries: Entry[]) =>
    entries.flatMap((entry) => (entry.kind === "coverage" ? [entry] : []));

  /**
   * "Nothing matches marco" read as "marco does not exist" while it meant "I
   * did not look at ServiceAccounts". The line under the results says which
   * kinds were compared, in which namespaces, and which served kinds were
   * not: listable ones only, a kind that cannot be listed has no names.
   */
  it("says which kinds were read, where, and which served kinds were not", () => {
    const entries = buildPaletteEntries(
      state({
        text: "marco",
        shownClusters: [answered],
        kinds: catalogue,
        scopeLabel: "team-checkout",
      })
    );

    const [line] = coverage(entries);
    expect(line.scope).toBe("team-checkout");
    expect(line.notSearched?.map((entry) => entry.kind)).toEqual([
      "Widget",
      "PriorityClass",
    ]);
    expect(entries).toContainEqual({
      id: "search-more",
      kind: "search-more",
      count: 2,
    });
  });

  /**
   * Lena's Ctrl+K said "28 kinds searched, 47 not searched", 75, beside API
   * resources' 82: the seven kinds a cluster serves only to create (Binding,
   * TokenReview and the access reviews) were in neither number. Fails if a
   * served kind is left out of the line, or the line and API resources count
   * the catalogue differently.
   */
  it("accounts for every kind API resources counts, the ones no list can read included", () => {
    const createOnly = [
      served("Binding", "", "bindings", ["create"]),
      served(
        "SelfSubjectReview",
        "authentication.k8s.io",
        "selfsubjectreviews",
        ["create"]
      ),
      served(
        "LocalSubjectAccessReview",
        "authorization.k8s.io",
        "localsubjectaccessreviews",
        ["create"]
      ),
      served(
        "SelfSubjectAccessReview",
        "authorization.k8s.io",
        "selfsubjectaccessreviews",
        ["create"]
      ),
      served(
        "SelfSubjectRulesReview",
        "authorization.k8s.io",
        "selfsubjectrulesreviews",
        ["create"]
      ),
      served(
        "SubjectAccessReview",
        "authorization.k8s.io",
        "subjectaccessreviews",
        ["create"]
      ),
    ];
    const kinds = [...catalogue, ...createOnly];
    const [line] = coverage(
      buildPaletteEntries(
        state({ text: "marco", shownClusters: [answered], kinds })
      )
    );

    const accounted =
      line.cluster.searched.length +
      line.cluster.loading.length +
      line.cluster.unreadable.length +
      (line.notSearched?.length ?? 0) +
      (line.unlistable?.length ?? 0);
    expect(accounted).toBe(
      catalogGroups({ entries: kinds, unread: [] }, "").kinds
    );
    expect(line.unlistable?.map((entry) => entry.kind)).toEqual([
      "TokenReview",
      ...createOnly.map((entry) => entry.kind),
    ]);
  });

  /** Once every kind is being read, offering to read them is a button that does nothing. */
  it("offers no second search once every kind is read, and still names what was left", () => {
    const entries = buildPaletteEntries(
      state({
        text: "marco",
        shownClusters: [answered],
        kinds: catalogue,
        everything: true,
      })
    );
    expect(coverage(entries)[0].notSearched).toHaveLength(2);
    expect(entries.some((entry) => entry.kind === "search-more")).toBe(false);
  });

  /**
   * Another cluster's catalogue is not read here: counting its kinds against
   * this one's would name kinds it may not serve, so it says only that its
   * other kinds were not searched, and offers nothing it cannot do.
   */
  it("does not count another cluster's kinds against this one's", () => {
    const entries = buildPaletteEntries(
      state({
        text: "marco",
        scope: { kind: "context", context: "prod-eu" },
        shownClusters: [{ ...answered, context: "prod-eu" }],
        kinds: catalogue,
        scopeLabel: "team-checkout",
      })
    );
    const [line] = coverage(entries);
    expect(line.notSearched).toBeNull();
    expect(line.scope).toBeNull();
    expect(entries.some((entry) => entry.kind === "search-more")).toBe(false);
  });

  /**
   * A kind the index is still listing is neither read nor left out: it is on
   * its way, and the line says so while the cluster is still answering.
   */
  it("accounts for kinds still loading while the cluster is still answering", () => {
    const entries = buildPaletteEntries(
      state({
        text: "marco",
        shownClusters: [
          {
            ...answered,
            status: "searching",
            loading: [read("Widget", "demo.example.com", "widgets")],
          },
        ],
        kinds: catalogue,
        everything: true,
      })
    );
    const [line] = coverage(entries);
    expect(line.cluster.loading).toHaveLength(1);
    expect(line.notSearched?.map((entry) => entry.kind)).toEqual([
      "PriorityClass",
    ]);
  });

  /** A cluster that failed or was never asked has said nothing to account for. */
  it("draws no coverage for a cluster that failed or was skipped", () => {
    const entries = buildPaletteEntries(
      state({
        text: "marco",
        scope: { kind: "all" },
        shownClusters: [
          cluster("k3d-dev", "failed", "unreachable"),
          cluster("prod-eu", "skipped", "not-connected"),
        ],
        kinds: catalogue,
      })
    );
    expect(coverage(entries)).toEqual([]);
  });
});

describe("an object's actions", () => {
  const target = {
    context: "k3d-dev",
    kind: "Deployment",
    group: "apps",
    plural: "deployments",
    name: "search",
    namespace: "shop",
  };
  const ready = {
    target: "k3d-dev/apps/deployments/shop/search",
    reading: "ready" as const,
    actions: [
      { id: "scale" as const, label: "Scale", icon: Box },
      { id: "restart" as const, label: "Restart", icon: Box },
    ],
    busy: {},
  };
  const english = new Map([
    ["scale", "Scale"],
    ["restart", "Restart"],
  ]);

  /** On an object's page the palette opens on a way into that object's actions. */
  it("offers the page's object first while nothing is typed", () => {
    const entries = buildPaletteEntries(
      state({ page: { target, actions: null, english } })
    );
    expect(entries[0]).toMatchObject({ kind: "page-actions", target });
  });

  /**
   * "restart" typed on a Deployment's page found nothing; the k9s habit of
   * acting from the keyboard has the page's own action first.
   */
  it("finds the page's own action by its words before anything else", () => {
    const entries = buildPaletteEntries(
      state({
        text: "resta",
        shownClusters: [cluster("k3d-dev")],
        page: {
          target,
          actions: [
            { id: "restart", label: "Restart", icon: Box },
            { id: "delete", label: "Delete", icon: Box, danger: true },
          ],
          english,
        },
      })
    );
    expect(ids(entries).slice(0, 2)).toEqual(["cap:page", "act:restart"]);
  });

  /**
   * Reading the object first is said as reading; a failed read is the
   * failure. Either drawn as no actions would be "this has none".
   */
  it("says the object is still being read, or why it could not be", () => {
    const pending = buildActionEntries({
      target,
      report: { target: "x", reading: "pending" },
      text: "",
      english,
      t,
    });
    expect(ids(pending)).toEqual(["target", "hint:reading"]);
    expect(hintTone(pending)).toBe("loading");

    const failed = buildActionEntries({
      target,
      report: {
        target: "x",
        reading: "failed",
        error: 'deployments.apps "search" is forbidden',
      },
      text: "",
      english,
      t,
    });
    expect(hintText(failed)).toBe('deployments.apps "search" is forbidden');
    expect(hintTone(failed)).toBe("unread");
  });

  it("lists the object's actions, narrowed by what is typed", () => {
    const all = buildActionEntries({
      target,
      report: ready,
      text: "",
      english,
      t,
    });
    expect(ids(all)).toEqual([
      "target",
      "act:logs",
      "act:scale",
      "act:restart",
      "act:copyName",
      "act:copyLink",
      "act:openTab",
    ]);
    const narrowed = buildActionEntries({
      target,
      report: ready,
      text: "sca",
      english,
      t,
    });
    expect(ids(narrowed)).toEqual(["target", "act:scale"]);
    const none = buildActionEntries({
      target,
      report: ready,
      text: "zzz",
      english,
      t,
    });
    expect(hintText(none)).toBe("No action matches “zzz”.");
  });

  /** An action that cannot run says why and takes no Enter, as in the peek. */
  it("does not stop the arrows on an action that cannot run", () => {
    const entries = buildActionEntries({
      target,
      report: {
        ...ready,
        actions: [
          {
            id: "shell",
            label: "Shell",
            icon: Box,
            reason: "This pod has finished",
          },
        ],
      },
      text: "",
      english,
      t,
    });
    const shell = entries.find((entry) => entry.id === "act:shell")!;
    expect(isSelectable(shell)).toBe(false);
  });
});

describe("the words pages and kinds answer to", () => {
  const ru: T = (section, key, values) => translate("ru", section, key, values);
  const served = (
    kind: string,
    group: string,
    plural: string,
    shortNames: string[] = []
  ) => ({
    group,
    version: "v1",
    kind,
    plural,
    namespaced: true,
    verbs: ["list"],
    shortNames,
  });
  const catalogue = [
    served("Pod", "", "pods"),
    served("Deployment", "apps", "deployments"),
    served("StatefulSet", "apps", "statefulsets"),
    served("DaemonSet", "apps", "daemonsets"),
    served("ReplicaSet", "apps", "replicasets"),
    served("Service", "", "services"),
    served("Ingress", "networking.k8s.io", "ingresses"),
    served("ConfigMap", "", "configmaps"),
    served("ServiceAccount", "", "serviceaccounts"),
    served("PersistentVolumeClaim", "", "persistentvolumeclaims"),
    served("PersistentVolume", "", "persistentvolumes"),
    served("Namespace", "", "namespaces"),
    served("Node", "", "nodes"),
    served(
      "HorizontalPodAutoscaler",
      "autoscaling",
      "horizontalpodautoscalers"
    ),
    served("CronJob", "batch", "cronjobs"),
    served("Endpoints", "", "endpoints"),
    served("NetworkPolicy", "networking.k8s.io", "networkpolicies"),
    served("StorageClass", "storage.k8s.io", "storageclasses"),
    served("Widget", "demo.example.com", "widgets", ["wd"]),
  ];
  const offered = (text: string, overrides: Partial<PaletteState> = {}) =>
    buildPaletteEntries(state({ text, kinds: catalogue, ...overrides }));
  const kindsOf = (entries: Entry[]) =>
    entries.flatMap((entry) =>
      entry.kind === "kind" ? [entry.entry.kind] : []
    );
  const navOf = (entries: Entry[]) =>
    entries.flatMap((entry) =>
      entry.kind === "link" || entry.kind === "settings" ? [entry.id] : []
    );

  /**
   * Lena typed "настройки" and "конфиг" and got nothing: the titles she
   * reads are Russian, and so are the words she reaches for.
   */
  it.each([
    ["поды", "nav:goToPods"],
    ["деплойменты", "nav:goToDeployments"],
    ["сервисы", "nav:goToServices"],
    ["секреты", "nav:goToSecrets"],
    ["узлы", "nav:goToNodes"],
    ["конфиг", "nav:goToConfigMaps"],
    ["настройки", "settings"],
  ])("finds the page a Russian reader calls %s", (text, id) => {
    expect(navOf(offered(text, { t: ru }))).toContain(id);
  });

  it.each([
    ["ингрессы", "Ingress"],
    ["неймспейсы", "Namespace"],
    ["пространства имён", "Namespace"],
    ["тома", "PersistentVolume"],
    ["поды", "Pod"],
  ])("finds the kind a Russian reader calls %s", (text, kind) => {
    expect(kindsOf(offered(text, { t: ru }))[0]).toBe(kind);
  });

  /** Marco asked "what can I do here" and the page that answers it had no words to be found by. */
  it.each([
    ["can i", undefined],
    ["permissions", undefined],
    ["права", ru],
    ["что я могу", ru],
  ])("finds Your access by %s", (text, t) => {
    expect(navOf(offered(text, t ? { t } : {}))).toContain("nav:goToMyAccess");
  });

  /** A title is found by its English words too, whatever language it is drawn in. */
  it("finds a page by its English title in another language", () => {
    expect(navOf(offered("settings", { t: ru }))).toContain("settings");
    expect(navOf(offered("overview", { t: ru }))).toContain("nav:goToOverview");
  });

  /** kubectl's short names name their kinds, whole and first. */
  it.each([
    ["po", "Pod"],
    ["deploy", "Deployment"],
    ["sts", "StatefulSet"],
    ["ds", "DaemonSet"],
    ["rs", "ReplicaSet"],
    ["svc", "Service"],
    ["ing", "Ingress"],
    ["cm", "ConfigMap"],
    ["sa", "ServiceAccount"],
    ["pvc", "PersistentVolumeClaim"],
    ["pv", "PersistentVolume"],
    ["ns", "Namespace"],
    ["no", "Node"],
    ["hpa", "HorizontalPodAutoscaler"],
    ["cj", "CronJob"],
    ["ep", "Endpoints"],
    ["netpol", "NetworkPolicy"],
    ["sc", "StorageClass"],
  ])("finds the kind kubectl calls %s", (text, kind) => {
    expect(kindsOf(offered(text))[0]).toBe(kind);
  });

  /**
   * The cluster's own short names come first: a custom kind's are known only
   * to it, and one it renamed answers to its new name, not the table's.
   */
  it("takes a kind's short names from discovery before the table", () => {
    expect(kindsOf(offered("wd"))).toEqual(["Widget"]);
    const renamed = catalogue.map((entry) =>
      entry.kind === "ConfigMap" ? { ...entry, shortNames: ["cfg"] } : entry
    );
    expect(kindsOf(offered("cfg", { kinds: renamed }))).toEqual(["ConfigMap"]);
    expect(kindsOf(offered("cm", { kinds: renamed }))).not.toContain(
      "ConfigMap"
    );
  });
});

describe("the order the palette draws hits in", () => {
  const hit = (kind: string, name: string, namespace: string | null) => ({
    hit: {
      context: "acme",
      kind,
      group: "",
      plural: `${kind.toLowerCase()}s`,
      name,
      namespace,
    },
  });
  const hits = [
    hit("ReplicaSet", "cart-9df89489c", "shop"),
    hit("Pod", "cart-9df89489c-f76qh", "shop"),
    hit("Service", "cart", "shop"),
    hit("Deployment", "cart", "shop"),
    hit("ConfigMap", "kube-root-ca.crt", "shop"),
    hit("Pod", "cart-9df89489c-a1b2c", "shop"),
  ];
  const drawn = (found: typeof hits) =>
    orderHits(found, "cart").map(({ hit }) => `${hit.kind}/${hit.name}`);

  /**
   * Dana's "cart": the Deployment was third on one search and eighth on the
   * next, because hits were drawn in the order the kinds answered, and Down
   * Down copied a ReplicaSet name instead of scaling. Fails if the order
   * depends on arrival.
   */
  it("draws the same hits in one order whatever order they arrived in", () => {
    const first = drawn(hits);
    expect(drawn([...hits].reverse())).toEqual(first);
    expect(
      drawn([hits[3], hits[0], hits[5], hits[2], hits[4], hits[1]])
    ).toEqual(first);
  });

  /** Fails if a pod whose name only starts with the query pushes the object named exactly that down. */
  it("puts an exact name first, then names that start with the query, then the namespace-only matches", () => {
    const order = drawn(hits);
    expect(order.slice(0, 2).sort()).toEqual([
      "Deployment/cart",
      "Service/cart",
    ]);
    expect(order.at(-1)).toBe("ConfigMap/kube-root-ca.crt");
  });

  /** Marco's "could not read 13 kinds" list was in a new order on every open. */
  it("names kinds in one order whatever order the cluster listed them in", () => {
    const kinds = ["Role", "DaemonSet", "ClusterRole"].map((kind) => ({
      kind,
    }));
    expect(byKindName(kinds).map(({ kind }) => kind)).toEqual([
      "ClusterRole",
      "DaemonSet",
      "Role",
    ]);
    expect(byKindName([...kinds].reverse())).toEqual(byKindName(kinds));
  });
});
