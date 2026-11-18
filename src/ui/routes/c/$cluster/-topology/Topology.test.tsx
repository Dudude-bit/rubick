import { screen } from "@testing-library/react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";

import type { MapKindState } from "@/generated/types";
import { useClusterStore } from "@/stores/clusterStore";
import { renderWithRouter } from "@/test/render";

const given = vi.hoisted(() => ({
  classes: null as unknown,
  kinds: [] as MapKindState[],
}));

vi.mock("../-map/useTopology", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../-map/useTopology")>()),
  useTopology: () => ({
    phase: "ready",
    nodes: new Map(),
    edges: new Map(),
    reads: new Map(),
    kinds: given.kinds,
    end: null,
    error: null,
    version: 1,
    firstWhole: 0,
  }),
}));
vi.mock("../-map/GraphCanvas", () => ({
  GraphCanvas: () => <div data-testid="canvas" />,
}));
vi.mock("@/hooks/useRoutesBoard", () => ({
  useRoutesBoard: () => ({
    board: { notServing: [], unknown: [], serving: [], mesh: [], pulse: [] },
    gatewaysAll: { data: [], error: null },
    classes: { data: undefined, error: given.classes },
    topologyKnown: given.classes === null,
  }),
}));
vi.mock("@/hooks/useIngressHealth", () => ({
  useIngressHealth: () => () => null,
}));
vi.mock("@/hooks/useServiceHealthInputs", () => ({
  useServiceHealthInputs: () => undefined,
}));
vi.mock("./vendor-layers", () => ({
  useVendorLayers: () => ({ nodes: [], edges: [], unread: [] }),
}));

const { Topology } = await import("./Topology");

const open = () =>
  renderWithRouter(<Topology />, {
    at: "/c/prod/topology",
    route: "/c/$cluster/topology",
  });

beforeEach(() => {
  given.classes = null;
  given.kinds = [];
  useClusterStore.setState({
    currentContext: "prod",
    isConnected: true,
    namespaceScope: [],
  });
});
afterEach(() => {
  useClusterStore.setState({ currentContext: null, isConnected: false });
});

describe("the Topology screen", () => {
  /**
   * The line saying why routes and Gateways are drawn not checked reached
   * Share and the image and not the screen. Fails if a failed GatewayClass
   * list is not said above the map.
   */
  it("says above the map why routes and Gateways are not checked", async () => {
    given.classes = new Error("gatewayclasses is forbidden");
    await open();
    expect(screen.getByTestId("topology-not-read")).toHaveTextContent(
      "GatewayClass could not be read, so routes and Gateways are drawn not checked: gatewayclasses is forbidden"
    );
  });
});
