import { screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { renderWithRouter } from "@/test/render";
import { useClusterStore } from "@/stores/clusterStore";

vi.mock("@/lib/commands", () => ({
  commands: {
    getPrometheusConnection: () =>
      Promise.resolve({
        url: "https://admin:S3cret@prom.example.com/",
        authType: "none",
        hasToken: false,
        insecureTls: false,
      }),
  },
}));
vi.mock("./coverage", async (original) => ({
  ...(await original<typeof import("./coverage")>()),
  coverage: () => new Promise(() => {}),
}));

const { default: Connection } = await import("./connection");

describe("the Connection tab's own line about the address", () => {
  afterEach(() =>
    useClusterStore.setState({ isConnected: false, currentContext: null })
  );

  /**
   * The tab's Share section cut the credentials and the line drawn two
   * rows above it did not. Fails if the tab draws the saved address whole.
   */
  it("names the host and not the password it is reached with", async () => {
    useClusterStore.setState({ currentContext: "prod", isConnected: true });
    await renderWithRouter(<Connection />, {
      at: "/c/prod",
      route: "/c/$cluster",
    });
    expect(await screen.findByText("prom.example.com")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("S3cret");
  });
});
