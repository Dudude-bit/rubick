import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import { act, screen } from "@testing-library/react";

import { setTransport, transport } from "@/lib/transport";
import { fakeTransport } from "@/lib/transport/fake";
import { useClusterStore } from "@/stores/clusterStore";
import { renderWithRouter } from "@/test/render";
import { ClusterOverview } from "./ClusterOverview";

const refused = (resource: string) => () => {
  throw {
    code: "PERMISSION_DENIED",
    message: `Kubernetes API error: ApiError: ${resource} is forbidden: User "system:serviceaccount:team-checkout:marco" cannot list resource "${resource}" at the cluster scope: Forbidden`,
  };
};

const REFUSED_READS = {
  get_cluster_overview: refused("pods"),
  list_ingress_health_inputs: refused("ingresses.networking.k8s.io"),
  list_autoscalers_in: refused("horizontalpodautoscalers.autoscaling"),
  list_service_health_inputs: refused("services"),
  list_persistent_volume_claims_in: refused("persistentvolumeclaims"),
};

const asks = new Map<string, number>();
const real = transport();
setTransport(
  fakeTransport(
    Object.fromEntries(
      Object.entries(REFUSED_READS).map(([command, answer]) => [
        command,
        () => {
          asks.set(command, (asks.get(command) ?? 0) + 1);
          return answer();
        },
      ])
    )
  ).transport
);
afterAll(() => setTransport(real));

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  asks.clear();
  useClusterStore.setState((s) => ({
    isConnected: true,
    currentContext: "acme-staging",
    namespaceScope: [],
    connectionAttemptId: s.connectionAttemptId + 1,
  }));
});

afterEach(() => vi.useRealTimers());

describe("the All namespaces Overview as a reader of one namespace", () => {
  /**
   * Marco's Overview asked five reads it had already been refused every ten
   * seconds, each one a 403 in the cluster's audit log and an ERROR line in
   * the app's: about thirty a minute. Fails if any of them is asked again on
   * the same connection.
   */
  it("asks each refused read once a connection, not on every refresh", async () => {
    await renderWithRouter(<ClusterOverview />, {
      at: "/c/acme-staging",
      route: "/c/$cluster",
    });
    expect(
      await screen.findByText(
        /do not have permission to read the whole cluster/
      )
    ).toBeVisible();

    await act(() => vi.advanceTimersByTimeAsync(60_000));

    expect(Object.fromEntries(asks)).toEqual({
      get_cluster_overview: 1,
      list_ingress_health_inputs: 1,
      list_autoscalers_in: 1,
      list_service_health_inputs: 1,
      list_persistent_volume_claims_in: 1,
    });
    expect(
      screen.getByText(/do not have permission to read the whole cluster/)
    ).toBeVisible();
  });
});
