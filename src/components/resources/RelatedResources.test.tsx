import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const getReplicaset = vi.fn();
const getJob = vi.fn();

vi.mock("@/lib/commands", () => ({
  commands: {
    getReplicaset: (...args: unknown[]) => getReplicaset(...args),
    getJob: (...args: unknown[]) => getJob(...args),
  },
}));

const { RelatedResources } = await import("./RelatedResources");

const owner = (kind: string, name: string, controller = true) => ({
  api_version: "apps/v1",
  kind,
  name,
  uid: `${kind}-${name}`,
  controller,
});

const wrap = (ui: ReactNode) =>
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>
  );

describe("RelatedResources", () => {
  beforeEach(() => vi.clearAllMocks());

  it("walks past the first hop to the object somebody actually deploys", async () => {
    /** A pod's owner is a hash nobody named. Stopping at it left the
     *  Deployment — the thing a person recognises and edits — off the page
     *  entirely, one API call away. */
    getReplicaset.mockResolvedValue({
      ownerReferences: [owner("Deployment", "meshed-demo")],
    });

    wrap(
      <RelatedResources
        ownerReferences={[owner("ReplicaSet", "meshed-demo-65d47b457f")]}
        namespace="k8s-gui-test"
      />
    );

    expect(
      await screen.findByRole("link", { name: "Deployment meshed-demo" })
    ).toHaveAttribute("href", "/deployments/k8s-gui-test/meshed-demo");
    expect(
      screen.getByRole("link", { name: "ReplicaSet meshed-demo-65d47b457f" })
    ).toBeInTheDocument();
  });

  it("keeps the hop the object stated when the one above it cannot be read", async () => {
    /** RBAC denies one kind at a time. Dropping the whole chain because the
     *  next request was refused would lose a reference the object itself
     *  carried and the app never needed permission for. */
    getReplicaset.mockRejectedValue(new Error("forbidden"));

    wrap(
      <RelatedResources
        ownerReferences={[owner("ReplicaSet", "meshed-demo-65d47b457f")]}
        namespace="k8s-gui-test"
      />
    );

    expect(
      await screen.findByRole("link", {
        name: "ReplicaSet meshed-demo-65d47b457f",
      })
    ).toBeInTheDocument();
  });

  it("asks nothing of a kind whose owner cannot be read back", async () => {
    /** A Deployment is owned by nothing in an ordinary cluster, so a walk
     *  that fetched it anyway would be one request per pod page whose answer
     *  is always empty. */
    wrap(
      <RelatedResources
        ownerReferences={[owner("Deployment", "meshed-demo")]}
        namespace="k8s-gui-test"
      />
    );

    expect(
      await screen.findByRole("link", { name: "Deployment meshed-demo" })
    ).toBeInTheDocument();
    expect(getReplicaset).not.toHaveBeenCalled();
    expect(getJob).not.toHaveBeenCalled();
  });
});
