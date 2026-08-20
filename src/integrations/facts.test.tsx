/**
 * A cluster fact belongs to the cluster that gave it.
 *
 * The counts beside the rail's rows are keyed by context; the facts were
 * not, and a fact is the louder of the two. "2 renewals overdue" carried
 * over from the cluster you just left is not stale inventory — it is an
 * accusation aimed at the wrong place, and the reader has no way to tell.
 */
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/lib/commands", () => ({
  commands: {
    detectInClusterExtensions: vi.fn(async () => []),
    listCustomResources: vi.fn(async () => []),
    getPrometheusConnection: vi.fn(async () => null),
    probePrometheus: vi.fn(async () => null),
    getLokiConnection: vi.fn(async () => null),
  },
}));

import { commands } from "@/lib/commands";
import { useClusterStore } from "@/stores/clusterStore";
import type { CustomResourceInfo } from "@/generated/types";

import { useIntegrations } from "./index";

const DAY = 86_400_000;
const inDays = (days: number) =>
  new Date(Date.now() + days * DAY).toISOString();

let uids = 0;

/** Short-lived, issued, and past the renewal cert-manager promised. */
function overdueCertificate(): CustomResourceInfo {
  uids += 1;
  return {
    name: `cert-${uids}`,
    namespace: "shop",
    uid: `uid-${uids}`,
    apiVersion: "cert-manager.io/v1",
    kind: "Certificate",
    spec: {},
    status: {
      conditions: [{ type: "Ready", status: "True" }],
      notBefore: inDays(-4.75),
      notAfter: inDays(2.25),
      renewalTime: inDays(-0.5),
    },
    labels: {},
    annotations: {},
    createdAt: null,
    ownerReferences: [],
  };
}

let client: QueryClient;
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={client}>{children}</QueryClientProvider>
);

function certManagerLines(
  statuses: ReturnType<typeof useIntegrations>["statuses"]
): string[] {
  const state = statuses.find(
    (status) => status.vendor.id === "cert-manager"
  )?.facts;
  return state?.state === "ready" ? state.facts.map((fact) => fact.text) : [];
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(commands.detectInClusterExtensions).mockResolvedValue([
    { id: "cert-manager", installed: true, version: "v1.16.2" },
  ]);
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  useClusterStore.setState({ currentContext: "prod-eu", isConnected: true });
});

describe("the extensions' cluster facts", () => {
  /**
   * Would break if the facts cache were shared between clusters: the reader
   * switches to a cluster with nothing wrong in it and is still told a
   * renewal is overdue, while that cluster is never even asked.
   */
  it("asks the cluster it is now standing in, not the one before", async () => {
    vi.mocked(commands.listCustomResources).mockResolvedValue([
      overdueCertificate(),
    ]);
    const { result } = renderHook(() => useIntegrations(), { wrapper });
    await waitFor(() =>
      expect(certManagerLines(result.current.statuses)).toContain(
        "1 renewal overdue"
      )
    );

    vi.mocked(commands.listCustomResources).mockResolvedValue([]);
    act(() => useClusterStore.setState({ currentContext: "staging" }));

    await waitFor(() =>
      expect(certManagerLines(result.current.statuses)).toEqual([
        "0 certificates",
      ])
    );
    expect(commands.listCustomResources).toHaveBeenCalledTimes(2);
  });
});
