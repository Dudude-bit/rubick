import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const editor = {
  connect: { urlPlaceholder: "http://prometheus:9090", inCluster: undefined },
  saved: { url: "http://old:9090", authType: "none", hasToken: false },
  save: vi.fn(),
  forget: vi.fn(),
  test: vi.fn(),
  isSaving: false,
  readError: null as Error | null,
  reread: vi.fn(),
};

vi.mock("@/integrations", () => ({
  useConnectionEditor: () => editor,
  candidates: vi.fn(),
  forward: vi.fn(),
}));

const { ConnectIntegration } = await import("./ConnectIntegration");

const onOpenChange = vi.fn();

const open = () =>
  render(
    <ConnectIntegration
      vendorId="prometheus"
      vendorName="Prometheus"
      gives="metrics"
      open
      onOpenChange={onOpenChange}
    />
  );

beforeEach(() => {
  vi.clearAllMocks();
  editor.readError = null;
});

describe("the integration dialog when a write does not go through", () => {
  /**
   * Save awaited the mutation with no catch: a failure left the dialog open
   * and said nothing. Fails if the cluster's words are not shown inside the
   * dialog, or if the dialog closes as though it had worked.
   */
  it("says why Save failed inside the dialog and stays open", async () => {
    editor.save.mockRejectedValue(new Error("keychain is locked"));
    open();

    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "keychain is locked"
    );
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  });

  /**
   * Disconnect had no catch and no pending state, so a double click fired
   * two forgets and a failure was silent. Fails if the failure is not shown
   * or the dialog closes over it.
   */
  it("says why Disconnect failed inside the dialog and stays open", async () => {
    editor.forget.mockRejectedValue(new Error("config is read-only"));
    open();

    await userEvent.click(screen.getByRole("button", { name: "Disconnect" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "config is read-only"
    );
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  /**
   * A rejected probe reset the spinner and showed nothing, so Test looked
   * like it did nothing. Fails if the rejection is not drawn as a failed
   * result.
   */
  it("shows a rejected Test as a failed result", async () => {
    editor.test.mockRejectedValue(new Error("tunnel is down"));
    open();

    await userEvent.click(screen.getByRole("button", { name: "Test" }));

    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("tunnel is down")
    );
  });

  /**
   * A saved address that could not be read looked like no address at all.
   * Fails if the read failure is not named.
   */
  it("names a saved connection it could not read instead of showing empty fields as if nothing were saved", () => {
    editor.readError = new Error("config unreadable");
    open();

    expect(
      screen.getByText("Could not read what is saved for this integration.")
    ).toBeVisible();
  });
});
