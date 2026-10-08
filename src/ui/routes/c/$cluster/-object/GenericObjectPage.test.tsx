import { act, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { ApiCatalog, CatalogEntry } from "@/generated/types";
import { useClusterStore } from "@/stores/clusterStore";
import { renderWithRouter } from "@/test/render";

const answers = vi.hoisted(() => ({
  catalog: (): Promise<ApiCatalog> =>
    Promise.resolve({ entries: [], unread: [] }),
  object: (_group?: string, _plural?: string): Promise<unknown> =>
    Promise.reject(new Error("unset")),
  yaml: (): Promise<string> =>
    Promise.reject({ code: "NOT_FOUND", message: 'leases "x" not found' }),
  events: vi.fn((_filter: unknown): Promise<unknown[]> => Promise.resolve([])),
}));

vi.mock("@/lib/commands", () => ({
  commands: {
    listApiCatalog: () => answers.catalog(),
    getServedObjectYaml: () => answers.yaml(),
    getServedObject: (group: string, plural: string) =>
      answers.object(group, plural),
    listEvents: (filter: unknown) => answers.events(filter),
    objectLineage: () =>
      Promise.reject({ code: "NOT_FOUND", message: 'leases "x" not found' }),
  },
}));

const { GenericObjectPage } = await import("./GenericObjectPage");

const LEASES: CatalogEntry = {
  group: "coordination.k8s.io",
  version: "v1",
  kind: "Lease",
  plural: "leases",
  namespaced: true,
  verbs: ["get", "list"],
  shortNames: [],
};

beforeEach(() => {
  useClusterStore.setState({ currentContext: "test", isConnected: true });
});

const open = () =>
  renderWithRouter(
    <GenericObjectPage
      resource="leases.coordination.k8s.io"
      namespace="kube-node-lease"
      name="x"
    />
  );

describe("an object of a kind no screen draws", () => {
  /** The peek and this page read an object through one function. */
  it("draws what the object says about itself as the peek does", async () => {
    answers.catalog = () => Promise.resolve({ entries: [LEASES], unread: [] });
    answers.object = () =>
      Promise.resolve({
        metadata: {
          name: "x",
          labels: { tier: "control" },
          managedFields: [
            {
              manager: "kubelet",
              operation: "Update",
              time: "2026-10-04T05:00:00Z",
            },
          ],
        },
        spec: { holderIdentity: "node-1" },
      });
    await open();
    expect(await screen.findByText("holderIdentity")).toBeInTheDocument();
    expect(screen.getByText("kubelet")).toBeInTheDocument();
    expect(screen.getByText("tier")).toBeInTheDocument();
  });

  /**
   * A Lease has no status, and "Status: Nothing reported yet" read as one
   * still to come. Discovery says the kind serves none, so nothing is said.
   */
  it("draws no status for a kind that serves none", async () => {
    answers.catalog = () =>
      Promise.resolve({
        entries: [{ ...LEASES, hasStatus: false }],
        unread: [],
      });
    answers.object = () =>
      Promise.resolve({
        metadata: { name: "x" },
        spec: { holderIdentity: "node-1" },
      });
    await open();
    expect(await screen.findByText("holderIdentity")).toBeInTheDocument();
    expect(screen.queryByText("Nothing reported yet")).not.toBeInTheDocument();
  });
});

describe("an object of a kind no screen draws, when the read finds nothing", () => {
  beforeEach(() => {
    answers.object = () =>
      Promise.reject({ code: "NOT_FOUND", message: 'leases "x" not found' });
  });

  /** Only a served kind's 404 is about the object. */
  it("says the object is missing when the kind is served", async () => {
    answers.catalog = () => Promise.resolve({ entries: [LEASES], unread: [] });
    await open();
    expect(
      await screen.findByText("There is no Lease named x")
    ).toBeInTheDocument();
  });

  /**
   * The 404 is the same bytes whether the object or the whole kind is gone;
   * with the group's discovery unread, neither can be claimed.
   */
  it("cannot tell when the kind's group did not answer", async () => {
    answers.catalog = () =>
      Promise.resolve({
        entries: [],
        unread: [
          {
            group: "coordination.k8s.io",
            code: "INTERNAL_ERROR",
            message: "the server is currently unable to handle the request",
          },
        ],
      });
    await open();
    expect(
      await screen.findByText(
        "Could not tell whether this cluster serves leases.coordination.k8s.io"
      )
    ).toBeInTheDocument();
    expect(screen.queryByText(/There is no/)).toBeNull();
  });

  it("says the cluster serves no such kind when discovery answered without it", async () => {
    answers.catalog = () => Promise.resolve({ entries: [], unread: [] });
    await open();
    expect(
      await screen.findByText(
        "This cluster serves no leases.coordination.k8s.io"
      )
    ).toBeInTheDocument();
  });
});

describe("an object addressed by a bare plural", () => {
  const CLUSTER_ROLES: CatalogEntry = {
    group: "rbac.authorization.k8s.io",
    version: "v1",
    kind: "ClusterRole",
    plural: "clusterroles",
    namespaced: false,
    verbs: ["get", "list"],
    shortNames: [],
  };

  /**
   * Sam's hand-typed link, clusterroles/<name>, said "This cluster serves no
   * clusterroles" while API resources listed ClusterRole: the bare plural
   * was read as a core kind. Discovery names its group, as kubectl reads it.
   */
  it("reads it in the group discovery names, and never says it is not served", async () => {
    answers.catalog = () =>
      Promise.resolve({ entries: [CLUSTER_ROLES], unread: [] });
    const asked: Array<[string, string]> = [];
    answers.object = (group?: string, plural?: string) => {
      asked.push([group ?? "", plural ?? ""]);
      return group === "rbac.authorization.k8s.io"
        ? Promise.resolve({
            metadata: { name: "system:controller:x", labels: { tier: "rbac" } },
            rules: [],
          })
        : Promise.reject({ code: "NOT_FOUND", message: "not found" });
    };
    await renderWithRouter(
      <GenericObjectPage resource="clusterroles" name="system:controller:x" />
    );
    expect(await screen.findByText("tier")).toBeInTheDocument();
    expect(screen.queryByText(/serves no/)).toBeNull();
    expect(asked).toEqual([["rbac.authorization.k8s.io", "clusterroles"]]);
  });

  /**
   * Sam's link opened under a trail reading "clusterroles", and Lena's
   * Russian pages read "deployments / lena-sandbox", while the sidebar and
   * the list's heading say ClusterRoles and Deployments. Fails if the trail
   * goes back to the lowercase plural from the address.
   */
  it("names the list the way the sidebar and the list's heading do", async () => {
    answers.catalog = () =>
      Promise.resolve({ entries: [CLUSTER_ROLES], unread: [] });
    answers.object = () =>
      Promise.resolve({ metadata: { name: "edit" }, rules: [] });
    await renderWithRouter(
      <GenericObjectPage resource="clusterroles" name="edit" />
    );
    expect(
      await screen.findByRole("link", { name: "ClusterRoles" })
    ).toBeVisible();
    expect(screen.queryByRole("link", { name: "clusterroles" })).toBeNull();
  });
});

describe("an object of a kind no screen draws, read again", () => {
  /**
   * The lists say "read failing" over rows a failed read left; this page's
   * header said "polling" over an object it could no longer refresh. Fails
   * if the header does not say the read is failing.
   */
  it("says in its header that the read is failing, over the object it keeps", async () => {
    answers.catalog = () => Promise.resolve({ entries: [LEASES], unread: [] });
    answers.object = () =>
      Promise.resolve({
        metadata: { name: "x" },
        spec: { holderIdentity: "node-1" },
      });
    answers.yaml = () => Promise.resolve("metadata:\n  name: x\n");
    const { client } = await open();
    expect(await screen.findByText("holderIdentity")).toBeInTheDocument();
    expect(await screen.findByText("polling")).toBeInTheDocument();

    answers.yaml = () => Promise.reject(new Error("502 Bad Gateway"));
    answers.object = () => Promise.reject(new Error("502 Bad Gateway"));
    await act(() => client.refetchQueries());

    expect(await screen.findByText("read failing")).toBeInTheDocument();
    expect(screen.getByText("holderIdentity")).toBeInTheDocument();
  });

  /** Fails if an object deleted while its page is open is kept as though only the read had failed. */
  it("says an object deleted while its page is open is gone", async () => {
    answers.catalog = () => Promise.resolve({ entries: [LEASES], unread: [] });
    answers.object = () =>
      Promise.resolve({
        metadata: { name: "x" },
        spec: { holderIdentity: "node-1" },
      });
    answers.yaml = () => Promise.resolve("metadata:\n  name: x\n");
    const { client } = await open();
    expect(await screen.findByText("holderIdentity")).toBeInTheDocument();

    const gone = () =>
      Promise.reject({ code: "NOT_FOUND", message: 'leases "x" not found' });
    answers.yaml = gone;
    answers.object = gone;
    await act(() => client.refetchQueries());

    expect(
      await screen.findByText("There is no Lease named x")
    ).toBeInTheDocument();
    expect(screen.queryByText("holderIdentity")).toBeNull();
  });
});

describe("the events of an object no screen draws", () => {
  /**
   * Sam's HPA cart had 61 FailedGetResourceMetric events and its page had no
   * Events tab to show them. Fails if the generic page drops the tab or asks
   * about another object.
   */
  it("has an Events tab reading this object's own events", async () => {
    answers.catalog = () =>
      Promise.resolve({
        entries: [
          {
            group: "autoscaling",
            version: "v2",
            kind: "HorizontalPodAutoscaler",
            plural: "horizontalpodautoscalers",
            namespaced: true,
            verbs: ["get", "list"],
            shortNames: ["hpa"],
          },
        ],
        unread: [],
      });
    answers.object = () => Promise.resolve({ metadata: { name: "cart" } });
    answers.yaml = () => Promise.resolve("metadata:\n  name: cart\n");
    await renderWithRouter(
      <GenericObjectPage
        resource="horizontalpodautoscalers.autoscaling"
        namespace="shop"
        name="cart"
      />
    );
    expect(await screen.findByRole("tab", { name: /Events/ })).toBeVisible();
    expect(answers.events).toHaveBeenCalledWith(
      expect.objectContaining({
        namespace: "shop",
        involved_object_kind: "HorizontalPodAutoscaler",
        involved_object_name: "cart",
      })
    );
  });
});
