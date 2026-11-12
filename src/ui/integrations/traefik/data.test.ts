import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@/lib/commands", () => ({
  commands: {
    listDeployments: vi.fn(),
    listDaemonsets: vi.fn(),
    getDeployment: vi.fn(),
    getDaemonset: vi.fn(),
    listCustomResources: vi.fn(),
    listIngresses: vi.fn(async () => []),
    resolveIngressClass: vi.fn(async () => ({ available: [] })),
  },
}));

import { commands } from "@/lib/commands";
import type { CustomResourceInfo } from "@/generated/types";
import {
  fetchController,
  fetchRouteSources,
  groupsReadBy,
  ingressClients,
} from "./data";

const deployments = vi.mocked(commands.listDeployments);
const daemonSets = vi.mocked(commands.listDaemonsets);

beforeEach(() => {
  deployments.mockReset();
  daemonSets.mockReset();
});

describe("looking for the proxy", () => {
  /**
   * Both lists came back through `.catch(() => [])`, so a token refused
   * `list deployments` was told Traefik is not installed on a cluster where
   * it serves every host on the page.
   */
  it("says the lookup was refused rather than that there is no proxy", async () => {
    deployments.mockRejectedValue("deployments.apps is forbidden (code: 403)");
    daemonSets.mockResolvedValue([]);

    const controller = await fetchController();

    expect(controller.workload).toBeNull();
    expect(controller.problem?.key).toBe("controllerUnread");
    expect(String(controller.problem?.values?.why)).toContain("forbidden");
  });

  /** Both lists answered and neither holds it: that is "not installed". */
  it("says there is none when both lists answered empty", async () => {
    deployments.mockResolvedValue([]);
    daemonSets.mockResolvedValue([]);

    const controller = await fetchController();

    expect(controller.problem?.key).toBe("traefikNoController");
  });
});

const NEW = "traefik.io";
const OLD = "traefik.containo.us";

const object = (
  group: string,
  name: string,
  kind = "IngressRoute"
): CustomResourceInfo => ({
  name,
  namespace: "shop",
  uid: `${group}/${name}`,
  apiVersion: `${group}/v1alpha1`,
  kind,
  spec: {},
  status: null,
  labels: {},
  annotations: {},
  createdAt: null,
  ownerReferences: [],
  generation: null,
});

const failure = (code: string, message: string) =>
  new Error(`Tauri command 'listCustomResources' failed: ${message}`, {
    cause: { code, message },
  });
const notServed = () => failure("NOT_FOUND", "not found");
/** The API server's 403 where a binding names a role that is gone. */
const refused = () =>
  failure(
    "PERMISSION_DENIED",
    'ingressroutes.traefik.containo.us is forbidden: RBAC: clusterrole.rbac.authorization.k8s.io "viewer" not found'
  );

/** A cluster by what each `<plural>.<group>` answers and the image its proxy runs. */
function cluster(
  answers: Record<string, CustomResourceInfo[] | Error>,
  image: string | null
) {
  vi.mocked(commands.listCustomResources).mockImplementation(
    async (crd: string) => {
      const answer = answers[crd] ?? [];
      if (answer instanceof Error) throw answer;
      return answer;
    }
  );
  deployments.mockResolvedValue(
    image === null
      ? []
      : ([
          {
            name: "traefik",
            namespace: "kube-system",
            containers: [{ image }],
            replicas: { ready: 1, desired: 1 },
          },
        ] as never)
  );
  daemonSets.mockResolvedValue([]);
}

const K3S_2_11 = "rancher/mirrored-library-traefik:2.11.10";
const names = (objects: CustomResourceInfo[]) =>
  objects.map((entry) => `${entry.apiVersion.split("/")[0]}/${entry.name}`);

