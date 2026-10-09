import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { usePrivacyStore } from "@/stores/privacyStore";

const saveGcpProfile = vi.fn(
  async (_name: string, _profile: unknown) => undefined
);
vi.mock("@/lib/commands", () => ({
  commands: {
    listGcpProfiles: vi.fn(async () => [
      {
        name: "deploy",
        profile: {
          serviceAccountKeyPath: "/home/lena/keys/deploy.json",
          preferNativeAuth: true,
        },
      },
    ]),
    saveGcpProfile: (name: string, profile: unknown) =>
      saveGcpProfile(name, profile),
  },
}));

const { GcpProfilesSection } = await import("./GcpProfilesSection");

const KEY = "/home/lena/keys/deploy.json";

beforeEach(() => {
  saveGcpProfile.mockClear();
  usePrivacyStore.setState({
    hidePaths: true,
    identity: { roots: [{ root: "/home/lena", standIn: "~" }], user: "lena" },
  });
});

describe("the service account key path while names and paths are hidden", () => {
  const keyField = (dialog: HTMLElement) =>
    [...dialog.querySelectorAll("input")].find((input) =>
      /deploy\.json$/.test(input.value)
    ) as HTMLInputElement;

  /**
   * Lena opened a GCP profile and read her home folder in the key path
   * field with the box ticked. Fails if the unfocused field prints the home
   * or the login, or the focused one stops showing the real path.
   */
  it("shows the redacted path in the open profile and the real one under the cursor", async () => {
    const user = userEvent.setup();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <GcpProfilesSection />
      </QueryClientProvider>
    );
    await user.click(await screen.findByRole("button", { name: "Edit" }));
    const dialog = await screen.findByRole("dialog");
    const key = keyField(dialog);
    expect(key.value).toBe("~/keys/deploy.json");
    expect(
      [...dialog.querySelectorAll("input")].map((input) => input.value).join()
    ).not.toMatch(/lena/);

    await user.click(key);
    expect(key.value).toBe(KEY);
    await user.tab();
    expect(key.value).toBe("~/keys/deploy.json");
  });

  /** Saving a profile that was only looked at must store the real path, not the form on screen. */
  it("saves the real path, whether or not the field was visited", async () => {
    const user = userEvent.setup();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <GcpProfilesSection />
      </QueryClientProvider>
    );
    await user.click(await screen.findByRole("button", { name: "Edit" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(keyField(dialog));
    await user.tab();
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(saveGcpProfile).toHaveBeenCalled());
    expect(saveGcpProfile).toHaveBeenCalledWith(
      "deploy",
      expect.objectContaining({ serviceAccountKeyPath: KEY })
    );
  });
});
