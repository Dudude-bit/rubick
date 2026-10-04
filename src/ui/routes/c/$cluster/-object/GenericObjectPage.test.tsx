import { screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { ApiCatalog, CatalogEntry } from "@/generated/types";
import { useClusterStore } from "@/stores/clusterStore";
import { renderWithRouter } from "@/test/render";

const answers = vi.hoisted(() => ({
  catalog: (): Promise<ApiCatalog> =>
    Promise.resolve({ entries: [], unread: [] }),
}));

vi.mock("@/lib/commands", () => ({
  commands: {
    listApiCatalog: () => answers.catalog(),
    getServedObjectYaml: () =>
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

describe("an object of a kind no screen draws, when the read finds nothing", () => {
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
