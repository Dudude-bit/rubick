import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { useDependenciesStore } from "@/stores/dependenciesStore";
import { usePrivacyStore } from "@/stores/privacyStore";

const saveCliPaths = vi.fn(async (_paths: unknown) => undefined);
vi.mock("@/lib/commands", () => ({
  commands: {
    getCliPaths: vi.fn(async () => ({
      helmPath: "/home/lena/.local/bin/helm",
      kubectlPath: "/usr/local/bin/kubectl",
    })),
    saveCliPaths: (paths: unknown) => saveCliPaths(paths),
    checkHelmAvailability: vi.fn(async () => ({
      available: true,
      version: "v3.16.0",
      error: null,
      path: "/home/lena/.local/bin/helm",
      searchedPaths: [],
    })),
    checkKubectlAvailability: vi.fn(async () => ({
      available: true,
      version: "v1.31.0",
      error: null,
      path: "/usr/local/bin/kubectl",
      searchedPaths: [],
    })),
  },
}));

const { ToolPathsPanel } = await import("./ToolPathsPanel");

const HOME_HELM = "/home/lena/.local/bin/helm";

beforeEach(() => {
  saveCliPaths.mockClear();
  usePrivacyStore.setState({
    hidePaths: true,
    identity: { roots: [{ root: "/home/lena", standIn: "~" }], user: "lena" },
  });
  useDependenciesStore.setState({ helm: null, kubectl: null });
});

const helmField = async () => {
  const field = (await screen.findByDisplayValue(/helm/)) as HTMLInputElement;
  await waitFor(() => expect(field.value).not.toBe(""));
  return field;
};

function mount() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <ToolPathsPanel />
    </QueryClientProvider>
  );
}

describe("the tool path fields while names and paths are hidden", () => {
  /**
   * Lena's screenshot of Settings showed `/home/lena/.local/bin/helm` in the
   * field under a ticked "hide names and paths". Fails if an unfocused field
   * prints the home or the login, or the focused one stops showing the real
   * path.
   */
  it("shows the redacted path until the field is clicked, then the real one", async () => {
    const user = userEvent.setup();
    mount();
    const helm = await helmField();
    expect(helm.value).toBe("~/.local/bin/helm");
    expect(document.body.innerHTML).not.toContain("/home/lena");
    expect(
      [...document.querySelectorAll("input")].map((input) => input.value).join()
    ).not.toMatch(/lena/);

    await user.click(helm);
    expect(helm.value).toBe(HOME_HELM);

    await user.tab();
    expect(helm.value).toBe("~/.local/bin/helm");
  });

  /** Looking at a field and leaving it must not rewrite the stored path with the form on screen. */
  it("saves nothing, and keeps the real path, when a field is focused and left alone", async () => {
    const user = userEvent.setup();
    mount();
    const helm = await helmField();
    await user.click(helm);
    await user.tab();
    expect(saveCliPaths).not.toHaveBeenCalled();
    await user.click(helm);
    expect(helm.value).toBe(HOME_HELM);
  });

  /** An edit saves what was typed on top of the real path, never the redacted one. */
  it("saves the real path, with the edit, when the field is left", async () => {
    const user = userEvent.setup();
    mount();
    const helm = await helmField();
    await user.click(helm);
    await user.type(helm, "2");
    await user.tab();
    await waitFor(() => expect(saveCliPaths).toHaveBeenCalled());
    expect(saveCliPaths).toHaveBeenCalledWith({
      helmPath: `${HOME_HELM}2`,
      kubectlPath: "/usr/local/bin/kubectl",
    });
  });

  /** With the box unticked nothing is hidden, focused or not. */
  it("shows the real path in an unfocused field when names and paths are not hidden", async () => {
    usePrivacyStore.setState({ hidePaths: false });
    mount();
    expect((await helmField()).value).toBe(HOME_HELM);
  });
});
