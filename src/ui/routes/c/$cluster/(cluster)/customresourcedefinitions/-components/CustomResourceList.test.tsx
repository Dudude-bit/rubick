import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { screen } from "@testing-library/react";

const store = vi.hoisted(() => ({
  state: {
    currentNamespace: "default",
    namespaceScope: [] as string[],
    isConnected: true,
    currentContext: "prod",
    contexts: [{ name: "prod", namespace: null }],
  },
}));

vi.mock("@/stores/clusterStore", () => ({
  useClusterStore: vi.fn(<T,>(selector?: (s: typeof store.state) => T) =>
    typeof selector === "function" ? selector(store.state) : store.state
  ),
}));

import { commands } from "@/lib/commands";
import { renderWithRouter } from "@/test/render";
import { CustomResourceList } from "./CustomResourceList";

afterEach(() => {
  vi.restoreAllMocks();
});

/** The `widgets.demo.k8s-gui.io` specimen, one instance. */
const widget = {
  name: "blue",
  namespace: "k8s-gui-test",
  uid: "w1",
  apiVersion: "demo.k8s-gui.io/v1",
  kind: "Widget",
  spec: { size: 3 },
  status: null,
  labels: {},
  annotations: {},
  createdAt: null,
  ownerReferences: [],
  generation: 1,
};

describe("a custom resource list's count", () => {
  /**
   * Sam's widgets list ended "1 widgets": the plural stood in for the kind,
   * so the count could not agree with its number. Fails if the footer stops
   * naming one instance by its kind.
   */
  it("names one instance by its kind", async () => {
    vi.spyOn(commands, "listCustomResourcesIn").mockResolvedValue({
      rows: [widget],
      unread: [],
    });
    vi.spyOn(commands, "subscribeCustomResourceWatch").mockResolvedValue(
      "w" as never
    );
    await renderWithRouter(
      <CustomResourceList
        crdName="widgets.demo.k8s-gui.io"
        crdKind="Widget"
        crdGroup="demo.k8s-gui.io"
        crdVersion="v1"
        crdPlural="widgets"
        scope="Namespaced"
      />,
      { at: "/c/prod/customresourcedefinitions", route: "/c/$cluster/$" }
    );
    expect(await screen.findByText("1 Widget")).toBeInTheDocument();
    expect(screen.queryByText("1 widgets")).toBeNull();
  });
});
