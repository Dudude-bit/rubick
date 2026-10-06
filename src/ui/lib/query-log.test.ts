import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const logged = vi.hoisted(() => ({ lines: [] as string[] }));
vi.mock("@/lib/logger", () => ({
  logError: (message: string) => logged.lines.push(`ERROR ${message}`),
  logWarn: (message: string) => logged.lines.push(`WARN ${message}`),
}));

import { useClusterStore } from "@/stores/clusterStore";
import { logQueryFailure } from "./query-log";

const REFUSED = new Error(
  'Tauri command \'detectGatewayApi\' failed: Kubernetes API error: ApiError: customresourcedefinitions.apiextensions.k8s.io is forbidden: User "system:serviceaccount:team-checkout:marco" cannot list resource "customresourcedefinitions" at the cluster scope: Forbidden'
);

const query = (...queryKey: unknown[]) => ({
  queryKey,
  queryHash: JSON.stringify(queryKey),
});

const reconnect = () =>
  useClusterStore.setState((s) => ({
    connectionAttemptId: s.connectionAttemptId + 1,
  }));

beforeEach(() => {
  logged.lines.length = 0;
  reconnect();
});

describe("a failed read in the log", () => {
  /**
   * Marco's app.log was mostly ERROR lines for refusals every screen already
   * says, detectGatewayApi and listNamespaces on every route change. Fails if
   * a handled refusal is an ERROR, or is logged again on the same connection.
   */
  it("logs a refusal once per connection per read, as a warning", () => {
    const gateway = query("gateway-api", "acme-staging");
    logQueryFailure(REFUSED, gateway);
    logQueryFailure(REFUSED, gateway);
    logQueryFailure(REFUSED, query("namespaces"));
    logQueryFailure(REFUSED, gateway);
    expect(logged.lines).toEqual(["WARN Query refused", "WARN Query refused"]);

    reconnect();
    logQueryFailure(REFUSED, gateway);
    expect(logged.lines).toHaveLength(3);
  });

  /** Fails if the once-only rule swallows a read that broke, which the log is for. */
  it("logs every other failure as an error", () => {
    const failure = new Error("connection reset by peer");
    logQueryFailure(failure, query("pods"));
    logQueryFailure(failure, query("pods"));
    expect(logged.lines).toEqual(["ERROR Query error", "ERROR Query error"]);
  });
});
