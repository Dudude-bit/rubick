// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from "vite-plus/test";
import { createMemoryHistory, createRouter } from "@tanstack/react-router";
import { QueryClient } from "@tanstack/react-query";
import { RefreshCw, Scale, Trash2 } from "lucide-react";

import { routeTree } from "@/generated/routeTree.gen";
import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import { setRouter } from "@/lib/links";
import type { PeekAction } from "../-peek/peek-actions";
import {
  actionMatches,
  actionTargetOfEntry,
  objectOnScreen,
  paletteActionsOf,
  type ActionTarget,
} from "./palette-actions";

const t: T = (section, key, values) => translate("en", section, key, values);
const ru: T = (section, key, values) => translate("ru", section, key, values);

beforeAll(async () => {
  const router = createRouter({
    routeTree,
    context: { queryClient: new QueryClient() },
    history: createMemoryHistory({ initialEntries: ["/c/k3d-dev"] }),
  });
  setRouter(router);
  await router.load();
});

const deployment: ActionTarget = {
  context: "k3d-dev",
  kind: "Deployment",
  group: "apps",
  plural: "deployments",
  name: "search",
  namespace: "shop",
};

const registry: PeekAction[] = [
  { id: "delete", label: "Delete", icon: Trash2, danger: true },
  { id: "scale", label: "Scale", icon: Scale },
  { id: "restart", label: "Restart", icon: RefreshCw },
];

describe("the actions the palette offers on one object", () => {
  /**
   * The registry's actions are the peek's and the object menu's, in the
   * order a reader scans for them: Logs where the page has that tab, Delete
   * after everything it could be mistaken for, and the object menu's copy
   * and open last.
   */
  it("puts Logs first and Delete after the other registry actions", () => {
    expect(
      paletteActionsOf(deployment, registry, {}, t).map((action) => action.id)
    ).toEqual([
      "logs",
      "scale",
      "restart",
      "delete",
      "copyName",
      "copyLink",
      "openTab",
    ]);
  });

  /**
   * A Lease has no Restart, no Scale and no Logs. Drawn greyed out they
   * would be noise; it gets the object menu's copy and open, nothing else.
   */
  it("offers a kind with no registry actions only what the object menu offers", () => {
    const lease: ActionTarget = {
      ...deployment,
      kind: "Lease",
      group: "coordination.k8s.io",
      plural: "leases",
    };
    expect(
      paletteActionsOf(lease, [], {}, t).map((action) => action.id)
    ).toEqual(["copyName", "copyLink", "openTab"]);
  });

  /** A Gateway from another group is not the registry's Gateway, and has no Logs either way. */
  it("reads the kind by its group, not its name alone", () => {
    const pod: ActionTarget = {
      ...deployment,
      kind: "Pod",
      group: "metrics.example.com",
      plural: "pods",
    };
    expect(
      paletteActionsOf(pod, [], {}, t).map((action) => action.id)
    ).not.toContain("logs");
  });

  /** An action is found by its English words too, as a page title is. */
  it("matches an action in the reader's language and in English", () => {
    const [scale] = paletteActionsOf(
      deployment,
      [{ id: "scale", label: ru("action", "scale"), icon: Scale }],
      {},
      ru
    ).filter((action) => action.id === "scale");
    expect(actionMatches(scale, "Scale", "масштаб")).toBe(true);
    expect(actionMatches(scale, "Scale", "scale")).toBe(true);
    expect(actionMatches(scale, "Scale", "delete")).toBe(false);
  });
});

describe("the object the page on screen is about", () => {
  /** A typed route names its kind by the folder it sits in. */
  it("reads a typed object page", () => {
    expect(
      objectOnScreen(
        {
          fullPath: "/c/$cluster/pods/$namespace/$name",
          params: { cluster: "k3d-dev", namespace: "shop", name: "api-0" },
        },
        "k3d-dev"
      )
    ).toEqual({
      context: "k3d-dev",
      kind: "Pod",
      group: "",
      plural: "pods",
      name: "api-0",
      namespace: "shop",
    });
  });

  /** A served kind on the generic page takes its kind from the catalogue. */
  it("reads a served kind on the generic page by its catalogue entry", () => {
    expect(
      objectOnScreen(
        {
          fullPath: "/c/$cluster/$resource/$namespace/$name",
          params: {
            resource: "leases.coordination.k8s.io",
            namespace: "kube-system",
            name: "kube-scheduler",
          },
        },
        "k3d-dev",
        [
          {
            group: "coordination.k8s.io",
            version: "v1",
            kind: "Lease",
            plural: "leases",
            namespaced: true,
            verbs: ["list"],
          },
        ]
      )
    ).toMatchObject({ kind: "Lease", group: "coordination.k8s.io" });
  });

  /** A Helm release or a list is not one object the registry can act on. */
  it("reads no object off a list or a Helm release", () => {
    expect(
      objectOnScreen(
        { fullPath: "/c/$cluster/pods", params: { cluster: "k3d-dev" } },
        "k3d-dev"
      )
    ).toBeNull();
    expect(
      objectOnScreen(
        {
          fullPath: "/c/$cluster/helm/$source/$namespace/$name",
          params: { source: "secret", namespace: "shop", name: "web" },
        },
        "k3d-dev"
      )
    ).toBeNull();
  });
});

describe("whose actions a row opens", () => {
  const hit = (context: string) => ({
    id: `hit:${context}/Pod/shop/api-0`,
    kind: "hit" as const,
    path: null,
    hit: {
      context,
      kind: "Pod",
      group: "",
      plural: "pods",
      name: "api-0",
      namespace: "shop",
    },
  });

  /**
   * Every action runs against the cluster this window is on. Offered on a
   * hit from another cluster, Delete would have deleted this cluster's
   * namesake.
   */
  it("opens a hit's actions only in the cluster this window is on", () => {
    expect(actionTargetOfEntry(hit("k3d-dev"), "k3d-dev")).toMatchObject({
      context: "k3d-dev",
      name: "api-0",
    });
    expect(actionTargetOfEntry(hit("prod-eu"), "k3d-dev")).toBeNull();
  });
});
