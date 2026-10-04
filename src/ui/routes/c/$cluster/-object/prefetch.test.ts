import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { queryKeys } from "@/lib/query-keys";
import { ResourceType } from "@/lib/resource-registry";
import { setTransport, transport, type Transport } from "@/lib/transport";
import { fakeTransport } from "@/lib/transport/fake";
import { useClusterStore } from "@/stores/clusterStore";
import { prefetchObject } from "./prefetch";

const POD = { name: "api-0", namespace: "shop" };
const CERTIFICATE = { name: "web", namespace: "shop" };

let asked: string[];
let real: Transport;

beforeEach(() => {
  asked = [];
  real = transport();
  setTransport(
    fakeTransport({
      get_pod: (args) => (asked.push(`pod ${args?.name}`), POD),
      get_custom_resource: (args) => (
        asked.push(`${args?.crdName} ${args?.name}`),
        CERTIFICATE
      ),
    }).transport
  );
  useClusterStore.setState({ currentContext: "prod", isConnected: true });
});

afterEach(() => setTransport(real));

describe("reading an object before its page opens", () => {
  /** Without it the page opens on a spinner and asks the same question again. */
  it("fills the entry the object's page reads", async () => {
    const client = new QueryClient();
    await prefetchObject(
      client,
      { cluster: "prod", namespace: "shop", name: "api-0" },
      "pods"
    );
    expect(
      client.getQueryData(queryKeys.detail(ResourceType.Pod, "shop", "api-0"))
    ).toEqual(POD);
  });

  /**
   * The key has no cluster in it: a link into staging read while connected
   * to prod would show prod's api-0 on staging's page.
   */
  it("asks nothing for a link into a cluster the window is not connected to", async () => {
    const client = new QueryClient();
    await prefetchObject(
      client,
      { cluster: "staging", namespace: "shop", name: "api-0" },
      "pods"
    );
    expect(asked).toEqual([]);
    expect(client.getQueryCache().getAll()).toEqual([]);
  });

  /** A custom resource read by kind would ask the core API for it and get a 404. */
  it("reads a custom resource through the CRD its address names", async () => {
    const client = new QueryClient();
    await prefetchObject(client, {
      cluster: "prod",
      resource: "certificates.cert-manager.io",
      namespace: "shop",
      name: "web",
    });
    expect(asked).toEqual(["certificates.cert-manager.io web"]);
    expect(
      client.getQueryData(
        queryKeys.customResource("certificates.cert-manager.io", "shop", "web")
      )
    ).toEqual(CERTIFICATE);
  });
});
