import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@/lib/commands", () => ({
  commands: {
    listGcpProfiles: vi.fn(async () => [{ name: "deploy", profile: {} }]),
    listAzureProfiles: vi.fn(async () => []),
    getContextBinding: vi.fn(),
    saveContextBinding: vi.fn(async () => undefined),
    deleteContextBinding: vi.fn(async () => undefined),
    forgetDiscovery: vi.fn(async () => undefined),
  },
}));

import { commands } from "@/lib/commands";
import { renderWithProviders } from "@/test/render";
import { BindingDialog } from "./BindingDialog";

beforeEach(() => vi.clearAllMocks());

describe("the profile a context uses", () => {
  /**
   * While the stored binding was unread the dialog held an empty one, and
   * Save then deleted the real one. Fails if Save is pressable before the
   * binding has been read, or after the read failed.
   */
  it("keeps Save locked and says so when the stored binding could not be read", async () => {
    vi.mocked(commands.getContextBinding).mockRejectedValue(new Error("boom"));
    renderWithProviders(
      <BindingDialog context="gke-shop" onOpenChange={() => {}} />
    );

    expect(
      await screen.findByText("Could not read which profile this context uses.")
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("lets Save through once the binding has been read", async () => {
    vi.mocked(commands.getContextBinding).mockResolvedValue({
      gcpProfile: "deploy",
      azureProfile: undefined,
    });
    const user = userEvent.setup();
    renderWithProviders(
      <BindingDialog context="gke-shop" onOpenChange={() => {}} />
    );

    const save = await screen.findByRole("button", { name: "Save" });
    await vi.waitFor(() => expect(save).toBeEnabled());
    await user.click(save);
    expect(commands.saveContextBinding).toHaveBeenCalledWith("gke-shop", {
      gcpProfile: "deploy",
      azureProfile: undefined,
    });
  });
});
