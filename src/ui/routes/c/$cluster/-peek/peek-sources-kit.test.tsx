import { screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { useClusterStore } from "@/stores/clusterStore";
import { renderWithRouter } from "@/test/render";

const crds = vi.hoisted(() => ({
  answer: () => new Promise<unknown>(() => {}),
}));

vi.mock("@/lib/commands", () => ({
  commands: { listCrds: () => crds.answer() },
}));

const { controlledBy, ref } = await import("./peek-sources-kit");

const say = ((_section: string, key: string) => key) as never;

const owners = [
  { api_version: "apps/v1", kind: "StatefulSet", name: "db", uid: "1" },
  {
    apiVersion: "apps.kruise.io/v1beta1",
    kind: "StatefulSet",
    name: "kruise-db",
    uid: "2",
  },
];

const renderOwners = () =>
  renderWithRouter(
    <>{controlledBy(owners, "shop", say)[0].items.map((item) => item.value)}</>
  );

beforeEach(() => {
  useClusterStore.setState({ currentContext: "test", isConnected: true });
});

describe("what controls an object, in the peek", () => {
  /**
   * Linked by kind name alone, a pod an OpenKruise StatefulSet made opened
   * the apps/v1 StatefulSet page of an object that does not exist.
   */
  it("opens a namesake owner on its CRD's page and the built-in owner on its own", async () => {
    crds.answer = () =>
      Promise.resolve([
        {
          group: "apps.kruise.io",
          crds: [
            {
              name: "statefulsets.apps.kruise.io",
              group: "apps.kruise.io",
              kind: "StatefulSet",
            },
          ],
        },
      ]);
    await renderOwners();
    expect(
      await screen.findByRole("link", { name: "StatefulSet kruise-db" })
    ).toHaveAttribute(
      "href",
      "/c/test/statefulsets.apps.kruise.io/shop/kruise-db"
    );
    expect(
      screen.getByRole("link", { name: "StatefulSet db" })
    ).toHaveAttribute("href", "/c/test/statefulsets/shop/db");
  });

  /** While the CRDs are unread a namesake is text, never the built-in's page. */
  it("draws a namesake owner as text until its CRD is known", async () => {
    crds.answer = () => new Promise(() => {});
    await renderOwners();
    expect(
      await screen.findByRole("link", { name: "StatefulSet db" })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "StatefulSet kruise-db" })
    ).toBeNull();
    expect(screen.getByText("StatefulSet kruise-db")).toBeInTheDocument();
  });
});

describe("a reference in a peek row", () => {
  /**
   * The ClusterRoleBinding peek cut "system:controller:clusterrole-aggregation-co"
   * at the panel's edge with no ellipsis: the link took the name's whole
   * width and the panel clipped it. Fails if a peek reference stops being
   * bounded by its row, which is what lets the name end in an ellipsis.
   */
  it("is bounded by its row so a long name ends in an ellipsis", async () => {
    await renderWithRouter(
      <dl>
        <dd>
          {ref(
            "ClusterRole",
            "system:controller:clusterrole-aggregation-controller"
          )}
        </dd>
      </dl>
    );
    const link = await screen.findByRole("link");
    expect(link).toHaveClass("max-w-full", "min-w-0");
    expect(screen.getByTestId("resource-ref-stem").parentElement).toHaveClass(
      "truncate"
    );
  });
});
