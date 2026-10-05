// @vitest-environment jsdom
import { describe, expect, it } from "vite-plus/test";
import { createMemoryHistory, createRouter } from "@tanstack/react-router";
import { QueryClient } from "@tanstack/react-query";

import { routeTree } from "@/generated/routeTree.gen";
import {
  clusterOf,
  crdInstancesLink,
  hrefOf,
  listLink,
  objectLink,
  retargetHref,
  servedListLink,
  servedObjectLink,
  setRouter,
} from "./links";
import { RESOURCE_REGISTRY } from "./resource-registry";

function at(path: string) {
  const router = createRouter({
    routeTree,
    context: { queryClient: new QueryClient() },
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  setRouter(router);
  return router;
}

/** The route an address lands on, or the generic one for "nothing of its own". */
function routeOf(router: ReturnType<typeof at>, href: string): string {
  const [pathname] = href.split("?");
  return router.matchRoutes(pathname).at(-1)?.routeId ?? "";
}

const GENERIC = /\/\$resource\//;

describe("an object's address", () => {
  /** Built from the cluster the window is in, so a link never leaves it by accident. */
  it("is the kind's plural under the current cluster", async () => {
    const router = at("/c/prod/pods");
    await router.load();
    const link = objectLink({ kind: "Pod", name: "api-0", namespace: "web" });
    expect(hrefOf(link!)).toBe("/c/prod/pods/web/api-0");
    expect(routeOf(router, hrefOf(link!))).not.toMatch(GENERIC);
  });

  /** A namespaced kind with no namespace would be a dead link the reader finds by clicking. */
  it("is refused for a namespaced kind handed no namespace", () => {
    at("/c/prod");
    expect(objectLink({ kind: "Pod", name: "api-0" })).toBeNull();
  });

  /** A cluster-scoped kind keeps no namespace, whatever an owner reference carried. */
  it("drops the namespace of a cluster-scoped kind", async () => {
    const router = at("/c/prod");
    await router.load();
    const link = objectLink({ kind: "Node", name: "n1", namespace: "web" });
    expect(hrefOf(link!)).toBe("/c/prod/nodes/n1");
  });

  /** A custom resource is named by its CRD, the way kubectl names it. */
  it("names a custom resource by its CRD", async () => {
    const router = at("/c/prod");
    await router.load();
    const link = objectLink({
      kind: "Certificate",
      name: "tls",
      namespace: "web",
      crd: "certificates.cert-manager.io",
    });
    expect(hrefOf(link!)).toBe("/c/prod/certificates.cert-manager.io/web/tls");
    expect(hrefOf(crdInstancesLink("certificates.cert-manager.io"))).toBe(
      "/c/prod/customresourcedefinitions/certificates.cert-manager.io?tab=instances"
    );
  });

  /** A context name from EKS is an ARN, with slashes and colons in it. */
  it("survives a cluster name with slashes in it", async () => {
    const arn = "arn:aws:eks:eu-west-1:123:cluster/prod";
    const router = at(`/c/${encodeURIComponent(arn)}`);
    await router.load();
    const href = hrefOf(objectLink({ kind: "Node", name: "n1" })!);
    expect(clusterOf(href)).toBe(arn);
  });
});

describe("every kind the registry knows", () => {
  /**
   * A kind that gained a page in the registry and no folder in the tree
   * would quietly open on the generic page; one with a list folder missing
   * would land on "Rubick does not list this yet".
   */
  it("lists on a page of its own", async () => {
    const router = at("/c/prod");
    await router.load();
    const generic = RESOURCE_REGISTRY.filter(
      (entry) =>
        !["HorizontalPodAutoscaler", "PodDisruptionBudget"].includes(entry.kind)
    )
      .map((entry) => hrefOf(listLink(entry.kind)))
      .filter((href) => GENERIC.test(routeOf(router, href)));
    expect(generic).toEqual([]);
  });
});

describe("a served kind's list", () => {
  /** A kind the registry holds opens its own page; a namesake in another group does not. */
  it("opens the registry's page only for that very kind", async () => {
    const router = at("/c/prod");
    await router.load();
    const pods = hrefOf(
      servedListLink({ kind: "Pod", group: "", plural: "pods" })
    );
    expect(pods).toBe("/c/prod/pods");
    expect(routeOf(router, pods)).not.toMatch(GENERIC);
    const routes = hrefOf(
      servedListLink({
        kind: "HTTPRoute",
        group: "gateway.networking.k8s.io",
        plural: "httproutes",
      })
    );
    expect(routeOf(router, routes)).not.toMatch(GENERIC);
    const events = hrefOf(
      servedListLink({
        kind: "Event",
        group: "events.k8s.io",
        plural: "events",
      })
    );
    expect(events).toBe("/c/prod/events.events.k8s.io");
    expect(routeOf(router, events)).toMatch(GENERIC);
  });

  it("lists a core kind the registry does not hold by its bare plural", async () => {
    at("/c/prod");
    expect(
      hrefOf(
        servedListLink({
          kind: "ServiceAccount",
          group: "",
          plural: "serviceaccounts",
        })
      )
    ).toBe("/c/prod/serviceaccounts");
  });
});

describe("an object of a served kind", () => {
  /**
   * A search hit for a ServiceAccount, a ClusterRole or an Istio Gateway
   * carries its group and plural. Linked by kind name alone, the first two
   * had nowhere to go and the third opened the Gateway API page of a
   * Gateway that does not exist.
   */
  it("opens the registry's page only for that very kind, and the generic page otherwise", async () => {
    const router = at("/c/prod");
    await router.load();
    const href = (ref: Parameters<typeof servedObjectLink>[0]) =>
      hrefOf(servedObjectLink(ref)!);

    const pod = href({
      kind: "Pod",
      group: "",
      plural: "pods",
      name: "api-0",
      namespace: "web",
    });
    expect(pod).toBe("/c/prod/pods/web/api-0");
    expect(routeOf(router, pod)).not.toMatch(GENERIC);

    expect(
      href({
        kind: "ServiceAccount",
        group: "",
        plural: "serviceaccounts",
        name: "marco",
        namespace: "team-checkout",
      })
    ).toBe("/c/prod/serviceaccounts/team-checkout/marco");
    const role = href({
      kind: "ClusterRole",
      group: "rbac.authorization.k8s.io",
      plural: "clusterroles",
      name: "view",
      namespace: null,
    });
    expect(role).toBe("/c/prod/clusterroles.rbac.authorization.k8s.io/view");
    expect(routeOf(router, role)).toMatch(GENERIC);
    expect(
      href({
        kind: "Gateway",
        group: "networking.istio.io",
        plural: "gateways",
        name: "edge",
        namespace: "istio-system",
      })
    ).toBe("/c/prod/gateways.networking.istio.io/istio-system/edge");
  });
});

describe("the same place in another cluster", () => {
  /** A list means the same thing in any cluster. */
  it("keeps a list", () => {
    expect(retargetHref("/c/prod/pods?q=api", "dev")).toBe("/c/dev/pods");
  });

  /** An object exists only in the cluster it was opened in. */
  it("gives way to the object's list", () => {
    expect(retargetHref("/c/prod/pods/web/api-0", "dev")).toBe("/c/dev/pods");
    expect(retargetHref("/c/prod/replicasets/web/api-7f9", "dev")).toBe(
      "/c/dev/deployments"
    );
  });

  /** Outside any cluster there is no place to keep. */
  it("starts at the overview from the front door", () => {
    expect(retargetHref("/", "dev")).toBe("/c/dev");
  });
});
