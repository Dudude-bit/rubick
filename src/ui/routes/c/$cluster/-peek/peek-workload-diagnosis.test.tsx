import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { screen } from "@testing-library/react";

import type {
  DeploymentInfo,
  ObjectRef,
  ResourceConnections,
} from "@/generated/types";
import type { T } from "@/i18n/useT";
import type { PeekTarget } from "@/hooks/usePeek";
import { renderWithRouter } from "@/test/render";

const subject: ObjectRef = {
  kind: "Deployment",
  name: "cart",
  namespace: "shop",
  existence: "present",
  facts: null,
};

const neighbourhood: { current: ResourceConnections | undefined } = {
  current: undefined,
};

vi.mock("@/hooks/useConnections", () => ({
  useConnections: () => ({ data: neighbourhood.current }),
}));

import { WORKLOAD_SOURCES } from "./peek-sources-workloads";

const blind: ResourceConnections = {
  subject,
  edges: [
    {
      from: {
        kind: "HorizontalPodAutoscaler",
        name: "cart",
        namespace: "shop",
        existence: "present",
        facts: {
          kind: "autoscaler",
          minReplicas: 2,
          maxReplicas: 5,
          currentReplicas: 2,
          desiredReplicas: 0,
          metrics: [
            { name: "cpu", source: "resource", target: "60%", current: null },
          ],
          conditions: [
            {
              type: "ScalingActive",
              status: "False",
              reason: "FailedGetResourceMetric",
              message: "the HPA was unable to compute the replica count",
              lastTransitionTime: null,
            },
          ],
          lastScaleTime: null,
        },
      },
      to: subject,
      relation: { verb: "governs", selector: null },
    },
  ],
  stops: [],
  published: [],
  notLookedAt: [],
};

function deployment(over: Partial<DeploymentInfo>): DeploymentInfo {
  return {
    name: "cart",
    namespace: "shop",
    replicas: { desired: 2, ready: 2, available: 2, updated: 2 },
    rollout: { state: "ready" },
    strategy: "RollingUpdate",
    containers: [],
    initContainers: [],
    ownerReferences: [],
    createdAt: null,
    ...over,
  } as DeploymentInfo;
}

const target: PeekTarget = {
  kind: "Deployment",
  name: "cart",
  namespace: "shop",
};
const t = ((section: string, key: string, values?: Record<string, unknown>) =>
  values?.name
    ? `${section}.${key}:${String(values.name)}`
    : `${section}.${key}`) as T;

async function lead(info: DeploymentInfo) {
  const summary = WORKLOAD_SOURCES.Deployment!.summarise(info, target, t);
  await renderWithRouter(summary.lead as ReactElement);
  return summary;
}

describe("the peek says what the workload's page says first", () => {
  /**
   * Dana's `cart`: green Ready in the peek while the page said its HPA could
   * not read metrics. The finding has to arrive through the page's reader.
   */
  it("names an autoscaler that cannot read its metrics over a Ready rollout", async () => {
    neighbourhood.current = blind;
    const summary = await lead(deployment({}));
    expect(summary.status).toBe("Ready");
    expect(await screen.findByText(/cart is not scaling this/)).toHaveClass(
      "text-err"
    );
    expect(screen.queryByTestId("rollout-summary")).toBeNull();
  });

  /** The stuck `search` rollout read Ready in the peek with no hint of the new ReplicaSet. */
  it("says a stalled rollout is stalled, in the controller's own words", async () => {
    neighbourhood.current = { ...blind, edges: [] };
    const summary = await lead(
      deployment({
        rollout: {
          state: "stalled",
          message: 'ReplicaSet "search-6df9f694b5" has timed out progressing.',
          serving: 2,
        },
      })
    );
    expect(summary.status).toBe("Stalled");
    const line = await screen.findByTestId("rollout-summary");
    expect(line.textContent).toContain("2 old pods still serve");
    expect(line).toHaveClass("text-err");
    expect(line.textContent).toContain("has timed out progressing");
  });
});