describe("the API groups Traefik's kinds are read from", () => {
  /**
   * Traefik 2.10 and 2.11 serve and read both groups. The first one's empty
   * list was taken as the whole answer, so routes kept under the old group
   * were "nothing routes to it" on the page, the sidebar and every Service.
   */
  it("reads the routes a 2.11 cluster keeps under the old group beside an empty new one", async () => {
    cluster(
      {
        [`ingressroutes.${OLD}`]: [object(OLD, "storefront")],
        [`middlewares.${OLD}`]: [object(OLD, "headers", "Middleware")],
      },
      K3S_2_11
    );

    const sources = await fetchRouteSources();

    expect(names(sources.ingressRoutes)).toEqual([`${OLD}/storefront`]);
    expect(names(sources.middlewares)).toEqual([`${OLD}/headers`]);
    expect(sources.legacyUnconfirmed).toBe(0);
  });

  /**
   * Traefik skips an old-group object whose name the new group already holds.
   * Fails if a route applied under both groups is drawn twice, or as the copy
   * Traefik ignores.
   */
  it("counts a name both groups hold once, as the traefik.io object", async () => {
    cluster(
      {
        [`ingressroutes.${NEW}`]: [object(NEW, "storefront")],
        [`ingressroutes.${OLD}`]: [
          object(OLD, "storefront"),
          object(OLD, "legacy"),
        ],
      },
      K3S_2_11
    );

    const { ingressRoutes } = await fetchRouteSources();

    expect(names(ingressRoutes)).toEqual([
      `${NEW}/storefront`,
      `${OLD}/legacy`,
    ]);
  });

  /**
   * A refusal is told from "not served" by its code: this one's sentence ends
   * in "not found". Fails if a group Traefik reads and the app could not is
   * answered with the other group's routes alone.
   */
  it("fails whole where a group this Traefik reads was refused", async () => {
    cluster(
      {
        [`ingressroutes.${NEW}`]: [object(NEW, "storefront")],
        [`ingressroutes.${OLD}`]: refused(),
      },
      K3S_2_11
    );

    await expect(fetchRouteSources()).rejects.toThrow(/forbidden/);
  });

  /**
   * Helm leaves the old CRDs behind an upgrade, and v3 does not read them.
   * Fails if their objects are drawn as served, or if a reader allowed only
   * `traefik.io` loses the page to a group this proxy ignores.
   */
  it("leaves the old group out for a v3 proxy, objects and refusal alike", async () => {
    cluster(
      {
        [`ingressroutes.${NEW}`]: [object(NEW, "storefront")],
        [`ingressroutes.${OLD}`]: [object(OLD, "abandoned")],
        [`middlewares.${OLD}`]: refused(),
      },
      "docker.io/traefik:v3.1.2"
    );

    const sources = await fetchRouteSources();

    expect(names(sources.ingressRoutes)).toEqual([`${NEW}/storefront`]);
    expect(sources.legacyUnconfirmed).toBe(0);
  });

  /**
   * An image pinned by digest names no version, so whether the old group is
   * read is not known. Fails if those routes vanish, or are drawn with
   * nothing saying the doubt.
   */
  it("draws old-group routes it cannot place and counts them as unconfirmed", async () => {
    cluster(
      {
        [`ingressroutes.${NEW}`]: [object(NEW, "storefront")],
        [`ingressroutes.${OLD}`]: [object(OLD, "legacy")],
      },
      "traefik@sha256:0f0f"
    );

    const sources = await fetchRouteSources();

    expect(names(sources.ingressRoutes)).toEqual([
      `${NEW}/storefront`,
      `${OLD}/legacy`,
    ]);
    expect(sources.legacyUnconfirmed).toBe(1);
  });

  /**
   * A cluster on 2.9 serves the old group alone. Fails if its routes are not
   * read, or if the ordinary one-group cluster pays for a look at the proxy.
   */
  it("reads a one-group cluster without asking for the proxy", async () => {
    cluster(
      {
        [`ingressroutes.${NEW}`]: notServed(),
        [`middlewares.${NEW}`]: notServed(),
        [`ingressroutes.${OLD}`]: [object(OLD, "storefront")],
      },
      "traefik:v2.9.6"
    );

    const { ingressRoutes } = await fetchRouteSources();

    expect(names(ingressRoutes)).toEqual([`${OLD}/storefront`]);
    expect(deployments).not.toHaveBeenCalled();
  });

  /** Fails if a kind no group serves is answered as an empty routing table. */
  it("fails where neither group serves the kind", async () => {
    cluster(
      {
        [`ingressroutes.${NEW}`]: notServed(),
        [`ingressroutes.${OLD}`]: notServed(),
      },
      K3S_2_11
    );

    await expect(fetchRouteSources()).rejects.toThrow(/not found/);
  });

  /**
   * 2.10 and 2.11 read both groups, v3 the new one, 2.9 and older the old
   * one. Fails if a digest, a floating tag or a build number is read as a
   * version and decides which routes are drawn.
   */
  it("reads the proxy's version off its image tag and nothing off anything else", () => {
    expect(groupsReadBy(K3S_2_11)).toEqual([NEW, OLD]);
    expect(groupsReadBy("registry.local:5000/traefik:v2.10.4")).toEqual([
      NEW,
      OLD,
    ]);
    expect(groupsReadBy("traefik:v3.1.2@sha256:0f0f")).toEqual([NEW]);
    expect(groupsReadBy("traefik:2.9")).toEqual([OLD]);
    for (const image of [
      null,
      "traefik",
      "traefik:latest",
      "traefik:v3",
      "traefik@sha256:0f0f",
      "registry.local:5000/traefik",
      "corp/traefik:20240101.3",
      "corp/traefik:1.7.34",
    ]) {
      expect(groupsReadBy(image)).toBeNull();
    }
  });
});

describe("the controllers Traefik's pods answer for", () => {
  /**
   * Traefik's Gateway API provider runs in the pods its Ingress provider
   * does. Fails if an HTTPRoute through a Traefik GatewayClass finds nobody
   * to judge at the pods' NetworkPolicies, or another vendor is claimed.
   */
  it("claims its Ingress and Gateway API controllers and nothing else", () => {
    expect(ingressClients("traefik.io/ingress-controller")?.name).toBe(
      "Traefik"
    );
    expect(ingressClients("traefik.io/gateway-controller")?.name).toBe(
      "Traefik"
    );
    expect(
      ingressClients("gateway.envoyproxy.io/gatewayclass-controller")
    ).toBeNull();
  });
});
