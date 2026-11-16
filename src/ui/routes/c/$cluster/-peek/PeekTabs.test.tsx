import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { DeploymentInfo } from "@/generated/types";
import { queryKeys } from "@/lib/query-keys";
import { useClusterStore } from "@/stores/clusterStore";
import { renderWithRouter, testQueryClient } from "@/test/render";
import { PeekTabBody } from "./PeekTabs";

const ledger = {
  name: "ledger",
  namespace: "team-blind",
  uid: "uid",
  replicas: { desired: 1, ready: 1, available: 1, updated: 1 },
} as unknown as DeploymentInfo;

const detailKey = queryKeys.detail("Deployment", "team-blind", "ledger");

beforeEach(() => {
  useClusterStore.setState({ isConnected: true, currentContext: "prod" });
});

describe("a workload's peek, its Pods tab", () => {
  /**
   * Sam's quick delete and apply: the page said "Pods 0" beside a header
   * reading Ready 1/1, from a list asked a moment before the ReplicaSet was
   * made, and the peek draws the same pods. Fails if none read before the
   * peek's read of a Deployment that counts a pod ready is drawn as none, or
   * is not asked again.
   */
  it("counts none read before the Deployment it holds counts a pod ready as still reading, and asks again", async () => {
    let asked = 0;
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command !== "get_deployment_pods") return undefined;
      asked += 1;
      return asked === 1 ? { uid: "uid", pods: [] } : new Promise(() => {});
    });
    const client = testQueryClient();
    client.setQueryData(detailKey, ledger);
    await renderWithRouter(
      <PeekTabBody
        tab="children"
        target={{ kind: "Deployment", name: "ledger", namespace: "team-blind" }}
        detail={ledger}
        isDetailLoading={false}
      />,
      { client }
    );
    expect(
      await screen.findByText("This Deployment has no pods right now")
    ).toBeInTheDocument();

    await new Promise((resolve) => setTimeout(resolve, 5));
    client.setQueryData(detailKey, { ...ledger });

    await waitFor(() =>
      expect(
        screen.queryByText("This Deployment has no pods right now")
      ).toBeNull()
    );
    await waitFor(() => expect(asked).toBe(2));
  });
});

describe("an autoscaler's peek, its Connections tab", () => {
  const hpa = {
    kind: "HorizontalPodAutoscaler",
    name: "hello-web",
    namespace: "lena-sandbox",
  };
  const object = {
    apiVersion: "autoscaling/v2",
    kind: "HorizontalPodAutoscaler",
    metadata: { name: "hello-web", namespace: "lena-sandbox" },
    spec: {
      scaleTargetRef: {
        apiVersion: "apps/v1",
        kind: "Deployment",
        name: "hello-web",
      },
      minReplicas: 1,
      maxReplicas: 2,
    },
  };

  /** Lena's HPA peek said nothing knew what it connects to while the pod's tab named it; fails if the tab stops naming the scale target. */
  it("names what the autoscaler scales, linked, with its bounds", async () => {
    vi.mocked(invoke).mockResolvedValue(undefined);
    await renderWithRouter(
      <PeekTabBody
        tab="connections"
        target={hpa}
        detail={object}
        isDetailLoading={false}
      />,
      { at: "/c/prod/events", route: "/c/$cluster/events" }
    );
    expect(screen.getByText("Scales")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Deployment hello-web" })
    ).toHaveAttribute("href", "/c/prod/deployments/lena-sandbox/hello-web");
    expect(screen.getByText(/1 to 2 replicas/)).toBeInTheDocument();
  });

  /** An unread autoscaler is not one that scales nothing; fails if the tab draws the failed read as an empty answer. */
  it("says what it scales is not known when the autoscaler could not be read", async () => {
    await renderWithRouter(
      <PeekTabBody
        tab="connections"
        target={hpa}
        detail={undefined}
        isDetailLoading={false}
      />
    );
    expect(
      screen.getByText(/could not be read, so what it scales is not known/)
    ).toBeInTheDocument();
    expect(screen.queryByText(/names nothing to scale/)).toBeNull();
  });
});

describe("a pod's peek when the pod could not be read", () => {
  const target = { kind: "Pod", name: "api-1", namespace: "shop" };
  const refused = new Error("pods api-1 is forbidden");

  /**
   * Logs and Containers waited on a pod that never came and drew a skeleton
   * for ever. Fails if either tab does not say the pod was not read, with the
   * cause and a way to ask again.
   */
  it.each(["logs", "containers"] as const)(
    "says on the %s tab that the pod was not read, and asks again",
    async (tab) => {
      const retry = vi.fn();
      await renderWithRouter(
        <PeekTabBody
          tab={tab}
          target={target}
          detail={undefined}
          isDetailLoading={false}
          detailError={refused}
          onRetryDetail={retry}
        />
      );
      expect(screen.getByText("Could not read this Pod")).toBeInTheDocument();
      expect(screen.getByText(/pods api-1 is forbidden/)).toBeInTheDocument();
      expect(screen.queryByTestId("peek-rows-skeleton")).toBeNull();
      await userEvent.click(
        screen.getByRole("button", { name: "Try the read again" })
      );
      expect(retry).toHaveBeenCalled();
    }
  );

  /** The control: while the pod read is still on its way the tab is a skeleton and says nothing failed. */
  it("stays a skeleton while the pod is still being read", async () => {
    await renderWithRouter(
      <PeekTabBody
        tab="logs"
        target={target}
        detail={undefined}
        isDetailLoading
        detailError={null}
      />
    );
    expect(screen.getByTestId("peek-rows-skeleton")).toBeInTheDocument();
    expect(screen.queryByText("Could not read this Pod")).toBeNull();
  });
});

describe("a DaemonSet's peek when the DaemonSet could not be read", () => {
  /**
   * Its pods are found by the selector the DaemonSet names, so the pods read
   * never starts and the tab waited for ever. Fails if the Pods tab draws a
   * skeleton instead of the cause of the unread DaemonSet.
   */
  it("says the Pods tab cannot be read instead of waiting on it", async () => {
    await renderWithRouter(
      <PeekTabBody
        tab="children"
        target={{ kind: "DaemonSet", name: "agent", namespace: "kube-system" }}
        detail={undefined}
        isDetailLoading={false}
        detailError={new Error("daemonsets is forbidden")}
      />
    );
    expect(
      await screen.findByText("Could not read this DaemonSet")
    ).toBeInTheDocument();
    expect(screen.getByText(/daemonsets is forbidden/)).toBeInTheDocument();
  });
});
