import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const getKubeconfigSource = vi.fn(async () => ({
  candidates: [
    { path: "/home/dev/.kube/config", exists: true, origin: "unset" },
  ],
  counts: null,
  error: "line 6: mapping values are not allowed",
}));
vi.mock("@/lib/commands", () => ({
  commands: {
    getKubeconfigPath: vi.fn(async () => null),
    getKubeconfigPaths: vi.fn(async () => []),
    getKubeconfigSource: () => getKubeconfigSource(),
    listContexts: vi.fn(async () => []),
  },
}));

import { renderWithRouter } from "@/test/render";
import { KubeconfigUnread } from "./ClusterMissing";

beforeEach(() => getKubeconfigSource.mockClear());

describe("the page for a kubeconfig that could not be read", () => {
  /**
   * The page named the error and offered nothing, so the reader had to find
   * Settings to fix a path. Fails if Reload or Choose a different file is
   * missing, or if Reload does not ask for the file again.
   */
  it("offers to reload the file and to choose another, and reload reads it again", async () => {
    await renderWithRouter(
      <KubeconfigUnread cluster="acme-prod" error="line 6: bad" />
    );
    expect(
      screen.getByRole("button", { name: "Choose a different file…" })
    ).toBeInTheDocument();

    const before = getKubeconfigSource.mock.calls.length;
    await userEvent.click(screen.getByRole("button", { name: "Reload" }));
    await vi.waitFor(() =>
      expect(getKubeconfigSource.mock.calls.length).toBeGreaterThan(before)
    );
  });
});
