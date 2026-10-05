import type { UseMutationResult } from "@tanstack/react-query";
import { fireEvent, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { useClusterStore } from "@/stores/clusterStore";
import { renderWithRouter } from "@/test/render";

vi.mock("@/lib/commands", () => ({
  commands: {
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
