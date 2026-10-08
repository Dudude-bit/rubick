import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

import { TooltipProvider } from "@/components/ui/tooltip";

import { useClusterStore } from "@/stores/clusterStore";
import { useDeepLinkStore } from "@/stores/deepLinkStore";
import { renderWithRouter } from "@/test/render";
import { DeepLinkBanner, LINK_NOTE_MS, LinkOpenedNote } from "./DeepLinkBanner";

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
  function arriveLive() {
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
  }

  function renderNote() {
    return render(
      <TooltipProvider>
        <footer>
          <LinkOpenedNote />
        </footer>
      </TooltipProvider>
    );
  }

  afterEach(() => vi.useRealTimers());

  /** Floating bottom right, it covered the log viewer's "shown / Streaming" footer and toasts; fails if it leaves the status strip again. */
  it("sits in the status strip instead of floating over the page", () => {
    arriveLive();
    const { container } = renderNote();
    const note = screen.getByRole("status");
    expect(container.querySelector("footer")?.contains(note)).toBe(true);
    expect(note.className).not.toContain("fixed");
  });

  /** Lena had it on screen for ten minutes; fails if the timer is removed. */
  it("leaves on its own a few seconds after it appears", () => {
    vi.useFakeTimers();
    arriveLive();
    renderNote();
    expect(screen.getByRole("status")).toBeTruthy();
    act(() => vi.advanceTimersByTime(LINK_NOTE_MS));
    expect(useDeepLinkStore.getState().arrival).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });

  /** A reader halfway through the sentence would lose it; fails if pointing at it no longer holds it. */
  it("stays while the pointer rests on it", () => {
    vi.useFakeTimers();
    arriveLive();
    renderNote();
    fireEvent.mouseEnter(screen.getByRole("status"));
    act(() => vi.advanceTimersByTime(LINK_NOTE_MS * 3));
    expect(useDeepLinkStore.getState().arrival).not.toBeNull();
    fireEvent.mouseLeave(screen.getByRole("status"));
    act(() => vi.advanceTimersByTime(LINK_NOTE_MS));
    expect(useDeepLinkStore.getState().arrival).toBeNull();
  });

  /** The page area must not draw a second copy over the page. */
  it("is not drawn by the page area", async () => {
    arriveLive();
    await renderWithRouter(<DeepLinkBanner />, {
      at: PATH,
      route: "/c/$cluster/deployments/$namespace/$name",
    });
    expect(screen.queryByRole("status")).toBeNull();
  });
});
