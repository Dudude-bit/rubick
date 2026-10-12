import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { screen } from "@testing-library/react";

import { renderWithRouter } from "@/test/render";

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

const wrap = (ui: ReactElement) =>
  renderWithRouter(ui, {
    at: "/c/prod/pods/k8s-gui-test/meshed-demo",
    route: "/c/$cluster/$",
  });

describe("RelatedResources", () => {
  beforeEach(() => vi.clearAllMocks());

  it("walks past the first hop to the object somebody actually deploys", async () => {
    /** A pod's owner is a hash nobody named. Stopping at it left the
     *  Deployment — the thing a person recognises and edits — off the page
     *  entirely, one API call away. */
    getReplicaset.mockResolvedValue({
      ownerReferences: [owner("Deployment", "meshed-demo")],
    });

    await wrap(
      <RelatedResources
        ownerReferences={[owner("ReplicaSet", "meshed-demo-65d47b457f")]}
        namespace="k8s-gui-test"
      />
    );

    expect(
      await screen.findByRole("link", { name: "Deployment meshed-demo" })
    ).toHaveAttribute("href", "/c/prod/deployments/k8s-gui-test/meshed-demo");
    expect(
      screen.getByRole("link", { name: "ReplicaSet meshed-demo-65d47b457f" })
    ).toBeInTheDocument();
  });

  /**
   * The pod's Overview said "the replica count is set here" of hello-web
   * while an HPA scaled it. Fails if the row stops reading the autoscaler
   * from the page's neighbourhood, or claims a setter before it answers.
   */
  it("names the autoscaler that sets the count, and claims nothing before the neighbourhood answers", async () => {
    getReplicaset.mockResolvedValue({
      ownerReferences: [owner("Deployment", "hello-web")],
    });
    const deployment = {
      kind: "Deployment",
      name: "hello-web",
      namespace: "k8s-gui-test",
      existence: "present" as const,
      facts: null,
    };
    const hpa = {
      ...deployment,
      kind: "HorizontalPodAutoscaler",
      facts: {
        kind: "autoscaler" as const,
        minReplicas: 1,
        maxReplicas: 2,
        currentReplicas: 1,
        desiredReplicas: 1,
        metrics: [],
        conditions: [],
        lastScaleTime: null,
      },
    };
    const refs = [owner("ReplicaSet", "hello-web-5966d9b889")];

    const { rerender } = await wrap(
      <RelatedResources ownerReferences={refs} namespace="k8s-gui-test" />
    );
    await screen.findByRole("link", { name: "Deployment hello-web" });
    expect(screen.queryByText(/replica count/)).toBeNull();

    await rerender(
      <RelatedResources
        ownerReferences={refs}
        namespace="k8s-gui-test"
        connections={{
          subject: { ...deployment, kind: "Pod", name: "hello-web-x" },
          edges: [
            {
              from: hpa,
              to: deployment,
              relation: { verb: "governs", selector: null },
            },
          ],
          stops: [],
          published: [],
          notLookedAt: [],
        }}
      />
    );
    expect(
      await screen.findByText(
        "the replica count is set by HorizontalPodAutoscaler hello-web"
      )
    ).toBeInTheDocument();
  });

  it("keeps the hop the object stated when the one above it cannot be read", async () => {
    /** RBAC denies one kind at a time. Dropping the whole chain because the
     *  next request was refused would lose a reference the object itself
     *  carried and the app never needed permission for. */
    getReplicaset.mockRejectedValue(new Error("forbidden"));

    await wrap(
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
    await wrap(
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
