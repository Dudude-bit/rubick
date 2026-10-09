import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { usePrivacyStore } from "@/stores/privacyStore";

const setKubeconfigPath = vi.fn(async (_path: string) => undefined);
vi.mock("@/lib/commands", () => ({
  commands: {
    getKubeconfigPath: vi.fn(async () => "/home/lena/work/kubeconfig"),
    getKubeconfigPaths: vi.fn(async () => ["/home/lena/work/kubeconfig"]),
    getKubeconfigSource: vi.fn(async () => ({
      candidates: [
        {
          path: "/home/lena/work/kubeconfig",
          exists: true,
          origin: "override",
          contexts: [],
        },
      ],
      kubeconfig_env: null,
      counts: { contexts: 2, clusters: 2, users: 2 },
      error: null,
    })),
    setKubeconfigPath: (path: string) => setKubeconfigPath(path),
  },
}));

const { SourceLine } = await import("./SourceLine");

beforeEach(() => {
  setKubeconfigPath.mockClear();
  usePrivacyStore.setState({
    hidePaths: true,
    identity: { roots: [{ root: "/home/lena", standIn: "~" }], user: "lena" },
  });
});

function mount() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <SourceLine />
    </QueryClientProvider>
  );
}

describe("the kubeconfig line while names and paths are hidden", () => {
  /**
   * "Use another file" opens a field pre-filled with the pinned path so it
   * can be corrected. The real path is allowed there because the field has
   * the cursor; fails if it is on screen before that, or stays after the
   * cursor leaves, with the stored path unchanged.
   */
  it("shows the redacted path, the real one only in the focused field, and the redacted one again after", async () => {
    const user = userEvent.setup();
    mount();
    expect(await screen.findByText("~/work/kubeconfig")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("lena");

    await user.click(screen.getByRole("button", { name: "Use another file" }));
    const field = screen.getByRole("textbox", { name: "Kubeconfig file" });
    expect(field).toHaveFocus();
    expect(field).toHaveValue("/home/lena/work/kubeconfig");

    await user.tab();
    expect(
      screen.queryByRole("textbox", { name: "Kubeconfig file" })
    ).toBeNull();
    expect(await screen.findByText("~/work/kubeconfig")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("lena");
    expect(setKubeconfigPath).not.toHaveBeenCalled();
  });
});
