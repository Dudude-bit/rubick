import { fireEvent, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { Dependent, Lineage } from "@/generated/types";
import { useClusterStore } from "@/stores/clusterStore";
import { renderWithRouter, settle } from "@/test/render";

const pod = (name: string, kind = "Pod"): Dependent => ({
  uid: `uid-${name}`,
  kind,
  group: "",
  version: "v1",
  plural: kind === "Pod" ? "pods" : "configmaps",
  name,
  namespace: "shop",
  controlled: true,
  dependents: 0,
});

const LINEAGE: Lineage = {
  uid: "uid-api-b",
  ancestors: [
    {
      uid: "r",
      kind: "ReplicaSet",
      group: "apps",
      plural: "replicasets",
      name: "api-7f9",
      namespace: "shop",
    },
  ],
  others: [],
  stop: null,
};

const beside = vi.hoisted(() => ({ asked: [] as string[][] }));

vi.mock("@/lib/commands", () => ({
  commands: {
    objectLineage: () => Promise.resolve(LINEAGE),
    listDependents: () =>
      Promise.resolve({
        dependents: [pod("api-a")],
        page: 0,
        pageSize: 100,
        total: 1,
        notRead: { kinds: [], groups: [], watched: 40 },
      }),
    listDependentsBeside: (owner: string, uid: string) => {
      beside.asked.push([owner, uid]);
      return Promise.resolve({ previous: pod("api-a"), next: pod("api-c") });
    },
  },
}));

const { useOwnershipKeys } = await import("./ownership-keys");

function Page() {
  useOwnershipKeys({ group: "", plural: "pods" }, "api-b", "shop");
  return <input aria-label="field" />;
}

beforeEach(() => {
  useClusterStore.setState({ currentContext: "test", isConnected: true });
});

const at = "/c/test/pods/shop/api-b";

describe("moving along ownership from the keyboard", () => {
  it("goes up to the owner", async () => {
    const { router } = await renderWithRouter(<Page />, { at });
    await waitFor(() => {
      fireEvent.keyDown(window, { key: "ArrowUp", altKey: true });
      expect(router.state.location.pathname).toBe(
        "/c/test/replicasets/shop/api-7f9"
      );
    });
  });

  /**
   * The neighbour was looked for in the list of everything the owner owns,
   * which now comes a page at a time: a pod on the second page had none.
   * Fails if the index is not asked for the neighbours of this object under
   * its owner, or the key goes anywhere but to the one it names.
   */
  it("goes sideways to the neighbour the index names under the owner", async () => {
    const { router } = await renderWithRouter(<Page />, { at });
    await waitFor(() => {
      fireEvent.keyDown(window, { key: "ArrowRight", altKey: true });
      expect(router.state.location.pathname).toBe("/c/test/pods/shop/api-c");
    });
    expect(beside.asked).toContainEqual(["r", "uid-api-b"]);
  });

  it("goes back to the neighbour before it", async () => {
    const { router } = await renderWithRouter(<Page />, { at });
    await waitFor(() => {
      fireEvent.keyDown(window, { key: "ArrowLeft", altKey: true });
      expect(router.state.location.pathname).toBe("/c/test/pods/shop/api-a");
    });
  });

  /** In a field, Alt and an arrow are the field's: a word jump, not a page. */
  it("leaves the keys to a field that has the focus", async () => {
    const { router, getByLabelText } = await renderWithRouter(<Page />, { at });
    await waitFor(() => expect(getByLabelText("field")).toBeInTheDocument());
    fireEvent.keyDown(getByLabelText("field"), {
      key: "ArrowUp",
      altKey: true,
    });
    await settle(router);
    expect(router.state.location.pathname).toBe(at);
  });
});
