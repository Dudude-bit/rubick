/**
 * Pointing at a Service the search cannot recognise (#71).
 *
 * The search matches a Service by the vendor's own name and label, which is
 * right for the thing it names and useless for anything that merely speaks
 * its API: a VictoriaMetrics is called `vmsingle`, wears no Prometheus label,
 * listens on 8428 and answers the same queries. Worse, its query API is not
 * at the root — so an address that stops at the port tests green and then
 * 404s on every query.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";

import type { ServiceInfo } from "@/generated/types";

const listServices = vi.fn();
const portForwardService = vi.fn(
  async (
    _service: unknown,
    _namespace: unknown,
    config: { localPort: number }
  ) => ({
    id: "pf-1",
    localPort: config.localPort,
  })
);

vi.mock("@/lib/commands", () => ({
  commands: {
    listServices: (filters: unknown) => listServices(filters),
    portForwardService: (
      service: unknown,
      namespace: unknown,
      config: { localPort: number }
    ) => portForwardService(service, namespace, config),
    portForwardSubscribed: vi.fn(async () => undefined),
    listPortForwards: vi.fn(async () => []),
    listPortForwardConfigs: vi.fn(async () => []),
  },
}));

const { InCluster } = await import("./ConnectIntegration");
const { useClusterStore } = await import("@/stores/clusterStore");

// Radix's Select asks the DOM two things jsdom does not implement. Without
// them the listbox never opens and the test fails on the widget rather than
// on the behaviour it is about.
beforeAll(() => {
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.releasePointerCapture ??= () => {};
  Element.prototype.scrollIntoView ??= () => {};
});

const vmsingle = {
  name: "vmsingle-victoria-metrics-k8s-stack",
  namespace: "monitoring",
  uid: "u1",
  type: "ClusterIP",
  sessionAffinity: "None",
  clusterIp: "10.0.0.9",
  externalIps: [],
  loadBalancerIps: [],
  ports: [{ name: "http", port: 8428, targetPort: 8428, protocol: "TCP" }],
  selector: { "app.kubernetes.io/name": "vmsingle" },
  labels: { "app.kubernetes.io/name": "vmsingle" },
  annotations: {},
  createdAt: null,
} as unknown as ServiceInfo;

beforeEach(() => {
  vi.clearAllMocks();
  listServices.mockResolvedValue([vmsingle]);
  useClusterStore.setState({ currentContext: "prod" });
});

const hint = { names: ["prometheus"], ports: [9090] };

describe("pointing at a Service the search cannot find", () => {
  it("is offered even before the search has been run", async () => {
    render(
      <InCluster hint={hint} vendorName="Prometheus" onPicked={vi.fn()} />
    );
    expect(
      screen.getByRole("button", { name: "Point at a Service yourself" })
    ).toBeInTheDocument();
  });

  /**
   * A Service the search did find is one click, and the tunnel that click
   * opens is this cluster's. Fails if it is asked for with no cluster named,
   * which the backend used to read as "wherever the window is by then".
   */
  it("forwards a Service the search found on the cluster the dialog is on", async () => {
    const user = userEvent.setup();
    const prometheus = {
      ...vmsingle,
      name: "prometheus",
      ports: [{ name: "http", port: 9090, targetPort: 9090, protocol: "TCP" }],
    };
    listServices.mockResolvedValue([prometheus]);
    render(
      <InCluster hint={hint} vendorName="Prometheus" onPicked={vi.fn()} />
    );

    await user.click(screen.getByRole("button", { name: /Prometheus/ }));
    await user.click(
      await screen.findByRole("button", { name: /monitoring\/prometheus/ })
    );

    await waitFor(() => expect(portForwardService).toHaveBeenCalled());
    expect(portForwardService.mock.calls[0][2]).toMatchObject({
      context: "prod",
    });
  });

  /**
   * The assertion the issue is about: the port is the one chosen rather than
   * the vendor's 9090, and the address carries the subpath the API sits under.
   */
  it("forwards the chosen port and gives back an address with the subpath", async () => {
    const user = userEvent.setup();
    const picked = vi.fn();
    render(<InCluster hint={hint} vendorName="Prometheus" onPicked={picked} />);

    await user.click(
      screen.getByRole("button", { name: "Point at a Service yourself" })
    );
    await waitFor(() => expect(listServices).toHaveBeenCalled());

    await user.click(screen.getByRole("combobox", { name: "Service" }));
    await user.click(
      await screen.findByRole("option", {
        name: "monitoring/vmsingle-victoria-metrics-k8s-stack",
      })
    );

    await user.click(screen.getByRole("combobox", { name: "Port" }));
    await user.click(await screen.findByRole("option", { name: /8428/ }));
    await user.type(screen.getByLabelText("Subpath"), "/prometheus");
    await user.click(screen.getByRole("button", { name: "Forward it" }));

    await waitFor(() => expect(picked).toHaveBeenCalled());
    // Asked for on the cluster the dialog is on, by name.
    expect(portForwardService.mock.calls[0][2]).toMatchObject({
      context: "prod",
    });
    const forwarded = picked.mock.calls[0][0];
    expect(forwarded.remotePort).toBe(8428);
    expect(forwarded.subpath).toBe("/prometheus");
    expect(forwarded.url).toBe(
      `http://localhost:${forwarded.localPort}/prometheus`
    );
    // Two popovers opened and picked from, in jsdom: the default five seconds
    // is not a statement about this code, it is the widget being slow here.
  }, 20_000);
});
