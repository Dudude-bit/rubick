import type { UseMutationResult } from "@tanstack/react-query";
import { fireEvent, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { ObjectRef, ResourceConnections } from "@/generated/types";
import { useClusterStore } from "@/stores/clusterStore";
import { renderWithRouter } from "@/test/render";

const getResourceConnections = vi.hoisted(() => vi.fn());

vi.mock("@/lib/commands", () => ({
  commands: {
    getResourceConnections,
    objectLineage: () =>
      Promise.resolve({ uid: "d", ancestors: [], others: [], stop: null }),
    previewCascade: () =>
      Promise.resolve({
        takes: [{ kind: "Pod", group: "", plural: "pods", count: 3 }],
        notRead: { kinds: [], groups: [], watched: 40 },
        holds: null,
      }),
  },
}));

const { DeleteAction } = await import("./DeleteAction");

const mutate = vi.fn();
const mutation = {
  mutate,
  isPending: false,
} as unknown as UseMutationResult<void, Error, void>;

beforeEach(() => {
  mutate.mockReset();
  getResourceConnections.mockReset();
  useClusterStore.setState({ currentContext: "test", isConnected: true });
});

const renderDelete = () =>
  renderWithRouter(
    <DeleteAction
      kind="Deployment"
      name="api"
      namespace="shop"
      intercept={null}
      mutation={mutation}
    />
  );

describe("Delete on a detail page", () => {
  /** Every detail page deleted on the click itself until this asked first. */
  it("asks first and deletes nothing on the click", async () => {
    await renderDelete();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(await screen.findByRole("alertdialog")).toBeInTheDocument();
    expect(await screen.findByText("Also deletes:")).toBeInTheDocument();
    expect(mutate).not.toHaveBeenCalled();
  });

  /** However long the preview grows, the field to type the name stays on screen. */
  it("keeps the confirmation field outside the preview's own scroller", async () => {
    await renderDelete();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await screen.findByText("Also deletes:");
    const scroller = screen.getByTestId("confirm-details");
    expect(scroller).toHaveClass("overflow-y-auto");
    expect(scroller).toContainElement(screen.getByText("Also deletes:"));
    expect(scroller).not.toContainElement(screen.getByRole("textbox"));
  });

  /** The confirmation is the name typed, not a second click in the same place. */
  it("deletes once the name is typed and confirmed", async () => {
    await renderDelete();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("alertdialog");
    const confirm = Array.from(dialog.querySelectorAll("button")).find(
      (button) => button.textContent === "Delete"
    )!;
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "api" } });
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);
    expect(mutate).toHaveBeenCalledTimes(1);
  });
});

describe("Restart on a pod's page", () => {
  const owned = {
    name: "cart-1",
    namespace: "shop",
    status: { phase: "Running" },
    ownerReferences: [
      {
        api_version: "apps/v1",
        kind: "ReplicaSet",
        name: "cart-75",
        uid: "rs",
        controller: true,
      },
    ],
  };

  /** The page's Restart deleted the pod on the click, like the peek's did. */
  it("asks with the delete's facts and restarts nothing on the click", async () => {
    await renderWithRouter(
      <DeleteAction
        restart
        kind="Pod"
        name="cart-1"
        namespace="shop"
        detail={owned}
        intercept={null}
        mutation={mutation}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Restart" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("Restart pod shop/cart-1?");
    expect(dialog).toHaveTextContent(
      "Its ReplicaSet cart-75 will start a replacement."
    );
    expect(await screen.findByText("Also deletes:")).toBeInTheDocument();
    expect(mutate).not.toHaveBeenCalled();

    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "cart-1" },
    });
    fireEvent.click(
      Array.from(dialog.querySelectorAll("button")).find(
        (button) => button.textContent === "Restart"
      )!
    );
    expect(mutate).toHaveBeenCalledTimes(1);
  });
});

describe("Delete on a Service that Ingresses route to", () => {
  const ref = (kind: string, name: string): ObjectRef => ({
    kind,
    name,
    namespace: "k8s-gui-test",
    existence: "present",
    facts: null,
  });
  const service = ref("Service", "topology-demo");
  const routes = (
    ingress: string,
    host: string
  ): ResourceConnections["edges"][number] => ({
    from: ref("Ingress", ingress),
    to: service,
    relation: {
      verb: "routes",
      host,
      path: "/",
      pathType: "Prefix",
      port: "80",
      tls: false,
    },
  });
  const neighbourhood = (
    over: Partial<ResourceConnections> = {}
  ): ResourceConnections => ({
    subject: service,
    edges: [
      routes("dupe-nginx-new", "legacy.nginx.k8s-gui.test"),
      routes("promo-nginx-canary", "promo.nginx.k8s-gui.test"),
      {
        from: service,
        to: ref("Pod", "topology-demo-1"),
        relation: { verb: "selects", selector: "app=topology-demo" },
      },
    ],
    stops: [],
    published: [],
    notLookedAt: [],
    ...over,
  });

  const openDelete = async () => {
    await renderWithRouter(
      <DeleteAction
        kind="Service"
        name="topology-demo"
        namespace="k8s-gui-test"
        intercept={null}
        mutation={mutation}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    return screen.findByRole("alertdialog");
  };

  /**
   * Sam's Delete on topology-demo said only "Also deletes: EndpointSlice 1"
   * while two Ingresses route to it and stay, pointing at nothing. Fails
   * unless the dialog names both, with the route each sends.
   */
  it("names the Ingresses left routing to it", async () => {
    getResourceConnections.mockResolvedValue(neighbourhood());
    const dialog = await openDelete();
    const left = await within(dialog).findByTestId("dependents");
    expect(left).toHaveTextContent("Left behind, still pointing at it:");
    expect(left).toHaveTextContent(
      "Ingressdupe-nginx-newlegacy.nginx.k8s-gui.test/"
    );
    expect(left).toHaveTextContent(
      "promo-nginx-canarypromo.nginx.k8s-gui.test/"
    );
    expect(left).not.toHaveTextContent("topology-demo-1");
  });

  /**
   * A refused or failed read is not "nothing points at it". Fails if the
   * dialog falls silent when the neighbourhood could not be read.
   */
  it("says it could not check when the neighbourhood read fails", async () => {
    getResourceConnections.mockRejectedValue(new Error("connection reset"));
    const dialog = await openDelete();
    expect(
      await within(dialog).findByText(/Could not check what points at it/)
    ).toBeInTheDocument();
    expect(within(dialog).queryByTestId("dependents")).toBeNull();
  });

  /**
   * Marco may not list Ingresses, so an Ingress routing here would be
   * invisible. Fails unless the kinds the read skipped are named.
   */
  it("names the kinds it could not check for references", async () => {
    getResourceConnections.mockResolvedValue(
      neighbourhood({
        edges: [],
        notLookedAt: [
          {
            kind: "Ingress",
            why: { says: "unanswered", version: "v1", said: "forbidden" },
          },
        ],
      })
    );
    const dialog = await openDelete();
    expect(
      await within(dialog).findByText(
        "Not checked for references to it: Ingress."
      )
    ).toBeInTheDocument();
  });
});
