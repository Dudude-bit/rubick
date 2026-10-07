import { describe, expect, it, vi } from "vite-plus/test";
import { screen, waitFor, within } from "@testing-library/react";

const command = vi.hoisted(() => {
  const made = new Map<string, ReturnType<typeof vi.fn>>();
  return (name: string) => {
    const known = made.get(name) ?? vi.fn(async () => null);
    made.set(name, known);
    return known;
  };
});
vi.mock("@/lib/commands", () => ({
  commands: new Proxy({}, { get: (_, name) => command(String(name)) }),
}));

import type { CrdDetailInfo } from "@/generated/types";
import { useClusterStore } from "@/stores/clusterStore";
import { renderWithRouter } from "@/test/render";
import { CrdDetail } from "./CrdDetail";

const NAME = "widgets.demo.k8s-gui.io";

const widgets = {
  name: NAME,
  group: "demo.k8s-gui.io",
  kind: "Widget",
  plural: "widgets",
  singular: "widget",
  scope: "Namespaced",
  versions: [],
  shortNames: [],
  categories: [],
  labels: {},
  annotations: {},
  conditions: [],
  createdAt: null,
  acceptedNames: {
    kind: "Widget",
    plural: "widgets",
    singular: "widget",
    shortNames: [],
    categories: [],
    listKind: "WidgetList",
  },
} satisfies CrdDetailInfo;

/**
 * The page passed the CRD's kind where the frame takes the object's name, so
 * every open asked the cluster for a CustomResourceDefinition named "Widget"
 * and logged its NotFound, and the copy button copied the kind.
 */
describe("a CRD's page", () => {
  it("names the object by its metadata.name, and asks for its owners by it", async () => {
    useClusterStore.setState({ currentContext: "prod", isConnected: true });
    command("getCrd").mockResolvedValue(widgets);

    await renderWithRouter(<CrdDetail />, {
      at: `/c/prod/customresourcedefinitions/${NAME}`,
      route: "/c/$cluster/customresourcedefinitions/$name",
    });

    await screen.findAllByText("Widget");
    await waitFor(() => expect(command("objectLineage")).toHaveBeenCalled());
    const asked = command("objectLineage").mock.calls.map((call) => call[2]);
    expect(asked).not.toContain("Widget");
    expect(asked).toContain(NAME);
    expect(
      within(screen.getByRole("heading", { level: 1 })).getByText(NAME)
    ).toBeInTheDocument();
  });
});
