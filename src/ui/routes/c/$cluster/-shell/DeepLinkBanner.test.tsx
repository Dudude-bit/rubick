import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { screen, waitFor } from "@testing-library/react";

import { useClusterStore } from "@/stores/clusterStore";
import { useDeepLinkStore } from "@/stores/deepLinkStore";
import { renderWithRouter } from "@/test/render";
import { DeepLinkBanner } from "./DeepLinkBanner";

const PATH = "/c/acme/deployments/lena-sandbox/hello-web";
const setNamespaceScope = vi.fn(async () => {});

async function arrive(scope: string[]) {
  useClusterStore.setState({
    currentContext: "acme",
    isConnected: true,
    namespaceScope: scope,
    setNamespaceScope,
  });
  useDeepLinkStore.setState({
    arrival: {
      status: "live",
      link: { context: "acme", path: PATH, capturedAt: null },
    },
  });
  await renderWithRouter(<DeepLinkBanner />, {
    at: PATH,
    route: "/c/$cluster/deployments/$namespace/$name",
  });
  await screen.findByRole("status");
}

beforeEach(() => setNamespaceScope.mockClear());

describe("a link that opens an object in another namespace", () => {
  /** The pill stayed on kube-system beside a page in lena-sandbox. */
  it("moves the scope to the object's namespace", async () => {
    await arrive(["kube-system"]);
    await waitFor(() =>
      expect(setNamespaceScope).toHaveBeenCalledWith(["lena-sandbox"])
    );
  });

  /** All namespaces already shows it, and narrowing would hide the rest. */
  it.each([[[]], [["lena-sandbox", "shop"]]])(
    "leaves a scope that already holds it (%j)",
    async (scope: string[]) => {
      await arrive(scope);
      expect(setNamespaceScope).not.toHaveBeenCalled();
    }
  );
});

describe("the note a live link leaves", () => {
  /** Lena's page sat 40px lower until she closed the note, then jumped; fails if the note goes back into the page's flow. */
  it("floats over the page instead of pushing it down", async () => {
    useClusterStore.setState({
      currentContext: "acme",
      isConnected: true,
      namespaceScope: [],
      setNamespaceScope,
    });
    useDeepLinkStore.setState({
      arrival: {
        status: "live",
        link: { context: "acme", path: PATH, capturedAt: null },
      },
    });
    const { container } = await renderWithRouter(<DeepLinkBanner />, {
      at: PATH,
      route: "/c/$cluster/deployments/$namespace/$name",
    });
    const note = await screen.findByRole("status");
    expect(container.contains(note)).toBe(false);
    expect(note.className).toContain("fixed");
  });
});
