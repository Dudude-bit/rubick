import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vite-plus/test";

import type { ApiCatalog } from "@/generated/types";
import { renderWithRouter, testQueryClient } from "@/test/render";
import { AnyObject } from "./AnyObject";
import { catalogQuery } from "./served";

const LEASES: ApiCatalog = {
  entries: [
    {
      group: "coordination.k8s.io",
      version: "v1",
      kind: "Lease",
      plural: "leases",
      namespaced: true,
      verbs: ["list", "watch"],
      shortNames: [],
    },
  ],
  unread: [],
};

const open = (resource: string, name: string, catalog?: ApiCatalog) => {
  const client = testQueryClient();
  if (catalog) client.setQueryData(catalogQuery().queryKey, catalog);
  return renderWithRouter(<AnyObject resource={resource} name={name} />, {
    client,
    at: `/c/prod/${resource}/${name}`,
    route: "/c/$cluster/$",
    beside: { "/c/$cluster/$resource": <p>the list</p> },
  });
};

describe("an object address with no namespace", () => {
  /**
   * The route's own check can only read a discovery already cached; a link
   * opened before it answered fell through to the object page. Fails if the
   * page, once discovery says the kind is namespaced, reads one segment as
   * an object's name instead of the namespace it is.
   */
  it("opens the namespaced kind's list in that namespace once discovery says so", async () => {
    const { router } = await open("leases", "kube-system", LEASES);

    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/c/prod/leases")
    );
    expect(router.state.location.search).toEqual({ namespace: "kube-system" });
    expect(screen.getByText("the list")).toBeInTheDocument();
  });

  /** A registry kind needs no discovery to be known as namespaced. */
  it("opens a registry kind's list in that namespace at once", async () => {
    const { router } = await open("deployments", "team-blind");

    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/c/prod/deployments")
    );
    expect(router.state.location.search).toEqual({ namespace: "team-blind" });
  });

  /** Fails if a kind discovery has not answered for is guessed either way. */
  it("waits for discovery rather than guessing", async () => {
    const { router } = await open("leases", "kube-system");

    expect(router.state.location.pathname).toBe("/c/prod/leases/kube-system");
    expect(screen.queryByText("the list")).toBeNull();
  });
});
