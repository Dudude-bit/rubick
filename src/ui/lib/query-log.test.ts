import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const logged = vi.hoisted(() => ({ lines: [] as string[] }));
vi.mock("@/lib/logger", () => ({
  logError: (message: string) => logged.lines.push(`ERROR ${message}`),
  logWarn: (message: string) => logged.lines.push(`WARN ${message}`),
  logInfo: (message: string) => logged.lines.push(`INFO ${message}`),
}));

import { useClusterStore } from "@/stores/clusterStore";
import { logQueryFailure } from "./query-log";

const REFUSED = new Error(
  'Tauri command \'detectGatewayApi\' failed: Kubernetes API error: ApiError: customresourcedefinitions.apiextensions.k8s.io is forbidden: User "system:serviceaccount:team-checkout:marco" cannot list resource "customresourcedefinitions" at the cluster scope: Forbidden'
);

const NAMESPACES_REFUSED = new Error(
  'Tauri command \'listNamespaces\' failed: Kubernetes API error: namespaces is forbidden: User "system:serviceaccount:team-checkout:marco" cannot list resource "namespaces" in API group "" at the cluster scope'
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
    logQueryFailure(NAMESPACES_REFUSED, query("namespaces"));
    logQueryFailure(REFUSED, gateway);
    expect(logged.lines).toEqual(["WARN Query refused", "WARN Query refused"]);

    reconnect();
    logQueryFailure(REFUSED, gateway);
    expect(logged.lines).toHaveLength(3);
  });

  /**
   * Marco's switch to All namespaces logged services refused twice, once for
   * the list and once for its health inputs, and pods twice. Fails if two
   * reads the server refused in the same sentence take two lines.
   */
  it("logs one line for reads refused in the same sentence", () => {
    const services = (command: string) =>
      Object.assign(new Error(`Tauri command '${command}' failed: refused`), {
        cause: {
          code: "PERMISSION_DENIED",
          said: 'services is forbidden: User "marco" cannot list resource "services" in API group "" at the cluster scope',
        },
      });
    logQueryFailure(services("listServicesIn"), query("services", "all"));
    logQueryFailure(
      services("listServiceHealthInputs"),
      query("service-health", "all")
    );
    expect(logged.lines).toEqual(["WARN Query refused"]);
  });

  /**
   * Lena kept a pod's page open after a restart replaced the pod: the page,
   * its Connections and its lineage each logged an ERROR for the same gone
   * pod, and Dana's page logged getPod twice in 300 ms. Fails if an object
   * found gone is an error, or takes more than one line however many of its
   * readers find it gone.
   */
  it("logs an object found gone once, whichever of its readers found it", () => {
    const pod = "hello-web-5bc6cfc846-9qqvr";
    const gone = (command: string, said: string) =>
      Object.assign(new Error(`Tauri command '${command}' failed: ${said}`), {
        code: "NOT_FOUND",
      });
    const page = query("pod", "lena-sandbox", pod);
    logQueryFailure(
      gone("getPod", `Kubernetes API error: pods "${pod}" not found`),
      page
    );
    logQueryFailure(
      gone("getPod", `Kubernetes API error: pods "${pod}" not found`),
      page
    );
    logQueryFailure(
      gone(
        "getResourceConnections",
        `Resource not found: Pod/${pod} in namespace lena-sandbox`
      ),
      query("connections", "Pod", "lena-sandbox", pod, null)
    );
    logQueryFailure(
      gone("objectLineage", `Kubernetes API error: pods "${pod}" not found`),
      query("lineage", "", "pods", "lena-sandbox", pod)
    );
    expect(logged.lines).toEqual(["INFO Query found the object gone"]);

    logQueryFailure(
      gone("getPod", `Kubernetes API error: pods "${pod}" not found`),
      query("pod", "staging", pod)
    );
    expect(logged.lines).toHaveLength(2);

    reconnect();
    logQueryFailure(
      gone("getPod", `Kubernetes API error: pods "${pod}" not found`),
      page
    );
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
