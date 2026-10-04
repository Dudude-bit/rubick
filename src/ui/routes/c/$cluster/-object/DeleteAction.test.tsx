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
        notRead: { kinds: [], groups: [] },
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
